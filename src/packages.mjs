// Released packages: one package object per package.json the repository
// releases, so callers ask a package for its version, lockfile entry, archive
// name and version commit instead of reading package.json themselves.
import fs from "node:fs";
import path from "node:path";

export const MANIFEST_FILE = "package.json";

/** Archive slug for a package name (`@scope/name` -> `scope-name`). */
export function archiveSlug(name) {
  return name ? name.replace("@", "").replace("/", "-") : undefined;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// bun.lock records each workspace package's version, but `bun install` leaves
// it stale when only package.json "version" changes, so releases set it here.
export function lockfileWorkspaceVersion(lockfile, workspacePath) {
  const block = new RegExp(`\\n    "${escapeRegExp(workspacePath)}": \\{\\n      "name": "[^"]+",\\n      "version": "([^"]+)",`);
  return block.exec(lockfile)?.[1];
}

export function setLockfileWorkspaceVersion(lockfile, workspacePath, version) {
  const block = new RegExp(`(\\n    "${escapeRegExp(workspacePath)}": \\{\\n      "name": "[^"]+",\\n      "version": ")[^"]+(",)`);
  if (!block.test(lockfile)) throw new Error(`bun.lock has no workspace entry for ${workspacePath}`);
  return lockfile.replace(block, `$1${version}$2`);
}

/** Repository-relative POSIX path to a package's manifest file. */
export function packageManifestPath(pkg) {
  return path.posix.join(pkg.path, MANIFEST_FILE);
}

/** Reads the version string from a package's manifest text. */
export function readPackageVersion(pkg, text) {
  if (typeof pkg.readVersion === "function") return pkg.readVersion(text);
  return JSON.parse(text).version;
}

/**
 * The commit that introduced `pkg.version` into the package's manifest: the
 * release commit, even when later commits touched the file.
 */
export function versionCommitOf(git, pkg) {
  const file = path.join(pkg.path, MANIFEST_FILE);
  const needle = `"version": "${pkg.version}"`;
  const [first] = git("log", "--reverse", "--format=%H", "-S", needle, "--", file).split("\n").filter(Boolean);
  if (first) return first;
  throw new Error(`no commit sets ${needle} in ${file}`);
}

/**
 * The packages this repository releases: each directory under packages/ with
 * a package.json (a workspace), or else the root package. `path` is relative
 * to the root ("." for the root package).
 */
export function releasedPackages(root) {
  const manifestFile = MANIFEST_FILE;
  const packagesDir = path.join(root, "packages");
  const workspace = fs.existsSync(packagesDir)
    ? fs.readdirSync(packagesDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && fs.existsSync(path.join(packagesDir, entry.name, manifestFile)))
      .map(entry => `packages/${entry.name}`)
    : [];
  return (workspace.length ? workspace : ["."]).map(relative => {
    const dir = path.join(root, relative);
    const file = path.join(dir, manifestFile);
    if (!fs.existsSync(file)) throw new Error(`${path.relative(root, file)} not found`);
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    const { name, version } = manifest;
    const isWorkspace = relative !== ".";
    const slug = archiveSlug(name);
    const pkg = {
      path: relative,
      dir,
      manifest,
      name,
      version,
      workspace: isWorkspace,
      readVersion(text) {
        return JSON.parse(text).version;
      },
      withVersion(text, from, to) {
        return text.replace(`"version": "${from}"`, `"version": "${to}"`);
      },
      lockfileVersion(lock) {
        return isWorkspace ? lockfileWorkspaceVersion(lock, relative) : undefined;
      },
      withLockfileVersion(lock, next) {
        return isWorkspace ? setLockfileWorkspaceVersion(lock, relative, next) : lock;
      },
      archiveName(ver = version) {
        return slug ? `${slug}-${ver}.tgz` : undefined;
      },
      archiveVersionsIn(text) {
        if (!slug || !text) return [];
        const pattern = new RegExp(`${escapeRegExp(slug)}-(\\d+\\.\\d+\\.\\d+)\\.tgz`, "g");
        return [...text.matchAll(pattern)].map(match => match[1]);
      },
      versionCommit(git) {
        return versionCommitOf(git, pkg);
      },
    };
    return pkg;
  }).sort((a, b) => a.name.localeCompare(b.name));
}
