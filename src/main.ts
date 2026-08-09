import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Store, Column } from "./db.js";
import { createApp } from "./server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ACC = (s: string): string => `\x1b[1m\x1b[38;2;91;155;255m${s}\x1b[0m`;
const GREEN = (s: string): string => `\x1b[32m${s}\x1b[0m`;
const DIM = (s: string): string => `\x1b[2m${s}\x1b[0m`;

function bootBanner(port: number, dbFile: string, boardName: string, taskCount: number): string {
  const W = 66;
  const line = "┌" + "─".repeat(W) + "┐";
  const sep = "├" + "─".repeat(W) + "┤";
  const bottom = "└" + "─".repeat(W) + "┘";
  const cell = (left: string, right = ""): string => {
    const pad = W - left.length - right.length;
    return `│ ${left}${" ".repeat(Math.max(pad, 1))}${right} │`;
  };
  const rows = [
    cell(`${ACC("taskboard")}`, GREEN("● online")),
    cell("real-time kanban · react 19 + node + websocket"),
    sep,
    cell("http", ACC(`http://127.0.0.1:${port}`)),
    cell("ws", ACC(`ws://127.0.0.1:${port}/ws`)),
    cell("db", DIM(dbFile)),
    cell("REST", DIM("/api/boards · /api/boards/:id/tasks · /api/tasks/:id/move")),
    sep,
    cell(`board "${boardName}" · ${taskCount} tasks`, DIM("--seed resets")),
    cell("status", GREEN("ready — waiting for connections")),
    bottom,
  ];
  return [line, ...rows].join("\n");
}

interface MainOptions {
  port: number;
  dbFile: string;
  seed: boolean;
}

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 3004);
  const dbFile = process.env.DB_FILE ?? path.join(__dirname, "..", "data", "taskboard.db");
  const seed = process.argv.includes("--seed");

  if (!dbFile.includes(":memory:")) {
    mkdirSync(path.dirname(dbFile), { recursive: true });
  }

  const db = new Store(dbFile);
  let board = (db.listBoards() ?? [])[0];
  if (!board) {
    board = db.createBoard("Team Sprint");
  }
  if (seed) {
    for (const task of db.listTasks(board.id)) db.deleteTask(task.id);
    const seedTasks: ReadonlyArray<[Column, string]> = [
      ["todo", "Design the WebSocket protocol"],
      ["todo", "Write SQLite migration"],
      ["todo", "Add optimistic move rollback"],
      ["doing", "Build kanban columns UI"],
      ["doing", "Wire real-time events to store"],
      ["done", "Scaffold React + Vite"],
      ["done", "Set up CI pipeline"],
    ];
    for (const [column, title] of seedTasks) db.addTask(board.id, title, column);
  }
  const firstBoard = db.getBoard(board.id);

  const handle = createApp(db, { port });
  await new Promise<void>((resolve) => setTimeout(resolve, 200));

  const name = firstBoard?.name ?? "Team Sprint";
  const count = firstBoard ? db.listTasks(firstBoard.id).length : 0;
  console.log(bootBanner(handle.port, dbFile, name, count));

  const shutdown = (): void => {
    handle.close().finally(() => db.close());
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();