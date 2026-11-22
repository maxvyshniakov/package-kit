import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_FREE_FLOOR_GB,
  GRADE,
  INCOMPLETE,
  KEEP_SEED_KEYS,
  OVERSIZED,
  POOL,
  POOL_CAP,
  Refusal,
  SEED,
  UNRUN,
  WAITING,
  cargoBuild,
  cargoConfiguration,
  containerScript,
  countsLine,
  currentToolchain,
  declarationErrors,
  evictTargets,
  flock,
  freeFloor,
  lanefatherMinimumGb,
  poolLimit,
  publishFile,
  resolveToolchain,
  retirePools,
  runMsrv,
  runRust,
  stagedOutput,
  targetTree,
  waitRecord,
  waitedFor,
} from "../src/rust.mjs";
import { kitRoot, tempRepository } from "./fixtures.mjs";

const binCli = path.join(kitRoot, "bin/repo-kit.mjs");
const PIN = "1.98.1";

function writeExecutable(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

test("rust modules stay under 300 lines each", () => {
  for (const rel of ["src/rust.mjs", "src/rust/cache.mjs", "src/rust/toolchain.mjs", "src/rust/msrv.mjs"]) {
    const lines = fs.readFileSync(path.join(kitRoot, rel), "utf8").split("\n").length;
    assert.ok(lines <= 300, `${rel} has ${lines} lines (> 300)`);
  }
});

test("rust toolchain resolves PATH, off-PATH rustup proxies, and Homebrew kegs, and refuses mismatches or overrides", () => {
  const repo = tempRepository({
    "rust-toolchain.toml": `[toolchain]\nchannel = "${PIN}"\n`,
    "rust-version": PIN,
  });
  try {
    const stub = expr => `#!/bin/sh\nversion=${expr} || exit 127\necho "$(basename "$0") $version (stub)"\n`;
    for (const name of ["rustc", "cargo"]) {
      writeExecutable(path.join(repo.root, "bin", name), stub(`"$(cat "${path.join(repo.root, "rust-version")}")"`));
    }
    const baseEnv = {
      PATH: `${path.join(repo.root, "bin")}:/usr/bin:/bin`,
      HOMEBREW_PREFIX: path.join(repo.root, "brew"),
      CARGO_HOME: path.join(repo.root, "cargo"),
      HOME: repo.root,
    };

    // 1. PATH already serves the pin -> bin is "".
    const fromPath = resolveToolchain(repo.root, baseEnv);
    assert.equal(fromPath.pinned, PIN);
    assert.equal(fromPath.source, "PATH");
    assert.equal(fromPath.bin, "");
    assert.equal(fromPath.current.rustc, `rustc ${PIN} (stub)`);
    assert.equal(fromPath.current.rustc_origin, "PATH");

    // 2. CLI via bin/repo-kit.mjs rust toolchain --json and --current.
    const cliJson = spawnSync(process.execPath, [binCli, "rust", "toolchain", "--root", repo.root, "--json"], {
      cwd: repo.root,
      env: baseEnv,
      encoding: "utf8",
    });
    assert.equal(cliJson.status, 0, cliJson.stderr);
    assert.equal(JSON.parse(cliJson.stdout).pinned, PIN);

    const cliCurrent = spawnSync(process.execPath, [binCli, "rust", "toolchain", "--root", repo.root, "--current"], {
      cwd: repo.root,
      env: baseEnv,
      encoding: "utf8",
    });
    assert.equal(cliCurrent.status, 0, cliCurrent.stderr);
    assert.equal(JSON.parse(cliCurrent.stdout).cargo, `cargo ${PIN} (stub)`);

    // 3. When PATH moves to 1.99.1, a Homebrew keg of the pinned version serves the run.
    fs.writeFileSync(path.join(repo.root, "rust-version"), "1.99.1");
    assert.throws(() => resolveToolchain(repo.root, baseEnv), err => err instanceof Refusal && /rustc 1\.99\.1/.test(err.message));

    for (const name of ["rustc", "cargo"]) {
      writeExecutable(path.join(repo.root, `brew/Cellar/rust/${PIN}/bin`, name), stub(`"${PIN}"`));
    }
    const fromKeg = resolveToolchain(repo.root, baseEnv);
    assert.equal(fromKeg.source, "homebrew-keg");
    assert.equal(fromKeg.bin, path.join(repo.root, `brew/Cellar/rust/${PIN}/bin`));

    // 4. Off-PATH rustup proxies resolve in the checkout before a Homebrew keg.
    const proxy = `"$( [ -f rust-toolchain.toml ] && echo ${PIN} || echo 1.99.1 )"`;
    for (const name of ["rustc", "cargo"]) {
      writeExecutable(path.join(repo.root, "brew/opt/rustup/bin", name), stub(proxy));
    }
    const fromRustup = resolveToolchain(repo.root, baseEnv);
    assert.equal(fromRustup.source, "rustup");
    assert.equal(fromRustup.bin, path.join(repo.root, "brew/opt/rustup/bin"));

    // 5. RUSTC, CARGO_BUILD_RUSTC, and .cargo/config.toml build.rustc (including includes) override PATH and are checked.
    fs.writeFileSync(path.join(repo.root, "rust-version"), PIN);
    writeExecutable(path.join(repo.root, "other/rustc"), stub('"1.99.1"'));
    for (const how of ["RUSTC", "CARGO_BUILD_RUSTC"]) {
      assert.throws(
        () => resolveToolchain(repo.root, { ...baseEnv, [how]: path.join(repo.root, "other/rustc") }),
        err => err instanceof Refusal && err.message.includes(how),
      );
    }
    fs.mkdirSync(path.join(repo.root, ".cargo"), { recursive: true });
    fs.writeFileSync(path.join(repo.root, ".cargo/extra.toml"), '[build]\nrustc = "other/rustc"\n');
    fs.writeFileSync(path.join(repo.root, ".cargo/config.toml"), 'include = [{ path = "extra.toml" }]\n');
    assert.equal(currentToolchain(repo.root, baseEnv).rustc_origin, "build.rustc");
    assert.throws(
      () => resolveToolchain(repo.root, baseEnv),
      err => err instanceof Refusal && err.message.includes("build.rustc"),
    );

    // Cycle detection in Cargo config includes.
    fs.writeFileSync(path.join(repo.root, ".cargo/extra.toml"), 'include = ["config.toml"]\n');
    assert.throws(() => cargoConfiguration(repo.root, baseEnv), /include cycle/);
  } finally {
    repo.cleanup();
  }
});

test("rust msrv validates crate declarations, handles missing Docker/images with UNRUN (77), caches targets by lockfile, and relays counts", async () => {
  const repo = tempRepository({});
  try {
    const crates = ["straylight-link-linux", "straylight-core", "ulanzi-codec"];
    const writeManifest = (crate, version) => {
      const file = path.join(repo.root, "native", crate, "Cargo.toml");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const decl = version ? `rust-version = "${version}"\n` : "";
      fs.writeFileSync(file, `[package]\nname = "${crate}"\nversion = "0.1.0"\nedition = "2021"\n${decl}`);
    };
    for (const crate of [...crates, "minidsp-session"]) writeManifest(crate, "1.98");

    const fakeBin = path.join(repo.root, "fake-bin");
    const dockerLog = path.join(repo.root, "docker.jsonl");
    const cacheDir = path.join(repo.root, "cache");
    writeExecutable(path.join(fakeBin, "docker"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "info") process.exit(Number(process.env.FAKE_DOCKER_INFO || "0"));
if (args[0] === "image") process.exit(Number(process.env.FAKE_DOCKER_IMAGE || "0"));
if (args[0] === "run") {
  const out = process.env.FAKE_DOCKER_OUTPUT;
  process.stdout.write(out ? fs.readFileSync(out, "utf8") : "container output\\n");
  process.exit(Number(process.env.FAKE_DOCKER_RUN || "0"));
}
process.exit(0);
`);

    const runCheck = async (extraEnv = {}, overrides = {}) => {
      let stdout = "";
      let stderr = "";
      const nodeBin = path.dirname(process.execPath);
      const env = {
        ...process.env,
        PATH: extraEnv.PATH ?? `${fakeBin}${path.delimiter}${nodeBin}${path.delimiter}/usr/bin:/bin`,
        FAKE_DOCKER_LOG: dockerLog,
        CARGO_BUILD_JOBS: "1",
        RUST_TEST_THREADS: "1",
        ...extraEnv,
      };
      const code = await runMsrv(repo.root, {
        cache: cacheDir,
        env,
        stdout: { write: s => { stdout += s; } },
        stderr: { write: s => { stderr += s; } },
        ...overrides,
      });
      const calls = fs.existsSync(dockerLog)
        ? fs.readFileSync(dockerLog, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l))
        : [];
      return { code, stdout, stderr, calls };
    };

    // 1. Missing Docker -> UNRUN (77). Use an empty directory rather than
    // /usr/bin:/bin because Linux CI runners install docker in /usr/bin.
    const emptyBin = path.join(repo.root, "empty-bin");
    fs.mkdirSync(emptyBin);
    const noDocker = await runCheck({ PATH: emptyBin });
    assert.equal(noDocker.code, UNRUN);
    assert.equal(UNRUN, 77);
    assert.match(noDocker.stdout, /rust-msrv: unrun: Docker is unavailable/);

    // 2. Stopped daemon -> UNRUN (77).
    fs.rmSync(dockerLog, { force: true });
    const stoppedDaemon = await runCheck({ FAKE_DOCKER_INFO: "1" });
    assert.equal(stoppedDaemon.code, UNRUN);
    assert.deepEqual(stoppedDaemon.calls.map(c => c[0]), ["info"]);

    // 3. Missing image -> UNRUN (77) with pull command.
    fs.rmSync(dockerLog, { force: true });
    const missingImage = await runCheck({ FAKE_DOCKER_IMAGE: "1" });
    assert.equal(missingImage.code, UNRUN);
    assert.match(missingImage.stdout, /docker pull --platform linux\//);

    // 4. Mismatched or missing rust-version fails before Docker.
    fs.rmSync(dockerLog, { force: true });
    writeManifest("ulanzi-codec", "1.99");
    const badDecl = await runCheck();
    assert.equal(badDecl.code, 1);
    assert.match(badDecl.stderr, /native\/ulanzi-codec\/Cargo\.toml declares rust-version '1\.99'/);
    assert.deepEqual(badDecl.calls, []);
    writeManifest("ulanzi-codec", "1.98");

    // 5. Green run passes, mounts cargo-home and lockfile-keyed target tree, and prints per-crate test counts.
    const cargoOut = path.join(repo.root, "cargo-out.txt");
    fs.writeFileSync(cargoOut, [
      "rust-msrv: testing straylight-link-linux",
      "test result: ok. 40 passed; 0 failed; 0 ignored",
      "test result: ok. 2 passed; 0 failed; 0 ignored",
      "rust-msrv: testing straylight-core",
      "test result: ok. 914 passed; 0 failed; 0 ignored",
      "rust-msrv: testing ulanzi-codec",
      "test result: ok. 8 passed; 0 failed; 0 ignored",
      "",
    ].join("\n"));
    const green = await runCheck({ FAKE_DOCKER_OUTPUT: cargoOut });
    assert.equal(green.code, 0, green.stdout + green.stderr);
    assert.match(
      green.stdout,
      /rust-msrv: Linux tests: straylight-link-linux 42 passed, straylight-core 914 passed, ulanzi-codec 8 passed/,
    );
    const runCall = green.calls.find(c => c[0] === "run");
    assert.ok(runCall.includes("RUSTUP_TOOLCHAIN=1.98.1"));
    assert.ok(runCall.includes("RUSTUP_AUTO_INSTALL=0"));
    const script = runCall.at(-1);
    assert.ok(script.lastIndexOf("cargo clean") < script.indexOf("cargo test"));

    // 6. Target tree eviction keeps only the 2 most recent target trees.
    const targetsDir = path.join(cacheDir, "targets");
    for (const [idx, name] of ["newest", "older", "oldest"].entries()) {
      const dir = path.join(targetsDir, name);
      fs.mkdirSync(dir, { recursive: true });
      const t = new Date((1_000_000 - idx) * 1000);
      fs.utimesSync(dir, t, t);
    }
    const currentTree = targetTree(repo.root, cacheDir, "linux/arm64", { crates });
    evictTargets(cacheDir, currentTree);
    assert.deepEqual(
      fs.readdirSync(targetsDir).sort(),
      [path.basename(currentTree), "newest"].sort(),
    );

    // 7. Container script compiler guard refuses a mismatched compiler before any build.
    const stubBin = path.join(repo.root, "stub-bin");
    const cargoCalls = path.join(repo.root, "cargo.log");
    writeExecutable(path.join(stubBin, "apt-get"), "#!/bin/sh\nexit 0\n");
    writeExecutable(path.join(stubBin, "rustc"), '#!/bin/sh\necho "rustc 1.99.1 (stub)"\n');
    writeExecutable(path.join(stubBin, "cargo"), `#!/bin/sh\necho "$@" >> "${cargoCalls}"\n`);
    const badContainer = spawnSync("sh", ["-c", containerScript({ crates, target: "aarch64-unknown-linux-gnu" })], {
      env: { PATH: `${stubBin}:/usr/bin:/bin`, RUSTUP_TOOLCHAIN: "1.98.1" },
      encoding: "utf8",
    });
    assert.notEqual(badContainer.status, 0);
    assert.match(badContainer.stderr, /the container runs rustc 1\.99\.1 \(stub\), not 1\.98\.1/);
    assert.equal(fs.existsSync(cargoCalls), false);
  } finally {
    repo.cleanup();
  }
});

test("rust cache manages versioned pools, retired pools, Lanefather disk floor, graded limits, waiting records, seeding, and atomic staging", async () => {
  const repo = tempRepository({});
  try {
    const cacheRoot = path.join(repo.root, "cache");
    const fakeBin = path.join(repo.root, "bin");
    const buildLog = path.join(repo.root, "builds.jsonl");

    writeExecutable(path.join(fakeBin, "cargo"), `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const mIdx = args.indexOf("--manifest-path");
const manifest = args[mIdx + 1];
const local = path.basename(path.dirname(manifest));
if (args[0] === "metadata") {
  console.log(JSON.stringify({
    packages: [
      { name: local, source: null, targets: [{ name: local.replaceAll("-", "_") }] },
      { name: "registry-dep", source: "registry+https://github.com/rust-lang/crates.io-index", targets: [{ name: "registry_dep" }] }
    ]
  }));
  process.exit(0);
}
const tIdx = args.indexOf("--target-dir");
const target = args[tIdx + 1];
const value = fs.readFileSync(path.join(path.dirname(manifest), "src/lib.rs"), "utf8");
const seen = [];
const walk = dir => {
  for (const e of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else seen.push(path.relative(target, full));
  }
};
walk(target);
seen.sort();
fs.appendFileSync(process.env.BUILD_LOG, JSON.stringify({ target, value, command: args[0], seen }) + "\\n");
if (process.env.BUILD_FAIL === "1") process.exit(42);
const profile = path.join(target, "x86_64-unknown-linux-gnu/release");
for (const name of [local + "-0123456789abcdef", "registry-dep-fedcba9876543210"]) {
  fs.mkdirSync(path.join(profile, ".fingerprint", name), { recursive: true });
  fs.writeFileSync(path.join(profile, ".fingerprint", name, "lib"), value);
}
fs.mkdirSync(path.join(profile, "deps"), { recursive: true });
fs.writeFileSync(path.join(profile, "deps/libregistry_dep-fedcba9876543210.rlib"), value);
fs.writeFileSync(path.join(profile, "deps/lib" + local.replaceAll("-", "_") + ".a"), value);
fs.mkdirSync(path.join(profile, "incremental"), { recursive: true });
fs.writeFileSync(path.join(profile, "incremental/session"), value);
fs.writeFileSync(path.join(profile, "lib" + local.replaceAll("-", "_") + ".so"), value);
`);

    const env = {
      ...process.env,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
      REPO_KIT_BUILD_CACHE: cacheRoot,
      REPO_KIT_BUILD_CACHE_FREE_FLOOR_BYTES: "0",
      BUILD_LOG: buildLog,
    };

    const makeCheckout = (name, sourceValue) => {
      const dir = path.join(repo.root, name, "native/straylight-core");
      fs.mkdirSync(path.join(dir, "src"), { recursive: true });
      fs.writeFileSync(path.join(dir, "Cargo.toml"), '[package]\nname = "straylight-core"\nversion = "0.1.0"\n');
      fs.writeFileSync(path.join(dir, "src/lib.rs"), sourceValue);
      return path.join(dir, "Cargo.toml");
    };

    // 1. Versioned pool (cargo-v4) and retiring idle unlocked older pools (cargo-v2, cargo-v3).
    assert.equal(POOL, "cargo-v4");
    const oldPool = path.join(cacheRoot, "cargo-v3");
    const oldPart = path.join(oldPool, "a".repeat(64));
    fs.mkdirSync(oldPart, { recursive: true });
    const lockPath = path.join(oldPool, `${"a".repeat(64)}.lock`);
    fs.writeFileSync(lockPath, "");
    const oldDate = new Date(Date.now() - 25 * 3600 * 1000);
    for (const p of [oldPart, lockPath, oldPool]) fs.utimesSync(p, oldDate, oldDate);

    // While a lock is held in oldPool, retirePools leaves it alone.
    const heldFd = fs.openSync(lockPath, "a");
    flock(heldFd);
    retirePools(cacheRoot);
    assert.equal(fs.existsSync(oldPool), true, "locked retired pool stays");
    fs.closeSync(heldFd);
    fs.utimesSync(lockPath, oldDate, oldDate);
    fs.utimesSync(oldPool, oldDate, oldDate);
    retirePools(cacheRoot);
    assert.equal(fs.existsSync(oldPool), false, "unlocked idle retired pool is removed");

    // 2. Partition reuse within a checkout and APFS clone seeding across checkouts without local packages.
    const m1 = makeCheckout("first", "first sources");
    const m2 = makeCheckout("second", "second sources");
    const toolchain = "a".repeat(64);
    const cmd = manifest => [path.join(fakeBin, "cargo"), "build", "--locked", "--release", "--manifest-path", manifest];

    const t1 = {};
    const p1 = await cargoBuild(cmd(m1), toolchain, { cacheRoot, env, timings: t1 });
    const p1Again = await cargoBuild(cmd(m1), toolchain, { cacheRoot, env });
    assert.equal(p1, p1Again);

    const t2 = {};
    const p2 = await cargoBuild(cmd(m2), toolchain, { cacheRoot, env, timings: t2 });
    assert.notEqual(p1, p2);
    const builds = fs.readFileSync(buildLog, "utf8").trim().split("\n").map(l => JSON.parse(l));
    if (process.platform === "darwin") {
      assert.equal(t2.seeded_from, path.basename(p1));
      const seen = builds[2].seen;
      assert.ok(seen.includes("x86_64-unknown-linux-gnu/release/.fingerprint/registry-dep-fedcba9876543210/lib"));
      assert.ok(seen.includes("x86_64-unknown-linux-gnu/release/deps/libregistry_dep-fedcba9876543210.rlib"));
      assert.deepEqual(seen.filter(p => p.includes("straylight") || p.includes("incremental")), []);
    }

    // 3. Lanefather free-disk floor discovery and linear graded retention limit.
    const lfShare = path.join(repo.root, "lf-share");
    const lfBin = path.join(repo.root, "lf-bin");
    fs.mkdirSync(path.join(lfShare, "current/lanefather"), { recursive: true });
    fs.writeFileSync(path.join(lfShare, "current/lanefather/host.py"), "MIN_DISK_GB = 120\n");
    writeExecutable(
      path.join(lfBin, "lanefather"),
      `#!/usr/bin/env python3\nimport sys\nsys.path.insert(0, '${path.join(lfShare, "current")}')\n`,
    );
    assert.equal(lanefatherMinimumGb({ env: { PATH: lfBin, HOME: repo.root } }), 120);
    assert.equal(freeFloor({ env: { PATH: lfBin, HOME: repo.root } }), 120 * 1000 ** 3);
    assert.equal(lanefatherMinimumGb({ env: { PATH: "/nonexistent", HOME: repo.root } }), DEFAULT_FREE_FLOOR_GB);

    const gb = 1000 ** 3;
    const gib = 1024 ** 3;
    assert.equal(poolLimit(cacheRoot, { free: 100 * gb, floor: 150 * gb, env: {} }), 0);
    assert.equal(poolLimit(cacheRoot, { free: 150 * gb, floor: 150 * gb, env: {} }), 0);
    assert.equal(poolLimit(cacheRoot, { free: 175 * gb, floor: 150 * gb, env: {} }), 16 * gib);
    assert.equal(poolLimit(cacheRoot, { free: 200 * gb, floor: 150 * gb, env: {} }), 32 * gib);
    assert.equal(GRADE, 50 * gb);
    assert.equal(POOL_CAP, 32 * gib);
    assert.equal(KEEP_SEED_KEYS, 4);

    // 4. Waiting records: a live shared lock protects the partition; a closed/dead record is cleaned up.
    const poolDir = path.join(cacheRoot, POOL);
    const waiter = waitRecord(poolDir, path.basename(p1));
    assert.equal(waitedFor(poolDir, path.basename(p1)), true);
    waiter.close();
    const staleRecord = path.join(poolDir, `${path.basename(p1)}${WAITING}999999-dead`);
    fs.writeFileSync(staleRecord, "");
    assert.equal(waitedFor(poolDir, path.basename(p1)), false);
    assert.equal(fs.existsSync(staleRecord), false);

    // 5. Provenance validate failure wipes the partition and removes incomplete markers on next run.
    await assert.rejects(
      () => cargoBuild(cmd(m1), toolchain, { cacheRoot, env, validate: () => false }),
      /inputs changed/,
    );
    assert.deepEqual(fs.readdirSync(p1), []);
    fs.writeFileSync(path.join(p1, INCOMPLETE), "");
    fs.writeFileSync(path.join(p1, "poisoned"), "bad");
    await cargoBuild(cmd(m1), toolchain, { cacheRoot, env, validate: () => true });
    assert.equal(fs.existsSync(path.join(p1, "poisoned")), false);
    assert.equal(fs.existsSync(path.join(p1, INCOMPLETE)), false);
    assert.equal(fs.existsSync(path.join(p1, SEED)), true);
    assert.equal(OVERSIZED, ".repo-kit-seed-oversized");

    // 6. stagedOutput and publishFile atomically replace destination and preserve open readers and file mode.
    const destFile = path.join(repo.root, "artifact.json");
    fs.writeFileSync(destFile, '{"old":true}');
    fs.chmodSync(destFile, 0o640);
    const readerFd = fs.openSync(destFile, "r");
    try {
      await stagedOutput(destFile, staged => {
        fs.writeFileSync(staged, '{"new":true}');
        assert.equal(fs.readFileSync(destFile, "utf8"), '{"old":true}');
      });
      const oldBuf = Buffer.alloc(64);
      const bytesRead = fs.readSync(readerFd, oldBuf, 0, 64, 0);
      assert.equal(oldBuf.toString("utf8", 0, bytesRead), '{"old":true}');
    } finally {
      fs.closeSync(readerFd);
    }
    assert.equal(fs.readFileSync(destFile, "utf8"), '{"new":true}');
    assert.equal(fs.statSync(destFile).mode & 0o777, 0o640);

    const srcFile = path.join(repo.root, "src-lib.so");
    const pubFile = path.join(repo.root, "pub-lib.so");
    fs.writeFileSync(srcFile, "binary-payload");
    fs.chmodSync(srcFile, 0o751);
    await publishFile(srcFile, pubFile);
    assert.equal(fs.readFileSync(pubFile, "utf8"), "binary-payload");
    assert.equal(fs.statSync(pubFile).mode & 0o777, 0o751);

    // 7. CLI `repo-kit rust cache --toolchain <sha256> -- cargo ...`
    const cliCode = await runRust(
      ["cache", "--toolchain", toolchain, "--cache-root", cacheRoot, "--", ...cmd(m1)],
      { root: repo.root, env },
    );
    assert.equal(cliCode, 0);
  } finally {
    repo.cleanup();
  }
});
