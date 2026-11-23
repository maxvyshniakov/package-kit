// `package-kit check`: the kit's own drift check, a verify step in every repository.
//   - the managed .githooks files are what `package-kit hooks sync` writes;
//   - every maxvyshniakov/package-kit workflow or action reference in
//     .github/workflows names v<installed package-kit version>, so CI runs the kit
//     the lockfile pins;
//   - package.json "packageManager", when set, names the Bun the workflows run.
import fs from "node:fs";
import path from "node:path";

import { hookIssues } from "./hooks.mjs";
import { BUN_VERSION, KIT_VERSION } from "./toolchain.mjs";

export { KIT_VERSION } from "./toolchain.mjs";

const KIT_REFERENCE = /maxvyshniakov\/package-kit\/([\w./-]+)@([\w.-]+)/g;
const LEGACY_KIT_REFERENCE = /maxvyshniakov\/repo-kit\/([\w./-]+)@([\w.-]+)/g;

/** Every package-kit reference in a workflow file's text: { target, ref, line }. */
export function kitReferences(text) {
  return text.split("\n").flatMap((line, index) => [...line.matchAll(KIT_REFERENCE)].map(match => ({ target: match[1], ref: match[2], line: index + 1 })));
}

function legacyKitReferences(text) {
  return text.split("\n").flatMap((line, index) => [...line.matchAll(LEGACY_KIT_REFERENCE)].map(match => ({ target: match[1], ref: match[2], line: index + 1 })));
}

export function workflowIssues(root, version = KIT_VERSION) {
  const dir = path.join(root, ".github/workflows");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(file => /\.ya?ml$/.test(file)).flatMap(file => {
    const text = fs.readFileSync(path.join(dir, file), "utf8");
    const legacy = legacyKitReferences(text)
      .map(({ target, ref, line }) => `.github/workflows/${file}:${line}: maxvyshniakov/repo-kit/${target}@${ref}; switch to maxvyshniakov/package-kit/${target}@v${version}`);
    const drifted = kitReferences(text)
      .filter(({ ref }) => ref !== `v${version}`)
      .map(({ target, ref, line }) => `.github/workflows/${file}:${line}: ${target}@${ref}; the installed package-kit is v${version}`);
    return [...legacy, ...drifted];
  });
}

export function packageManagerIssues(root, bunVersion = BUN_VERSION) {
  const manifest = path.join(root, "package.json");
  if (!fs.existsSync(manifest)) return []; // a Python package, say
  const { packageManager } = JSON.parse(fs.readFileSync(manifest, "utf8"));
  if (!packageManager) return [];
  return packageManager === `bun@${bunVersion}` ? [] : [`package.json packageManager is ${packageManager}; the workflows run bun@${bunVersion}`];
}

export function kitIssues(root, config = {}) {
  return [...hookIssues(root, config), ...workflowIssues(root), ...packageManagerIssues(root)];
}
