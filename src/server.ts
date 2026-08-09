import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { Store } from "./db.js";
import { RaceRunner } from "./sim.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type JsonBody = Record<string, unknown>;

function sendJson(res: http.ServerResponse, code: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

function readBody(req: http.IncomingMessage, maxBytes = 1_000_000): Promise<JsonBody> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("payload too large"));
        req.destroy();
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
};

export interface ServerHandle {
  port: number;
  close: () => Promise<void>;
}

export function createApp(db: Store, runner: RaceRunner, opts: { port?: number } = {}): ServerHandle {
  const bound = { port: opts.port ?? 0 };
  const clients = new Set<WebSocket>();

  const broadcast = (): void => {
    const message = JSON.stringify({ type: "race", snapshot: runner.snapshot() });
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) client.send(message);
    }
  };

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
        serveStatic(res, "/index.html");
        return;
      }
      if (req.method === "GET" && (req.url?.startsWith("/assets/") || req.url?.startsWith("/fonts/"))) {
        serveStatic(res, req.url);
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

  const wss = new WebSocketServer({ server });
  wss.on("connection", (socket) => {
    clients.add(socket);
    socket.send(JSON.stringify({ type: "race", snapshot: runner.snapshot() }));
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
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => clients.delete(socket));
  });

  const tick = setInterval(() => {
    if (runner.isRunning()) broadcast();
  }, db.getConfig().tickMs);

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
        clearInterval(tick);
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
    const laps = db.listLaps();
    sendJson(res, 200, { laps });
    return;
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "events" && parts.length === 2) {
    const after = getId(url.searchParams.get("after") ?? undefined);
    sendJson(res, 200, { events: after === null ? db.listEvents() : db.listEvents(after) });
    return;
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "control" && parts.length === 2) {
    const body = await readBody(req);
    const action = body.action;
    if (action === "start") runner.start();
    else if (action === "pause") runner.pause();
    else if (action === "reset") runner.reset();
    else {
      sendJson(res, 400, { error: "action must be start|pause|reset" });
      return;
    }
    broadcast();
    sendJson(res, 200, { race: runner.snapshot() });
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

function serveStatic(res: http.ServerResponse, requestPath: string): void {
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
  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      "Content-Length": data.length,
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600",
    });
    res.end(data);
  });
}