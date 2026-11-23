import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { KIT_VERSION, kitIssues, kitReferences, packageManagerIssues, workflowIssues } from "../src/check.mjs";
import { leasedCommand, runLeased } from "../src/slotfather.mjs";
import { hookIssues, hookStatus, installHooks, managedHooks, REFERENCE_TRANSACTION_SHA256, sha256, syncHooks } from "../src/hooks.mjs";
import { bunTooOld, BUN_VERSION, resolveToken } from "../src/token.mjs";
import { isolatedGitEnv, kitRoot, tempRepository } from "./fixtures.mjs";

const quietly = fn => {
  const { log, warn } = console;
  console.log = console.warn = () => {};
  try {
    return fn();
  } finally {
    Object.assign(console, { log, warn });
  }
};

test("package-kit's own repository passes package-kit check", () => {
  assert.deepEqual(kitIssues(kitRoot), []);
});

test("the reference-transaction copy is Lanefather's, pinned by hash", () => {
  assert.equal(sha256(fs.readFileSync(path.join(kitRoot, "hooks/reference-transaction"))), REFERENCE_TRANSACTION_SHA256);
  assert.match(managedHooks()["reference-transaction"], /^#!\/usr\/bin\/env bash\n# One writer for main and dev/);
});

test("hooks sync writes executable managed hooks that hooks check accepts, and leaves the repository's own", () => {
  const repository = tempRepository({ "package.json": { name: "@maxvyshniakov/example" }, ".githooks/pre-commit": "#!/bin/sh\nexit 0\n" });
  try {
    assert.match(hookIssues(repository.root).join("\n"), /\.githooks\/pre-push is missing; run package-kit hooks sync/);
    quietly(() => syncHooks(repository.root));
    assert.deepEqual(hookIssues(repository.root), []);
    for (const name of ["pre-push", "reference-transaction"]) assert.ok(fs.statSync(path.join(repository.root, ".githooks", name)).mode & 0o111, name);
    assert.equal(fs.readFileSync(path.join(repository.root, ".githooks/pre-commit"), "utf8"), "#!/bin/sh\nexit 0\n");
    fs.appendFileSync(path.join(repository.root, ".githooks/reference-transaction"), "# local edit\n");
    assert.match(hookIssues(repository.root).join("\n"), /\.githooks\/reference-transaction differs from package-kit's/);
  } finally {
    repository.cleanup();
  }
});

test("the pre-push shim runs the installed package-kit, or the sources in package-kit itself", () => {
  assert.match(managedHooks()["pre-push"], /node_modules\/@maxvyshniakov\/package-kit\/src\/cli\.mjs/);
  assert.match(managedHooks({ self: true })["pre-push"], /cli="\$root\/src\/cli\.mjs"/);
  assert.equal(fs.readFileSync(path.join(kitRoot, ".githooks/pre-push"), "utf8"), managedHooks({ self: true })["pre-push"]);
});

test("hooks install points core.hooksPath at .githooks once, keeps a deliberate one, and skips CI", () => {
  const repository = tempRepository({ "package.json": { name: "@maxvyshniakov/example" } }, { git: true });
  try {
    installHooks(repository.root, { CI: "true" });
    assert.throws(() => repository.git("config", "--get", "core.hooksPath"));
    quietly(() => installHooks(repository.root, {}));
    assert.equal(repository.git("config", "--get", "core.hooksPath"), ".githooks");
    repository.git("config", "core.hooksPath", "custom");
    quietly(() => installHooks(repository.root, {}));
    assert.equal(repository.git("config", "--get", "core.hooksPath"), "custom");
  } finally {
    repository.cleanup();
  }
});

test("hooks status reports a tracked hook Git would not run", () => {
  const repository = tempRepository({ "package.json": { name: "@maxvyshniakov/example" } }, { git: true });
  try {
    quietly(() => syncHooks(repository.root));
    assert.match(hookStatus(repository.root).join("\n"), /pre-push: .* is not the tracked \.githooks\/pre-push/);
    repository.git("config", "core.hooksPath", ".githooks");
    assert.deepEqual(hookStatus(repository.root), []);
  } finally {
    repository.cleanup();
  }
});

test("package-kit references in workflows must name the installed version", () => {
  const text = `jobs:
  check:
    uses: maxvyshniakov/package-kit/.github/workflows/verify.yml@v0.1.0
    steps:
      - uses: maxvyshniakov/package-kit/actions/setup-bun@abc123
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262
`;
  assert.deepEqual(kitReferences(text), [
    { target: ".github/workflows/verify.yml", ref: "v0.1.0", line: 3 },
    { target: "actions/setup-bun", ref: "abc123", line: 5 },
  ]);
  const repository = tempRepository({ "package.json": {}, ".github/workflows/check.yml": text });
  try {
    assert.deepEqual(workflowIssues(repository.root, "0.1.0"), [".github/workflows/check.yml:5: actions/setup-bun@abc123; the installed package-kit is v0.1.0"]);
    assert.equal(workflowIssues(repository.root, "0.2.0").length, 2);
    fs.writeFileSync(path.join(repository.root, ".github/workflows/legacy.yml"), "jobs:\n  check:\n    uses: maxvyshniakov/repo-kit/.github/workflows/verify.yml@v0.10.0\n");
    assert.ok(workflowIssues(repository.root, "0.1.0").some(issue => issue.includes("maxvyshniakov/repo-kit/.github/workflows/verify.yml@v0.10.0; switch to maxvyshniakov/package-kit/.github/workflows/verify.yml@v0.1.0")));
  } finally {
    repository.cleanup();
  }
});

test("packageManager must name the Bun the workflows run", () => {
  const repository = tempRepository({ "package.json": { packageManager: "bun@1.3.14" } });
  try {
    assert.deepEqual(packageManagerIssues(repository.root), [`package.json packageManager is bun@1.3.14; the workflows run bun@${BUN_VERSION}`]);
    fs.writeFileSync(path.join(repository.root, "package.json"), JSON.stringify({ packageManager: `bun@${BUN_VERSION}` }));
    assert.deepEqual(packageManagerIssues(repository.root), []);
    fs.writeFileSync(path.join(repository.root, "package.json"), "{}");
    assert.deepEqual(packageManagerIssues(repository.root), []);
  } finally {
    repository.cleanup();
  }
});

test("the kit version is package.json's", () => {
  assert.equal(KIT_VERSION, JSON.parse(fs.readFileSync(path.join(kitRoot, "package.json"), "utf8")).version);
});

test("a heavy command leases once, and runs directly without slotfather", () => {
  assert.deepEqual(leasedCommand(2, ["bun", "run", "x"], { env: {}, cwd: "/repo/sid-kit", slotfather: true }), ["slotfather", "run", "-n", "2", "--label", "sid-kit bun run x", "--", "bun", "run", "x"]);
  assert.deepEqual(leasedCommand(2, ["bun"], { env: { SLOTFATHER_LEASE: "outer" }, cwd: "/repo", slotfather: true }), ["bun"]);
  assert.deepEqual(leasedCommand("all", ["bun"], { env: {}, cwd: "/repo", slotfather: false }), ["bun"]);
  assert.deepEqual(leasedCommand(2, ["bun"], { env: { PACKAGE_KIT_SLOT_WAIT: "2400" }, cwd: "/repo/sid-kit", slotfather: true }), ["slotfather", "run", "-n", "2", "--label", "sid-kit bun", "--wait", "2400", "--", "bun"], "a lease that gives up after PACKAGE_KIT_SLOT_WAIT");
  assert.deepEqual(leasedCommand(2, ["bun"], { env: { SID_KIT_SLOT_WAIT: "60" }, cwd: "/repo", slotfather: true }).slice(6, 8), ["--wait", "60"], "the older name still works");
  assert.deepEqual(leasedCommand(2, ["bun"], { env: { PACKAGE_KIT_SLOT_WAIT: "0" }, cwd: "/repo", slotfather: true }).includes("--wait"), false);
});

test("GITHUB_TOKEN wins over gh auth token, which fills in when it is unset", () => {
  assert.deepEqual(resolveToken({ GITHUB_TOKEN: "env" }, () => "gh"), { token: "env", source: "GITHUB_TOKEN" });
  assert.deepEqual(resolveToken({}, () => "gh"), { token: "gh", source: "gh auth token" });
  assert.deepEqual(resolveToken({}, () => undefined), { token: undefined });
});

test("Bun older than 1.4.4 is refused", () => {
  assert.match(bunTooOld("1.3.14"), /predates 1.4.4/);
  assert.equal(bunTooOld("1.4.4"), undefined);
  assert.equal(bunTooOld("1.10.0"), undefined);
  assert.equal(bunTooOld("1.4.5-canary.1"), undefined);
  assert.match(bunTooOld(undefined), /not on PATH/);
});

test("package-kit heavy handles signals before its command starts, and lets go of them when it cannot start", async () => {
  const signals = ["SIGTERM", "SIGHUP", "SIGINT"];
  const before = Object.fromEntries(signals.map(signal => [signal, process.listenerCount(signal)]));
  const { EventEmitter } = await import("node:events");
  let atSpawn;
  // The command can print "ready" and its caller can signal before spawn's caller
  // runs another line: a signal then must already be handled.
  const spawn = () => {
    atSpawn = Object.fromEntries(signals.map(signal => [signal, process.listenerCount(signal) - before[signal]]));
    const child = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => child.emit("error", new Error("spawn ENOENT")));
    return child;
  };
  const error = console.error;
  console.error = () => {};
  try {
    assert.equal(await runLeased(1, ["missing-command"], { env: { SLOTFATHER_LEASE: "outer" }, spawn }), 127);
  } finally {
    console.error = error;
  }
  assert.deepEqual(atSpawn, { SIGTERM: 1, SIGHUP: 1, SIGINT: 1 });
  for (const signal of signals) assert.equal(process.listenerCount(signal), before[signal], `${signal} listener left behind`);
});

test("package-kit heavy forwards SIGTERM to its command but not SIGINT, which the command gets from the terminal", { timeout: 20_000 }, async () => {
  const { spawn } = await import("node:child_process");
  const repository = tempRepository({});
  try {
    const log = path.join(repository.root, "signals");
    const script = `import { runLeased } from ${JSON.stringify(path.join(kitRoot, "src/slotfather.mjs"))};
const done = runLeased(1, ["sh", "-c", ${JSON.stringify(`trap 'echo INT >> ${log}' INT; trap 'echo TERM >> ${log}; exit 143' TERM; echo ready; while :; do sleep 0.1; done`)}], { env: { ...process.env, SLOTFATHER_LEASE: "outer" } });
process.once("SIGINT", () => setImmediate(() => console.log("sigint-handled")));
process.exitCode = await done;`;
    const parent = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";
    const waitForOutput = text => new Promise((resolve, reject) => {
      if (stdout.includes(text)) return resolve();
      const onData = chunk => {
        stdout += chunk;
        if (stdout.includes(text)) {
          parent.stdout.off("data", onData);
          resolve();
        }
      };
      parent.stdout.on("data", onData);
      parent.once("close", () => reject(new Error(`exited before ${text}: ${stdout}`)));
    });
    await waitForOutput("ready");
    const exited = new Promise(resolve => parent.on("close", code => resolve(code)));
    parent.kill("SIGINT");
    await waitForOutput("sigint-handled");
    parent.kill("SIGTERM");
    assert.equal(await exited, 143);
    assert.equal(fs.readFileSync(log, "utf8"), "TERM\n");
  } finally {
    repository.cleanup();
  }
});

 test("package-kit itself uses only the pre-push hook; consumer branch protection stays enabled", () => {
  assert.equal(managedHooks({ self: true })["reference-transaction"], undefined);
  assert.ok(managedHooks()["reference-transaction"]);
});

test("self hook sync retires only its unchanged old branch guard", () => {
 const repository=tempRepository({"package.json":{name:"@maxvyshniakov/package-kit"}});
 try {
  const guard=path.join(repository.root,".githooks/reference-transaction");
  fs.mkdirSync(path.dirname(guard),{recursive:true});
  fs.writeFileSync(guard,managedHooks()["reference-transaction"]);
  quietly(()=>syncHooks(repository.root));
  assert.ok(!fs.existsSync(guard));
  assert.deepEqual(hookIssues(repository.root),[]);
  fs.writeFileSync(guard,"custom guard");
  assert.throws(()=>syncHooks(repository.root),/customized/);
  assert.equal(fs.readFileSync(guard,"utf8"),"custom guard");
 } finally {repository.cleanup();}
});

test("a lease label names the project and what runs, never a bare directory", async () => {
  const { slotLabel, projectName } = await import("../src/slotfather.mjs");
  // A worktree's own directory is not the project: the main checkout's is.
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "package-kit-project-")));
  try {
    const main = path.join(parent, "package-kit");
    const worktree = path.join(parent, "lane-23-rename");
    const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: isolatedGitEnv(), stdio: "ignore" });
    fs.mkdirSync(main);
    git(main, "init", "--quiet", "-b", "main");
    git(main, "commit", "--quiet", "--allow-empty", "-m", "fixture");
    git(main, "worktree", "add", "--quiet", worktree);
    assert.equal(projectName(worktree), "package-kit");
    assert.equal(slotLabel("release-gate", { env: {}, cwd: worktree }), "package-kit release-gate");
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
  assert.equal(slotLabel("check", { env: { PACKAGE_KIT_SLOT_LABEL: "lane-sk-api-surfaces" } }), "lane-sk-api-surfaces check");
  assert.equal(slotLabel("check", { env: { PACKAGE_KIT_SLOT_LABEL: "lane-x post-merge" } }), "lane-x post-merge");
  // package-kit heavy under a package script names the script.
  assert.equal(leasedCommand(2, ["bun", "scripts/run-story-checks.mjs"], { env: { npm_lifecycle_event: "check:stories" }, cwd: "/repo/sid-kit", slotfather: true })[5], "sid-kit check:stories");
  assert.equal(leasedCommand(1, ["node", "x.mjs"], { env: { PACKAGE_KIT_SLOT_LABEL: "lane-a" }, purpose: "check", cwd: "/r", slotfather: true })[5], "lane-a check");
});

test('a configured lane carries named request fields and metadata into the execution lease', () => {
  const command = leasedCommand(2, ['node', 'check.mjs'], { slotfather: true, cwd: '/fixture', env: {
    PACKAGE_KIT_SLOT_LABEL: 'lane-check-42', PACKAGE_KIT_SLOT_PRIORITY: 'interactive', PACKAGE_KIT_SLOT_TICKET: '42',
    PACKAGE_KIT_SLOT_META: JSON.stringify({ lane: 'feature-42', phase: 'check' }),
  } });
  assert.deepEqual(command, ['slotfather', 'run', '-n', '2', '--label', 'lane-check-42',
    '--priority', 'interactive', '--ticket', '42', '--meta', 'lane=feature-42', '--meta', 'phase=check',
    '--', 'node', 'check.mjs']);
  assert.throws(() => leasedCommand(1, ['node'], { slotfather: true, env: { PACKAGE_KIT_SLOT_META: '{broken' } }), /metadata/);
});
