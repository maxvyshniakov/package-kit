// Shared STP lock, extracted from Data Grid safari-real-bounce (5f3823488).
// Keep the historical path to serialize with existing canonical harnesses.
import * as fs from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const LOCK_FILE = join(tmpdir(), "data-grid-safari-bounce.lock");

const alive = pid => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
};

/**
 * The lock's owners: the entries of the lock directory, each named after its run's pid. A plain file at the
 * lock's path is an earlier version's lock, which holds its pid. A path that changes under the read (gone, or a
 * file replaced by a run's directory) has no owners to judge: the caller tries the rename again.
 */
function lockOwners(file, io) {
  try {
    if (!io.lstatSync(file).isDirectory()) {
      return [{ path: file, name: "legacy", pid: Number(io.readFileSync(file, "utf8").trim()) || 0, legacy: true }];
    }
    return io.readdirSync(file).map(name => ({ path: join(file, name), name, pid: Number(name.split("-")[0]) || 0 }));
  } catch (error) {
    if (["ENOENT", "EISDIR", "ENOTDIR"].includes(error.code)) return [];
    throw error;
  }
}

/**
 * Takes the machine-wide lock for a whole run (the "already running" check, the launch and the quit): another lane's
 * run would otherwise drive the same Safari Technology Preview. Returns { release } or { held: owner pid }.
 *
 * The lock is a directory holding one entry, `<pid>-<nonce>`. A run builds its own directory with its entry and
 * renames it onto the lock's path: rename() replaces nothing but an empty directory, so it succeeds only while
 * no run holds the lock, and the entry arrives with it. A dead run's entry is taken out by its own name (renamed
 * aside, then removed): no other run's entry has that name, so a takeover never touches a lock another run has
 * just taken, and the lock's name is never free while a run holds it. An earlier version's lock file is unlinked,
 * which fails on a directory, so it never removes a run's lock that replaced the file meanwhile. `io` is for tests
 * that interleave runs: every file-system call goes through it.
 */
export function acquireLock(file = LOCK_FILE, { pid = process.pid, isAlive = alive, io = fs } = {}) {
  const { mkdirSync, renameSync, rmSync, rmdirSync, unlinkSync, writeFileSync } = io;
  const entry = `${pid}-${randomBytes(6).toString("hex")}`;
  const draft = `${file}.${entry}.draft`;
  mkdirSync(draft);
  writeFileSync(join(draft, entry), String(pid));
  const release = () => {
    rmSync(join(file, entry), { force: true });
    // Only an empty directory goes; a run that has renamed its own onto the path meanwhile keeps it.
    try { rmdirSync(file); } catch { /* another run's lock, or gone */ }
  };
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        renameSync(draft, file);
        return { release };
      } catch (error) {
        if (!["ENOTEMPTY", "EEXIST", "ENOTDIR", "EISDIR"].includes(error.code)) throw error;
      }
      const owners = lockOwners(file, io);
      const live = owners.find(owner => owner.pid && isAlive(owner.pid));
      if (live) return { held: live.pid };
      for (const owner of owners) {
        if (owner.legacy) {
          // A run's directory that replaced the file meanwhile fails the unlink (EPERM on macOS, EISDIR on Linux).
          try { unlinkSync(owner.path); } catch (error) { if (!["ENOENT", "EPERM", "EISDIR"].includes(error.code)) throw error; }
          continue;
        }
        const gone = `${draft}.gone-${owner.name}`;
        try { renameSync(owner.path, gone); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
        rmSync(gone, { recursive: true, force: true });
      }
    }
    return { held: "contended" };
  } finally {
    rmSync(draft, { recursive: true, force: true });
  }
}
