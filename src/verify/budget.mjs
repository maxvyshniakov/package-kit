// Machine core, memory and worker budgets for `package-kit verify`.
import os from "node:os";

import { capacity as readCapacity, leasedSlots, runSlots } from "../slotfather.mjs";

// Cores the steps beside a usesCores step keep busy while it runs.
const RESERVED_CORES = 2;
const GiB = 1024 ** 3;
// What one test worker holds at its peak, by default (verify.workerMemory):
// Data Grid's Vitest workers, VM contexts up to vmMemoryLimit plus the worker.
export const WORKER_MEMORY_GIB = 0.9;
// What a usesCores step holds besides its workers, by default (its `memory`).
export const USES_CORES_BASE_GIB = 0.25;

export { leasedSlots, readCapacity, readCapacity as capacity, runSlots };

/**
 * The cores this run may use: PACKAGE_KIT_VERIFY_CORES (or the older
 * SID_KIT_VERIFY_CORES) when set; under a slotfather lease its share of the
 * machine (the leased slots of slotfather's total slots); otherwise, as on CI
 * without slotfather, every core.
 */
export function verifyCores(env = process.env, { cpus = os.availableParallelism(), capacity = readCapacity } = {}) {
  const override = Number.parseInt(env.PACKAGE_KIT_VERIFY_CORES ?? env.SID_KIT_VERIFY_CORES ?? "", 10);
  if (override > 0) return override;
  const leased = leasedSlots(env);
  if (leased) {
    const { total } = capacity();
    if (total > 0) return Math.max(1, Math.min(cpus, Math.floor((leased * cpus) / total)));
  }
  return cpus;
}

/**
 * The memory this run may use, in GiB: PACKAGE_KIT_VERIFY_MEMORY_GIB when set.
 * Under a slotfather lease, the leased slots times the memory slotfather gives
 * a slot (for example 5 GiB), or no figure where slotfather budgets
 * cores only (as on a workstation); without a lease, what Linux reports available, or all
 * memory elsewhere (macOS counts its cache as used). Always no more than the
 * job's cgroup limit (process.constrainedMemory) and, on Linux, MemAvailable.
 * Infinity: no figure, cores decide.
 */
export function verifyMemory(env = process.env, {
  platform = process.platform, free = os.freemem(), total = os.totalmem(),
  constrained = process.constrainedMemory?.(), capacity = readCapacity,
} = {}) {
  const override = Number.parseFloat(env.PACKAGE_KIT_VERIFY_MEMORY_GIB ?? "");
  if (override > 0) return override;
  const limits = [];
  if (constrained > 0 && constrained < total) limits.push(constrained / GiB);
  if (platform === "linux") limits.push(free / GiB);
  const leased = leasedSlots(env);
  if (leased) {
    // A request above the total holds every slot.
    const { gib_per_slot: perSlot, total: slots } = capacity();
    if (perSlot > 0) limits.push(Math.min(leased, slots > 0 ? slots : leased) * perSlot);
  } else if (platform !== "linux") {
    limits.push(total / GiB);
  }
  return limits.length ? Math.min(...limits) : Infinity;
}

/**
 * Workers for a usesCores step: the run's cores less those the steps beside it
 * keep busy, and no more than half the run's memory (GiB) holds at
 * `workerMemory` GiB each, so the other steps keep room beside it. Several jobs
 * share CI's runner, so a core count alone can run it out of memory.
 */
export function unitTestWorkers(cores, memory = Infinity, workerMemory = WORKER_MEMORY_GIB) {
  const byMemory = Math.floor(memory / 2 / workerMemory);
  return Math.max(1, Math.min(cores - RESERVED_CORES, byMemory));
}
