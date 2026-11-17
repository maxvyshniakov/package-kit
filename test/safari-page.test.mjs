import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startPage } from '../src/safari-background/page.mjs';

test('local page bridge injects its token, isolates commands and closes pending calls', async () => {
  const upstream = createServer((_, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<html><head></head><body>story</body></html>'));
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const proxy = await startPage(`http://127.0.0.1:${upstream.address().port}`);
  try {
    const html = await (await fetch(proxy.origin + '/iframe.html')).text();
    assert.ok(html.includes(`data-token="${proxy.token}"`));
    const answer = proxy.run('return 42');
    const endpoint = route => `${proxy.origin}/__stp-bounce/${route}?token=${proxy.token}`;
    assert.deepEqual(await (await fetch(proxy.origin + '/__stp-bounce/cmd?token=wrong')).json(), []);
    const [command] = await (await fetch(endpoint('cmd'))).json();
    assert.equal(command.js, 'return 42');
    await fetch(endpoint('result'), { method: 'POST', body: JSON.stringify({ id: command.id, value: 42 }) });
    assert.equal(await answer, 42);
    const pending = proxy.run('return pending');
    const rejected = assert.rejects(pending, /bridge closed/);
    await proxy.close(); await rejected;
  } finally { await proxy.close(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); }
});

test('closing the bridge cancels polling and rejects new commands immediately', async () => {
  const proxy = await startPage('http://127.0.0.1:1');
  const polling = proxy.until('return false', 50, 'condition');
  const rejected = assert.rejects(polling, /bridge closed/);
  await proxy.close();
  await rejected;
  await assert.rejects(proxy.run('return 1'), /bridge closed/);
  assert.throws(() => proxy.send('return 1'), /bridge closed/);
});
