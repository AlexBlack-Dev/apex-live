import { Store, Driver, Lap, RaceEvent } from "./db.js";

export type DriverState = "racing" | "pit";

export interface LiveDriver {
  driverId: number;
  position: number;
  lapsDone: number;
  totalMs: number;
  gapMs: number;
  lastLapMs: number | null;
  bestLapMs: number | null;
  deltaMs: number | null;
  state: DriverState;
  pitMs: number;
  paceMs: number;
  progress: number;
}

export interface SessionSnapshot {
  running: boolean;
  startedAt: number | null;
  simMs: number;
  currentLap: number;
  plannedLaps: number;
  leaderId: number | null;
  leaderLaps: number;
  airTempC: number;
  trackTempC: number;
  humidityPct: number;
  lastLapAt: number | null;
  mostRecentEvent: string | null;
}

export interface RaceSnapshot {
  session: SessionSnapshot;
  standings: LiveDriver[];
  drivers: Driver[];
  lapCount: number;
  events: RaceEvent[];
}

interface SimDriver {
  driver: Driver;
  state: DriverState;
  paceMs: number;
  lapsDone: number;
  lapStartedAt: number;
  partialMs: number;
  bestLapMs: number | null;
  lastLapMs: number | null;
  prevTotalMs: number;
  pitUntilAt: number;
  pitPaceMs: number;
  hasPitted: boolean;
}

const PARKLOT_MS = 7600;

export class RaceRunner {
  private readonly store: Store;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private startedAt = 0;
  private simMs = 0;
  private drivers: SimDriver[] = [];
  private rallyNominal: number;
  private rallyTicks: number;
  private plannedLaps: number;

  constructor(store: Store) {
    this.store = store;
    const config = store.getConfig();
    const baseNominal = config.nominalMs;
    this.rallyNominal = Number(process.env.RACE_NOMINAL_MS ?? config.nominalMs) || 30500;
    this.rallyTicks = Number(process.env.RACE_TICK_MS ?? config.tickMs) || 500;
    this.plannedLaps = Number(process.env.RACE_LAPS ?? config.plannedLaps) || 10;
    this.paceScale = this.rallyNominal / baseNominal;
    this.resetRunners();
  }

  private paceScale = 1;

  private resetRunners(): void {
    this.drivers = this.store.listDrivers().map((driver) => {
      const paceMs = Math.max(600, Math.round(driver.baseMs * this.paceScale));
      return {
        driver,
        state: "racing" as DriverState,
        paceMs,
        lapsDone: 0,
        lapStartedAt: 0,
        partialMs: 0,
        bestLapMs: null,
        lastLapMs: null,
        prevTotalMs: 0,
        pitUntilAt: -1,
        pitPaceMs: 0,
        hasPitted: false,
      };
    });
  }

  isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.store.clearLaps();
    this.store.clearEvents();
    this.resetRunners();
    this.running = true;
    this.startedAt = Date.now();
    this.simMs = 0;
    for (const s of this.drivers) {
      s.lapStartedAt = 0;
      s.partialMs = 0;
    }
    this.store.addEvent("flag", "Lights out — the race is on", Date.now());
    this.timer = setInterval(() => this.tick(), this.rallyTicks);
  }

  pause(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.store.addEvent("flag", "Race paused by control", Date.now());
  }

  reset(): void {
    this.pause();
    this.store.clearLaps();
    this.store.clearEvents();
    this.store.addEvent("system", "Session reset — grid is set", Date.now());
    this.resetRunners();
  }

  snapshot(now = Date.now()): RaceSnapshot {
    const standings = this.computeStandings(now);
    return {
      session: {
        running: this.running,
        startedAt: this.running ? this.startedAt : null,
        simMs: this.simMs,
        plannedLaps: this.plannedLaps,
        currentLap: this.globalLap(now),
        leaderId: standings[0]?.driverId ?? null,
        leaderLaps: standings[0]?.lapsDone ?? 0,
        airTempC: 21.4 + Math.sin(this.simMs / 90000) * 1.2,
        trackTempC: 26.1 + Math.sin(this.simMs / 64000 + 1.7) * 2.4,
        humidityPct: 44 + Math.cos(this.simMs / 140000) * 6,
        lastLapAt: standings.some((s) => s.lastLapMs !== null) ? now : null,
        mostRecentEvent: this.store.listEvents().at(-1)?.text ?? null,
      },
      standings,
      drivers: this.store.listDrivers(),
      lapCount: this.store.listLaps().length,
      events: this.store.listEvents().slice(-30),
    };
  }

  private tick(): void {
    if (!this.running) return;
    const step = this.rallyTicks;
    this.simMs += step;
    const now = Date.now();

    for (const s of this.drivers) {
      if (s.state === "racing") {
        s.partialMs += step;
        if (s.partialMs >= s.paceMs) {
          this.completeLap(s, now);
        }
      } else if (now >= s.pitUntilAt) {
        const lost = Math.round(s.pitPaceMs / 1000);
        s.state = "racing";
        s.lapStartedAt = now;
        s.partialMs = 0;
        this.store.addEvent(
          "pit",
          `#${s.driver.number} ${s.driver.name} rejoins from the pits (−${lost}s)`,
          now
        );
      }
    }

    const standingsBefore = this.computeStandings(now - step);
    const standingsAfter = this.computeStandings(now);
    const done = this.drivers
      .map((s) => s.driver.id)
      .filter((id) => (standingsAfter.find((st) => st.driverId === id)?.lapsDone ?? 0) >= this.plannedLaps);
    if (done.length === this.drivers.length && this.drivers.length > 0) {
      this.finishRace(now);
    }

    for (const after of standingsAfter) {
      const before = standingsBefore.find((st) => st.driverId === after.driverId);
      if (before && after.position < before.position) {
        const sim = this.drivers.find((s) => s.driver.id === after.driverId);
        if (sim && sim.state === "racing") {
          this.store.addEvent(
            "overtake",
            `#${sim.driver.number} ${sim.driver.name} takes P${after.position}`,
            now
          );
        }
      }
    }
  }

  private completeLap(s: SimDriver, now: number): void {
    const noise = 0.965 + Math.random() * 0.07;
    const lapMs = Math.round((s.paceMs * noise) / 10) * 10;
    s.lapsDone += 1;
    s.lastLapMs = lapMs;
    if (s.bestLapMs === null || lapMs < s.bestLapMs) {
      s.bestLapMs = lapMs;
      this.store.addEvent(
        "fastest",
        `#${s.driver.number} ${s.driver.name} sets the fastest lap (${this.formatMs(lapMs)})`,
        now
      );
    }
    this.store.addLap(s.driver.id, s.lapsDone, lapMs, now);
    s.lapStartedAt = now;
    s.partialMs = 0;
    s.paceMs = this.nextPace(s);

    if (!s.hasPitted && s.lapsDone >= 2 && s.lapsDone <= 6 && Math.random() < 0.45) {
      s.hasPitted = true;
      s.state = "pit";
      s.pitPaceMs = PARKLOT_MS;
      s.pitUntilAt = now + PARKLOT_MS;
      this.store.addEvent(
        "pit",
        `#${s.driver.number} ${s.driver.name} pits for tyres`,
        now
      );
    }
  }

  private nextPace(s: SimDriver): number {
    const drift = (Math.random() - 0.5) * 0.4;
    const recovery = Math.random() < 0.06 ? 0.9 : 1;
    const next = s.paceMs * (1 + drift * 0.01) * recovery;
    const min = s.driver.baseMs * 0.96;
    const max = s.driver.baseMs * 1.08;
    return Math.min(max, Math.max(min, next));
  }

  private globalLap(now: number): number {
    const maxLaps = Math.max(1, ...this.drivers.map((s) => s.lapsDone + (s.state === "racing" ? 1 : 0)));
    return Math.min(this.plannedLaps, maxLaps);
  }

  private computeStandings(now: number): LiveDriver[] {
    const rows = this.drivers.map((s) => {
      const progress = s.state === "racing" ? Math.min(1, s.partialMs / s.paceMs) : 0;
      const totalMs =
        this.store.listLaps().filter((l) => l.driverId === s.driver.id).reduce((a, l) => a + l.ms, 0) +
        (s.state === "racing" ? Math.round(progress * s.paceMs) : 0) +
        (s.state === "pit" && s.pitUntilAt > 0 ? Math.max(0, now - s.lapStartedAt - 0) : 0);
      const best =
        s.bestLapMs ??
        this.store
          .listLaps()
          .filter((l) => l.driverId === s.driver.id)
          .reduce<number | null>((best, l) => (best === null || l.ms < best ? l.ms : best), null);
      const lapsDone = this.store.listLaps().filter((l) => l.driverId === s.driver.id).length;
      const last =
        this.store
          .listLaps()
          .filter((l) => l.driverId === s.driver.id)
          .at(-1)?.ms ?? null;
      const prev =
        this.store
          .listLaps()
          .filter((l) => l.driverId === s.driver.id)
          .at(-2)?.ms ?? null;
      return {
        driverId: s.driver.id,
        totalMs,
        lapsDone,
lastLapMs: last ?? null,
      bestLapMs: best ?? null,
      deltaMs: last !== null && prev !== null ? last - prev : null,
      state: s.state,
      pitMs: s.state === "pit" ? Math.max(0, s.pitUntilAt - now) : 0,
      paceMs: Math.round(s.paceMs),
      progress: s.state === "racing" ? Math.min(1, s.partialMs / s.paceMs) : 0,
    };
    });

    rows.sort((a, b) => {
      if (a.lapsDone !== b.lapsDone) return b.lapsDone - a.lapsDone;
      return a.totalMs - b.totalMs;
    });
    const leaderTotal = rows[0]?.totalMs ?? 0;
    const leaderLaps = rows[0]?.lapsDone ?? 0;

    return rows.map((row, index) => ({
      driverId: row.driverId,
      position: index + 1,
      lapsDone: row.lapsDone,
      totalMs: row.totalMs,
      gapMs: row.totalMs - leaderTotal,
      lastLapMs: row.lastLapMs,
      bestLapMs: row.bestLapMs,
      deltaMs: row.deltaMs,
      state: row.state,
      pitMs: row.pitMs,
      paceMs: row.paceMs,
      progress: row.progress,
    }));
  }

  private finishRace(now: number): void {
    this.pause();
    this.store.addEvent("flag", "Checkered flag — race complete", now);
  }

  private formatMs(ms: number): string {
    return `${(ms / 1000).toFixed(1)}s`;
  }

  close(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
  }

  debugSimMs(): number {
    return this.simMs;
  }

  debugLapsInStore(): Lap[] {
    return this.store.listLaps();
  }

  debugEventsInStore(): RaceEvent[] {
    return this.store.listEvents();
  }
}