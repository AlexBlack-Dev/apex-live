import Database from "better-sqlite3";

export type DriverStateKind = "racing" | "pit";

export interface Driver {
  id: number;
  number: number;
  name: string;
  team: string;
  color: string;
  baseMs: number;
  jitterMs: number;
}

export interface Lap {
  id: number;
  driverId: number;
  lapIndex: number;
  ms: number;
  at: number;
}

export interface RaceEvent {
  id: number;
  at: number;
  kind: "overtake" | "fastest" | "pit" | "flag" | "system";
  text: string;
}

export interface SessionConfig {
  id: number;
  nominalMs: number;
  plannedLaps: number;
  tickMs: number;
}

const DEFAULT_DRIVERS: ReadonlyArray<readonly [number, string, string, string, number, number]> = [
  [11, "V. Reska", "Scuderia Torino", "#ff2e1f", 30500, 260],
  [7, "A. Kovac", "Nord Motorsport", "#5b9bff", 30800, 320],
  [23, "T. Esen", "Lumen Racing", "#cfff04", 31100, 290],
  [5, "R. Okada", "Kita Endurance", "#a78bfa", 31450, 340],
  [33, "F. Marchetti", "Rosso Corse", "#ff6b3d", 31900, 310],
  [96, "M. Solo", "Polar Dynamics", "#8e8c86", 32400, 360],
];

export class Store {
  private db: Database.Database;

  constructor(file = ":memory:") {
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        nominal_ms INTEGER NOT NULL,
        planned_laps INTEGER NOT NULL,
        tick_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS drivers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        number INTEGER NOT NULL UNIQUE,
        name TEXT NOT NULL,
        team TEXT NOT NULL,
        color TEXT NOT NULL DEFAULT '',
        base_ms INTEGER NOT NULL,
        jitter_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS laps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        driver_id INTEGER NOT NULL REFERENCES drivers(id),
        lap_index INTEGER NOT NULL,
        ms INTEGER NOT NULL,
        at INTEGER NOT NULL,
        UNIQUE (driver_id, lap_index)
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        text TEXT NOT NULL
      );
    `);
    this.seed();
    this.migrateColor();
  }

  private migrateColor(): void {
    const cols = this.db.prepare("PRAGMA table_info(drivers)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "color")) {
      this.db.exec("ALTER TABLE drivers ADD COLUMN color TEXT NOT NULL DEFAULT ''");
    }
  }

  private seed(): void {
    const count = this.db.prepare("SELECT COUNT(*) AS n FROM drivers").get() as { n: number };
    if (count.n === 0) {
      const insert = this.db.prepare(
        "INSERT INTO drivers (number, name, team, color, base_ms, jitter_ms) VALUES (?, ?, ?, ?, ?, ?)"
      );
      for (const [number, name, team, color, baseMs, jitterMs] of DEFAULT_DRIVERS) {
        insert.run(number, name, team, color, baseMs, jitterMs);
      }
    }
    const has = this.db.prepare("SELECT id FROM session WHERE id = 1").get();
    if (!has) {
      this.db
        .prepare("INSERT INTO session (id, nominal_ms, planned_laps, tick_ms) VALUES (1, ?, ?, ?)")
        .run(30500, 10, 500);
    }
  }

  getConfig(): SessionConfig {
    const row = this.db
      .prepare("SELECT id, nominal_ms AS nominalMs, planned_laps AS plannedLaps, tick_ms AS tickMs FROM session WHERE id = 1")
      .get() as SessionConfig;
    return row;
  }

  listDrivers(): Driver[] {
    return this.db
      .prepare("SELECT id, number, name, team, color, base_ms AS baseMs, jitter_ms AS jitterMs FROM drivers ORDER BY base_ms ASC")
      .all() as Driver[];
  }

  listLaps(): Lap[] {
    return this.db
      .prepare("SELECT id, driver_id AS driverId, lap_index AS lapIndex, ms, at FROM laps ORDER BY id ASC")
      .all() as Lap[];
  }

  addLap(driverId: number, lapIndex: number, ms: number, at: number): void {
    this.db
      .prepare("INSERT OR IGNORE INTO laps (driver_id, lap_index, ms, at) VALUES (?, ?, ?, ?)")
      .run(driverId, lapIndex, ms, at);
  }

  clearLaps(): void {
    this.db.prepare("DELETE FROM laps").run();
  }

  listEvents(afterId = 0): RaceEvent[] {
    return this.db
      .prepare("SELECT id, at, kind, text FROM events WHERE id > ? ORDER BY id ASC")
      .all(afterId) as RaceEvent[];
  }

  addEvent(kind: RaceEvent["kind"], text: string, at: number): void {
    this.db.prepare("INSERT INTO events (at, kind, text) VALUES (?, ?, ?)").run(at, kind, text);
  }

  clearEvents(): void {
    this.db.prepare("DELETE FROM events").run();
  }

  close(): void {
    this.db.close();
  }
}