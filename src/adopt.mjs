// repo-kit adopt: pick the newest compatible set of @maxvyshniakov/* packages
// for a consumer repository, respecting peerDependencies and registry metadata.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { client as githubClient } from "./github.mjs";
import { archiveSlug } from "./packages.mjs";
import { compareVersions, isStableVersion, satisfiesRange } from "./semver.mjs";
import { resolveToken, TOKEN_HINT } from "./token.mjs";

export const EXIT_UPDATES_AVAILABLE = 10;

const DEFAULT_SCOPE = "@maxvyshniakov/";
const DEP_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies"];
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  "vendor",
  ".turbo",
  ".next",
  ".cache",
  ".claude",
]);

const ADOPT_USAGE = `Usage: repo-kit adopt [--json] [--apply] [--only <names>]

Pick the newest compatible set of @maxvyshniakov/* packages for this consumer.

Options:
  --json           print the plan as JSON
  --apply          update registry pins (bun add --exact) and vendored archives, then bun install
  --only <names>   limit to comma-separated package names (scoped or bare; repeatable)
  --help           show this message

Exit codes (without --apply):
  0   up to date (or no matching packages)
  10  a newer compatible set exists
  1   lookup or configuration error (warns, changes nothing)`;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizePackageName(name, scope = DEFAULT_SCOPE) {
  const trimmed = name.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("@")) return trimmed;
  return `${scope}${trimmed}`;
}

function normalizeHoldMap(hold = {}, scope = DEFAULT_SCOPE) {
  const result = {};
  for (const [name, reason] of Object.entries(hold ?? {})) {
    const normalized = normalizePackageName(name, scope);
    if (!normalized) continue;
    result[normalized] = typeof reason === "string" && reason.trim() ? reason.trim() : "held";
  }
  return result;
}

export function parseAdoptArgs(args = []) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      json: { type: "boolean", default: false },
      apply: { type: "boolean", default: false },
      only: { type: "string", multiple: true },
      help: { type: "boolean", default: false },
    },
  });
  if (positionals.length) {
    throw new Error(`adopt: unexpected argument ${positionals.join(" ")}`);
  }
  const only = (values.only ?? [])
    .flatMap(entry => entry.split(","))
    .map(entry => entry.trim())
    .filter(Boolean);
  return {
    json: values.json,
    apply: values.apply,
    only,
    help: values.help,
  };
}

function walkManifestFiles(root) {
  const found = [];
  const visit = dir => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        visit(path.join(dir, entry.name));
      } else if (entry.isFile() && entry.name === "package.json") {
        found.push(path.relative(root, path.join(dir, entry.name)).split(path.sep).join("/"));
      }
    }
  };
  visit(root);
  return found.sort();
}

function parsePinSpec(name, spec) {
  if (typeof spec !== "string") return null;
  if (/^(workspace|link|portal):/.test(spec)) return null;

  if (spec.startsWith("file:") && spec.endsWith(".tgz")) {
    const slug = archiveSlug(name);
    const slugPattern = slug
      ? new RegExp(`${escapeRegExp(slug)}-(\\d+\\.\\d+\\.\\d+)(?:-([0-9a-f]{12}))?\\.tgz$`)
      : null;
    const match = slugPattern?.exec(spec) ?? /-(\d+\.\d+\.\d+)(?:-([0-9a-f]{12}))?\.tgz$/.exec(spec);
    if (!match) return { kind: "unknown", spec, version: null };
    return {
      kind: "vendored",
      spec,
      version: match[1],
      sha12: match[2] ?? null,
    };
  }

  const registryMatch = /^(?:\^|~|=)?(\d+\.\d+\.\d+)$/.exec(spec.trim());
  if (registryMatch) {
    return {
      kind: "registry",
      spec,
      version: registryMatch[1],
    };
  }

  return { kind: "unknown", spec, version: null };
}

/**
 * Discovers `@maxvyshniakov/*` pins across the consumer's `package.json` files
 * (both registry pins and `file:.../*.tgz` vendored archives).
 */
export function discoverConsumerPins(root, { scope = DEFAULT_SCOPE, packages, only, manifests } = {}) {
  const manifestPaths = manifests?.length
    ? manifests.map(file => file.split(path.sep).join("/"))
    : walkManifestFiles(root);

  const loaded = [];
  const localNames = new Set();
  for (const relative of manifestPaths) {
    const full = path.join(root, relative);
    if (!fs.existsSync(full)) continue;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(full, "utf8"));
    } catch (error) {
      throw new Error(`${relative} is not valid JSON: ${error.message}`);
    }
    if (typeof parsed.name === "string" && parsed.name) localNames.add(parsed.name);
    loaded.push({ relative, full, manifest: parsed });
  }

  const configuredSet = packages?.length
    ? new Set(packages.map(name => normalizePackageName(name, scope)).filter(Boolean))
    : null;
  const onlySet = only?.length
    ? new Set(only.map(name => normalizePackageName(name, scope)).filter(Boolean))
    : null;

  const byName = new Map();
  const warnings = [];

  for (const { relative, manifest } of loaded) {
    for (const section of DEP_SECTIONS) {
      const deps = manifest[section];
      if (!deps || typeof deps !== "object") continue;
      for (const [name, spec] of Object.entries(deps)) {
        if (!name.startsWith(scope)) continue;
        if (localNames.has(name)) continue;
        if (configuredSet && !configuredSet.has(name)) continue;
        if (onlySet && !onlySet.has(name)) continue;

        const parsed = parsePinSpec(name, spec);
        if (!parsed) continue;
        if (parsed.kind === "unknown") {
          warnings.push(`${relative} pins ${name} as ${JSON.stringify(spec)}, which adopt cannot parse`);
          continue;
        }
        if (!byName.has(name)) byName.set(name, []);
        byName.get(name).push({
          manifest: relative,
          section,
          kind: parsed.kind,
          spec: parsed.spec,
          version: parsed.version,
          sha12: parsed.sha12 ?? null,
        });
      }
    }
  }

  const result = [...byName.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, pins]) => {
      const sortedVersions = [...new Set(pins.map(pin => pin.version))].sort(compareVersions);
      return {
        name,
        current: sortedVersions[0],
        pins,
      };
    });

  return { packages: result, warnings };
}

function stableVersionsNewestFirst(metadata) {
  const versions = Object.keys(metadata?.versions ?? {}).filter(isStableVersion);
  return versions.sort((a, b) => compareVersions(b, a));
}

function peerDependenciesOf(metadata, version) {
  const peers = metadata?.versions?.[version]?.peerDependencies;
  return peers && typeof peers === "object" ? peers : {};
}

function topologicalOrder(names, metadataByName) {
  const nameSet = new Set(names);
  // Edge: dependent -> peer (dependents are assigned first so they pick their newest version
  // and constrain their peers, matching ui-libs.py's newest-Data-Grid-first policy).
  const inDegree = new Map(names.map(name => [name, 0]));
  const edges = new Map(names.map(name => [name, new Set()]));

  for (const name of names) {
    const metadata = metadataByName[name];
    const versions = stableVersionsNewestFirst(metadata);
    const sample = versions[0];
    if (!sample) continue;
    for (const peerName of Object.keys(peerDependenciesOf(metadata, sample))) {
      if (peerName !== name && nameSet.has(peerName) && !edges.get(name).has(peerName)) {
        edges.get(name).add(peerName);
        inDegree.set(peerName, inDegree.get(peerName) + 1);
      }
    }
  }

  const queue = names.filter(name => inDegree.get(name) === 0).sort();
  const ordered = [];
  while (queue.length) {
    const current = queue.shift();
    ordered.push(current);
    for (const peerName of [...edges.get(current)].sort()) {
      inDegree.set(peerName, inDegree.get(peerName) - 1);
      if (inDegree.get(peerName) === 0) {
        queue.push(peerName);
        queue.sort();
      }
    }
  }
  for (const name of names) {
    if (!ordered.includes(name)) ordered.push(name);
  }
  return ordered;
}

/**
 * Picks the newest stable set of versions where every intra-set peerDependency
 * range is satisfied, respecting held packages and never downgrading below current.
 */
export function chooseCompatibleSet({ packages, metadataByName, hold = {}, scope = DEFAULT_SCOPE }) {
  const holdMap = normalizeHoldMap(hold, scope);
  const byName = new Map(packages.map(pkg => [pkg.name, pkg]));
  const names = packages.map(pkg => pkg.name);
  const nameSet = new Set(names);

  const latestByName = {};
  const candidatesByName = {};
  const warnings = [];

  for (const pkg of packages) {
    const metadata = metadataByName[pkg.name];
    const published = stableVersionsNewestFirst(metadata);
    latestByName[pkg.name] = published[0] ?? null;

    if (holdMap[pkg.name]) {
      candidatesByName[pkg.name] = [pkg.current];
      continue;
    }

    if (!published.length) {
      throw new Error(`no stable version of ${pkg.name} is published`);
    }

    const notOlder = published.filter(ver => compareVersions(ver, pkg.current) >= 0);
    if (!notOlder.length) {
      warnings.push(
        `${pkg.name} published ${published[0]} is older than pinned ${pkg.current}; keeping ${pkg.current}`,
      );
      candidatesByName[pkg.name] = [pkg.current];
    } else {
      candidatesByName[pkg.name] = notOlder;
    }
  }

  // Validate all relevant peer ranges up front so malformed ranges produce a clear error.
  for (const name of names) {
    for (const version of candidatesByName[name]) {
      const peers = peerDependenciesOf(metadataByName[name], version);
      for (const [peerName, peerRange] of Object.entries(peers)) {
        if (!nameSet.has(peerName)) continue;
        try {
          satisfiesRange(peerRange, candidatesByName[peerName][0]);
        } catch {
          throw new Error(`${name}@${version} peer range ${peerName} ${JSON.stringify(peerRange)} is not readable`);
        }
      }
    }
  }

  const order = topologicalOrder(names, metadataByName);
  const assigned = new Map();

  function compatibleWithAssigned(name, version) {
    const peers = peerDependenciesOf(metadataByName[name], version);
    for (const [otherName, otherVersion] of assigned.entries()) {
      if (peers[otherName] && !satisfiesRange(peers[otherName], otherVersion)) return false;
      const otherPeers = peerDependenciesOf(metadataByName[otherName], otherVersion);
      if (otherPeers[name] && !satisfiesRange(otherPeers[name], version)) return false;
    }
    return true;
  }

  function search(index) {
    if (index === order.length) return true;
    const name = order[index];
    for (const version of candidatesByName[name]) {
      if (!compatibleWithAssigned(name, version)) continue;
      assigned.set(name, version);
      if (search(index + 1)) return true;
      assigned.delete(name);
    }
    return false;
  }

  if (!search(0)) {
    throw new Error(`no compatible version set satisfies peerDependencies for ${names.join(", ")}`);
  }

  const chosen = Object.fromEntries(names.map(name => [name, assigned.get(name)]));
  const waiting = [];
  const held = [];

  for (const name of names) {
    const pkg = byName.get(name);
    if (holdMap[name]) {
      held.push({ name, version: chosen[name], latest: latestByName[name], reason: holdMap[name] });
      continue;
    }
    const latest = latestByName[name];
    if (latest && compareVersions(latest, chosen[name]) > 0) {
      let blocker = null;
      // 1. Another chosen package's peerDependency rejects `latest`.
      for (const otherName of names) {
        if (otherName === name) continue;
        const otherPeers = peerDependenciesOf(metadataByName[otherName], chosen[otherName]);
        if (otherPeers[name] && !satisfiesRange(otherPeers[name], latest)) {
          blocker = {
            blockedBy: otherName,
            blockedByVersion: chosen[otherName],
            peerRange: otherPeers[name],
            reason: `${otherName}@${chosen[otherName]} requires ${name} ${otherPeers[name]}`,
          };
          break;
        }
      }
      // 2. `latest`'s own peerDependency rejects another chosen package.
      if (!blocker) {
        const latestPeers = peerDependenciesOf(metadataByName[name], latest);
        for (const [peerName, peerRange] of Object.entries(latestPeers)) {
          if (!nameSet.has(peerName)) continue;
          if (!satisfiesRange(peerRange, chosen[peerName])) {
            const heldSuffix = holdMap[peerName] ? `, held: ${holdMap[peerName]}` : "";
            blocker = {
              blockedBy: peerName,
              blockedByVersion: chosen[peerName],
              peerRange,
              reason: `${name}@${latest} requires ${peerName} ${peerRange} (chosen ${chosen[peerName]}${heldSuffix})`,
            };
            break;
          }
        }
      }
      waiting.push({
        name,
        latest,
        chosen: chosen[name],
        ...(blocker ?? {
          blockedBy: null,
          blockedByVersion: null,
          peerRange: null,
          reason: `incompatible with selected package set`,
        }),
      });
    }
  }

  return { chosen, latestByName, waiting, held, warnings };
}

function defaultRegistry({ token, fetch }) {
  const resolved = token ?? resolveToken().token;
  if (!resolved) {
    throw new Error(`GITHUB_TOKEN is required to read GitHub Packages metadata (${TOKEN_HINT})`);
  }
  return githubClient({ token: resolved, fetch });
}

/**
 * Inspects a consumer repository and produces an adoption plan without modifying files.
 */
export async function planAdopt({ root, config = {}, args = [], registry, token, fetch } = {}) {
  const parsedArgs = Array.isArray(args) ? parseAdoptArgs(args) : args;
  const adoptConfig = config.adopt ?? {};
  const scope = adoptConfig.scope ?? DEFAULT_SCOPE;

  const { packages, warnings: discoveryWarnings } = discoverConsumerPins(root, {
    scope,
    packages: adoptConfig.packages,
    only: parsedArgs.only,
    manifests: adoptConfig.manifests,
  });

  if (!packages.length) {
    return {
      ok: true,
      status: "up-to-date",
      packages: [],
      updates: [],
      waiting: [],
      held: [],
      warnings: discoveryWarnings,
      metadataByName: {},
    };
  }

  const client = registry ?? defaultRegistry({ token, fetch });
  const metadataByName = {};
  for (const pkg of packages) {
    metadataByName[pkg.name] = await client.registryMetadata(pkg.name);
  }

  const solved = chooseCompatibleSet({
    packages,
    metadataByName,
    hold: adoptConfig.hold ?? {},
    scope,
  });

  const holdMap = normalizeHoldMap(adoptConfig.hold ?? {}, scope);
  const planPackages = packages.map(pkg => {
    const target = solved.chosen[pkg.name];
    const changed = pkg.pins.some(pin => pin.version !== target);
    return {
      name: pkg.name,
      current: pkg.current,
      target,
      latest: solved.latestByName[pkg.name],
      changed,
      held: Boolean(holdMap[pkg.name]),
      holdReason: holdMap[pkg.name] ?? null,
      pins: pkg.pins,
    };
  });

  const updates = planPackages
    .filter(pkg => pkg.changed)
    .map(pkg => ({ name: pkg.name, from: pkg.current, to: pkg.target }));

  return {
    ok: true,
    status: updates.length ? "updates-available" : "up-to-date",
    packages: planPackages,
    updates,
    waiting: solved.waiting,
    held: solved.held,
    warnings: [...discoveryWarnings, ...solved.warnings],
    metadataByName,
  };
}

function verifyTarballIntegrity(bytes, dist, name, version) {
  if (!dist) return;
  if (typeof dist.integrity === "string" && dist.integrity.startsWith("sha512-")) {
    const expected = dist.integrity.slice("sha512-".length);
    const actual = crypto.createHash("sha512").update(bytes).digest("base64");
    if (actual !== expected) {
      throw new Error(`integrity mismatch for ${name}@${version}: expected ${dist.integrity}`);
    }
  } else if (typeof dist.shasum === "string" && dist.shasum) {
    const actual = crypto.createHash("sha1").update(bytes).digest("hex");
    if (actual !== dist.shasum) {
      throw new Error(`shasum mismatch for ${name}@${version}: expected ${dist.shasum}, got ${actual}`);
    }
  }
}

function defaultRunBun(args, { cwd }) {
  const result = spawnSync("bun", args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`bun ${args.join(" ")} exited with status ${result.status}`);
  }
}

/**
 * Applies a computed adoption plan: updates registry pins via `bun add --exact`
 * and vendored archives by downloading tarballs into the vendor directory,
 * updating `package.json`, and running `bun install`.
 */
export async function applyAdoptPlan(plan, { root, config = {}, registry, token, fetch, runBun = defaultRunBun } = {}) {
  if (!plan.ok || !plan.updates.length) return plan;

  const adoptConfig = config.adopt ?? {};
  const changedPackages = plan.packages.filter(pkg => pkg.changed);
  const needsTarball = changedPackages.some(pkg => pkg.pins.some(pin => pin.kind === "vendored"));
  const client = needsTarball ? (registry ?? defaultRegistry({ token, fetch })) : registry;

  // 1. Download and verify all needed tarballs before mutating any files.
  const downloaded = new Map();
  for (const pkg of changedPackages) {
    if (!pkg.pins.some(pin => pin.kind === "vendored")) continue;
    const versionMeta = plan.metadataByName?.[pkg.name]?.versions?.[pkg.target];
    const tarballUrl = versionMeta?.dist?.tarball;
    if (!tarballUrl) {
      throw new Error(`registry metadata for ${pkg.name}@${pkg.target} has no dist.tarball URL`);
    }
    const bytes = await client.registryTarball(tarballUrl);
    verifyTarballIntegrity(bytes, versionMeta.dist, pkg.name, pkg.target);
    const sha12 = crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 12);
    const fileName = `${archiveSlug(pkg.name)}-${pkg.target}-${sha12}.tgz`;
    downloaded.set(pkg.name, { bytes, fileName });
  }

  // 2. Apply vendored archive updates and record directories needing `bun install`.
  const vendoredManifestDirs = new Set();
  const vendoredByManifest = new Map();
  for (const pkg of changedPackages) {
    for (const pin of pkg.pins) {
      if (pin.kind !== "vendored" || pin.version === pkg.target) continue;
      if (!vendoredByManifest.has(pin.manifest)) vendoredByManifest.set(pin.manifest, []);
      vendoredByManifest.get(pin.manifest).push({ pkg, pin });
    }
  }

  for (const [manifestRel, items] of vendoredByManifest.entries()) {
    const manifestFull = path.join(root, manifestRel);
    const manifestDir = path.dirname(manifestFull);
    const manifest = JSON.parse(fs.readFileSync(manifestFull, "utf8"));

    for (const { pkg, pin } of items) {
      const { bytes, fileName } = downloaded.get(pkg.name);
      const oldRelPath = pin.spec.slice("file:".length);
      const oldFullPath = path.resolve(manifestDir, oldRelPath);
      const vendorDir = adoptConfig.vendorDir
        ? path.resolve(root, adoptConfig.vendorDir)
        : path.dirname(oldFullPath);

      fs.mkdirSync(vendorDir, { recursive: true });
      const newFullPath = path.join(vendorDir, fileName);
      fs.writeFileSync(newFullPath, bytes);

      if (oldFullPath !== newFullPath && fs.existsSync(oldFullPath)) {
        fs.rmSync(oldFullPath, { force: true });
      }

      const relToManifest = path.relative(manifestDir, newFullPath).split(path.sep).join("/");
      const prefix = oldRelPath.startsWith("./") && !relToManifest.startsWith(".") ? "./" : "";
      manifest[pin.section][pkg.name] = `file:${prefix}${relToManifest}`;
    }

    fs.writeFileSync(manifestFull, `${JSON.stringify(manifest, null, 2)}\n`);
    vendoredManifestDirs.add(manifestDir);
  }

  for (const dir of vendoredManifestDirs) {
    runBun(["install"], { cwd: dir });
  }

  // 3. Apply registry pin updates via `bun add --exact`.
  const registryGroups = new Map();
  for (const pkg of changedPackages) {
    for (const pin of pkg.pins) {
      if (pin.kind !== "registry" || pin.version === pkg.target) continue;
      const manifestDir = path.dirname(path.join(root, pin.manifest));
      const key = `${manifestDir}\0${pin.section}`;
      if (!registryGroups.has(key)) registryGroups.set(key, { cwd: manifestDir, section: pin.section, specs: [] });
      registryGroups.get(key).specs.push(`${pkg.name}@${pkg.target}`);
    }
  }

  for (const group of registryGroups.values()) {
    const flags = ["add", "--exact"];
    if (group.section === "devDependencies") flags.push("--dev");
    else if (group.section === "optionalDependencies") flags.push("--optional");
    runBun([...flags, ...group.specs], { cwd: group.cwd });
  }

  return { ...plan, status: "applied" };
}

export function formatAdoptLine(plan) {
  if (!plan.ok) {
    return `adopt: warning: ${plan.error}; changed nothing`;
  }
  if (!plan.packages.length) {
    return "adopt: no matching packages found";
  }

  const parts = [];
  if (plan.status === "applied") {
    parts.push(`adopt: applied ${plan.updates.map(u => `${u.name} ${u.from} -> ${u.to}`).join(", ")}`);
  } else if (plan.updates.length) {
    parts.push(`adopt: updates available: ${plan.updates.map(u => `${u.name} ${u.from} -> ${u.to}`).join(", ")}`);
  } else {
    parts.push(`adopt: up to date (${plan.packages.map(p => `${p.name} ${p.current}`).join(", ")})`);
  }

  if (plan.waiting.length) {
    parts.push(`waiting: ${plan.waiting.map(w => `${w.name} ${w.latest} (${w.reason})`).join(", ")}`);
  }
  if (plan.held.length) {
    parts.push(`held: ${plan.held.map(h => `${h.name} ${h.version} (${h.reason})`).join(", ")}`);
  }
  return parts.join("; ");
}

function publicPlanJson(plan) {
  const { metadataByName: _ignored, ...rest } = plan;
  return rest;
}

export async function runAdopt({
  root,
  config = {},
  args = [],
  registry,
  token,
  fetch,
  runBun,
  stdout = line => console.log(line),
  stderr = line => console.error(line),
} = {}) {
  const parsedArgs = parseAdoptArgs(args);
  if (parsedArgs.help) {
    stdout(ADOPT_USAGE);
    return 0;
  }

  try {
    let plan = await planAdopt({ root, config, args: parsedArgs, registry, token, fetch });
    if (parsedArgs.apply && plan.updates.length) {
      plan = await applyAdoptPlan(plan, { root, config, registry, token, fetch, runBun });
    }

    if (parsedArgs.json) {
      stdout(JSON.stringify(publicPlanJson(plan), null, 2));
    } else {
      for (const warning of plan.warnings) stderr(`adopt: warning: ${warning}`);
      stdout(formatAdoptLine(plan));
    }

    if (parsedArgs.apply) return 0;
    return plan.updates.length ? EXIT_UPDATES_AVAILABLE : 0;
  } catch (error) {
    const failed = {
      ok: false,
      status: "error",
      error: error.message,
      packages: [],
      updates: [],
      waiting: [],
      held: [],
      warnings: [error.message],
    };
    stderr(formatAdoptLine(failed));
    if (parsedArgs.json) stdout(JSON.stringify(failed, null, 2));
    return 1;
  }
}
