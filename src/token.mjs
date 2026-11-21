// GITHUB_TOKEN for the GitHub Packages registry.
//
// bunfig.toml reads @maxvyshniakov packages with token = "$GITHUB_TOKEN", so
// every `bun install` needs it: read:packages to install, write:packages to
// publish. In CI the workflow token; locally `gh auth token` when unset.
import { execFileSync } from "node:child_process";

export { BUN_VERSION, bunTooOld, compareBunVersions, localBunVersion } from "./toolchain.mjs";

/** { token, source } with source "GITHUB_TOKEN" | "gh auth token", or { token: undefined }. */
export function resolveToken(env = process.env, ghToken = readGhToken) {
  if (env.GITHUB_TOKEN) return { token: env.GITHUB_TOKEN, source: "GITHUB_TOKEN" };
  const token = ghToken();
  return token ? { token, source: "gh auth token" } : { token: undefined };
}

function readGhToken() {
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

export const TOKEN_HINT = "export GITHUB_TOKEN=$(gh auth token) (read:packages to install, write:packages to publish)";
