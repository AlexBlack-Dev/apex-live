import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { Store } from "../src/db";
import { RaceRunner } from "../src/sim";
import { createApp, ServerHandle } from "../src/server";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let db: Store;
let runner: RaceRunner;
let handle: ServerHandle;
let base: string;

beforeAll(async () => {
  process.env.RACE_NOMINAL_MS = "900";
  process.env.RACE_TICK_MS = "100";
  process.env.RACE_LAPS = "12";
  db = new Store();
  runner = new RaceRunner(db);
  handle = createApp(db, runner, { port: 0 });
  await sleep(300);
  base = `http://127.0.0.1:${handle.port}/api`;
});

afterAll(async () => {
  await handle.close();
  db.close();
});

describe("REST API", () => {
  it("returns a session snapshot", async () => {
    const response = await fetch(`${base}/session`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      race: { session: { running: boolean; plannedLaps: number }; standings: unknown[]; drivers: unknown[] };
    };
    expect(body.race.session.running).toBe(false);
    expect(body.race.standings).toHaveLength(6);
    expect(body.race.drivers).toHaveLength(6);
  });

  it("lists drivers and laps", async () => {
    const drivers = await (await fetch(`${base}/drivers`)).json() as { drivers: Array<{ number: number }> };
    expect(drivers.drivers).toHaveLength(6);
    const laps = await (await fetch(`${base}/laps`)).json() as { laps: unknown[] };
    expect(laps.laps).toEqual([]);
  });

  it("rejects unknown control actions", async () => {
    const response = await fetch(`${base}/control`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "launch" }),
    });
    expect(response.status).toBe(400);
  });

  it("start runs and pause freezes the race via HTTP control", async () => {
    const started = await fetch(`${base}/control`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "start" }),
    });
    expect(started.status).toBe(200);
    const running = (await started.json()) as { race: { session: { running: boolean } } };
    expect(running.race.session.running).toBe(true);
    await sleep(2200);
    const mid = await (await fetch(`${base}/laps`)).json() as { laps: unknown[] };
    expect(mid.laps.length).toBeGreaterThan(0);

    const paused = await fetch(`${base}/control`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "pause" }),
    });
    const frozen = (await paused.json()) as { race: { session: { running: boolean } } };
    expect(frozen.race.session.running).toBe(false);
  });

  it("reset clears laps and events cursor works after racing", async () => {
    const response = await fetch(`${base}/control`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reset" }),
    });
    expect(response.status).toBe(200);
    const laps = await (await fetch(`${base}/laps`)).json() as { laps: unknown[] };
    expect(laps.laps).toEqual([]);

    const events = await (await fetch(`${base}/events`)).json() as {
      events: Array<{ id: number; text: string }>;
    };
    expect(events.events.length).toBeGreaterThan(0);
    const lastId = events.events[events.events.length - 1]!.id;
    const rest = await (await fetch(`${base}/events?after=${lastId}`)).json() as { events: unknown[] };
    expect(rest.events).toHaveLength(0);
  });
});

describe("WebSocket broadcast", () => {
  it("pushes an initial race snapshot on connect", async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${handle.port}/ws`);
    const first = new Promise<{ type: string; snapshot?: unknown }>((resolve) =>
      socket.once("message", (data) => resolve(JSON.parse(data.toString()) as never))
    );
    const message = await first;
    expect(message.type).toBe("race");
    expect(message.snapshot).toBeDefined();
    socket.close();
  });

  it("streams race ticks while the race runs", async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${handle.port}/ws`);
    await new Promise<void>((resolve) => socket.once("open", resolve));
    await fetch(`${base}/control`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "start" }),
    });
    let ticks = 0;
    const sawTick = new Promise<void>((resolve) => {
      socket.on("message", () => {
        ticks += 1;
        if (ticks >= 4) resolve();
      });
    });
    await sawTick;
    expect(ticks).toBeGreaterThanOrEqual(4);
    socket.close();
    await fetch(`${base}/control`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reset" }),
    });
  });

  it("replies pong to ping", async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${handle.port}/ws`);
    await new Promise<void>((resolve) => socket.once("open", resolve));
    socket.send(JSON.stringify({ type: "ping" }));
    const reply = await new Promise<{ type: string }>((resolve) =>
      socket.once("message", (data) => resolve(JSON.parse(data.toString()) as never))
    );
    expect(reply.type).toBe("pong");
    socket.close();
  });
});