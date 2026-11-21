// `repo-kit rust <cache|toolchain|msrv>`: shared Cargo build cache, pinned
// toolchain preflight, and declared-minimum Rust (MSRV) container check.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { projectName } from "./slotfather.mjs";
import {
  INCOMPLETE,
  OVERSIZED,
  POOL,
  SEED,
  diskFreeBytes,
  flock,
  forgetLocal,
  partitionSize,
  poolCap,
  prunePool,
  retirePools,
  seedKey,
  waitRecord,
  waitedFor,
} from "./rust/cache.mjs";
import { runMsrv } from "./rust/msrv.mjs";
import { Refusal, currentToolchain, resolveToolchain } from "./rust/toolchain.mjs";

export * from "./rust/cache.mjs";
export * from "./rust/msrv.mjs";
export * from "./rust/toolchain.mjs";

const HEX64_RE = /^[0-9a-f]{64}$/;

export function defaultCacheRoot(cwd = process.cwd(), env = process.env, config = {}) {
  const override = config?.rust?.cacheRoot || env.REPO_KIT_BUILD_CACHE || env.STRAYLIGHT_BUILD_CACHE;
  if (override) return path.resolve(override);
  const project = projectName(cwd);
  if (process.platform === "darwin") return path.join(env.HOME || os.homedir(), "Library/Caches", project);
  const base = env.XDG_CACHE_HOME || path.join(env.HOME || os.homedir(), ".cache");
  return path.join(base, project);
}

export function cloneDirectory(source, destination) {
  execFileSync("/bin/cp", ["-cR", source, destination], { stdio: "ignore" });
}

export function localPackages(command, manifest, { cwd, env } = {}) {
  try {
    const res = spawnSync(command[0], ["metadata", "--format-version=1", "--frozen", "--manifest-path", manifest], {
      cwd, env, encoding: "utf8", timeout: 300_000,
    });
    if (res.status !== 0) return null;
    const metadata = JSON.parse(res.stdout);
    const packages = new Set();
    const crates = new Set();
    for (const pkg of metadata.packages.filter(p => p.source === null)) {
      packages.add(pkg.name);
      packages.add(pkg.name.replaceAll("-", "_"));
      for (const target of pkg.targets ?? []) crates.add(target.name.replaceAll("-", "_"));
    }
    return { packages, crates };
  } catch {
    return null;
  }
}

export function seedPartition(cache, key, target, seed, command, manifest, {
  cwd, env = process.env, config, platform = process.platform, clone = cloneDirectory,
} = {}) {
  if (platform !== "darwin") return null;
  const limit = Math.floor(poolCap({ env, config }) / 2);
  const candidatesList = [];
  for (const name of fs.existsSync(cache) ? fs.readdirSync(cache) : []) {
    if (!HEX64_RE.test(name) || name === key) continue;
    const full = path.join(cache, name);
    try {
      if (fs.lstatSync(full).isSymbolicLink() || !fs.statSync(full).isDirectory()) continue;
      if (fs.readFileSync(path.join(full, SEED), "utf8") !== seed) continue;
      const oversized = fs.existsSync(path.join(full, OVERSIZED))
        && Number.parseInt(fs.readFileSync(path.join(full, OVERSIZED), "utf8"), 10) >= limit;
      if (!oversized) candidatesList.push({ name, path: full, mtime: fs.statSync(full).mtimeMs });
    } catch {}
  }
  if (!candidatesList.length) return null;
  const local = localPackages(command, manifest, { cwd, env });
  if (!local) return null;
  const staging = path.join(cache, `${key}.seeding`);
  fs.rmSync(staging, { recursive: true, force: true });
  for (const candidate of candidatesList.sort((a, b) => b.mtime - a.mtime)) {
    const lockFd = fs.openSync(path.join(cache, `${candidate.name}.lock`), "a");
    let cloned = false;
    try {
      if (!flock(lockFd, { nonblock: true })) continue;
      if (!fs.existsSync(candidate.path) || fs.existsSync(path.join(candidate.path, INCOMPLETE))) continue;
      if (fs.readFileSync(path.join(candidate.path, SEED), "utf8") !== seed) continue;
      clone(candidate.path, staging);
      cloned = true;
    } catch {
      fs.rmSync(staging, { recursive: true, force: true });
      continue;
    } finally {
      fs.closeSync(lockFd);
    }
    if (!cloned) continue;
    try {
      forgetLocal(staging, local.packages, local.crates);
      if (partitionSize(staging) > limit) {
        fs.rmSync(staging, { recursive: true, force: true });
        const rejectFd = fs.openSync(path.join(cache, `${candidate.name}.lock`), "a");
        try {
          if (flock(rejectFd, { nonblock: true }) && fs.readFileSync(path.join(candidate.path, SEED), "utf8") === seed) {
            fs.writeFileSync(path.join(candidate.path, OVERSIZED), String(limit));
          }
        } catch {} finally {
          fs.closeSync(rejectFd);
        }
        return null;
      }
      fs.rmSync(target, { recursive: true, force: true });
      fs.renameSync(staging, target);
      return candidate.name;
    } catch {
      fs.rmSync(staging, { recursive: true, force: true });
      return null;
    }
  }
  return null;
}

function withPoolLock(cache, fn) {
  const fd = fs.openSync(path.join(cache, "build.lock"), "a");
  try {
    flock(fd);
    return fn();
  } finally {
    fs.closeSync(fd);
  }
}

export async function cargoBuild(command, toolchain, {
  codegen, timings, validate, cacheRoot, prepare = [], cwd = process.cwd(), env = process.env,
  config, diskFree = diskFreeBytes, platform = process.platform, clone = cloneDirectory,
  stdio = ["ignore", "inherit", "inherit"],
} = {}, callback) {
  if (!HEX64_RE.test(toolchain) || !HEX64_RE.test(codegen ?? toolchain)) {
    throw new Error("Cargo cache key must be a SHA-256 digest");
  }
  const rootDir = path.resolve(cacheRoot ?? defaultCacheRoot(cwd, env, config));
  const cache = path.join(rootDir, POOL);
  fs.mkdirSync(cache, { recursive: true });
  retirePools(rootDir);
  const manifestIdx = command.indexOf("--manifest-path");
  if (manifestIdx === -1 || !command[manifestIdx + 1]) throw new Error("Cargo command requires --manifest-path");
  const rawManifest = command[manifestIdx + 1];
  const manifestPath = path.isAbsolute(rawManifest) ? rawManifest : path.resolve(cwd, rawManifest);
  const realManifest = fs.existsSync(manifestPath) ? fs.realpathSync(manifestPath) : manifestPath;
  const key = crypto.createHash("sha256").update(`${toolchain}\0${realManifest}`).digest("hex");
  const target = path.join(cache, key);
  const lockFd = fs.openSync(path.join(cache, `${key}.lock`), "a");
  try {
    const waitingStart = performance.now();
    const waiter = waitRecord(cache, key);
    try { flock(lockFd); } finally { waiter.close(); }
    if (timings) timings.lock_seconds = (performance.now() - waitingStart) / 1000;
    withPoolLock(cache, () => {
      prunePool(cache, key, { keepOwned: true, env, config, diskFree });
      fs.mkdirSync(target, { recursive: true });
    });
    if (fs.lstatSync(target).isSymbolicLink()) throw new Error("Cargo cache partition must not be a symlink");
    const incomplete = path.join(target, INCOMPLETE);
    if (validate && fs.existsSync(incomplete)) {
      fs.rmSync(target, { recursive: true, force: true });
      fs.mkdirSync(target, { recursive: true });
    }
    let fresh = fs.readdirSync(target).length === 0;
    const seed = seedKey(command, realManifest, codegen ?? toolchain, { env });
    if (fresh) {
      const seedStart = performance.now();
      const seeded = seedPartition(cache, key, target, seed, command, realManifest, { cwd, env, config, platform, clone });
      if (seeded) {
        fresh = false;
        const elapsed = (performance.now() - seedStart) / 1000;
        if (timings) { timings.seeded_from = seeded; timings.seed_seconds = elapsed; }
        process.stderr.write(`cargo-build-cache: seeded ${key.slice(0, 12)} from ${seeded.slice(0, 12)} in ${elapsed.toFixed(2)}s\n`);
      }
    }
    if (fresh && prepare.length) {
      fs.writeFileSync(path.join(target, "CACHEDIR.TAG"), "Signature: 8a477f597d28d172789f06886806bc55\n");
    }
    if (validate) fs.writeFileSync(incomplete, "");
    let activeChild = null;
    const killGroup = pid => { if (pid) { try { process.kill(-pid, "SIGKILL"); } catch {} } };
    try {
      for (const current of [...(!fresh ? prepare : []), command]) {
        const sep = current.includes("--") ? current.indexOf("--") : current.length;
        const invocation = [...current.slice(0, sep), "--target-dir", target, ...current.slice(sep)];
        const code = await new Promise((resolve, reject) => {
          const child = spawn(invocation[0], invocation.slice(1), {
            cwd, env, detached: true,
            stdio: [stdio[0] ?? "ignore", stdio[1] ?? "inherit", stdio[2] ?? "inherit", lockFd],
          });
          activeChild = child;
          child.on("error", reject);
          child.on("close", exitCode => resolve(exitCode ?? 1));
        });
        killGroup(activeChild?.pid);
        activeChild = null;
        if (code !== 0) {
          const err = new Error(`Cargo command exited with ${code}`);
          err.returncode = code;
          throw err;
        }
      }
      if (validate && !(await validate())) throw new Error("Cargo test inputs changed during execution");
      if (validate) fs.rmSync(incomplete, { force: true });
      fs.writeFileSync(path.join(target, SEED), seed);
      if (callback) await callback(target);
      return target;
    } catch (error) {
      killGroup(activeChild?.pid);
      activeChild = null;
      if (validate) {
        fs.rmSync(target, { recursive: true, force: true });
        fs.mkdirSync(target, { recursive: true });
      }
      throw error;
    } finally {
      killGroup(activeChild?.pid);
      try { if (fs.existsSync(target)) { const now = new Date(); fs.utimesSync(target, now, now); } } catch {}
      withPoolLock(cache, () => {
        prunePool(cache, key, { keepOwned: waitedFor(cache, key), env, config, diskFree });
      });
    }
  } finally {
    fs.closeSync(lockFd);
  }
}

const RUST_USAGE = `Usage: repo-kit rust <subcommand>
  rust cache --toolchain <sha256> [--codegen <sha256>] [--cache-root <dir>] -- <cargo command...>
  rust toolchain [--root <dir>] [--json] [--current]
  rust msrv [--root <dir>] [--cache <dir>] [--image <image>] [--declared <version>]`;

export async function runRust([subcommand, ...args], { config = {}, root = config.root ?? process.cwd(), env = process.env } = {}) {
  if (!subcommand || subcommand === "help" || subcommand === "--help") return console.log(RUST_USAGE), 0;
  if (subcommand === "toolchain") {
    const { values } = parseArgs({
      args,
      options: { root: { type: "string" }, json: { type: "boolean", default: false }, current: { type: "boolean", default: false } },
    });
    const targetRoot = path.resolve(values.root ?? root);
    try {
      if (values.current) return console.log(JSON.stringify(currentToolchain(targetRoot, env))), 0;
      const resolved = resolveToolchain(targetRoot, env);
      console.log(values.json ? JSON.stringify(resolved) : resolved.bin);
      return 0;
    } catch (error) {
      if (error instanceof Refusal) return console.error(error.message), 1;
      throw error;
    }
  }
  if (subcommand === "msrv") {
    const { values } = parseArgs({
      args,
      options: { root: { type: "string" }, cache: { type: "string" }, image: { type: "string" }, declared: { type: "string" }, toolchain: { type: "string" }, "crate-dir": { type: "string" } },
    });
    return runMsrv(path.resolve(values.root ?? root), {
      cache: values.cache ? path.resolve(values.cache) : undefined,
      config, env, image: values.image, declared: values.declared, toolchain: values.toolchain, crateDir: values["crate-dir"],
    });
  }
  if (subcommand === "cache") {
    const dashDash = args.indexOf("--");
    const flagArgs = dashDash === -1 ? args : args.slice(0, dashDash);
    const cmdArgs = dashDash === -1 ? [] : args.slice(dashDash + 1);
    const { values, positionals } = parseArgs({
      args: flagArgs, allowPositionals: true,
      options: { toolchain: { type: "string" }, codegen: { type: "string" }, "cache-root": { type: "string" } },
    });
    const command = cmdArgs.length ? cmdArgs : positionals;
    if (!values.toolchain || !command.length) return console.error(RUST_USAGE), 1;
    try {
      await cargoBuild(command, values.toolchain, { codegen: values.codegen, cacheRoot: values["cache-root"], cwd: root, env, config });
      return 0;
    } catch (error) {
      if (typeof error?.returncode === "number") return error.returncode;
      return console.error(`repo-kit rust cache: ${error.message}`), 1;
    }
  }
  return console.error(RUST_USAGE), 1;
}
