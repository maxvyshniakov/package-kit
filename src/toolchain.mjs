// Shared toolchain facts: repo-kit's own version and the Bun floor.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { compareVersions } from "./semver.mjs";

export const KIT_VERSION = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")).version;

// Bun 1.3.14 trusted the compromised eMudhra chains; 1.4.4 rejects them
// (README.md#tls-gate). The workflows pin the same version.
export const BUN_VERSION = "1.4.4";

export function compareBunVersions(a, b) {
  return compareVersions(a, b, { lenient: true });
}

/** An error message when the local Bun is older than BUN_VERSION, else undefined. */
export function bunTooOld(version) {
  if (!version) return "bun is not on PATH";
  return compareBunVersions(version, BUN_VERSION) < 0
    ? `bun ${version} predates ${BUN_VERSION}, the first release that rejects the compromised eMudhra chains; upgrade Bun`
    : undefined;
}

export function localBunVersion() {
  try {
    return execFileSync("bun", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}
