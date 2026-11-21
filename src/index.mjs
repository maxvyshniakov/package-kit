// What a repository's repo-kit.config.mjs may import.
export { chain } from "./verify.mjs";
export { changedPaths, createMatcher, planChecks, planSmoke } from "./plan.mjs";
export { KIT_VERSION, BUN_VERSION } from "./toolchain.mjs";

/** Identity, for editors: `export default defineConfig({ ... })`. */
export function defineConfig(config) {
  return config;
}
