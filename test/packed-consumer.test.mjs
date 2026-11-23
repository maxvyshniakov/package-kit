import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { withDefaults } from "../src/config.mjs";
import { entrySpecifiers, exportTargets, inspectTarball, packedArchives, pinnedVersions, requiredPeers, runPackedConsumer, runtimeTarget, tarballIssues } from "../src/packed-consumer.mjs";
import { releasedPackages } from "../src/packages.mjs";
import { tempRepository } from "./fixtures.mjs";

const manifest = {
  name: "@maxvyshniakov/example",
  exports: {
    ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
    "./multiline": { types: "./dist/multiline.d.ts", import: "./dist/multiline.js" },
    "./styles.css": "./dist/styles.css",
    "./package.json": "./package.json",
  },
};

test("export targets and entrypoints come from the manifest's exports", () => {
  assert.deepEqual(exportTargets(manifest.exports["."]), ["./dist/index.d.ts", "./dist/index.js"]);
  assert.equal(runtimeTarget(manifest.exports["."]), "./dist/index.js");
  assert.equal(runtimeTarget({ default: "./x.js" }), "./x.js");
  assert.deepEqual(entrySpecifiers(manifest), ["@maxvyshniakov/example", "@maxvyshniakov/example/multiline"]);
});

test("a tarball that misses an export target, ships tests or keeps workspace ranges fails", () => {
  const files = new Set(["dist/index.d.ts", "dist/index.js", "dist/multiline.d.ts", "dist/multiline.js", "dist/styles.css", "package.json"]);
  const packedManifest = { name: manifest.name, peerDependencies: { react: "^19.0.0" } };
  assert.deepEqual(tarballIssues({ manifest, packedManifest, files }), []);
  const missing = new Set([...files].filter(file => file !== "dist/multiline.js"));
  assert.match(tarballIssues({ manifest, packedManifest, files: missing }).join("\n"), /export "\.\/multiline" points at \.\/dist\/multiline\.js, which is not in the tarball/);
  const tests = new Set([...files, "dist/__tests__/a.js", "dist/fixtures/b.json", "dist/a.stories.js"]);
  assert.match(tarballIssues({ manifest, packedManifest, files: tests }).join("\n"), /ships test files: dist\/__tests__\/a\.js, dist\/fixtures\/b\.json, dist\/a\.stories\.js/);
  assert.match(tarballIssues({ manifest, packedManifest: { dependencies: { a: "workspace:*" } }, files }).join("\n"), /dependencies\.a is workspace:\* in the tarball/);
  assert.match(tarballIssues({ manifest, packedManifest: { private: true }, files }).join("\n"), /private and cannot be published/);
});

test("consumer packages take the first exact pin in the repository's manifests, else the declared range", () => {
  const pinned = pinnedVersions([
    { devDependencies: { vite: "^8.0.0", react: "19.2.8", "react-dom": "^19.3.0", self: "workspace:*" } },
    { dependencies: { vite: "8.3.2" } },
  ]);
  assert.equal(pinned("react"), "19.2.8");
  assert.equal(pinned("vite"), "8.3.2", "an exact pin wins over an earlier range");
  // Text Truncate's React peers are ^ ranges in devDependencies, as its own check accepted.
  assert.equal(pinned("react-dom"), "^19.3.0");
  assert.throws(() => pinned("self"), /No version of self is declared/);
  assert.throws(() => pinned("typescript"), /No version of typescript is declared/);
});

test("the consumer installs every peer but the optional ones", () => {
  assert.deepEqual(requiredPeers([
    { peerDependencies: { react: "^19.0.0", "react-dom": "^19.0.0" } },
    { peerDependencies: { react: "^19.0.0", playwright: ">=1.50.0" }, peerDependenciesMeta: { playwright: { optional: true } } },
    {},
  ]), ["react", "react-dom"]);
});

test("an optional peer the repository pins is installed too; one it does not pin is left out (package-kit#3)", () => {
  const manifests = [{ peerDependencies: { react: "^19.0.0", "@floating-ui/dom": "^1.6.0", playwright: ">=1.52.0" },
    peerDependenciesMeta: { "@floating-ui/dom": { optional: true }, playwright: { optional: true } } }];
  const pinned = pinnedVersions([{ devDependencies: { react: "19.1.0", "@floating-ui/dom": "1.6.13" } }]);
  assert.deepEqual(requiredPeers(manifests, pinned), ["react", "@floating-ui/dom"]);
});

// A root package whose exports point at dist/, which the repository has not
// built: only the prebuilt archive holds it, so packing would fail.
const prebuiltManifest = { name: "@maxvyshniakov/prebuilt", version: "1.2.0", type: "module", exports: { ".": "./dist/index.js" } };

function prebuiltTarball(root, manifest = prebuiltManifest) {
  const staging = path.join(root, "staging", "package");
  fs.mkdirSync(path.join(staging, "dist"), { recursive: true });
  fs.writeFileSync(path.join(staging, "package.json"), `${JSON.stringify(manifest)}\n`);
  fs.writeFileSync(path.join(staging, "dist/index.js"), "export const prebuilt = true;\n");
  const tarball = path.join(root, "archives", `prebuilt-${manifest.version}.tgz`);
  fs.mkdirSync(path.dirname(tarball), { recursive: true });
  execFileSync("tar", ["-czf", tarball, "-C", path.dirname(staging), "package"]);
  return tarball;
}

test("a prebuilt archive is checked as it is, matched to its package by name and version", () => {
  const repository = tempRepository({ "package.json": prebuiltManifest });
  try {
    const tarball = prebuiltTarball(repository.root);
    const tarballDir = path.join(repository.root, "tarballs");
    fs.mkdirSync(tarballDir);
    const released = releasedPackages(repository.root);
    const [pkg] = packedArchives(released, { tarballDir, tarballs: [tarball] });
    assert.equal(pkg.tarball, path.join(tarballDir, path.basename(tarball)));
    assert.deepEqual([...pkg.files].sort(), ["dist/index.js", "package.json"]);
    assert.equal(pkg.packedManifest.version, "1.2.0");
    assert.deepEqual(inspectTarball(tarball).packedManifest, prebuiltManifest);

    const other = prebuiltTarball(path.join(repository.root, "other"), { ...prebuiltManifest, name: "@maxvyshniakov/other" });
    assert.throws(() => packedArchives(released, { tarballDir, tarballs: [other] }), /No prebuilt tarball for @maxvyshniakov\/prebuilt; got @maxvyshniakov\/other\./);
    const stale = prebuiltTarball(path.join(repository.root, "stale"), { ...prebuiltManifest, version: "1.1.0" });
    assert.throws(() => packedArchives(released, { tarballDir, tarballs: [stale] }), /prebuilt tarball of @maxvyshniakov\/prebuilt is 1\.1\.0, not 1\.2\.0/);
    // Without tarballs it packs, and the unbuilt dist/ fails as before.
    assert.throws(() => packedArchives(released, { tarballDir }), /has no dist; run `bun run build` first/);
  } finally {
    repository.cleanup();
  }
});

test("packed-consumer installs and imports the prebuilt archive publish hands it", async () => {
  const repository = tempRepository({ "package.json": prebuiltManifest });
  const { log, error } = console;
  const output = [];
  console.log = console.error = line => output.push(line);
  try {
    const config = { ...withDefaults({ packedConsumer: { types: false } }), root: repository.root };
    const passed = await runPackedConsumer(config, { tarballs: [prebuiltTarball(repository.root)] });
    assert.equal(passed, true, output.join("\n"));
    assert.ok(output.some(line => /^Checking the prebuilt archives in /.test(line)));
    assert.ok(output.includes('  ok import("@maxvyshniakov/prebuilt")'), output.join("\n"));
  } finally {
    Object.assign(console, { log, error });
    repository.cleanup();
  }
});
