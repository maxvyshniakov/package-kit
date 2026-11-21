// Process table accounting, step membership, environment marks, cgroup memory and out-of-process reaper.
import { execFile, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const GiB = 1024 ** 3;
const PS_ARGS = ["-A", "-o", "pid=,ppid=,pgid=,rss="];

// Each step's environment carries REPO_KIT_STEP=<this run>.<step index>, so a
// process it starts that leaves its tree can still be told apart.
export const STEP_MARK = "REPO_KIT_STEP";

/**
 * Each step's processes in one process table ({ pid, ppid, pgid, rss } rows,
 * rss in KiB): its process group, every descendant of its first process by
 * parent pid (Chromium and agent-browser start sessions of their own, outside
 * the group), and every process an earlier sample found in it that is still
 * running (one reparented to init has left the tree). `roots` maps each running
 * step's first pid, its group, to its name; `members` (name -> Set of pids)
 * carries what earlier samples found. A child of init that no step holds and
 * `checked` has not seen is offered once to `marked` (pids -> Map of pid to
 * step name): a daemon such as agent-browser's, orphaned before any sample saw
 * it, joins the step whose REPO_KIT_STEP its environment carries. Returns
 * name -> { pids, gib }.
 */
export function stepProcesses(table, roots, members = new Map(), { marked = () => new Map(), checked = new Set() } = {}) {
  const byPid = new Map(table.map(row => [row.pid, row]));
  const children = new Map();
  for (const row of table) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row.pid]);
  const tree = (starts, pids = new Set()) => {
    const stack = starts.filter(pid => byPid.has(pid));
    while (stack.length) {
      const pid = stack.pop();
      if (pids.has(pid)) continue;
      pids.add(pid);
      stack.push(...(children.get(pid) ?? []));
    }
    return pids;
  };
  const names = new Set(roots.values());
  for (const name of members.keys()) if (!names.has(name)) members.delete(name);
  const found = new Map();
  for (const [root, name] of roots) {
    const known = [...(members.get(name) ?? [])];
    found.set(name, tree([root, ...known, ...table.filter(row => row.pgid === root).map(row => row.pid)]));
  }
  const held = new Set([...found.values()].flatMap(pids => [...pids]));
  const orphans = table.filter(row => row.ppid === 1 && !held.has(row.pid) && !checked.has(row.pid)).map(row => row.pid);
  for (const pid of orphans) checked.add(pid);
  if (orphans.length && names.size) {
    for (const [pid, name] of marked(orphans)) if (found.has(name)) tree([pid], found.get(name));
  }
  const result = new Map();
  for (const [name, pids] of found) {
    members.set(name, pids);
    let kib = 0;
    for (const pid of pids) kib += byPid.get(pid).rss;
    result.set(name, { pids, gib: (kib * 1024) / GiB });
  }
  return result;
}

/**
 * Those of `pids` whose environment carries one of `marks` (REPO_KIT_STEP
 * value -> step name), as pid -> name. Linux reads /proc/<pid>/environ, macOS
 * `ps -E`; either shows only the user's own processes (macOS: not platform
 * binaries), and the rest read as unmarked.
 */
export function markedProcesses(pids, marks, { platform = process.platform } = {}) {
  const found = new Map();
  if (!pids.length || !marks.size) return found;
  if (platform === "linux") {
    for (const pid of pids) {
      try {
        const entry = fs.readFileSync(`/proc/${pid}/environ`, "latin1").split("\0").find(item => item.startsWith(`${STEP_MARK}=`));
        const name = entry && marks.get(entry.slice(STEP_MARK.length + 1));
        if (name) found.set(pid, name);
      } catch {
        // gone, or not ours
      }
    }
    return found;
  }
  let output = "";
  try {
    output = execFileSync("ps", ["-wwE", "-o", "pid=,command=", "-p", pids.join(",")], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (error) {
    output = error.stdout ?? ""; // ps exits 1 when one of the pids is gone
  }
  for (const line of output.split("\n")) {
    const match = line.match(new RegExp(`^\\s*(\\d+) .* ${STEP_MARK}=(\\S+)(?: |$)`));
    const name = match && marks.get(match[2]);
    if (name) found.set(Number(match[1]), name);
  }
  return found;
}

/** The machine's process table, for stepProcesses. */
export function parseProcessTable(output) {
  const table = [];
  for (const line of output.split("\n")) {
    const [pid, ppid, pgid, rss] = line.trim().split(/\s+/).map(Number);
    if (pid > 0) table.push({ pid, ppid, pgid, rss: rss || 0 });
  }
  return table;
}

/**
 * The job's cgroup (cgroup v2, this process's, from /proc/self/cgroup) on
 * Linux, for the summary: the memory of everything in the job, its page cache
 * included. memory.peak is reset for this reader where the kernel allows it
 * (6.12 and later), so it covers this run alone; elsewhere the samples of
 * memory.current give the peak. `sample()` takes one, `stop()` returns { gib,
 * source }. Undefined off Linux and where the cgroup has no memory files.
 */
export function cgroupMemory({ proc = "/proc/self/cgroup", root = "/sys/fs/cgroup" } = {}) {
  let group;
  try {
    group = fs.readFileSync(proc, "utf8").split("\n").find(line => line.startsWith("0::"))?.slice(3).trim();
  } catch {
    return undefined;
  }
  if (!group) return undefined;
  const dir = path.join(root, group);
  const read = file => {
    try {
      const bytes = Number.parseInt(fs.readFileSync(path.join(dir, file), "utf8"), 10);
      return Number.isFinite(bytes) ? bytes : undefined;
    } catch {
      return undefined;
    }
  };
  if (read("memory.current") === undefined) return undefined;
  let peakFd;
  try {
    peakFd = fs.openSync(path.join(dir, "memory.peak"), "r+");
    fs.writeSync(peakFd, "reset\n");
  } catch {
    if (peakFd !== undefined) fs.closeSync(peakFd);
    peakFd = undefined;
  }
  let sampled = 0;
  return {
    path: group,
    sample() {
      sampled = Math.max(sampled, read("memory.current") ?? 0);
    },
    stop() {
      this.sample();
      if (peakFd !== undefined) {
        try {
          const buffer = Buffer.alloc(64);
          const bytes = Number.parseInt(buffer.toString("utf8", 0, fs.readSync(peakFd, buffer, 0, 64, 0)), 10);
          if (Number.isFinite(bytes)) return { gib: Math.max(bytes, sampled) / GiB, source: "memory.peak" };
        } catch {
          // fall back to the samples
        } finally {
          fs.closeSync(peakFd);
          peakFd = undefined;
        }
      }
      return { gib: sampled / GiB, source: "memory.current" };
    },
  };
}

/**
 * Samples the resident memory of every running step's processes
 * (stepProcesses) once a second, and the job's cgroup where there is one;
 * `stop()` returns the highest total (GiB), each step's share of it, each
 * step's own peak (`each`), the figure its `memory` declares, and the cgroup's
 * peak (`cgroup`).
 */
export function sampleMemory(roots, marks, { cgroup = cgroupMemory() } = {}) {
  let peak = { total: 0, steps: {} };
  const each = {};
  const members = new Map();
  const checked = new Set();
  const marked = pids => markedProcesses(pids, marks);
  const sample = () => {
    cgroup?.sample();
    execFile("ps", PS_ARGS, (error, output) => {
      if (error) return;
      const steps = {};
      for (const [name, { gib }] of stepProcesses(parseProcessTable(output), roots, members, { marked, checked })) {
        steps[name] = gib;
        each[name] = Math.max(each[name] ?? 0, gib);
      }
      const total = Object.values(steps).reduce((sum, gib) => sum + gib, 0);
      if (total > peak.total) peak = { total, steps };
    });
  };
  const timer = setInterval(sample, 1000);
  timer.unref();
  return {
    /** Every process step `name` runs now, read at once: to stop all of them. */
    processes(name) {
      const root = [...roots].find(([, step]) => step === name)?.[0];
      try {
        const table = parseProcessTable(execFileSync("ps", PS_ARGS, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
        return [...(stepProcesses(table, roots, members, { marked, checked }).get(name)?.pids ?? [root])];
      } catch {
        return root ? [root] : [];
      }
    },
    stop: () => {
      clearInterval(timer);
      return { ...peak, each, cgroup: cgroup && { path: cgroup.path, ...cgroup.stop() } };
    },
  };
}

// Runs beside verify in its own process group and reads the step groups verify
// starts ("+pgid") and ends ("-pgid") from its stdin. When that pipe closes
// before "done", verify itself died, SIGKILL included, which no handler sees:
// the reaper stops every step group still listed, SIGKILL after 5 s.
const REAPER = `
const groups = new Set();
let done = false;
let pending = "";
const signal = (name) => { for (const group of groups) { try { process.kill(-group, name); } catch {} } };
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  const lines = (pending + chunk).split("\\n");
  pending = lines.pop();
  for (const line of lines) {
    if (line === "done") done = true;
    else if (line[0] === "+") groups.add(Number(line.slice(1)));
    else if (line[0] === "-") groups.delete(Number(line.slice(1)));
  }
});
process.stdin.on("end", () => {
  if (done || !groups.size) return;
  signal("SIGTERM");
  setTimeout(() => signal("SIGKILL"), 5000);
});
`;

/** Starts the reaper; `add`/`remove` report step groups, `done` releases it. */
export function startReaper() {
  const reaper = spawn(process.execPath, ["-e", REAPER], { stdio: ["pipe", "ignore", "ignore"], detached: true });
  reaper.unref();
  reaper.stdin.on("error", () => {});
  reaper.stdin.unref?.();
  return {
    add: pgid => reaper.stdin.write(`+${pgid}\n`),
    remove: pgid => reaper.stdin.write(`-${pgid}\n`),
    done: () => reaper.stdin.end("done\n"),
  };
}
