// One HTTP adapter for GitHub's REST API and GitHub Packages registry.
// Policy (attestation state, workflow check state, retries, messages) stays
// in the calling modules; this module owns URLs, auth headers, and requests.

export const API_BASE = "https://api.github.com";
export const REGISTRY_BASE = "https://npm.pkg.github.com";

/** The single Authorization header builder for GitHub API and registry requests. */
export function authHeaders(token, extra = {}) {
  return { Authorization: `Bearer ${token}`, ...extra };
}

function apiHeaders(token, extra = {}) {
  return authHeaders(token, { Accept: "application/vnd.github+json", ...extra });
}

export function repositoryOf(remoteUrl) {
  const match = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(remoteUrl);
  if (!match) throw new Error(`origin is not a GitHub repository: ${remoteUrl}`);
  return match[1];
}

export function registryUrl(name) {
  return `${REGISTRY_BASE}/${name.replace("/", "%2f")}`;
}

export function dispatchUrl({ repository, workflow }) {
  return `${API_BASE}/repos/${repository}/actions/workflows/${workflow}/dispatches`;
}

/**
 * A GitHub HTTP client with an injectable `fetch`. `repository` may be a
 * `"owner/name"` string or a lazy `() => "owner/name"` getter (only needed
 * for repository-scoped calls: statuses, postStatus, hasCommit, workflowRuns).
 */
export function client({ token, repository, fetch: fetcher = globalThis.fetch } = {}) {
  const repo = () => {
    const value = typeof repository === "function" ? repository() : repository;
    if (!value) throw new Error("GitHub client requires a repository");
    return value;
  };
  const repoUrl = suffix => `${API_BASE}/repos/${repo()}${suffix}`;

  return {
    async statuses(sha) {
      const response = await fetcher(repoUrl(`/commits/${sha}/statuses?per_page=100`), {
        headers: apiHeaders(token, { "Content-Type": "application/json" }),
      });
      if (!response.ok) throw new Error(`status lookup for ${sha.slice(0, 7)} failed: ${response.status} ${response.statusText}`);
      return response.json();
    },

    async postStatus(sha, body) {
      const response = await fetcher(repoUrl(`/statuses/${sha}`), {
        method: "POST",
        headers: apiHeaders(token, { "Content-Type": "application/json" }),
        body: JSON.stringify(body),
      });
      if (response.ok) return { ok: true };
      const message = await response.json().then(json => json.message, () => "");
      return {
        ok: false,
        unknownCommit: response.status === 422 && /No commit found/i.test(message),
        message: `${response.status} ${response.statusText} ${message}`.trim(),
      };
    },

    async hasCommit(sha) {
      const response = await fetcher(repoUrl(`/commits/${sha}`), {
        headers: apiHeaders(token, { "Content-Type": "application/json" }),
      });
      return response.ok;
    },

    async workflowRuns(workflow, sha) {
      const response = await fetcher(repoUrl(`/actions/workflows/${workflow}/runs?head_sha=${sha}&per_page=5`), {
        headers: apiHeaders(token),
      });
      if (!response.ok) throw new Error(`${workflow} lookup failed: ${response.status} ${response.statusText}`);
      return (await response.json()).workflow_runs;
    },

    async dispatch(target, { timeoutMs = 30_000 } = {}) {
      const response = await fetcher(dispatchUrl(target), {
        method: "POST",
        headers: apiHeaders(token, { "Content-Type": "application/json" }),
        body: JSON.stringify({ ref: target.ref ?? "main" }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
      return true;
    },

    async user() {
      const response = await fetcher(`${API_BASE}/user`, {
        headers: apiHeaders(token),
      });
      if (!response.ok) throw new Error(`GitHub user lookup failed: ${response.status} ${response.statusText}`);
      return response.json();
    },

    async registryMetadata(name) {
      const response = await fetcher(registryUrl(name), { headers: authHeaders(token) });
      if (response.status === 404) return { versions: {}, "dist-tags": {} };
      if (!response.ok) throw new Error(`Registry lookup failed: ${response.status}`);
      return response.json();
    },

    async registryHasVersion(name, version) {
      const response = await fetcher(registryUrl(name), { headers: authHeaders(token) });
      if (!response.ok) return false;
      const metadata = await response.json();
      return Boolean(metadata.versions?.[version]);
    },

    async registryTarball(url) {
      const response = await fetcher(url, { headers: authHeaders(token) });
      if (!response.ok) throw new Error(`Tarball download failed: ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    },
  };
}
