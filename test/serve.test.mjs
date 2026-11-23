import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";

import { entrySpecifiers, tarballIssues } from "../src/packed-consumer.mjs";
import {
  cacheControlFor,
  DEFAULT_BACKLOG,
  DEFAULT_HOST,
  DEFAULT_KEEP_ALIVE_TIMEOUT_MS,
  DEFAULT_PORT,
  MIME_TYPES,
  mimeTypeFor,
  parseServeArgs,
  startStaticServer,
} from "../src/serve.mjs";
import { kitRoot, tempRepository } from "./fixtures.mjs";

function rawRequest(port, rawPath, { method = "GET", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: rawPath,
        headers,
      },
      res => {
        const chunks = [];
        res.on("data", chunk => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("parseServeArgs parses <dir>, --port, and --host with defaults and validation", () => {
  assert.deepEqual(parseServeArgs(["dist"], { cwd: "/workspace" }), {
    dir: "/workspace/dist",
    port: DEFAULT_PORT,
    host: DEFAULT_HOST,
  });
  assert.deepEqual(parseServeArgs(["./storybook-static", "--port", "6020", "--host", "0.0.0.0"], { cwd: "/workspace" }), {
    dir: "/workspace/storybook-static",
    port: 6020,
    host: "0.0.0.0",
  });
  assert.deepEqual(parseServeArgs(["--port=0", "--host=127.0.0.1", "public"], { cwd: "/workspace" }), {
    dir: "/workspace/public",
    port: 0,
    host: "127.0.0.1",
  });
  assert.deepEqual(parseServeArgs(["--help"]), { help: true });
  assert.throws(() => parseServeArgs([]), /Name a directory to serve/);
  assert.throws(() => parseServeArgs(["dist", "extra"]), /Unexpected extra argument/);
  assert.throws(() => parseServeArgs(["dist", "--port", "abc"]), /--port takes an integer port/);
  assert.throws(() => parseServeArgs(["dist", "--port=70000"]), /--port must be between 0 and 65535/);
  assert.throws(() => parseServeArgs(["dist", "--host"]), /--host needs an address/);
  assert.throws(() => parseServeArgs(["dist", "--unknown"]), /Unknown option --unknown/);
});

test("mimeTypeFor and cacheControlFor cover all required extensions and cache policies", () => {
  const expectedMimes = {
    "app.js": "text/javascript; charset=utf-8",
    "mod.mjs": "text/javascript; charset=utf-8",
    "styles.css": "text/css; charset=utf-8",
    "iframe.html": "text/html; charset=utf-8",
    "index.json": "application/json; charset=utf-8",
    "icon.svg": "image/svg+xml",
    "font.woff2": "font/woff2",
    "font.woff": "font/woff",
    "shot.png": "image/png",
    "photo.jpg": "image/jpeg",
    "hero.webp": "image/webp",
    "favicon.ico": "image/x-icon",
    "bundle.js.map": "application/json; charset=utf-8",
    "robots.txt": "text/plain; charset=utf-8",
    "archive.bin": "application/octet-stream",
  };
  for (const [file, expected] of Object.entries(expectedMimes)) {
    assert.equal(mimeTypeFor(file), expected, file);
  }
  for (const ext of [".js", ".mjs", ".css", ".html", ".json", ".svg", ".woff2", ".woff", ".png", ".jpg", ".webp", ".ico", ".map", ".txt"]) {
    assert.ok(MIME_TYPES[ext], `MIME_TYPES[${ext}] defined`);
  }

  assert.equal(cacheControlFor("/iframe.html", "/root/iframe.html"), "no-cache");
  assert.equal(cacheControlFor("/index.json", "/root/index.json"), "no-cache");
  assert.equal(cacheControlFor("/", "/root/index.html"), "no-cache");
  assert.equal(cacheControlFor("/assets/index.html", "/root/assets/index.html"), "no-cache");
  assert.equal(cacheControlFor("/assets/meta.json", "/root/assets/meta.json"), "no-cache");
  assert.equal(cacheControlFor("/assets/Button-a1b2c3.js", "/root/assets/Button-a1b2c3.js"), "public, max-age=31536000, immutable");
  assert.equal(cacheControlFor("/assets/theme.woff2", "/root/assets/theme.woff2"), "public, max-age=31536000, immutable");
});

test("startStaticServer serves GET and HEAD with Keep-Alive, cache headers, 404, and 403 path traversal guard", async () => {
  const repo = tempRepository({
    "public/index.html": "<!doctype html><title>Home</title>",
    "public/iframe.html": "<!doctype html><title>Story</title>",
    "public/index.json": JSON.stringify({ v: 5, entries: {} }),
    "public/assets/chunk-123.js": "export const x = 1;\n",
    "public/assets/styles-123.css": "body { margin: 0; }\n",
    "secret.txt": "outside root",
  });
  const publicDir = path.join(repo.root, "public");
  fs.symlinkSync(path.join(repo.root, "secret.txt"), path.join(publicDir, "escape-link.txt"));

  const instance = await startStaticServer({ dir: publicDir, port: 0, host: "127.0.0.1" });
  try {
    assert.equal(instance.backlog, DEFAULT_BACKLOG);
    assert.equal(instance.keepAliveTimeout, DEFAULT_KEEP_ALIVE_TIMEOUT_MS);

    // Directory root -> index.html with no-cache
    const home = await rawRequest(instance.port, "/");
    assert.equal(home.status, 200);
    assert.equal(home.headers["content-type"], "text/html; charset=utf-8");
    assert.equal(home.headers["cache-control"], "no-cache");
    assert.equal(home.body, "<!doctype html><title>Home</title>");

    // JSON with query string -> no-cache
    const indexJson = await rawRequest(instance.port, "/index.json?ts=123");
    assert.equal(indexJson.status, 200);
    assert.equal(indexJson.headers["content-type"], "application/json; charset=utf-8");
    assert.equal(indexJson.headers["cache-control"], "no-cache");
    assert.deepEqual(JSON.parse(indexJson.body), { v: 5, entries: {} });

    // Hashed /assets/* -> immutable cache header
    const asset = await rawRequest(instance.port, "/assets/chunk-123.js", {
      headers: { Connection: "keep-alive" },
    });
    assert.equal(asset.status, 200);
    assert.equal(asset.headers["content-type"], "text/javascript; charset=utf-8");
    assert.equal(asset.headers["cache-control"], "public, max-age=31536000, immutable");
    assert.match(asset.headers.connection ?? "", /keep-alive/i);
    assert.equal(asset.body, "export const x = 1;\n");

    // HEAD support returns headers and Content-Length without body
    const headRes = await rawRequest(instance.port, "/assets/styles-123.css", { method: "HEAD" });
    assert.equal(headRes.status, 200);
    assert.equal(headRes.headers["content-type"], "text/css; charset=utf-8");
    assert.equal(headRes.headers["cache-control"], "public, max-age=31536000, immutable");
    assert.equal(Number(headRes.headers["content-length"]), Buffer.byteLength("body { margin: 0; }\n"));
    assert.equal(headRes.body, "");

    // Missing file -> 404
    const missing = await rawRequest(instance.port, "/assets/missing.js");
    assert.equal(missing.status, 404);

    // Path traversal attempts -> 403
    for (const attack of [
      "/../secret.txt",
      "/..%2fsecret.txt",
      "/..%2Fsecret.txt",
      "/%2e%2e/secret.txt",
      "/assets/../../secret.txt",
      "/..%5csecret.txt",
      "/escape-link.txt",
      "/bad%00.html",
      "/%E0%A4%A",
    ]) {
      const res = await rawRequest(instance.port, attack);
      assert.equal(res.status, 403, `Expected 403 for ${attack}, got ${res.status}`);
    }
  } finally {
    await instance.close();
    repo.cleanup();
  }
});

test("startStaticServer handles a 50-request concurrent burst without dropping connections", async () => {
  const files = {
    "dist/iframe.html": "<!doctype html><div id='storybook-root'></div>",
    "dist/index.json": JSON.stringify({ v: 5 }),
  };
  for (let i = 0; i < 50; i++) {
    files[`dist/assets/module-${i}.js`] = `export const chunk = ${i};\n`;
  }
  const repo = tempRepository(files);
  const instance = await startStaticServer({
    dir: path.join(repo.root, "dist"),
    port: 0,
    host: "127.0.0.1",
  });

  const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });
  try {
    const burst = Array.from({ length: 50 }, (_, i) =>
      new Promise((resolve, reject) => {
        const req = http.get(
          `${instance.url}/assets/module-${i}.js`,
          { agent, headers: { Connection: "keep-alive" } },
          res => {
            const chunks = [];
            res.on("data", c => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode,
                cacheControl: res.headers["cache-control"],
                connection: res.headers.connection,
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
      }),
    );

    const results = await Promise.all(burst);
    assert.equal(results.length, 50);
    results.forEach((res, i) => {
      assert.equal(res.status, 200, `request ${i} status`);
      assert.equal(res.cacheControl, "public, max-age=31536000, immutable");
      assert.match(res.connection ?? "", /keep-alive/i);
      assert.equal(res.body, `export const chunk = ${i};\n`);
    });
  } finally {
    agent.destroy();
    await instance.close();
    repo.cleanup();
  }
});

test("bin/package-kit.mjs serve logs bound URL and shuts down cleanly on SIGTERM and SIGINT", async () => {
  const repo = tempRepository({ "site/index.html": "<h1>ok</h1>" });
  const siteDir = path.join(repo.root, "site");
  const binPath = path.join(kitRoot, "bin/package-kit.mjs");

  try {
    for (const signal of ["SIGTERM", "SIGINT"]) {
      const child = spawn(process.execPath, [binPath, "serve", siteDir, "--port", "0", "--host", "127.0.0.1"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const line = await new Promise((resolve, reject) => {
        let output = "";
        child.stdout.on("data", chunk => {
          output += chunk.toString("utf8");
          if (output.includes("\n")) resolve(output.trim());
        });
        child.on("error", reject);
        child.on("exit", code => reject(new Error(`Exited early with ${code}: ${output}`)));
      });

      const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(line);
      assert.ok(match, `Expected startup log line with bound URL, got: ${line}`);
      const response = await fetch(match[0]);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), "<h1>ok</h1>");

      const exitCode = await new Promise(resolve => {
        child.on("close", code => resolve(code));
        child.kill(signal);
      });
      assert.equal(exitCode, 0, `${signal} graceful exit`);
    }
  } finally {
    repo.cleanup();
  }
});

test("package.json exports ./serve and packed-consumer includes @maxvyshniakov/package-kit/serve", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(kitRoot, "package.json"), "utf8"));
  assert.equal(manifest.exports["./serve"], "./src/serve.mjs");
  assert.ok(entrySpecifiers(manifest).includes("@maxvyshniakov/package-kit/serve"));
  const files = new Set(
    Object.values(manifest.exports)
      .filter(v => typeof v === "string")
      .map(v => v.replace(/^\.\//, "")),
  );
  assert.deepEqual(tarballIssues({ manifest, packedManifest: manifest, files }), []);
});
