// Rust toolchain pin preflight (`repo-kit rust toolchain`), decoupled from
// project-specific builder scripts.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PIN_FILE = "rust-toolchain.toml";
const VERSION_RE = /^(rustc|cargo) (\d+\.\d+\.\d+)(?:\s|$)/;

export class Refusal extends Error {
  constructor(message) {
    super(message);
    this.name = "Refusal";
  }
}

/** Minimal TOML parser for `rust-toolchain.toml`, `Cargo.toml`, and `.cargo/config.toml`. */
export function parseToml(text) {
  const root = {};
  let current = root;
  const stripComment = line => {
    let quote = null;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quote) {
        if (ch === "\\" && quote === '"') i++;
        else if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "#") return line.slice(0, i);
    }
    if (quote) throw new Error("unterminated string in TOML");
    return line;
  };
  const splitTop = (input, sep) => {
    const parts = [];
    let quote = null, depth = 0, start = 0;
    for (let i = 0; i < input.length; i++) {
      const ch = input[i];
      if (quote) {
        if (ch === "\\" && quote === '"') i++;
        else if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "[" || ch === "{") depth++;
      else if (ch === "]" || ch === "}") depth--;
      else if (ch === sep && depth === 0) {
        parts.push(input.slice(start, i));
        start = i + 1;
      }
    }
    if (quote || depth !== 0) throw new Error("unbalanced TOML expression");
    parts.push(input.slice(start));
    return parts;
  };
  const parseValue = raw => {
    const val = raw.trim();
    if (!val) throw new Error("empty TOML value");
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      return val[0] === '"' ? JSON.parse(val) : val.slice(1, -1);
    }
    if (val === "true") return true;
    if (val === "false") return false;
    if (/^-?\d+(?:\.\d+)?$/.test(val)) return Number(val);
    if (val.startsWith("[") && val.endsWith("]")) {
      const inner = val.slice(1, -1).trim();
      return inner ? splitTop(inner, ",").map(s => s.trim()).filter(Boolean).map(parseValue) : [];
    }
    if (val.startsWith("{") && val.endsWith("}")) {
      const inner = val.slice(1, -1).trim();
      const obj = {};
      if (!inner) return obj;
      for (const entry of splitTop(inner, ",").map(s => s.trim()).filter(Boolean)) {
        const eq = entry.indexOf("=");
        if (eq <= 0) throw new Error(`invalid TOML inline table entry: ${entry}`);
        obj[entry.slice(0, eq).trim().replace(/^["']|["']$/g, "")] = parseValue(entry.slice(eq + 1));
      }
      return obj;
    }
    throw new Error(`unsupported TOML value: ${val}`);
  };
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = stripComment(lines[i]).trim();
    if (!line) continue;
    while ((line.includes("=[") || line.includes("= [")) && !line.endsWith("]") && i + 1 < lines.length) {
      line += " " + stripComment(lines[++i]).trim();
    }
    if (line.startsWith("[[") && line.endsWith("]]")) { current = {}; continue; }
    if (line.startsWith("[") && line.endsWith("]")) {
      const section = line.slice(1, -1).trim();
      if (!section) throw new Error("empty TOML section header");
      current = root;
      for (const part of section.split(".")) {
        const key = part.trim().replace(/^["']|["']$/g, "");
        if (typeof current[key] !== "object" || current[key] === null || Array.isArray(current[key])) current[key] = {};
        current = current[key];
      }
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) throw new Error(`invalid TOML line: ${line}`);
    current[line.slice(0, eq).trim().replace(/^["']|["']$/g, "")] = parseValue(line.slice(eq + 1));
  }
  return root;
}

export function pinned(root, { pinFile = PIN_FILE } = {}) {
  const file = path.join(root, pinFile);
  let channel;
  try {
    channel = parseToml(fs.readFileSync(file, "utf8"))?.toolchain?.channel;
    if (channel === undefined) throw new Error("missing [toolchain] channel");
  } catch (error) {
    const missing = error?.code === "ENOENT" ? `${pinFile} is missing` : error.message;
    throw new Refusal(`environment: toolchain not pinned: ${file} names no [toolchain] channel (${missing})`);
  }
  if (typeof channel !== "string" || !/^\d+\.\d+\.\d+$/.test(channel)) {
    throw new Refusal(`environment: toolchain not pinned: ${pinFile} must pin an exact release such as 1.98.1, not ${JSON.stringify(channel)}`);
  }
  return channel;
}

/**
 * Hash and extract executable settings from the Cargo configuration chain
 * (ancestor `.cargo/config[.toml]` and `$CARGO_HOME/config[.toml]`), decoupled
 * from project-specific builders. Never exposes arbitrary config values.
 */
export function cargoConfiguration(root, env = process.env) {
  const dirs = [];
  for (let cur = path.resolve(root); ; ) {
    dirs.push(path.join(cur, ".cargo"));
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  const homeRaw = env.CARGO_HOME || path.join(env.HOME || os.homedir(), ".cargo");
  dirs.push(path.isAbsolute(homeRaw) ? homeRaw : path.resolve(root, homeRaw));
  const selected = [];
  for (const dir of dirs) {
    for (const name of ["config", "config.toml"]) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        selected.push(fs.realpathSync(candidate));
        break;
      }
    }
  }
  const hashes = {}, settingsCache = {}, active = new Set();
  const visit = (filePath, optional = false) => {
    const resolved = fs.existsSync(filePath) ? fs.realpathSync(filePath) : path.resolve(filePath);
    if (active.has(resolved)) throw new Error(`Cargo configuration include cycle: ${resolved}`);
    if (resolved in hashes) return settingsCache[resolved];
    if (optional && !fs.existsSync(resolved)) return (hashes[resolved] = null), (settingsCache[resolved] = {});
    let data, config;
    try {
      data = fs.readFileSync(resolved);
      config = parseToml(data.toString("utf8"));
    } catch {
      throw new Error(`Cannot read Cargo configuration: ${resolved}`);
    }
    hashes[resolved] = crypto.createHash("sha256").update(data).digest("hex");
    active.add(resolved);
    const includes = config.include ?? [];
    if (!Array.isArray(includes)) throw new Error(`Invalid Cargo configuration include list: ${resolved}`);
    const settings = {};
    for (const entry of includes) {
      let child, optionalChild = false;
      if (typeof entry === "string") child = entry;
      else if (entry && typeof entry === "object" && typeof entry.path === "string") {
        child = entry.path;
        optionalChild = Boolean(entry.optional);
      } else throw new Error(`Invalid Cargo configuration include: ${resolved}`);
      Object.assign(settings, visit(path.join(path.dirname(resolved), child), optionalChild));
    }
    const build = config.build ?? {};
    for (const name of ["rustc", "rustc-wrapper", "rustc-workspace-wrapper"]) {
      if (name in build) {
        if (typeof build[name] !== "string") throw new Error(`Invalid Cargo build executable setting: ${resolved}`);
        settings[name] = [build[name], path.dirname(path.dirname(resolved))];
      }
    }
    active.delete(resolved);
    settingsCache[resolved] = settings;
    return settings;
  };
  const effective = {};
  for (const file of [...selected].reverse()) Object.assign(effective, visit(file));
  return { hashes, settings: effective };
}

export function cargoBuildRustc(root, env = process.env) {
  try { return cargoConfiguration(root, env).settings.rustc; }
  catch (error) { throw new Refusal(`environment: toolchain not pinned: cannot read Cargo's configuration: ${error.message}`); }
}

export function compiler(root, env = process.env) {
  for (const name of ["RUSTC", "CARGO_BUILD_RUSTC"]) if (name in env) return [name, env[name], root];
  const configured = cargoBuildRustc(root, env);
  return configured ? ["build.rustc", configured[0], configured[1]] : ["PATH", "rustc", root];
}

export function locate(command, base, env = process.env) {
  if (!command) return null;
  const check = file => {
    try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile() ? file : null; }
    catch { return null; }
  };
  if (command.includes("/") || command.includes(path.sep)) {
    return check(path.isAbsolute(command) ? command : path.join(base, command));
  }
  for (const dir of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const found = check(path.join(dir, command));
    if (found) return found;
  }
  return null;
}

export function probe(name, toolPath, root, env = process.env) {
  if (!toolPath) return { line: `${name}: not found`, version: null, path: null };
  const res = spawnSync(toolPath, ["--version"], {
    cwd: root, env: { ...env, RUSTUP_AUTO_INSTALL: "0" }, encoding: "utf8", timeout: 60_000,
  });
  if (res.error) return { line: `${name}: ${res.error.message}`, version: null, path: toolPath };
  const lines = (res.status === 0 ? res.stdout ?? "" : "").trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) {
    const detail = (res.stderr ?? "").trim().split(/\r?\n/).filter(Boolean).at(-1) || `exit ${res.status}`;
    return { line: `${name}: ${detail}`, version: null, path: toolPath };
  }
  const match = lines[0].match(VERSION_RE);
  return { line: lines[0], version: match && match[1] === name ? match[2] : null, path: toolPath };
}

export function served(root, env, selected) {
  const [, command, base] = selected;
  return {
    rustc: probe("rustc", locate(command, base, env), root, env),
    cargo: probe("cargo", locate("cargo", root, env), root, env),
  };
}

export function currentToolchain(root, env = process.env) {
  const selected = compiler(root, env);
  const found = served(root, env, selected);
  const result = { rustc_origin: selected[0] };
  for (const [name, tool] of Object.entries(found)) {
    result[name] = tool.line;
    result[`${name}_path`] = tool.path && fs.existsSync(tool.path) ? fs.realpathSync(tool.path) : null;
  }
  return result;
}

export function candidates(pin, env = process.env) {
  const cargoHome = env.CARGO_HOME || path.join(env.HOME || os.homedir(), ".cargo");
  const prefixes = env.HOMEBREW_PREFIX ? [env.HOMEBREW_PREFIX] : ["/opt/homebrew", "/usr/local"];
  return [
    ["PATH", null],
    ["rustup", path.join(cargoHome, "bin")],
    ...prefixes.map(prefix => ["rustup", path.join(prefix, "opt/rustup/bin")]),
    ...prefixes.map(prefix => ["homebrew-keg", path.join(prefix, "Cellar/rust", pin, "bin")]),
  ];
}

function fixMessage(pin, origin) {
  if (origin !== "PATH") return `${origin} selects that compiler: unset it, or point it at a Rust ${pin} rustc.`;
  return [
    "When Homebrew moved Rust, bump rust-toolchain.toml and the rust:<version>-bookworm images together (docs/development.md#rust-toolchain).",
    "Or install the pinned toolchain once; Homebrew's rust formula stays as it is:",
    `  brew install rustup && "$(brew --prefix rustup)/bin/rustup" toolchain install ${pin} --profile minimal`,
    `Without Homebrew, install rustup (https://rustup.rs), then: rustup toolchain install ${pin} --profile minimal`,
  ].join("\n");
}

export function resolveToolchain(root, env = process.env, { pinFile = PIN_FILE } = {}) {
  const pin = pinned(root, { pinFile });
  const selected = compiler(root, env);
  let first = null;
  for (const [source, directory] of candidates(pin, env)) {
    if (directory && (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory())) continue;
    const activated = directory ? { ...env, PATH: `${directory}${path.delimiter}${env.PATH ?? ""}` } : { ...env };
    const found = served(root, activated, selected);
    first = first ?? found;
    if (Object.values(found).every(tool => tool.version === pin)) {
      return { pinned: pin, source, bin: directory ?? "", current: currentToolchain(root, activated) };
    }
  }
  const [origin, command] = selected;
  const where = origin === "PATH" ? "rustc on PATH" : `${origin} = ${command}`;
  const serves = Object.values(first ?? {}).map(tool => `${tool.line} (${tool.path ?? "missing"})`).join(", ");
  throw new Refusal(
    `environment: toolchain not pinned: ${pinFile} pins Rust ${pin}, the Linux packages' rust:${pin}-bookworm, `
    + `but Cargo's compiler (${where}) and cargo serve ${serves}, and no rustup toolchain or Homebrew keg serves ${pin}.\n`
    + fixMessage(pin, origin),
  );
}
