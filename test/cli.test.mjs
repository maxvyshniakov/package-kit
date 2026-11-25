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
  test(`package-kit ${command} exits 1 and says it was removed and what to do instead`, () => {
    const result = cli([command, "--json"]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, `${REMOVED_COMMANDS[command]}\n`);
    assert.match(result.stderr, new RegExp(`^package-kit ${command} was removed in 0\\.10\\.0: `));
  });
}

test("help lists no removed command", () => {
  const result = cli(["help"]);
  assert.equal(result.status, 0);
  for (const command of Object.keys(REMOVED_COMMANDS)) {
    assert.doesNotMatch(result.stdout, new RegExp(`^ {2}${command}\\b|${command} `, "m"), command);
  }
  assert.match(result.stdout, /^ {2}heavy <slots\|all> <command\.\.\.>/m);
  assert.match(result.stdout, /^ {2}publish \[--resume\]$/m);
  assert.match(result.stdout, /^ {2}publish --prerelease <preid> --dist-tag <tag> \[--ref <ref>\] \[--dry-run\]$/m);
});

test("publish --prerelease validates its options and routes valid flags to runPrerelease", () => {
  const repository = tempRepository(rootPackageFiles(), { git: true });
  try {
    const latest = cli(["publish", "--prerelease", "integration", "--dist-tag", "latest"], { cwd: repository.root });
    assert.equal(latest.status, 1);
    assert.match(latest.stderr, /--dist-tag cannot be "latest"/);

    const unpaired = cli(["publish", "--dry-run"], { cwd: repository.root });
    assert.equal(unpaired.status, 1);
    assert.match(unpaired.stderr, /--prerelease and --dist-tag must be given together/);

    const mixed = cli(["publish", "--resume", "--prerelease", "integration", "--dist-tag", "integration"], { cwd: repository.root });
    assert.equal(mixed.status, 1);
    assert.match(mixed.stderr, /--resume cannot be combined with prerelease/);

    // Valid flags route into runPrerelease (refusing unresolvable --ref cleanly).
    const badRef = cli(["publish", "--prerelease", "integration", "--dist-tag", "integration", "--ref", "nonexistent-ref"], { cwd: repository.root });
    assert.equal(badRef.status, 1);
    assert.match(badRef.stderr, /could not resolve nonexistent-ref to a full commit SHA/);
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
  assert.match(result.stdout, /package-kit friction log/);
});

test("heavy still runs its command", () => {
  const result = cli(["heavy", "1", "--", process.execPath, "-e", "process.stdout.write('ran')"], { env: { SLOTFATHER_LEASE: "outer" } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "ran");
});

test("a config with an unknown key fails the command with the key's path", () => {
  const repository = tempRepository(rootPackageFiles({ "package-kit.config.mjs": "export default { verify: { cheapp: true }, rust: {} };\n" }));
  try {
    const result = cli(["check-changelogs"], { cwd: repository.root });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^package-kit: package-kit\.config\.mjs:\n {2}unknown key verify\.cheapp; did you mean cheap\? It is a key of each verify step/);
    assert.match(result.stderr, /\n {2}rust: package-kit rust was removed in 0\.10\.0/);
  } finally {
    repository.cleanup();
  }
});
