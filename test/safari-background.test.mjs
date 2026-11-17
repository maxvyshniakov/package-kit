import test from 'node:test';
import assert from 'node:assert/strict';
import { launchSafari } from '../src/safari.mjs';

function fake() {
  const events = []; let onFront; let front = { pid: 1, bundle: 'owner.editor' };
  const proxy = { origin: 'http://127.0.0.1:9000', run: async js => js.includes('innerWidth') ? [1280, 900] : true, send: js => events.push(['send', js]), until: async () => true, close: async () => events.push(['proxy-close']) };
  const system = {
    // Old launcher must fail at its mocked foreground boundary, never run Safari.
    exists: () => true, freePort: async () => 9001, spawn: () => { throw new Error('foreground WebDriver spawn'); },
    preflight: async () => events.push(['preflight']), lock: () => ({ release: () => events.push(['unlock']) }),
    syncPids: () => new Set(), sweepSync: async () => {},
    pids: () => [], front: () => front,
    watch: fn => { onFront = fn; return { ready: Promise.resolve(), close: () => events.push(['watch-close']) }; },
    startProxy: async origin => (events.push(['proxy', origin]), proxy),
    open: async url => (events.push(['open-background', url]), 77),
    place: async (...args) => events.push(['place', ...args]),
    capture: async (...args) => events.push(['capture', ...args]),
    quit: async pid => events.push(['quit', pid]), version: () => 'STP test',
  };
  return { events, system, proxy, foreground: value => { front = value; onFront?.(value); } };
}

test('Safari screenshot route opens in background and never spawns WebDriver or activates an app', async () => {
  const f = fake(); const browser = await launchSafari(f.system);
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto('http://localhost:6010/iframe.html?id=button');
  await page.screenshot({ path: '/tmp/not-written-by-fake.png' });
  await browser.close();
  assert.deepEqual(f.events.filter(e => ['open-background', 'quit', 'unlock'].includes(e[0])), [['open-background', 'http://127.0.0.1:9000/iframe.html?id=button'], ['quit', 77], ['unlock']]);
});

test('busy Safari or missing permissions refuse before opening and release the lock', async () => {
  for (const reason of ['busy', 'permissions']) {
    const f = fake();
    if (reason === 'busy') f.system.pids = () => [44];
    else f.system.preflight = async () => { throw new Error('missing permissions'); };
    await assert.rejects(launchSafari(f.system), /busy|permissions/);
    assert.ok(!f.events.some(e => e[0] === 'open-background'));
    assert.ok(f.events.some(e => e[0] === 'unlock'));
  }
});

test('focus guard aborts and closes only its own Safari; owner app switches are allowed', async () => {
  const f = fake(); const browser = await launchSafari(f.system);
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto('http://localhost:6010/iframe.html');
  f.foreground({ pid: 2, bundle: 'owner.other' });
  await page.evaluate(() => true);
  f.foreground({ pid: 77, bundle: 'com.apple.SafariTechnologyPreview' });
  await assert.rejects(page.evaluate(() => true), /focus/);
  await assert.rejects(browser.close(), /focus/); await assert.rejects(browser.close(), /focus/);
  assert.equal(f.events.filter(e => e[0] === 'quit').length, 1);
  assert.deepEqual(f.events.find(e => e[0] === 'quit'), ['quit', 77]);
});

test('wrong viewport size fails and navigation reuses one owned app', async () => {
  const f = fake(); const browser = await launchSafari(f.system);
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto('http://localhost:6010/one'); await page.goto('http://localhost:6010/two');
  assert.equal(f.events.filter(e => e[0] === 'open-background').length, 1);
  await assert.rejects(page.setViewportSize({ width: 375, height: 900 }), /1280.*375/);
  await browser.close();
});

test('focus abort during launch waits for ownership before cleanup', async () => {
  const f = fake(); let finish;
  f.system.open = () => new Promise(resolve => { finish = resolve; });
  const browser = await launchSafari(f.system);
  const page = await browser.newPage();
  const navigation = page.goto('http://localhost:6010/one');
  await new Promise(resolve => setImmediate(resolve));
  f.foreground({ pid: 77, bundle: 'com.apple.SafariTechnologyPreview' });
  finish(77);
  await assert.rejects(navigation, /focus/);
  await assert.rejects(browser.close(), /focus/);
  assert.deepEqual(f.events.filter(e => e[0] === 'quit'), [['quit', 77]]);
});

test('native launch boundary requests a non-activating owned process, never WebDriver', async () => {
  const { createSafariSystem } = await import('../src/safari-background/system.mjs');
  const calls = [];
  const system = createSafariSystem({ exec: () => assert.fail('no direct process spawn'), native: () => assert.fail('launch must be asynchronous'), asyncNative: async args => { calls.push(args); return 77; } });
  assert.equal(await system.open('http://127.0.0.1:9000/iframe.html'), 77);
  assert.deepEqual(calls, [['open', 'http://127.0.0.1:9000/iframe.html']]);
});

test('watcher readiness is a barrier before any native browser open', async () => {
  const f = fake(); let ready;
  f.system.watch = () => ({ ready: new Promise(resolve => { ready = resolve; }), close() {} });
  let launched = false;
  const pending = launchSafari(f.system).then(browser => { launched = true; return browser; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(launched, false);
  assert.ok(!f.events.some(e => e[0] === 'open-background'));
  ready(); const browser = await pending;
  await (await browser.newPage()).goto('http://localhost:6010/one');
  assert.ok(f.events.some(e => e[0] === 'open-background')); await browser.close();
});

test('waitForFunction serializes readiness rather than a circular React DOM node', async () => {
  const f = fake(); const browser = await launchSafari(f.system);
  try {
    const page = await browser.newPage();
    await page.goto('http://localhost:6010/iframe.html');
    const node = {}; node.__reactFiber = { stateNode: node };
    // The page-beacon boundary JSON-serializes results. React-owned DOM nodes
    // carry enumerable fiber references, so returning the node itself fails.
    f.proxy.until = async js => JSON.parse(JSON.stringify(await Function('document', `return (async () => { ${js} })()`)({ querySelector: () => node })));
    assert.equal(await page.waitForFunction(() => document.querySelector('#story')), true);
    assert.equal(await page.waitForFunction(() => false), false);
    assert.equal(await page.waitForFunction(async () => false), false);
    assert.equal(await page.waitForFunction(async () => document.querySelector('#story')), true);
  } finally { await browser.close(); }
});

test('focus violation during finalization rejects close after owned cleanup', async () => {
  const f = fake();
  f.system.quit = async pid => { f.events.push(['quit', pid]); f.foreground({ pid, bundle: 'com.apple.SafariTechnologyPreview' }); };
  const browser = await launchSafari(f.system);
  await (await browser.newPage()).goto('http://localhost:6010/one');
  await assert.rejects(browser.close(), /focus guard/);
  assert.ok(f.events.some(event => event[0] === 'unlock'));
});

test('screenshot refuses a hidden page before capturing stale pixels', async () => {
  const f = fake(); const browser = await launchSafari(f.system);
  const page = await browser.newPage();
  await page.goto('http://localhost:6010/one');
  const original = f.proxy.run;
  f.proxy.run = js => js.includes('visibilityState') ? Promise.resolve(false) : original(js);
  await assert.rejects(page.screenshot({ path: '/unused' }), /hidden|covered/);
  assert.ok(!f.events.some(event => event[0] === 'capture'));
  await browser.close();
});

test('sync service baseline is preserved and swept before releasing the lock', async () => {
  const f = fake(); const baseline = new Set(['11']);
  f.system.syncPids = () => baseline;
  f.system.sweepSync = async before => { assert.equal(before, baseline); f.events.push(['sweep']); };
  const browser = await launchSafari(f.system);
  await (await browser.newPage()).goto('http://localhost:6010/one');
  await browser.close();
  assert.deepEqual(f.events.filter(event => ['quit', 'sweep', 'unlock'].includes(event[0])).map(event => event[0]), ['quit', 'sweep', 'unlock']);
});

test('native async boundary is bounded and propagates failed confirmed termination', async () => {
  const { nativeAsync, createSafariSystem } = await import('../src/safari-background/system.mjs');
  let callback;
  const pending = nativeAsync(['open', 'local'], { binary: '/mock', execute: (bin, args, options, done) => {
    assert.equal(bin, '/mock'); assert.deepEqual(args, ['open', 'local']);
    assert.equal(options.timeout, 30000); callback = done;
  } });
  callback(null, '77'); assert.equal(await pending, 77);
  const system = createSafariSystem({ asyncNative: async args => { assert.deepEqual(args, ['quit', 77]); throw new Error('STP did not exit'); } });
  await assert.rejects(system.quit(77), /did not exit/);
});

test('sync cleanup retains baseline processes and sweeps one service relaunch', async () => {
  const { createSafariSystem } = await import('../src/safari-background/system.mjs');
  const lists = ['11 22', '11 33', '11', '11'], killed = [];
  const system = createSafariSystem({ list: () => ({ stdout: lists.shift() }), kill: pid => killed.push(pid), sleep: async () => {} });
  await system.sweepSync(new Set(['11']));
  assert.deepEqual(killed, [22, 33]);
});
