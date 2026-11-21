import assert from "node:assert/strict";
import test from "node:test";

import { compareVersions, nextVersion, parseVersion, satisfiesCaret } from "../src/semver.mjs";

test("parseVersion parses strict x.y.z and optional lenient prerelease suffixes", () => {
  assert.deepEqual(parseVersion("1.2.3"), [1, 2, 3]);
  assert.throws(() => parseVersion("1.4.5-canary.1"), /Not a release version/);
  assert.deepEqual(parseVersion("1.4.5-canary.1", { lenient: true }), [1, 4, 5]);
  assert.deepEqual(parseVersion("1.4.4", { lenient: true }), [1, 4, 4]);
  assert.throws(() => parseVersion("not-a-version", { lenient: true }), /Not a version/);
});

test("compareVersions orders strict and lenient versions numerically", () => {
  assert.ok(compareVersions("1.10.0", "1.4.4") > 0);
  assert.equal(compareVersions("0.8.0", "0.8.0"), 0);
  assert.ok(compareVersions("1.3.14", "1.4.4") < 0);
  assert.ok(compareVersions("1.4.5-canary.1", "1.4.4", { lenient: true }) > 0);
  assert.equal(compareVersions("1.4.4-canary.1", "1.4.4", { lenient: true }), 0);
});

test("satisfiesCaret and nextVersion match semver release rules", () => {
  assert.equal(satisfiesCaret("^0.26.1", "0.26.4"), true);
  assert.equal(satisfiesCaret("^0.26.1", "0.27.0"), false);
  assert.equal(nextVersion("0.8.0", "patch"), "0.8.1");
  assert.equal(nextVersion("0.8.0", "minor"), "0.9.0");
  assert.equal(nextVersion("0.8.0", "major"), "1.0.0");
  assert.equal(nextVersion("0.8.0", "0.10.0"), "0.10.0");
});
