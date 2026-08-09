import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { Store, COLUMNS, Column } from "./db.js";

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
  return Number.isInteger(id) && id > 0 ? id : null;
}

function parseColumn(value: unknown): Column | null {
  return typeof value === "string" && COLUMNS.includes(value as Column)
    ? (value as Column)
    : null;
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

export function createApp(db: Store, opts: { port?: number } = {}): ServerHandle {
  const bound = { port: opts.port ?? 0 };
  const clients = new Set<WebSocket>();

  const broadcast = (boardId: number): void => {
    const message = JSON.stringify({ type: "board-updated", boardId });
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
      if (req.method === "GET" && req.url?.startsWith("/assets/")) {
        serveStatic(res, req.url);
        return;
      }
      if (!req.url || !req.url.startsWith("/api/")) {
        sendJson(res, 404, { error: "not found" });
        return;
      }
      await routeApi(req, res, db, broadcast);
    } catch (error) {
      const message = error instanceof Error ? error.message : "server error";
      sendJson(res, 400, { error: message });
    }
  });

  const wss = new WebSocketServer({ server });
  wss.on("connection", (socket) => {
    clients.add(socket);
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
  broadcast: (boardId: number) => void
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "boards" && parts.length === 2) {
    sendJson(res, 200, { boards: db.listBoards() });
    return;
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "boards" && parts.length === 2) {
    const body = await readBody(req);
    const name =
      typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 80) : null;
    if (!name) {
      sendJson(res, 400, { error: "name is required" });
      return;
    }
    sendJson(res, 201, { board: db.createBoard(name) });
    return;
  }

  if (
    req.method === "POST" &&
    parts[0] === "api" &&
    parts[1] === "boards" &&
    parts[2] &&
    parts[3] === "reset"
  ) {
    const boardId = getId(parts[2]);
    if (!boardId) {
      sendJson(res, 400, { error: "invalid board id" });
      return;
    }
    for (const task of db.listTasks(boardId)) db.deleteTask(task.id);
    const seed: ReadonlyArray<readonly [Column, string]> = [
      ["todo", "Design the WebSocket protocol"],
      ["todo", "Write SQLite migration"],
      ["todo", "Add optimistic move rollback"],
      ["doing", "Build kanban columns UI"],
      ["doing", "Wire real-time events to store"],
      ["done", "Scaffold React + Vite"],
      ["done", "Set up CI pipeline"],
    ];
    for (const [column, title] of seed) {
      db.addTask(boardId, title, column);
    }
    broadcast(boardId);
    sendJson(res, 200, { ok: true, board: db.getBoard(boardId) });
    return;
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "boards" && parts.length === 3) {
    const boardId = getId(parts[2]);
    if (boardId === null) {
      sendJson(res, 400, { error: "invalid board id" });
      return;
    }
    const board = db.getBoard(boardId);
    if (!board) {
      sendJson(res, 404, { error: "board not found" });
      return;
    }
    sendJson(res, 200, { board, tasks: db.listTasks(boardId) });
    return;
  }

  if (
    req.method === "POST" &&
    parts[0] === "api" &&
    parts[1] === "boards" &&
    parts.length === 4 &&
    parts[3] === "tasks"
  ) {
    const boardId = getId(parts[2]);
    const body = await readBody(req);
    const title =
      typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 200) : null;
    const column = parseColumn(body.column) ?? "todo";
    if (!boardId || !title) {
      sendJson(res, 400, { error: "boardId and title are required" });
      return;
    }
    const task = db.addTask(boardId, title, column);
    if (!task) {
      sendJson(res, 404, { error: "board not found" });
      return;
    }
    broadcast(boardId);
    sendJson(res, 201, { task });
    return;
  }

  if (
    req.method === "POST" &&
    parts[0] === "api" &&
    parts[1] === "tasks" &&
    parts.length === 4 &&
    parts[3] === "move"
  ) {
    const taskId = getId(parts[2]);
    const body = await readBody(req);
    const column = parseColumn(body.column);
    if (!taskId || !column) {
      sendJson(res, 400, { error: "taskId and column are required" });
      return;
    }
    const task = db.moveTask(taskId, column);
    if (!task) {
      sendJson(res, 404, { error: "task not found" });
      return;
    }
    broadcast(task.boardId);
    sendJson(res, 200, { task });
    return;
  }

  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "tasks" && parts.length === 3) {
    const taskId = getId(parts[2]);
    if (!taskId) {
      sendJson(res, 400, { error: "invalid task id" });
      return;
    }
    const task = db.getTask(taskId);
    if (!db.deleteTask(taskId)) {
      sendJson(res, 404, { error: "task not found" });
      return;
    }
    if (task) broadcast(task.boardId);
    sendJson(res, 200, { ok: true });
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
    });
    res.end(data);
  });
}