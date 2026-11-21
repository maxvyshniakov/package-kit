// Repository-relative path glob compiler and matcher shared by change-aware
// verification planning (plan.mjs) and the changelog-entry guard
// (changelog-entries.mjs).

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Normalizes a repository-relative path to POSIX separators without leading ./ or /. */
export function normalizePath(file) {
  return String(file).replaceAll("\\", "/").replace(/^(?:\.\/|\/)+/, "");
}

/**
 * Compiles a repository-relative path glob into a RegExp: `*` and `?` stay
 * within a path segment, `**` spans segments, `{a,b}` is either, and a
 * trailing `/` names everything below a directory.
 */
export function globToRegExp(glob, label = "glob") {
  if (typeof glob !== "string" || !glob) {
    throw new Error(`${label}: expected a non-empty glob string, got ${JSON.stringify(glob)}`);
  }
  let source = "";
  const pattern = glob.replace(/^(?:\.\/|\/)+/, "").replace(/\/$/, "/**");
  if (!pattern) {
    throw new Error(`${label}: "${glob}": empty glob pattern`);
  }
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") {
      // "**/" at a segment's start: any directories, none included; else anything.
      const atSegmentStart = index === 0 || pattern[index - 1] === "/";
      if (atSegmentStart && pattern[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else if (char === "[" || char === "]") {
      throw new Error(`${label}: "${glob}": character classes ([...]) are not supported; use {a,b}`);
    } else if (char === "{") {
      const end = pattern.indexOf("}", index);
      if (end === -1) throw new Error(`${label}: "${glob}": unclosed "{"`);
      const body = pattern.slice(index + 1, end);
      if (body.includes("{")) throw new Error(`${label}: "${glob}": nested {} is not supported`);
      if (body.includes("**")) throw new Error(`${label}: "${glob}": "**" inside {} is not supported; list the globs separately`);
      if (body.includes("[") || body.includes("]")) {
        throw new Error(`${label}: "${glob}": character classes ([...]) are not supported; use {a,b}`);
      }
      // Alternatives match literally, or with * and ? within a segment.
      source += `(?:${body.split(",").map(part => escapeRegExp(part).replaceAll("\\*", "[^/]*").replaceAll("\\?", "[^/]")).join("|")})`;
      index = end;
    } else source += escapeRegExp(char);
  }
  return new RegExp(`^${source}$`);
}

/**
 * Builds a predicate `(file) => boolean` from include and exclude globs (or
 * precompiled RegExps). A path matches iff it matches at least one include and
 * no exclude.
 */
export function matcher(includes = [], excludes = [], label = "glob") {
  const include = (includes ?? []).map(item => (item instanceof RegExp ? item : globToRegExp(item, label)));
  const exclude = (excludes ?? []).map(item => (item instanceof RegExp ? item : globToRegExp(item, label)));
  return file => {
    if (!include.length) return false;
    const normalized = normalizePath(file);
    return include.some(re => re.test(normalized)) && !exclude.some(re => re.test(normalized));
  };
}

/**
 * Compiles a list of repository-relative globs (with optional `!` exclusions)
 * into `{ match(path), hasIncludes }`.
 */
export function createMatcher(globs = [], label = "inputs") {
  const includes = [];
  const excludes = [];
  for (const glob of globs ?? []) {
    if (typeof glob !== "string" || !glob) {
      throw new Error(`${label}: expected glob strings, got ${JSON.stringify(glob)}`);
    }
    if (glob.startsWith("!")) excludes.push(globToRegExp(glob.slice(1), label));
    else includes.push(globToRegExp(glob, label));
  }
  return {
    hasIncludes: includes.length > 0,
    match: matcher(includes, excludes, label),
  };
}
