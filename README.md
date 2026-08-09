# taskboard

Real-time kanban board — a full-stack web application with zero-framework React
UI and a plain-Node.js server over WebSocket.

[![CI](https://github.com/AlexBlack-Dev/taskboard/actions/workflows/ci.yml/badge.svg)](https://github.com/AlexBlack-Dev/taskboard/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Stack

| Layer      | Tech                                   |
| ---------- | -------------------------------------- |
| Backend    | Node.js (http core), TypeScript        |
| Storage    | SQLite via better-sqlite3 (WAL)        |
| Real-time  | WebSocket (ws), broadcast on change    |
| Frontend   | React 19, Vite 8, plain CSS            |
| Tests      | Vitest (unit + API + WebSocket)        |

## Quick start

```bash
npm install
npm run dev          # API + WebSocket server on :3004
npm run dev:client   # Vite dev server on :5173 (proxies /api and /ws)
```

Open `http://localhost:5173` — the first board is created automatically.
`npm run build` compiles the client into `client/dist`, which the server then
serves itself on `http://127.0.0.1:3004`.

## Terminal

| Server boot (colored banner) | Board UI |
| ---------------------------- | -------- |
| ![Server boot](docs/screenshots-server.png) | ![Board UI](docs/screenshots-board.png) |

## API

| Method | Route                          | Action                          |
| ------ | ------------------------------ | ------------------------------- |
| GET    | `/api/boards`                  | list boards                     |
| POST   | `/api/boards`                  | create board                    |
| GET    | `/api/boards/:id`              | board + tasks                   |
| POST   | `/api/boards/:id/tasks`        | add task (`title`, `column`)    |
| POST   | `/api/boards/:id/reset`        | reseed a demo board             |
| POST   | `/api/tasks/:id/move`          | move task (`column: todo/doing/done`) |
| DELETE | `/api/tasks/:id`               | delete task                     |

Every mutation broadcasts `{"type":"board-updated","boardId":N}` to all
connected WebSocket clients; the UI refetches the board on the event.

## Architecture

```
client/  React 19 SPA (Vite) — optimistic UI, WS subscription
src/     Node server
  db.ts        SQLite store (WAL, single-writer, prepared statements)
  server.ts    http core: routing, JSON parsing, static client, ws broadcast
  main.ts      boot, CLI flags (--seed), colored banner
test/    Vitest: store, REST, WebSocket protocol
```

Key design decisions:

- **SQLite WAL + prepared statements** — ACID without a separate DB daemon;
  `better-sqlite3` runs statements synchronously, so ordering is trivially
  consistent and broadcast events always follow the committed state.
- **WebSocket broadcast, not sync protocol** — the client owns a local snapshot
  and refetches on `board-updated`; the wire protocol stays minimal and
  versioning is trivial.
- **Plain-Node http core** — no express dependency; routing is explicit and
  covered by tests.
- **Row dedup columns** — task ordering uses a density-based `position`
  column (`+1000` steps), so inserts never invalidate existing positions.

## Project layout

```
src/db.ts        store schema + queries (single file, 130 LOC)
src/server.ts    http + ws wiring
src/main.ts      entry point
client/          React app (App.tsx, styles.css)
test/            vitest suites
docs/            screenshots
.github/workflows/ci.yml   typecheck → test → build
```

## Tests

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest run — 16 tests
```

CI runs the same three steps (typecheck, tests, production build) on Node 22.

## Local measurements

Full HTTP+WS+SQLite round trip on this machine (`GET /api/boards`,
400 requests):

```
avg  1.18 ms
p50  0.94 ms
p95  1.60 ms
```

The WebSocket path reuses the same HTTP server; broadcast delivery is a single
`client.send` per connected peer (one syscall each).