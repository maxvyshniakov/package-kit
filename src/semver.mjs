// Shared x.y.z version parsing, comparison, caret ranges and bumps.

const STRICT_VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const LENIENT_VERSION = /^(\d+)\.(\d+)\.(\d+)(?:[.-]|$)/;

/**
 * Parses `x.y.z` into `[major, minor, patch]`. With `{ lenient: true }`,
 * prerelease/build suffixes such as `1.4.5-canary.1` are ignored.
 */
export function parseVersion(version, { lenient = false } = {}) {
  const match = (lenient ? LENIENT_VERSION : STRICT_VERSION).exec(version);
  if (!match) throw new Error(lenient ? `Not a version: ${version}` : `Not a release version: ${version}`);
  return match.slice(1).map(Number);
}

export function compareVersions(a, b, options) {
  const [left, right] = [parseVersion(a, options), parseVersion(b, options)];
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

// npm caret semantics: the leftmost non-zero part is fixed, so ^0.26.1 means
// >=0.26.1 <0.27.0. Peer ranges between workspace packages use only this form.
export function satisfiesCaret(range, version) {
  const match = /^\^(\d+\.\d+\.\d+)$/.exec(range);
  if (!match) throw new Error(`Expected a ^x.y.z range, got ${range}`);
  const floor = parseVersion(match[1]);
  const fixed = floor.findIndex(part => part !== 0);
  const candidate = parseVersion(version);
  const fixedParts = fixed === -1 ? 3 : fixed + 1;
  return compareVersions(version, match[1]) >= 0
    && candidate.slice(0, fixedParts).every((part, index) => part === floor[index]);
}

// `level` is patch, minor, major or an explicit x.y.z above the current one.
export function nextVersion(current, level) {
  if (STRICT_VERSION.test(level)) {
    if (compareVersions(level, current) <= 0) throw new Error(`${level} is not above ${current}`);
    return level;
  }
  const [major, minor, patch] = parseVersion(current);
  if (level === "major") return `${major + 1}.0.0`;
  if (level === "minor") return `${major}.${minor + 1}.0`;
  if (level === "patch") return `${major}.${minor}.${patch + 1}`;
  throw new Error(`Unknown release level: ${level} (use patch, minor, major or x.y.z)`);
}
