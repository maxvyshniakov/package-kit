import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { KIT_VERSION as CHECK_KIT_VERSION } from "../src/check.mjs";
import { BUN_VERSION as INDEX_BUN_VERSION, KIT_VERSION as INDEX_KIT_VERSION } from "../src/index.mjs";
import { BUN_VERSION as TOKEN_BUN_VERSION, bunTooOld as tokenBunTooOld } from "../src/token.mjs";
import { BUN_VERSION, KIT_VERSION, bunTooOld, compareBunVersions } from "../src/toolchain.mjs";
import { kitRoot } from "./fixtures.mjs";

test("toolchain exports KIT_VERSION, BUN_VERSION and Bun comparison, re-exported for compatibility", () => {
  const manifestVersion = JSON.parse(fs.readFileSync(path.join(kitRoot, "package.json"), "utf8")).version;
  assert.equal(KIT_VERSION, manifestVersion);
  assert.equal(CHECK_KIT_VERSION, KIT_VERSION);
  assert.equal(INDEX_KIT_VERSION, KIT_VERSION);
  assert.equal(TOKEN_BUN_VERSION, BUN_VERSION);
  assert.equal(INDEX_BUN_VERSION, BUN_VERSION);
  assert.equal(tokenBunTooOld, bunTooOld);

  assert.ok(compareBunVersions("1.3.14", "1.4.4") < 0);
  assert.equal(compareBunVersions("1.4.4", "1.4.4"), 0);
  assert.ok(compareBunVersions("1.4.5-canary.1", "1.4.4") > 0);
  assert.match(bunTooOld("1.3.14"), /predates 1\.4\.4/);
  assert.equal(bunTooOld("1.4.4"), undefined);
  assert.match(bunTooOld(undefined), /not on PATH/);
});

test("token.mjs only resolves tokens and delegates toolchain exports", () => {
  const source = fs.readFileSync(path.join(kitRoot, "src/token.mjs"), "utf8");
  assert.doesNotMatch(source, /const BUN_VERSION/);
  assert.doesNotMatch(source, /function bunTooOld/);
  assert.doesNotMatch(source, /function localBunVersion/);
  assert.doesNotMatch(source, /function compareBunVersions/);
});
