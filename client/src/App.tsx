import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Driver, EventKind, LiveDriver, RaceEvent, RaceSnapshot } from "./types";

const REPO_URL = "https://github.com/AlexBlack-Dev/apex-live";

interface WsState {
  kind: "connecting" | "online" | "offline";
}

function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatClock(date: Date): string {
  return date.toLocaleTimeString("en-GB", { hour12: false });
}

function formatLap(ms: number | null): string {
  if (ms === null) return "—";
  const s = (ms / 1000).toFixed(2);
  return `${s.padStart(6, "0")}s`;
}

function formatGap(ms: number): string {
  return `+${(ms / 1000).toFixed(1)}s`;
}

const EVENT_LABEL: Record<EventKind, string> = {
  overtake: "OVERTAKE",
  fastest: "FASTEST",
  pit: "PIT STOP",
  flag: "FLAG",
  system: "SYSTEM",
};

const EVENT_CLASS: Record<EventKind, string> = {
  overtake: "ev-overtake",
  fastest: "ev-fastest",
  pit: "ev-pit",
  flag: "ev-flag",
  system: "ev-system",
};

function ControlButton(props: {
  label: string;
  active: boolean;
  onClick: () => void;
  tone?: "lime" | "paper" | "red";
}): React.ReactElement {
  const { label, active, onClick, tone = "paper" } = props;
  return (
    <button
      type="button"
      className={`ctl ctl-${tone}${active ? " ctl-active" : ""}`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function LeaderRow(props: {
  row: LiveDriver;
  driver: Driver;
  isLeader: boolean;
  flash: "up" | "down" | "lap" | null;
  index: number;
  entering: boolean;
}): React.ReactElement {
  const { row, driver, isLeader, flash, index, entering } = props;
  const delta =
    row.deltaMs !== null ? (row.deltaMs <= 0 ? `${(row.deltaMs / 1000).toFixed(1)}s` : `+${(row.deltaMs / 1000).toFixed(1)}s`) : null;
  return (
    <div
      className={`row${isLeader ? " row-leader" : ""}${flash ? ` flash-${flash}` : ""}${entering ? " row-enter" : ""}`}
      style={{ animationDelay: `${index * 34}ms` }}
    >
      <span className="row-pos">{String(row.position).padStart(2, "0")}</span>
      <span className="row-num">{String(driver.number).padStart(2, "0")}</span>
      <span className="row-name">
        <b>{driver.name}</b>
        <i>{driver.team}</i>
      </span>
      {row.state === "pit" ? (
        <span className="row-pit" title="in the pits">
          PIT · {formatTime(row.pitMs)}
        </span>
      ) : (
        <span className="row-lap">{formatLap(row.lastLapMs)}</span>
      )}
      <span className={`row-delta${delta !== null && row.deltaMs !== null && row.deltaMs > 0 ? " delta-pos" : delta !== null && row.deltaMs !== null && row.deltaMs < 0 ? " delta-neg" : ""}`}>
        {delta ?? "—"}
      </span>
      <span className="row-best">{formatLap(row.bestLapMs)}</span>
      <span className="row-gap">{isLeader ? "LEAD" : formatGap(row.gapMs)}</span>
    </div>
  );
}

function MetricTile(props: { label: string; value: string; right?: string }): React.ReactElement {
  return (
    <div className="tile">
      <span className="tile-label">{props.label}</span>
      <span className="tile-value">
        {props.value}
        {props.right && <em>{props.right}</em>}
      </span>
    </div>
  );
}

function RaceGraph(props: {
  points: Map<number, { lap: number; pos: number }[]>;
  drivers: Driver[];
  leaderId: number | null;
  plannedLaps: number;
}): React.ReactElement {
  const { points, drivers, leaderId, plannedLaps } = props;
  const W = 720;
  const H = 200;
  const PAD = 12;
  const maxDrivers = Math.max(6, drivers.length);
  const x = (lap: number): number => PAD + (lap / (plannedLaps + 0.4)) * (W - PAD * 2);
  const y = (pos: number): number => PAD + ((pos - 1) / maxDrivers) * (H - PAD * 2);

  const gridLines = [];
  for (let i = 1; i <= plannedLaps; i += 2) {
    gridLines.push(
      <line key={`gx${i}`} x1={x(i)} y1={0} x2={x(i)} y2={H} className="graph-grid" />
    );
  }
  for (let i = 1; i < maxDrivers; i++) {
    gridLines.push(
      <line key={`gy${i}`} x1={0} y1={y(i)} x2={W} y2={y(i)} className="graph-grid" />
    );
  }

  return (
    <svg className="race-graph" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-label="race position history">
      {gridLines}
      {drivers.map((driver) => {
        const pts = points.get(driver.id) ?? [];
        if (pts.length < 2) return null;
        const path = pts
          .map((p, i) => `${i === 0 ? "M" : "L"}${x(p.lap).toFixed(1)},${y(p.pos).toFixed(1)}`)
          .join(" ");
        const last = pts[pts.length - 1]!;
        const isLeader = driver.id === leaderId;
        return (
          <g key={driver.id}>
            <path d={path} className={`graph-line${isLeader ? " graph-lead" : ""}`} />
            <circle cx={x(last.lap)} cy={y(last.pos)} r={isLeader ? 4 : 2.5} className={isLeader ? "graph-dot-lead" : "graph-dot"} />
          </g>
        );
      })}
    </svg>
  );
}

function Ticker(props: { events: RaceEvent[] }): React.ReactElement {
  const { events } = props;
  const items = events.slice(-24);
  if (items.length === 0) {
    return <div className="ticker ticker-idle">waiting for the race to start — lights out at any moment</div>;
  }
  const strip = [...items, ...items];
  return (
    <div className="ticker">
      <div className="ticker-track">
        {strip.map((event, index) => (
          <span key={`${event.id}-${index}`} className={`ticker-item ${EVENT_CLASS[event.kind]}`}>
            <em>{EVENT_LABEL[event.kind]}</em>
            {event.text}
          </span>
        ))}
      </div>
    </div>
  );
}

export default function App(): React.ReactElement {
  const [snapshot, setSnapshot] = useState<RaceSnapshot | null>(null);
  const [conn, setConn] = useState<WsState>({ kind: "connecting" });
  const [clock, setClock] = useState(() => new Date());
  const historyRef = useRef<Map<number, { lap: number; pos: number }[]>>(new Map());
  const prevSnapRef = useRef<RaceSnapshot | null>(null);
  const [flashes, setFlashes] = useState<Record<number, "up" | "down" | "lap" | null>>({});
  const [entering, setEntering] = useState<Record<number, boolean>>({});

  useEffect(() => {
    const timer = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const applySnapshot = useCallback((next: RaceSnapshot) => {
    const prev = prevSnapRef.current;
    if (prev) {
      const nextFlashes: Record<number, "up" | "down" | "lap" | null> = {};
      const prevById = new Map(prev.standings.map((s) => [s.driverId, s]));
      for (const s of next.standings) {
        const before = prevById.get(s.driverId);
        if (!before) continue;
        if (s.position < before.position) nextFlashes[s.driverId] = "up";
        else if (s.position > before.position) nextFlashes[s.driverId] = "down";
        else if (s.lastLapMs !== before.lastLapMs && s.lastLapMs !== null) nextFlashes[s.driverId] = "lap";
      }
      setFlashes(nextFlashes);
      setTimeout(() => setFlashes({}), 900);
    } else {
      setEntering(Object.fromEntries(next.standings.map((s) => [s.driverId, true])));
      setTimeout(() => setEntering({}), 1400);
    }

    const hist = historyRef.current;
    for (const s of next.standings) {
      const pts = hist.get(s.driverId) ?? [];
      const last = pts[pts.length - 1];
      const lapKey = s.lapsDone + (s.state === "pit" ? 0 : s.progress);
      if (!last || Math.abs(last.lap - lapKey) > 0.04 || last.pos !== s.position) {
        pts.push({ lap: lapKey, pos: s.position });
        if (pts.length > 220) pts.shift();
        hist.set(s.driverId, pts);
      }
    }
    prevSnapRef.current = next;
    setSnapshot(next);
  }, []);

  useEffect(() => {
    let disposed = false;
    fetch("/api/session")
      .then((response) => response.json())
      .then((body: { race: RaceSnapshot }) => {
        if (!disposed) applySnapshot(body.race);
      })
      .catch(() => setConn({ kind: "offline" }));

    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${protocol}://${window.location.host}/ws`);
    socket.addEventListener("open", () => setConn({ kind: "online" }));
    socket.addEventListener("close", () => setConn({ kind: "offline" }));
    socket.addEventListener("error", () => setConn({ kind: "offline" }));
    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(event.data as string) as { type: string; snapshot?: RaceSnapshot };
        if (message.type === "race" && message.snapshot) applySnapshot(message.snapshot);
      } catch {
        setConn({ kind: "offline" });
      }
    });
    return () => {
      disposed = true;
      socket.close();
    };
  }, [applySnapshot]);

  const control = useCallback((action: "start" | "pause" | "reset") => {
    void fetch("/api/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    })
      .then((response) => response.json())
      .then((body: { race: RaceSnapshot }) => applySnapshot(body.race))
      .catch(() => undefined);
  }, [applySnapshot]);

  const standings = snapshot?.standings ?? [];
  const drivers = snapshot?.drivers ?? [];
  const driverById = useMemo(() => new Map(drivers.map((d) => [d.id, d])), [drivers]);
  const session = snapshot?.session ?? null;
  const leader = standings[0] ?? null;

  const progress = useMemo(() => {
    if (!session) return 0;
    const total = session.plannedLaps;
    const done = Math.max(0, leader?.lapsDone ?? 0);
    const partial = leader?.state === "racing" ? leader.progress : 0;
    return Math.min(1, (done + partial) / total);
  }, [session, leader]);

  const stateLabel = session?.running ? "RACE LIVE" : session ? "GRID HOLD" : "OFFLINE";
  const stateClass = session?.running ? "badge-live" : "badge-idle";

  return (
    <div className="app">
      <div className="grain" aria-hidden="true" />
      <div className="wordmark-bg" aria-hidden="true">
        APEX
      </div>

      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">APEX</span>
          <span className="brand-sub">
            <i>live racing terminal</i>
          </span>
        </div>
        <div className="session-meta">
          <span className="session-name">
            The Grand Prix of <i>Lugano</i>
          </span>
          <span className="session-night">NIGHT SESSION · ROUND 07</span>
        </div>
        <div className="topbar-right">
          <span className={`live-badge ${stateClass}`}>
            <span className="live-dot" />
            {stateLabel}
          </span>
          <span className="clock">{formatClock(clock)}</span>
          <a className="repo-link" href={REPO_URL} target="_blank" rel="noreferrer">
            SOURCE ↗
          </a>
        </div>
      </header>

      <main className="stage">
        <section className="timing">
          <div className="timing-head">
            <div>
              <span className="kicker">session 01 — race classification</span>
              <h1 className="lap-title">
                LAP&nbsp;{String(session?.currentLap ?? 0).padStart(2, "0")}
                <em>/</em>
                {String(session?.plannedLaps ?? 10).padStart(2, "0")}
              </h1>
            </div>
            <div className="controls">
              <ControlButton
                label={session?.running ? "PAUSE" : "LIGHTS OUT"}
                tone="lime"
                active={!!session?.running}
                onClick={() => control(session?.running ? "pause" : "start")}
              />
              <ControlButton label="RESET" tone="paper" active={false} onClick={() => control("reset")} />
            </div>
          </div>

          <div className="progress" aria-label="race progress">
            {Array.from({ length: session?.plannedLaps ?? 10 }, (_, index) => (
              <span
                key={index}
                className={`progress-cell${index < (leader?.lapsDone ?? 0) ? " done" : index === (session?.currentLap ?? 0) - 1 && session?.running ? " now" : ""}`}
                style={{ width: `${100 / (session?.plannedLaps ?? 10)}%` }}
              />
            ))}
          </div>

          <div className="leaderboard">
            <div className="lb-head">
              <span>POS</span>
              <span>Nº</span>
              <span>DRIVER / TEAM</span>
              <span>LAST</span>
              <span>Δ</span>
              <span>BEST</span>
              <span>GAP</span>
            </div>
            {standings.length === 0 && (
              <div className="lb-empty">loading timing…</div>
            )}
            {standings.map((row, index) => {
              const driver = driverById.get(row.driverId);
              if (!driver) return null;
              return (
                <LeaderRow
                  key={row.driverId}
                  row={row}
                  driver={driver}
                  index={index}
                  isLeader={row.position === 1}
                  flash={flashes[row.driverId] ?? null}
                  entering={!!entering[row.driverId]}
                />
              );
            })}
          </div>

          <footer className="timing-foot">
            <span>
              {snapshot?.lapCount ?? 0} completed laps recorded · latest&nbsp;
              {leader ? `laps: ${leader.lapsDone}` : "—"} · leader P1
            </span>
            <span>broadcast tick 0.5 s</span>
          </footer>
        </section>

        <aside className="board">
          <div className="board-block">
            <span className="kicker">position over laps</span>
            <div className="graph-wrap">
              <RaceGraph
                points={historyRef.current}
                drivers={drivers}
                leaderId={session?.leaderId ?? null}
                plannedLaps={session?.plannedLaps ?? 10}
              />
            </div>
          </div>

          <div className="board-block">
            <span className="kicker">track conditions</span>
            <div className="tiles">
              <MetricTile label="AIR" value={(session?.airTempC ?? 0).toFixed(1)} right="°C" />
              <MetricTile label="TRACK" value={(session?.trackTempC ?? 0).toFixed(1)} right="°C" />
              <MetricTile label="HUMIDITY" value={String(Math.round(session?.humidityPct ?? 0))} right="%" />
              <MetricTile label="LEADER PACE" value={leader ? `${(leader.paceMs / 1000).toFixed(1)}` : "—"} right="s" />
            </div>
          </div>

          <div className="board-block">
            <span className="kicker">driver notes</span>
            <div className="notes">
              {drivers.slice(0, 6).map((driver) => {
                const row = standings.find((s) => s.driverId === driver.id);
                const extra = row?.state === "pit" ? "— pit window" : row ? `P${row.position}` : "—";
                return (
                  <div key={driver.id} className="note">
                    <span className="note-num">{String(driver.number).padStart(2, "0")}</span>
                    <span className="note-name">{driver.name}</span>
                    <span className="note-extra">{extra}</span>
                  </div>
                );
              })}
            </div>
          </div>

          <aside className="connection">
            link: <em className={conn.kind === "online" ? "ok" : conn.kind === "offline" ? "bad" : ""}>{conn.kind}</em>{" "}
            · websocket broadcast
          </aside>
        </aside>
      </main>

      <Ticker events={snapshot?.events ?? []} />

      <footer className="app-foot">
        <span>APEX · live racing terminal — react 19 · node.js · websocket · sqlite</span>
        <span className="foot-right">tyre window P2–P6 · 10 laps · broadcast every 500 ms</span>
      </footer>
    </div>
  );
}