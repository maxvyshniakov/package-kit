// Change-aware verification planning: selects checks by changed repository
// paths, propagates producer/dependent relationships, handles always-run,
// inert, runner/canary and unowned-path fallback to full, plus narrow smoke
// selection and dynamic per-step scope arguments.
import { execFileSync } from "node:child_process";

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compiles a repository-relative path glob into a RegExp: `*` and `?` stay
 * within a path segment, `**` spans segments, `{a,b}` is either, and a
 * trailing `/` means everything below a directory.
 */
export function compileGlob(glob, label = "inputs") {
  if (typeof glob !== "string" || !glob) {
    throw new Error(`${label}: expected a non-empty glob string, got ${JSON.stringify(glob)}`);
  }
  let source = "";
  const pattern = glob.replace(/^\.\//, "").replace(/\/$/, "/**");
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") {
      const atSegmentStart = index === 0 || pattern[index - 1] === "/";
      if (atSegmentStart && pattern[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else if (char === "[" || char === "]") {
      throw new Error(`${label}: "${glob}": character classes ([...]) are not supported; use {a,b}`);
    } else if (char === "{") {
      const end = pattern.indexOf("}", index);
      if (end === -1) throw new Error(`${label}: "${glob}": unclosed "{"`);
      const body = pattern.slice(index + 1, end);
      if (body.includes("{")) throw new Error(`${label}: "${glob}": nested {} is not supported`);
      if (body.includes("**")) throw new Error(`${label}: "${glob}": "**" inside {} is not supported; list the globs separately`);
      source += `(?:${body.split(",").map(part => escapeRegExp(part).replaceAll("\\*", "[^/]*").replaceAll("\\?", "[^/]")).join("|")})`;
      index = end;
    } else source += escapeRegExp(char);
  }
  return new RegExp(`^${source}$`);
}

function normalizePath(file) {
  return String(file).replaceAll("\\", "/").replace(/^\.\//, "");
}

/**
 * Compiles a list of repository-relative globs (with optional `!` exclusions)
 * into `{ match(path), hasIncludes }`. A path matches iff it matches at least
 * one positive glob and no `!` exclusion glob.
 */
export function createMatcher(globs = [], label = "inputs") {
  const include = [];
  const exclude = [];
  for (const glob of globs ?? []) {
    if (typeof glob !== "string" || !glob) {
      throw new Error(`${label}: expected glob strings, got ${JSON.stringify(glob)}`);
    }
    if (glob.startsWith("!")) exclude.push(compileGlob(glob.slice(1), label));
    else include.push(compileGlob(glob, label));
  }
  return {
    hasIncludes: include.length > 0,
    match(file) {
      if (!include.length) return false;
      const normalized = normalizePath(file);
      return include.some(re => re.test(normalized)) && !exclude.some(re => re.test(normalized));
    },
  };
}

/** Resolves `base` (default HEAD) to a commit SHA in `root`. */
export function resolveBase(root, base = "HEAD", { env = process.env } = {}) {
  return execFileSync("git", ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`], {
    cwd: root,
    encoding: "utf8",
    env,
  }).trim();
}

/**
 * Repository-relative paths changed since `base`, including worktree edits,
 * staged edits (so a staged edit reverted only in the worktree is still
 * checked), both sides of renames (`--no-renames`), and untracked non-ignored
 * files.
 */
export function changedPaths(root, base = "HEAD", { env = process.env } = {}) {
  const commit = resolveBase(root, base, { env });
  const git = (...argv) => execFileSync("git", argv, { cwd: root, encoding: "utf8", env });
  const collected = [
    ...git("diff", "--name-only", "-z", "--no-renames", commit, "--").split("\0"),
    ...git("diff", "--cached", "--name-only", "-z", "--no-renames", commit, "--").split("\0"),
    ...git("ls-files", "--others", "--exclude-standard", "-z").split("\0"),
  ].filter(Boolean);
  return [...new Set(collected)].sort();
}

/**
 * Whether any check or config option declares path ownership. Consumers that
 * have not declared `inputs`, `always`, `inert`, or `runner` keep the legacy
 * full-run behavior.
 */
export function hasPathScopes(checks, { inert = [], runner = [] } = {}) {
  return checks.some(check => (check.step.inputs?.length > 0) || Boolean(check.step.always))
    || (inert?.length > 0)
    || (runner?.length > 0);
}

function resolveNeedId(check, need, byId, bySuiteName) {
  if (byId.has(need)) return need;
  const scoped = bySuiteName.get(`${check.suite}\0${need}`);
  if (scoped) return scoped;
  return null;
}

function resolveCheckRef(ref, checks, byId) {
  if (byId.has(ref)) return [ref];
  const matches = checks.filter(check => check.step.name === ref).map(check => check.id);
  return matches;
}

function collectWithProducers(ids, byId, needIds) {
  const keep = new Set();
  const stack = [...ids].filter(id => byId.has(id));
  while (stack.length) {
    const id = stack.pop();
    if (keep.has(id)) continue;
    keep.add(id);
    for (const need of needIds.get(id) ?? []) stack.push(need);
  }
  return keep;
}

/**
 * Selects the checks affected by `paths`.
 *
 * Each entry in `checks` is `{ id, suite, step }` where `step` is a normalized
 * verify step (`name`, `needs`, optional `inputs`, `always`, `cheap`, `smoke`,
 * `scopeArgs`). Returns the Lanefather plan contract:
 * `{ v: 1, full, paths, unowned, suites, reasons, checks: [{ id, suite, paths, producer }] }`.
 */
export function planChecks({ checks, paths = [], inert = [], runner = [], canary = [], forceFull = false }) {
  const normalizedPaths = [...new Set(paths.map(normalizePath).filter(Boolean))].sort();
  const allSuites = [...new Set(checks.map(check => check.suite))];

  if (!hasPathScopes(checks, { inert, runner })) {
    return {
      v: 1,
      full: true,
      paths: normalizedPaths,
      unowned: [],
      suites: allSuites,
      reasons: Object.fromEntries(allSuites.map(suite => [suite, ["All configured steps are checked."]])),
      checks: checks.map(({ id, suite }) => ({ id, suite, paths: normalizedPaths, producer: false })),
    };
  }

  const byId = new Map(checks.map(check => [check.id, check]));
  const bySuiteName = new Map(checks.map(check => [`${check.suite}\0${check.step.name}`, check.id]));
  const needIds = new Map(checks.map(check => [
    check.id,
    (check.step.needs ?? []).map(need => resolveNeedId(check, need, byId, bySuiteName)).filter(Boolean),
  ]));

  const producersCache = new Map();
  const producersOf = id => {
    if (producersCache.has(id)) return producersCache.get(id);
    const found = new Set();
    for (const need of needIds.get(id) ?? []) {
      found.add(need);
      for (const ancestor of producersOf(need)) found.add(ancestor);
    }
    producersCache.set(id, found);
    return found;
  };

  if (!normalizedPaths.length && !forceFull) {
    return {
      v: 1,
      full: false,
      paths: [],
      unowned: [],
      suites: [],
      reasons: {},
      checks: [],
    };
  }

  const ownMatchers = new Map(checks.map(check => [check.id, createMatcher(check.step.inputs, `verify step "${check.step.name}" inputs`)]));
  const inertMatcher = createMatcher(inert, "verify.inert");
  const runnerMatcher = createMatcher(runner, "verify.runner");
  const canaryIds = new Set((canary ?? []).flatMap(ref => resolveCheckRef(ref, checks, byId)));

  const triggered = new Map();
  const unowned = [];

  for (const file of normalizedPaths) {
    const readers = new Set();
    for (const [id, matcher] of ownMatchers) {
      if (matcher.match(file)) readers.add(id);
    }
    if (runnerMatcher.match(file)) {
      for (const id of canaryIds) readers.add(id);
    }
    if (!readers.size && !inertMatcher.match(file)) {
      unowned.push(file);
    }
    for (const check of checks) {
      const producerHit = [...producersOf(check.id)].some(prod => readers.has(prod));
      if (check.step.always || readers.has(check.id) || producerHit) {
        const list = triggered.get(check.id) ?? [];
        list.push(file);
        triggered.set(check.id, list);
      }
    }
  }

  const fallbackFull = forceFull || unowned.length > 0;
  const selected = fallbackFull
    ? new Set(checks.map(check => check.id))
    : collectWithProducers(triggered.keys(), byId, needIds);

  const full = fallbackFull || (normalizedPaths.length > 0 && selected.size === checks.length);
  const rows = checks
    .filter(check => selected.has(check.id))
    .map(check => ({
      id: check.id,
      suite: check.suite,
      paths: triggered.get(check.id) ?? [],
      producer: !triggered.has(check.id),
    }));

  const suites = allSuites.filter(suite => rows.some(row => row.suite === suite && (full || !row.producer)));
  const reasons = {};
  for (const suite of suites) {
    const suitePaths = [];
    for (const row of rows) {
      if (row.suite !== suite) continue;
      for (const file of row.paths) {
        if (!suitePaths.includes(file)) suitePaths.push(file);
      }
    }
    reasons[suite] = suitePaths.length ? suitePaths : (unowned.length ? [...unowned] : [...normalizedPaths]);
  }

  return {
    v: 1,
    full,
    paths: normalizedPaths,
    unowned,
    suites,
    reasons,
    checks: rows,
  };
}

/**
 * Computes the narrow post-merge smoke plan:
 * - `config.verify.smoke` as a function `({ paths, plan, checks }) => ids`
 * - `config.verify.smoke` as an array of check IDs or step names
 * - steps tagged with `smoke: true`
 * - otherwise falls back to `plan` (what the merged diff touches).
 */
export function planSmoke(config, { checks, paths = [], plan }) {
  const smokeConfig = config?.verify?.smoke;
  const byId = new Map(checks.map(check => [check.id, check]));
  const bySuiteName = new Map(checks.map(check => [`${check.suite}\0${check.step.name}`, check.id]));
  const needIds = new Map(checks.map(check => [
    check.id,
    (check.step.needs ?? []).map(need => resolveNeedId(check, need, byId, bySuiteName)).filter(Boolean),
  ]));

  let targetRefs = null;
  if (typeof smokeConfig === "function") {
    targetRefs = smokeConfig({ paths: plan.paths, plan, checks });
    if (!Array.isArray(targetRefs)) {
      throw new Error("verify.smoke() must return an array of check names or IDs");
    }
  } else if (Array.isArray(smokeConfig)) {
    targetRefs = smokeConfig;
  } else {
    const tagged = checks.filter(check => check.step.smoke === true).map(check => check.id);
    if (tagged.length) targetRefs = tagged;
  }

  if (targetRefs === null) return plan;

  const targetIds = new Set();
  for (const ref of targetRefs) {
    const resolved = resolveCheckRef(ref, checks, byId);
    if (!resolved.length) throw new Error(`verify.smoke references unknown check "${ref}"`);
    for (const id of resolved) targetIds.add(id);
  }

  const selected = collectWithProducers(targetIds, byId, needIds);
  const planPathsById = new Map((plan.checks ?? []).map(row => [row.id, row.paths]));
  const allSuites = [...new Set(checks.map(check => check.suite))];
  const rows = checks
    .filter(check => selected.has(check.id))
    .map(check => ({
      id: check.id,
      suite: check.suite,
      paths: planPathsById.get(check.id) ?? [],
      producer: !targetIds.has(check.id),
    }));

  const full = plan.paths.length > 0 && selected.size === checks.length;
  const suites = allSuites.filter(suite => rows.some(row => row.suite === suite && (full || !row.producer)));
  const reasons = {};
  for (const suite of suites) {
    const suitePaths = [];
    for (const row of rows) {
      if (row.suite !== suite) continue;
      for (const file of row.paths) {
        if (!suitePaths.includes(file)) suitePaths.push(file);
      }
    }
    reasons[suite] = suitePaths.length ? suitePaths : ["Configured smoke selection."];
  }

  return {
    v: 1,
    full,
    paths: plan.paths,
    unowned: plan.unowned,
    suites,
    reasons,
    checks: rows,
  };
}

/**
 * Applies each step's optional `scopeArgs({ paths, matchedPaths, full, release })`
 * function, returning new step objects with any extra arguments appended to
 * `command`. Never mutates the input steps.
 */
export function applyScopeArgs(steps, { paths = [], matchedByName = new Map(), full = false, release = false } = {}) {
  return steps.map(step => {
    if (typeof step.scopeArgs !== "function") return step;
    const extra = step.scopeArgs({
      paths,
      matchedPaths: matchedByName.get(step.name) ?? [],
      full,
      release,
    });
    if (extra === undefined || extra === null) return step;
    if (!Array.isArray(extra) || extra.some(arg => typeof arg !== "string")) {
      throw new Error(`verify step "${step.name}": scopeArgs must return an array of strings`);
    }
    return extra.length ? { ...step, command: [...step.command, ...extra] } : step;
  });
}

/** Human-readable explanation of a plan, matching Straylight's verify-changed output. */
export function formatPlan(plan) {
  const lines = [];
  if (!plan.paths.length) {
    lines.push("No changes against the selected base; no checks selected.");
    return lines.join("\n");
  }
  for (const row of plan.checks) {
    const why = row.producer ? "(producer)" : (row.paths.length ? row.paths.join(", ") : "(all)");
    lines.push(`${row.suite} ${row.id}: ${why}`);
  }
  if (plan.unowned.length) {
    lines.push(`No check reads ${plan.unowned.join(", ")}: declare it on the checks that read it or add it to verify.inert.`);
  }
  if (plan.full) {
    lines.push("The change needs the full gate.");
  } else {
    lines.push(`${plan.checks.length} check(s) in ${plan.suites.join(", ")}.`);
  }
  return lines.join("\n");
}
