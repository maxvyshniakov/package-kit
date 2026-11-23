// package-kit Safari screenshots's line into the page: a local reverse proxy in front of the Storybook preview that injects
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

  let queue = [], nextId = 1, closed = false;
  const closedError = new Error("Safari page bridge closed");
  const checkOpen = () => { if (closed) throw closedError; };
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
        let result;
        try { result = JSON.parse(body); } catch { result = null; }
        if (result && result.id !== undefined) {
          waiting.get(result.id)?.(result);
          waiting.delete(result.id);
        }
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
    if (closed) return Promise.reject(closedError);
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
  const send = js => { checkOpen(); queue.push({ id: nextId++, js }); };
  /** Polls `js` until it returns something truthy. */
  async function until(js, timeoutMs, what, explain = "return { href: location.href, state: document.readyState, visibility: document.visibilityState }") {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      checkOpen();
      const remaining = end - Date.now();
      if (remaining <= 0) break;
      const value = await run(js, Math.min(5_000, remaining)).catch(() => { checkOpen(); return null; });
      if (value) return value;
      const wait = Math.min(250, Math.max(0, end - Date.now()));
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    }
    checkOpen();
    const state = await run(explain, Math.min(5_000, Math.max(50, timeoutMs))).catch(error => String(error));
    throw new Error(`timed out waiting for ${what}: ${JSON.stringify(state)}`);
  }
  const close = () => new Promise(resolve => { closed = true; for (const complete of waiting.values()) complete({ error: "Safari page bridge closed" }); waiting.clear(); queue = []; server.closeAllConnections?.(); server.close(() => resolve()); });
  return { origin, token, run, send, until, close };
}
