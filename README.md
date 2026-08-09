# APEX — Live Racing Terminal

Real-time race broadcasting platform: a live timing screen for motorsport
with position battles, fastest laps, pit windows and a rolling event ticker —
pushed to every connected client over WebSocket.

[![CI](https://github.com/AlexBlack-Dev/apex-live/actions/workflows/ci.yml/badge.svg)](https://github.com/AlexBlack-Dev/apex-live/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Stack

| Layer      | Tech                                   |
| ---------- | -------------------------------------- |
| Backend    | Node.js (http core), TypeScript        |
| Storage    | SQLite via better-sqlite3 (WAL)        |
| Real-time  | WebSocket (ws), race tick broadcast    |
| Frontend   | React 19, Vite 8, self-hosted fonts    |
| Tests      | Vitest (unit + simulator + REST + WS)  |

## Quick start

```bash
npm install
npm run dev            # server on :3004 (idle, grid set)
npm run dev:client     # Vite dev server on :5173
```

Open `http://localhost:5173`. To start the race from HTTP:

```bash
curl -X POST http://127.0.0.1:3004/api/control -d "{\"action\":\"start\"}" -H "Content-Type: application/json"
```

`npm run build` compiles the client into `client/dist`, which the server then
serves itself — the whole terminal lives on `http://127.0.0.1:3004`.

## Terminal

| Race screen (live timing) | Server boot |
| ------------------------- | ----------- |
| ![Race screen](docs/screenshots-board.png) | ![Server boot](docs/screenshots-server.png) |

## API

| Method | Route            | Action                      |
| ------ | ---------------- | --------------------------- |
| GET    | `/api/session`   | full race snapshot+ticker   |
| GET    | `/api/drivers`   | grid (6 drivers)            |
| GET    | `/api/laps`      | completed lap history       |
| GET    | `/api/events?after=` | race events (cursor)    |
| POST   | `/api/control`   | `{action: start\|pause\|reset}` |

Every 500 ms while the race runs, the server pushes
`{"type":"race","snapshot":{...}}` to all WebSocket clients: standings,
laps, gap to leader, last/best lap, pit state, track conditions, event ticker.

## Architecture

```
client/  React 19 SPA (Vite) — timing typography, live graph, ticker
src/
  db.ts        SQLite store: drivers, laps, events (WAL, single-writer)
  sim.ts       RaceRunner: pace model, pit windows, overtake detection
  server.ts    http core + ws push + static client
  main.ts      boot banner, control flags (--start)
test/    Vitest: store, simulator, REST, WebSocket protocol
```

Design decisions:

- **Model over state** — the simulator is a pace model with per-driver noise,
  tyre-window pit logic and overtake detection; positions derive from laps +
  partial progress, never from ad-hoc flags. Broadcast payloads are snapshots,
  so a reconnecting client converges immediately.
- **SQLite as the race recorder** — laps and events persist (WAL); the UI is a
  pure projection of the store, which makes replay/audit trivial.
- **Plain-Node http core** — no framework dependency; routing is explicit and
  covered by tests.
- **Self-hosted type** — Archivo Expanded, IBM Plex Mono and Instrument Serif
  (all OFL) ship as `woff2` in the client; the terminal renders identically
  offline, fonts and license files included in the repository.

## Tests

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest run — 19 tests
```

CI runs typecheck → tests → production build on Node 22.

## Typography & palette

Display: Archivo Expanded 125 (900, tight tracking) · Data: IBM Plex Mono
tabular · Embellishment: Instrument Serif italic · Accent: racing lime
`#CFFF04` on ink `#07080A`, paper `#F3F1EC`, alert red `#FF2E1F`.
Screen texture: film grain, carbon-diagonal pattern, oversized outline
wordmark. No rounded corners, no icon-swirl — broadcast-board language.