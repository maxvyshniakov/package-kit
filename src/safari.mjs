// Real STP transport extracted from Data Grid's focus-guarded safari-real-bounce.
// No WebDriver: non-activating NSWorkspace open, a tokenized page bridge, AX placement and window capture.
import { safariSystem } from './safari-background/system.mjs';
export { safariSystem } from './safari-background/system.mjs';
const STP = 'com.apple.SafariTechnologyPreview';

export async function launchSafari(overrides = {}) {
  const system = { ...safariSystem, ...overrides };
  const lock = system.lock();
  if (lock.held) throw new Error(`Safari background run busy (owner ${lock.held})`);
  let watcher, proxy, ownedPid, starting, closing, failure, origin, syncBefore;
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  aborted.catch(() => {});
  const check = () => { if (failure) throw failure; if (closing) throw new Error('Safari background run closed'); };
  const guarded = action => { check(); return Promise.race([Promise.resolve().then(action), aborted]); };
  const close = () => closing ??= (async () => {
    try {
      await starting?.catch(() => {});
      if (ownedPid) {
        await system.quit(ownedPid);
        await system.sweepSync(syncBefore);
      }
    } finally {
      try { await proxy?.close(); } finally { try { await watcher?.close(); } finally { lock.release(); } }
    }
    if (failure) throw failure;
  })();
  const onFront = front => {
    if (front.bundle === STP || (ownedPid && front.pid === ownedPid)) {
      failure ??= new Error('Safari background focus guard: test browser became frontmost');
      rejectAbort(failure); void close().catch(() => {});
    }
  };
  try {
    await system.preflight();
    if (system.pids().length) throw new Error('Safari Technology Preview is busy; leave the existing instance alone');
    syncBefore = system.syncPids();
    onFront(system.front()); check();
    watcher = system.watch(onFront, error => {
      failure ??= error; rejectAbort(failure); void close().catch(() => {});
    });
    await watcher.ready; check();
  } catch (error) { await close(); throw error; }
  const browser = {
    version: () => system.version(), close,
    async newPage({ viewport } = {}) {
      let desired = viewport ?? { width: 1280, height: 900 };
      const evaluate = async (fn, ...args) => guarded(() => proxy.run(`return (${fn}).apply(null, ${JSON.stringify(args)})`));
      const resize = async () => {
        await guarded(() => system.place(ownedPid, desired));
        const [width, height] = await evaluate(() => [innerWidth, innerHeight]);
        await guarded(() => system.place(ownedPid, { width: desired.width * 2 - width, height: desired.height * 2 - height }));
        const [gotWidth, gotHeight] = await evaluate(() => [innerWidth, innerHeight]);
        if (gotWidth !== desired.width) throw new Error(`Safari Technology Preview gives a ${gotWidth} px wide viewport, not ${desired.width} px`);
        if (gotHeight !== desired.height) system.warn?.(`Safari viewport height ${gotHeight}px, requested ${desired.height}px`);
      };
      const page = {
        evaluate,
        async goto(url) {
          const target = new URL(url);
          if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Safari background pages require an HTTP(S) Storybook URL');
          if (origin && origin !== target.origin) throw new Error('One Safari screenshot run must use one Storybook origin');
          if (!proxy) {
            origin = target.origin;
            starting = (async () => {
              proxy = await system.startProxy(origin); check();
              ownedPid = await system.open(proxy.origin + target.pathname + target.search); check();
            })();
            await guarded(() => starting);
            await guarded(() => proxy.until(`return location.pathname + location.search === ${JSON.stringify(target.pathname + target.search)} && document.readyState === 'complete'`, 60000, 'navigation'));
          } else {
            const before = await evaluate(() => performance.timeOrigin);
            proxy.send(`location.href = ${JSON.stringify(proxy.origin + target.pathname + target.search)};`);
            await guarded(() => proxy.until(`return performance.timeOrigin !== ${JSON.stringify(before)} && location.pathname + location.search === ${JSON.stringify(target.pathname + target.search)} && document.readyState === 'complete'`, 60000, 'navigation'));
          }
          await resize();
        },
        async reload() { const before = await evaluate(() => performance.timeOrigin); proxy.send('location.reload()'); await guarded(() => proxy.until(`return performance.timeOrigin !== ${before} && document.readyState === 'complete'`, 60000, 'reload')); },
        async setViewportSize(size) { desired = size; if (ownedPid) await resize(); },
        async waitForFunction(fn, arg, { timeout = 30000 } = {}) { return guarded(() => proxy.until(`return Boolean(await (${fn})(${JSON.stringify(arg)}))`, timeout, 'page condition')); },
        locator: selector => ({ count: () => evaluate(s => document.querySelectorAll(s).length, selector) }),
        async screenshot({ path }) {
          if (!await evaluate(() => document.visibilityState === "visible")) throw new Error("Safari page is hidden: its window may be fully covered");
          const size = await evaluate(() => [innerWidth, innerHeight]);
          await guarded(() => system.capture(ownedPid, path, size));
        },
        close: async () => {},
      };
      return page;
    },
  };
  return browser;
}
