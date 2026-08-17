export type DriverState = "racing" | "pit";

export type RacePhase = "idle" | "running" | "paused" | "finished";

export type EventKind = "overtake" | "fastest" | "pit" | "flag" | "system";

export interface Driver {
  id: number;
  number: number;
  name: string;
  team: string;
  color: string;
  baseMs: number;
  jitterMs: number;
}

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

export interface RaceEvent {
  id: number;
  at: number;
  kind: EventKind;
  text: string;
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