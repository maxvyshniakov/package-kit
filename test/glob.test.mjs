import assert from "node:assert/strict";
import test from "node:test";

import { createMatcher, globToRegExp, matcher, normalizePath } from "../src/glob.mjs";

test("globToRegExp: * stays in a segment, ** spans them, {a,b}, ? and trailing slash", () => {
  assert.equal(globToRegExp("packages/sid-kit/src/**").test("packages/sid-kit/src/a/b.tsx"), true);
  assert.equal(globToRegExp("packages/sid-kit/src/**").test("packages/sid-kit/srcset.ts"), false);
  assert.equal(globToRegExp("src/**/*.css").test("src/a.css"), true);
  assert.equal(globToRegExp("src/**/*.css").test("src/a/b/c.css"), true);
  assert.equal(globToRegExp("*.py").test("lib/a.py"), false);
  assert.equal(globToRegExp("{lanefather,hooks}/**").test("hooks/reference-transaction"), true);
  assert.equal(globToRegExp("./lanefather/").test("lanefather/cli.py"), true);
  assert.equal(globToRegExp("src/?.ts").test("src/a.ts"), true);
  assert.equal(globToRegExp("src/?.ts").test("src/ab.ts"), false);
});

test("globToRegExp reports syntax errors under the caller's config key", () => {
  assert.throws(() => globToRegExp("src/[ab].ts", "changelog.paths"), /changelog\.paths: "src\/\[ab\]\.ts": character classes \(\[\.\.\.\]\) are not supported/);
  assert.throws(() => globToRegExp("{src/**,lib}/x", "changelog.paths"), /changelog\.paths: "\{src\/\*\*,lib\}\/x": "\*\*" inside \{\} is not supported/);
  assert.throws(() => globToRegExp("{a,{b,c}}", "verify.inputs"), /verify\.inputs: "\{a,\{b,c\}\}": nested \{\} is not supported/);
  assert.throws(() => globToRegExp("packages/{a,[bc]}/index.ts", "inputs"), /inputs:.*character classes/);
  assert.throws(() => globToRegExp("packages/{a,b/index.ts", "inputs"), /inputs:.*unclosed "\{"/);
  assert.throws(() => globToRegExp("/", "inputs"), /inputs:.*empty glob pattern/);
  assert.throws(() => globToRegExp("", "inputs"), /inputs: expected a non-empty glob string/);
});

test("matcher and createMatcher apply includes, exclusions and path normalization", () => {
  const match = matcher(["src/**", "package.json"], ["src/**/*.test.mjs"]);
  assert.equal(match("src/a.mjs"), true);
  assert.equal(match("./src/a.mjs"), true);
  assert.equal(match("src\\a.mjs"), true);
  assert.equal(match("src/a.test.mjs"), false);
  assert.equal(match("test/b.mjs"), false);
  assert.equal(match("package.json"), true);

  const empty = matcher([], ["src/**"]);
  assert.equal(empty("src/a.mjs"), false);

  const compiled = createMatcher(["/a/**/b?.ts", "!a/skip/**/b?.ts"], "verify.inputs");
  assert.equal(compiled.hasIncludes, true);
  assert.equal(compiled.match("a/b1.ts"), true);
  assert.equal(compiled.match("a/x/y/b2.ts"), true);
  assert.equal(compiled.match("a/skip/x/b2.ts"), false);
  assert.equal(createMatcher([]).hasIncludes, false);
  assert.equal(normalizePath("./a\\b/c"), "a/b/c");
});
