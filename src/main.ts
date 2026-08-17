import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "./db.js";
import { RaceRunner } from "./sim.js";
import { createApp } from "./server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ACC = (s: string): string => `\x1b[1m\x1b[38;2;207;255;4m${s}\x1b[0m`;
const DIM = (s: string): string => `\x1b[2m${s}\x1b[0m`;
const RED = (s: string): string => `\x1b[38;2;255;46;31m${s}\x1b[0m`;
const CREAM = (s: string): string => `\x1b[1m${s}\x1b[0m`;

function bootBanner(port: number, dbFile: string): string {
  const W = 76;
  const line = "┌" + "─".repeat(W) + "┐";
  const sep = "├" + "─".repeat(W) + "┤";
  const bottom = "└" + "─".repeat(W) + "┘";
  const cell = (left: string, right = ""): string => {
    const pad = W - left.length - right.length;
    return `│ ${left}${" ".repeat(Math.max(pad, 1))}${right} │`;
  };
  const rows = [
    cell(`${ACC("REDLINE ▸ LIVE RACING TERMINAL")}`, RED("LIVE")),
    cell(`${DIM("real-time broadcast · react 19 + node + websocket + sqlite")}`),
    sep,
    cell("http", ACC(`http://127.0.0.1:${port}`)),
    cell("ws", ACC(`ws://127.0.0.1:${port}/ws`)),
    cell("db", DIM(dbFile)),
    cell("api", DIM("GET /api/session · /api/drivers · /api/laps · /api/events   POST /api/control")),
    sep,
    cell("control", DIM("POST /api/control {action: start | pause | resume | reset}")),
    cell("status", CREAM("grid set — waiting for lights out")),
    bottom,
  ];
  return [line, ...rows].join("\n");
}

async function main(): Promise<void> {
  const rawPort = process.env.PORT ?? "3004";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`invalid PORT "${rawPort}"`);
    process.exit(1);
  }
  const dbFile = process.env.DB_FILE ?? path.join(__dirname, "..", "data", "redline.db");
  const autostart = process.argv.includes("--start");

  if (!dbFile.includes(":memory:")) {
    mkdirSync(path.dirname(dbFile), { recursive: true });
  }

  const db = new Store(dbFile);
  const runner = new RaceRunner(db);
  const handle = createApp(db, runner, { port });
  try {
    await new Promise<void>((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (handle.port > 0) {
          clearInterval(timer);
          resolve();
        } else if (Date.now() - started > 3000) {
          clearInterval(timer);
          reject(new Error("listen timeout"));
        }
      }, 25);
    });
  } catch {
    console.error(`failed to listen on 127.0.0.1:${port} — address in use?`);
    process.exit(1);
  }

  console.log(bootBanner(handle.port, dbFile));
  console.log();

  const grid = db.listDrivers();
  console.log(`${ACC(`GRID (${grid.length})`)}`);
  for (const d of grid) {
    console.log(`  #${String(d.number).padStart(2, "0")}  ${CREAM(d.name.padEnd(16))} ${DIM(d.team.padEnd(20))} ${DIM(`${(d.baseMs / 1000).toFixed(1)}s`)}`);
  }
  console.log();

  if (autostart) {
    runner.start();
    console.log(RED("LIGHTS OUT — race started"));
  } else {
    console.log(DIM("session idle — POST /api/control {action: start} to launch"));
  }

  const shutdown = (): void => {
    handle.close().finally(() => db.close());
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();