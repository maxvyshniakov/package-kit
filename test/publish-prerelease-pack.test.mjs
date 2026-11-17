import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { tempRepository, rootPackageFiles, workspaceFiles } from "./fixtures.mjs";
import { runPrerelease } from "../src/publish-prerelease.mjs";

for (const workspace of [false, true]) {
  test(`real ${workspace ? "workspace" : "root"} prepack generates files in an immutable prerelease archive`, async () => {
    const prefix = workspace ? "packages/example/" : "";
    const files = (workspace ? workspaceFiles : rootPackageFiles)();
    files[".npmrc"] = "registry=http://127.0.0.1:9/\n//127.0.0.1:9/:_authToken=fixture\n";
    const manifest = files[`${prefix}package.json`];
    manifest.scripts = { prepack: "node build.mjs" };
    manifest.files = ["dist"];
    files[`${prefix}build.mjs`] = 'import fs from "node:fs";fs.mkdirSync("dist",{recursive:true});fs.writeFileSync("dist/output.txt","built from captured source");';
    const repo = tempRepository(files, { git: true });
    try {
      execFileSync("bun", ["install", "--ignore-scripts"], { cwd: repo.root, env: repo.env, stdio: "pipe" });
      repo.git("add", ".");
      repo.git("commit", "--allow-empty", "-qm", "lock fixture");
      const sha = repo.git("rev-parse", "HEAD");
      let packed;
      await runPrerelease({ root: repo.root, changelog: {} }, { preid: "preview", tag: "preview", dryRun: true }, {
        tls: () => true,
        tokenSource: () => ({ token: "fixture" }),
        request: async () => ({ status: 404 }),
        execute(command, args, options) {
          if (args[0] === "publish") {
            const archive = args.find(arg => arg.endsWith(".tgz"));
            assert.ok(archive, "publish must upload the exact validated tarball");
            packed = JSON.parse(execFileSync("tar", ["-xOf", archive, "package/package.json"], { encoding: "utf8" }));
            assert.equal(execFileSync("tar", ["-xOf", archive, "package/dist/output.txt"], { encoding: "utf8" }), "built from captured source");
          }
          return execFileSync(command, args, { ...options, stdio: "pipe" });
        },
      });
      assert.equal(packed.version, "0.3.0-preview.1");
      assert.equal(packed.gitHead, sha);
      assert.equal(fs.existsSync(path.join(repo.root, prefix, "dist")), false);
      assert.equal(repo.git("status", "--porcelain"), "");
    } finally { repo.cleanup(); }
  });
}

test("a prepack hook cannot erase provenance before upload", async () => {
  const files = rootPackageFiles();
  files["package.json"].scripts = { prepack: "node build.mjs" };
  files["build.mjs"] = 'import fs from "node:fs";const p=JSON.parse(fs.readFileSync("package.json"));delete p.gitHead;fs.writeFileSync("package.json",JSON.stringify(p));';
  const repo = tempRepository(files, { git: true });
  try {
    execFileSync("bun", ["install", "--ignore-scripts"], { cwd: repo.root, env: repo.env, stdio: "pipe" });
    repo.git("add", ".");
    repo.git("commit", "--allow-empty", "-qm", "lock fixture");
    await assert.rejects(runPrerelease({ root: repo.root, changelog: {} }, { preid: "preview", tag: "preview" }, {
      tls: () => true,
      tokenSource: () => ({ token: "fixture" }),
      request: async () => ({ ok: true, json: async () => ({ versions: { "0.2.0": {} }, "dist-tags": { latest: "0.2.0" } }) }),
      execute(command, args, options) {
        assert.notEqual(args[0], "publish", "invalid packed provenance must be refused before upload");
        return execFileSync(command, args, { ...options, stdio: "pipe" });
      },
    }), /packed.*provenance/i);
    assert.equal(repo.git("status", "--porcelain"), "");
  } finally { repo.cleanup(); }
});
