// The npm registries a package publishes to: GitHub Packages and npmjs.org.
// One adapter reads what a registry serves for a version, waits for a new
// version to propagate, and checks the served tarball against the one that
// was published. `fetch`, `sleep` and `now` are injectable, so tests poll
// without waiting.
import crypto from "node:crypto";

import { PUBLISH_REGISTRIES as REGISTRIES } from "./config.mjs";
import { authHeaders, REGISTRY_BASE, registryUrl as githubRegistryUrl } from "./github.mjs";

export { REGISTRIES };

export const NPM_REGISTRY = "https://registry.npmjs.org/";

export const REGISTRY_URLS = { github: `${REGISTRY_BASE}/`, npm: NPM_REGISTRY };

/** publish.registry as a list: "github" (the default), "npm", or both in order. */
export function registriesOf(value = "github") {
  return Array.isArray(value) ? value : [value];
}

/** What a registry serves at `name`'s packument, or `name@version`'s manifest. */
export function packageUrl(kind, name, version) {
  if (kind === "github") return githubRegistryUrl(name);
  return `${NPM_REGISTRY}${name.replace("/", "%2f")}${version ? `/${version}` : ""}`;
}

/** The `sha512-<base64>` Subresource Integrity string npm records as dist.integrity. */
export function tarballIntegrity(bytes) {
  return `sha512-${crypto.createHash("sha512").update(bytes).digest("base64")}`;
}

/**
 * Why a served version is not the publication: the manifest is missing, its
 * dist.integrity is not the local tarball's, or provenance was required and
 * the registry holds no attestation for it. Empty when it is.
 */
export function publicationIssues({ kind, name, version, manifest, integrity, requireAttestation = false }) {
  const where = `${packageUrl(kind, name)}`;
  if (!manifest) return [`${where} does not serve ${version}`];
  const issues = [];
  if (integrity && manifest.dist?.integrity !== integrity) {
    issues.push(`${where} serves ${version} with integrity ${manifest.dist?.integrity ?? "(none)"}, not the published tarball's ${integrity}`);
  }
  if (requireAttestation && !manifest.dist?.attestations?.provenance) {
    issues.push(`${where} serves ${version} without a provenance attestation (dist.attestations), though the repository is public`);
  }
  return issues;
}

/**
 * A client for one registry. `token` authenticates GitHub Packages; npmjs.org
 * reads public packages without one (pass a read token for a restricted one).
 */
export function registryClient({ kind, token, fetch: fetcher = globalThis.fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = () => Date.now() }) {
  if (!REGISTRIES.includes(kind)) throw new Error(`Unknown registry ${kind}; known: ${REGISTRIES.join(", ")}`);
  const headers = token ? authHeaders(token, { Accept: "application/json" }) : { Accept: "application/json" };
  const tarballHeaders = token ? authHeaders(token) : {};

  // GitHub Packages serves only whole packuments; npmjs.org serves one
  // version's manifest, which its CDN refreshes sooner than the packument.
  async function manifest(name, version) {
    const response = await fetcher(packageUrl(kind, name, kind === "npm" ? version : undefined), { headers, cache: "no-store" });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`${packageUrl(kind, name)} lookup failed: ${response.status} ${response.statusText ?? ""}`.trim());
    const body = await response.json();
    return kind === "npm" ? (body.version === version ? body : null) : body.versions?.[version] ?? null;
  }

  return {
    kind,
    url: REGISTRY_URLS[kind],
    manifest,

    async hasVersion(name, version) {
      return Boolean(await manifest(name, version));
    },

    async tarball(url) {
      const response = await fetcher(url, { headers: tarballHeaders });
      if (!response.ok) throw new Error(`Tarball download failed: ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    },

    /**
     * Polls until the registry serves `name@version`; resolves to its manifest,
     * or null after `timeoutMs`. A failed lookup counts as not served yet.
     */
    async waitForVersion(name, version, { timeoutMs = 5 * 60_000, intervalMs = 10_000, onWait = () => {} } = {}) {
      const started = now();
      for (;;) {
        const found = await manifest(name, version).catch(() => null);
        if (found) return found;
        const waited = now() - started;
        if (waited >= timeoutMs) return null;
        onWait({ waited, intervalMs });
        await sleep(intervalMs);
      }
    },
  };
}

/**
 * Waits for each registry to serve the version, then checks it. Resolves to
 * the problems found, empty when every registry serves the published tarball.
 * Without the local tarball's `integrity` (--resume with nothing left to
 * upload), the registries must at least agree with the first one.
 */
export async function verifyPublication({ clients, name, version, integrity, requireAttestation = () => false, wait = {} }) {
  const issues = [];
  let expected = integrity;
  for (const client of clients) {
    const manifest = await client.waitForVersion(name, version, wait);
    issues.push(...publicationIssues({ kind: client.kind, name, version, manifest, integrity: expected, requireAttestation: requireAttestation(client.kind) }));
    expected ??= manifest?.dist?.integrity;
  }
  return issues;
}
