// Declared-minimum Rust (`rust-version`) check in a pinned Linux container (`repo-kit rust msrv`).
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { projectName } from "../slotfather.mjs";
import { flock } from "./cache.mjs";
import { parseToml } from "./toolchain.mjs";

export const DEFAULT_TOOLCHAIN = "1.98.1";
export const DEFAULT_IMAGE = `rust:${DEFAULT_TOOLCHAIN}-bookworm`;
export const DEFAULT_DECLARED = "1.98";
export const UNRUN = 77;
export const KEEP_TARGETS = 2;

const TESTING_RE = /^rust-msrv: testing (\S+)$/;
const RESULT_RE = /^test result: \w+\. (\d+) passed; (\d+) failed/;

export function defaultMsrvCache(root = process.cwd(), env = process.env) {
  const override = env.REPO_KIT_RUST_MSRV_CACHE || env.STRAYLIGHT_RUST_MSRV_CACHE;
  if (override) return path.resolve(override);
  const project = projectName(root);
  if (process.platform === "darwin") {
    return path.join(env.HOME || os.homedir(), "Library/Caches", project, "rust-msrv");
  }
  const base = env.XDG_CACHE_HOME || path.join(env.HOME || os.homedir(), ".cache");
  return path.join(base, project, "rust-msrv");
}

export function resolveMsrvConfig(root, config = {}, overrides = {}) {
  const rustCfg = config?.rust ?? {};
  const msrvCfg = typeof rustCfg.msrv === "object" && rustCfg.msrv !== null ? rustCfg.msrv : {};
  const toolchain = overrides.toolchain ?? msrvCfg.toolchain ?? rustCfg.toolchain
    ?? (overrides.image ?? msrvCfg.image ?? rustCfg.image)?.match(/^rust:(\d+\.\d+\.\d+)/)?.[1]
    ?? DEFAULT_TOOLCHAIN;
  const image = overrides.image ?? msrvCfg.image ?? rustCfg.image ?? `rust:${toolchain}-bookworm`;
  const declared = overrides.declared
    ?? (typeof rustCfg.msrv === "string" ? rustCfg.msrv : undefined)
    ?? msrvCfg.declared ?? msrvCfg.version ?? rustCfg.rustVersion
    ?? toolchain.split(".").slice(0, 2).join(".");
  const crateDir = overrides.crateDir ?? msrvCfg.crateDir ?? rustCfg.crateDir ?? "native";
  let crates = overrides.crates ?? msrvCfg.crates ?? rustCfg.crates;
  if (!crates?.length) {
    const dir = path.join(root, crateDir);
    if (fs.existsSync(dir)) {
      const discovered = fs.readdirSync(dir, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, "Cargo.toml")))
        .map(entry => entry.name)
        .sort();
      const preferred = ["straylight-link-linux", "straylight-core", "ulanzi-codec"];
      crates = preferred.every(c => discovered.includes(c)) ? preferred : discovered;
    } else {
      crates = ["straylight-link-linux", "straylight-core", "ulanzi-codec"];
    }
  }
  const aptPackages = overrides.aptPackages ?? msrvCfg.aptPackages ?? rustCfg.aptPackages ?? ["cmake"];
  const cleanCommands = overrides.cleanCommands ?? msrvCfg.cleanCommands;
  const buildCommands = overrides.buildCommands ?? msrvCfg.buildCommands;
  return { toolchain, image, declared, crateDir, crates, aptPackages, cleanCommands, buildCommands };
}

export function declarationErrors(root, { crateDir = "native", manifests, declared = DEFAULT_DECLARED, image = DEFAULT_IMAGE } = {}) {
  let files = manifests;
  if (!files) {
    const base = path.join(root, crateDir);
    files = fs.existsSync(base)
      ? fs.readdirSync(base, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && fs.existsSync(path.join(base, entry.name, "Cargo.toml")))
        .map(entry => path.join(base, entry.name, "Cargo.toml"))
        .sort()
      : [];
  }
  if (!files.length) return [`no Rust crates under ${crateDir}/`];
  const errors = [];
  for (const manifest of files) {
    let rustVersion = null;
    try {
      rustVersion = parseToml(fs.readFileSync(manifest, "utf8"))?.package?.["rust-version"] ?? null;
    } catch {
      rustVersion = null;
    }
    if (rustVersion !== declared) {
      const rel = path.relative(root, manifest).split(path.sep).join("/");
      const fmt = v => (v === null || v === undefined ? "None" : `'${v}'`);
      errors.push(`${rel} declares rust-version ${fmt(rustVersion)}; ${image} checks ${fmt(declared)}`);
    }
  }
  return errors;
}

export function platformAndTarget(arch = os.machine?.() ?? process.arch) {
  if (["arm64", "aarch64"].includes(String(arch).toLowerCase())) {
    return ["linux/arm64", "aarch64-unknown-linux-gnu"];
  }
  return ["linux/amd64", "x86_64-unknown-linux-gnu"];
}

export function countsLine(crates, counts) {
  const parts = crates.map(crate => {
    const label = path.basename(crate);
    if (!(label in counts) && !(crate in counts)) return `${label} not run`;
    const [passed, failed] = counts[label] ?? counts[crate];
    return `${label} ${passed} passed${failed ? `, ${failed} failed` : ""}`;
  });
  return `rust-msrv: Linux tests: ${parts.join(", ")}`;
}

export function containerScript({
  crates,
  crateDir = "native",
  target,
  aptPackages = ["cmake"],
  cleanCommands,
  buildCommands,
} = {}) {
  const manifestOf = crate => (crate.includes("/") ? `${crate}/Cargo.toml` : `${crateDir}/${crate}/Cargo.toml`);
  const nameOf = crate => path.basename(crate);
  const crateNames = crates.map(nameOf);
  const cleans = cleanCommands ?? (
    crateNames.join(",") === "straylight-link-linux,straylight-core,ulanzi-codec"
      ? [
          `cargo clean --locked --offline -p straylight-link-linux --manifest-path ${crateDir}/straylight-link-linux/Cargo.toml`,
          `cargo clean --locked --offline -p straylight-core -p ulanzi-codec --manifest-path ${crateDir}/straylight-core/Cargo.toml`,
          `cargo clean --locked --offline -p ulanzi-codec --manifest-path ${crateDir}/ulanzi-codec/Cargo.toml`,
        ]
      : crates.map(crate => `cargo clean --locked --offline -p ${nameOf(crate)} --manifest-path ${manifestOf(crate)}`)
  );
  const builds = buildCommands ?? (
    crateNames.includes("straylight-core")
      ? [`cargo build --locked --offline --lib --manifest-path ${crateDir}/straylight-core/Cargo.toml`]
      : []
  );
  const tests = crates.flatMap(crate => [
    `echo "rust-msrv: testing ${nameOf(crate)}"`,
    `cargo test --locked --offline --manifest-path ${manifestOf(crate)}`,
  ]);
  const aptLines = aptPackages.length
    ? [
        "apt-get update -qq",
        `DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends ${aptPackages.join(" ")} >/dev/null`,
      ]
    : [];
  const fetchBlock = crates.every(c => !c.includes("/"))
    ? [
        `for crate in ${crateNames.join(" ")}; do`,
        `  cargo fetch --locked --target ${target} --manifest-path ${crateDir}/$crate/Cargo.toml`,
        "done",
      ]
    : crates.map(crate => `cargo fetch --locked --target ${target} --manifest-path ${manifestOf(crate)}`);
  return [
    "set -eu",
    'compiler="$(rustc --version)"',
    'echo "$compiler"',
    'case "$compiler" in',
    '  "rustc $RUSTUP_TOOLCHAIN "*) ;;',
    '  *) echo "rust-msrv: the container runs $compiler, not $RUSTUP_TOOLCHAIN" >&2; exit 1 ;;',
    "esac",
    ...aptLines,
    ...fetchBlock,
    ...cleans,
    ...tests,
    ...builds,
    "",
  ].join("\n");
}

export function targetTree(root, cache, dockerPlatform, { image = DEFAULT_IMAGE, crates = [], crateDir = "native", locks } = {}) {
  const lockPaths = locks ?? crates.map(crate => (crate.includes("/") ? `${crate}/Cargo.lock` : `${crateDir}/${crate}/Cargo.lock`));
  const hash = crypto.createHash("sha256");
  hash.update(`${image}\0${dockerPlatform}`);
  for (const lock of lockPaths) {
    const full = path.join(root, lock);
    hash.update("\0");
    hash.update(fs.existsSync(full) && fs.statSync(full).isFile() ? fs.readFileSync(full) : Buffer.from("missing"));
  }
  const target = path.join(cache, "targets", hash.digest("hex").slice(0, 16));
  fs.mkdirSync(target, { recursive: true });
  const now = new Date();
  fs.utimesSync(target, now, now);
  return target;
}

export function evictTargets(cache, current, keepTargets = KEEP_TARGETS) {
  const targetsDir = path.join(cache, "targets");
  if (!fs.existsSync(targetsDir)) return;
  const resolvedCurrent = path.resolve(current);
  const trees = fs.readdirSync(targetsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && path.resolve(targetsDir, entry.name) !== resolvedCurrent)
    .map(entry => {
      const full = path.join(targetsDir, entry.name);
      return { full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  for (const stale of trees.slice(keepTargets - 1)) {
    fs.rmSync(stale.full, { recursive: true, force: true });
  }
}

function quiet(cmd, args, env) {
  const res = spawnSync(cmd, args, { env, stdio: "ignore", timeout: 60_000 });
  return res.status === 0;
}

export async function relayContainer(command, crates, { env = process.env, stdout = process.stdout } = {}) {
  const counts = {};
  let current = null;
  return new Promise(resolve => {
    const child = spawn(command[0], command.slice(1), { env, stdio: ["ignore", "pipe", "inherit"] });
    let pending = "";
    const handleLine = line => {
      stdout.write(`${line}\n`);
      const testMatch = line.match(TESTING_RE);
      if (testMatch) {
        current = testMatch[1];
        counts[current] = [0, 0];
        return;
      }
      if (current) {
        const resMatch = line.match(RESULT_RE);
        if (resMatch) {
          counts[current][0] += Number(resMatch[1]);
          counts[current][1] += Number(resMatch[2]);
        }
      }
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      const lines = (pending + chunk).split("\n");
      pending = lines.pop();
      for (const line of lines) handleLine(line);
    });
    child.on("close", code => {
      if (pending) handleLine(pending);
      stdout.write(`${countsLine(crates, counts)}\n`);
      resolve(code ?? 1);
    });
    child.on("error", () => {
      stdout.write(`${countsLine(crates, counts)}\n`);
      resolve(1);
    });
  });
}

export async function runMsrv(root, { cache, config, env = process.env, stdout = process.stdout, stderr = process.stderr, ...overrides } = {}) {
  const resolvedRoot = fs.realpathSync(root);
  const resolvedCache = path.resolve(cache ?? defaultMsrvCache(resolvedRoot, env));
  const settings = resolveMsrvConfig(resolvedRoot, config, overrides);
  const errors = declarationErrors(resolvedRoot, settings);
  if (errors.length) {
    for (const err of errors) stderr.write(`rust-msrv: ${err}\n`);
    return 1;
  }
  const [dockerPlatform, target] = platformAndTarget();
  if (!quiet("docker", ["info"], env)) {
    stdout.write("rust-msrv: unrun: Docker is unavailable (no docker CLI or daemon); the declared Rust minimum was not checked\n");
    return UNRUN;
  }
  if (!quiet("docker", ["image", "inspect", settings.image], env)) {
    stdout.write(`rust-msrv: unrun: image ${settings.image} is not present; fetch it with: docker pull --platform ${dockerPlatform} ${settings.image}\n`);
    return UNRUN;
  }
  const cargoHome = path.join(resolvedCache, "cargo-home");
  fs.mkdirSync(cargoHome, { recursive: true });
  const containerName = `repo-kit-rust-msrv-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const lockFile = path.join(resolvedCache, "lock");
  const lockFd = fs.openSync(lockFile, "w");
  try {
    if (!flock(lockFd, { nonblock: true })) {
      stdout.write(`rust-msrv: waiting for another run to release ${resolvedCache}\n`);
      flock(lockFd);
    }
    const tree = targetTree(resolvedRoot, resolvedCache, dockerPlatform, settings);
    evictTargets(resolvedCache, tree);
    const passed = ["CARGO_BUILD_JOBS", "RUST_TEST_THREADS"]
      .filter(key => key in env)
      .flatMap(key => ["-e", `${key}=${env[key]}`]);
    const script = containerScript({ ...settings, target });
    const command = [
      "docker", "run", "--rm", "--init", "--name", containerName, "--platform", dockerPlatform,
      "-v", `${resolvedRoot}:/work:ro`, "-v", `${cargoHome}:/cargo-home`, "-v", `${tree}:/target`,
      "-e", "CARGO_HOME=/cargo-home", "-e", "CARGO_TARGET_DIR=/target",
      "-e", `RUSTUP_TOOLCHAIN=${settings.toolchain}`, "-e", "RUSTUP_AUTO_INSTALL=0",
      "-e", "CARGO_PROFILE_DEV_DEBUG=0", "-e", "CARGO_INCREMENTAL=0",
      ...passed,
      "-w", "/work", settings.image, "sh", "-c", script,
    ];
    stdout.write(`rust-msrv: ${settings.image} (${dockerPlatform}) target=${tree}\n`);
    return await relayContainer(command, settings.crates, { env, stdout });
  } finally {
    fs.closeSync(lockFd);
  }
}
