import { Store, Driver, Lap, RaceEvent } from "./db.js";

export type DriverState = "racing" | "pit";
export type RacePhase = "idle" | "running" | "paused" | "finished";

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
  phase: RacePhase;
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
  partialMs: number;
  completedMs: number;
  bestLapMs: number | null;
  lastLapMs: number | null;
  prevLapMs: number | null;
  pitTotalMs: number;
  pitEnteredAt: number;
  hasPitted: boolean;
  justExitedPit: boolean;
}

const PARKLOT_MS = 7600;
const MAX_TICK_DT = 5000;

export class RaceRunner {
  private readonly store: Store;
  private timer: ReturnType<typeof setInterval> | null = null;
  private phase: RacePhase = "idle";
  private startedAt = 0;
  private raceTime = 0;
  private lastTickAt = 0;
  private drivers: SimDriver[] = [];
  private rallyNominal: number;
  private rallyTicks: number;
  private plannedLaps: number;
  private paceScale = 1;
  onTick: (() => void) | null = null;

  constructor(store: Store) {
    this.store = store;
    const config = store.getConfig();
    this.rallyNominal = Number(process.env.RACE_NOMINAL_MS ?? config.nominalMs) || 30500;
    this.rallyTicks = Number(process.env.RACE_TICK_MS ?? config.tickMs) || 500;
    this.plannedLaps = Number(process.env.RACE_LAPS ?? config.plannedLaps) || 10;
    this.paceScale = this.rallyNominal / config.nominalMs;
    this.resetRunners();
  }

  isRunning(): boolean {
    return this.phase === "running";
  }

  getPhase(): RacePhase {
    return this.phase;
  }

  start(): void {
    if (this.phase === "running") return;
    if (this.phase === "paused") {
      this.resume();
      return;
    }
    this.store.clearLaps();
    this.store.clearEvents();
    this.resetRunners();
    this.phase = "running";
    this.startedAt = Date.now();
    this.raceTime = 0;
    this.lastTickAt = Date.now();
    this.store.addEvent("flag", "Lights out — the race is on", this.raceTime);
    this.startTimer();
  }

  pause(): void {
    if (this.phase !== "running") return;
    this.phase = "paused";
    this.stopTimer();
    this.store.addEvent("flag", "Race paused by control", this.raceTime);
  }

  resume(): void {
    if (this.phase !== "paused") return;
    this.phase = "running";
    this.lastTickAt = Date.now();
    this.store.addEvent("flag", "Race resumed", this.raceTime);
    this.startTimer();
  }

  reset(): void {
    this.stopTimer();
    this.phase = "idle";
    this.raceTime = 0;
    this.lastTickAt = 0;
    this.store.clearLaps();
    this.store.clearEvents();
    this.store.addEvent("system", "Session reset — grid is set", 0);
    this.resetRunners();
  }

  snapshot(): RaceSnapshot {
    const standings = this.computeStandings();
    return {
      session: {
        phase: this.phase,
        running: this.phase === "running",
        startedAt: this.phase === "running" ? this.startedAt : null,
        simMs: this.raceTime,
        plannedLaps: this.plannedLaps,
        currentLap: this.globalLap(),
        leaderId: standings[0]?.driverId ?? null,
        leaderLaps: standings[0]?.lapsDone ?? 0,
        airTempC: 21.4 + Math.sin(this.raceTime / 90000) * 1.2,
        trackTempC: 26.1 + Math.sin(this.raceTime / 64000 + 1.7) * 2.4,
        humidityPct: 44 + Math.cos(this.raceTime / 140000) * 6,
        mostRecentEvent: this.store.listEvents().at(-1)?.text ?? null,
      },
      standings,
      drivers: this.store.listDrivers(),
      lapCount: this.store.listLaps().length,
      events: this.store.listEvents().slice(-30),
    };
  }

  private startTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.rallyTicks);
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    if (this.phase !== "running") return;
    const standingsBefore = this.computeStandings();

    const now = Date.now();
    const dt = Math.min(Math.max(now - this.lastTickAt, 0), MAX_TICK_DT);
    this.lastTickAt = now;
    this.raceTime += dt;

    for (const s of this.drivers) {
      if (s.state === "racing") {
        s.partialMs += dt;
        while (s.partialMs >= s.paceMs) {
          this.completeLap(s);
        }
      } else if (this.raceTime >= s.pitEnteredAt + PARKLOT_MS) {
        s.pitTotalMs += PARKLOT_MS;
        s.state = "racing";
        s.partialMs = 0;
        s.justExitedPit = true;
        this.store.addEvent(
          "pit",
          `#${s.driver.number} ${s.driver.name} rejoins from the pits (−${Math.round(PARKLOT_MS / 1000)}s)`,
          this.raceTime
        );
      }
    }

    const standingsAfter = this.computeStandings();

    if (this.drivers.length > 0 && this.drivers.every((s) => s.lapsDone >= this.plannedLaps)) {
      this.finishRace();
      this.onTick?.();
      return;
    }

    for (const after of standingsAfter) {
      const before = standingsBefore.find((st) => st.driverId === after.driverId);
      if (before && after.position < before.position) {
        const sim = this.drivers.find((s) => s.driver.id === after.driverId);
        if (sim && sim.state === "racing" && !sim.justExitedPit) {
          this.store.addEvent(
            "overtake",
            `#${sim.driver.number} ${sim.driver.name} takes P${after.position}`,
            this.raceTime
          );
        }
      }
    }

    for (const s of this.drivers) {
      s.justExitedPit = false;
    }

    this.onTick?.();
  }

  private completeLap(s: SimDriver): void {
    const noise = 0.965 + Math.random() * 0.07;
    const lapMs = Math.round((s.paceMs * noise) / 10) * 10;
    s.lapsDone += 1;
    s.prevLapMs = s.lastLapMs;
    s.lastLapMs = lapMs;
    s.completedMs += lapMs;
    s.partialMs -= s.paceMs;
    if (s.bestLapMs === null || lapMs < s.bestLapMs) {
      s.bestLapMs = lapMs;
      this.store.addEvent(
        "fastest",
        `#${s.driver.number} ${s.driver.name} sets the fastest lap (${this.formatMs(lapMs)})`,
        this.raceTime
      );
    }
    this.store.addLap(s.driver.id, s.lapsDone, lapMs, this.raceTime);
    s.paceMs = this.nextPace(s);

    if (!s.hasPitted && s.lapsDone >= 2 && s.lapsDone <= 6 && Math.random() < 0.45) {
      s.hasPitted = true;
      s.state = "pit";
      s.partialMs = 0;
      s.pitEnteredAt = this.raceTime;
      this.store.addEvent(
        "pit",
        `#${s.driver.number} ${s.driver.name} pits for tyres`,
        this.raceTime
      );
    }
  }

  private nextPace(s: SimDriver): number {
    const base = (s.driver.baseMs + s.driver.jitterMs) * this.paceScale;
    const drift = (Math.random() - 0.5) * 0.4;
    const recovery = Math.random() < 0.06 ? 0.9 : 1;
    const next = s.paceMs * (1 + drift * 0.01) * recovery;
    const min = base * 0.96;
    const max = base * 1.08;
    return Math.min(max, Math.max(min, next));
  }

  private globalLap(): number {
    const maxLaps = Math.max(1, ...this.drivers.map((s) => s.lapsDone + (s.state === "racing" ? 1 : 0)));
    return Math.min(this.plannedLaps, maxLaps);
  }

  private computeStandings(): LiveDriver[] {
    const rows = this.drivers.map((s) => {
      const progress = s.state === "racing" ? Math.min(1, s.partialMs / s.paceMs) : 0;
      const totalMs =
        s.completedMs +
        s.pitTotalMs +
        (s.state === "racing" ? s.partialMs : Math.max(0, this.raceTime - s.pitEnteredAt));
      return {
        driverId: s.driver.id,
        totalMs,
        lapsDone: s.lapsDone,
        lastLapMs: s.lastLapMs,
        bestLapMs: s.bestLapMs,
        deltaMs: s.lastLapMs !== null && s.prevLapMs !== null ? s.lastLapMs - s.prevLapMs : null,
        state: s.state,
        pitMs: s.state === "pit" ? Math.max(0, s.pitEnteredAt + PARKLOT_MS - this.raceTime) : 0,
        paceMs: Math.round(s.paceMs),
        progress,
      };
    });

    rows.sort((a, b) => {
      if (a.lapsDone !== b.lapsDone) return b.lapsDone - a.lapsDone;
      return a.totalMs - b.totalMs;
    });

    const leader = rows[0];
    const leaderTotal = leader?.totalMs ?? 0;
    const leaderLaps = leader?.lapsDone ?? 0;
    const leaderLapMs = leaderLaps > 0 && leader
      ? leader.totalMs / leaderLaps
      : leader?.paceMs ?? 0;

    return rows.map((row, index) => ({
      driverId: row.driverId,
      position: index + 1,
      lapsDone: row.lapsDone,
      totalMs: row.totalMs,
      gapMs:
        index === 0
          ? 0
          : Math.max(0, (leaderLaps - row.lapsDone) * leaderLapMs + (row.totalMs - leaderTotal)),
      lastLapMs: row.lastLapMs,
      bestLapMs: row.bestLapMs,
      deltaMs: row.deltaMs,
      state: row.state,
      pitMs: row.pitMs,
      paceMs: row.paceMs,
      progress: row.progress,
    }));
  }

  private finishRace(): void {
    this.phase = "finished";
    this.stopTimer();
    this.store.addEvent("flag", "Checkered flag — race complete", this.raceTime);
  }

  private formatMs(ms: number): string {
    return `${(ms / 1000).toFixed(1)}s`;
  }

  private resetRunners(): void {
    this.drivers = this.store.listDrivers().map((driver) => ({
      driver,
      state: "racing",
      paceMs: Math.round((driver.baseMs + driver.jitterMs) * this.paceScale),
      lapsDone: 0,
      partialMs: 0,
      completedMs: 0,
      bestLapMs: null,
      lastLapMs: null,
      prevLapMs: null,
      pitTotalMs: 0,
      pitEnteredAt: 0,
      hasPitted: false,
      justExitedPit: false,
    }));
  }

  close(): void {
    this.stopTimer();
    this.phase = "idle";
  }

  debugForcePit(driverId: number): void {
    const s = this.drivers.find((d) => d.driver.id === driverId);
    if (!s || s.state !== "racing" || s.hasPitted) return;
    s.hasPitted = true;
    s.state = "pit";
    s.partialMs = 0;
    s.pitEnteredAt = this.raceTime;
  }

  debugLapsInStore(): Lap[] {
    return this.store.listLaps();
  }

  debugEventsInStore(): RaceEvent[] {
    return this.store.listEvents();
  }
}