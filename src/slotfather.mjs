// Machine-wide slot leases and capacity via slotfather. With slotfather on PATH
// a command runs under `slotfather run -n <slots>`; without it, as on CI
// runners, it runs directly. A command already under a lease (SLOTFATHER_LEASE
// set by an outer slotfather run) runs without a second one, so nested commands
// lease once. PACKAGE_KIT_SLOT_WAIT=<seconds> (or the older SID_KIT_SLOT_WAIT)
// gives up waiting for the lease after that long: slotfather exits 75, so a CI
// job fails with that reason instead of being cancelled at its time limit while
// queued.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function hasSlotfather(env = process.env) {
  return spawnSync("sh", ["-c", "command -v slotfather"], { env, stdio: "ignore" }).status === 0;
}

/** Whether `env` already holds an outer slotfather lease. */
export function hasLease(env = process.env) {
  return Boolean(env.SLOTFATHER_LEASE);
}

/** Number of slots held by the active slotfather lease in `env`, or 0 without one. */
export function leasedSlots(env = process.env) {
  const count = Number.parseInt(env.SLOTFATHER_COUNT ?? "", 10);
  return env.SLOTFATHER_LEASE && count > 0 ? count : 0;
}

/**
 * The slots of the run's lease, which steps that take slots share. Without a
 * lease (a CI runner without slotfather) one: such steps run one at a time.
 */
export function runSlots(env = process.env) {
  return leasedSlots(env) || 1;
}

let capacityCache;
/** slotfather's capacity (`slotfather advise`: total slots, gib_per_slot), or {} without slotfather. */
export function capacity() {
  if (!capacityCache) {
    try {
      capacityCache = JSON.parse(execFileSync("slotfather", ["advise"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
    } catch {
      capacityCache = {};
    }
  }
  return capacityCache;
}

export const readCapacity = capacity;

/**
 * The slots `verify` leases: PACKAGE_KIT_VERIFY_SLOTS when set (CI's reusable
 * workflows set it, `all` by default, so a job holds the whole runner),
 * otherwise the repository's configured count.
 */
export function verifyLeaseSlots(configured, env = process.env) {
  return env.PACKAGE_KIT_VERIFY_SLOTS || configured;
}

// slotfather's exit status when --wait ran out before a lease was granted.
export const WAIT_EXPIRED = 75;

/** Seconds to wait for a lease before giving up, or 0: wait as long as it takes. */
export function slotWait(env = process.env) {
  const seconds = Number.parseInt(env.PACKAGE_KIT_SLOT_WAIT ?? env.SID_KIT_SLOT_WAIT ?? "", 10);
  return seconds > 0 ? seconds : 0;
}

/**
 * The project a lease runs for: the main checkout's directory (the same in
 * every worktree, unlike the worktree's own name), else package.json's
 * unscoped name, else the directory.
 */
export function projectName(cwd = process.cwd()) {
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (path.basename(common) === ".git") return path.basename(path.dirname(common));
  } catch { /* not a repository */ }
  try {
    const { name } = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
    if (name) return name.replace(/^@[^/]+\//, "");
  } catch { /* no package.json */ }
  return path.basename(cwd);
}

/** What a lease is for when the caller does not say: the package script that runs it, or the command's first words. */
export function commandPurpose(command, env = process.env) {
  if (env.npm_lifecycle_event) return env.npm_lifecycle_event;
  const words = command.filter(word => !word.startsWith("-")).slice(0, 3).map(word => path.basename(word));
  return words.join(" ") || "command";
}

/**
 * The lease's label: who and what, never a bare directory name. A label from
 * PACKAGE_KIT_SLOT_LABEL (a lane's, say) gets the purpose appended unless it has
 * one already (a space).
 */
export function slotLabel(purpose, { env = process.env, cwd = process.cwd() } = {}) {
  const given = env.PACKAGE_KIT_SLOT_LABEL;
  if (given) return given.includes(" ") || !purpose ? given : `${given} ${purpose}`;
  return `${projectName(cwd)} ${purpose}`;
}

/** The argv that runs `command` under a lease, or `command` itself when no lease applies. */
export function leasedCommand(slots, command, { env = process.env, cwd = process.cwd(), slotfather = hasSlotfather(env), purpose } = {}) {
  if (env.SLOTFATHER_LEASE || !slotfather) return command;
  const wait = slotWait(env);
  const context = [];
  if (env.PACKAGE_KIT_SLOT_PRIORITY) {
    if (!["interactive", "normal", "batch"].includes(env.PACKAGE_KIT_SLOT_PRIORITY)) throw new Error("invalid execution priority");
    context.push("--priority", env.PACKAGE_KIT_SLOT_PRIORITY);
  }
  if (env.PACKAGE_KIT_SLOT_TICKET) context.push("--ticket", env.PACKAGE_KIT_SLOT_TICKET);
  if (env.PACKAGE_KIT_SLOT_META) {
    let metadata;
    try { metadata = JSON.parse(env.PACKAGE_KIT_SLOT_META); }
    catch { throw new Error("invalid execution metadata JSON"); }
    if (!metadata || Array.isArray(metadata) || typeof metadata !== "object") throw new Error("execution metadata must be an object");
    for (const [key, value] of Object.entries(metadata)) {
      if (["priority", "ticket"].includes(key) || typeof value !== "string") throw new Error("invalid execution metadata fields");
      context.push("--meta", `${key}=${value}`);
    }
  }
  if (env.PACKAGE_KIT_SLOT_YIELDABLE === "1") context.push("--yieldable");
  const label = env.PACKAGE_KIT_SLOT_LABEL && !purpose ? env.PACKAGE_KIT_SLOT_LABEL : slotLabel(purpose ?? commandPurpose(command, env), { env, cwd });
  return ["slotfather", "run", "-n", String(slots), "--label", label,
    ...context, ...(wait ? ["--wait", String(wait)] : []), "--", ...command];
}

/**
 * Runs `command` (argv) under a lease; resolves to its exit code. `input`, when
 * given, is written to its stdin. SIGTERM and SIGHUP are forwarded. SIGINT is
 * not: Ctrl-C reaches the child from the terminal's process group already, and
 * forwarding it too would deliver it twice. The listeners keep this process
 * alive until the child has handled the signal, and are in place before the
 * child starts: the child writes to the same stdout, so whoever reads it can
 * signal this process before spawn's caller runs another line.
 */
export function runLeased(slots, command, { env = process.env, cwd = process.cwd(), input, purpose, spawn: start = spawn } = {}) {
  const argv = leasedCommand(slots, command, { env, cwd, purpose });
  const [file, ...args] = argv;
  const leased = argv !== command;
  // A signal is caught from here on and handled on the event loop, by when
  // `child` is set.
  let child;
  const forward = signal => child.kill(signal);
  const ignore = () => {};
  process.on("SIGTERM", forward);
  process.on("SIGHUP", forward);
  process.on("SIGINT", ignore);
  const release = () => {
    process.off("SIGTERM", forward);
    process.off("SIGHUP", forward);
    process.off("SIGINT", ignore);
  };
  child = start(file, args, { cwd, env, stdio: [input === undefined ? "inherit" : "pipe", "inherit", "inherit"] });
  if (input !== undefined) child.stdin.end(input);
  return new Promise(resolve => {
    child.on("error", error => {
      release();
      console.error(`${file}: ${error.message}`);
      resolve(127);
    });
    child.on("close", (code, signal) => {
      release();
      if (leased && code === WAIT_EXPIRED && slotWait(env)) {
        console.error(`package-kit: gave up waiting for ${slots} slot(s) after ${slotWait(env)}s (slotfather status shows the queue)`);
      }
      resolve(code ?? 128 + os.constants.signals[signal]);
    });
  });
}

/**
 * Re-runs this process under a lease unless it already holds one or there is
 * no slotfather; resolves to whether it did (process.exitCode then holds the
 * leased run's code).
 */
export async function leaseSelf(slots, { env = process.env, input, purpose = process.argv.slice(2, 4).map(arg => arg.replace(/^-+/, "")).join(" ") || "package-kit" } = {}) {
  if (env.SLOTFATHER_LEASE || !hasSlotfather(env)) return false;
  process.exitCode = await runLeased(slots, [process.execPath, ...process.argv.slice(1)], { env, input, purpose });
  return true;
}

/** Whether `env` is running under a yieldable slotfather lease. */
export function yieldEnabled(env = process.env) {
  return Boolean(env.SLOTFATHER_YIELD);
}

/**
 * Whether a waiter asked this process's yieldable lease to give its slots back
 * (slotfather's client protocol: SLOTFATHER_YIELD names a request file).
 */
export function yieldRequested(env = process.env) {
  return Boolean(env.SLOTFATHER_YIELD) && fs.existsSync(env.SLOTFATHER_YIELD);
}

/**
 * Environment copy without SLOTFATHER_YIELD: only the runner that took the
 * lease yields between steps, never the child commands it spawns.
 */
export function withoutYield(env = process.env) {
  if (!("SLOTFATHER_YIELD" in env)) return env;
  const copy = { ...env };
  delete copy.SLOTFATHER_YIELD;
  return copy;
}

/**
 * Runs `slotfather yield` between steps so a higher-priority waiter can run,
 * resolving once the lease holds its slots again. Rejects with an Error with
 * `code = "LEASE_LOST"` when yielding fails (the lease is gone, so stop).
 * If `signal` aborts while waiting, kills `slotfather yield`.
 */
export function yieldSlots({ env = process.env, signal, spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const error = new Error(`slotfather yield aborted (${signal.reason ?? "aborted"})`);
      error.code = "LEASE_LOST";
      reject(error);
      return;
    }
    const child = spawnImpl("slotfather", ["yield"], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding?.("utf8");
    child.stderr?.setEncoding?.("utf8");
    child.stdout?.on?.("data", chunk => { stdout += chunk; });
    child.stderr?.on?.("data", chunk => { stderr += chunk; });
    const onAbort = () => {
      try {
        child.kill(typeof signal.reason === "string" && signal.reason.startsWith("SIG") ? signal.reason : "SIGTERM");
      } catch {
        // already exited
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    let settled = false;
    const finish = err => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (err) reject(err);
      else resolve();
    };
    child.on("error", err => {
      const error = new Error(`slotfather yield failed (${err.message})`);
      error.code = "LEASE_LOST";
      finish(error);
    });
    child.on("close", (code, termSignal) => {
      if (code === 0 && !signal?.aborted) {
        finish();
        return;
      }
      const detail = termSignal
        ? `signal ${termSignal}`
        : `exit ${code}: ${(stderr || stdout || "").trim().slice(0, 300)}`;
      const error = new Error(`slotfather yield failed (${detail})`);
      error.code = "LEASE_LOST";
      finish(error);
    });
  });
}
