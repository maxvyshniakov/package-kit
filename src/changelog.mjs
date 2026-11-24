// Package changelog format shared by `bun run release` and `check:changelogs`.
// The policy lives in docs/VERSIONING.md.
//
//   # @maxvyshniakov/<package> Changelog
//
//   <optional intro paragraph>
//
//   ## Unreleased
//
//   ## 1.2.3 - 2026-09-25
//
//   ### Breaking | Added | Changed | Deprecated | Removed | Fixed | Security
//
//   - Entry ...
//
// A Breaking entry under "## Unreleased" also carries an indented line saying
// why a transition period (the new form beside the deprecated old one) could
// not avoid the break:
//
//   - Removed the `size` prop.
//     No transition period: <why>

import { compareVersions } from "./semver.mjs";

export { compareVersions, nextVersion, parseVersion, satisfiesCaret } from "./semver.mjs";

export const NO_TRANSITION = "No transition period:";

export const SECTION_NAMES = ["Breaking", "Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"];

const RELEASE_HEADING = /^## (\d+\.\d+\.\d+) - (\d{4}-\d{2}-\d{2})$/;

/**
 * Splits a changelog into title, intro, the Unreleased body and releases.
 * Structural problems are collected in `errors` instead of thrown, so the
 * checker can report every one of them.
 */
export function parseChangelog(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const errors = [];
  const titles = lines.map((line, index) => ({ line, index })).filter(({ line }) => line.startsWith("# "));
  if (titles.length !== 1) errors.push(`expected one "# " title, found ${titles.length}`);
  const title = titles[0]?.line.slice(2) ?? "";
  if (titles[0] && lines.slice(0, titles[0].index).some(line => line.trim())) {
    errors.push("text before the title");
  }

  const sections = [];
  let intro = [];
  let current = null;
  for (const [index, line] of lines.entries()) {
    if (titles[0] && index <= titles[0].index) continue;
    if (line.startsWith("## ")) {
      current = { heading: line, line: index + 1, body: [] };
      sections.push(current);
      continue;
    }
    if (/^#### |^##### /.test(line)) errors.push(`line ${index + 1}: use "###" section headings only`);
    const section = /^### (.+)$/.exec(line);
    if (section && !SECTION_NAMES.includes(section[1])) {
      errors.push(`line ${index + 1}: unknown section "${section[1]}" (use ${SECTION_NAMES.join(", ")})`);
    }
    (current ? current.body : intro).push(line);
  }

  let unreleased = null;
  const releases = [];
  for (const [position, section] of sections.entries()) {
    errors.push(...duplicateSubsections(section));
    if (section.heading === "## Unreleased") {
      if (position !== 0) errors.push(`line ${section.line}: "## Unreleased" must be the first section`);
      if (unreleased !== null) errors.push(`line ${section.line}: duplicate "## Unreleased"`);
      unreleased = trimBlank(section.body).join("\n");
      errors.push(...breakingWithoutReason(section));
      continue;
    }
    const release = RELEASE_HEADING.exec(section.heading);
    if (!release) {
      errors.push(`line ${section.line}: expected "## Unreleased" or "## x.y.z - YYYY-MM-DD", found "${section.heading}"`);
      continue;
    }
    releases.push({ version: release[1], date: release[2], line: section.line, body: trimBlank(section.body).join("\n") });
  }
  if (unreleased === null) errors.push('missing "## Unreleased"');

  for (let index = 1; index < releases.length; index++) {
    const [newer, older] = [releases[index - 1], releases[index]];
    if (compareVersions(newer.version, older.version) <= 0) {
      errors.push(`line ${older.line}: ${older.version} must be older than ${newer.version} above it`);
    }
    if (newer.date < older.date) errors.push(`line ${newer.line}: ${newer.version} is dated before ${older.version}`);
  }

  return { title, intro: trimBlank(intro).join("\n"), unreleased: unreleased ?? "", releases, errors };
}

// A union merge of two branches that both added "### Added" under one release leaves the heading twice.
function duplicateSubsections(section) {
  const errors = [];
  const seen = new Map();
  for (const [offset, line] of section.body.entries()) {
    const heading = /^### (.+)$/.exec(line);
    if (!heading) continue;
    const lineNumber = section.line + 1 + offset;
    const first = seen.get(heading[1]);
    if (first === undefined) seen.set(heading[1], lineNumber);
    else errors.push(`line ${lineNumber}: duplicate "### ${heading[1]}" in "${section.heading}" (first at line ${first}); merge their entries into one section`);
  }
  return errors;
}

// Each "- " entry under the section's "### Breaking" needs a non-empty "No transition period:" line of its own.
function breakingWithoutReason(section) {
  const errors = [];
  let breaking = false;
  let entry = null;
  const close = () => {
    if (entry && !entry.reason) errors.push(`line ${entry.line}: a Breaking entry needs a line "${NO_TRANSITION} <why>" saying why the old form could not stay deprecated for a while: "${entry.text.slice(0, 60)}"`);
    entry = null;
  };
  for (const [offset, line] of section.body.entries()) {
    const heading = /^### (.+)$/.exec(line);
    if (heading) {
      close();
      breaking = heading[1] === "Breaking";
      continue;
    }
    if (!breaking) continue;
    if (line.startsWith("- ")) {
      close();
      entry = { line: section.line + 1 + offset, text: line, reason: false };
    } else if (entry && line.trim().startsWith(NO_TRANSITION) && line.trim().slice(NO_TRANSITION.length).trim()) {
      entry.reason = true;
    }
  }
  close();
  return errors;
}

export function formatChangelog({ title, intro, unreleased, releases }) {
  const parts = [`# ${title}`];
  if (intro) parts.push(intro);
  parts.push(unreleased ? `## Unreleased\n\n${unreleased}` : "## Unreleased");
  for (const release of releases) {
    parts.push(release.body ? `## ${release.version} - ${release.date}\n\n${release.body}` : `## ${release.version} - ${release.date}`);
  }
  return `${parts.join("\n\n")}\n`;
}

function trimBlank(lines) {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start].trim()) start++;
  while (end > start && !lines[end - 1].trim()) end--;
  return lines.slice(start, end);
}

export { lockfileWorkspaceVersion, setLockfileWorkspaceVersion } from "./packages.mjs";
