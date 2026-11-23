// The release gate: what `package-kit publish` requires before it publishes a
// commit. package-kit.config.mjs chooses it with one line:
//
//   release: { gate: "local" }   (the default) a local run of `package-kit release-gate`
//                                on that commit, recorded as a commit status
//   release: { gate: "ci" }      the checks workflow (publish.checks) passed on that commit
//
// `package-kit release-gate [<ref>]` (default HEAD) runs the gate in a clean
// temporary worktree of the exact commit, under one slotfather lease: a frozen
// install, `verify --release`, and `verify --browser` when the repository
// declares browser checks, with every Playwright Chromium started with software
// compositing (chromium.mjs), as on the Linux CI runner. The result goes to GitHub as the commit status "Library checks
// (local, <os>-<arch>)" (darwin-arm64: verified-tree counts it only for that platform), with a short summary that names the local log
// (.git/package-kit-gate/<sha>.log). A commit that passed is recorded in
// .git/package-kit-gate/passed and is not run again; the next run only records the
// status it could not (a commit GitHub did not have yet). --rerun runs it
// again; --no-attest records nothing on GitHub.
//
// The workflows stay. Under gate "local" they are advisory: publish does not
// wait for them, and the Storybook deploy (`package-kit ci-gate`) runs whatever
// they concluded. Under gate "ci" publish waits for the checks workflow and the
// deploy runs only after every job it needs passed.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SOFTWARE_SWITCHES, compositingStatus, defaultBrowsersPath, playwrightChromium, shadowBrowsers, softwareCompositing } from "./chromium.mjs";
import { passedRecord, trapSignals, verifyCommands, withCommitWorktree } from "./commit-check.mjs";
import { cleanEnvironment, commonGitDir, gitRunner } from "./git.mjs";
import { client as githubClient, repositoryOf } from "./github.mjs";
import { leaseSelf } from "./slotfather.mjs";
import { TOKEN_HINT, resolveToken } from "./token.mjs";
import { KIT_VERSION, bunTooOld, localBunVersion } from "./toolchain.mjs";

export { verifyCommands as gateCommands };

export const GATES = ["local", "ci"];
const CONTEXT_PREFIX = "Library checks (local";
const PLATFORM_NAMES = { darwin: "macOS", linux: "Linux", win32: "Windows" };

/** The configured gate, "local" or "ci". */
export function releaseGate(config) {
  const gate = config.release?.gate ?? "local";
  if (!GATES.includes(gate)) throw new Error(`release.gate must be "local" or "ci", got ${JSON.stringify(gate)}`);
  return gate;
}

/**
 * The gate's status context names the platform that ran it, `<os>-<arch>`, as
 * verified-tree reads it: a tree counts as verified only for that platform.
 */
export function localContext(platform = process.platform, arch = process.arch) {
  return `${CONTEXT_PREFIX}, ${platform}-${arch})`;
}

/**
 * The contexts the gate records: the platform one, then the deprecated
 * `Library checks (local, macOS)` (Linux, Windows) of package-kit 0.6.0 and older,
 * so a branch protection rule that requires the old name keeps passing. The old
 * name goes in the next batched minor release.
 */
export function localContexts(platform = process.platform, arch = process.arch) {
  const legacy = PLATFORM_NAMES[platform];
  return [localContext(platform, arch), ...(legacy ? [`${CONTEXT_PREFIX}, ${legacy})`] : [])];
}

/**
 * What publish requires before it publishes: "attestation" (a passed local
 * gate status), "workflow" (the checks workflow passed), "actions" (inside
 * Actions the calling workflow orders publication after its own check jobs) or
 * "unchecked" (publish.checks: false under gate ci, with a warning). Gate ci
 * keeps the decisions publish made before release.gate existed.
 */
export function publishGatePlan({ gate, checks, inActions }) {
  if (gate === "local") return inActions ? "actions" : "attestation";
  if (checks === false) return "unchecked";
  return inActions ? "actions" : "workflow";
}

/** The newest local gate status among a commit's statuses (newest first, as the API lists them). */
export function attestationState(statuses) {
  const status = statuses.find(({ context }) => context?.startsWith(CONTEXT_PREFIX));
  if (!status) return { state: "missing" };
  const state = { success: "passed", pending: "pending" }[status.state] ?? "failed";
  return { state, status };
}

export function attestationRefusal({ state, status }, sha) {
  const short = sha.slice(0, 7);
  const reason = {
    missing: `no local release gate attestation (${CONTEXT_PREFIX}, …)) on ${short}`,
    pending: `the local release gate on ${short} has not finished: ${status?.description ?? ""}`,
    failed: `the local release gate failed on ${short}: ${status?.description ?? status?.state}`,
  }[state];
  return [
    reason,
    `  Run it on this commit: bunx package-kit release-gate ${sha.slice(0, 12)}`,
    '  (release.gate is "local"; release: { gate: "ci" } in package-kit.config.mjs waits for the checks workflow instead. README.md#release-gate)',
  ];
}

const duration = seconds => {
  const whole = Math.round(seconds);
  return whole >= 60 ? `${Math.floor(whole / 60)}m ${whole % 60}s` : `${whole}s`;
};

/** The status description: at most 140 characters, naming the host and the local log. */
export function statusDescription({ passed, host, platform, kitVersion, seconds, log, browser }) {
  const head = `${passed ? "Passed" : "Failed"} on ${host} (${PLATFORM_NAMES[platform] ?? platform}) in ${duration(seconds)}`;
  const tail = `; log ${log}`;
  const middles = [
    `, package-kit ${kitVersion}${browser ? `, ${browser} software-GPU Chromium launches` : ""}`,
    `, package-kit ${kitVersion}`,
    "",
  ];
  for (const middle of middles) {
    const text = head + middle + tail;
    if (text.length <= 140) return text;
  }
  return `${passed ? "Passed" : "Failed"} in ${duration(seconds)}${tail}`.slice(0, 140);
}

/** Whether the Storybook deploy runs: always under gate local, after every needed job passed under gate ci. */
export function ciGateDecision({ gate, needs }) {
  const failed = Object.entries(needs ?? {}).filter(([, job]) => job?.result !== "success").map(([name]) => name);
  return { run: gate === "local" || !failed.length, failed };
}

/** `package-kit ci-gate`: PACKAGE_KIT_NEEDS is the caller's toJSON(needs); writes run=true|false to GITHUB_OUTPUT. */
export function runCiGate(config, env = process.env) {
  const gate = releaseGate(config);
  let needs;
  try {
    needs = JSON.parse(env.PACKAGE_KIT_NEEDS || "{}");
  } catch {
    console.error(`PACKAGE_KIT_NEEDS is not JSON: ${env.PACKAGE_KIT_NEEDS}`);
    return 1;
  }
  const { run, failed } = ciGateDecision({ gate, needs });
  const names = failed.join(", ");
  if (gate === "local") {
    console.log(failed.length
      ? `release.gate is "local": the checks are advisory; ${names} did not pass, and this job runs anyway.`
      : 'release.gate is "local": the checks are advisory; this job runs.');
  } else {
    console.log(run ? 'release.gate is "ci": every needed job passed; this job runs.' : `release.gate is "ci" and ${names} did not pass; this job does nothing.`);
  }
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `run=${run}\n`);
  return 0;
}

/** The local gate's state on `sha`, from GitHub's statuses. */
export async function readAttestation(repository, sha, token, fetcher = fetch) {
  return attestationState(await githubClient({ token, repository, fetch: fetcher }).statuses(sha));
}

export const PASSED_RECORD = "passed";

/**
 * Commits that passed on this machine: "<sha> <seconds>" per line; sha to seconds.
 * The record of the kit before its rename to package-kit (.git/repo-kit-gate) still counts.
 */
export const gateRecord = recordDir => passedRecord(recordDir, PASSED_RECORD, {
  legacy: [path.join("..", "repo-kit-gate", PASSED_RECORD)],
  parse: line => {
    const [sha, seconds] = line.split(" ");
    return [sha, Number(seconds) || 0];
  },
  format: (sha, seconds) => `${sha} ${Math.round(seconds)}`,
});

/**
 * Prepares Chromium with software compositing for a worktree: installs the
 * Chromium its Playwright pins (as browser.yml does), mirrors Playwright's
 * browsers directory with wrapped Chromium executables, and checks that the
 * wrapped browser composites in software. Undefined when the commit has no
 * Playwright.
 */
export async function softwareChromium({ worktree, env, step }) {
  if (!playwrightChromium(worktree, env)) return undefined;
  if (await step("playwright", "bunx", ["playwright", "install", "--no-shell", "chromium"]) !== 0) throw new Error("bunx playwright install --no-shell chromium failed");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "package-kit-gate-chromium-"));
  const mirror = path.join(dir, "ms-playwright");
  const log = path.join(dir, "launches");
  fs.writeFileSync(log, "");
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  try {
    const wrapped = shadowBrowsers(defaultBrowsersPath(env), mirror, { switches: SOFTWARE_SWITCHES, log });
    const executable = playwrightChromium(worktree, { ...env, PLAYWRIGHT_BROWSERS_PATH: mirror });
    if (!wrapped.some(({ wrapper }) => wrapper === executable)) throw new Error(`Playwright's Chromium ${executable} is not one the gate wrapped; is it installed?`);
    const status = await compositingStatus(executable);
    if (!softwareCompositing(status)) {
      throw new Error(`Chromium with ${SOFTWARE_SWITCHES.join(" ")} still composites on the GPU (gpu_compositing ${status.gpu_compositing})`);
    }
    const count = () => fs.readFileSync(log, "utf8").split("\n").filter(Boolean).length;
    const baseline = count();
    return {
      env: { PLAYWRIGHT_BROWSERS_PATH: mirror, PACKAGE_KIT_CHROMIUM_SWITCHES: SOFTWARE_SWITCHES.join(" ") },
      summary: `${path.relative(mirror, executable).split(path.sep)[0]} with ${SOFTWARE_SWITCHES.join(" ")}: gpu_compositing ${status.gpu_compositing}, rasterization ${status.rasterization}`,
      launches: () => count() - baseline,
      cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}

function parseArguments(args) {
  const known = new Set(["--no-attest", "--rerun"]);
  for (const arg of args) if (arg.startsWith("--") && !known.has(arg)) throw new Error(`release-gate: unknown option ${arg}`);
  const refs = args.filter(arg => !arg.startsWith("--"));
  if (refs.length > 1) throw new Error(`release-gate takes one commit, got ${refs.join(" ")}`);
  return { ref: refs[0] ?? "HEAD", attest: !args.includes("--no-attest"), rerun: args.includes("--rerun") };
}

/** `package-kit release-gate [<ref>] [--rerun] [--no-attest]`; resolves to the exit code. */
export async function runReleaseGate(config, args = [], deps = {}) {
  const {
    env = process.env,
    fetch: fetcher = globalThis.fetch,
    lease = leaseSelf,
    platform = process.platform,
    arch = process.arch,
    host = os.hostname().split(".")[0],
    softwareChromium: prepareChromium = softwareChromium,
    tokenSource,
    stdout = process.stdout,
    stderr = process.stderr,
  } = deps;
  const print = line => stdout.write(`${line}\n`);
  const options = parseArguments(args);
  const gitEnv = cleanEnvironment(env);
  const git = gitRunner(config.root, { env: gitEnv });
  const sha = git("rev-parse", "--verify", `${options.ref}^{commit}`);
  const short = sha.slice(0, 12);
  const gitDir = commonGitDir(config.root, gitEnv);
  const recordDir = path.join(gitDir, "package-kit-gate");
  const passedStore = gateRecord(recordDir);
  const logFile = path.join(recordDir, `${short}.log`);
  const logLabel = path.relative(path.dirname(gitDir), logFile);
  const gate = releaseGate(config);
  const [context, ...legacyContexts] = localContexts(platform, arch);
  const { token, source } = tokenSource ? { token: tokenSource() } : resolveToken(env);
  const repository = () => repositoryOf(git("remote", "get-url", "origin"));
  const github = githubClient({ token, repository, fetch: fetcher });
  const fail = lines => {
    for (const line of [lines].flat()) stderr.write(`${line}\n`);
    return 1;
  };
  if (options.attest && !token) return fail(`release-gate: GITHUB_TOKEN is not set and gh has no token; the attestation needs one with repo scope. ${TOKEN_HINT}`);
  if (gate === "ci") print(`release-gate: release.gate is "ci", so publish waits for ${config.publish.checks || "no workflow"}; this run's status is for information only.`);

  // Records `passed` as the commit's status; resolves to the exit code.
  const attest = async ({ passed, seconds, browser }) => {
    if (!options.attest) return passed ? 0 : 1;
    const description = statusDescription({ passed, host, platform, kitVersion: KIT_VERSION, seconds, log: logLabel, browser });
    const posted = await github.postStatus(sha, { state: passed ? "success" : "failure", context, description });
    if (posted.ok) {
      print(`release-gate: recorded "${context}" = ${passed ? "success" : "failure"} on ${short}: ${description}`);
      // The deprecated name, for a protection rule that still requires it; publish and verified-tree need the new one only.
      for (const legacy of legacyContexts) {
        const old = await github.postStatus(sha, { state: passed ? "success" : "failure", context: legacy, description });
        if (old.ok) print(`release-gate: also recorded the deprecated "${legacy}"`);
        else stderr.write(`release-gate: warning: the deprecated "${legacy}" was not recorded (${old.message}); a protection rule requiring it will wait\n`);
      }
      return passed ? 0 : 1;
    }
    if (posted.unknownCommit) {
      return fail(passed
        ? `release-gate: ${short} passed, but GitHub does not have it yet: push it, then run bunx package-kit release-gate ${short} to record the attestation (it will not run again).`
        : `release-gate: ${short} failed; GitHub does not have it, so nothing was recorded there.`);
    }
    return fail(`release-gate: recording the status on ${short} failed: ${posted.message}`);
  };

  if (!options.rerun && passedStore.has(sha)) {
    print(`release-gate: ${short} passed the release gate on this machine (${logLabel}); not running it again (--rerun does).`);
    if (!options.attest) return 0;
    const current = attestationState(await github.statuses(sha));
    if (current.state === "passed") {
      print(`release-gate: ${short} is already attested: ${current.status.context}: ${current.status.description}`);
      return 0;
    }
    return attest({ passed: true, seconds: passedStore.get(sha) });
  }

  const browserConfigured = Boolean(config.verify?.browser);
  if (await lease(Math.max(config.verify?.slots ?? 1, browserConfigured ? config.verify?.browserSlots ?? 1 : 0), { env, purpose: "release-gate" })) return process.exitCode;

  const tooOld = bunTooOld(localBunVersion());
  if (tooOld) return fail(`release-gate: ${tooOld}.`);
  if (token && source && source !== "GITHUB_TOKEN") print(`release-gate: GITHUB_TOKEN unset; using ${source}.`);
  if (options.attest && !(await github.hasCommit(sha))) {
    print(`release-gate: GitHub does not have ${short} yet. The gate runs; push the commit, then run it again to record the attestation.`);
  }

  fs.mkdirSync(recordDir, { recursive: true });
  const out = fs.openSync(logFile, "w");
  const say = (text, stream = stdout) => {
    stream.write(text);
    fs.writeSync(out, typeof text === "string" ? text : Buffer.from(text));
  };
  let stepEnv = { ...gitEnv, ...(token ? { GITHUB_TOKEN: token } : {}) };
  const signals = trapSignals();
  const started = Date.now();
  const results = [];
  const record = (name, ok, detail = "") => results.push({ name, ok, detail });
  const timed = async (name, run) => {
    const begun = Date.now();
    const code = await run();
    record(name, code === 0, `${((Date.now() - begun) / 1000).toFixed(1)}s${code === 0 ? "" : `, exit ${code}`}`);
    return code === 0;
  };
  let chromium;
  let launches;
  try {
    return await withCommitWorktree(config.root, sha, async worktree => {
      const step = (label, file, stepArgs, extraEnv = {}) => new Promise(resolve => {
        if (signals.stopped) return resolve(1);
        say(`\n== ${label}: ${[file, ...stepArgs].join(" ")}\n`);
        const child = spawn(file, stepArgs, { cwd: worktree, env: { ...stepEnv, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
        signals.track(child);
        child.stdout.on("data", chunk => say(chunk));
        child.stderr.on("data", chunk => say(chunk, stderr));
        child.on("error", error => {
          say(`${file}: ${error.message}\n`, stderr);
          resolve(127);
        });
        child.on("close", (code, signal) => {
          signals.track(undefined);
          resolve(code ?? 128 + os.constants.signals[signal]);
        });
      });

      say(`release-gate: ${short} (${options.ref}) in ${worktree}, package-kit ${KIT_VERSION}, log ${logFile}\n`);
      say(`release-gate: slotfather lease ${env.SLOTFATHER_LEASE ? `${env.SLOTFATHER_LEASE} (${env.SLOTFATHER_COUNT ?? "?"} slots)` : "none"}\n`);
      let ok = await timed("install", () => step("install", "bun", ["install", "--frozen-lockfile"]));
      let commands = {};
      if (ok) {
        try {
          commands = await verifyCommands(worktree);
          if (!commands.release) throw new Error(`${short} has no verify script: nothing to gate`);
          chromium = await prepareChromium({ worktree, env: stepEnv, step });
          if (chromium) {
            stepEnv = { ...stepEnv, ...chromium.env };
            say(`\nrelease-gate: Chromium for every check: ${chromium.summary}\n`);
            record("software Chromium", true, chromium.summary);
          } else {
            say("\nrelease-gate: no Playwright in this commit, so no Chromium to start with software compositing.\n");
          }
          if (commands.browser && !chromium) {
            record("software Chromium", false, "no Playwright");
            say("release-gate: verify.browser is configured, but this commit has no Playwright: the gate cannot start its Chromium with software compositing as CI did.\n", stderr);
            ok = false;
          }
        } catch (error) {
          record("software Chromium", false, error.message);
          say(`release-gate: ${error.message}\n`, stderr);
          ok = false;
        }
      }
      ok = ok && await timed("verify --release", () => step("verify --release", ...commands.release));
      if (ok && commands.browser) {
        ok = await timed("verify --browser", () => step("verify --browser", ...commands.browser));
        launches = chromium.launches();
        if (ok && launches === 0) {
          record("software Chromium launches", false, "none");
          say("release-gate: the browser checks started no Chromium through the software-compositing wrapper, so they did not run as on CI.\n", stderr);
          ok = false;
        } else if (ok) {
          record("software Chromium launches", true, `${launches} Chromium launches with ${SOFTWARE_SWITCHES.join(" ")}`);
        }
      } else if (ok) {
        say("\nrelease-gate: no verify.browser in this commit's package-kit.config.mjs and no verify:browser script; no browser checks to run.\n");
      }
      const seconds = (Date.now() - started) / 1000;
      const passed = ok && !signals.stopped;
      say(`\nrelease-gate ${short}:\n`);
      for (const { name, ok: good, detail } of results) say(`  ${good ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}\n`);
      say(`${passed ? "Passed" : signals.stopped ? `Stopped (${signals.stopped})` : "Failed"} in ${duration(seconds)}; log ${logFile}\n`);
      if (signals.stopped) return signals.exitCode();
      if (passed) passedStore.add(sha, seconds);
      return await attest({ passed, seconds, browser: launches });
    }, { prefix: "package-kit-release-gate-", env: gitEnv });
  } finally {
    signals.dispose();
    chromium?.cleanup();
    fs.closeSync(out);
  }
}
