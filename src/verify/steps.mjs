// Step declaration, sizing, cheap-tier splitting, step cache keys and scheduling (`runSteps`).
import crypto from "node:crypto";

import { STEP_KEYS, unknownKeyMessage } from "../config.mjs";
import { createMatcher } from "../plan.mjs";
import { USES_CORES_BASE_GIB, WORKER_MEMORY_GIB, unitTestWorkers } from "./budget.mjs";

export { WORKER_MEMORY_GIB, unitTestWorkers };

/**
 * Each step: { name, command (bun arguments), needs (names of steps that must
 * pass first), memory? (GiB it holds at its peak; 0 when left out), usesCores?
 * (test workers from the run's cores and memory; `memory` is then what it holds
 * besides them), workers? (a fixed worker count), timeout? (minutes it may run;
 * `stepTimeout` when left out, 0 for no limit), slots? (the run's slots it
 * holds while it runs: steps that take slots run side by side only as far as
 * the run's lease goes; it sees its share as PACKAGE_KIT_STEP_SLOTS) }. `needs`
 * defaults to [].
 */
export function normalizeSteps(steps, { stepTimeout = 0 } = {}) {
  const seen = new Set();
  return steps.map(step => {
    if (!step?.name || !Array.isArray(step.command)) throw new Error(`verify step needs a name and a command array: ${JSON.stringify(step)}`);
    if (seen.has(step.name)) throw new Error(`duplicate verify step "${step.name}"`);
    const unknown = Object.keys(step).filter(key => !STEP_KEYS.includes(key));
    if (unknown.length) throw new Error(`verify step "${step.name}": ${unknown.map(key => unknownKeyMessage(key, STEP_KEYS)).join("; ")}`);
    if (step.memory !== undefined && !(step.memory >= 0)) throw new Error(`verify step "${step.name}": memory is GiB, a number of 0 or more`);
    if (step.workers !== undefined && !(Number.isInteger(step.workers) && step.workers > 0)) throw new Error(`verify step "${step.name}": workers is a positive integer`);
    if (step.workers && step.usesCores) throw new Error(`verify step "${step.name}": usesCores and workers exclude each other`);
    if (step.slots !== undefined && !(Number.isInteger(step.slots) && step.slots > 0)) throw new Error(`verify step "${step.name}": slots is a positive integer`);
    if (step.timeout !== undefined && !(step.timeout >= 0)) throw new Error(`verify step "${step.name}": timeout is minutes, a number of 0 (no limit) or more`);
    if (step.inputs !== undefined) {
      if (!Array.isArray(step.inputs)) throw new Error(`verify step "${step.name}": inputs must be an array of glob strings`);
      createMatcher(step.inputs, `verify step "${step.name}" inputs`);
    }
    if (step.always !== undefined && typeof step.always !== "boolean") throw new Error(`verify step "${step.name}": always must be a boolean`);
    if (step.cheap !== undefined && typeof step.cheap !== "boolean") throw new Error(`verify step "${step.name}": cheap must be a boolean`);
    if (step.smoke !== undefined && typeof step.smoke !== "boolean") throw new Error(`verify step "${step.name}": smoke must be a boolean`);
    if (step.scopeArgs !== undefined && typeof step.scopeArgs !== "function") throw new Error(`verify step "${step.name}": scopeArgs must be a function`);
    const needs = step.needs ?? [];
    for (const need of needs) {
      if (!seen.has(need)) throw new Error(`verify step "${step.name}" needs "${need}", which is not an earlier step`);
    }
    seen.add(step.name);
    return { ...step, needs, timeout: step.timeout ?? stepTimeout };
  });
}

/** Names of the cheap tier: every step with `cheap: true` and its transitive `needs` / `after`. */
export function cheapTier(steps) {
  const byName = new Map(steps.map(step => [step.name, step]));
  const keep = new Set();
  const stack = steps.filter(step => step.cheap).map(step => step.name);
  while (stack.length) {
    const name = stack.pop();
    if (keep.has(name) || !byName.has(name)) continue;
    keep.add(name);
    const step = byName.get(name);
    for (const need of [...(step.needs ?? []), ...(step.after ?? [])]) stack.push(need);
  }
  return keep;
}

/** Splits `steps` into `[first, rest]`: the cheap tier first, then the rest, each in plan order. */
export function splitCheapFirst(steps) {
  const tier = cheapTier(steps);
  if (!tier.size) return [[], [...steps]];
  const first = steps.filter(step => tier.has(step.name));
  const rest = steps.filter(step => !tier.has(step.name));
  return [first, rest];
}

/** Deterministic cache key for a step's name, command, release mode, runtime, and transitive `needs`. */
export function stepCacheKey(step, { release = false, runtime = process.version, needKeys = [] } = {}) {
  return crypto.createHash("sha256")
    .update(JSON.stringify({
      name: step.name,
      command: step.command,
      release: Boolean(release),
      runtime,
      ...(needKeys.length ? { needs: needKeys } : {}),
    }))
    .digest("hex");
}

/** Computes deterministic cache keys for all `steps`, including transitive `needs` keys. */
export function stepCacheKeys(steps, { release = false, runtime = process.version } = {}) {
  const byName = new Map(steps.map(step => [step.name, step]));
  const keys = new Map();
  const visiting = new Set();
  const compute = name => {
    if (keys.has(name)) return keys.get(name);
    const step = byName.get(name);
    if (!step || visiting.has(name)) return null;
    visiting.add(name);
    const needKeys = (step.needs ?? []).map(need => compute(need) ?? `missing:${need}`).sort();
    const key = stepCacheKey(step, { release, runtime, needKeys });
    visiting.delete(name);
    keys.set(name, key);
    return key;
  };
  for (const step of steps) compute(step.name);
  return keys;
}

/** Step names that can safely be reused from `cachedKeys` without invalidating uncached dependents. */
export function reusableSteps(steps, cachedKeys, { release = false, runtime = process.version } = {}) {
  if (!cachedKeys?.size) return new Set();
  const keys = stepCacheKeys(steps, { release, runtime });
  const upstreamCached = new Set();
  for (const step of steps) {
    if (cachedKeys.has(keys.get(step.name)) && (step.needs ?? []).every(need => upstreamCached.has(need))) {
      upstreamCached.add(step.name);
    }
  }
  const dependents = new Map(steps.map(step => [step.name, []]));
  for (const step of steps) {
    for (const need of step.needs ?? []) if (dependents.has(need)) dependents.get(need).push(step.name);
  }
  const reusable = new Set();
  for (let index = steps.length - 1; index >= 0; index--) {
    const step = steps[index];
    if (upstreamCached.has(step.name) && dependents.get(step.name).every(dep => reusable.has(dep))) {
      reusable.add(step.name);
    }
  }
  return reusable;
}

/**
 * Steps that run one after another: [[name, command, options?], ...]. An entry
 * that is a list of such steps is a group: its steps run side by side after the
 * entry before it, and the entry after it waits for all of them.
 */
export function chain(entries) {
  const steps = [];
  let previous = [];
  for (const entry of entries) {
    const group = Array.isArray(entry[0]) ? entry : [entry];
    if (!entry.length) throw new Error("chain: an empty group");
    for (const [name, command, options = {}] of group) {
      if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error(`chain: the options of "${name}" are an object, such as { slots: 1 }`);
      steps.push({ ...options, name, command, needs: [...previous] });
    }
    previous = group.map(([name]) => name);
  }
  return steps;
}

export function verifySteps(config, { release = false, browser = false } = {}) {
  const declared = browser ? config.verify.browser : config.verify.steps;
  if (!declared) throw new Error(`package-kit.config.mjs declares no verify.${browser ? "browser" : "steps"}`);
  return normalizeSteps(typeof declared === "function" ? declared({ release }) : declared, { stepTimeout: config.verify.stepTimeout });
}

/** Each step's worker count and the memory it is planned with: a usesCores step's follows its workers. */
export function sizeSteps(steps, { workers, workerMemory = WORKER_MEMORY_GIB }) {
  return steps.map(step => {
    if (step.usesCores) return { ...step, workers, memory: workers * workerMemory + (step.memory ?? USES_CORES_BASE_GIB) };
    return { ...step, memory: step.memory ?? 0 };
  });
}

async function runStepGroup(steps, start, {
  now = Date.now, signal, memory = Infinity, slots = Infinity, keepGoing = false,
  reused = new Set(), yieldRequested, yieldSlots, initialResults = [],
} = {}) {
  const results = new Map(initialResults.map(row => [row.name, row]));
  const groupNames = new Set(steps.map(step => step.name));
  const running = new Map();
  let held = 0;
  let heldSlots = 0;
  let halted = false;
  let yielding = false;
  const halt = reason => {
    halted = true;
    for (const handle of running.values()) handle.stop(reason);
  };
  await new Promise(resolve => {
    const ready = step => step.needs.every(need => results.get(need)?.status === "ok")
      && (step.after ?? []).every(id => results.get(id)?.status === "ok");
    const launch = () => {
      if (yielding) return;
      let reusedAny;
      do {
        reusedAny = false;
        for (const step of halted ? [] : steps) {
          if (results.has(step.name) || running.has(step.name) || !ready(step)) continue;
          if (reused?.has(step.name)) {
            results.set(step.name, { name: step.name, status: "ok", seconds: 0, reused: true });
            reusedAny = true;
          }
        }
      } while (reusedAny);

      const hasRunnable = !halted && steps.some(step => !results.has(step.name) && !running.has(step.name) && ready(step));
      if (hasRunnable && yieldRequested?.()) {
        if (running.size) return;
        yielding = true;
        Promise.resolve().then(() => yieldSlots?.({ signal })).then(() => {
          yielding = false;
          launch();
        }, error => {
          yielding = false;
          halted = true;
          if (error?.message) console.error(`verify: ${error.message}`);
          if (!running.size) resolve();
        });
        return;
      }

      // Once a slot-taking step waits, later ones wait behind it: a big step is not starved by small ones.
      let slotWaiting = false;
      for (const step of halted ? [] : steps) {
        if (results.has(step.name) || running.has(step.name) || !ready(step)) continue;
        const needed = step.memory ?? 0;
        if (running.size && held + needed > memory) continue;
        const taken = Math.min(step.slots ?? 0, slots);
        if (taken && (slotWaiting || (heldSlots && heldSlots + taken > slots))) {
          slotWaiting = true;
          continue;
        }
        held += needed;
        heldSlots += taken;
        const started = now();
        const handle = start(step);
        running.set(step.name, handle);
        handle.done.then(passed => {
          running.delete(step.name);
          held -= needed;
          heldSlots -= taken;
          const status = passed ? "ok" : handle.stopped ? "stopped" : "fail";
          results.set(step.name, {
            name: step.name,
            status,
            seconds: (now() - started) / 1000,
            ...(handle.timedOut ? { timedOut: true } : {}),
            ...(handle.signal ? { signal: handle.signal } : {}),
          });
          if (status === "fail" && !halted && !keepGoing) halt("SIGTERM");
          launch();
        });
      }
      if (!running.size && !yielding) resolve();
    };
    if (signal?.aborted) halted = true;
    signal?.addEventListener("abort", () => halt(signal.reason), { once: true });
    launch();
  });
  return [...results.values()].filter(row => groupNames.has(row.name));
}

export async function runSteps(steps, start, opts = {}) {
  if (steps.some(step => step.cheap)) {
    const [first, rest] = splitCheapFirst(steps);
    const firstResults = await runStepGroup(first, start, opts);
    const firstFailed = firstResults.length < first.length || firstResults.some(row => row.status !== "ok") || opts.signal?.aborted;
    if (firstFailed || !rest.length) return firstResults;
    const restResults = await runStepGroup(rest, start, { ...opts, initialResults: firstResults });
    return [...firstResults, ...restResults];
  }
  return runStepGroup(steps, start, opts);
}
