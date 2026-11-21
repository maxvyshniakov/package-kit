// Shared Git helpers: hook-safe environment cleaning, command execution, and
// common-dir resolution.
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";

const HOOK_VARS = /^GIT_(DIR|WORK_TREE|INDEX_FILE|PREFIX|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|QUARANTINE_PATH)$/;

/**
 * Strips Git hook environment variables (GIT_DIR and friends) so commands run
 * in another checkout or temporary worktree resolve their own repository.
 */
export function cleanEnvironment(env = process.env) {
  const clean = { ...env };
  for (const name of Object.keys(clean)) {
    if (HOOK_VARS.test(name)) delete clean[name];
  }
  return clean;
}

/**
 * Runs a Git command in `root` and returns trimmed stdout (or raw stdout when
 * `trim: false`). An optional trailing plain object passes `{ env, stdio, trim }`.
 */
export function git(root, ...args) {
  const opts = args.length && typeof args.at(-1) === "object" && args.at(-1) !== null ? args.pop() : {};
  const { env, stdio = ["ignore", "pipe", "pipe"], trim = true } = opts;
  const out = execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    ...(env ? { env } : {}),
    stdio,
  });
  return trim ? out.trim() : out;
}

/** Returns a `(...args) => string` helper bound to `root` and default options. */
export function gitRunner(root, opts = {}) {
  return (...args) => git(root, ...args, opts);
}

/**
 * Runs a Git command via spawnSync and returns the full result object (for
 * callers that need stdin, NUL-delimited output, or non-throwing failure checks).
 */
export function gitResult(root, args, { env, input, allowFailure = false, maxBuffer = 256 * 1024 * 1024 } = {}) {
  const result = spawnSync("git", args, {
    cwd: root,
    ...(env ? { env } : {}),
    input,
    encoding: "utf8",
    maxBuffer,
  });
  if (result.status !== 0 && !allowFailure) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result;
}

/** Resolves the repository's shared common Git directory (`.git`). */
export function commonGitDir(root = process.cwd(), env = cleanEnvironment()) {
  return path.resolve(root, git(root, "rev-parse", "--git-common-dir", { env }));
}
