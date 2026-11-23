// package-kit serve <dir> [--port N] [--host 127.0.0.1]
//
// Dependency-free HTTP/1.1 Keep-Alive static preview server with a high socket
// backlog, so cold browser loads behind an HTTP/2 reverse proxy (e.g. Tailscale
// Serve -> Safari fetching ~45 concurrent ES module chunks) never hit python3's
// HTTP/1.0 no-Keep-Alive listen(5) backlog wall, and rebuilds never serve stale
// HTML or JSON story indexes.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 6010;
export const DEFAULT_BACKLOG = 2048;
export const DEFAULT_KEEP_ALIVE_TIMEOUT_MS = 65_000;
export const DEFAULT_HEADERS_TIMEOUT_MS = 66_000;

export const MIME_TYPES = Object.freeze({
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
});

export const USAGE = `Usage: package-kit serve <dir> [--port <number>] [--host <address>]`;

/** Content-Type header for a file path or extension. */
export function mimeTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

/**
 * Cache-Control header for a request pathname and resolved file path:
 * - `.html` and `.json`: `no-cache` so rebuilds update `iframe.html` and `index.json` immediately;
 * - `/assets/*`: `public, max-age=31536000, immutable` for content-hashed bundle assets;
 * - everything else: `no-cache`.
 */
export function cacheControlFor(urlPathname, filePath = urlPathname) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html" || ext === ".json") return "no-cache";
  const normalized = urlPathname.replace(/\\/g, "/");
  if (normalized.startsWith("/assets/") || normalized.includes("/assets/")) {
    return "public, max-age=31536000, immutable";
  }
  return "no-cache";
}

/**
 * Parse `package-kit serve <dir> [--port N] [--host 127.0.0.1]`.
 */
export function parseServeArgs(argv, { cwd = process.cwd() } = {}) {
  let dir;
  let port = DEFAULT_PORT;
  let host = DEFAULT_HOST;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") {
      return { help: true };
    }
    if (arg === "--port" || arg.startsWith("--port=")) {
      const raw = arg === "--port" ? argv[++i] : arg.slice("--port=".length);
      if (raw === undefined || raw === "" || !/^\d+$/.test(raw)) {
        throw new Error(`--port takes an integer port (0-65535), not "${raw ?? ""}"`);
      }
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
        throw new Error(`--port must be between 0 and 65535, got ${raw}`);
      }
      port = parsed;
      continue;
    }
    if (arg === "--host" || arg.startsWith("--host=")) {
      const value = arg === "--host" ? argv[++i] : arg.slice("--host=".length);
      if (!value || value.startsWith("--")) {
        throw new Error("--host needs an address, such as 127.0.0.1");
      }
      host = value;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown option ${arg}`);
    }
    if (dir !== undefined) {
      throw new Error(`Unexpected extra argument "${arg}"`);
    }
    dir = arg;
  }
  if (!dir) {
    throw new Error(`Name a directory to serve (${USAGE})`);
  }
  const resolvedDir = path.resolve(cwd, dir);
  return { dir: resolvedDir, port, host };
}

function isInsideRoot(rootDir, candidate) {
  const relative = path.relative(rootDir, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Resolve a raw request URL against rootDir.
 * Returns `{ status: 200, filePath, stat, urlPathname }` or `{ status: 403 | 404 }`.
 */
export async function resolveStaticFile(rootDir, rawUrl, realRootDir) {
  const rawPath = (rawUrl ?? "/").split("?")[0].split("#")[0];
  if (!rawPath.startsWith("/")) return { status: 403 };

  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return { status: 403 };
  }
  if (decoded.includes("\0") || decoded.includes("\\")) {
    return { status: 403 };
  }

  // Reject any explicit `..` segment in either raw or decoded path before normalization.
  const rawSegments = rawPath.split("/");
  const decodedSegments = decoded.split("/");
  if (rawSegments.includes("..") || decodedSegments.includes("..")) {
    return { status: 403 };
  }

  const relativePath = decoded.replace(/^\/+/, "");
  const candidate = path.resolve(rootDir, relativePath);
  if (!isInsideRoot(rootDir, candidate)) {
    return { status: 403 };
  }

  let target = candidate;
  let stat;
  try {
    stat = await fs.promises.stat(target);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return { status: 404 };
    if (error.code === "EACCES" || error.code === "EPERM") return { status: 403 };
    throw error;
  }

  if (stat.isDirectory()) {
    target = path.join(target, "index.html");
    if (!isInsideRoot(rootDir, target)) return { status: 403 };
    try {
      stat = await fs.promises.stat(target);
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return { status: 404 };
      if (error.code === "EACCES" || error.code === "EPERM") return { status: 403 };
      throw error;
    }
  }

  if (!stat.isFile()) return { status: 404 };

  // Also guard against symlinks escaping rootDir.
  if (realRootDir) {
    let realTarget;
    try {
      realTarget = await fs.promises.realpath(target);
    } catch {
      return { status: 404 };
    }
    if (!isInsideRoot(realRootDir, realTarget)) {
      return { status: 403 };
    }
  }

  const effectivePathname = decoded.endsWith("/") ? `${decoded}index.html` : decoded;
  return { status: 200, filePath: target, stat, urlPathname: effectivePathname };
}

function formatUrl(host, port) {
  const bracketed = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${bracketed}:${port}`;
}

/**
 * Start the HTTP/1.1 Keep-Alive static server.
 * Resolves to `{ server, url, host, port, dir, close }`.
 */
export async function startStaticServer({
  dir,
  port = DEFAULT_PORT,
  host = DEFAULT_HOST,
  backlog = DEFAULT_BACKLOG,
  keepAliveTimeout = DEFAULT_KEEP_ALIVE_TIMEOUT_MS,
  headersTimeout = DEFAULT_HEADERS_TIMEOUT_MS,
} = {}) {
  if (!dir) throw new Error("startStaticServer requires a directory path");
  const rootDir = path.resolve(dir);
  let rootStat;
  try {
    rootStat = fs.statSync(rootDir);
  } catch {
    throw new Error(`Directory does not exist: ${rootDir}`);
  }
  if (!rootStat.isDirectory()) {
    throw new Error(`Not a directory: ${rootDir}`);
  }
  const realRootDir = fs.realpathSync(rootDir);

  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    try {
      const method = req.method ?? "GET";
      if (method !== "GET" && method !== "HEAD") {
        res.writeHead(405, {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-cache",
          Allow: "GET, HEAD",
          "Content-Length": 18,
        });
        res.end("Method Not Allowed");
        return;
      }

      const resolved = await resolveStaticFile(rootDir, req.url ?? "/", realRootDir);
      if (resolved.status === 403) {
        const body = "Forbidden";
        res.writeHead(403, {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-cache",
          "Content-Length": Buffer.byteLength(body),
        });
        res.end(method === "HEAD" ? undefined : body);
        return;
      }
      if (resolved.status === 404) {
        const body = "Not Found";
        res.writeHead(404, {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-cache",
          "Content-Length": Buffer.byteLength(body),
        });
        res.end(method === "HEAD" ? undefined : body);
        return;
      }

      const { filePath, stat, urlPathname } = resolved;
      const headers = {
        "Content-Type": mimeTypeFor(filePath),
        "Cache-Control": cacheControlFor(urlPathname, filePath),
        "Content-Length": stat.size,
      };
      res.writeHead(200, headers);
      if (method === "HEAD") {
        res.end();
        return;
      }

      const stream = fs.createReadStream(filePath);
      stream.on("error", () => {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Internal Server Error");
        } else {
          res.destroy();
        }
      });
      res.on("close", () => stream.destroy());
      stream.pipe(res);
    } catch {
      if (!res.headersSent) {
        const body = "Internal Server Error";
        res.writeHead(500, {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-cache",
          "Content-Length": Buffer.byteLength(body),
        });
        res.end(req.method === "HEAD" ? undefined : body);
      } else {
        res.destroy();
      }
    }
  });

  server.keepAliveTimeout = keepAliveTimeout;
  server.headersTimeout = Math.max(headersTimeout, keepAliveTimeout + 1000);
  server.on("connection", socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise((resolve, reject) => {
    const onError = error => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host, backlog);
  });

  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;
  const url = formatUrl(host, boundPort);

  let closingPromise = null;
  const close = () => {
    if (closingPromise) return closingPromise;
    closingPromise = new Promise(resolve => {
      server.close(() => resolve());
      server.closeIdleConnections?.();
      for (const socket of sockets) {
        socket.destroy();
      }
    });
    return closingPromise;
  };

  return {
    server,
    url,
    host,
    port: boundPort,
    dir: rootDir,
    backlog,
    keepAliveTimeout: server.keepAliveTimeout,
    close,
  };
}

/**
 * CLI entrypoint for `package-kit serve <dir> [--port N] [--host 127.0.0.1]`.
 */
export async function runServe(argv, {
  cwd = process.cwd(),
  log = console.log,
  signals = process,
} = {}) {
  const parsed = parseServeArgs(argv, { cwd });
  if (parsed.help) {
    log(USAGE);
    return 0;
  }
  const instance = await startStaticServer(parsed);
  log(`package-kit serve: ${instance.dir} at ${instance.url}`);

  await new Promise(resolve => {
    const shutdown = () => {
      signals.off("SIGINT", onSigint);
      signals.off("SIGTERM", onSigterm);
      instance.close().finally(resolve);
    };
    const onSigint = () => shutdown();
    const onSigterm = () => shutdown();
    signals.on("SIGINT", onSigint);
    signals.on("SIGTERM", onSigterm);
  });
  return 0;
}
