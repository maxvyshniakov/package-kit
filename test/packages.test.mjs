import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { changelogPackages, runCheckChangelogs } from "../src/check-changelogs.mjs";
import { withDefaults } from "../src/config.mjs";
import { lockfileWorkspaceVersion, releasedPackages } from "../src/packages.mjs";
import { runRelease } from "../src/release.mjs";
import { kitRoot, rootPackageFiles, tempRepository, workspaceFiles } from "./fixtures.mjs";

const capture = fn => {
  const { log, error } = console;
  const out = [];
  const err = [];
  console.log = (...args) => out.push(args.join(" "));
  console.error = (...args) => err.push(args.join(" "));
  const restore = () => Object.assign(console, { log, error });
  let result;
  try {
    result = fn();
  } catch (thrown) {
    restore();
    throw thrown;
  }
  if (result instanceof Promise) {
    return result.then(
      value => { restore(); return { result: value, stdout: out.join("\n"), stderr: err.join("\n") }; },
      thrown => { restore(); throw thrown; },
    );
  }
  restore();
  return { result, stdout: out.join("\n"), stderr: err.join("\n") };
};

test("releasedPackages hides npm workspace and root package differences behind one interface", () => {
  const ws = tempRepository(workspaceFiles());
  const rootNpm = tempRepository(rootPackageFiles());
  const none = tempRepository({ "package-kit.config.mjs": "export default {};\n" });
  try {
    const [wsPkg] = releasedPackages(ws.root);
    assert.equal(wsPkg.workspace, true);
    assert.equal(wsPkg.archiveName("0.2.0"), "maxvyshniakov-example-0.2.0.tgz");
    assert.equal(wsPkg.archiveName("0.3.0"), "maxvyshniakov-example-0.3.0.tgz");
    assert.deepEqual(wsPkg.archiveVersionsIn("bun add ./maxvyshniakov-example-0.2.0.tgz"), ["0.2.0"]);
    const lock = fs.readFileSync(path.join(ws.root, "bun.lock"), "utf8");
    assert.equal(wsPkg.lockfileVersion(lock), "0.2.0");
    assert.equal(lockfileWorkspaceVersion(wsPkg.withLockfileVersion(lock, "0.3.0"), "packages/example"), "0.3.0");
    const wsManifest = fs.readFileSync(path.join(wsPkg.dir, "package.json"), "utf8");
    assert.equal(wsPkg.readVersion(wsManifest), "0.2.0");
    assert.equal(wsPkg.readVersion(wsPkg.withVersion(wsManifest, "0.2.0", "0.3.0")), "0.3.0");

    const [rootPkg] = releasedPackages(rootNpm.root);
    assert.equal(rootPkg.workspace, false);
    assert.equal(rootPkg.archiveName("0.2.0"), "maxvyshniakov-example-0.2.0.tgz");
    assert.equal(rootPkg.lockfileVersion(lock), undefined);
    assert.equal(rootPkg.withLockfileVersion(lock, "0.3.0"), lock);

    assert.throws(() => releasedPackages(none.root), /^Error: package\.json not found$/);
  } finally {
    ws.cleanup();
    rootNpm.cleanup();
    none.cleanup();
  }
});

test("pkg.versionCommit finds the release commit, even when later commits touched package.json", () => {
  const npmRepo = tempRepository(rootPackageFiles(), { git: true });
  try {
    const [npmPkg0] = releasedPackages(npmRepo.root);
    const npmManifest = path.join(npmRepo.root, "package.json");
    fs.writeFileSync(npmManifest, npmPkg0.withVersion(fs.readFileSync(npmManifest, "utf8"), "0.2.0", "0.3.0"));
    npmRepo.git("commit", "--quiet", "-am", "release 0.3.0");
    const npmRelease = npmRepo.git("rev-parse", "HEAD");
    const parsedNpm = JSON.parse(fs.readFileSync(npmManifest, "utf8"));
    fs.writeFileSync(npmManifest, `${JSON.stringify({ ...parsedNpm, description: "later" }, null, 2)}\n`);
    npmRepo.git("commit", "--quiet", "-am", "touch package.json");
    const [npmPkg] = releasedPackages(npmRepo.root);
    assert.equal(npmPkg.versionCommit((...args) => npmRepo.git(...args)), npmRelease);

  } finally {
    npmRepo.cleanup();
  }
});

test("release and check-changelogs produce expected files and output for workspace and root npm fixtures", async () => {
  const cases = [
    {
      label: "workspace",
      files: workspaceFiles(),
      request: "example:minor",
      name: "@maxvyshniakov/example",
      changelogPath: "packages/example/CHANGELOG.md",
      readManifestVersion: root => JSON.parse(fs.readFileSync(path.join(root, "packages/example/package.json"), "utf8")).version,
      stopBeforeInstall: true,
    },
    {
      label: "root npm",
      files: rootPackageFiles({ "docs/GETTING_STARTED.md": "bun add ./maxvyshniakov-example-0.2.0.tgz\n" }),
      request: "minor",
      name: "@maxvyshniakov/example",
      changelogPath: "CHANGELOG.md",
      readManifestVersion: root => JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version,
      stopBeforeInstall: false,
    },
  ];
  for (const fixture of cases) {
    const repo = tempRepository(fixture.files);
    try {
      const config = withDefaults({});
      config.root = repo.root;
      if (fixture.stopBeforeInstall) {
        config.release = { afterCut() { throw Object.assign(new Error("stop"), { stop: true }); } };
      }

      const pre = capture(() => runCheckChangelogs(config));
      assert.equal(pre.result, true, fixture.label);
      assert.equal(pre.stdout, `ok   ${fixture.name}@0.2.0`);

      const preRelease = capture(() => runCheckChangelogs(config, { release: true }));
      assert.equal(preRelease.result, false, fixture.label);
      assert.match(preRelease.stderr, new RegExp(`FAIL ${fixture.name}@0\\.2\\.0`));

      let releaseOut;
      try {
        releaseOut = await capture(() => runRelease(config, [fixture.request, "--date=2026-11-21"]));
      } catch (error) {
        if (!error.stop) throw error;
      }
      if (releaseOut) assert.equal(releaseOut.stdout, `${fixture.name} 0.2.0 -> 0.3.0 (2026-11-21)`);

      assert.equal(fixture.readManifestVersion(repo.root), "0.3.0", fixture.label);
      assert.match(fs.readFileSync(path.join(repo.root, fixture.changelogPath), "utf8"), /## Unreleased\n\n## 0\.3\.0 - 2026-11-21\n\n### Fixed/);
      if (fixture.label === "workspace") {
        assert.equal(lockfileWorkspaceVersion(fs.readFileSync(path.join(repo.root, "bun.lock"), "utf8"), "packages/example"), "0.3.0");
      }
      assert.match(fs.readFileSync(path.join(repo.root, "docs/GETTING_STARTED.md"), "utf8"), /maxvyshniakov-example-0\.3\.0\.tgz/);

      const post = capture(() => runCheckChangelogs(config, { release: true }));
      assert.equal(post.result, true, fixture.label);
      assert.equal(post.stdout, `ok   ${fixture.name}@0.3.0`);
      const [pkg] = changelogPackages(repo.root);
      assert.equal(pkg.version, "0.3.0");
    } finally {
      repo.cleanup();
    }
  }
});

test("released-package callers never branch on manifestFile or name package.json directly", () => {
  const callers = [
    "src/config.mjs",
    "src/changelog.mjs",
    "src/check-changelogs.mjs",
    "src/release.mjs",
    "src/changelog-entries.mjs",
    "src/publish.mjs",
  ];
  for (const relative of callers) {
    const code = fs.readFileSync(path.join(kitRoot, relative), "utf8").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(code, /manifestFile\s*===?/, relative);
    assert.doesNotMatch(code, /"package\.json"/, relative);
  }
});
