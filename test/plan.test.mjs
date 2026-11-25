import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { withoutYield, yieldRequested, yieldSlots } from "../src/slotfather.mjs";
import {
  applyScopeArgs,
  changedPaths,
  compileGlob,
  createMatcher,
  formatPlan,
  hasPathScopes,
  planChecks,
  planSmoke,
} from "../src/plan.mjs";
import {
  cheapTier,
  cleanCheckoutTree,
  hasReuseBypassEnv,
  normalizeSteps,
  readTreeCache,
  reusableSteps,
  runSteps,
  splitCheapFirst,
  stepCacheKey,
  stepCacheKeys,
  writeTreeCache,
} from "../src/verify.mjs";
import { kitRoot, tempRepository } from "./fixtures.mjs";

const cli = path.join(kitRoot, "src/cli.mjs");
const adapter = path.join(kitRoot, "src/lanefather.mjs");

test("compileGlob and createMatcher support *, ?, **, {a,b}, trailing /, and ! exclusions", () => {
  const matcher = createMatcher([
    "packages/a/src/**/*.{ts,tsx}",
    "packages/a/package.json",
    "docs/",
    "!packages/a/src/**/*.test.tsx",
    "!docs/private/**",
  ]);
  assert.equal(matcher.match("packages/a/src/Button.tsx"), true);
  assert.equal(matcher.match("./packages/a/src/nested/Button.ts"), true);
  assert.equal(matcher.match("packages/a/src/Button.test.tsx"), false);
  assert.equal(matcher.match("packages/a/package.json"), true);
  assert.equal(matcher.match("docs/guide.md"), true);
  assert.equal(matcher.match("docs/private/secret.md"), false);
  assert.equal(matcher.match("packages/b/src/Other.tsx"), false);

  assert.throws(() => compileGlob("packages/[ab]/index.ts"), /character classes/);
  assert.throws(() => compileGlob("packages/{a,[bc]}/index.ts"), /character classes/);
  assert.throws(() => compileGlob("packages/{a,b/index.ts"), /unclosed/);
  assert.throws(() => compileGlob("packages/{a,{b,c}}/index.ts"), /nested/);
  assert.throws(() => compileGlob("packages/{a/**,b}/index.ts"), /\*\*.*inside/);
  assert.throws(() => compileGlob("/"), /empty glob pattern/);

  // Leading `/` stripped consistently with `./`, `a/**/b` matches 0 and N segments, `?` matches 1 non-slash char.
  const deep = createMatcher(["/a/**/b?.ts", "!a/skip/**/b?.ts"]);
  assert.equal(deep.match("a/b1.ts"), true);
  assert.equal(deep.match("/a/b1.ts"), true);
  assert.equal(deep.match("a/x/y/b2.ts"), true);
  assert.equal(deep.match("a/b12.ts"), false);
  assert.equal(deep.match("a/b/.ts"), false);
  assert.equal(deep.match("a/skip/b1.ts"), false);
  assert.equal(deep.match("a/skip/nested/b1.ts"), false);
});

test("planChecks preserves backward compatibility when no path scopes are declared", () => {
  const checks = [
    { id: "verify:lint", suite: "verify", step: { name: "lint", needs: [] } },
    { id: "verify:test", suite: "verify", step: { name: "test", needs: ["lint"] } },
  ];
  assert.equal(hasPathScopes(checks), false);
  const plan = planChecks({ checks, paths: [] });
  assert.equal(plan.v, 1);
  assert.equal(plan.full, true);
  assert.deepEqual(plan.unowned, []);
  assert.deepEqual(plan.suites, ["verify"]);
  assert.deepEqual(plan.checks.map(row => row.id), ["verify:lint", "verify:test"]);
  assert.deepEqual(plan.capabilities, ["base"]);
});

test("planChecks selects only affected checks, transitive producers, and always-run checks", () => {
  const checks = [
    { id: "verify:hygiene", suite: "verify", step: { name: "hygiene", needs: [], always: true, cheap: true, inputs: ["test-hygiene-baseline.json"] } },
    { id: "verify:pkg-a", suite: "verify", step: { name: "pkg-a", needs: [], inputs: ["packages/a/**"] } },
    { id: "verify:pkg-b", suite: "verify", step: { name: "pkg-b", needs: [], inputs: ["packages/b/**"] } },
    { id: "verify:build", suite: "verify", step: { name: "build", needs: [], inputs: ["packages/a/src/**", "packages/b/src/**"] } },
    { id: "verify:typecheck", suite: "verify", step: { name: "typecheck", needs: ["build"], inputs: ["tsconfig.json"] } },
    { id: "browser:build", suite: "browser", step: { name: "build", needs: [], inputs: ["packages/a/src/**"] } },
    { id: "browser:a-ui", suite: "browser", step: { name: "a-ui", needs: ["build"], inputs: ["packages/a/stories/**"] } },
    { id: "browser:b-ui", suite: "browser", step: { name: "b-ui", needs: ["build"], inputs: ["packages/b/stories/**"] } },
  ];

  // Change in packages/b/stories/ only selects always + browser:b-ui + its producer browser:build.
  const storyPlan = planChecks({ checks, paths: ["packages/b/stories/Card.stories.tsx"], inert: ["**/*.md"] });
  assert.equal(storyPlan.full, false);
  assert.deepEqual(storyPlan.unowned, []);
  assert.deepEqual(storyPlan.capabilities, ["base"]);
  assert.deepEqual(storyPlan.checks.map(row => [row.id, row.producer]), [
    ["verify:hygiene", false],
    ["verify:pkg-b", false],
    ["browser:build", true],
    ["browser:b-ui", false],
  ]);
  assert.deepEqual(storyPlan.suites, ["verify", "browser"]);

  // Change in packages/a/src/ triggers build and transitively its dependent typecheck, plus browser:build -> a-ui, b-ui.
  const srcPlan = planChecks({ checks, paths: ["packages/a/src/index.ts"], inert: ["**/*.md"] });
  assert.equal(srcPlan.full, false);
  assert.ok(srcPlan.checks.some(row => row.id === "verify:typecheck" && !row.producer));
  assert.ok(!srcPlan.checks.some(row => row.id === "verify:pkg-b"));

  // Inert-only change runs only always checks.
  const docsPlan = planChecks({ checks, paths: ["README.md"], inert: ["**/*.md"] });
  assert.equal(docsPlan.full, false);
  assert.deepEqual(docsPlan.unowned, []);
  assert.deepEqual(docsPlan.checks.map(row => row.id), ["verify:hygiene"]);
  assert.deepEqual(docsPlan.suites, ["verify"]);

  // Empty diff selects nothing when scopes are declared.
  const emptyPlan = planChecks({ checks, paths: [], inert: ["**/*.md"] });
  assert.equal(emptyPlan.full, false);
  assert.deepEqual(emptyPlan.checks, []);
  assert.deepEqual(emptyPlan.suites, []);
  assert.deepEqual(emptyPlan.capabilities, ["base"]);
});

test("planChecks falls back to full when an unowned path changes, and supports runner + canary", () => {
  const checks = [
    { id: "verify:lint", suite: "verify", step: { name: "lint", needs: [], inputs: ["src/**"], always: true } },
    { id: "verify:unit", suite: "verify", step: { name: "unit", needs: [], inputs: ["src/**"] } },
    { id: "browser:ui", suite: "browser", step: { name: "ui", needs: [], inputs: ["stories/**"] } },
  ];

  // Unowned path forces full.
  const unownedPlan = planChecks({ checks, paths: ["mystery.config.json"], inert: ["**/*.md"] });
  assert.equal(unownedPlan.full, true);
  assert.deepEqual(unownedPlan.unowned, ["mystery.config.json"]);
  assert.deepEqual(unownedPlan.checks.map(row => row.id), ["verify:lint", "verify:unit", "browser:ui"]);
  assert.match(formatPlan(unownedPlan), /No check reads mystery\.config\.json/);

  // Runner path with canary runs canary instead of full.
  const canaryPlan = planChecks({
    checks,
    paths: ["package-kit.config.mjs"],
    runner: ["package-kit.config.mjs"],
    canary: ["unit"],
  });
  assert.equal(canaryPlan.full, false);
  assert.deepEqual(canaryPlan.unowned, []);
  assert.deepEqual(canaryPlan.checks.map(row => row.id), ["verify:lint", "verify:unit"]);
});

test("planSmoke supports function, array, step.smoke tag, and default diff fallback", () => {
  const checks = [
    { id: "verify:lint", suite: "verify", step: { name: "lint", needs: [], always: true } },
    { id: "browser:build", suite: "browser", step: { name: "build", needs: [], inputs: ["vite.config.ts"] } },
    { id: "browser:row-dom", suite: "browser", step: { name: "row-dom", needs: ["build"], inputs: ["src/row/**"], smoke: true } },
    { id: "browser:keyboard", suite: "browser", step: { name: "keyboard", needs: ["build"], inputs: ["src/keyboard/**"] } },
  ];
  const basePlan = planChecks({ checks, paths: ["src/keyboard/nav.ts"] });

  // Default (no smoke config, no smoke:true) falls back to plan.
  const noTagChecks = checks.map(c => ({ ...c, step: { ...c.step, smoke: false } }));
  const fallback = planSmoke({ verify: {} }, { checks: noTagChecks, paths: basePlan.paths, plan: basePlan });
  assert.deepEqual(fallback.checks.map(r => r.id), basePlan.checks.map(r => r.id));

  // step.smoke: true selects tagged steps + their producers.
  const tagged = planSmoke({ verify: {} }, { checks, paths: basePlan.paths, plan: basePlan });
  assert.deepEqual(tagged.capabilities, ["base"]);
  assert.deepEqual(tagged.checks.map(r => [r.id, r.producer]), [
    ["browser:build", true],
    ["browser:row-dom", false],
  ]);

  // verify.smoke as function (data-grid#107: what the merged diff touches + cheap smoke).
  const dynamic = planSmoke(
    {
      verify: {
        smoke: ({ plan }) => [
          "verify:lint",
          ...plan.checks.filter(row => row.suite === "browser" && !row.producer).map(row => row.id),
        ],
      },
    },
    { checks, paths: basePlan.paths, plan: basePlan },
  );
  assert.deepEqual(dynamic.checks.map(r => [r.id, r.producer]), [
    ["verify:lint", false],
    ["browser:build", true],
    ["browser:keyboard", false],
  ]);
});

test("applyScopeArgs appends scoped component arguments on partial runs and omits them on full runs (sid-kit#64)", () => {
  const steps = normalizeSteps([
    {
      name: "browser checks",
      command: ["run", "check:browser", "--", "--no-build"],
      inputs: ["packages/sid-kit/src/components/**"],
      scopeArgs: ({ matchedPaths, full }) => {
        if (full) return [];
        const names = [...new Set(matchedPaths.map(file => file.split("/")[4]).filter(Boolean))];
        return names.length ? names : [];
      },
    },
  ]);

  const partial = applyScopeArgs(steps, {
    paths: ["packages/sid-kit/src/components/timeline/Timeline.tsx"],
    matchedByName: new Map([["browser checks", ["packages/sid-kit/src/components/timeline/Timeline.tsx"]]]),
    full: false,
  });
  assert.deepEqual(partial[0].command, ["run", "check:browser", "--", "--no-build", "timeline"]);

  const full = applyScopeArgs(steps, {
    paths: ["packages/sid-kit/src/components/timeline/Timeline.tsx"],
    matchedByName: new Map([["browser checks", ["packages/sid-kit/src/components/timeline/Timeline.tsx"]]]),
    full: true,
  });
  assert.deepEqual(full[0].command, ["run", "check:browser", "--", "--no-build"]);
});

test("cheapTier and runSteps run cheap steps first and stop heavier steps if a cheap step fails", async () => {
  const steps = normalizeSteps([
    { name: "prep", command: ["run", "prep"] },
    { name: "lint", command: ["run", "lint"], needs: ["prep"], cheap: true },
    { name: "heavy", command: ["run", "heavy"], needs: ["prep"] },
    { name: "heavy-2", command: ["run", "heavy-2"] },
  ]);
  assert.deepEqual([...cheapTier(steps)].sort(), ["lint", "prep"]);
  const [first, rest] = splitCheapFirst(steps);
  assert.deepEqual(first.map(s => s.name), ["prep", "lint"]);
  assert.deepEqual(rest.map(s => s.name), ["heavy", "heavy-2"]);

  // When lint (cheap) fails, heavy and heavy-2 never start even with keepGoing: true.
  const started = [];
  const results = await runSteps(steps, step => {
    started.push(step.name);
    return { stopped: false, done: Promise.resolve(step.name !== "lint"), stop() {} };
  }, { now: () => 0, keepGoing: true });
  assert.deepEqual(started, ["prep", "lint"]);
  assert.deepEqual(results.map(r => [r.name, r.status]), [["prep", "ok"], ["lint", "fail"]]);

  // When cheap tier passes, rest starts and sees prep as ok.
  const startedAll = [];
  const allResults = await runSteps(steps, step => {
    startedAll.push(step.name);
    return { stopped: false, done: Promise.resolve(true), stop() {} };
  }, { now: () => 0 });
  assert.deepEqual(startedAll, ["prep", "lint", "heavy", "heavy-2"]);
  assert.equal(allResults.every(r => r.status === "ok"), true);
});

test("reusableSteps skips cached leaves and keeps producers when a dependent is uncached", async () => {
  const steps = normalizeSteps([
    { name: "build", command: ["run", "build"] },
    { name: "typecheck", command: ["run", "typecheck"], needs: ["build"] },
    { name: "lint", command: ["run", "lint"] },
  ]);

  // Only build and lint are cached: typecheck is NOT cached, so build MUST run to produce artifacts!
  const keys = stepCacheKeys(steps);
  const partialCache = new Set([keys.get("build"), keys.get("lint")]);
  assert.deepEqual([...reusableSteps(steps, partialCache)], ["lint"]);

  // If typecheck is cached without its artifact need `build`, refuse reuse of typecheck.
  const orphanDependentCache = new Set([keys.get("typecheck")]);
  assert.deepEqual([...reusableSteps(steps, orphanDependentCache)], []);

  // All three are cached: all three can be reused.
  const fullCache = new Set(keys.values());
  assert.deepEqual([...reusableSteps(steps, fullCache)].sort(), ["build", "lint", "typecheck"]);

  // Release mode and runtime version change the cache key.
  assert.deepEqual([...reusableSteps(steps, fullCache, { release: true })], []);
  assert.deepEqual([...reusableSteps(steps, fullCache, { runtime: "v0.0.0-other" })], []);

  // Changing an upstream producer's command changes the dependent's transitive cache key.
  const changedProducerSteps = normalizeSteps([
    { name: "build", command: ["run", "build", "--prod"] },
    { name: "typecheck", command: ["run", "typecheck"], needs: ["build"] },
    { name: "lint", command: ["run", "lint"] },
  ]);
  const changedKeys = stepCacheKeys(changedProducerSteps);
  assert.notEqual(changedKeys.get("typecheck"), keys.get("typecheck"));
  assert.equal(changedKeys.get("lint"), keys.get("lint"));

  // Ordering-only `after` barrier does NOT invalidate a cached verify step when an uncached browser step runs after it.
  const orderedSteps = [
    { name: "verify:lint", command: ["run", "lint"], needs: [] },
    { name: "browser:ui", command: ["run", "ui"], needs: [], after: ["verify:lint"] },
  ];
  const orderedKeys = stepCacheKeys(orderedSteps);
  assert.deepEqual([...reusableSteps(orderedSteps, new Set([orderedKeys.get("verify:lint")]))], ["verify:lint"]);

  // Local-source override env vars bypass verified-tree reuse.
  assert.equal(hasReuseBypassEnv({}), false);
  assert.equal(hasReuseBypassEnv({ SID_KIT_SOURCE: "/tmp/sid-kit" }), true);

  // runSteps skips reused steps without calling start().
  const started = [];
  const results = await runSteps(steps, step => {
    started.push(step.name);
    return { stopped: false, done: Promise.resolve(true), stop() {} };
  }, { now: () => 0, reused: new Set(["lint"]) });
  assert.deepEqual(started, ["build", "typecheck"]);
  assert.equal(results.find(r => r.name === "lint").reused, true);
});

test("runSteps yields between checks when SLOTFATHER_YIELD is requested and stops on lease loss", async () => {
  const steps = normalizeSteps([
    { name: "first", command: ["run", "first"] },
    { name: "second", command: ["run", "second"], needs: ["first"] },
  ]);

  let askYield = false;
  let yieldCalls = 0;
  const order = [];
  const results = await runSteps(steps, step => {
    order.push(`start:${step.name}`);
    if (step.name === "first") askYield = true;
    return { stopped: false, done: Promise.resolve(true), stop() {} };
  }, {
    now: () => 0,
    yieldRequested: () => askYield,
    yieldSlots: () => {
      yieldCalls += 1;
      order.push("yield");
      askYield = false;
    },
  });
  assert.equal(yieldCalls, 1);
  assert.deepEqual(order, ["start:first", "yield", "start:second"]);
  assert.deepEqual(results.map(r => [r.name, r.status]), [["first", "ok"], ["second", "ok"]]);

  // If yieldSlots throws (lease lost), remaining steps do not start.
  let askLost = false;
  const startedLost = [];
  const lostResults = await runSteps(steps, step => {
    startedLost.push(step.name);
    if (step.name === "first") askLost = true;
    return { stopped: false, done: Promise.resolve(true), stop() {} };
  }, {
    now: () => 0,
    yieldRequested: () => askLost,
    yieldSlots: () => {
      const error = new Error("lease lost");
      error.code = "LEASE_LOST";
      throw error;
    },
  });
  assert.deepEqual(startedLost, ["first"]);
  assert.deepEqual(lostResults.map(r => [r.name, r.status]), [["first", "ok"]]);
});

test("heavy yield helpers check SLOTFATHER_YIELD, strip it for children, report lease loss, and forward abort", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "package-kit-yield-"));
  try {
    const marker = path.join(dir, "yield-req");
    assert.equal(yieldRequested({ SLOTFATHER_YIELD: marker }), false);
    fs.writeFileSync(marker, "1");
    assert.equal(yieldRequested({ SLOTFATHER_YIELD: marker }), true);
    const cleaned = withoutYield({ SLOTFATHER_YIELD: marker, KEEP: "yes" });
    assert.equal("SLOTFATHER_YIELD" in cleaned, false);
    assert.equal(cleaned.KEEP, "yes");

    const fakeSpawn = ({ code = 0, stderr = "", onKill } = {}) => () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = sig => {
        onKill?.(sig);
        queueMicrotask(() => child.emit("close", null, sig));
      };
      if (!onKill) {
        queueMicrotask(() => {
          if (stderr) child.stderr.emit("data", stderr);
          child.emit("close", code, null);
        });
      }
      return child;
    };

    // yieldSlots resolves on exit 0 and rejects with LEASE_LOST on non-zero.
    await yieldSlots({ spawnImpl: fakeSpawn({ code: 0 }) });
    await assert.rejects(
      () => yieldSlots({ spawnImpl: fakeSpawn({ code: 1, stderr: "lease expired" }) }),
      error => error.code === "LEASE_LOST" && /lease expired/.test(error.message),
    );

    // Abort signal kills the waiting `slotfather yield` child.
    const ac = new AbortController();
    const killed = [];
    const pending = yieldSlots({
      signal: ac.signal,
      spawnImpl: fakeSpawn({ onKill: sig => killed.push(sig) }),
    });
    ac.abort("SIGTERM");
    await assert.rejects(pending, error => error.code === "LEASE_LOST" && /SIGTERM/.test(error.message));
    assert.deepEqual(killed, ["SIGTERM"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("package-kit verify --changed --plan and verified-tree reuse work end to end", () => {
  const repo = tempRepository({
    "package.json": { name: "plan-e2e", type: "module" },
    ".gitignore": "ran-*\n",
    "packages/a/index.js": "export const a = 1;\n",
    "packages/b/index.js": "export const b = 1;\n",
    "README.md": "hello\n",
    "package-kit.config.mjs": `export default {
      verify: {
        inert: ["**/*.md"],
        steps: [
          { name: "always-check", always: true, cheap: true, command: ["-e", "require('fs').appendFileSync('ran-always', 'x')"] },
          { name: "pkg-a", inputs: ["packages/a/**"], command: ["-e", "require('fs').appendFileSync('ran-a', 'x')"] },
          { name: "pkg-b", inputs: ["packages/b/**"], command: ["-e", "require('fs').appendFileSync('ran-b', 'x')"] },
        ],
      },
    };`,
  }, { git: true });
  try {
    const base = repo.git("rev-parse", "HEAD");
    fs.writeFileSync(path.join(repo.root, "packages/a/index.js"), "export const a = 2;\n");
    repo.git("add", "packages/a/index.js");
    repo.git("commit", "-qm", "change pkg a");

    // 1. Plan only: runs no steps, returns scoped JSON.
    const planned = spawnSync(process.execPath, [cli, "verify", "--changed", "--base", base, "--plan", "--json"], {
      cwd: repo.root,
      env: { ...repo.env, SLOTFATHER_LEASE: "test" },
      encoding: "utf8",
    });
    assert.equal(planned.status, 0, planned.stderr);
    const planJson = JSON.parse(planned.stdout);
    assert.equal(planJson.full, false);
    assert.deepEqual(planJson.checks.map(row => row.id), ["always-check", "pkg-a"]);
    assert.equal(fs.existsSync(path.join(repo.root, "ran-a")), false);

    // 2. Execute --changed: runs only always-check and pkg-a, caches them for this clean tree.
    const firstRun = spawnSync(process.execPath, [cli, "verify", "--changed", "--base", base], {
      cwd: repo.root,
      env: { ...repo.env, SLOTFATHER_LEASE: "test" },
      encoding: "utf8",
    });
    assert.equal(firstRun.status, 0, firstRun.stdout + firstRun.stderr);
    assert.equal(fs.readFileSync(path.join(repo.root, "ran-always"), "utf8"), "x");
    assert.equal(fs.readFileSync(path.join(repo.root, "ran-a"), "utf8"), "x");
    assert.equal(fs.existsSync(path.join(repo.root, "ran-b")), false);

    // 3. Repeat on the same clean tree: both steps are reused (ran-* files stay length 1).
    const secondRun = spawnSync(process.execPath, [cli, "verify", "--changed", "--base", base], {
      cwd: repo.root,
      env: { ...repo.env, SLOTFATHER_LEASE: "test" },
      encoding: "utf8",
    });
    assert.equal(secondRun.status, 0, secondRun.stdout + secondRun.stderr);
    assert.match(secondRun.stdout, /ok\s+pkg-a \(reused\)/);
    assert.equal(fs.readFileSync(path.join(repo.root, "ran-a"), "utf8"), "x");

    // 4. --no-reuse bypasses the cache and re-runs pkg-a.
    const thirdRun = spawnSync(process.execPath, [cli, "verify", "--changed", "--base", base, "--no-reuse"], {
      cwd: repo.root,
      env: { ...repo.env, SLOTFATHER_LEASE: "test" },
      encoding: "utf8",
    });
    assert.equal(thirdRun.status, 0, thirdRun.stdout + thirdRun.stderr);
    assert.equal(fs.readFileSync(path.join(repo.root, "ran-a"), "utf8"), "xx");
  } finally {
    repo.cleanup();
  }
});

test("package-kit-lane returns scoped plans, unowned fallback, and narrow --smoke plans", () => {
  const repo = tempRepository({
    "package.json": { name: "lane-plan-fixture", type: "module" },
    "packages/a/src.js": "export const a = 1;\n",
    "packages/b/src.js": "export const b = 1;\n",
    "unowned.txt": "x\n",
    "package-kit.config.mjs": `export default {
      verify: {
        inert: ["**/*.md"],
        smoke: ({ plan }) => ["verify:hygiene", ...plan.checks.filter(r => r.suite === "browser" && !r.producer).map(r => r.id)],
        steps: [
          { name: "hygiene", always: true, cheap: true, command: ["-e", "process.exit(0)"] },
          { name: "pkg-a", inputs: ["packages/a/**"], command: ["-e", "process.exit(0)"] },
          { name: "pkg-b", inputs: ["packages/b/**"], command: ["-e", "process.exit(0)"] },
        ],
        browser: [
          { name: "build", inputs: ["packages/a/**"], command: ["-e", "process.exit(0)"] },
          { name: "ui-a", needs: ["build"], inputs: ["packages/a/**"], command: ["-e", "process.exit(0)"] },
          { name: "ui-b", needs: ["build"], inputs: ["packages/b/**"], command: ["-e", "process.exit(0)"] },
        ],
      },
    };`,
  }, { git: true });
  try {
    const base = repo.git("rev-parse", "HEAD");
    fs.writeFileSync(path.join(repo.root, "packages/b/src.js"), "export const b = 2;\n");

    const scoped = spawnSync(process.execPath, [adapter, "--changed", "--base", base, "--plan", "--json"], {
      cwd: repo.root,
      env: repo.env,
      encoding: "utf8",
    });
    assert.equal(scoped.status, 0, scoped.stderr);
    const scopedPlan = JSON.parse(scoped.stdout);
    assert.equal(scopedPlan.full, false);
    assert.deepEqual(scopedPlan.unowned, []);
    assert.deepEqual(scopedPlan.capabilities, ["base"]);
    assert.deepEqual(scopedPlan.checks.map(r => [r.id, r.producer]), [
      ["verify:hygiene", false],
      ["verify:pkg-b", false],
      ["browser:build", true],
      ["browser:ui-b", false],
    ]);

    // Narrow smoke returns only hygiene + browser:ui-b (with its producer browser:build).
    const smoke = spawnSync(process.execPath, [adapter, "--changed", "--base", base, "--plan", "--smoke", "--json"], {
      cwd: repo.root,
      env: repo.env,
      encoding: "utf8",
    });
    assert.equal(smoke.status, 0, smoke.stderr);
    const smokePlan = JSON.parse(smoke.stdout);
    assert.equal(smokePlan.full, false);
    assert.deepEqual(smokePlan.capabilities, ["base"]);
    assert.deepEqual(smokePlan.checks.map(r => [r.id, r.producer]), [
      ["verify:hygiene", false],
      ["browser:build", true],
      ["browser:ui-b", false],
    ]);

    // Changing an unowned file falls back to full: true.
    fs.writeFileSync(path.join(repo.root, "unowned.txt"), "y\n");
    const full = spawnSync(process.execPath, [adapter, "--changed", "--base", base, "--plan", "--json"], {
      cwd: repo.root,
      env: repo.env,
      encoding: "utf8",
    });
    assert.equal(full.status, 0, full.stderr);
    const fullPlan = JSON.parse(full.stdout);
    assert.equal(fullPlan.full, true);
    assert.deepEqual(fullPlan.unowned, ["unowned.txt"]);
    assert.equal(fullPlan.checks.length, 6);
  } finally {
    repo.cleanup();
  }
});

test("tree cache reads and writes atomically per platform and ignores dirty checkouts", () => {
  const repo = tempRepository({ "a.txt": "1\n" }, { git: true });
  try {
    const clean = cleanCheckoutTree(repo.root, { env: repo.env });
    assert.ok(clean?.tree);
    const cacheDir = path.join(repo.root, ".git", "test-cache");
    writeTreeCache(cacheDir, clean.tree, "darwin-arm64", ["key1"]);
    writeTreeCache(cacheDir, clean.tree, "linux-x64", ["key2"]);
    assert.deepEqual([...readTreeCache(cacheDir, clean.tree, "darwin-arm64")], ["key1"]);
    assert.deepEqual([...readTreeCache(cacheDir, clean.tree, "linux-x64")], ["key2"]);

    // Dirty checkout returns null so reuse is never active on uncommitted edits.
    fs.writeFileSync(path.join(repo.root, "a.txt"), "2\n");
    assert.equal(cleanCheckoutTree(repo.root, { env: repo.env }), null);
    assert.deepEqual(changedPaths(repo.root, "HEAD", { env: repo.env }), ["a.txt"]);
  } finally {
    repo.cleanup();
  }
});

test("unowned fallback and forceFull mark every check producer: false, preserving planSmoke and formatPlan (P1 #1)", () => {
  const checks = [
    { id: "verify:lint", suite: "verify", step: { name: "lint", needs: [], always: true } },
    { id: "browser:build", suite: "browser", step: { name: "build", needs: [], inputs: ["vite.config.ts"] } },
    { id: "browser:ui", suite: "browser", step: { name: "ui", needs: ["build"], inputs: ["stories/**"] } },
  ];

  const unownedPlan = planChecks({ checks, paths: ["mystery.txt"] });
  assert.equal(unownedPlan.full, true);
  assert.deepEqual(unownedPlan.checks.map(row => [row.id, row.producer]), [
    ["verify:lint", false],
    ["browser:build", false],
    ["browser:ui", false],
  ]);
  assert.doesNotMatch(formatPlan(unownedPlan), /\(producer\)/);
  assert.match(formatPlan(unownedPlan), /browser browser:ui: \(all\)/);

  const smoke = planSmoke(
    {
      verify: {
        smoke: ({ plan }) => [
          "verify:lint",
          ...plan.checks.filter(row => row.suite === "browser" && !row.producer).map(row => row.id),
        ],
      },
    },
    { checks, paths: unownedPlan.paths, plan: unownedPlan },
  );
  assert.deepEqual(smoke.checks.map(row => row.id), ["verify:lint", "browser:build", "browser:ui"]);

  // Unknown check in verify.canary throws; cyclic needs do not stack-overflow.
  assert.throws(
    () => planChecks({ checks, paths: ["package-kit.config.mjs"], runner: ["package-kit.config.mjs"], canary: ["nonexistent"] }),
    /verify\.canary references unknown check "nonexistent"/,
  );
  const cyclic = [
    { id: "verify:a", suite: "verify", step: { name: "a", needs: ["b"], inputs: ["a/**"] } },
    { id: "verify:b", suite: "verify", step: { name: "b", needs: ["a"], inputs: ["b/**"] } },
  ];
  const cyclicPlan = planChecks({ checks: cyclic, paths: ["a/file.js"] });
  assert.deepEqual(cyclicPlan.checks.map(row => row.id), ["verify:a", "verify:b"]);
});

test("verify --changed plans across both steps and browser suites so cross-suite files are not unowned (P1 #2)", () => {
  const repo = tempRepository({
    "package.json": { name: "dual-suite-e2e", type: "module" },
    ".gitignore": "ran-*\n",
    "src/index.js": "export const x = 1;\n",
    "stories/Button.stories.js": "export const story = 1;\n",
    "package-kit.config.mjs": `export default {
      verify: {
        steps: [
          { name: "unit", inputs: ["src/**"], command: ["-e", "require('fs').appendFileSync('ran-unit', 'x')"] },
        ],
        browser: [
          { name: "ui", inputs: ["stories/**"], command: ["-e", "require('fs').appendFileSync('ran-ui', 'x')"] },
        ],
      },
    };`,
  }, { git: true });
  try {
    const base = repo.git("rev-parse", "HEAD");
    fs.writeFileSync(path.join(repo.root, "stories/Button.stories.js"), "export const story = 2;\n");
    repo.git("add", "stories/Button.stories.js");
    repo.git("commit", "-qm", "edit story only");

    // verify --changed should NOT treat stories/Button.stories.js as unowned or run unit.
    const verifyPlan = spawnSync(process.execPath, [cli, "verify", "--changed", "--base", base, "--plan", "--json"], {
      cwd: repo.root,
      env: { ...repo.env, SLOTFATHER_LEASE: "test" },
      encoding: "utf8",
    });
    assert.equal(verifyPlan.status, 0, verifyPlan.stderr);
    const verifyJson = JSON.parse(verifyPlan.stdout);
    assert.equal(verifyJson.full, false);
    assert.deepEqual(verifyJson.unowned, []);
    assert.deepEqual(verifyJson.checks, []);

    // verify --browser --changed selects only browser:ui (stripped to "ui").
    const browserPlan = spawnSync(process.execPath, [cli, "verify", "--browser", "--changed", "--base", base, "--plan", "--json"], {
      cwd: repo.root,
      env: { ...repo.env, SLOTFATHER_LEASE: "test" },
      encoding: "utf8",
    });
    assert.equal(browserPlan.status, 0, browserPlan.stderr);
    const browserJson = JSON.parse(browserPlan.stdout);
    assert.equal(browserJson.full, false);
    assert.deepEqual(browserJson.unowned, []);
    assert.deepEqual(browserJson.checks.map(row => row.id), ["ui"]);

    // Executing verify --changed skips unit and exits 0.
    const verifyRun = spawnSync(process.execPath, [cli, "verify", "--changed", "--base", base], {
      cwd: repo.root,
      env: { ...repo.env, SLOTFATHER_LEASE: "test" },
      encoding: "utf8",
    });
    assert.equal(verifyRun.status, 0, verifyRun.stdout + verifyRun.stderr);
    assert.equal(fs.existsSync(path.join(repo.root, "ran-unit")), false);
  } finally {
    repo.cleanup();
  }
});

test("tree cache uses lock-free per-key marker files and SID_KIT_SOURCE bypasses reuse (P2 #3, #4)", () => {
  const repo = tempRepository({
    "package.json": { name: "marker-cache-e2e", type: "module" },
    ".gitignore": "ran-*\n",
    "src/index.js": "export const x = 1;\n",
    "package-kit.config.mjs": `export default {
      verify: {
        steps: [
          { name: "unit", inputs: ["src/**"], command: ["-e", "require('fs').appendFileSync('ran-unit', 'x')"] },
        ],
      },
    };`,
  }, { git: true });
  try {
    const clean = cleanCheckoutTree(repo.root, { env: repo.env });
    const cacheDir = path.join(repo.root, ".git", "lock-free-cache");
    writeTreeCache(cacheDir, clean.tree, "darwin-arm64", ["key-a"]);
    writeTreeCache(cacheDir, clean.tree, "darwin-arm64", ["key-b"]);
    assert.ok(fs.existsSync(path.join(cacheDir, clean.tree, "darwin-arm64", "key-a")));
    assert.ok(fs.existsSync(path.join(cacheDir, clean.tree, "darwin-arm64", "key-b")));
    assert.deepEqual([...readTreeCache(cacheDir, clean.tree, "darwin-arm64")].sort(), ["key-a", "key-b"]);

    // First run populates cache; second run reuses; SID_KIT_SOURCE bypasses reuse.
    const first = spawnSync(process.execPath, [cli, "verify"], {
      cwd: repo.root,
      env: { ...repo.env, SLOTFATHER_LEASE: "test" },
      encoding: "utf8",
    });
    assert.equal(first.status, 0, first.stdout + first.stderr);
    assert.equal(fs.readFileSync(path.join(repo.root, "ran-unit"), "utf8"), "x");

    const reused = spawnSync(process.execPath, [cli, "verify"], {
      cwd: repo.root,
      env: { ...repo.env, SLOTFATHER_LEASE: "test" },
      encoding: "utf8",
    });
    assert.equal(reused.status, 0, reused.stdout + reused.stderr);
    assert.match(reused.stdout, /ok\s+unit \(reused\)/);
    assert.equal(fs.readFileSync(path.join(repo.root, "ran-unit"), "utf8"), "x");

    const override = spawnSync(process.execPath, [cli, "verify"], {
      cwd: repo.root,
      env: { ...repo.env, SLOTFATHER_LEASE: "test", SID_KIT_SOURCE: "/tmp/local-sid-kit" },
      encoding: "utf8",
    });
    assert.equal(override.status, 0, override.stdout + override.stderr);
    assert.doesNotMatch(override.stdout, /\(reused\)/);
    assert.equal(fs.readFileSync(path.join(repo.root, "ran-unit"), "utf8"), "xx");
  } finally {
    repo.cleanup();
  }
});

test("changedPaths handles renames, deletions, untracked files, and spaces", () => {
  const repo = tempRepository({
    "keep.txt": "keep\n",
    "old name.txt": "move me\n",
    "delete me.txt": "bye\n",
  }, { git: true });
  try {
    const base = repo.git("rev-parse", "HEAD");
    fs.renameSync(path.join(repo.root, "old name.txt"), path.join(repo.root, "new name.txt"));
    fs.unlinkSync(path.join(repo.root, "delete me.txt"));
    fs.writeFileSync(path.join(repo.root, "untracked file.txt"), "hi\n");
    const paths = changedPaths(repo.root, base, { env: repo.env });
    assert.deepEqual(paths, ["delete me.txt", "new name.txt", "old name.txt", "untracked file.txt"]);
  } finally {
    repo.cleanup();
  }
});

test("package-kit-lane supports --checks with/without --base, ordering barrier reuse, reused:true, and --no-reuse (P2 #5, #6)", () => {
  const repo = tempRepository({
    "package.json": { name: "lane-e2e", type: "module" },
    ".gitignore": "ran-*\nargs-*\n",
    "packages/a/index.js": "export const a = 1;\n",
    "packages/b/index.js": "export const b = 1;\n",
    "package-kit.config.mjs": `export default {
      verify: {
        steps: [
          { name: "lint", always: true, command: ["-e", "require('fs').appendFileSync('ran-lint', 'x')"] },
          { name: "pkg-b", inputs: ["packages/b/**"], command: ["-e", "process.exit(0)"] },
        ],
        browser: [
          {
            name: "ui",
            inputs: ["packages/*/index.js"],
            command: ["-e", "require('fs').appendFileSync('ran-ui', 'x'); require('fs').writeFileSync('args-ui', process.argv.slice(1).join(','))", "--"],
            scopeArgs: ({ matchedPaths, full }) => full ? ["FULL"] : matchedPaths.map(p => p.split('/')[1]),
          },
        ],
      },
    };`,
  }, { git: true });
  try {
    const base = repo.git("rev-parse", "HEAD");
    fs.writeFileSync(path.join(repo.root, "packages/a/index.js"), "export const a = 2;\n");
    repo.git("add", "packages/a/index.js");
    repo.git("commit", "-qm", "edit pkg a");

    const runLane = args => {
      const res = spawnSync(process.execPath, [adapter, ...args], {
        cwd: repo.root,
        env: { ...repo.env, SLOTFATHER_LEASE: "test" },
        encoding: "utf8",
      });
      assert.equal(res.status, 0, res.stdout + res.stderr);
      const reportPath = /^Verification report: (.+)$/m.exec(res.stdout)?.[1];
      assert.ok(reportPath, res.stdout + res.stderr);
      return JSON.parse(fs.readFileSync(reportPath, "utf8"));
    };

    // 1. Run only verify:lint first so verify:lint is cached on this clean tree.
    const lintOnly = runLane(["--checks", "verify:lint"]);
    assert.deepEqual(lintOnly.checks.map(c => [c.id, c.status, Boolean(c.reused)]), [["verify:lint", "passed", false]]);
    assert.equal(fs.readFileSync(path.join(repo.root, "ran-lint"), "utf8"), "x");

    // 2. Run both verify:lint and browser:ui with --base:
    //    - verify:lint is REUSED even though browser:ui is uncached (P2 #5 ordering barrier vs artifact needs)
    //    - browser:ui receives scoped args ["a"] from --base
    const scopedRun = runLane(["--checks", "verify:lint,browser:ui", "--base", base]);
    assert.deepEqual(scopedRun.checks.map(c => [c.id, c.status, Boolean(c.reused)]), [
      ["verify:lint", "passed", true],
      ["browser:ui", "passed", false],
    ]);
    assert.equal(fs.readFileSync(path.join(repo.root, "ran-lint"), "utf8"), "x");
    assert.equal(fs.readFileSync(path.join(repo.root, "ran-ui"), "utf8"), "x");
    assert.equal(fs.readFileSync(path.join(repo.root, "args-ui"), "utf8"), "a");

    // 3. Repeat with --checks --base: both reused!
    const cachedRun = runLane(["--checks", "verify:lint,browser:ui", "--base", base]);
    assert.deepEqual(cachedRun.checks.map(c => [c.id, c.status, Boolean(c.reused)]), [
      ["verify:lint", "passed", true],
      ["browser:ui", "passed", true],
    ]);
    assert.equal(fs.readFileSync(path.join(repo.root, "ran-ui"), "utf8"), "x");

    // 4. --checks WITHOUT --base passes full: true to scopeArgs (P2 #6).
    const fullCheckRun = runLane(["--checks", "browser:ui", "--no-reuse"]);
    assert.deepEqual(fullCheckRun.checks.map(c => [c.id, c.status, Boolean(c.reused)]), [
      ["browser:ui", "passed", false],
    ]);
    assert.equal(fs.readFileSync(path.join(repo.root, "args-ui"), "utf8"), "FULL");
    assert.equal(fs.readFileSync(path.join(repo.root, "ran-ui"), "utf8"), "xx");
  } finally {
    repo.cleanup();
  }
});
