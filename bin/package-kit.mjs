#!/usr/bin/env node
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { main } from "../src/cli.mjs";

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const code = await main(process.argv.slice(2));
    if (code !== undefined) process.exitCode = code;
  } catch (error) {
    console.error(`package-kit: ${error.message}`);
    process.exitCode = 1;
  }
}
export { main };
