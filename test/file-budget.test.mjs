import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  checkFileBudget,
  countBytes,
  countLines,
  fileBudgetConfig,
  formatAllowlist,
  parseAllowlist,
  parseExemptions,
  runFileBudget,
} from "../src/file-budget.mjs";
import { isolatedGitEnv, kitRoot } from "./fixtures.mjs";

const CLI = path.join(kitRoot, "src/cli.mjs");

function swiftLines(count, finalNewline = true) {
  const text = Array.from({ length: count }, (_, i) => `let line${i} = ${i}`).join("\n");
  return text + (finalNewline && count ? "\n" : "");
}

function makeRepo(t, files = {}, config = "export default {};\n") {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "file-budget-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = isolatedGitEnv();
  const git = (...args) => execFileSync("git", args, { cwd: root, env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  git("init", "-q", "-b", "main");
  if (config !== null) {
    fs.writeFileSync(path.join(root, "package-kit.config.mjs"), config);
  }
  const write = (name, content, { track = false } = {}) => {
    const full = path.join(root, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    if (track) git("add", "--", name);
  };
  for (const [name, content] of Object.entries(files)) {
    write(name, content);
  }
  const commit = (message = "snapshot") => {
    git("add", "-A");
    git("commit", "-q", "--allow-empty", "-m", message);
  };
  const run = (args = [], cfg = {}) => {
    const out = [];
    const err = [];
    const code = runFileBudget({
      root,
      config: cfg,
      args,
      env,
      print: line => out.push(line),
      printError: line => err.push(line),
    });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  const runCli = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, env, encoding: "utf8" });
  return { root, env, git, write, commit, run, runCli };
}

test("countLines and countBytes handle empty, trailing-newline, no-trailing-newline, and multi-byte UTF-8 inputs", () => {
  assert.equal(countLines(""), 0);
  assert.equal(countLines("a\nb\n"), 2);
  assert.equal(countLines("a\nb"), 2);
  assert.equal(countLines("\n"), 1);
  assert.equal(countBytes("a".repeat(20_000)), 20_000);
  assert.equal(countBytes("é".repeat(10_001)), 20_002);
});

test("Straylight-style per-glob line budget with plain-text allowlist ratchet", t => {
  const config = {
    fileBudget: {
      rules: [{ glob: "**/*.swift", lines: 800 }],
      allowlist: "tools/file-length-allowlist.txt",
    },
  };
  const repo = makeRepo(t, {
    "control-agent.swift": swiftLines(800),
    "tools/probe/main.swift": swiftLines(12),
    "desktop/src/editor.ts": swiftLines(2000),
    ".gitignore": "generated/\n",
    "generated/huge.swift": swiftLines(2000),
  });

  // Files within 800 lines, ignored files, and non-Swift files pass.
  assert.equal(repo.run([], config).code, 0);

  // Untracked Swift file over 800 lines fails before it is added, including without a final newline.
  repo.write("oversized.swift", swiftLines(801, false));
  let res = repo.run([], config);
  assert.equal(res.code, 1);
  assert.match(res.err, /oversized\.swift has 801 lines, over the limit of 800/);
  fs.rmSync(path.join(repo.root, "oversized.swift"));

  // Listed file at its exact maximum passes.
  repo.write("execution-runtime.swift", swiftLines(1127), { track: true });
  repo.write("tools/file-length-allowlist.txt", "# comment\nexecution-runtime.swift 1127\n", { track: true });
  repo.commit();
  assert.equal(repo.run([], config).code, 0);

  // Growing past its allowed entry fails.
  repo.write("execution-runtime.swift", swiftLines(1128));
  res = repo.run([], config);
  assert.equal(res.code, 1);
  assert.match(res.err, /execution-runtime\.swift grew to 1128 lines, past its allowed 1127/);

  // Shrinking requires lowering the allowlist entry (or running --update).
  repo.write("execution-runtime.swift", swiftLines(1100));
  res = repo.run([], config);
  assert.equal(res.code, 1);
  assert.match(res.err, /execution-runtime\.swift shrank to 1100 lines; lower its entry from 1127 to 1100/);

  const updated = repo.run(["--update"], config);
  assert.equal(updated.code, 0, updated.err);
  assert.equal(fs.readFileSync(path.join(repo.root, "tools/file-length-allowlist.txt"), "utf8"), "execution-runtime.swift 1100\n");
  assert.equal(repo.run([], config).code, 0);

  // Once the file fits the 800-line budget, its allowlist entry must be removed.
  repo.write("execution-runtime.swift", swiftLines(800));
  res = repo.run([], config);
  assert.equal(res.code, 1);
  assert.match(res.err, /execution-runtime\.swift fits the limit of 800 lines with 800 lines; remove its entry/);
  assert.equal(repo.run(["--update"], config).code, 0);
  assert.equal(fs.readFileSync(path.join(repo.root, "tools/file-length-allowlist.txt"), "utf8"), "");
  assert.equal(repo.run([], config).code, 0);
});

test("allowlist entries may not rise or add new files compared with the base commit", t => {
  const config = {
    fileBudget: {
      rules: [{ glob: "**/*.swift", lines: 800 }],
      allowlist: "file-budget-allowlist.json",
    },
  };
  const repo = makeRepo(t, {
    "a.swift": swiftLines(950),
  });

  // --init writes the initial JSON allowlist.
  const init = repo.run(["--init"], config);
  assert.equal(init.code, 0, init.err);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(repo.root, "file-budget-allowlist.json"), "utf8")),
    { version: 1, files: { "a.swift": 950 } },
  );
  repo.commit();
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  repo.git("switch", "-q", "-c", "feature");

  // Raising an entry on the branch and committing it still fails against origin/main.
  repo.write("a.swift", swiftLines(960));
  repo.write("file-budget-allowlist.json", JSON.stringify({ version: 1, files: { "a.swift": 960 } }));
  repo.commit();
  let res = repo.run([], config);
  assert.equal(res.code, 1);
  assert.match(res.err, /a\.swift: its entry rose from 950 to 960 lines/);

  // Adding a new entry to a committed allowlist fails.
  repo.git("reset", "-q", "--hard", "origin/main");
  repo.write("b.swift", swiftLines(900));
  repo.write("file-budget-allowlist.json", JSON.stringify({ version: 1, files: { "a.swift": 950, "b.swift": 900 } }));
  res = repo.run([], config);
  assert.equal(res.code, 1);
  assert.match(res.err, /b\.swift: new entries cannot be added to file-budget-allowlist\.json/);

  // Listing a deleted file fails until removed.
  repo.git("reset", "-q", "--hard", "origin/main");
  fs.rmSync(path.join(repo.root, "a.swift"));
  res = repo.run([], config);
  assert.equal(res.code, 1);
  assert.match(res.err, /a\.swift is listed in file-budget-allowlist\.json but does not exist/);
});

test("Data-Grid-style 20,000-byte staged check, exclusions, and SHA-256 provenance exemptions", t => {
  const config = {
    fileBudget: {
      bytes: 20_000,
      exclude: ["vendor/**", "packages/**/generated/**"],
      exemptions: "config/file-size-exemptions.json",
    },
  };
  const repo = makeRepo(t);

  // 20,000 staged bytes pass; 20,001 fail with token calculation and splitting guidance.
  repo.write("source.ts", "a".repeat(20_000), { track: true });
  assert.equal(repo.run(["--staged"], config).code, 0);

  repo.write("source.ts", "a".repeat(20_001), { track: true });
  let res = repo.run(["--staged"], config);
  assert.equal(res.code, 1);
  assert.match(res.err, /File budget blocked: authored files must be at most 5,000 tokens/);
  assert.match(res.err, /5000\.25 tokens/);
  assert.match(res.err, /Move a cohesive behavior/);

  // Staged mode inspects index blobs, not unstaged edits or untracked files.
  repo.write("source.ts", "small", { track: true });
  repo.write("source.ts", "x".repeat(25_000)); // unstaged
  repo.write("untracked.ts", "x".repeat(25_000)); // untracked
  assert.equal(repo.run(["--staged"], config).code, 0);

  // Configured exclude globs, lockfiles, changelogs, and NUL-containing binaries pass.
  repo.write("vendor/library.js", "x".repeat(30_000), { track: true });
  repo.write("packages/grid/generated/types.ts", "x".repeat(30_000), { track: true });
  repo.write("bun.lock", "x".repeat(30_000), { track: true });
  repo.write("packages/grid/CHANGELOG.md", "x".repeat(30_000), { track: true });
  repo.write("assets/blob.dat", Buffer.alloc(30_000), { track: true });
  assert.equal(repo.run(["--staged"], config).code, 0);

  // SHA-256 provenance exemption requires staged manifest, tracked generator, and matching hash.
  const iconContent = "x".repeat(25_000);
  repo.write("src/lucide-icons.ts", iconContent, { track: true });
  repo.write("scripts/vendor-icons.mjs", "// generator\n", { track: true });
  const entry = {
    path: "src/lucide-icons.ts",
    kind: "generated",
    source: "npm:lucide@1.64.0",
    generator: "scripts/vendor-icons.mjs",
    sha256: createHash("sha256").update(iconContent).digest("hex"),
  };
  repo.write("config/file-size-exemptions.json", JSON.stringify({ version: 1, files: [entry] }));
  assert.equal(repo.run(["--staged"], config).code, 1, "unstaged exemption manifest does not exempt staged file");
  repo.git("add", "config/file-size-exemptions.json");
  assert.equal(repo.run(["--staged"], config).code, 0);

  // Stale hash fails when the generated file changes without updating the staged hash.
  repo.write("src/lucide-icons.ts", `${iconContent}// edit`, { track: true });
  res = repo.run(["--staged"], config);
  assert.equal(res.code, 1);
  assert.match(res.err, /SHA-256/);
});

test("CLI runs both `package-kit file-budget` and `package-kit check file-budget`, and preserves `package-kit check`", t => {
  const repo = makeRepo(
    t,
    {
      "src/small.ts": "export const x = 1;\n",
      "src/big.ts": "x".repeat(1500),
    },
    `export default {
      fileBudget: {
        rules: [
          { glob: "src/**/*.ts", bytes: 1000 },
        ],
      },
    };\n`,
  );
  repo.git("add", "-A");

  const viaSubcommand = repo.runCli("check", "file-budget", "--json");
  assert.equal(viaSubcommand.status, 1);
  const report1 = JSON.parse(viaSubcommand.stdout);
  assert.equal(report1.oversized.length, 1);
  assert.equal(report1.oversized[0].path, "src/big.ts");

  const viaDirect = repo.runCli("file-budget", "--staged", "--json");
  assert.equal(viaDirect.status, 1);
  const report2 = JSON.parse(viaDirect.stdout);
  assert.equal(report2.mode, "changed-index");
  assert.equal(report2.oversized.length, 1);
  assert.equal(report2.oversized[0].path, "src/big.ts");
});

test("parseAllowlist and formatAllowlist round-trip JSON and text allowlists and report malformed lines", () => {
  const problems = [];
  const parsedText = parseAllowlist("# header\nsrc/a.swift 900\nsrc/b.swift bad\nsrc/a.swift 850\n", {
    file: "allow.txt",
    defaultUnit: "lines",
    problems,
  });
  assert.equal(problems.length, 2);
  assert.match(problems[0], /allow\.txt:3: expected `<path> <maximum>`/);
  assert.match(problems[1], /allow\.txt:4: duplicate allowlist entry/);
  assert.equal(formatAllowlist(parsedText, { file: "allow.txt", defaultUnit: "lines" }), "src/a.swift 900\n");

  const jsonText = formatAllowlist(parsedText, { file: "allow.json", defaultUnit: "lines" });
  assert.deepEqual(JSON.parse(jsonText), { version: 1, files: { "src/a.swift": 900 } });
  const reparsed = parseAllowlist(jsonText, { file: "allow.json", defaultUnit: "lines" });
  assert.deepEqual(reparsed.get("src/a.swift"), { lines: 900 });
});

test("fileBudgetConfig validates rule syntax and reuses src/glob.mjs error messages", () => {
  assert.throws(() => fileBudgetConfig({ fileBudget: { rules: [{ glob: "src/[ab].ts", lines: 100 }] } }), /character classes/);
  assert.throws(() => fileBudgetConfig({ fileBudget: { rules: [{ glob: "src/*.ts", lines: 100, bytes: 100 }] } }), /either "lines" or "bytes"/);
  assert.throws(() => fileBudgetConfig({ fileBudget: { rules: [{ glob: "src/*.ts", lines: 0 }] } }), /positive integer/);
  assert.throws(() => parseExemptions('{"version":2}', new Set()), /invalid file-size exemption manifest/);
});
