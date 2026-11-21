// Shared machine-owned Cargo target pool with versioned on-disk protocol,
// APFS clone seeding, lock-held waiting records, and graded retention by free
// disk above Lanefather's minimum floor (`repo-kit rust cache`).
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const POOL = "cargo-v4";
export const RETIRED_POOLS = ["cargo-v2", "cargo-v3"];
export const RETIRE_AFTER = 24 * 3600;
export const SEED = ".repo-kit-seed";
export const INCOMPLETE = ".repo-kit-incomplete";
export const OVERSIZED = ".repo-kit-seed-oversized";
export const WAITING = ".waiting-";
export const POOL_CAP = 32 * 1024 ** 3;
export const DEFAULT_FREE_FLOOR_GB = 150;
export const GRADE = 50 * 1000 ** 3;
export const KEEP_SEED_KEYS = 4;

const PROFILE_KEEP = new Set([".fingerprint", "build", "deps"]);
const HEX64_RE = /^[0-9a-f]{64}$/;
const CODEGEN_ENV_RE = /^(?:RUSTFLAGS|RUSTDOCFLAGS|RUSTC\w*|RUSTUP_TOOLCHAIN|CARGO_(?:BUILD|ENCODED|TARGET|PROFILE)_\w+|SDKROOT|DEVELOPER_DIR|\w+_DEPLOYMENT_TARGET|ARCHFLAGS|(?:HOST_|TARGET_)?(?:CC|CXX|CPP|C|LD|AR|RANLIB)(?:FLAGS)?(?:_\w+)?|CMAKE\w*|PKG_CONFIG\w*|CRATE_CC_\w*|CPATH|CPLUS_INCLUDE_PATH|LIBRARY_PATH|LIBSQLITE3_\w+|SQLITE_\w+|OPUS_\w+)$/;
const SCHEDULING_RE = /^\w*(?:_JOBS|PARALLEL_LEVEL)$/;

/** Acquires an `flock(2)` lock on open file descriptor `fd` (shared across open file description). */
export function flock(fd, { shared = false, nonblock = false } = {}) {
  const op = `${shared ? "fcntl.LOCK_SH" : "fcntl.LOCK_EX"}${nonblock ? " | fcntl.LOCK_NB" : ""}`;
  const script = `import fcntl, sys\ntry:\n fcntl.flock(3, ${op})\nexcept BlockingIOError:\n sys.exit(11)`;
  const res = spawnSync("python3", ["-c", script], { stdio: ["ignore", "ignore", "pipe", fd] });
  if (res.status === 0) return true;
  if (nonblock && res.status === 11) return false;
  throw new Error(`flock failed: ${(res.stderr || "").toString().trim() || `exit ${res.status}`}`);
}

function withLockFile(lockPath, { nonblock = false } = {}, fn) {
  const fd = fs.openSync(lockPath, "a");
  try {
    return flock(fd, { nonblock }) ? { locked: true, value: fn(fd) } : { locked: false };
  } finally {
    fs.closeSync(fd);
  }
}

/** Publish one complete file atomically while existing readers retain the old inode. */
export async function stagedOutput(destination, fn) {
  const dest = path.resolve(destination);
  const parent = path.dirname(dest), base = path.basename(dest);
  fs.mkdirSync(parent, { recursive: true });
  const tempDir = fs.mkdtempSync(path.join(parent, `.${base}.`));
  const staged = path.join(tempDir, base);
  try {
    fs.writeFileSync(staged, "");
    if (fs.existsSync(dest)) fs.chmodSync(staged, fs.statSync(dest).mode & 0o777);
    await fn(staged);
    fs.renameSync(staged, dest);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export async function publishFile(source, destination) {
  await stagedOutput(destination, staged => {
    fs.copyFileSync(source, staged);
    fs.chmodSync(staged, fs.statSync(source).mode & 0o777);
  });
}

/** MIN_DISK_GB from the installed Lanefather's current release, read without importing or executing it. */
export function lanefatherMinimumGb({ env = process.env } = {}) {
  let share = env.LANEFATHER_SHARE ? path.resolve(env.LANEFATHER_SHARE) : null;
  if (!share) {
    for (const dir of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
      const cmd = path.join(dir, "lanefather");
      if (fs.existsSync(cmd) && fs.statSync(cmd).isFile()) {
        try {
          const match = fs.readFileSync(cmd, "utf8").match(/sys\.path\.insert\(\s*0\s*,\s*['"]([^'"]+\/current)['"]\s*\)/);
          if (match) share = path.dirname(match[1]);
        } catch {}
        break;
      }
    }
  }
  if (!share) share = path.join(env.HOME || os.homedir(), ".local/share/lanefather");
  try {
    const hostPy = fs.readFileSync(path.join(share, "current/lanefather/host.py"), "utf8");
    if (hostPy.includes("MIN_DISK_GB = (")) return DEFAULT_FREE_FLOOR_GB;
    for (const line of hostPy.split(/\r?\n/)) {
      const match = line.match(/^MIN_DISK_GB\s*=\s*(\d+(?:\.\d+)?)\s*(?:#.*)?$/);
      if (match) return Number(match[1]);
    }
  } catch {}
  return DEFAULT_FREE_FLOOR_GB;
}

export function freeFloor({ env = process.env, config } = {}) {
  const configured = env.REPO_KIT_BUILD_CACHE_FREE_FLOOR_BYTES
    ?? env.STRAYLIGHT_BUILD_CACHE_FREE_FLOOR_BYTES
    ?? config?.rust?.freeFloorBytes;
  if (configured !== undefined && configured !== "") {
    const floor = Number.parseInt(String(configured), 10);
    if (!Number.isFinite(floor) || floor < 0) throw new Error("Cargo cache free-space floor must not be negative");
    return floor;
  }
  return Math.round((config?.rust?.freeFloorGb ?? lanefatherMinimumGb({ env })) * 1000 ** 3);
}

export function poolCap({ env = process.env, config } = {}) {
  const raw = env.REPO_KIT_BUILD_CACHE_MAX_BYTES ?? env.STRAYLIGHT_BUILD_CACHE_MAX_BYTES ?? config?.rust?.maxBytes ?? POOL_CAP;
  const limit = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(limit) || limit < 0) throw new Error("Cargo cache size limit must not be negative");
  return Math.min(limit, POOL_CAP);
}

export function diskFreeBytes(dir) {
  const stats = fs.statfsSync(dir);
  return Number(stats.bavail) * Number(stats.bsize);
}

export function poolLimit(cache, { free, floor, env = process.env, config, diskFree = diskFreeBytes } = {}) {
  const actualFree = free ?? diskFree(cache);
  const actualFloor = floor ?? freeFloor({ env, config });
  const room = Math.min(Math.max(0, actualFree - actualFloor), GRADE);
  return Math.min(poolCap({ env, config }), Math.floor((POOL_CAP * room) / GRADE));
}

export function retirePools(root, { now = () => Date.now() / 1000, retiredPools = RETIRED_POOLS } = {}) {
  for (const name of retiredPools) {
    const pool = path.join(root, name);
    try {
      if (!fs.existsSync(pool) || fs.lstatSync(pool).isSymbolicLink() || !fs.statSync(pool).isDirectory()) continue;
      const entries = fs.readdirSync(pool);
      const mtimes = [fs.statSync(pool).mtimeMs / 1000, ...entries.map(e => fs.lstatSync(path.join(pool, e)).mtimeMs / 1000)];
      if (now() - Math.max(...mtimes) < RETIRE_AFTER) continue;
      const fds = [];
      let busy = false;
      try {
        for (const entry of entries.filter(e => e.endsWith(".lock"))) {
          const fd = fs.openSync(path.join(pool, entry), "a");
          fds.push(fd);
          if (!flock(fd, { nonblock: true })) { busy = true; break; }
        }
        if (!busy) fs.rmSync(pool, { recursive: true, force: true });
      } finally {
        for (const fd of fds) { try { fs.closeSync(fd); } catch {} }
      }
    } catch {}
  }
}

export function waitRecord(cache, name) {
  for (;;) {
    const recordPath = path.join(cache, `${name}${WAITING}${process.pid}-${crypto.randomBytes(6).toString("hex")}`);
    const fd = fs.openSync(recordPath, "wx+");
    flock(fd, { shared: true });
    try {
      if (fs.statSync(recordPath).ino === fs.fstatSync(fd).ino) {
        return {
          fd, recordPath,
          close() { try { fs.unlinkSync(recordPath); } catch {} try { fs.closeSync(fd); } catch {} },
        };
      }
    } catch {}
    fs.closeSync(fd);
  }
}

export function waitedFor(cache, name) {
  let waited = false;
  const prefix = `${name}${WAITING}`;
  for (const entry of fs.existsSync(cache) ? fs.readdirSync(cache) : []) {
    if (!entry.startsWith(prefix)) continue;
    const recordPath = path.join(cache, entry);
    try {
      const fd = fs.openSync(recordPath, "r");
      try {
        if (!flock(fd, { nonblock: true })) { waited = true; continue; }
        fs.rmSync(recordPath, { force: true });
      } finally { fs.closeSync(fd); }
    } catch {}
  }
  return waited;
}

export function seedKey(command, manifest, codegen, { env = process.env } = {}) {
  const sep = command.includes("--") ? command.indexOf("--") : command.length;
  const shape = command.slice(0, sep).filter((arg, i, arr) => arg !== "--manifest-path" && arr[i - 1] !== "--manifest-path");
  const settings = Object.entries(env)
    .filter(([k, v]) => v !== undefined && CODEGEN_ENV_RE.test(k) && !SCHEDULING_RE.test(k))
    .sort(([a], [b]) => a.localeCompare(b));
  return crypto.createHash("sha256").update(JSON.stringify([codegen, path.basename(path.dirname(manifest)), shape, settings])).digest("hex");
}

export function partitionSize(partition) {
  let total = 0;
  const walk = dir => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) walk(full);
      else { try { total += fs.lstatSync(full).size; } catch {} }
    }
  };
  walk(partition);
  return total;
}

export function forgetLocal(partition, packages, crates) {
  const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const unitsRe = new RegExp(`^(?:${[...packages].sort().map(escape).join("|")})-[0-9a-f]{16}$`);
  const outputsRe = new RegExp(`^(?:lib)?(?:${[...crates].sort().map(escape).join("|")})(?:-[0-9a-f]{16})?(?:\\..+)?$`);
  for (const marker of [SEED, OVERSIZED, INCOMPLETE]) fs.rmSync(path.join(partition, marker), { force: true });
  const profiles = [];
  for (const a of fs.existsSync(partition) ? fs.readdirSync(partition, { withFileTypes: true }) : []) {
    if (!a.isDirectory() || a.isSymbolicLink()) continue;
    const p1 = path.join(partition, a.name);
    if (fs.existsSync(path.join(p1, ".fingerprint"))) profiles.push(p1);
    for (const b of fs.readdirSync(p1, { withFileTypes: true })) {
      if (b.isDirectory() && !b.isSymbolicLink() && fs.existsSync(path.join(p1, b.name, ".fingerprint"))) profiles.push(path.join(p1, b.name));
    }
  }
  for (const profile of profiles) {
    for (const entry of fs.readdirSync(profile)) {
      if (!PROFILE_KEEP.has(entry)) fs.rmSync(path.join(profile, entry), { recursive: true, force: true });
    }
    for (const [sub, re] of [[".fingerprint", unitsRe], ["build", unitsRe], ["deps", outputsRe]]) {
      const dir = path.join(profile, sub);
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
      for (const entry of fs.readdirSync(dir)) if (re.test(entry)) fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
    }
  }
}

function seedOf(partition, cap) {
  try {
    if (fs.existsSync(path.join(partition, INCOMPLETE))) return null;
    if (fs.existsSync(path.join(partition, OVERSIZED)) && Number.parseInt(fs.readFileSync(path.join(partition, OVERSIZED), "utf8"), 10) >= Math.floor(cap / 2)) return null;
    return fs.readFileSync(path.join(partition, SEED), "utf8");
  } catch { return null; }
}

export function keptSeeds(cache, entries, owned, cap) {
  const kept = new Set(), keys = new Set();
  for (const entry of [...entries].sort((a, b) => b.mtime - a.mtime)) {
    if (keys.size === KEEP_SEED_KEYS) break;
    const seed = seedOf(entry.path, cap);
    if (!seed || keys.has(seed)) continue;
    if (entry.name !== owned) {
      if (waitedFor(cache, entry.name)) continue;
      if (!withLockFile(path.join(cache, `${entry.name}.lock`), { nonblock: true }, () => true).locked) continue;
    }
    keys.add(seed);
    kept.add(entry.name);
  }
  return kept;
}

export function prunePool(cache, owned, { keepOwned = false, env = process.env, config, diskFree = diskFreeBytes } = {}) {
  const free = diskFree(cache), floor = freeFloor({ env, config }), cap = poolCap({ env, config });
  const limit = poolLimit(cache, { free, floor, env, config, diskFree });
  for (const name of fs.existsSync(cache) ? fs.readdirSync(cache) : []) {
    if (!name.endsWith(".seeding")) continue;
    const base = name.slice(0, -".seeding".length), full = path.join(cache, name);
    if (HEX64_RE.test(base) && base !== owned && !fs.lstatSync(full).isSymbolicLink()) {
      withLockFile(path.join(cache, `${base}.lock`), { nonblock: true }, () => fs.rmSync(full, { recursive: true, force: true }));
    }
  }
  const entries = [];
  for (const name of fs.existsSync(cache) ? fs.readdirSync(cache) : []) {
    const full = path.join(cache, name);
    if (HEX64_RE.test(name) && !fs.lstatSync(full).isSymbolicLink() && fs.statSync(full).isDirectory()) {
      entries.push({ name, path: full, mtime: fs.statSync(full).mtimeMs, size: partitionSize(full) });
    }
  }
  let total = entries.reduce((sum, e) => sum + e.size, 0);
  const kept = free > floor ? keptSeeds(cache, entries, owned, cap) : new Set();
  for (const entry of [...entries].sort((a, b) => a.mtime - b.mtime)) {
    if (total <= limit) break;
    if (kept.has(entry.name) && total <= cap) continue;
    if (entry.name !== owned) {
      const removed = withLockFile(path.join(cache, `${entry.name}.lock`), { nonblock: true }, () => {
        if (waitedFor(cache, entry.name)) return false;
        fs.rmSync(entry.path, { recursive: true, force: true });
        return true;
      });
      if (!removed.locked || !removed.value) continue;
    } else if (keepOwned) continue;
    else fs.rmSync(entry.path, { recursive: true, force: true });
    total -= entry.size;
  }
}
