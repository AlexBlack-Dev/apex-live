import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { Store } from "./db.js";
import { RaceRunner } from "./sim.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type JsonBody = Record<string, unknown>;

const MAX_BODY_BYTES = 1_000_000;
const WS_MAX_PAYLOAD = 1_000_000;
const WS_HEARTBEAT_MS = 30_000;

function sendJson(res: http.ServerResponse, code: number, body: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  const data = JSON.stringify(body);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

function readBody(req: http.IncomingMessage): Promise<JsonBody> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("payload too large"));
        req.removeAllListeners("end");
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonBody);
      } catch {
        reject(new Error("invalid json"));
      }
    });
    req.on("error", reject);
  });
}

function getId(raw: string | undefined): number | null {
  if (!raw) return null;
  const id = Number(raw);
  return Number.isInteger(id) && id >= 0 ? id : null;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".mp4": "video/mp4",
};

export interface ServerHandle {
  port: number;
  close: () => Promise<void>;
}

export function createApp(db: Store, runner: RaceRunner, opts: { port?: number } = {}): ServerHandle {
  const bound = { port: opts.port ?? 0 };
  const clients = new Set<WebSocket>();
  const isAlive = new Map<WebSocket, boolean>();

  const broadcast = (): void => {
    const message = JSON.stringify({ type: "race", snapshot: runner.snapshot() });
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) client.send(message);
    }
  };

  runner.onTick = broadcast;

  const server = http.createServer(async (req, res) => {
    try {
      res.setHeader("Access-Control-Allow-Origin", "*");
      if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
        serveStatic(req, res, "/index.html");
        return;
      }
      if (req.method === "GET" && (req.url?.startsWith("/assets/") || req.url?.startsWith("/race-"))) {
        serveStatic(req, res, req.url);
        return;
      }
      if (!req.url || !req.url.startsWith("/api/")) {
        sendJson(res, 404, { error: "not found" });
        return;
      }
      await routeApi(req, res, db, runner, broadcast);
    } catch (error) {
      const message = error instanceof Error ? error.message : "server error";
      sendJson(res, 400, { error: message });
    }
  });

  const wss = new WebSocketServer({ server, maxPayload: WS_MAX_PAYLOAD });
  wss.on("connection", (socket) => {
    clients.add(socket);
    isAlive.set(socket, true);
    socket.send(JSON.stringify({ type: "race", snapshot: runner.snapshot() }));
    socket.on("pong", () => {
      isAlive.set(socket, true);
    });
    socket.on("message", (raw) => {
      try {
        const message = JSON.parse(raw.toString("utf8")) as JsonBody;
        if (message.type === "ping") {
          socket.send(JSON.stringify({ type: "pong" }));
        } else {
          socket.send(JSON.stringify({ type: "error", message: "unknown message type" }));
        }
      } catch {
        socket.send(JSON.stringify({ type: "error", message: "invalid message" }));
      }
    });
    socket.on("close", () => {
      clients.delete(socket);
      isAlive.delete(socket);
    });
    socket.on("error", () => {
      clients.delete(socket);
      isAlive.delete(socket);
    });
  });

  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (client.readyState !== WebSocket.OPEN) {
        clients.delete(client);
        isAlive.delete(client);
        continue;
      }
      if (isAlive.get(client) === false) {
        client.terminate();
        clients.delete(client);
        isAlive.delete(client);
        continue;
      }
      isAlive.set(client, false);
      client.ping();
    }
  }, WS_HEARTBEAT_MS);

  server.listen(bound.port, "127.0.0.1", () => {
    const address = server.address();
    if (address && typeof address === "object") bound.port = address.port;
  });

  const handle: ServerHandle = {
    get port(): number {
      return bound.port;
    },
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(heartbeat);
        runner.onTick = null;
        runner.close();
        for (const client of clients) client.terminate();
        wss.close();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
  return handle;
}

async function routeApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  db: Store,
  runner: RaceRunner,
  broadcast: () => void
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "session" && parts.length === 2) {
    sendJson(res, 200, { race: runner.snapshot() });
    return;
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "drivers" && parts.length === 2) {
    sendJson(res, 200, { drivers: db.listDrivers() });
    return;
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "laps" && parts.length === 2) {
    sendJson(res, 200, { laps: db.listLaps() });
    return;
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "events" && parts.length === 2) {
    const after = getId(url.searchParams.get("after") ?? undefined);
    sendJson(res, 200, { events: after === null ? db.listEvents() : db.listEvents(after) });
    return;
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "control" && parts.length === 2) {
    const body = await readBody(req);
    const action = typeof body.action === "string" ? body.action : null;
    if (action === "start") runner.start();
    else if (action === "pause") runner.pause();
    else if (action === "resume") runner.resume();
    else if (action === "reset") runner.reset();
    else {
      sendJson(res, 400, { error: "action must be start|pause|resume|reset" });
      return;
    }
    broadcast();
    sendJson(res, 200, { race: runner.snapshot() });
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, requestPath: string): void {
  const root = path.resolve(__dirname, "..", "client", "dist");
  if (!fs.existsSync(root)) {
    sendJson(res, 404, { error: "static client not built — run npm run build" });
    return;
  }
  const filePath = path.join(root, requestPath.replace(/^\/+/, ""));
  if (!filePath.startsWith(root)) {
    sendJson(res, 403, { error: "forbidden" });
    return;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const stat = fs.statSync(filePath);
  const mime = MIME[ext] ?? "application/octet-stream";
  const cacheControl = ext === ".html" ? "no-cache" : "public, max-age=3600";
  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) {
      res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
      res.end();
      return;
    }
    let start = match[1] ? parseInt(match[1], 10) : 0;
    let end = match[2] ? parseInt(match[2], 10) : stat.size - 1;
    if (start >= stat.size) {
      res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
      res.end();
      return;
    }
    end = Math.min(end, stat.size - 1);
    res.writeHead(206, {
      "Content-Type": mime,
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
      "Cache-Control": cacheControl,
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, {
    "Content-Type": mime,
    "Content-Length": stat.size,
    "Accept-Ranges": "bytes",
    "Cache-Control": cacheControl,
  });
  fs.createReadStream(filePath).pipe(res);
}