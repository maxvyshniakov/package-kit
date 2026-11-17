import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireLock } from './lock.mjs';
import { startPage } from './page.mjs';
export const STP_BUNDLE = 'com.apple.SafariTechnologyPreview';
export const backgroundLaunchArgs = url => ['-g', '-b', STP_BUNDLE, url, '--args', '-ApplePersistenceIgnoreState', 'YES'];
const source = fileURLToPath(new URL('./BackgroundSafari.swift', import.meta.url));
let binary;
function tool() {
  if (binary) return binary;
  const hash = createHash('sha256').update(readFileSync(source)).digest('hex').slice(0, 16);
  const dir = path.join(homedir(), 'Library/Caches/repo-kit'); mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `BackgroundSafari-${hash}`);
  if (!existsSync(target)) execFileSync('swiftc', ['-O', '-swift-version', '5', '-o', target, source]);
  return binary = target;
}
const call = (...args) => JSON.parse(execFileSync(tool(), args.map(String), { encoding: 'utf8' }));
export function nativeAsync(args, { execute = execFile, binary = tool() } = {}) {
  return new Promise((resolve, reject) => execute(binary, args.map(String), { encoding: 'utf8', timeout: 30000 }, (error, stdout) => {
    if (error) { reject(error); return; }
    try { resolve(JSON.parse(stdout)); } catch (failure) { reject(failure); }
  }));
}
export function createSafariSystem({ exec = execFileSync, native = call, asyncNative = nativeAsync, start = spawn, list = spawnSync, kill = process.kill, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
 const syncPids = () => new Set((list('pgrep', ['-f', 'Safari Technology Preview.app/Contents/MacOS/SafariSyncService'], { encoding: 'utf8' }).stdout ?? '').split(/\s+/).filter(Boolean));
 return {
  lock: acquireLock, syncPids,
  async sweepSync(before) {
    for (let pass = 0; pass < 3; pass++) {
      for (const pid of syncPids()) if (!before.has(pid)) {
        try { kill(Number(pid), 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
      await sleep(1500);
    }
    const remaining = [...syncPids()].filter(pid => !before.has(pid));
    if (remaining.length) throw new Error(`Safari sync services did not exit: ${remaining.join(', ')}`);
  },
  async preflight() {
    if (process.platform !== 'darwin' || !existsSync('/Applications/Safari Technology Preview.app')) throw new Error('Safari Technology Preview requires macOS and the installed STP app');
    const permissions = native('preflight');
    if (!permissions.accessibility || !permissions.screenCapture) throw new Error('Background Safari needs existing Accessibility and Screen Recording permissions; no permission prompt was opened');
  },
  pids: () => native('pids'), front: () => native('front'),
  version: () => exec('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', '/Applications/Safari Technology Preview.app/Contents/Info.plist'], { encoding: 'utf8' }).trim(),
  watch(onFront, onError) {
    const child = start(tool(), ['watch'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let pending = '', closed = false, resolveReady, rejectReady;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const timer = setTimeout(() => fail(new Error('Safari focus watcher readiness timed out')), 10000);
    const fail = error => { clearTimeout(timer); rejectReady(error); onError(error); };
    child.stdout.on('data', chunk => { const lines = (pending + chunk).split('\n'); pending = lines.pop(); for (const line of lines) if (line.trim()) { try { const message = JSON.parse(line); if (message.ready) { clearTimeout(timer); resolveReady(); } else onFront(message); } catch (error) { fail(error); } } });
    const exited = new Promise(resolve => child.once('close', resolve));
    child.on('error', fail); child.on('exit', () => { if (!closed) fail(new Error('Safari focus watcher exited')); });
    return { ready, async close() { closed = true; clearTimeout(timer); child.kill(); await exited; } };
  },
  startProxy: startPage,
  async open(url) {
    // NSWorkspace's non-activating open is the native open -g path. A fresh
    // instance and completion PID avoid claiming an unrelated singleton PID.
    return asyncNative(['open', url]);
  },
  place: async (pid, { width, height }) => native('place', pid, width, height),
  async capture(pid, output, [width, height]) {
    const window = native('window', pid), dir = mkdtempSync(path.join(tmpdir(), 'repo-kit-safari-'));
    try {
      const raw = path.join(dir, 'window.png');
      exec('/usr/sbin/screencapture', ['-x', '-o', '-l', String(window.id), raw]);
      native('crop', raw, output, window.bounds.Width, window.bounds.Height, width, height);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  },
  quit: async pid => asyncNative(['quit', pid]), warn: message => console.warn(`repo-kit: ${message}`),
};
}
export const safariSystem = createSafariSystem();
