// `package-kit check file-budget` / `package-kit file-budget`: one configurable
// file-size ratchet for every consumer (maxvyshniakov/package-kit#6).
//
//   - Per-glob budgets, in lines or bytes (`rules: [{ glob, lines } | { glob, bytes }]`,
//     plus optional top-level `lines` or `bytes` fallback / shorthand).
//   - A ratchet allowlist that may only shrink: a listed file may not grow past
//     its recorded size, a shrunken file must lower its entry (`--update`), and
//     an entry is removed once the file fits or no longer exists. Compared with
//     the base commit (`PACKAGE_KIT_FILE_BUDGET_BASE`, `HEAD` when `--staged`, or
//     where `HEAD` left `origin/main` / `origin/HEAD`), no entry may rise and
//     no new file may be added without `--init`.
//   - Generated and vendored paths are excluded by config (`exclude`, `!` globs,
//     plus optional SHA-256 provenance exemptions in `exemptions`), alongside
//     default lockfile, changelog and NUL-containing binary exclusions.
//   - Runs from both the pre-commit hook (`--staged`: inspects staged index
//     blobs) and verify (default / `--all`: inspects tracked and untracked
//     non-ignored working-tree files, or all index blobs with `--staged --all`).
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { createMatcher, globToRegExp, matcher, normalizePath } from "./glob.mjs";

export const DEFAULT_EXCLUDE = [
  "**/node_modules/**",
  "**/dist/**",
  "**/.git/**",
];

export const LOCKFILE_NAMES = new Set([
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",
  "Gemfile.lock",
  "poetry.lock",
  "uv.lock",
  "composer.lock",
  "Pipfile.lock",
  "deno.lock",
  "flake.lock",
  "go.sum",
]);

const CHANGELOG_NAME = /^changelog(?:\.(?:md|markdown|mdx|rst|txt|adoc))?$/i;

export const USAGE = "Usage: package-kit file-budget [--staged] [--all] [--init|--update] [--json]";

/** Number of lines in `buffer`, counting a final line without a trailing newline. */
export function countLines(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer), "utf8");
  if (bytes.length === 0) return 0;
  let lines = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0a) lines++;
  }
  if (bytes[bytes.length - 1] !== 0x0a) lines++;
  return lines;
}

/** Number of UTF-8 bytes in `buffer`. */
export function countBytes(buffer) {
  return Buffer.isBuffer(buffer) ? buffer.length : Buffer.byteLength(String(buffer), "utf8");
}

/** Measures `buffer` in `unit` ("lines" or "bytes"). */
export function measureBuffer(buffer, unit) {
  if (unit === "lines") return countLines(buffer);
  if (unit === "bytes") return countBytes(buffer);
  throw new Error(`fileBudget: unknown unit ${JSON.stringify(unit)} (expected "lines" or "bytes")`);
}

/** Whether `buffer` contains a NUL byte (treated as a binary blob). */
export function isBinaryBuffer(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer), "utf8");
  return bytes.includes(0);
}

/** Whether `file` is a standard lockfile or changelog excluded by default. */
export function isDefaultExcludedFile(file) {
  const name = normalizePath(file).split("/").at(-1);
  return LOCKFILE_NAMES.has(name) || CHANGELOG_NAME.test(name);
}

function normalizeRule(raw, index) {
  const label = `fileBudget.rules[${index}]`;
  if (!raw || typeof raw !== "object") {
    throw new Error(`${label}: expected a rule object`);
  }
  const rawGlobs = raw.globs ?? raw.glob ?? raw.paths ?? raw.include ?? "**";
  const globs = Array.isArray(rawGlobs) ? rawGlobs : [rawGlobs];
  if (!globs.length || globs.some(g => typeof g !== "string" || !g)) {
    throw new Error(`${label}: expected a non-empty glob string or array of globs`);
  }
  const hasLines = raw.lines !== undefined;
  const hasBytes = raw.bytes !== undefined;
  const hasMax = raw.max !== undefined || raw.limit !== undefined;
  if (hasLines && hasBytes) {
    throw new Error(`${label}: specify either "lines" or "bytes", not both`);
  }
  let unit = raw.unit;
  let limit;
  if (hasLines) {
    if (unit && unit !== "lines") throw new Error(`${label}: unit "${unit}" conflicts with "lines"`);
    unit = "lines";
    limit = raw.lines;
  } else if (hasBytes) {
    if (unit && unit !== "bytes") throw new Error(`${label}: unit "${unit}" conflicts with "bytes"`);
    unit = "bytes";
    limit = raw.bytes;
  } else if (hasMax) {
    unit = unit ?? "bytes";
    if (unit !== "lines" && unit !== "bytes") {
      throw new Error(`${label}: expected unit "lines" or "bytes", got ${JSON.stringify(unit)}`);
    }
    limit = raw.max ?? raw.limit;
  } else {
    throw new Error(`${label}: expected "lines" or "bytes" budget`);
  }
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`${label}: expected a positive integer limit, got ${JSON.stringify(limit)}`);
  }
  const ruleExclude = Array.isArray(raw.exclude) ? raw.exclude : (raw.exclude ? [raw.exclude] : []);
  const combinedGlobs = [...globs, ...ruleExclude.map(g => (g.startsWith("!") ? g : `!${g}`))];
  const compiled = createMatcher(combinedGlobs, label);
  if (!compiled.hasIncludes) {
    throw new Error(`${label}: rule must have at least one positive include glob`);
  }
  return {
    id: raw.name ?? `${ (Array.isArray(rawGlobs) ? rawGlobs.join(",") : rawGlobs) } (${limit} ${unit})`,
    globs,
    unit,
    limit,
    match: compiled.match,
  };
}

/**
 * Normalizes `config.fileBudget` (or direct options) into a validated settings
 * object with compiled matchers.
 */
export function fileBudgetConfig(config = {}) {
  const own = config?.fileBudget ?? config ?? {};
  const excludeList = own.exclude ?? DEFAULT_EXCLUDE;
  if (!Array.isArray(excludeList) || excludeList.some(g => typeof g !== "string" || !g)) {
    throw new Error("fileBudget.exclude: expected an array of non-empty glob strings");
  }
  const excludePatterns = excludeList.map(g => (g.startsWith("!") ? g.slice(1) : g));
  const isExcluded = matcher(excludePatterns, [], "fileBudget.exclude");

  const rawRules = [];
  if (Array.isArray(own.rules)) {
    rawRules.push(...own.rules);
  } else if (own.rules && typeof own.rules === "object") {
    for (const [glob, spec] of Object.entries(own.rules)) {
      if (typeof spec === "number") {
        rawRules.push({ glob, [own.unit === "lines" ? "lines" : "bytes"]: spec });
      } else if (spec && typeof spec === "object") {
        rawRules.push({ glob, ...spec });
      } else {
        throw new Error(`fileBudget.rules["${glob}"]: expected a limit number or { lines | bytes }`);
      }
    }
  }
  if (own.lines !== undefined || own.bytes !== undefined || own.max !== undefined || own.limit !== undefined) {
    rawRules.push({
      glob: own.glob ?? own.globs ?? own.include ?? "**",
      ...(own.lines !== undefined ? { lines: own.lines } : {}),
      ...(own.bytes !== undefined ? { bytes: own.bytes } : {}),
      ...(own.max !== undefined ? { max: own.max } : {}),
      ...(own.limit !== undefined ? { limit: own.limit } : {}),
      ...(own.unit !== undefined ? { unit: own.unit } : {}),
    });
  }

  const rules = rawRules.map((rule, index) => normalizeRule(rule, index));
  const allowlist = own.allowlist ?? own.baseline ?? null;
  if (allowlist !== null && (typeof allowlist !== "string" || !allowlist.trim())) {
    throw new Error("fileBudget.allowlist: expected a repository-relative file path");
  }
  const exemptions = own.exemptions ?? null;
  if (exemptions !== null && (typeof exemptions !== "string" || !exemptions.trim())) {
    throw new Error("fileBudget.exemptions: expected a repository-relative file path");
  }

  return {
    rules,
    exclude: excludePatterns,
    isExcluded,
    allowlist: allowlist ? normalizePath(allowlist) : null,
    exemptions: exemptions ? normalizePath(exemptions) : null,
    excludeLockfiles: own.excludeLockfiles ?? true,
    excludeChangelogs: own.excludeChangelogs ?? true,
    excludeBinary: own.excludeBinary ?? true,
  };
}

/**
 * Parses an allowlist file (either JSON `{ version: 1, files: { [path]: number | { lines, bytes } } }`
 * or plain text `<path> <max>` lines with `#` comments).
 * Appends any syntax errors to `problems`.
 */
export function parseAllowlist(text, { file = "file-budget-allowlist.json", defaultUnit = "lines", problems = [] } = {}) {
  const entries = new Map();
  if (!text || !text.trim()) return entries;
  const trimmed = text.trim();
  const isJson = file.endsWith(".json") || trimmed.startsWith("{");
  if (isJson) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      problems.push(`${file}: invalid JSON (${error.message})`);
      return entries;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      problems.push(`${file}: expected a JSON object`);
      return entries;
    }
    const rawFiles = parsed.files && typeof parsed.files === "object" && !Array.isArray(parsed.files)
      ? parsed.files
      : parsed;
    for (const [key, value] of Object.entries(rawFiles)) {
      if (key === "version" && rawFiles === parsed && typeof value === "number") continue;
      const normalized = normalizePath(key);
      if (typeof value === "number") {
        if (!Number.isInteger(value) || value <= 0) {
          problems.push(`${file}: "${key}": expected a positive integer limit, got ${JSON.stringify(value)}`);
          continue;
        }
        entries.set(normalized, { [defaultUnit]: value });
      } else if (value && typeof value === "object" && !Array.isArray(value)) {
        const record = {};
        for (const unit of ["lines", "bytes"]) {
          if (value[unit] !== undefined) {
            if (!Number.isInteger(value[unit]) || value[unit] <= 0) {
              problems.push(`${file}: "${key}".${unit}: expected a positive integer, got ${JSON.stringify(value[unit])}`);
            } else {
              record[unit] = value[unit];
            }
          }
        }
        if (!Object.keys(record).length) {
          problems.push(`${file}: "${key}": expected a positive integer or { lines, bytes }`);
          continue;
        }
        entries.set(normalized, record);
      } else {
        problems.push(`${file}: "${key}": expected a positive integer or { lines, bytes }`);
      }
    }
    return entries;
  }

  // Plain-text `<path> <max>` [lines|bytes] format (as in Straylight's file-length-allowlist.txt).
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.split("#", 1)[0].trim();
    if (!line) continue;
    const fields = line.split(/\s+/);
    const unit = fields.length === 3 && (fields[2] === "lines" || fields[2] === "bytes") ? fields[2] : defaultUnit;
    if ((fields.length !== 2 && !(fields.length === 3 && (fields[2] === "lines" || fields[2] === "bytes")))
      || !/^\d+$/.test(fields[1])
      || Number(fields[1]) <= 0) {
      problems.push(`${file}:${i + 1}: expected \`<path> <maximum>\` once per file, found \`${raw}\``);
      continue;
    }
    const normalized = normalizePath(fields[0]);
    if (entries.has(normalized)) {
      problems.push(`${file}:${i + 1}: duplicate allowlist entry for ${normalized}`);
      continue;
    }
    entries.set(normalized, { [unit]: Number(fields[1]) });
  }
  return entries;
}

/** Formats an allowlist Map back to disk text (JSON for `.json`, text lines otherwise). */
export function formatAllowlist(entries, { file = "file-budget-allowlist.json", defaultUnit = "lines", singleUnit = true } = {}) {
  const sorted = [...entries.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (file.endsWith(".json")) {
    const files = {};
    for (const [name, limits] of sorted) {
      const units = Object.keys(limits);
      if (singleUnit && units.length === 1 && units[0] === defaultUnit) {
        files[name] = limits[defaultUnit];
      } else {
        files[name] = limits;
      }
    }
    return `${JSON.stringify({ version: 1, files }, null, 2)}\n`;
  }
  const lines = sorted.map(([name, limits]) => {
    const units = Object.keys(limits);
    if (singleUnit && units.length === 1 && units[0] === defaultUnit) {
      return `${name} ${limits[defaultUnit]}`;
    }
    return units.map(u => `${name} ${limits[u]} ${u}`).join("\n");
  });
  return lines.length ? `${lines.join("\n")}\n` : "";
}

/**
 * Parses a SHA-256 provenance exemptions manifest (`config/file-size-exemptions.json`),
 * validating exact tracked paths, provenance (`kind: "generated" | "vendor"`, `source`),
 * tracked `generator` for generated files, and 64-hex `sha256`.
 */
export function parseExemptions(text, trackedPaths, file = "config/file-size-exemptions.json") {
  if (text === null || text === undefined) return new Map();
  let config;
  try {
    config = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file}: invalid JSON (${error.message})`);
  }
  if (config?.version !== 1 || !Array.isArray(config.files)) {
    throw new Error(`${file}: invalid file-size exemption manifest`);
  }
  const result = new Map();
  for (const entry of config.files) {
    const entryPath = entry?.path;
    if (typeof entryPath !== "string"
      || entryPath.startsWith("/")
      || entryPath.includes("\\")
      || entryPath.split("/").some(part => !part || part === "." || part === "..")
      || (trackedPaths && !trackedPaths.has(entryPath))
      || result.has(entryPath)) {
      throw new Error(`Invalid/duplicate exemption path: ${JSON.stringify(entryPath)}`);
    }
    if (!["generated", "vendor"].includes(entry.kind)
      || typeof entry.source !== "string"
      || !entry.source.trim()
      || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? "")) {
      throw new Error(`Missing provenance/hash for ${entryPath}`);
    }
    if (entry.kind === "generated" && (!entry.generator || (trackedPaths && !trackedPaths.has(entry.generator)))) {
      throw new Error(`Generated exemption needs a tracked generator: ${entryPath}`);
    }
    result.set(entryPath, entry);
  }
  return result;
}

function git(root, args, { env = process.env, input, encoding = "utf8" } = {}) {
  return execFileSync("git", ["--literal-pathspecs", ...args], {
    cwd: root,
    env,
    input,
    encoding,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/**
 * Base commit whose allowlist may not be exceeded:
 * - In `--staged` mode, `HEAD` (the commit being built upon).
 * - Otherwise `PACKAGE_KIT_FILE_BUDGET_BASE`, or where `HEAD` left `origin/HEAD`
 *   or `origin/main` (or `HEAD~1` on that branch itself), or `HEAD`.
 */
export function baseCommit(root, { staged = false, env = process.env } = {}) {
  const tryGit = args => {
    try {
      return git(root, args, { env }).trim();
    } catch {
      return null;
    }
  };
  if (env.PACKAGE_KIT_FILE_BUDGET_BASE) {
    return tryGit(["rev-parse", "--verify", `${env.PACKAGE_KIT_FILE_BUDGET_BASE}^{commit}`]);
  }
  const head = tryGit(["rev-parse", "--verify", "HEAD"]);
  if (!head) return null;
  if (staged) return head;
  for (const ref of ["origin/HEAD", "origin/main"]) {
    const base = tryGit(["merge-base", "HEAD", ref]);
    if (!base) continue;
    return base === head ? tryGit(["rev-parse", "--verify", "HEAD~1"]) ?? head : base;
  }
  return head;
}

function readCommittedFile(root, file, commit, env) {
  if (!commit || !file) return null;
  try {
    return git(root, ["show", `${commit}:./${file}`], { env });
  } catch {
    return null;
  }
}

function collectWorkingTreeFiles(root, env) {
  const out = git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { env });
  const names = [...new Set(out.split("\0").filter(Boolean).map(normalizePath))].sort();
  const existing = [];
  for (const name of names) {
    const full = path.join(root, name);
    try {
      const stat = fs.lstatSync(full);
      if (stat.isFile()) existing.push(name);
    } catch {
      // Deleted in working tree before staging.
    }
  }
  return {
    files: existing,
    tracked: new Set(existing),
    readBuffer: file => fs.readFileSync(path.join(root, file)),
    readSize: file => fs.statSync(path.join(root, file)).size,
  };
}

function collectStagedFiles(root, { all = false, env = process.env } = {}) {
  const entries = new Map();
  const stageOut = git(root, ["ls-files", "--stage", "-z"], { env });
  for (const item of stageOut.split("\0")) {
    if (!item) continue;
    const tab = item.indexOf("\t");
    const header = /^(100644|100755) ([0-9a-f]+) 0$/.exec(item.slice(0, tab));
    if (header) entries.set(normalizePath(item.slice(tab + 1)), header[2]);
  }
  const paths = all
    ? [...entries.keys()].sort()
    : git(root, ["diff", "--cached", "--name-only", "--diff-filter=ACMRT", "-z"], { env })
        .split("\0")
        .filter(Boolean)
        .map(normalizePath)
        .filter(file => entries.has(file))
        .sort();

  const hashes = [...new Set(paths.map(file => entries.get(file)))];
  const sizes = new Map();
  if (hashes.length) {
    const batchOut = git(root, ["cat-file", "--batch-check=%(objectname) %(objectsize)"], {
      env,
      input: `${hashes.join("\n")}\n`,
    });
    for (const line of batchOut.trim().split("\n")) {
      if (!line) continue;
      const match = /^([a-f0-9]+) (\d+)$/.exec(line);
      if (!match) throw new Error(`Cannot inspect staged blob: ${line}`);
      sizes.set(match[1], Number(match[2]));
    }
  }
  const blobCache = new Map();
  const readBuffer = file => {
    const hash = entries.get(file);
    if (!hash) return null;
    if (!blobCache.has(hash)) {
      blobCache.set(hash, git(root, ["cat-file", "blob", hash], { env, encoding: null }));
    }
    return blobCache.get(hash);
  };
  return {
    files: paths,
    tracked: new Set(entries.keys()),
    readBuffer,
    readSize: file => sizes.get(entries.get(file)) ?? 0,
  };
}

/**
 * Evaluates the configured file-budget rules and ratchet allowlist against a
 * repository.
 */
export function checkFileBudget(root, config = {}, { staged = false, all = false, env = process.env } = {}) {
  const settings = fileBudgetConfig(config);
  const defaultUnit = settings.rules[0]?.unit ?? "lines";
  const singleUnit = new Set(settings.rules.map(r => r.unit)).size <= 1;

  const source = staged
    ? collectStagedFiles(root, { all, env })
    : collectWorkingTreeFiles(root, env);

  const readPolicyText = policyPath => {
    if (!policyPath) return null;
    if (staged) {
      if (!source.tracked.has(policyPath)) return null;
      const buf = source.readBuffer(policyPath);
      return buf ? buf.toString("utf8") : null;
    }
    const full = path.join(root, policyPath);
    return fs.existsSync(full) && fs.statSync(full).isFile() ? fs.readFileSync(full, "utf8") : null;
  };

  const exemptions = settings.exemptions
    ? parseExemptions(readPolicyText(settings.exemptions), source.tracked, settings.exemptions)
    : new Map();

  const problems = [];
  const allowlistText = readPolicyText(settings.allowlist);
  const allowed = settings.allowlist
    ? parseAllowlist(allowlistText ?? "", { file: settings.allowlist, defaultUnit, problems })
    : new Map();

  const commit = settings.allowlist ? baseCommit(root, { staged, env }) : null;
  const committedText = settings.allowlist ? readCommittedFile(root, settings.allowlist, commit, env) : null;
  const committed = committedText !== null
    ? parseAllowlist(committedText, { file: settings.allowlist, defaultUnit })
    : null;

  const oversized = [];
  const stale = [];
  const excluded = [];
  const measured = new Map(); // file -> { lines?, bytes? }
  const matchedRules = new Map(); // file -> rule[]
  const lowered = new Map();

  for (const file of source.files) {
    if (settings.allowlist && file === settings.allowlist) continue;
    if (settings.exemptions && file === settings.exemptions) continue;

    if (settings.isExcluded(file)) {
      excluded.push({ path: file, kind: "config" });
      continue;
    }

    const exemption = exemptions.get(file);
    if (exemption) {
      const content = source.readBuffer(file);
      const hash = createHash("sha256").update(content).digest("hex");
      if (hash !== exemption.sha256) {
        throw new Error(`Exemption SHA-256 hash is stale for ${JSON.stringify(file)}; regenerate and review provenance`);
      }
      excluded.push({ path: file, bytes: content.length, kind: exemption.kind });
      continue;
    }

    const name = file.split("/").at(-1);
    if (settings.excludeChangelogs && CHANGELOG_NAME.test(name)) {
      excluded.push({ path: file, kind: "changelog" });
      continue;
    }
    if (settings.excludeLockfiles && LOCKFILE_NAMES.has(name)) {
      excluded.push({ path: file, kind: "lockfile" });
      continue;
    }

    const matching = settings.rules.filter(rule => rule.match(file));
    if (!matching.length) continue;

    // Fast path for byte-only rules when file is within budget and not in allowlist.
    const needsLines = matching.some(rule => rule.unit === "lines");
    const minBytesLimit = matching.filter(rule => rule.unit === "bytes").reduce((min, r) => Math.min(min, r.limit), Infinity);
    const byteSize = source.readSize(file);
    if (!needsLines && byteSize <= minBytesLimit && !allowed.has(file)) {
      measured.set(file, { bytes: byteSize });
      matchedRules.set(file, matching);
      continue;
    }

    const content = source.readBuffer(file);
    if (settings.excludeBinary && isBinaryBuffer(content)) {
      excluded.push({ path: file, bytes: content.length, kind: "binary" });
      continue;
    }

    const sizes = { bytes: content.length };
    if (needsLines) sizes.lines = countLines(content);
    measured.set(file, sizes);
    matchedRules.set(file, matching);

    const fileAllowed = allowed.get(file);
    for (const rule of matching) {
      const size = sizes[rule.unit];
      const allowedMax = fileAllowed?.[rule.unit];
      if (size > rule.limit) {
        // Record in lowered allowlist for --init or --update.
        const currentLowered = lowered.get(file) ?? {};
        currentLowered[rule.unit] = allowedMax !== undefined ? Math.min(size, allowedMax) : size;
        lowered.set(file, currentLowered);

        if (allowedMax === undefined) {
          const detail = rule.unit === "bytes"
            ? `${size.toLocaleString("en-US")} bytes / 4 = ${size / 4} tokens (limit ${rule.limit.toLocaleString("en-US")} bytes)`
            : `${size} lines, over the limit of ${rule.limit}`;
          const message = settings.allowlist
            ? `${file} has ${detail}. Split it along its domain concepts; new files may not be added to ${settings.allowlist}.`
            : `${JSON.stringify(file)}: ${detail}`;
          problems.push(message);
          oversized.push({
            path: file,
            unit: rule.unit,
            size,
            limit: rule.limit,
            ...(rule.unit === "bytes" ? { bytes: size, tokens: size / 4 } : { lines: size }),
          });
        } else if (size > allowedMax) {
          problems.push(`${file} grew to ${size} ${rule.unit}, past its allowed ${allowedMax} in ${settings.allowlist}. Move code out instead.`);
          oversized.push({
            path: file,
            unit: rule.unit,
            size,
            limit: rule.limit,
            allowed: allowedMax,
            ...(rule.unit === "bytes" ? { bytes: size, tokens: size / 4 } : { lines: size }),
          });
        } else if (size < allowedMax) {
          stale.push({
            kind: "shrunk",
            file,
            unit: rule.unit,
            size,
            allowed: allowedMax,
            message: `${file} shrank to ${size} ${rule.unit}; lower its entry from ${allowedMax} to ${size} in ${settings.allowlist}.`,
          });
        }
      }
    }
  }

  // Inspect allowlist entries for files that now fit, were deleted, or rose against the base commit.
  if (settings.allowlist && (!staged || all)) {
    for (const [file, limits] of allowed.entries()) {
      const sizes = measured.get(file);
      const rules = matchedRules.get(file) ?? [];
      if (!sizes) {
        stale.push({
          kind: "missing",
          file,
          message: `${file} is listed in ${settings.allowlist} but does not exist (or is excluded); remove its entry from ${settings.allowlist}.`,
        });
        continue;
      }
      for (const [unit, maximum] of Object.entries(limits)) {
        const rule = rules.find(r => r.unit === unit);
        const limit = rule?.limit;
        const size = sizes[unit] ?? measureBuffer(source.readBuffer(file), unit);
        if (limit !== undefined && size <= limit) {
          stale.push({
            kind: "fits",
            file,
            unit,
            size,
            limit,
            allowed: maximum,
            message: `${file} fits the limit of ${limit} ${unit} with ${size} ${unit}; remove its entry from ${settings.allowlist}.`,
          });
        }
      }
    }
  } else if (settings.allowlist && staged && !all) {
    // In staged-only mode, check allowlisted files that were part of the staged change or deleted in index.
    for (const [file, limits] of allowed.entries()) {
      if (!source.tracked.has(file)) {
        stale.push({
          kind: "missing",
          file,
          message: `${file} is listed in ${settings.allowlist} but does not exist; remove its entry from ${settings.allowlist}.`,
        });
        continue;
      }
      const sizes = measured.get(file);
      if (!sizes) continue;
      const rules = matchedRules.get(file) ?? [];
      for (const [unit, maximum] of Object.entries(limits)) {
        const rule = rules.find(r => r.unit === unit);
        const limit = rule?.limit;
        const size = sizes[unit];
        if (limit !== undefined && size !== undefined && size <= limit) {
          stale.push({
            kind: "fits",
            file,
            unit,
            size,
            limit,
            allowed: maximum,
            message: `${file} fits the limit of ${limit} ${unit} with ${size} ${unit}; remove its entry from ${settings.allowlist}.`,
          });
        }
      }
    }
  }

  const raisedProblems = [];
  if (settings.allowlist && committed !== null) {
    for (const [file, limits] of allowed.entries()) {
      const before = committed.get(file);
      if (!before) {
        raisedProblems.push(`${file}: new entries cannot be added to ${settings.allowlist}; its maxima may only decrease.`);
        continue;
      }
      for (const [unit, maximum] of Object.entries(limits)) {
        const previous = before[unit];
        if (previous === undefined) {
          raisedProblems.push(`${file}: new ${unit} entry cannot be added to ${settings.allowlist}; its maxima may only decrease.`);
        } else if (maximum > previous) {
          raisedProblems.push(`${file}: its entry rose from ${previous} to ${maximum} ${unit}; entries in ${settings.allowlist} may only decrease.`);
        }
      }
    }
  }

  return {
    mode: staged ? (all ? "all-tracked-index" : "changed-index") : "working-tree",
    settings,
    defaultUnit,
    singleUnit,
    checkedFiles: measured.size,
    allowed,
    committed,
    lowered,
    oversized,
    excluded,
    stale,
    problems: [...problems, ...raisedProblems],
  };
}

export function parseFileBudgetArgs(args = []) {
  const options = {
    staged: false,
    all: false,
    init: false,
    update: false,
    json: false,
    help: false,
  };
  for (const arg of args) {
    if (arg === "--") continue;
    if (arg === "--staged") options.staged = true;
    else if (arg === "--all") options.all = true;
    else if (arg === "--init") options.init = true;
    else if (arg === "--update") options.update = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`${USAGE} (unknown option ${arg})`);
  }
  if (options.init && options.update) {
    throw new Error("file-budget: specify either --init or --update, not both");
  }
  return options;
}

const SPLIT_GUIDANCE = `Split each file by responsibility before committing:
  1. Move a cohesive behavior into a sibling module with a small interface.
     Keep state, transitions and cleanup together; avoid forwarding-only files.
  2. Move independent test scenarios into separate *.test files; share focused
     fixtures. Split docs by topic and link them from an index.
  3. Update imports, exports and links; run relevant tests and typecheck.
  4. Stage the split files and deletions, then retry.`;

export function runFileBudget({
  root,
  config = {},
  args = [],
  env = process.env,
  print = console.log,
  printError = console.error,
} = {}) {
  let options;
  try {
    options = parseFileBudgetArgs(args);
  } catch (error) {
    printError(`file-budget: ${error.message}`);
    return 2;
  }
  if (options.help) {
    print(USAGE);
    return 0;
  }

  let settings;
  try {
    settings = fileBudgetConfig(config);
  } catch (error) {
    printError(`file-budget: ${error.message}`);
    return 1;
  }

  if (!settings.rules.length) {
    if (options.json) {
      print(JSON.stringify({ mode: "unconfigured", checkedFiles: 0, oversized: [], excluded: [] }, null, 2));
    } else {
      print("file-budget: fileBudget is not configured; nothing to check");
    }
    return 0;
  }

  let report;
  try {
    report = checkFileBudget(root, config, {
      staged: options.staged,
      all: options.all,
      env,
    });
  } catch (error) {
    printError(`file-budget: ${error.message}`);
    return 1;
  }

  if (options.init) {
    if (!settings.allowlist) {
      printError("file-budget: fileBudget.allowlist is not configured; cannot write an allowlist");
      return 1;
    }
    const allowlistFile = path.join(root, settings.allowlist);
    if (fs.existsSync(allowlistFile)) {
      printError(`file-budget: ${settings.allowlist} exists; use --update to lower it`);
      return 1;
    }
    fs.mkdirSync(path.dirname(allowlistFile), { recursive: true });
    fs.writeFileSync(
      allowlistFile,
      formatAllowlist(report.lowered, {
        file: settings.allowlist,
        defaultUnit: report.defaultUnit,
        singleUnit: report.singleUnit,
      }),
    );
    print(`file-budget: wrote ${settings.allowlist} with ${report.lowered.size} oversized file(s) in ${report.checkedFiles} checked files; entries may only shrink`);
    return 0;
  }

  if (options.update) {
    if (!settings.allowlist) {
      printError("file-budget: fileBudget.allowlist is not configured; cannot update an allowlist");
      return 1;
    }
    const allowlistFile = path.join(root, settings.allowlist);
    // Only lower or remove existing allowlist entries; never add new files or raise maxima.
    const nextAllowed = new Map();
    for (const [file, limits] of report.allowed.entries()) {
      const current = report.lowered.get(file);
      if (!current) continue;
      const updated = {};
      for (const [unit, maximum] of Object.entries(limits)) {
        if (current[unit] !== undefined) {
          updated[unit] = Math.min(maximum, current[unit]);
        }
      }
      if (Object.keys(updated).length) nextAllowed.set(file, updated);
    }
    fs.mkdirSync(path.dirname(allowlistFile), { recursive: true });
    fs.writeFileSync(
      allowlistFile,
      formatAllowlist(nextAllowed, {
        file: settings.allowlist,
        defaultUnit: report.defaultUnit,
        singleUnit: report.singleUnit,
      }),
    );
    for (const item of report.stale) {
      if (item.kind === "shrunk") {
        print(`file-budget: lowered ${item.file} ${item.allowed} -> ${item.size} ${item.unit}`);
      } else {
        print(`file-budget: removed ${item.file} from ${settings.allowlist}`);
      }
    }
    // Re-evaluate after lowering stale entries so only genuine growth/new violations fail.
    report = checkFileBudget(root, config, {
      staged: options.staged,
      all: options.all,
      env,
    });
  }

  const allProblems = [
    ...report.problems,
    ...report.stale.map(item => `${item.message} (or run package-kit file-budget --update)`),
  ];

  if (options.json) {
    const firstBytesRule = settings.rules.find(r => r.unit === "bytes");
    print(JSON.stringify({
      mode: report.mode,
      ...(firstBytesRule ? { limitBytes: firstBytesRule.limit } : {}),
      checkedFiles: report.checkedFiles,
      oversized: report.oversized,
      stale: report.stale,
      excluded: report.excluded,
      problems: allProblems,
    }, null, 2));
    return allProblems.length ? 1 : 0;
  }

  if (allProblems.length) {
    const byteRule = settings.rules.length === 1 && settings.rules[0].unit === "bytes" ? settings.rules[0] : null;
    if (byteRule && report.oversized.length && !settings.allowlist) {
      printError(`File budget blocked: authored files must be at most ${(byteRule.limit / 4).toLocaleString("en-US")} tokens (tokens = bytes / 4; limit = ${byteRule.limit.toLocaleString("en-US")} bytes).\n`);
      for (const problem of allProblems) printError(`  ${problem}`);
      printError(`\n${SPLIT_GUIDANCE}`);
    } else {
      printError("file-budget failed:");
      for (const problem of allProblems) printError(`  ${problem}`);
      if (report.oversized.some(item => item.unit === "bytes")) {
        printError(`\n${SPLIT_GUIDANCE}`);
      }
    }
    return 1;
  }

  if (settings.allowlist) {
    print(`file-budget: ok (${report.checkedFiles - report.allowed.size} files within budget, ${report.allowed.size} allowlisted at their maxima)`);
  } else {
    print(`file-budget: ok (${report.checkedFiles} files within budget)`);
  }
  return 0;
}
