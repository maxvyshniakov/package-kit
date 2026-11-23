import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { withDefaults } from "../src/config.mjs";
import { dispatchUrl, notify, notifyAll } from "../src/notify.mjs";
import {
  checksState,
  githubRepository,
  noreplyEmail,
  NPM_FLOOR,
  NPM_RELEASE_WORKFLOW,
  npmBlockers,
  npmPublishArguments,
  provenanceWanted,
  publishArguments,
  publishBlockers,
  registriesToPublish,
  registryUrl,
  releaseArchive,
  releaseCommitOf,
  resumePublication,
  runPublish,
  tagEnvironment,
  tagPushRecovery,
} from "../src/publish.mjs";
import { packageUrl, publicationIssues, registriesOf, registryClient, tarballIntegrity, verifyPublication } from "../src/registry.mjs";

import { tempRepository } from "./fixtures.mjs";

const ready = { token: "t", dirty: false, head: "a".repeat(40), upstream: "a".repeat(40), issues: [], tagExists: false, tag: "v0.2.0" };

const quietly = async fn => {
  const { log, warn } = console;
  console.log = console.warn = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, { log, warn });
  }
};

test("publishing requires a token, a clean HEAD at origin/main, a released changelog and a new tag", () => {
  assert.deepEqual(publishBlockers(ready), []);
  assert.match(publishBlockers({ ...ready, token: undefined }).join("\n"), /GITHUB_TOKEN is not set/);
  assert.match(publishBlockers({ ...ready, dirty: true }).join("\n"), /uncommitted changes/);
  assert.match(publishBlockers({ ...ready, upstream: "b".repeat(40) }).join("\n"), /HEAD aaaaaaaaaaaa is not origin\/main bbbbbbbbbbbb; push the release commit first/);
  assert.match(publishBlockers({ ...ready, issues: ['"## Unreleased" has entries'] }).join("\n"), /CHANGELOG.md: "## Unreleased" has entries/);
  assert.match(publishBlockers({ ...ready, tagExists: true }).join("\n"), /v0.2.0 already exists; .*--resume/);
});

test("a worktree branch or a detached HEAD at origin/main's SHA may publish, as Inline Measure and Text Truncate could not", () => {
  // The branch name is not an input: only SHA equality with origin/main counts.
  assert.deepEqual(publishBlockers({ ...ready, branch: "chore/release" }), []);
  assert.deepEqual(publishBlockers({ ...ready, branch: "" }), []);
  assert.notDeepEqual(publishBlockers({ ...ready, branch: "main", head: "d".repeat(40) }), []);
});

test("bun publish gets the root bunfig.toml after the subcommand", () => {
  // `bun --config <file> publish` exits 0 without publishing anything.
  assert.deepEqual(publishArguments("/repo/bunfig.toml"), ["publish", "--config=/repo/bunfig.toml"]);
  assert.deepEqual(publishArguments(undefined), ["publish"]);
});

test("the registry check reads the scoped package from GitHub Packages", () => {
  assert.equal(registryUrl("@maxvyshniakov/sid-kit"), "https://npm.pkg.github.com/@maxvyshniakov%2fsid-kit");
});

test("publication follows the newest checks run on the release commit", () => {
  assert.equal(checksState([]), "missing");
  assert.equal(checksState([{ status: "in_progress", conclusion: null }]), "running");
  assert.equal(checksState([{ status: "completed", conclusion: "failure" }, { status: "completed", conclusion: "success" }]), "failed");
  assert.equal(checksState([{ status: "completed", conclusion: "cancelled" }]), "failed");
  assert.equal(checksState([{ status: "completed", conclusion: "success" }]), "passed");
});

test("the GitHub repository comes from the origin URL", () => {
  assert.equal(githubRepository("https://github.com/maxvyshniakov/sid-kit.git"), "maxvyshniakov/sid-kit");
  assert.equal(githubRepository("git@github.com:maxvyshniakov/sid-kit.git"), "maxvyshniakov/sid-kit");
  assert.equal(githubRepository("https://github.com/maxvyshniakov/sid-kit"), "maxvyshniakov/sid-kit");
  assert.throws(() => githubRepository("https://gitlab.com/maxvyshniakov/sid-kit.git"), /not a GitHub repository/);
});

test("--resume publishes, tags or only pushes the tag, and refuses a tag that is not this release's", () => {
  assert.equal(resumePublication({ published: false, tagExists: false, tagMatches: true }), "publish");
  assert.equal(resumePublication({ published: true, tagExists: false, tagMatches: true }), "tag");
  assert.equal(resumePublication({ published: true, tagExists: true, tagMatches: true }), "done");
  assert.throws(() => resumePublication({ published: false, tagExists: true, tagMatches: true }), /do not match/);
  assert.throws(() => resumePublication({ published: true, tagExists: true, tagMatches: false }), /do not match/);
});

test("the tag takes git's identity unless RELEASE_TAGGER_EMAIL names another address", () => {
  const env = { PATH: "/bin" };
  assert.equal(tagEnvironment(env), env);
  assert.deepEqual(tagEnvironment({ ...env, RELEASE_TAGGER_EMAIL: "release@example.com" }), {
    PATH: "/bin",
    RELEASE_TAGGER_EMAIL: "release@example.com",
    GIT_COMMITTER_EMAIL: "release@example.com",
  });
});

test("a declined tag push names the commands that retag as the account's noreply address", () => {
  // GitHub declined Sid-Kit's v0.34.5 with GH007 while the account blocked pushes exposing its private emails.
  const noreply = noreplyEmail({ id: 136558382, login: "maxvyshniakov" });
  assert.equal(noreply, "136558382+maxvyshniakov@users.noreply.github.com");
  assert.deepEqual(tagPushRecovery("v0.2.0", "@maxvyshniakov/sid-kit 0.2.0", noreply), [
    "git tag --delete v0.2.0",
    'GIT_COMMITTER_EMAIL=136558382+maxvyshniakov@users.noreply.github.com git tag --annotate v0.2.0 --message "@maxvyshniakov/sid-kit 0.2.0"',
    "git push origin v0.2.0",
  ]);
});

test("GIT_COMMITTER_EMAIL sets an annotated tag's tagger without touching git config", () => {
  const repository = mkdtempSync(path.join(tmpdir(), "repo-kit-tagger-"));
  try {
    const git = (args, env = {}) => execFileSync("git", args, { cwd: repository, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", ...env } }).trim();
    git(["init", "--quiet"]);
    git(["config", "user.name", "Release"]);
    git(["config", "user.email", "private@example.com"]);
    git(["commit", "--quiet", "--allow-empty", "--message", "release"]);
    git(["tag", "--annotate", "v1.0.0", "--message", "v1.0.0"], { GIT_COMMITTER_EMAIL: "1+someone@users.noreply.github.com" });
    assert.equal(git(["for-each-ref", "--format=%(taggeremail)", "refs/tags/v1.0.0"]), "<1+someone@users.noreply.github.com>");
    assert.equal(git(["config", "user.email"]), "private@example.com");
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("publish notifies only after tagging", () => {
  const source = readFileSync(new URL("../src/publish.mjs", import.meta.url), "utf8");
  const pushTag = source.slice(source.indexOf("const pushTag = async () => {"), source.indexOf("  if (action === \"done\") {"));
  const tagPush = pushTag.indexOf('git("push", "origin", tag);');
  const notifyCall = pushTag.indexOf("await notifyAll(config.publish.notify, token)");
  assert.ok(tagPush > 0 && notifyCall > tagPush, "notifications follow the tag push");
  assert.match(pushTag, /tagPushRecovery/, "a declined push prints the GH007 recovery");
  // --resume's "done" path and a fresh publication push the tag the same way.
  assert.equal(source.match(/return pushTag\(\);/g)?.length, 2);
});

test("--resume finds the release commit even after later commits touched package.json", () => {
  const repository = mkdtempSync(path.join(tmpdir(), "repo-kit-release-commit-"));
  try {
    const run = (...args) => execFileSync("git", args, { cwd: repository, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "a", GIT_AUTHOR_EMAIL: "a@b", GIT_COMMITTER_NAME: "a", GIT_COMMITTER_EMAIL: "a@b" } }).trim();
    const manifest = (version, extra = {}) => writeFileSync(path.join(repository, "package.json"), `${JSON.stringify({ name: "x", version, ...extra }, null, 2)}\n`);
    run("init", "--quiet");
    manifest("0.1.0");
    run("add", "-A");
    run("commit", "--quiet", "-m", "0.1.0");
    manifest("0.2.0");
    run("commit", "--quiet", "-am", "release 0.2.0");
    const release = run("rev-parse", "HEAD");
    manifest("0.2.0", { dependencies: { a: "1.0.0" } });
    run("commit", "--quiet", "-am", "add a dependency");
    const git = (...args) => run(...args);
    assert.equal(releaseCommitOf(git, { path: ".", version: "0.2.0" }), release);
    assert.throws(() => releaseCommitOf(git, { path: ".", version: "0.3.0" }), /no commit sets "version": "0.3.0"/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

const dataGrid = { repository: "maxvyshniakov/data-grid", workflow: "update-catalog-dependencies.yml", ref: "main" };

test("publication requests each configured workflow, and a failed request is recoverable", async () => {
  let request;
  assert.equal(await quietly(() => notify(dataGrid, "test-token", async (url, options) => {
    request = { url, options };
    return { ok: true };
  })), true);
  assert.equal(request.url, "https://api.github.com/repos/maxvyshniakov/data-grid/actions/workflows/update-catalog-dependencies.yml/dispatches");
  assert.equal(dispatchUrl(dataGrid), request.url);
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers.Authorization, "Bearer test-token");
  assert.deepEqual(JSON.parse(request.options.body), { ref: "main" });
  // The package is already published and tagged: a failed request only warns.
  assert.equal(await quietly(() => notify(dataGrid, "test-token", async () => ({ ok: false, status: 403 }))), false);
  assert.equal(await quietly(() => notify(dataGrid, "test-token", async () => { throw new Error("network down"); })), false);
  assert.equal(await quietly(() => notify(dataGrid, undefined, async () => assert.fail("no request without a token"))), false);
  const requested = [];
  assert.equal(await quietly(() => notifyAll([dataGrid, { ...dataGrid, repository: "maxvyshniakov/other" }], "t", async url => {
    requested.push(url);
    return { ok: !url.includes("data-grid") };
  })), false);
  assert.equal(requested.length, 2, "a failed request does not stop the next one");
});

test("publish follows release.gate: the local attestation before bun publish, or the checks workflow under ci", () => {
  const source = readFileSync(new URL("../src/publish.mjs", import.meta.url), "utf8");
  const plan = source.indexOf("publishGatePlan({");
  const attestation = source.indexOf('plan === "attestation"');
  const workflowWait = source.indexOf('plan === "workflow"');
  const bunPublish = source.indexOf("publishArguments(fs.existsSync(bunfig)");
  assert.ok(plan > 0 && attestation > plan && workflowWait > plan, "one plan decides the gate");
  assert.ok(attestation < bunPublish && workflowWait < bunPublish, "every gate comes before bun publish");
  // A missing, pending or failed attestation refuses; it never skips silently.
  const branch = source.slice(attestation, source.indexOf("} else if", attestation));
  assert.match(branch, /readAttestation\(/);
  assert.match(branch, /if \(attestation\.state !== "passed"\) return fail\(/);
  // The gate is read before the token, so a mistyped release.gate fails first.
  assert.ok(source.indexOf("releaseGate(config)") < source.indexOf("resolveToken()"));
});

test("publish refuses a repository without package.json before any token", async () => {
  const repository = tempRepository({ "pyproject.toml": '[project]\nname = "example"\nversion = "0.2.0"\n', "repo-kit.config.mjs": "export default {};\n" });
  try {
    const config = withDefaults({});
    config.root = repository.root;
    await assert.rejects(runPublish(config), /package\.json not found/);
  } finally {
    repository.cleanup();
  }
});

// npmjs.org: trusted publishing from GitHub Actions, provenance, one archive.

const npmReady = { inActions: true, oidc: true, npmVersion: "11.19.1", publishConfigRegistry: undefined };

test("npmjs.org publishes only from Actions with an OIDC token, npm 11.5.1 or newer, and no other publishConfig.registry", () => {
  assert.deepEqual(npmBlockers(npmReady), []);
  assert.deepEqual(npmBlockers({ ...npmReady, npmVersion: NPM_FLOOR }), []);
  for (const registry of ["https://registry.npmjs.org/", "https://registry.npmjs.org"]) {
    assert.deepEqual(npmBlockers({ ...npmReady, publishConfigRegistry: registry }), [], registry);
  }
  // A local run names the caller workflow that publishes instead.
  assert.deepEqual(npmBlockers({ ...npmReady, inActions: false, oidc: false }), [
    `npmjs.org publishes only from GitHub Actions (trusted publishing and provenance); run the caller workflow: gh workflow run ${NPM_RELEASE_WORKFLOW} --ref main`,
  ]);
  assert.match(npmBlockers({ ...npmReady, oidc: false }).join("\n"), /ACTIONS_ID_TOKEN_REQUEST_URL is not set: .*id-token: write/);
  assert.match(npmBlockers({ ...npmReady, npmVersion: "11.5.0" }).join("\n"), /npm 11\.5\.0 is older than 11\.5\.1/);
  assert.match(npmBlockers({ ...npmReady, npmVersion: "10.9.2" }).join("\n"), /npm 10\.9\.2 is older than 11\.5\.1/);
  assert.match(npmBlockers({ ...npmReady, npmVersion: undefined }).join("\n"), /npm is not on PATH/);
  assert.match(npmBlockers({ ...npmReady, publishConfigRegistry: "https://npm.pkg.github.com/" }).join("\n"),
    /publishConfig\.registry is https:\/\/npm\.pkg\.github\.com\/, not https:\/\/registry\.npmjs\.org\/; delete it/);
  // Beside GitHub Packages, publishConfig.registry would send both uploads to one registry.
  assert.deepEqual(npmBlockers({ ...npmReady, registries: ["github", "npm"] }), []);
  for (const registry of ["https://npm.pkg.github.com/", "https://registry.npmjs.org/"]) {
    assert.match(npmBlockers({ ...npmReady, registries: ["github", "npm"], publishConfigRegistry: registry }).join("\n"), /publishing to GitHub Packages and npmjs\.org, delete it/, registry);
  }
});

test("publishBlockers adds the npm blockers only when publish.registry lists npm, and words the token for it", () => {
  assert.deepEqual(publishBlockers({ ...ready, npm: { inActions: false } }), [], "GitHub Packages alone ignores the npm facts");
  assert.deepEqual(publishBlockers({ ...ready, registries: ["npm"], npm: npmReady }), []);
  assert.match(publishBlockers({ ...ready, registries: ["npm"], npm: { ...npmReady, oidc: false } }).join("\n"), /id-token: write/);
  assert.deepEqual(publishBlockers({ ...ready, token: undefined, registries: ["npm"], npm: npmReady }),
    ["GITHUB_TOKEN is not set and gh has no token; the release gate, the tag push and publish.notify need it"]);
  assert.match(publishBlockers({ ...ready, token: undefined, registries: ["github", "npm"], npm: npmReady })[0], /write:packages/);
});

test("--provenance goes to npm only for a public package from a public repository", () => {
  assert.equal(provenanceWanted({ repositoryPublic: true, access: "public" }), true);
  assert.equal(provenanceWanted({ repositoryPublic: false, access: "public" }), false, "npm refuses provenance from a private repository");
  assert.equal(provenanceWanted({ repositoryPublic: true, access: "restricted" }), false);
  const tarball = "/tmp/work/maxvyshniakov-repo-kit-1.0.0.tgz";
  assert.deepEqual(npmPublishArguments({ tarball, name: "@maxvyshniakov/repo-kit", access: "public", provenance: true }), [
    "publish", tarball,
    `--userconfig=${devNull}`,
    "--registry=https://registry.npmjs.org/",
    // .npmrc's @maxvyshniakov:registry would otherwise win over --registry.
    "--@maxvyshniakov:registry=https://registry.npmjs.org/",
    "--access=public",
    "--provenance",
  ]);
  assert.deepEqual(npmPublishArguments({ tarball, name: "unscoped", access: "restricted", provenance: false }),
    ["publish", tarball, `--userconfig=${devNull}`, "--registry=https://registry.npmjs.org/", "--access=restricted"]);
});

test("bun publish uploads a prebuilt archive with the root bunfig.toml after the subcommand", () => {
  assert.deepEqual(publishArguments("/repo/bunfig.toml", "/tmp/a.tgz"), ["publish", "/tmp/a.tgz", "--config=/repo/bunfig.toml"]);
  assert.deepEqual(publishArguments(undefined, "/tmp/a.tgz"), ["publish", "/tmp/a.tgz"]);
});

test("publish.registry is one registry or a list, GitHub Packages by default", () => {
  assert.deepEqual(registriesOf(), ["github"]);
  assert.deepEqual(registriesOf("npm"), ["npm"]);
  assert.deepEqual(registriesOf(["github", "npm"]), ["github", "npm"]);
  assert.deepEqual(registriesOf(withDefaults({}).publish.registry), ["github"]);
  assert.equal(withDefaults({}).publish.access, "public");
});

// A fake registry: `serve` answers each request in turn, the clock advances
// only when the poll sleeps.
function fakeRegistry(responses) {
  const requests = [];
  const sleeps = [];
  let clock = 0;
  const fetch = async (url, options) => {
    requests.push({ url, headers: options?.headers ?? {} });
    const next = responses.length > 1 ? responses.shift() : responses[0];
    if (next === 404) return { ok: false, status: 404, statusText: "Not Found", json: async () => ({}) };
    if (next === 500) return { ok: false, status: 500, statusText: "Error", json: async () => ({}) };
    return { ok: true, status: 200, json: async () => next, arrayBuffer: async () => next };
  };
  const sleep = async ms => {
    sleeps.push(ms);
    clock += ms;
  };
  return { fetch, sleep, now: () => clock, requests, sleeps };
}

const name = "@maxvyshniakov/example";
const bytes = Buffer.from("the archive");
const integrity = tarballIntegrity(bytes);
const attested = { version: "1.2.0", dist: { integrity, tarball: "https://registry.npmjs.org/x.tgz", attestations: { url: "https://registry.npmjs.org/-/npm/v1/attestations/x", provenance: { predicateType: "https://slsa.dev/provenance/v1" } } } };

test("the integrity is npm's sha512 Subresource Integrity of the archive", () => {
  assert.match(integrity, /^sha512-[A-Za-z0-9+/]+=*$/);
  assert.equal(integrity, `sha512-${createHash("sha512").update(bytes).digest("base64")}`);
});

test("npmjs.org is read per version without a token; GitHub Packages as a packument with one", async () => {
  const npm = fakeRegistry([attested]);
  assert.deepEqual(await registryClient({ kind: "npm", fetch: npm.fetch }).manifest(name, "1.2.0"), attested);
  assert.equal(npm.requests[0].url, "https://registry.npmjs.org/@maxvyshniakov%2fexample/1.2.0");
  assert.equal(npm.requests[0].headers.Authorization, undefined);
  assert.equal(packageUrl("npm", name), "https://registry.npmjs.org/@maxvyshniakov%2fexample");

  const github = fakeRegistry([{ versions: { "1.2.0": attested } }]);
  const client = registryClient({ kind: "github", token: "secret", fetch: github.fetch });
  assert.equal(await client.hasVersion(name, "1.2.0"), true);
  assert.equal(await client.hasVersion(name, "9.9.9"), false);
  assert.equal(github.requests[0].url, "https://npm.pkg.github.com/@maxvyshniakov%2fexample");
  assert.equal(github.requests[0].headers.Authorization, "Bearer secret");
  assert.throws(() => registryClient({ kind: "jsr" }), /Unknown registry jsr; known: github, npm/);
});

test("a version the registry does not serve yet is polled until it does", async () => {
  // npmjs.org answers 404, then an error, then the version: two waits.
  const registry = fakeRegistry([404, 500, attested]);
  const waits = [];
  const client = registryClient({ kind: "npm", fetch: registry.fetch, sleep: registry.sleep, now: registry.now });
  const manifest = await client.waitForVersion(name, "1.2.0", { intervalMs: 10_000, onWait: wait => waits.push(wait) });
  assert.deepEqual(manifest, attested);
  assert.deepEqual(registry.sleeps, [10_000, 10_000]);
  assert.deepEqual(waits.map(({ waited }) => waited), [0, 10_000]);
  assert.equal(registry.requests.length, 3);
});

test("a version that never appears gives up after the timeout", async () => {
  const registry = fakeRegistry([404]);
  const client = registryClient({ kind: "npm", fetch: registry.fetch, sleep: registry.sleep, now: registry.now });
  assert.equal(await client.waitForVersion(name, "1.2.0", { timeoutMs: 30_000, intervalMs: 10_000 }), null);
  assert.deepEqual(registry.sleeps, [10_000, 10_000, 10_000]);
  const [issue] = await verifyPublication({
    clients: [registryClient({ kind: "npm", fetch: fakeRegistry([404]).fetch, sleep: async () => {}, now: (() => { let t = 0; return () => (t += 60_000); })() })],
    name, version: "1.2.0", integrity, wait: { timeoutMs: 60_000 },
  });
  assert.equal(issue, "https://registry.npmjs.org/@maxvyshniakov%2fexample does not serve 1.2.0");
});

test("a served tarball whose integrity is not the published archive's refuses the tag", async () => {
  const other = { ...attested, dist: { ...attested.dist, integrity: tarballIntegrity(Buffer.from("another archive")) } };
  const issues = await verifyPublication({ clients: [registryClient({ kind: "npm", fetch: fakeRegistry([other]).fetch })], name, version: "1.2.0", integrity });
  assert.equal(issues.length, 1);
  assert.match(issues[0], /serves 1\.2\.0 with integrity sha512-.*, not the published tarball's sha512-/);
  assert.deepEqual(await verifyPublication({ clients: [registryClient({ kind: "npm", fetch: fakeRegistry([attested]).fetch })], name, version: "1.2.0", integrity }), []);
});

test("from a public repository, npmjs.org must hold a provenance attestation for the version", async () => {
  const unattested = { ...attested, dist: { integrity, tarball: attested.dist.tarball } };
  const npm = (manifest) => [registryClient({ kind: "npm", fetch: fakeRegistry([manifest]).fetch })];
  const required = kind => kind === "npm";
  assert.match((await verifyPublication({ clients: npm(unattested), name, version: "1.2.0", integrity, requireAttestation: required })).join("\n"),
    /serves 1\.2\.0 without a provenance attestation \(dist\.attestations\), though the repository is public/);
  assert.deepEqual(await verifyPublication({ clients: npm(attested), name, version: "1.2.0", integrity, requireAttestation: required }), []);
  // A private repository publishes without provenance; none is required.
  assert.deepEqual(await verifyPublication({ clients: npm(unattested), name, version: "1.2.0", integrity }), []);
  // GitHub Packages records no attestations; publish never requires one there.
  assert.deepEqual(publicationIssues({ kind: "github", name, version: "1.2.0", manifest: unattested, integrity, requireAttestation: false }), []);
});

test("without a local archive, the registries must serve the same integrity as the first", async () => {
  const github = registryClient({ kind: "github", token: "t", fetch: fakeRegistry([{ versions: { "1.2.0": attested } }]).fetch });
  const differs = { ...attested, dist: { ...attested.dist, integrity: tarballIntegrity(Buffer.from("repacked")) } };
  const npm = registryClient({ kind: "npm", fetch: fakeRegistry([differs]).fetch });
  assert.match((await verifyPublication({ clients: [github, npm], name, version: "1.2.0" })).join("\n"), /registry\.npmjs\.org.*not the published tarball's/);
});

test("--resume publishes only to the registries still missing the version", () => {
  const registries = ["github", "npm"];
  assert.deepEqual(registriesToPublish(registries, {}), ["github", "npm"]);
  assert.deepEqual(registriesToPublish(registries, { github: true, npm: false }), ["npm"]);
  assert.deepEqual(registriesToPublish(registries, { github: false, npm: true }), ["github"]);
  assert.deepEqual(registriesToPublish(registries, { github: true, npm: true }), []);
  assert.equal(resumePublication({ published: { github: true, npm: false }, tagExists: false, tagMatches: true }), "publish");
  assert.equal(resumePublication({ published: { github: true, npm: true }, tagExists: false, tagMatches: true }), "tag");
  assert.equal(resumePublication({ published: { github: true, npm: true }, tagExists: true, tagMatches: true }), "done");
  // A tag with one registry missing is not this release's finished publication.
  assert.throws(() => resumePublication({ published: { github: true, npm: false }, tagExists: true, tagMatches: true }), /do not match/);
});

test("a resumed publication uploads the bytes a registry already serves, checked against its integrity", async () => {
  const workDir = mkdtempSync(path.join(tmpdir(), "repo-kit-archive-"));
  try {
    const pkg = { name, version: "1.2.0" };
    const served = { ...attested, dist: { ...attested.dist, tarball: "https://npm.pkg.github.com/download/x.tgz" } };
    const github = fakeRegistry([{ versions: { "1.2.0": served } }, bytes]);
    const clients = { github: registryClient({ kind: "github", token: "t", fetch: github.fetch }) };
    const pack = () => assert.fail("a registry serves the version: nothing is packed");
    const archive = await quietly(() => releaseArchive({ pkg, clients, published: { github: true, npm: false }, workDir, pack }));
    assert.equal(archive.integrity, integrity);
    assert.deepEqual(readFileSync(archive.tarball), bytes);
    assert.equal(github.requests[1].url, "https://npm.pkg.github.com/download/x.tgz");

    const tampered = fakeRegistry([{ versions: { "1.2.0": served } }, Buffer.from("not it")]);
    const refused = await releaseArchive({ pkg, clients: { github: registryClient({ kind: "github", token: "t", fetch: tampered.fetch }) }, published: { github: true }, workDir, pack });
    assert.match(refused.refusal, /serves for 1\.2\.0 is sha512-.*, not its dist\.integrity sha512-/);

    // A fresh publication packs once.
    const fresh = path.join(workDir, "fresh.tgz");
    writeFileSync(fresh, bytes);
    assert.deepEqual(await releaseArchive({ pkg, clients, published: {}, workDir, pack: () => fresh }), { tarball: fresh, integrity });
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("publish tags only after every registry verified, and checks the archive as a consumer before uploading it", () => {
  const source = readFileSync(new URL("../src/publish.mjs", import.meta.url), "utf8");
  const consumer = source.indexOf("await runPackedConsumer(config, { tarballs: [archive.tarball] })");
  const npmPublish = source.indexOf('execFileSync("npm", npmPublishArguments(');
  const verify = source.indexOf("await verifyPublication({");
  const refuse = source.indexOf("if (problems.length) return fail(");
  const tag = source.indexOf('execFileSync("git", ["tag", "--annotate", tag');
  assert.ok(consumer > 0 && consumer < npmPublish, "packed-consumer checks the archive before any upload");
  assert.ok(npmPublish < verify && verify < refuse && refuse < tag, "an unverified registry returns before the tag");
  // npm runs outside the repository, so a project .npmrc cannot redirect the scope.
  assert.match(source.slice(npmPublish, npmPublish + 200), /cwd: workDir/);
});
