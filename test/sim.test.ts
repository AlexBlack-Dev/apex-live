import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/db";
import { RaceRunner } from "../src/sim";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("RaceRunner", () => {
  let store: Store;
  let runner: RaceRunner;

  beforeEach(() => {
    process.env.RACE_NOMINAL_MS = "900";
    process.env.RACE_TICK_MS = "100";
    process.env.RACE_LAPS = "12";
    store = new Store();
    runner = new RaceRunner(store);
  });

  afterEach(() => {
    runner.close();
    store.close();
  });

  it("starts idle with an empty grid state", () => {
    const snapshot = runner.snapshot();
    expect(snapshot.session.running).toBe(false);
    expect(snapshot.standings).toHaveLength(6);
    expect(snapshot.drivers).toHaveLength(6);
  });

  it("completes laps and emits events while running", async () => {
    runner.start();
    expect(runner.isRunning()).toBe(true);
    await sleep(3600);
    const snapshot = runner.snapshot();
    expect(runner.debugLapsInStore().length).toBeGreaterThan(1);
    expect(snapshot.session.running).toBe(true);
    expect(snapshot.standings[0]!.lapsDone).toBeGreaterThanOrEqual(snapshot.standings[1]!.lapsDone);
    expect(runner.debugEventsInStore().length).toBeGreaterThan(0);
    runner.pause();
    expect(runner.isRunning()).toBe(false);
  });

  it("pause freezes the race", async () => {
    runner.start();
    await sleep(1400);
    runner.pause();
    const lapsAtPause = runner.debugLapsInStore().length;
    await sleep(800);
    expect(runner.debugLapsInStore().length).toBe(lapsAtPause);
  });

  it("reset clears history and leaves the grid", async () => {
    runner.start();
    await sleep(1500);
    runner.reset();
    expect(runner.debugLapsInStore()).toHaveLength(0);
    expect(runner.debugEventsInStore().length).toBeGreaterThanOrEqual(1);
    expect(runner.snapshot().drivers).toHaveLength(6);
    expect(runner.isRunning()).toBe(false);
  });

  it("standings are sorted by laps then total time with gap to leader", async () => {
    runner.start();
    await sleep(3200);
    const { standings } = runner.snapshot();
    for (let i = 1; i < standings.length; i++) {
      const prev = standings[i - 1]!;
      const cur = standings[i]!;
      if (prev.lapsDone === cur.lapsDone) {
        expect(prev.totalMs).toBeLessThanOrEqual(cur.totalMs);
      }
    }
    expect(standings[0]!.gapMs).toBe(0);
    expect(standings.every((s) => s.gapMs >= 0)).toBe(true);
  });

  it("reports progress in [0,1] for racing drivers", async () => {
    runner.start();
    await sleep(600);
    const { standings } = runner.snapshot();
    for (const row of standings) {
      if (row.state === "racing") {
        expect(row.progress).toBeGreaterThanOrEqual(0);
        expect(row.progress).toBeLessThanOrEqual(1);
      }
    }
  });
});