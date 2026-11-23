// What a repository's package-kit.config.mjs may import.
export { chain } from "./verify.mjs";
export { changedPaths, createMatcher, planChecks, planSmoke } from "./plan.mjs";
export { checkFileBudget, countBytes, countLines, fileBudgetConfig, formatAllowlist, parseAllowlist, parseExemptions, runFileBudget } from "./file-budget.mjs";
export { KIT_VERSION, BUN_VERSION } from "./toolchain.mjs";

/** Identity, for editors: `export default defineConfig({ ... })`. */
export function defineConfig(config) {
  return config;
}
