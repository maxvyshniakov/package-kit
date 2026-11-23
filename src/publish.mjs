// Publishes the released version of the repository's package to its
// registries and tags it v<version>. Run on a clean checkout whose HEAD is
// origin/main by SHA (a branch of any name, a worktree or a detached HEAD),
// after `bun run release` was pushed. GITHUB_TOKEN (or `gh auth token`) pushes
// the tag and, for GitHub Packages, needs write:packages:
//
//   bun run release:publish               the release gate, publish, tag, notify
//   bun run release:publish -- --resume   finish a publication: the registries still missing it, the tag, its push
//
// The release gate is release.gate in repo-kit.config.mjs (release-gate.mjs):
// "local" (the default) requires a passed `repo-kit release-gate` status on the
// commit; "ci" waits for the checks workflow (publish.checks) on it.
//
// publish.registry picks the registries: "github" (the default) runs
// `bun publish` in the package, as before. "npm", or ["github", "npm"], packs
// one archive, checks it with packed-consumer, uploads those bytes to each
// registry in order (npmjs.org through `npm publish`, with GitHub Actions
// trusted publishing and, from a public repository, --provenance), and tags
// only once every registry serves the archive's integrity (and, on npmjs.org
// from a public repository, a provenance attestation).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { changelogIssues, changelogPackages } from "./check-changelogs.mjs";
import { gitRunner } from "./git.mjs";
import { client as githubClient, registryUrl, repositoryOf } from "./github.mjs";
import { notifyAll } from "./notify.mjs";
import { runPackedConsumer } from "./packed-consumer.mjs";
import { versionCommitOf } from "./packages.mjs";
import { NPM_REGISTRY, registriesOf, registryClient, tarballIntegrity, verifyPublication } from "./registry.mjs";
import { attestationRefusal, publishGatePlan, readAttestation, releaseGate } from "./release-gate.mjs";
import { compareVersions } from "./semver.mjs";
import { resolveToken } from "./token.mjs";

export { registryUrl, repositoryOf as githubRepository };

// The release commit is identified by SHA, not by the checked-out branch's
// name: a worktree or a detached HEAD at origin/main publishes the same commit
// as the shared checkout's main, which other sessions may hold or move.
export function publishBlockers({ token, dirty, head, upstream, issues, tagExists, tag, registries = ["github"], npm }) {
  const blockers = [];
  if (!token) {
    blockers.push(registries.includes("github")
      ? "GITHUB_TOKEN is not set and gh has no token; use GITHUB_TOKEN=$(gh auth token) with the write:packages scope"
      : "GITHUB_TOKEN is not set and gh has no token; the release gate, the tag push and publish.notify need it");
  }
  if (dirty) blockers.push("the working tree has uncommitted changes");
  if (head !== upstream) blockers.push(`HEAD ${head.slice(0, 12)} is not origin/main ${upstream.slice(0, 12)}; push the release commit first, or check out origin/main's SHA`);
  for (const issue of issues) blockers.push(`CHANGELOG.md: ${issue}`);
  if (tagExists) blockers.push(`${tag} already exists; this version was published (finish a partial publication with --resume)`);
  if (registries.includes("npm")) blockers.push(...npmBlockers({ registries, ...npm }));
  return blockers;
}

/** The first npm with trusted publishing (OIDC from GitHub Actions). */
export const NPM_FLOOR = "11.5.1";

/** The workflow docs/templates/release-npm.yml installs as. */
export const NPM_RELEASE_WORKFLOW = "release-npm.yml";

/**
 * What stops a publication to npmjs.org: it runs only inside GitHub Actions
 * with an OIDC token (id-token: write), with npm 11.5.1 or newer, and the
 * manifest's publishConfig.registry must not send it elsewhere. Next to
 * GitHub Packages, publishConfig.registry must be absent: bunfig.toml names
 * GitHub Packages' registry, the command line npmjs.org.
 */
export function npmBlockers({ registries = ["npm"], inActions, oidc, npmVersion, publishConfigRegistry }) {
  const blockers = [];
  if (!inActions) {
    blockers.push(`npmjs.org publishes only from GitHub Actions (trusted publishing and provenance); run the caller workflow: gh workflow run ${NPM_RELEASE_WORKFLOW} --ref main`);
  } else if (!oidc) {
    blockers.push("ACTIONS_ID_TOKEN_REQUEST_URL is not set: the publishing job needs permissions id-token: write for npm trusted publishing");
  }
  if (!npmVersion) blockers.push(`npm is not on PATH; npm ${NPM_FLOOR} or newer publishes with trusted publishing (actions/npm-publish installs it)`);
  else if (compareVersions(npmVersion, NPM_FLOOR, { lenient: true }) < 0) {
    blockers.push(`npm ${npmVersion} is older than ${NPM_FLOOR}, the first npm with trusted publishing; actions/npm-publish installs a newer one`);
  }
  const allowed = registries.includes("github") ? [undefined] : [undefined, NPM_REGISTRY, NPM_REGISTRY.slice(0, -1)];
  if (!allowed.includes(publishConfigRegistry)) {
    blockers.push(registries.includes("github")
      ? `package.json publishConfig.registry is ${publishConfigRegistry}; publishing to GitHub Packages and npmjs.org, delete it (bunfig.toml names GitHub Packages' registry)`
      : `package.json publishConfig.registry is ${publishConfigRegistry}, not ${NPM_REGISTRY}; delete it to publish to npmjs.org`);
  }
  return blockers;
}

/**
 * npm refuses provenance from a private repository, and records none for a
 * restricted package; elsewhere npmjs.org gets --provenance.
 */
export function provenanceWanted({ repositoryPublic, access }) {
  return Boolean(repositoryPublic) && access === "public";
}

/**
 * `npm publish` of the archive to npmjs.org. A scope mapped to another
 * registry (.npmrc's @scope:registry) wins over --registry, so the scope is
 * pointed at npmjs.org too, and --userconfig points at os.devNull so
 * $HOME/.npmrc cannot leak an _authToken or bypass OIDC trusted publishing.
 */
export function npmPublishArguments({ tarball, name, access = "public", provenance = false }) {
  const scope = name.startsWith("@") ? name.slice(0, name.indexOf("/")) : undefined;
  return [
    "publish", tarball,
    `--userconfig=${os.devNull}`,
    `--registry=${NPM_REGISTRY}`,
    ...(scope ? [`--${scope}:registry=${NPM_REGISTRY}`] : []),
    `--access=${access}`,
    ...(provenance ? ["--provenance"] : []),
  ];
}

function npmPublishEnvironment(env) {
  const clean = {};
  for (const [key, value] of Object.entries(env)) {
    if (/^(npm_config_|NPM_CONFIG_)/i.test(key)) continue;
    clean[key] = value;
  }
  clean.NPM_CONFIG_USERCONFIG = os.devNull;
  return clean;
}

// `bun --config <file> publish` exits 0 without publishing anything; the flag
// belongs after the subcommand. With a tarball, bun uploads that archive.
export function publishArguments(config, tarball) {
  return [...(tarball ? ["publish", tarball] : ["publish"]), ...(config ? [`--config=${config}`] : [])];
}

/**
 * What --resume still has to do: "publish", "tag" or "done". `published` is
 * whether the registry serves the version, or, per registry, { github, npm }.
 */
export function resumePublication({ published, tagExists, tagMatches }) {
  const everywhere = typeof published === "object" ? Object.values(published).every(Boolean) : Boolean(published);
  if (tagExists && (!everywhere || !tagMatches)) throw new Error("Release tag and registry do not match this release");
  return tagExists ? "done" : everywhere ? "tag" : "publish";
}

/** The registries still missing the version, in publish order. */
export function registriesToPublish(registries, published = {}) {
  return registries.filter(registry => !published[registry]);
}

// With "Block command line pushes that expose my email" on, GitHub declines
// (GH007) an annotated tag whose tagger is an address the account keeps
// private. The tag takes git's own identity unless RELEASE_TAGGER_EMAIL names
// another address; git config stays as is.
export function tagEnvironment(env) {
  return env.RELEASE_TAGGER_EMAIL ? { ...env, GIT_COMMITTER_EMAIL: env.RELEASE_TAGGER_EMAIL } : env;
}

export function noreplyEmail({ id, login }) {
  return `${id}+${login}@users.noreply.github.com`;
}

// The package is already published when the tag push fails, so the script
// cannot simply be run again.
export function tagPushRecovery(tag, message, email) {
  return [
    `git tag --delete ${tag}`,
    `GIT_COMMITTER_EMAIL=${email} git tag --annotate ${tag} --message "${message}"`,
    `git push origin ${tag}`,
  ];
}

/**
 * The commit that introduced the current version into the package's
 * manifest: the release commit, even when later commits touched the file
 * (a root package's dependencies or scripts).
 */
export function releaseCommitOf(git, pkg) {
  return typeof pkg.versionCommit === "function" ? pkg.versionCommit(git) : versionCommitOf(git, pkg);
}

// The browser and story checks run in the checks workflow, not in the pre-push
// hook, so a release waits for that workflow on its commit. The API lists the
// newest run first; a rerun updates that run in place.
export function checksState(runs) {
  const [latest] = runs;
  if (!latest) return "missing";
  if (latest.status !== "completed") return "running";
  return latest.conclusion === "success" ? "passed" : "failed";
}

async function waitForChecks(github, workflow, sha) {
  const started = Date.now();
  for (;;) {
    const runs = await github.workflowRuns(workflow, sha);
    const state = checksState(runs);
    const waited = Date.now() - started;
    // A push starts the run within seconds; a run lasts well under an hour.
    if (state === "passed" || state === "failed" || (state === "missing" && waited > 5 * 60_000) || waited > 60 * 60_000) {
      return { state, url: runs[0]?.html_url };
    }
    console.log(`${workflow} on ${sha.slice(0, 7)}: ${state}; checking again in 30 s.`);
    await new Promise(resolve => setTimeout(resolve, 30_000));
  }
}

export async function runPublish(config, { resume = false, fetch: fetcher = globalThis.fetch, sleep, now, env = process.env } = {}) {
  const { root } = config;
  const workflow = config.publish.checks;
  const registries = registriesOf(config.publish.registry);
  const { access } = config.publish;
  // GitHub Packages alone keeps `bun publish` in the package directory.
  const packOnce = registries.includes("npm");
  const git = gitRunner(root);
  const fail = (lines) => {
    for (const line of lines) console.error(line);
    return 1;
  };
  const { quickStart } = config.changelog;
  const [pkg, ...others] = changelogPackages(root, { quickStart });
  if (!pkg || others.length) return fail(["Not publishing: expected exactly one released package (the root package or one under packages/)."]);
  const tag = `v${pkg.version}`;
  const gate = releaseGate(config);
  const { token, source } = resolveToken();
  if (token && source !== "GITHUB_TOKEN") console.log(`GITHUB_TOKEN unset; publishing with ${source}.`);
  git("fetch", "--quiet", "--tags", "origin", "main");
  const head = git("rev-parse", "HEAD");
  const tagExists = Boolean(git("tag", "--list", tag));
  const blockers = publishBlockers({
    token,
    dirty: Boolean(git("status", "--porcelain")),
    head,
    upstream: git("rev-parse", "origin/main"),
    issues: changelogIssues(pkg, { release: true, quickStart: config.changelog.quickStart }),
    tagExists: tagExists && !resume,
    tag,
    registries,
    npm: {
      inActions: Boolean(env.GITHUB_ACTIONS),
      oidc: Boolean(env.ACTIONS_ID_TOKEN_REQUEST_URL),
      npmVersion: registries.includes("npm") ? installedNpm() : undefined,
      publishConfigRegistry: pkg.manifest.publishConfig?.registry,
    },
  });
  if (blockers.length) return fail([`Not publishing ${pkg.name}@${pkg.version}:`, ...blockers.map(blocker => `  ${blocker}`)]);

  const github = githubClient({
    token,
    repository: () => repositoryOf(git("remote", "get-url", "origin")),
    fetch: fetcher,
  });

  const clients = Object.fromEntries(registries.map(kind => [kind, registryClient({
    kind,
    token: kind === "github" ? token : env.NPM_TOKEN,
    fetch: fetcher,
    ...(sleep ? { sleep } : {}),
    ...(now ? { now } : {}),
  })]));
  const published = {};
  let action = "publish";
  if (resume) {
    const taggedCommit = tagExists ? git("rev-list", "-n", "1", tag) : undefined;
    const releaseCommit = releaseCommitOf(git, pkg);
    for (const kind of registries) published[kind] = await clients[kind].hasVersion(pkg.name, pkg.version);
    action = resumePublication({
      published,
      tagExists,
      tagMatches: !tagExists || (git("merge-base", taggedCommit, "HEAD") === taggedCommit
        && git("merge-base", releaseCommit, taggedCommit) === releaseCommit),
    });
  }
  // An annotated tag's tagger is git's committer identity. Resolve it before
  // publishing, so a missing identity leaves nothing half done.
  const tagEnv = tagEnvironment(env);
  const tagger = /<([^>]*)>/.exec(execFileSync("git", ["var", "GIT_COMMITTER_IDENT"], { cwd: root, encoding: "utf8", env: tagEnv }))[1];
  const message = `${pkg.name} ${pkg.version}`;
  // The package is published by the time the tag is pushed: a declined push
  // prints the recovery, and the follow-up workflows run only after the tag is out.
  const pushTag = async () => {
    try {
      git("push", "origin", tag);
    } catch {
      const user = await github.user().catch(() => null);
      return fail([
        `Published ${pkg.name}@${pkg.version}, but pushing ${tag} (tagger ${tagger}) failed.`,
        "If GitHub declined it for email privacy (GH007), tag it as the account's noreply address:",
        ...tagPushRecovery(tag, message, user ? noreplyEmail(user) : "<id>+<login>@users.noreply.github.com").map(line => `  ${line}`),
        ...(config.publish.notify.length ? ["Then request the follow-up workflows: bun run repo-kit notify"] : []),
      ]);
    }
    console.log(`Published ${pkg.name}@${pkg.version} to ${registries.map(kind => clients[kind].url).join(" and ")} and pushed ${tag}, tagged as ${tagger}.`);
    // A failed request only warns; each target's own schedule is the fallback.
    await notifyAll(config.publish.notify, token);
    return 0;
  };
  if (action === "done") {
    if (git("ls-remote", "--tags", "origin", `refs/tags/${tag}`)) {
      console.log(`${pkg.name}@${pkg.version} is already published and tagged.`);
      return 0;
    }
    // A local retry can have a tag whose first push failed.
    return pushTag();
  }
  // In Actions, a publication inside the checks workflow runs after its check
  // jobs; waiting for that run to finish would never end. Under either gate the
  // calling workflow's own jobs gate it (Data Grid's automated catalog release).
  // publish.checks: false is for a repository whose checks cannot run yet (no
  // runner); under gate ci its pre-push gate is then the only gate, and publish
  // says so.
  const plan = action === "publish" ? publishGatePlan({ gate, checks: workflow, inActions: Boolean(env.GITHUB_ACTIONS) }) : "none";
  if (plan === "attestation") {
    const attestation = await readAttestation(repositoryOf(git("remote", "get-url", "origin")), head, token, fetcher);
    if (attestation.state !== "passed") return fail([`Not publishing ${pkg.name}@${pkg.version}: ${attestationRefusal(attestation, head)[0]}`, ...attestationRefusal(attestation, head).slice(1)]);
    console.log(`${attestation.status.context} passed on ${head.slice(0, 7)}: ${attestation.status.description}`);
  } else if (plan === "actions" && gate === "local") {
    console.log(`Inside GitHub Actions: the calling workflow's jobs gate ${head.slice(0, 7)}; release.gate "local" applies to publications from a machine.`);
  } else if (plan === "unchecked") {
    console.warn(`publish.checks is false: publishing ${head.slice(0, 7)} without waiting for a checks workflow; the pre-push gate was the only gate.`);
  } else if (plan === "workflow") {
    const checks = await waitForChecks(github, workflow, head);
    if (checks.state !== "passed") {
      return fail([
        `Not publishing ${pkg.name}@${pkg.version}: ${workflow} ${checks.state} on ${head.slice(0, 7)}${checks.url ? ` (${checks.url})` : ""}.`,
        ...(checks.state === "missing" ? [`  Start them with: gh workflow run ${workflow} --ref main`] : []),
      ]);
    }
    console.log(`${workflow} passed on ${head.slice(0, 7)}: ${checks.url}`);
  }
  const bunfig = path.join(root, "bunfig.toml");
  let integrity;
  let provenance = false;
  if (registries.includes("npm")) {
    const visibility = await github.repositoryInfo().then(info => info.visibility ?? (info.private ? "private" : "public"));
    provenance = provenanceWanted({ repositoryPublic: visibility === "public", access });
    if (!provenance) console.log(`No --provenance: ${visibility === "public" ? `publish.access is ${access}` : `the repository is ${visibility}`}; npm records provenance only for a public package from a public repository.`);
  }
  if (action === "publish" && !packOnce) {
    // prepack builds dist; the root bunfig.toml supplies the registry and token.
    execFileSync("bun", publishArguments(fs.existsSync(bunfig) ? bunfig : undefined), { cwd: pkg.dir, stdio: "inherit", env: { ...process.env, GITHUB_TOKEN: token } });
  } else if (action === "publish") {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "repo-kit-publish-"));
    try {
      const archive = await releaseArchive({ pkg, clients, published, workDir });
      if (archive.refusal) return fail([`Not publishing ${pkg.name}@${pkg.version}: ${archive.refusal}`]);
      integrity = archive.integrity;
      console.log(`Archive ${path.basename(archive.tarball)} (${integrity}); checking it as a consumer installs it.`);
      if (!(await runPackedConsumer(config, { tarballs: [archive.tarball] }))) {
        return fail([`Not publishing ${pkg.name}@${pkg.version}: the packed-consumer check of ${path.basename(archive.tarball)} failed.`]);
      }
      for (const kind of registriesToPublish(registries, published)) {
        if (kind === "github") {
          execFileSync("bun", publishArguments(fs.existsSync(bunfig) ? bunfig : undefined, archive.tarball), { cwd: pkg.dir, stdio: "inherit", env: { ...process.env, GITHUB_TOKEN: token } });
        } else {
          // Outside the repository with isolated userconfig/env, so neither repo nor $HOME/.npmrc can bypass OIDC.
          execFileSync("npm", npmPublishArguments({ tarball: archive.tarball, name: pkg.name, access, provenance }), { cwd: workDir, stdio: "inherit", env: npmPublishEnvironment(env) });
        }
      }
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }
  const problems = await verifyPublication({
    clients: registries.map(kind => clients[kind]),
    name: pkg.name,
    version: pkg.version,
    integrity,
    requireAttestation: kind => kind === "npm" && provenance,
    wait: { onWait: ({ intervalMs }) => console.log(`Waiting for the registries to serve ${pkg.name}@${pkg.version}; checking again in ${intervalMs / 1000} s.`) },
  });
  if (problems.length) return fail([`Not tagging ${tag}:`, ...problems.map(problem => `  ${problem}`)]);
  execFileSync("git", ["tag", "--annotate", tag, "--message", message], { cwd: root, env: tagEnv });
  return pushTag();
}

function installedNpm() {
  try {
    return execFileSync("npm", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

/**
 * The one archive every registry gets. When --resume finds a registry that
 * already serves the version, its tarball (checked against its own
 * dist.integrity), so every registry serves the same bytes; otherwise
 * `bun pm pack`, which runs prepack and resolves workspace: and catalog: ranges.
 */
export async function releaseArchive({ pkg, clients, published = {}, workDir, pack = packArchive }) {
  const source = Object.keys(published).find(kind => published[kind]);
  if (!source) {
    const tarball = pack(pkg, workDir);
    return { tarball, integrity: tarballIntegrity(fs.readFileSync(tarball)) };
  }
  const manifest = await clients[source].manifest(pkg.name, pkg.version);
  if (!manifest?.dist?.tarball) return { refusal: `${clients[source].url} lists ${pkg.version} without a tarball` };
  const bytes = await clients[source].tarball(manifest.dist.tarball);
  const integrity = tarballIntegrity(bytes);
  if (!manifest.dist.integrity || manifest.dist.integrity !== integrity) {
    return { refusal: `the tarball ${clients[source].url} serves for ${pkg.version} is ${integrity}, not its dist.integrity ${manifest.dist.integrity ?? "(missing)"}` };
  }
  const tarball = path.join(workDir, `${pkg.name.replace("@", "").replace("/", "-")}-${pkg.version}.tgz`);
  fs.writeFileSync(tarball, bytes);
  console.log(`${clients[source].url} already serves ${pkg.version}; publishing its tarball to the others.`);
  return { tarball, integrity };
}

function packArchive(pkg, workDir) {
  const tarball = execFileSync("bun", ["pm", "pack", "--quiet", "--destination", workDir], { cwd: pkg.dir, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim().split("\n").at(-1);
  if (!fs.existsSync(tarball)) throw new Error(`bun pm pack did not produce ${tarball}`);
  return tarball;
}
