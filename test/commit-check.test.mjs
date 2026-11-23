import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  passedRecord,
  signalExitCode,
  trapSignals,
  verifyCommand,
  verifyCommands,
  withCommitWorktree,
} from "../src/commit-check.mjs";
import { cleanEnvironment, commonGitDir, git, gitResult, gitRunner } from "../src/git.mjs";
import { tempRepository } from "./fixtures.mjs";

test("git helpers strip hook vars, execute git commands, and resolve commonGitDir from a linked worktree", () => {
  const cleaned = cleanEnvironment({
    GIT_DIR: "/x",
    GIT_WORK_TREE: "/w",
    GIT_INDEX_FILE: "/i",
    GIT_PREFIX: "p",
    GIT_OBJECT_DIRECTORY: "/o",
    GIT_ALTERNATE_OBJECT_DIRECTORIES: "/a",
    GIT_QUARANTINE_PATH: "/q",
    GIT_AUTHOR_NAME: "kept",
    PATH: "/bin",
  });
  assert.deepEqual(cleaned, { GIT_AUTHOR_NAME: "kept", PATH: "/bin" });

  const repository = tempRepository({ "hello.txt": "hi\n" }, { git: true });
  const linked = `${repository.root}-linked`;
  try {
    const run = gitRunner(repository.root, { env: repository.env });
    const head = run("rev-parse", "HEAD");
    assert.match(head, /^[0-9a-f]{40}$/);
    assert.equal(git(repository.root, "rev-parse", "HEAD", { env: repository.env }), head);

    const listed = gitResult(repository.root, ["ls-files", "-z"], { env: repository.env });
    assert.equal(listed.status, 0);
    assert.equal(listed.stdout, "hello.txt\0");
    assert.equal(gitResult(repository.root, ["rev-parse", "--verify", "no-such-ref"], { env: repository.env, allowFailure: true }).status, 128);

    run("worktree", "add", "--quiet", "--detach", linked, head);
    assert.equal(fs.realpathSync(commonGitDir(linked, repository.env)), fs.realpathSync(path.join(repository.root, ".git")));
  } finally {
    try { git(repository.root, "worktree", "remove", "--force", linked, { env: repository.env }); } catch {}
    fs.rmSync(linked, { recursive: true, force: true });
    repository.cleanup();
  }
});

test("withCommitWorktree checks out an exact commit and always cleans up for sync and async callbacks", async () => {
  const repository = tempRepository({ "tracked.txt": "committed\n" }, { git: true });
  try {
    const sha = repository.git("rev-parse", "HEAD");
    fs.writeFileSync(path.join(repository.root, "dirty.txt"), "uncommitted\n");

    let syncDir;
    const syncValue = withCommitWorktree(repository.root, sha, worktree => {
      syncDir = worktree;
      assert.equal(fs.readFileSync(path.join(worktree, "tracked.txt"), "utf8"), "committed\n");
      assert.equal(fs.existsSync(path.join(worktree, "dirty.txt")), false);
      return 42;
    }, { env: repository.env });
    assert.equal(syncValue, 42);
    assert.equal(fs.existsSync(syncDir), false);

    let asyncDir;
    await assert.rejects(
      withCommitWorktree(repository.root, sha, async worktree => {
        asyncDir = worktree;
        assert.ok(fs.existsSync(worktree));
        throw new Error("boom");
      }, { env: repository.env }),
      /boom/,
    );
    assert.equal(fs.existsSync(asyncDir), false);
  } finally {
    repository.cleanup();
  }
});

test("verifyCommands resolves release and browser commands for modern, historical, and minimal commits", async () => {
  const modern = tempRepository({
    "package.json": { scripts: { verify: "package-kit verify" } },
    "package-kit.config.mjs": "export default { verify: { steps: () => [], browser: () => [] } };\n",
  });
  const historical = tempRepository({
    "package.json": { scripts: { verify: "node scripts/verify.mjs", "verify:browser": "node scripts/verify.mjs --browser" } },
  });
  const legacyScript = tempRepository({
    "package.json": { scripts: {} },
    "scripts/verify.mjs": "",
  });
  try {
    assert.deepEqual(await verifyCommands(modern.root), {
      release: ["bun", ["run", "verify", "--", "--release"]],
      browser: ["bun", ["run", "verify", "--", "--browser"]],
    });
    assert.deepEqual(await verifyCommands(historical.root), {
      release: ["bun", ["run", "verify", "--", "--release"]],
      browser: ["bun", ["run", "verify:browser"]],
    });
    assert.deepEqual(await verifyCommands(legacyScript.root), {
      release: ["node", ["scripts/verify.mjs", "--release"]],
      browser: undefined,
    });
    assert.deepEqual(verifyCommand(legacyScript.root, false), ["node", ["scripts/verify.mjs"]]);
  } finally {
    for (const repo of [modern, historical, legacyScript]) repo.cleanup();
  }
});

test("passedRecord supports both pre-push legacy files and release-gate duration entries", () => {
  const repository = tempRepository({
    "sid-kit-verified": "aaaa release\n",
    "package-kit-verified": "bbbb\n",
  });
  try {
    const prePush = passedRecord(repository.root, "package-kit-verified", { legacy: ["sid-kit-verified"] });
    assert.equal(prePush.has("aaaa release"), true);
    assert.equal(prePush.has("bbbb"), true);
    prePush.add("cccc release");
    assert.equal(prePush.has("cccc release"), true);
    assert.match(fs.readFileSync(path.join(repository.root, "package-kit-verified"), "utf8"), /cccc release\n$/);

    const gateDir = path.join(repository.root, "package-kit-gate");
    const gate = passedRecord(gateDir, "passed", {
      parse: line => {
        const [sha, seconds] = line.split(" ");
        return [sha, Number(seconds) || 0];
      },
      format: (sha, seconds) => `${sha} ${Math.round(seconds)}`,
    });
    assert.equal(gate.has("deadbeef"), false);
    gate.add("deadbeef", 12.6);
    assert.equal(gate.has("deadbeef"), true);
    assert.equal(gate.get("deadbeef"), 13);
    assert.equal(fs.readFileSync(path.join(gateDir, "passed"), "utf8"), "deadbeef 13\n");
  } finally {
    repository.cleanup();
  }
});

test("trapSignals forwards SIGTERM/SIGHUP to the tracked child, records SIGINT, and cleans up listeners", () => {
  const target = new EventEmitter();
  const killed = [];
  const signals = trapSignals({ target });
  signals.track({ kill: sig => killed.push(sig) });

  target.emit("SIGTERM", "SIGTERM");
  assert.equal(signals.stopped, "SIGTERM");
  assert.equal(signals.exitCode(), signalExitCode("SIGTERM"));
  assert.equal(signals.exitCode(), 128 + os.constants.signals.SIGTERM);
  assert.deepEqual(killed, ["SIGTERM"]);

  target.emit("SIGINT");
  assert.equal(signals.stopped, "SIGINT");
  assert.deepEqual(killed, ["SIGTERM"], "SIGINT is not forwarded unless forwardInterrupt is true");

  signals.dispose();
  assert.equal(target.listenerCount("SIGTERM"), 0);
  assert.equal(target.listenerCount("SIGHUP"), 0);
  assert.equal(target.listenerCount("SIGINT"), 0);
});
