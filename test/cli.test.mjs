import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FRICTION_DEPRECATION, REMOVED_COMMANDS } from "../src/cli.mjs";
import { runFriction } from "../src/friction.mjs";
import { kitRoot, rootPackageFiles, tempRepository } from "./fixtures.mjs";

const cli = (args, { cwd = os.tmpdir(), env = {} } = {}) => spawnSync(process.execPath, [path.join(kitRoot, "src/cli.mjs"), ...args], {
  encoding: "utf8", cwd, env: { ...process.env, FRICTION_JOURNAL: "off", ...env },
});

for (const command of ["tls", "adopt", "rust"]) {
  test(`repo-kit ${command} exits 1 and says it was removed and what to do instead`, () => {
    const result = cli([command, "--json"]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, `${REMOVED_COMMANDS[command]}\n`);
    assert.match(result.stderr, new RegExp(`^repo-kit ${command} was removed in 0\\.10\\.0: `));
  });
}

test("help lists no removed command", () => {
  const result = cli(["help"]);
  assert.equal(result.status, 0);
  for (const command of [...Object.keys(REMOVED_COMMANDS), "--prerelease"]) {
    assert.doesNotMatch(result.stdout, new RegExp(`^ {2}${command}\\b|${command} `, "m"), command);
  }
  assert.match(result.stdout, /^ {2}heavy <slots\|all> <command\.\.\.>/m);
});

test("publish --prerelease fails with the removal, before anything is published", () => {
  const repository = tempRepository(rootPackageFiles());
  try {
    for (const args of [["--prerelease", "integration", "--dist-tag", "integration"], ["--dry-run"]]) {
      const result = cli(["publish", ...args], { cwd: repository.root });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /^repo-kit: publish --prerelease was removed in 0\.10\.0/);
    }
  } finally {
    repository.cleanup();
  }
});

test("friction still works, with its deprecation on stderr and stdout unchanged", () => {
  const result = cli(["friction", "help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, `${FRICTION_DEPRECATION}\n`);
  // stdout is exactly what the friction module prints, so piped output stays parseable.
  const printed = [];
  const { log } = console;
  console.log = (...args) => printed.push(args.join(" "));
  try {
    runFriction(["help"]);
  } finally {
    console.log = log;
  }
  assert.equal(result.stdout, `${printed.join("\n")}\n`);
  assert.match(result.stdout, /repo-kit friction log/);
});

test("heavy still runs its command", () => {
  const result = cli(["heavy", "1", "--", process.execPath, "-e", "process.stdout.write('ran')"], { env: { SLOTFATHER_LEASE: "outer" } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "ran");
});

test("a config with an unknown key fails the command with the key's path", () => {
  const repository = tempRepository(rootPackageFiles({ "repo-kit.config.mjs": "export default { verify: { cheapp: true }, rust: {} };\n" }));
  try {
    const result = cli(["check-changelogs"], { cwd: repository.root });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^repo-kit: repo-kit\.config\.mjs:\n {2}unknown key verify\.cheapp; did you mean cheap\? It is a key of each verify step/);
    assert.match(result.stderr, /\n {2}rust: repo-kit rust was removed in 0\.10\.0/);
  } finally {
    repository.cleanup();
  }
});
