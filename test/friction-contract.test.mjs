// The friction journal's format as data: friction-contract.json. Every golden case runs
// against the JavaScript implementation; other writers (Mastack's Python hook) keep a
// pinned copy and run the same cases.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  buildEvent, DETAIL_LIMIT, eventLine, fingerprint, FRICTION_CONTRACT, FRICTION_KINDS, FRICTION_SCHEMA, redactNote,
  validateEvent,
} from "../src/friction.mjs";
import { kitRoot } from "./fixtures.mjs";

const contract = JSON.parse(fs.readFileSync(path.join(kitRoot, "friction-contract.json"), "utf8"));

// One record per schema version: the SHA-256 of the canonical schema part and how many
// build and validate cases the contract had when the version was cut. A change to the
// schema part fails here until it bumps schema.version, adds cases and records both.
const SCHEMA_RECORD = {
  1: { sha256: "026f8bd386ebb338374e8a1b9da7c2a79eff2d0a34920394baf7846ebc36cd0b", cases: 37 },
};

/** JSON with object keys sorted at every level: the hash ignores key order and whitespace. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
const schemaHash = schema => crypto.createHash("sha256").update(canonical(schema)).digest("hex");
const formatCases = () => contract.cases.build.length + contract.cases.validate.length;

test("friction.mjs takes the schema version, kinds and limits from the contract", () => {
  assert.deepEqual(FRICTION_CONTRACT, contract);
  assert.equal(FRICTION_SCHEMA, contract.schema.version);
  assert.deepEqual(FRICTION_KINDS, contract.schema.kinds);
  assert.equal(DETAIL_LIMIT, contract.schema.limits.detail);
});

test("a built event has every schema field, in the contract's order", () => {
  const built = buildEvent({ package: "@acme/kit", kind: "note" }, { cwd: "/repos/app", env: {}, now: new Date(0) });
  assert.deepEqual(Object.keys(built), contract.schema.fields.map(field => field.name));
});

for (const golden of contract.cases.build) {
  test(`build case: ${golden.name}`, () => {
    const event = buildEvent(golden.fields, { cwd: golden.cwd, env: golden.env, now: new Date(golden.now) });
    assert.equal(eventLine(event), golden.line);
    assert.deepEqual(validateEvent(JSON.parse(golden.line)), [], "a built line is valid");
  });
}

for (const golden of contract.cases.validate) {
  test(`validate case: ${golden.name}`, () => {
    assert.deepEqual(validateEvent(JSON.parse(golden.line)), golden.problems);
  });
}

for (const golden of contract.cases.fingerprint) {
  test(`fingerprint case: ${golden.name}`, () => {
    assert.equal(fingerprint(...golden.parts), golden.fingerprint);
  });
}

for (const golden of contract.cases.redact) {
  test(`redact case: ${golden.name}`, () => {
    assert.equal(redactNote(golden.note), golden.redacted);
  });
}

test("the schema part is recorded for its version: a change bumps the version and adds cases", () => {
  const { version } = contract.schema;
  const versions = Object.keys(SCHEMA_RECORD).map(Number).sort((a, b) => a - b);
  assert.deepEqual(versions, Array.from({ length: version }, (_, index) => index + 1),
    `schema.version ${version}: record every version from 1 to ${version} in SCHEMA_RECORD`);
  assert.equal(schemaHash(contract.schema), SCHEMA_RECORD[version].sha256,
    "the contract's schema part changed: bump schema.version, add build and validate cases for the change, "
    + `and record the new version's hash (${schemaHash(contract.schema)}) and case count in SCHEMA_RECORD`);
  assert.ok(formatCases() >= SCHEMA_RECORD[version].cases,
    `cases are only added: version ${version} was recorded with ${SCHEMA_RECORD[version].cases} build and validate cases`);
  for (const later of versions.slice(1)) {
    assert.ok(SCHEMA_RECORD[later].cases > SCHEMA_RECORD[later - 1].cases,
      `schema version ${later} must add build or validate cases to version ${later - 1}'s`);
  }
});

test("canonical JSON ignores key order, so reformatting the contract keeps its hash", () => {
  assert.equal(canonical({ b: [1, { d: 2, c: "x" }], a: null }), canonical({ a: null, b: [1, { c: "x", d: 2 }] }));
  assert.notEqual(canonical({ a: [1, 2] }), canonical({ a: [2, 1] }));
});
