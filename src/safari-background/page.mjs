// repo-kit Safari screenshots's line into the page: a local reverse proxy in front of the Storybook preview that injects
// beacon.js into every HTML page, runs scripts in the page through it.
// Safari Technology Preview is launched without WebDriver (a driven window activates itself on real input), so
// this replaces page.evaluate. A per-run token keeps tabs from earlier runs out of the samples.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const beacon = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "beacon.js"));
const hopHeaders = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive"]);

/** Starts the proxy on a free 127.0.0.1 port. `upstream` is the preview's origin. */
export async function startPage(upstream) {
  const token = randomUUID();

  let queue = [], nextId = 1;
  const waiting = new Map();
  const readBody = request => new Promise(resolve => {
    const chunks = [];
    request.on("data", chunk => chunks.push(chunk)).on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname.startsWith("/__stp-bounce/")) {
      const ours = url.searchParams.get("token") === token;
      const what = url.pathname.slice("/__stp-bounce/".length);
      if (what === "beacon.js") { response.writeHead(200, { "content-type": "text/javascript" }); response.end(beacon); return; }
      if (what === "cmd") {
        const send = ours ? queue : [];
        if (ours) queue = [];
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify(send));
        return;
      }
      const body = await readBody(request);

      if (ours && what === "result") {
        const result = JSON.parse(body);
        waiting.get(result.id)?.(result);
        waiting.delete(result.id);
      }
      response.writeHead(204).end();
      return;
    }
    try {
      const upstreamResponse = await fetch(new URL(url.pathname + url.search, upstream));
      const type = upstreamResponse.headers.get("content-type") ?? "";
      let body = Buffer.from(await upstreamResponse.arrayBuffer());
      if (type.includes("text/html")) {
        const tag = `<script src="/__stp-bounce/beacon.js?token=${token}" data-token="${token}"></script>`;
        body = Buffer.from(body.toString("utf8").replace(/<head[^>]*>/i, head => head + tag));
      }
      const headers = {};
      for (const [name, value] of upstreamResponse.headers) if (!hopHeaders.has(name)) headers[name] = value;
      response.writeHead(upstreamResponse.status, headers);
      response.end(body);
    } catch (error) {
      response.writeHead(502).end(String(error));
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  /** Runs `js` (an async function body) in the page; rejects on a page error or after `timeoutMs`. */
  function run(js, timeoutMs = 15_000) {
    const id = nextId++;
    queue.push({ id, js });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { queue = queue.filter(command => command.id !== id); waiting.delete(id); reject(new Error(`page did not answer within ${timeoutMs} ms`)); }, timeoutMs);
      waiting.set(id, result => {
        clearTimeout(timer);
        if (result.error) reject(new Error(`in the page: ${result.error}`)); else resolve(result.value);
      });
    });
  }
  /** Queues a script that ends the page (a navigation): no answer is awaited. */
  const send = js => { queue.push({ id: nextId++, js }); };
  /** Polls `js` until it returns something truthy. */
  async function until(js, timeoutMs, what, explain = "return { href: location.href, state: document.readyState, visibility: document.visibilityState }") {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const value = await run(js, 5_000).catch(() => null);
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    const state = await run(explain, 5_000).catch(error => String(error));
    throw new Error(`timed out waiting for ${what}: ${JSON.stringify(state)}`);
  }
  const close = () => new Promise(resolve => { for (const complete of waiting.values()) complete({ error: "Safari page bridge closed" }); waiting.clear(); queue = []; server.closeAllConnections?.(); server.close(() => resolve()); });
  return { origin, token, run, send, until, close };
}
