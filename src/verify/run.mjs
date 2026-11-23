// Step process launch with timeouts (`startProcess`) and verify summary printing.
import { spawn } from "node:child_process";

import { runSlots, withoutYield } from "../slotfather.mjs";
import { STEP_MARK } from "./processes.mjs";

// Lines of a failed step's output shown again under the summary.
export const FAILURE_TAIL_LINES = 80;

// After a timeout's SIGTERM, how long a step's processes get before SIGKILL,
// and how long its output may stay open after that (a process outside its
// tree can hold it) before verify stops waiting.
const KILL_GRACE_MS = 5000;
const CLOSE_GRACE_MS = 2000;

/** Splits a stream into lines and hands each complete one to `line`; `flush` hands over the rest. */
function lineReader(line) {
  let pending = "";
  return {
    push(chunk) {
      const lines = (pending + chunk).split("\n");
      pending = lines.pop();
      for (const text of lines) line(text);
    },
    flush() {
      if (pending) line(pending);
      pending = "";
    },
  };
}

/** Sends `signal` to a step's process group and to every process `processes()` finds in it. */
export function signalStep(pid, processes, signal) {
  for (const target of [-pid, ...processes()]) {
    try {
      process.kill(target, signal);
    } catch {
      // already gone
    }
  }
}

export function startProcess(step, { root, running, mark, processes = () => [], onLine = () => {}, environment = process.env }) {
  const env = { ...withoutYield(environment), [STEP_MARK]: mark };
  if (step.workers) env.VITEST_MAX_WORKERS = env.PACKAGE_KIT_WORKERS = String(step.workers);
  if (step.slots) env.PACKAGE_KIT_STEP_SLOTS = String(Math.min(step.slots, runSlots(environment)));
  // Each step gets its own process group, so stopping it reaches its workers too.
  const child = spawn("bun", step.command, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  // Output streams live, each line prefixed with its step, so a step that hangs is visible.
  const tail = [];
  const write = text => {
    process.stdout.write(`[${step.name}] ${text}\n`);
    onLine(step, text);
    tail.push(text);
    if (tail.length > FAILURE_TAIL_LINES) tail.shift();
  };
  const readers = [child.stdout, child.stderr].map(stream => {
    const reader = lineReader(write);
    stream.setEncoding("utf8");
    stream.on("data", chunk => reader.push(chunk));
    return reader;
  });
  const handle = {
    step,
    pid: child.pid,
    stopped: false,
    tail,
    stop(signal = "SIGTERM") {
      handle.stopped = true;
      signalStep(child.pid, processes, signal);
    },
  };
  const started = Date.now();
  const timers = [];
  handle.done = new Promise(resolve => {
    let ended = false;
    const finish = passed => {
      if (ended) return;
      ended = true;
      for (const timer of timers) clearTimeout(timer);
      for (const reader of readers) reader.flush();
      running.delete(handle);
      resolve(passed);
    };
    // A step past its timeout fails, and its whole tree is stopped: SIGTERM,
    // then SIGKILL. Its output may stay open in a process outside the tree, so
    // verify stops waiting for it a little after that.
    // Past setTimeout's range (about 24 days), Infinity included, is no limit.
    if (step.timeout > 0 && step.timeout * 60_000 < 2 ** 31) {
      timers.push(setTimeout(() => {
        // A step stopped already that still runs is killed the same way.
        if (!handle.stopped) {
          handle.timedOut = ((Date.now() - started) / 1000).toFixed(1);
          write(`timed out after ${handle.timedOut}s (timeout: ${step.timeout} min); stopping its processes`);
        }
        signalStep(child.pid, processes, "SIGTERM");
        timers.push(setTimeout(() => {
          signalStep(child.pid, processes, "SIGKILL");
          timers.push(setTimeout(() => {
            for (const stream of [child.stdout, child.stderr]) stream.destroy();
            finish(false);
          }, CLOSE_GRACE_MS));
        }, KILL_GRACE_MS));
      }, step.timeout * 60_000));
    }
    child.on("error", error => {
      write(String(error.stack));
      finish(false);
    });
    // A stopped command may handle SIGTERM and exit zero without finishing its work.
    child.on("close", code => finish(code === 0 && !handle.timedOut && !handle.stopped));
  });
  running.add(handle);
  return handle;
}

/** Prints failed step tails, per-step statuses, memory peaks, and total duration; returns whether the run failed. */
export function printSummary({ steps, results, tails, handles, peak, started }) {
  for (const { name, timedOut } of results.filter(result => result.status === "fail")) {
    const how = timedOut ? `timed out after ${handles.get(name).timedOut}s` : "failed";
    console.log(`\n=== ${name} ${how}; its last ${FAILURE_TAIL_LINES} lines:`);
    for (const line of tails.get(name)) console.log(line);
  }
  console.log("\nverify:");
  const symbol = { ok: "ok  ", fail: "FAIL", stopped: "stop" };
  for (const { name, status, seconds, timedOut, reused: wasReused } of results) {
    const detail = wasReused ? "reused" : `${seconds.toFixed(1)}s${timedOut ? ", timed out" : ""}`;
    console.log(`  ${symbol[status]} ${name} (${detail})`);
  }
  for (const { name } of steps.filter(step => !results.some(result => result.name === step.name))) console.log(`  skip ${name}`);
  const failed = results.length < steps.length || results.some(result => result.status !== "ok");
  const shares = Object.entries(peak.steps).filter(([, gib]) => gib > 0).sort((a, b) => b[1] - a[1])
    .map(([name, gib]) => `${name} ${gib.toFixed(1)}`).join(", ");
  if (peak.total > 0) console.log(`Peak RSS ${peak.total.toFixed(1)} GiB${shares ? ` (${shares})` : ""}, sampled every second`);
  const declared = new Map(steps.map(step => [step.name, step.memory]));
  const eachPeak = Object.entries(peak.each).filter(([, gib]) => gib > 0).sort((a, b) => b[1] - a[1])
    .map(([name, gib]) => `${name} ${gib.toFixed(1)}/${declared.get(name).toFixed(1)}`).join(", ");
  if (eachPeak) console.log(`Step peaks, measured/declared GiB: ${eachPeak}`);
  if (peak.cgroup?.gib > 0) console.log(`Job cgroup peak ${peak.cgroup.gib.toFixed(1)} GiB (${peak.cgroup.source} of ${peak.cgroup.path}, page cache included)`);
  console.log(`${failed ? "Failed" : "Passed"} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return failed;
}
