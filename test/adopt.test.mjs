import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  chooseCompatibleSet,
  discoverConsumerPins,
  EXIT_UPDATES_AVAILABLE,
  formatAdoptLine,
  parseAdoptArgs,
  runAdopt,
} from "../src/adopt.mjs";
import { withDefaults } from "../src/config.mjs";
import { client as githubClient } from "../src/github.mjs";
import { kitRoot, tempRepository } from "./fixtures.mjs";

function makeTarball(label) {
  const bytes = Buffer.from(`fake-tarball:${label}\n`, "utf8");
  const sha12 = crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 12);
  const integrity = `sha512-${crypto.createHash("sha512").update(bytes).digest("base64")}`;
  const shasum = crypto.createHash("sha1").update(bytes).digest("hex");
  return { bytes, sha12, integrity, shasum };
}

function makeFakeFetch(packagesByName, tarballsByUrl = {}, { failFor = {} } = {}) {
  return async (url, options = {}) => {
    assert.equal(options.headers?.Authorization, "Bearer test-token");
    if (tarballsByUrl[url]) {
      const bytes = tarballsByUrl[url];
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      };
    }
    const prefix = "https://npm.pkg.github.com/";
    if (url.startsWith(prefix)) {
      const name = decodeURIComponent(url.slice(prefix.length));
      if (failFor[name]) {
        const failure = failFor[name];
        if (failure instanceof Error) throw failure;
        return { ok: false, status: failure, statusText: "Error", json: async () => ({}) };
      }
      const meta = packagesByName[name];
      if (!meta) return { ok: false, status: 404, statusText: "Not Found", json: async () => ({}) };
      return { ok: true, status: 200, statusText: "OK", json: async () => meta };
    }
    throw new Error(`unexpected fetch URL: ${url}`);
  };
}

function makeRecorder() {
  const out = [];
  const err = [];
  return {
    out,
    err,
    stdout: line => out.push(line),
    stderr: line => err.push(line),
  };
}

test("compatible pair picks newest stable versions, ignores prereleases, and returns exit 10 then 0", async () => {
  const repo = tempRepository({
    "package.json": {
      name: "consumer-app",
      dependencies: {
        "@maxvyshniakov/sid-kit": "0.26.0",
        "@maxvyshniakov/data-grid": "0.9.0",
      },
    },
  });
  try {
    const fetch = makeFakeFetch({
      "@maxvyshniakov/sid-kit": {
        versions: {
          "0.26.0": {},
          "0.26.4": {},
          "0.26.5-canary.1": {},
        },
      },
      "@maxvyshniakov/data-grid": {
        versions: {
          "0.9.0": { peerDependencies: { "@maxvyshniakov/sid-kit": "^0.26.0" } },
          "0.10.0": { peerDependencies: { "@maxvyshniakov/sid-kit": "^0.26.0" } },
          "0.11.0-rc.1": { peerDependencies: { "@maxvyshniakov/sid-kit": "^0.27.0" } },
        },
      },
    });

    const io = makeRecorder();
    const code = await runAdopt({
      root: repo.root,
      config: withDefaults({}),
      args: ["--json"],
      token: "test-token",
      fetch,
      stdout: io.stdout,
      stderr: io.stderr,
    });

    assert.equal(code, EXIT_UPDATES_AVAILABLE);
    assert.deepEqual(io.err, []);
    const plan = JSON.parse(io.out.join("\n"));
    assert.equal(plan.ok, true);
    assert.equal(plan.status, "updates-available");
    assert.deepEqual(plan.updates, [
      { name: "@maxvyshniakov/data-grid", from: "0.9.0", to: "0.10.0" },
      { name: "@maxvyshniakov/sid-kit", from: "0.26.0", to: "0.26.4" },
    ]);
    assert.deepEqual(plan.waiting, []);
    assert.deepEqual(plan.held, []);

    // Once consumer pins match the newest compatible pair, exit code is 0.
    fs.writeFileSync(
      path.join(repo.root, "package.json"),
      JSON.stringify({
        name: "consumer-app",
        dependencies: {
          "@maxvyshniakov/sid-kit": "0.26.4",
          "@maxvyshniakov/data-grid": "0.10.0",
        },
      }, null, 2),
    );
    const ioUpToDate = makeRecorder();
    const upToDateCode = await runAdopt({
      root: repo.root,
      config: withDefaults({}),
      args: [],
      token: "test-token",
      fetch,
      stdout: ioUpToDate.stdout,
      stderr: ioUpToDate.stderr,
    });
    assert.equal(upToDateCode, 0);
    assert.match(ioUpToDate.out[0], /^adopt: up to date/);
  } finally {
    repo.cleanup();
  }
});

test("newer Sid-Kit waits on Data Grid peerDependencies range and reports why", async () => {
  const repo = tempRepository({
    "package.json": {
      name: "consumer-app",
      dependencies: {
        "@maxvyshniakov/sid-kit": "0.26.0",
        "@maxvyshniakov/data-grid": "0.9.0",
      },
    },
  });
  try {
    const fetch = makeFakeFetch({
      "@maxvyshniakov/sid-kit": {
        versions: {
          "0.26.0": {},
          "0.26.4": {},
          "0.27.0": {},
        },
      },
      "@maxvyshniakov/data-grid": {
        versions: {
          "0.9.0": { peerDependencies: { "@maxvyshniakov/sid-kit": "^0.26.0" } },
          "0.10.0": { peerDependencies: { "@maxvyshniakov/sid-kit": "^0.26.0" } },
        },
      },
    });

    const io = makeRecorder();
    const code = await runAdopt({
      root: repo.root,
      config: withDefaults({}),
      args: ["--json"],
      token: "test-token",
      fetch,
      stdout: io.stdout,
      stderr: io.stderr,
    });

    assert.equal(code, EXIT_UPDATES_AVAILABLE);
    const plan = JSON.parse(io.out.join("\n"));
    assert.deepEqual(plan.updates, [
      { name: "@maxvyshniakov/data-grid", from: "0.9.0", to: "0.10.0" },
      { name: "@maxvyshniakov/sid-kit", from: "0.26.0", to: "0.26.4" },
    ]);
    assert.equal(plan.waiting.length, 1);
    assert.equal(plan.waiting[0].name, "@maxvyshniakov/sid-kit");
    assert.equal(plan.waiting[0].latest, "0.27.0");
    assert.equal(plan.waiting[0].chosen, "0.26.4");
    assert.equal(plan.waiting[0].blockedBy, "@maxvyshniakov/data-grid");
    assert.equal(plan.waiting[0].peerRange, "^0.26.0");
    assert.match(formatAdoptLine(plan), /waiting: @maxvyshniakov\/sid-kit 0\.27\.0/);
  } finally {
    repo.cleanup();
  }
});

test("held package stays pinned and constrains dependent packages with waiting reason", async () => {
  const repo = tempRepository({
    "package.json": {
      name: "consumer-app",
      dependencies: {
        "@maxvyshniakov/sid-kit": "0.26.0",
        "@maxvyshniakov/data-grid": "0.9.0",
      },
    },
  });
  try {
    const fetch = makeFakeFetch({
      "@maxvyshniakov/sid-kit": {
        versions: {
          "0.26.0": {},
          "0.27.0": {},
        },
      },
      "@maxvyshniakov/data-grid": {
        versions: {
          "0.9.0": { peerDependencies: { "@maxvyshniakov/sid-kit": "^0.26.0" } },
          "0.10.0": { peerDependencies: { "@maxvyshniakov/sid-kit": "^0.26.0" } },
          "0.11.0": { peerDependencies: { "@maxvyshniakov/sid-kit": "^0.27.0" } },
        },
      },
    });

    const config = withDefaults({
      adopt: {
        hold: { "sid-kit": "awaiting theme migration" },
      },
    });
    const io = makeRecorder();
    const code = await runAdopt({
      root: repo.root,
      config,
      args: ["--json"],
      token: "test-token",
      fetch,
      stdout: io.stdout,
      stderr: io.stderr,
    });

    assert.equal(code, EXIT_UPDATES_AVAILABLE);
    const plan = JSON.parse(io.out.join("\n"));
    assert.deepEqual(plan.updates, [
      { name: "@maxvyshniakov/data-grid", from: "0.9.0", to: "0.10.0" },
    ]);
    assert.deepEqual(plan.held, [
      { name: "@maxvyshniakov/sid-kit", version: "0.26.0", latest: "0.27.0", reason: "awaiting theme migration" },
    ]);
    assert.equal(plan.waiting.length, 1);
    assert.equal(plan.waiting[0].name, "@maxvyshniakov/data-grid");
    assert.equal(plan.waiting[0].latest, "0.11.0");
    assert.match(plan.waiting[0].reason, /held: awaiting theme migration/);
  } finally {
    repo.cleanup();
  }
});

test("lookup failure warns on stderr and changes nothing even with --apply", async () => {
  const originalManifest = {
    name: "consumer-app",
    dependencies: {
      "@maxvyshniakov/sid-kit": "0.26.0",
    },
  };
  const repo = tempRepository({ "package.json": originalManifest });
  try {
    const fetch = makeFakeFetch({}, {}, { failFor: { "@maxvyshniakov/sid-kit": 503 } });
    const bunCalls = [];
    const io = makeRecorder();
    const code = await runAdopt({
      root: repo.root,
      config: withDefaults({}),
      args: ["--apply", "--json"],
      token: "test-token",
      fetch,
      runBun: (...call) => bunCalls.push(call),
      stdout: io.stdout,
      stderr: io.stderr,
    });

    assert.equal(code, 1);
    assert.equal(bunCalls.length, 0);
    assert.match(io.err.join("\n"), /adopt: warning:.*Registry lookup failed: 503.*changed nothing/);
    const parsed = JSON.parse(io.out.join("\n"));
    assert.equal(parsed.ok, false);
    assert.equal(parsed.status, "error");
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(repo.root, "package.json"), "utf8")),
      originalManifest,
    );
  } finally {
    repo.cleanup();
  }
});

test("apply updates vendored archives under <scope>-<name>-<version>-<sha12>.tgz and runs bun install", async () => {
  const oldSidTar = makeTarball("sid-kit-0.26.0");
  const newSidTar = makeTarball("sid-kit-0.26.4");
  const newGridTar = makeTarball("data-grid-0.10.0");
  const oldSidFile = `maxvyshniakov-sid-kit-0.26.0-${oldSidTar.sha12}.tgz`;
  const oldGridFile = `maxvyshniakov-data-grid-0.9.0-aaaaaaaaaaaa.tgz`;

  const repo = tempRepository({
    "desktop/package.json": {
      name: "straylight-desktop",
      dependencies: {
        "@maxvyshniakov/sid-kit": `file:vendor/${oldSidFile}`,
        "@maxvyshniakov/data-grid": `file:vendor/${oldGridFile}`,
      },
    },
    [`desktop/vendor/${oldSidFile}`]: oldSidTar.bytes.toString("utf8"),
    [`desktop/vendor/${oldGridFile}`]: "old-grid",
  });

  try {
    const sidUrl = "https://npm.pkg.github.com/download/@maxvyshniakov/sid-kit/0.26.4/tar.tgz";
    const gridUrl = "https://npm.pkg.github.com/download/@maxvyshniakov/data-grid/0.10.0/tar.tgz";
    const fetch = makeFakeFetch(
      {
        "@maxvyshniakov/sid-kit": {
          versions: {
            "0.26.0": {},
            "0.26.4": { dist: { tarball: sidUrl, integrity: newSidTar.integrity } },
          },
        },
        "@maxvyshniakov/data-grid": {
          versions: {
            "0.9.0": { peerDependencies: { "@maxvyshniakov/sid-kit": "^0.26.0" } },
            "0.10.0": {
              peerDependencies: { "@maxvyshniakov/sid-kit": "^0.26.0" },
              dist: { tarball: gridUrl, shasum: newGridTar.shasum },
            },
          },
        },
      },
      {
        [sidUrl]: newSidTar.bytes,
        [gridUrl]: newGridTar.bytes,
      },
    );

    const bunCalls = [];
    const io = makeRecorder();
    const code = await runAdopt({
      root: repo.root,
      config: withDefaults({ adopt: { vendorDir: "desktop/vendor" } }),
      args: ["--apply"],
      token: "test-token",
      fetch,
      runBun: (bunArgs, opts) => bunCalls.push({ bunArgs, cwd: opts.cwd }),
      stdout: io.stdout,
      stderr: io.stderr,
    });

    assert.equal(code, 0);
    assert.match(io.out[0], /^adopt: applied /);
    const expectedSidFile = `maxvyshniakov-sid-kit-0.26.4-${newSidTar.sha12}.tgz`;
    const expectedGridFile = `maxvyshniakov-data-grid-0.10.0-${newGridTar.sha12}.tgz`;

    assert.equal(fs.existsSync(path.join(repo.root, "desktop/vendor", expectedSidFile)), true);
    assert.equal(fs.existsSync(path.join(repo.root, "desktop/vendor", expectedGridFile)), true);
    assert.equal(fs.existsSync(path.join(repo.root, "desktop/vendor", oldSidFile)), false);
    assert.equal(fs.existsSync(path.join(repo.root, "desktop/vendor", oldGridFile)), false);

    const updatedManifest = JSON.parse(fs.readFileSync(path.join(repo.root, "desktop/package.json"), "utf8"));
    assert.equal(updatedManifest.dependencies["@maxvyshniakov/sid-kit"], `file:vendor/${expectedSidFile}`);
    assert.equal(updatedManifest.dependencies["@maxvyshniakov/data-grid"], `file:vendor/${expectedGridFile}`);
    assert.deepEqual(bunCalls, [
      { bunArgs: ["install"], cwd: path.join(repo.root, "desktop") },
    ]);
  } finally {
    repo.cleanup();
  }
});

test("apply updates registry pins with bun add --exact and respects devDependencies and --only", async () => {
  const repo = tempRepository({
    "package.json": {
      name: "library-workspace",
      private: true,
      devDependencies: {
        "@maxvyshniakov/repo-kit": "0.7.0",
      },
      dependencies: {
        "@maxvyshniakov/inline-measure": "0.2.0",
        "@maxvyshniakov/text-truncate": "0.1.0",
      },
    },
    "packages/local/package.json": {
      name: "@maxvyshniakov/local-pkg",
      version: "1.0.0",
      dependencies: {
        "@maxvyshniakov/local-pkg": "workspace:*",
      },
    },
  });

  try {
    const fetch = makeFakeFetch({
      "@maxvyshniakov/repo-kit": { versions: { "0.7.0": {}, "0.8.0": {} } },
      "@maxvyshniakov/inline-measure": { versions: { "0.2.0": {}, "0.3.0": {} } },
      "@maxvyshniakov/text-truncate": { versions: { "0.1.0": {}, "0.2.0": {} } },
    });

    const bunCalls = [];
    const io = makeRecorder();
    const code = await runAdopt({
      root: repo.root,
      config: withDefaults({}),
      args: ["--apply", "--only", "repo-kit,inline-measure"],
      token: "test-token",
      fetch,
      runBun: (bunArgs, opts) => bunCalls.push({ bunArgs, cwd: opts.cwd }),
      stdout: io.stdout,
      stderr: io.stderr,
    });

    assert.equal(code, 0);
    assert.deepEqual(bunCalls, [
      { bunArgs: ["add", "--exact", "@maxvyshniakov/inline-measure@0.3.0"], cwd: repo.root },
      { bunArgs: ["add", "--exact", "--dev", "@maxvyshniakov/repo-kit@0.8.0"], cwd: repo.root },
    ]);
  } finally {
    repo.cleanup();
  }
});

test("tarball integrity mismatch fails before mutating any files", async () => {
  const oldFile = "maxvyshniakov-sid-kit-0.26.0-111111111111.tgz";
  const repo = tempRepository({
    "desktop/package.json": {
      name: "consumer",
      dependencies: { "@maxvyshniakov/sid-kit": `file:vendor/${oldFile}` },
    },
    [`desktop/vendor/${oldFile}`]: "old-bytes",
  });
  try {
    const badUrl = "https://npm.pkg.github.com/download/@maxvyshniakov/sid-kit/0.26.4/tar.tgz";
    const fetch = makeFakeFetch(
      {
        "@maxvyshniakov/sid-kit": {
          versions: {
            "0.26.0": {},
            "0.26.4": { dist: { tarball: badUrl, integrity: "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" } },
          },
        },
      },
      { [badUrl]: Buffer.from("tampered-bytes") },
    );

    const io = makeRecorder();
    const code = await runAdopt({
      root: repo.root,
      config: withDefaults({}),
      args: ["--apply"],
      token: "test-token",
      fetch,
      runBun: () => { throw new Error("bun must not run on integrity mismatch"); },
      stdout: io.stdout,
      stderr: io.stderr,
    });

    assert.equal(code, 1);
    assert.match(io.err.join("\n"), /integrity mismatch/);
    assert.equal(fs.existsSync(path.join(repo.root, "desktop/vendor", oldFile)), true);
  } finally {
    repo.cleanup();
  }
});

test("discoverConsumerPins skips local workspace packages and workspace: specs", () => {
  const repo = tempRepository({
    "package.json": {
      name: "monorepo",
      private: true,
      devDependencies: { "@maxvyshniakov/repo-kit": "0.8.0" },
    },
    "packages/data-grid/package.json": {
      name: "@maxvyshniakov/data-grid",
      version: "0.10.0",
    },
    "apps/storybook/package.json": {
      name: "storybook",
      dependencies: {
        "@maxvyshniakov/data-grid": "workspace:*",
        "@maxvyshniakov/sid-kit": "^0.26.0",
      },
    },
  });
  try {
    const { packages, warnings } = discoverConsumerPins(repo.root);
    assert.deepEqual(warnings, []);
    assert.deepEqual(packages.map(p => [p.name, p.current]), [
      ["@maxvyshniakov/repo-kit", "0.8.0"],
      ["@maxvyshniakov/sid-kit", "0.26.0"],
    ]);
  } finally {
    repo.cleanup();
  }
});

test("parseAdoptArgs validates flags and CLI exposes adopt --help", () => {
  assert.deepEqual(parseAdoptArgs(["--json", "--only", "sid-kit,data-grid", "--only", "@maxvyshniakov/repo-kit"]), {
    json: true,
    apply: false,
    only: ["sid-kit", "data-grid", "@maxvyshniakov/repo-kit"],
    help: false,
  });
  assert.throws(() => parseAdoptArgs(["unexpected"]), /unexpected argument/);

  const helpOut = execFileSync("node", [path.join(kitRoot, "src/cli.mjs"), "adopt", "--help"], {
    cwd: kitRoot,
    encoding: "utf8",
  });
  assert.match(helpOut, /Usage: repo-kit adopt \[--json\] \[--apply\] \[--only <names>\]/);

  // Direct unit check on chooseCompatibleSet with registry client
  const gh = githubClient({ token: "t", fetch: async () => { throw new Error("unused"); } });
  assert.equal(typeof gh.registryTarball, "function");
  const solved = chooseCompatibleSet({
    packages: [{ name: "@maxvyshniakov/a", current: "1.0.0", pins: [] }],
    metadataByName: { "@maxvyshniakov/a": { versions: { "1.0.0": {}, "1.2.0": {} } } },
  });
  assert.equal(solved.chosen["@maxvyshniakov/a"], "1.2.0");
});
