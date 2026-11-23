import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { CONFIG_KEYS, configIssues, loadConfig, NOTIFY_KEYS, PUBLISH_ACCESS, PUBLISH_REGISTRIES, REMOVED_KEYS, STEP_KEYS, validateConfig, withDefaults } from "../src/config.mjs";
import { REGISTRIES } from "../src/registry.mjs";
import { normalizeSteps, verifySteps } from "../src/verify.mjs";
import { kitRoot, tempRepository } from "./fixtures.mjs";

const stub = () => [];
const notify = [{ repository: "maxvyshniakov/data-grid", workflow: "update-catalog-dependencies.yml", ref: "main" }];
const inert = ["README.md", "AGENTS.md", "GLOSSARY.md", "LICENSE", ".gitignore", ".gitattributes"];

// The shapes of the consumers' repo-kit.config.mjs files (2026-11-23), every
// key they set, with their functions stubbed.
const CONSUMERS = {
  "data-grid": {
    verify: {
      slots: 2,
      workerMemory: 1.75,
      inert: [...inert, ".lanefather.toml", "docs/agents/**"],
      runner: ["repo-kit.config.mjs", "scripts/repo-kit-browser-steps.mjs"],
      canary: ["verify:script%20tests", "verify:kit"],
      smoke: ({ plan }) => ["verify:lint", ...plan.checks.map(row => row.id)],
      steps: ({ release }) => [
        { name: "sid-kit imports", command: ["run", "check:sidkit-imports", ...(release ? ["--", "--release"] : [])], always: true, cheap: true, memory: 0.1, inputs: ["package.json"] },
        { name: "lint", command: ["run", "lint"], needs: ["sid-kit imports"], always: true, cheap: true, memory: 0.4, inputs: ["packages/**"] },
        { name: "unit tests", command: ["run", "test:grid"], needs: ["sid-kit imports"], usesCores: true, inputs: ["packages/data-grid/src/**"] },
        { name: "build", command: ["run", "build"], needs: ["sid-kit imports"], memory: 0.7, inputs: ["packages/data-grid/package.json"] },
        { name: "storybook tests", command: ["run", "test:storybook"], needs: ["build"], workers: 2, memory: 1.3, inputs: ["apps/storybook/**"] },
      ],
      browser: [
        { name: "story baseline", command: ["run", "check:story-baseline"], needs: [], slots: 1, cheap: true, inputs: ["apps/storybook/**"] },
        { name: "browser checks", command: ["run", "check:browser"], needs: ["story baseline"], slots: 2, inputs: ["scripts/**"] },
      ],
    },
    testHygiene: { ui: true },
    prePush: { slots: 2 },
  },
  "sid-kit": {
    verify: {
      slots: 3,
      inert: [...inert, ".lanefather.toml", "docs/agents/**"],
      runner: ["repo-kit.config.mjs"],
      canary: ["verify:script%20tests", "verify:kit"],
      smoke: ({ plan }) => ["verify:lint", "verify:test%20hygiene", ...plan.checks.map(row => row.id)],
      steps: ({ release }) => [
        { name: "changelogs", command: ["run", "check:changelogs", ...(release ? ["--", "--release"] : [])], cheap: true, memory: 0.1, inputs: ["**/CHANGELOG.md"] },
        { name: "unit tests", command: ["run", "test"], usesCores: true, memory: 0.5, inputs: ["packages/sid-kit/src/**"] },
      ],
      browser: () => [
        { name: "story baseline", command: ["run", "check:story-baseline"], slots: 1, cheap: true, inputs: ["apps/storybook/**"] },
        { name: "browser checks", command: ["run", "check:browser"], needs: ["story baseline"], slots: 2, always: true, inputs: ["scripts/**"], scopeArgs: ({ matchedPaths }) => matchedPaths },
      ],
    },
    testHygiene: { ui: true },
    prePush: { slots: 3 },
    publish: { notify },
  },
  fathers: {
    // Its steps come from tools/checks.py: name, command, memory and timeout.
    verify: { slots: 2, steps: () => [{ name: "slotfather tests", command: ["run", "check", "slotfather tests"], memory: 0.3, timeout: 20 }] },
    prePush: { slots: 2 },
    hooks: { managed: ["pre-push", "lane-check"] },
  },
  "flow-canvas": {
    verify: {
      slots: 2,
      inert,
      steps: ({ release }) => [
        { name: "changelogs", command: ["run", "check:changelogs", ...(release ? ["--", "--release"] : [])], cheap: true, memory: 0.1, inputs: ["**/CHANGELOG.md"] },
        { name: "build", command: ["run", "build"], memory: 0.7, inputs: ["packages/flow-canvas/src/**"] },
        { name: "typecheck", command: ["run", "typecheck"], needs: ["build"], memory: 1.0, inputs: ["tsconfig*.json"] },
      ],
    },
    prePush: { slots: 2 },
  },
  "inline-measure": {
    verify: {
      steps: ({ release }) => [
        { name: "changelog", command: ["run", "check:changelogs", ...(release ? ["--", "--release"] : [])] },
        { name: "build", command: ["run", "build"] },
        { name: "packed consumer", command: ["run", "check:consumer"], needs: ["build"] },
        { name: "test", command: ["run", "test"], usesCores: true },
      ],
    },
    publish: { notify },
  },
  "text-truncate": {
    verify: {
      steps: ({ release }) => [
        { name: "changelog", command: ["run", "check:changelogs", ...(release ? ["--", "--release"] : [])] },
        { name: "build", command: ["run", "build"] },
        { name: "packed consumer", command: ["run", "check:consumer"], needs: ["build"] },
        { name: "test", command: ["run", "test"], usesCores: true },
      ],
    },
    publish: { notify },
  },
};

for (const [name, config] of Object.entries(CONSUMERS)) {
  test(`${name}'s config shape passes validation, and its steps normalize`, () => {
    assert.deepEqual(configIssues(config), []);
    const full = withDefaults(validateConfig(config));
    for (const release of [false, true]) {
      assert.ok(verifySteps(full, { release }).length);
      if (full.verify.browser) assert.ok(verifySteps(full, { release, browser: true }).length);
    }
  });
}

test("repo-kit's own config passes validation", async () => {
  const config = await loadConfig(kitRoot);
  assert.equal(config.root, kitRoot);
  assert.ok(verifySteps(config).length);
});

test("steps, smoke and browser may be functions, arrays or absent", () => {
  assert.deepEqual(configIssues({ verify: { steps: stub, smoke: stub, browser: stub } }), []);
  assert.deepEqual(configIssues({ verify: { steps: [], smoke: ["verify:lint"], browser: [] } }), []);
  assert.deepEqual(configIssues({}), []);
  assert.deepEqual(configIssues({ verify: undefined }), []);
});

test("an unknown key names its path, the nearest known key and the keys it could be", () => {
  const [typo] = configIssues({ verify: { slot: 2 } });
  assert.match(typo, /^unknown key verify\.slot; did you mean verify\.slots\? \(known: steps, browser, slots,/);
  // A step key set on verify itself: the suggestion says where it belongs.
  const [misplaced] = configIssues({ verify: { cheapp: true } });
  assert.match(misplaced, /^unknown key verify\.cheapp; did you mean cheap\? It is a key of each verify step \(known: steps,/);
  const [section] = configIssues({ verfy: {} });
  assert.match(section, /^unknown key verfy; did you mean verify\? \(known: verify, prePush,/);
  // Far from every key: no suggestion, only the known keys.
  assert.match(configIssues({ verify: { zzzzzz: 1 } })[0], /^unknown key verify\.zzzzzz \(known: /);
  assert.match(configIssues({ publish: { notify: [{ repository: "a/b", workflw: "x.yml" }] } })[0],
    /^unknown key publish\.notify\[0\]\.workflw; did you mean publish\.notify\[0\]\.workflow\?/);
});

test("removed keys say which release removed them and what to do", () => {
  assert.deepEqual(configIssues({ adopt: { hold: {} }, rust: {}, changelog: { versionSource: "pyproject.toml" } }), [
    `adopt: ${REMOVED_KEYS.adopt}`,
    `rust: ${REMOVED_KEYS.rust}`,
    `changelog.versionSource: ${REMOVED_KEYS["changelog.versionSource"]}`,
  ]);
  for (const message of Object.values(REMOVED_KEYS)) assert.match(message, /removed in 0\.10\.0/);
});

test("sections and notify targets must be objects", () => {
  assert.deepEqual(configIssues({ verify: () => ({}) }), ["verify must be an object, got function"]);
  assert.deepEqual(configIssues({ prePush: [] }), ["prePush must be an object, got an array"]);
  assert.deepEqual(configIssues({ publish: { notify: {} } }), ["publish.notify must be an array of { repository, workflow, ref }"]);
  assert.deepEqual(configIssues({ publish: { notify: ["x"] } }), ["publish.notify[0] must be an object { repository, workflow, ref }"]);
  assert.deepEqual(configIssues(null), ["repo-kit.config.mjs must export an object, got null"]);
});

test("publish.registry names GitHub Packages, npmjs.org or both, and publish.access npm's access", () => {
  for (const registry of ["github", "npm", ["npm"], ["github", "npm"], ["npm", "github"]]) {
    assert.deepEqual(configIssues({ publish: { registry } }), [], JSON.stringify(registry));
  }
  for (const access of PUBLISH_ACCESS) assert.deepEqual(configIssues({ publish: { registry: "npm", access } }), []);
  for (const registry of ["npmjs", [], ["npm", "npm"], ["github", "jsr"], 1]) {
    assert.deepEqual(configIssues({ publish: { registry } }),
      [`publish.registry must be "github", "npm" or a list of both without repeats, got ${JSON.stringify(registry)}`]);
  }
  assert.deepEqual(configIssues({ publish: { access: "private" } }), ['publish.access must be "public" or "restricted", got "private"']);
  assert.match(configIssues({ publish: { registries: ["npm"] } })[0], /^unknown key publish\.registries; did you mean publish\.registry\?/);
  // GitHub Packages stays the default: configs that set neither key publish as before.
  assert.deepEqual(withDefaults({}).publish, { checks: "check.yml", notify: [], registry: "github", access: "public" });
  assert.deepEqual(withDefaults({ publish: { registry: "npm", access: "restricted" } }).publish.registry, "npm");
  // The schema and the registry adapter know the same registries.
  assert.deepEqual(PUBLISH_REGISTRIES, REGISTRIES);
});

test("validateConfig throws every issue at once", () => {
  assert.throws(() => validateConfig({ verify: { slot: 1 }, adopt: {} }), error => {
    assert.match(error.message, /^repo-kit\.config\.mjs:\n {2}unknown key verify\.slot;.*\n {2}adopt: repo-kit adopt was removed/);
    return true;
  });
});

test("loadConfig rejects an unknown key before any command runs", async () => {
  const repository = tempRepository({ "repo-kit.config.mjs": "export default { verify: { stepTimout: 5 } };\n" });
  try {
    await assert.rejects(loadConfig(repository.root), /unknown key verify\.stepTimout; did you mean verify\.stepTimeout\?/);
  } finally {
    repository.cleanup();
  }
});

test("an unknown step key fails with the step's name and a suggestion", () => {
  assert.throws(() => normalizeSteps([{ name: "lint", command: ["run", "lint"], inptus: ["src/**"] }]),
    /^Error: verify step "lint": unknown key inptus; did you mean inputs\? \(known: name, command,/);
  assert.doesNotThrow(() => normalizeSteps([Object.fromEntries(STEP_KEYS.map(key => [key, undefined]))].map(step => ({ ...step, name: "all", command: [] }))));
});

// The schema and the code that reads it stay in step: src/ reads no key the
// schema lacks, and every key the schema lists is read somewhere.
test("CONFIG_KEYS and STEP_KEYS match the keys src/ reads", () => {
  const files = fs.readdirSync(path.join(kitRoot, "src"), { recursive: true })
    .filter(file => file.endsWith(".mjs"))
    .map(file => path.join("src", file));
  const sources = Object.fromEntries(files.map(file => [file, fs.readFileSync(path.join(kitRoot, file), "utf8")]));
  // Locals named config that are not repo-kit.config.mjs: file-budget's allowlist file.
  const notRepoConfig = { "src/file-budget.mjs": ["version", "files"] };
  const sections = Object.keys(CONFIG_KEYS);
  for (const [file, text] of Object.entries(sources)) {
    // File names such as repo-kit.config.mjs are not reads.
    for (const [, section, key] of text.replace(/[\w./-]+\.mjs\b/g, "").matchAll(/\bconfig\??\.(\w+)(?:\??\.(\w+))?/g)) {
      if (section === "root" || notRepoConfig[file]?.includes(section)) continue;
      assert.ok(sections.includes(section), `${file} reads config.${section}, which CONFIG_KEYS lacks`);
      if (key) assert.ok(CONFIG_KEYS[section].includes(key), `${file} reads config.${section}.${key}, which CONFIG_KEYS.${section} lacks`);
    }
    for (const [, key] of text.matchAll(/\bstep\??\.(\w+)/g)) {
      assert.ok(STEP_KEYS.includes(key), `${file} reads step.${key}, which STEP_KEYS lacks`);
    }
  }
  const readers = files.filter(file => file !== "src/config.mjs").map(file => sources[file]).join("\n");
  const read = key => new RegExp(String.raw`\??\.${key}\b|\{[^}]*\b${key}\b[^}]*\}\s*=`).test(readers);
  for (const [section, keys] of Object.entries(CONFIG_KEYS)) {
    for (const key of keys) assert.ok(read(key), `CONFIG_KEYS.${section}.${key} is read nowhere in src/`);
  }
  for (const key of NOTIFY_KEYS) assert.ok(read(key), `NOTIFY_KEYS ${key} is read nowhere in src/`);
  for (const key of STEP_KEYS) assert.match(readers, new RegExp(String.raw`\bstep\??\.${key}\b`), `STEP_KEYS ${key} is read nowhere in src/`);
});
