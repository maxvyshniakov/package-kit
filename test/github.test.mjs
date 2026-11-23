import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { authHeaders, client, dispatchUrl, registryUrl, repositoryOf } from "../src/github.mjs";
import { kitRoot } from "./fixtures.mjs";

const sha = "a".repeat(40);

test("repositoryOf extracts owner/name from GitHub HTTPS and SSH remotes", () => {
  assert.equal(repositoryOf("https://github.com/maxvyshniakov/package-kit.git"), "maxvyshniakov/package-kit");
  assert.equal(repositoryOf("https://github.com/maxvyshniakov/package-kit"), "maxvyshniakov/package-kit");
  assert.equal(repositoryOf("git@github.com:maxvyshniakov/package-kit.git"), "maxvyshniakov/package-kit");
  assert.throws(() => repositoryOf("https://gitlab.com/maxvyshniakov/package-kit.git"), /not a GitHub repository/);
});

test("URL helpers and authHeaders format GitHub API and registry requests", () => {
  assert.equal(registryUrl("@maxvyshniakov/package-kit"), "https://npm.pkg.github.com/@maxvyshniakov%2fpackage-kit");
  assert.equal(
    dispatchUrl({ repository: "maxvyshniakov/data-grid", workflow: "update.yml" }),
    "https://api.github.com/repos/maxvyshniakov/data-grid/actions/workflows/update.yml/dispatches",
  );
  assert.deepEqual(authHeaders("tok"), { Authorization: "Bearer tok" });
  assert.deepEqual(authHeaders("tok", { Accept: "application/vnd.github+json" }), {
    Authorization: "Bearer tok",
    Accept: "application/vnd.github+json",
  });
});

test("client sends expected URLs, methods, headers, and bodies for every GitHub endpoint", async () => {
  const seen = [];
  const jsonResponse = (body, { ok = true, status = 200, statusText = "OK" } = {}) => ({
    ok,
    status,
    statusText,
    json: async () => body,
  });

  const fakeFetch = async (url, options = {}) => {
    seen.push({ url, method: options.method ?? "GET", headers: options.headers, body: options.body });
    if (url.includes(`/commits/${sha}/statuses`)) return jsonResponse([{ context: "Library checks (local, darwin-arm64)", state: "success" }]);
    if (url.endsWith(`/statuses/${sha}`) && options.method === "POST") return jsonResponse({}, { status: 201 });
    if (url.endsWith(`/commits/${sha}`)) return jsonResponse({ sha });
    if (url.includes("/actions/workflows/check.yml/runs")) return jsonResponse({ workflow_runs: [{ status: "completed", conclusion: "success", html_url: "https://example.test/run/1" }] });
    if (url.endsWith("/dispatches") && options.method === "POST") return jsonResponse({}, { status: 204 });
    if (url === "https://api.github.com/user") return jsonResponse({ id: 42, login: "octocat" });
    if (url === "https://npm.pkg.github.com/@maxvyshniakov%2fpackage-kit") return jsonResponse({ versions: { "1.0.0": {} }, "dist-tags": { latest: "1.0.0" } });
    throw new Error(`unexpected ${url}`);
  };

  const gh = client({ token: "secret-token", repository: () => "maxvyshniakov/package-kit", fetch: fakeFetch });

  const statuses = await gh.statuses(sha);
  assert.equal(statuses.length, 1);

  const posted = await gh.postStatus(sha, { state: "success", context: "ctx", description: "ok" });
  assert.deepEqual(posted, { ok: true });

  assert.equal(await gh.hasCommit(sha), true);

  const runs = await gh.workflowRuns("check.yml", sha);
  assert.equal(runs[0].conclusion, "success");

  assert.equal(await gh.dispatch({ repository: "maxvyshniakov/data-grid", workflow: "update.yml" }), true);

  assert.deepEqual(await gh.user(), { id: 42, login: "octocat" });

  assert.equal(await gh.registryHasVersion("@maxvyshniakov/package-kit", "1.0.0"), true);
  assert.equal(await gh.registryHasVersion("@maxvyshniakov/package-kit", "2.0.0"), false);

  const meta = await gh.registryMetadata("@maxvyshniakov/package-kit");
  assert.equal(meta["dist-tags"].latest, "1.0.0");

  assert.deepEqual(seen.map(r => [r.method, r.url]), [
    ["GET", `https://api.github.com/repos/maxvyshniakov/package-kit/commits/${sha}/statuses?per_page=100`],
    ["POST", `https://api.github.com/repos/maxvyshniakov/package-kit/statuses/${sha}`],
    ["GET", `https://api.github.com/repos/maxvyshniakov/package-kit/commits/${sha}`],
    ["GET", `https://api.github.com/repos/maxvyshniakov/package-kit/actions/workflows/check.yml/runs?head_sha=${sha}&per_page=5`],
    ["POST", "https://api.github.com/repos/maxvyshniakov/data-grid/actions/workflows/update.yml/dispatches"],
    ["GET", "https://api.github.com/user"],
    ["GET", "https://npm.pkg.github.com/@maxvyshniakov%2fpackage-kit"],
    ["GET", "https://npm.pkg.github.com/@maxvyshniakov%2fpackage-kit"],
    ["GET", "https://npm.pkg.github.com/@maxvyshniakov%2fpackage-kit"],
  ]);
  for (const request of seen) assert.equal(request.headers.Authorization, "Bearer secret-token");
  assert.deepEqual(JSON.parse(seen[1].body), { state: "success", context: "ctx", description: "ok" });
  assert.deepEqual(JSON.parse(seen[4].body), { ref: "main" });
});

test("client reports unknownCommit on 422 postStatus and empty metadata on 404 registry", async () => {
  const gh = client({
    token: "t",
    repository: "o/r",
    fetch: async url => {
      if (url.includes("/statuses/")) return { ok: false, status: 422, statusText: "Unprocessable", json: async () => ({ message: "No commit found for SHA" }) };
      if (url.startsWith("https://npm.pkg.github.com/")) return { ok: false, status: 404, statusText: "Not Found", json: async () => ({}) };
      return { ok: false, status: 500, statusText: "Error", json: async () => ({}) };
    },
  });
  const posted = await gh.postStatus(sha, { state: "success" });
  assert.equal(posted.ok, false);
  assert.equal(posted.unknownCommit, true);
  assert.deepEqual(await gh.registryMetadata("@o/pkg"), { versions: {}, "dist-tags": {} });
  assert.equal(await gh.registryHasVersion("@o/pkg", "1.0.0"), false);
});

test("release-gate does not import publish, and Authorization headers live only in src/github.mjs", () => {
  const releaseGate = fs.readFileSync(path.join(kitRoot, "src/release-gate.mjs"), "utf8");
  assert.doesNotMatch(releaseGate, /from ["']\.\/publish\.mjs["']/);

  const srcDir = path.join(kitRoot, "src");
  const authFiles = fs.readdirSync(srcDir)
    .filter(file => file.endsWith(".mjs"))
    .filter(file => /Authorization\s*:/.test(fs.readFileSync(path.join(srcDir, file), "utf8")));
  assert.deepEqual(authFiles, ["github.mjs"]);
});

test("repositoryInfo reads the repository's visibility, which decides npm provenance", async () => {
  const seen = [];
  const gh = client({
    token: "t",
    repository: "maxvyshniakov/package-kit",
    fetch: async (url, options) => {
      seen.push({ url, auth: options.headers.Authorization });
      return { ok: true, status: 200, json: async () => ({ visibility: "public", private: false }) };
    },
  });
  assert.deepEqual(await gh.repositoryInfo(), { visibility: "public", private: false });
  assert.deepEqual(seen, [{ url: "https://api.github.com/repos/maxvyshniakov/package-kit", auth: "Bearer t" }]);
  const failing = client({ token: "t", repository: "o/r", fetch: async () => ({ ok: false, status: 404, statusText: "Not Found" }) });
  await assert.rejects(failing.repositoryInfo(), /repository lookup failed: 404 Not Found/);
});
