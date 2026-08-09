import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../src/db";

describe("Store (SQLite)", () => {
  it("seeds six drivers ordered by pace", () => {
    const store = new Store();
    const drivers = store.listDrivers();
    expect(drivers).toHaveLength(6);
    expect(drivers[0]!.baseMs).toBeLessThan(drivers[drivers.length - 1]!.baseMs);
    store.close();
  });

  it("reads a session config", () => {
    const store = new Store();
    const config = store.getConfig();
    expect(config.plannedLaps).toBeGreaterThan(0);
    expect(config.nominalMs).toBeGreaterThan(0);
    store.close();
  });

  it("appends laps once per driver per lap index", () => {
    const store = new Store();
    const driverId = store.listDrivers()[0]!.id;
    store.addLap(driverId, 1, 30100, 1);
    store.addLap(driverId, 1, 99999, 2);
    store.addLap(driverId, 2, 29800, 3);
    expect(store.listLaps()).toHaveLength(2);
    expect(store.listLaps()[0]!.ms).toBe(30100);
    store.close();
  });

  it("orders events by id and filters after a cursor", () => {
    const store = new Store();
    store.addEvent("system", "first", 1);
    store.addEvent("overtake", "second", 2);
    store.addEvent("flag", "third", 3);
    const all = store.listEvents();
    expect(all.map((e) => e.kind)).toEqual(["system", "overtake", "flag"]);
    const after = store.listEvents(all[1]!.id);
    expect(after).toHaveLength(1);
    expect(after[0]!.text).toBe("third");
    store.close();
  });

  it("persists to a file and reloads", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "apex-"));
    const file = path.join(dir, "race.db");
    try {
      const first = new Store(file);
      const driverId = first.listDrivers()[0]!.id;
      first.addLap(driverId, 1, 30500, 42);
      first.addEvent("fastest", "hot lap", 42);
      first.close();

      const second = new Store(file);
      expect(second.listLaps()).toHaveLength(1);
      expect(second.listEvents()[0]!.text).toBe("hot lap");
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});