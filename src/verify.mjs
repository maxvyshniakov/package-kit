// The repository's gate: the one command that decides whether a commit may be
// pushed. CI's check job and the pre-push hook run exactly this, so project
// skills and instructions can name the command instead of listing steps.
//
//   package-kit verify                 the steps of package-kit.config.mjs verify.steps
//   package-kit verify --release       the same with release: true (main: no unreleased entries)
//   package-kit verify --browser       verify.browser, the slower browser checks
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { applyScopeArgs, changedPaths, formatPlan, planChecks } from "./plan.mjs";
import {
  readCapacity,
  runSlots,
  yieldEnabled,
  yieldRequested as defaultYieldRequested,
  yieldSlots as defaultYieldSlots,
} from "./slotfather.mjs";
import { hostPlatform } from "./verified-tree.mjs";
import { WORKER_MEMORY_GIB, unitTestWorkers, verifyCores, verifyMemory } from "./verify/budget.mjs";
import { cgroupMemory, markedProcesses, sampleMemory, startReaper, stepProcesses } from "./verify/processes.mjs";
import { printSummary, startProcess } from "./verify/run.mjs";
import {
  chain,
  cheapTier,
  normalizeSteps,
  reusableSteps,
  runSteps,
  sizeSteps,
  splitCheapFirst,
  stepCacheKey,
  stepCacheKeys,
  verifySteps,
} from "./verify/steps.mjs";

export {
  WORKER_MEMORY_GIB,
  cgroupMemory,
  chain,
  cheapTier,
  markedProcesses,
  normalizeSteps,
  printSummary,
  readCapacity,
  reusableSteps,
  runSlots,
  runSteps,
  sizeSteps,
  splitCheapFirst,
  startProcess,
  startReaper,
  stepCacheKey,
  stepCacheKeys,
  stepProcesses,
  unitTestWorkers,
  verifyCores,
  verifyMemory,
  verifySteps,
};

const RUN_MARK = `${process.pid}-${Date.now().toString(36)}`;
const REPEAT_SIGNAL_MS = 1000;

/**
 * HEAD's tree SHA and git common dir when `root` is a clean committed Git
 * checkout (no modified, staged or untracked files); null otherwise.
 */
export function cleanCheckoutTree(root, { env = process.env } = {}) {
  const git = (...argv) => {
    try {
      return execFileSync("git", argv, { cwd: root, encoding: "utf8", env, stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return null;
    }
  };
  const top = git("rev-parse", "--show-toplevel");
  if (!top) return null;
  try {
    if (fs.realpathSync(top) !== fs.realpathSync(root)) return null;
  } catch {
    return null;
  }
  if (git("--no-optional-locks", "status", "--porcelain", "--untracked-files=normal") !== "") return null;
  const tree = git("rev-parse", "--verify", "-q", "HEAD^{tree}");
  const common = git("rev-parse", "--git-common-dir");
  if (!tree || !common) return null;
  return { tree, gitCommonDir: path.resolve(root, common) };
}

/** Environment variables that override local sources and must bypass verified-tree reuse. */
export const REUSE_BYPASS_ENV_VARS = [
  "SID_KIT_SOURCE",
  "PACKAGE_KIT_SOURCE",
  "INLINE_MEASURE_SOURCE",
  "TEXT_TRUNCATE_SOURCE",
];

/** Whether `env` sets a local-source override that makes verified-tree reuse unsafe. */
export function hasReuseBypassEnv(env = process.env) {
  return REUSE_BYPASS_ENV_VARS.some(name => Boolean(env[name]));
}

/** Reads passed step cache keys for `(tree, platform)` from lock-free per-key markers in `cacheDir`. */
export function readTreeCache(cacheDir, tree, platform = hostPlatform()) {
  if (!cacheDir || !tree) return new Set();
  const dir = path.join(cacheDir, tree, platform);
  try {
    return new Set(fs.readdirSync(dir).filter(name => !name.startsWith(".")));
  } catch {
    return new Set();
  }
}

/** Atomically records newly passed step cache keys for `(tree, platform)` via lock-free marker files. */
export function writeTreeCache(cacheDir, tree, platform = hostPlatform(), keys = []) {
  if (!cacheDir || !tree || !keys.length) return;
  const dir = path.join(cacheDir, tree, platform);
  fs.mkdirSync(dir, { recursive: true });
  for (const key of keys) {
    if (!key || typeof key !== "string") continue;
    const target = path.join(dir, key);
    try {
      fs.writeFileSync(target, "", { flag: "wx" });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
}

/** Runs the gate in `root`; sets process.exitCode rather than exiting, so piped output drains. */
export async function runVerify(config, {
  release = false, browser = false, changed = false, base = "HEAD", plan = false, json = false,
  reuse = true, reuseDir, steps: declaredSteps, onLine, maxCores = Infinity, env = process.env, keepGoing = false,
} = {}) {
  let planned = null;
  let baseSteps = declaredSteps;
  if (!baseSteps) {
    const allSteps = verifySteps(config, { release, browser });
    if (changed) {
      const suite = browser ? "browser" : "verify";
      const allChecks = [
        ...(config.verify.steps
          ? (browser ? verifySteps(config, { release, browser: false }) : allSteps)
            .map(step => ({ id: `verify:${step.name}`, suite: "verify", step }))
          : []),
        ...(config.verify.browser
          ? (browser ? allSteps : verifySteps(config, { release, browser: true }))
            .map(step => ({ id: `browser:${step.name}`, suite: "browser", step }))
          : []),
      ];
      const paths = changedPaths(config.root, base, { env });
      const repoPlan = planChecks({
        checks: allChecks,
        paths,
        inert: config.verify.inert,
        runner: config.verify.runner,
        canary: config.verify.canary,
      });
      const suiteRows = repoPlan.checks
        .filter(row => row.suite === suite)
        .map(row => ({ ...row, id: row.id.slice(suite.length + 1) }));
      const suiteSuites = repoPlan.suites.filter(name => name === suite);
      const suiteReasons = suiteSuites.length && repoPlan.reasons[suite] ? { [suite]: repoPlan.reasons[suite] } : {};
      planned = { ...repoPlan, suites: suiteSuites, reasons: suiteReasons, checks: suiteRows };
      if (plan) {
        console.log(json ? JSON.stringify(planned, null, 2) : formatPlan(planned));
        process.exitCode = 0;
        return { exit: 0, plan: planned, results: [], interrupted: null };
      }
      if (!planned.checks.length) {
        console.log(formatPlan(planned));
        process.exitCode = 0;
        return { exit: 0, plan: planned, results: [], interrupted: null };
      }
      const selectedIds = new Set(planned.checks.map(row => row.id));
      const matchedByName = new Map(planned.checks.map(row => [row.id, row.paths]));
      baseSteps = applyScopeArgs(
        allSteps.filter(step => selectedIds.has(step.name)),
        { paths: planned.paths, matchedByName, full: planned.full, release },
      );
    } else {
      baseSteps = applyScopeArgs(allSteps, { paths: [], matchedByName: new Map(), full: true, release });
    }
  }
  const cores = Math.min(verifyCores(env), maxCores);
  const memory = verifyMemory(env);
  const { workerMemory } = config.verify;
  const workers = unitTestWorkers(cores, memory, workerMemory);
  const steps = sizeSteps(baseSteps, { workers, workerMemory });
  const reuseEnabled = reuse && env.PACKAGE_KIT_NO_REUSE !== "1" && !hasReuseBypassEnv(env);
  const checkout = reuseEnabled ? cleanCheckoutTree(config.root, { env }) : null;
  const cacheDir = checkout ? (reuseDir ?? path.join(checkout.gitCommonDir, "package-kit-verified-tree")) : null;
  const platform = hostPlatform();
  const cachedKeys = checkout ? readTreeCache(cacheDir, checkout.tree, platform) : new Set();
  const reused = checkout ? reusableSteps(steps, cachedKeys, { release }) : new Set();
  const running = new Set();
  // A signal stops every running step's process group and waits for them; a
  // second one kills them. One Ctrl-C under `bun run verify` arrives twice, from
  // the terminal's process group and from bun forwarding it, so a repeat within
  // REPEAT_SIGNAL_MS of the first is the same keypress.
  const interrupt = new AbortController();
  let interrupted = 0;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      if (!interrupt.signal.aborted) {
        console.log(`\nverify: ${signal}, stopping the running steps`);
        interrupted = Date.now();
        interrupt.abort(signal);
        return;
      }
      if (Date.now() - interrupted < REPEAT_SIGNAL_MS) return;
      for (const handle of running) handle.stop("SIGKILL");
      process.exit(128 + os.constants.signals[signal]);
    });
  }
  const memoryText = Number.isFinite(memory) ? `, ${memory.toFixed(1)} GiB` : "";
  console.log(`verify: ${cores} cores${memoryText}${steps.some(step => step.usesCores) ? `, ${workers} workers for the steps that use them` : ""}`);
  const started = Date.now();
  const tails = new Map();
  const handles = new Map();
  const groups = new Map();
  const marks = new Map(steps.map((step, index) => [`${RUN_MARK}.${index}`, step.name]));
  const memorySamples = sampleMemory(groups, marks);
  const reaper = startReaper();
  const yieldOpts = yieldEnabled(env)
    ? {
        yieldRequested: () => defaultYieldRequested(env),
        yieldSlots: async ({ signal } = {}) => {
          console.log("verify: a waiter asked for this run's slots; yielding lease between checks");
          await defaultYieldSlots({ env, signal });
          console.log("verify: lease slots regained; resuming");
        },
      }
    : {};
  const results = await runSteps(steps, step => {
    console.log(`  start ${step.name} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    const handle = startProcess(step, { root: config.root, running, mark: `${RUN_MARK}.${steps.indexOf(step)}`, processes: () => memorySamples.processes(step.name), onLine, environment: env });
    tails.set(step.name, handle.tail);
    handles.set(step.name, handle);
    if (handle.pid) {
      groups.set(handle.pid, step.name);
      reaper.add(handle.pid);
      handle.done.then(() => {
        groups.delete(handle.pid);
        reaper.remove(handle.pid);
      });
    }
    return handle;
  }, { signal: interrupt.signal, memory, slots: runSlots(env), keepGoing, reused, ...yieldOpts });
  const peak = memorySamples.stop();
  reaper.done();
  if (checkout) {
    const after = cleanCheckoutTree(config.root, { env });
    if (after && after.tree === checkout.tree) {
      const keys = stepCacheKeys(steps, { release });
      const passedKeys = results
        .filter(row => row.status === "ok" && !row.reused)
        .map(row => keys.get(row.name));
      writeTreeCache(cacheDir, checkout.tree, platform, passedKeys);
    }
  }
  const failed = printSummary({ steps, results, tails, handles, peak, started });
  // Not process.exit: stdout to a pipe (CI, the pre-push hook) is written
  // asynchronously, and exiting at once would cut off the steps' output.
  process.exitCode = interrupt.signal.aborted ? 128 + os.constants.signals[interrupt.signal.reason] : failed ? 1 : 0;
  return { exit: process.exitCode, results, interrupted: interrupt.signal.reason ?? null, ...(planned ? { plan: planned } : {}) };
}
