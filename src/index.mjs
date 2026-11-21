// What a repository's repo-kit.config.mjs may import.
export { chain } from "./verify.mjs";
export { changedPaths, createMatcher, planChecks, planSmoke } from "./plan.mjs";
export { applyAdoptPlan, chooseCompatibleSet, discoverConsumerPins, EXIT_UPDATES_AVAILABLE, formatAdoptLine, parseAdoptArgs, planAdopt, runAdopt } from "./adopt.mjs";
export { checkFileBudget, countBytes, countLines, fileBudgetConfig, formatAllowlist, parseAllowlist, parseExemptions, runFileBudget } from "./file-budget.mjs";
export { KIT_VERSION, BUN_VERSION } from "./toolchain.mjs";

/** Identity, for editors: `export default defineConfig({ ... })`. */
export function defineConfig(config) {
  return config;
}
