// Shared machinery for verifying an exact commit in a clean temporary worktree,
// used by both `pre-push` and `release-gate`. Policy (what to skip, attestation,
// Chromium) stays in the callers.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CONFIG_FILE, loadConfig } from "./config.mjs";
import { cleanEnvironment, git } from "./git.mjs";

export const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

export function signalExitCode(signal) {
  return 128 + (os.constants.signals[signal] ?? 0);
}

/**
 * Captures SIGINT/SIGTERM/SIGHUP, forwards SIGTERM/SIGHUP (and optionally
 * SIGINT) to the currently tracked child process, and removes its listeners
 * on `dispose()`.
 */
export function trapSignals({ target = process, forwardInterrupt = false } = {}) {
  let stopped;
  let current;
  const forward = signal => {
    stopped = signal;
    current?.kill(signal);
  };
  const onInterrupt = () => {
    stopped = "SIGINT";
    if (forwardInterrupt) current?.kill("SIGINT");
  };
  target.on("SIGTERM", forward);
  target.on("SIGHUP", forward);
  target.on("SIGINT", onInterrupt);
  return {
    get stopped() { return stopped; },
    exitCode: () => (stopped ? signalExitCode(stopped) : 0),
    track: child => { current = child; },
    dispose: () => {
      current = undefined;
      target.off("SIGTERM", forward);
      target.off("SIGHUP", forward);
      target.off("SIGINT", onInterrupt);
    },
  };
}

function readPackageScripts(worktree) {
  const manifest = path.join(worktree, "package.json");
  return fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, "utf8")).scripts ?? {} : {};
}

function verifyFromScripts(worktree, scripts, release) {
  if (scripts.verify) return ["bun", ["run", "verify", ...(release ? ["--", "--release"] : [])]];
  if (fs.existsSync(path.join(worktree, "scripts/verify.mjs"))) return ["node", ["scripts/verify.mjs", ...(release ? ["--release"] : [])]];
  return undefined;
}

/** The command that verifies a checked-out commit, or undefined when it predates any gate. */
export function verifyCommand(worktree, release = false) {
  return verifyFromScripts(worktree, readPackageScripts(worktree), release);
}

/**
 * The commands that verify a checked-out commit: `{ release, browser }` as
 * `[file, args]`, `browser` undefined when it declares no browser checks.
 * A commit from before the repository took its gate from repo-kit has no
 * repo-kit.config.mjs; its own verify and verify:browser scripts run.
 */
export async function verifyCommands(worktree) {
  const scripts = readPackageScripts(worktree);
  const configBrowser = fs.existsSync(path.join(worktree, CONFIG_FILE)) && Boolean((await loadConfig(worktree)).verify?.browser);
  const browser = scripts["verify:browser"]
    ? ["bun", ["run", "verify:browser"]]
    : configBrowser
      ? ["bun", ["run", "verify", "--", "--browser"]]
      : undefined;
  return { release: verifyFromScripts(worktree, scripts, true), browser };
}

/**
 * Checks out `sha` in a detached temporary worktree, invokes `run(worktree)`,
 * and always removes the worktree and directory afterward. Works with both
 * synchronous and async `run` callbacks.
 */
export function withCommitWorktree(root, sha, run, { prefix = "repo-kit-check-", env = cleanEnvironment() } = {}) {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const cleanup = () => {
    spawnSync("git", ["worktree", "remove", "--force", worktree], { cwd: root, env, stdio: "ignore" });
    fs.rmSync(worktree, { recursive: true, force: true });
  };
  let result;
  try {
    git(root, "worktree", "add", "--detach", worktree, sha, { env });
    result = run(worktree);
  } catch (error) {
    cleanup();
    throw error;
  }
  if (result && typeof result.then === "function") return result.finally(cleanup);
  cleanup();
  return result;
}

/**
 * A line-oriented passed-commit record under `dir/name` (plus optional `legacy`
 * filenames read for backwards compatibility). `parse` maps a line to
 * `[key, value]`; `format` turns `(key, value)` back into a line.
 */
export function passedRecord(dir, name, { legacy = [], parse = line => [line, true], format = key => String(key) } = {}) {
  const file = path.join(dir, name);
  const read = () => {
    const entries = new Map();
    for (const candidate of [...legacy, name]) {
      const full = path.join(dir, candidate);
      if (!fs.existsSync(full)) continue;
      for (const line of fs.readFileSync(full, "utf8").split("\n")) {
        if (!line) continue;
        const [key, value] = parse(line);
        entries.set(key, value);
      }
    }
    return entries;
  };
  return {
    file,
    read,
    keys: () => new Set(read().keys()),
    has: key => read().has(key),
    get: key => read().get(key),
    add: (key, value) => {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(file, `${format(key, value)}\n`);
    },
  };
}
