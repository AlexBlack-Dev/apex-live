import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Driver, EventKind, LiveDriver, RaceEvent, RacePhase, RaceSnapshot } from "./types";
import {
  IconAlert,
  IconChevronDown,
  IconChevronUp,
  IconPause,
  IconPlay,
  IconRotate,
  IconSwap,
  IconWrench,
} from "./icons";

const REPO_URL = "https://github.com/AlexBlack-Dev/redline";
const BG_VIDEOS = ["/race-bg-1.mp4", "/race-bg-2.mp4", "/race-bg-3.mp4", "/race-bg-4.mp4"];

function formatRaceTime(ms: number): string {
  const total = Math.max(0, ms) / 1000;
  const m = Math.floor(total / 60);
  const s = Math.floor(total % 60);
  const t = Math.floor((total % 1) * 10);
  return `${m}:${String(s).padStart(2, "0")}.${t}`;
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

function formatDelta(ms: number | null): string {
  if (ms === null) return "—";
  return ms <= 0 ? `${(ms / 1000).toFixed(1)}s` : `+${(ms / 1000).toFixed(1)}s`;
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

const PHASE_INFO: Record<RacePhase, { label: string; cls: string }> = {
  idle: { label: "GRID", cls: "ph-idle" },
  running: { label: "RACE LIVE", cls: "ph-live" },
  paused: { label: "PAUSED", cls: "ph-paused" },
  finished: { label: "FINISHED", cls: "ph-finished" },
};

type FlashKind = "up" | "down" | "lap" | "best" | null;

function ControlButton(props: {
  label: string;
  onClick: () => void;
  tone?: "lime" | "paper" | "red";
  icon?: React.ReactNode;
}): React.ReactElement {
  const { label, onClick, tone = "paper", icon } = props;
  return (
    <button type="button" className={`ctl ctl-${tone}`} onClick={onClick}>
      {icon && <span className="ctl-ico">{icon}</span>}
      {label}
    </button>
  );
}

function LapMeter(props: {
  done: number;
  progress: number;
  planned: number;
  inPit: boolean;
}): React.ReactElement {
  const { done, progress, planned, inPit } = props;
  return (
    <span className="laps" aria-label={`${done} of ${planned} laps`}>
      {Array.from({ length: planned }, (_, i) => {
        const idx = i + 1;
        const cls =
          idx <= done ? "lseg seg-done" : idx === done + 1 && !inPit ? "lseg seg-cur" : "lseg";
        return (
          <span
            key={idx}
            className={cls}
            style={
              idx === done + 1 && !inPit
                ? { transform: `scaleY(${(0.3 + progress * 0.7).toFixed(2)})` }
                : undefined
            }
          />
        );
      })}
    </span>
  );
}

function LeaderRow(props: {
  row: LiveDriver;
  driver: Driver;
  plannedLaps: number;
  isLeader: boolean;
  flash: FlashKind;
  index: number;
  entering: boolean;
}): React.ReactElement {
  const { row, driver, plannedLaps, isLeader, flash, index, entering } = props;
  const cls = [
    "row",
    isLeader ? "row-leader" : "",
    flash ? `flash-${flash}` : "",
    entering ? "row-enter" : "",
    row.state === "pit" ? "row-pitting" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const teamColor = driver.color || "var(--faint)";
  return (
    <div
      className={cls}
      style={{ animationDelay: `${index * 34}ms`, "--team": teamColor } as React.CSSProperties}
    >
      <span className="row-pos">
        {flash === "up" && <IconChevronUp className="row-move row-move-up" size={14} />}
        {flash === "down" && <IconChevronDown className="row-move row-move-down" size={14} />}
        {String(row.position).padStart(2, "0")}
      </span>
      <span className="row-num">
        <i style={{ background: teamColor }}>{driver.number}</i>
      </span>
      <span className="row-name">
        <b>{driver.name}</b>
        <i>{driver.team}</i>
      </span>
      <LapMeter done={row.lapsDone} progress={row.progress} planned={plannedLaps} inPit={row.state === "pit"} />
      <span className="row-last">
        {row.state === "pit" ? (
          <em className="pit-badge">
            <IconWrench size={12} />
            PIT · {formatRaceTime(row.pitMs)}
          </em>
        ) : (
          formatLap(row.lastLapMs)
        )}
      </span>
      <span className="row-best">{formatLap(row.bestLapMs)}</span>
      <span className="row-delta">{formatDelta(row.deltaMs)}</span>
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
  const H = 150;
  const PAD = 14;
  const maxDrivers = Math.max(6, drivers.length);
  const x = useCallback(
    (lap: number): number => PAD + (lap / (plannedLaps + 0.4)) * (W - PAD * 2),
    [plannedLaps]
  );
  const y = useCallback(
    (pos: number): number => PAD + ((pos - 1) / maxDrivers) * (H - PAD * 2),
    [maxDrivers]
  );

  const pathsRef = useRef(new Map<number, SVGPathElement>());
  const prevPtsRef = useRef<Map<number, { lap: number; pos: number }[]>>(new Map());
  const elapsedRef = useRef(0);

  useEffect(() => {
    prevPtsRef.current = points;
  }, [points]);

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const tick = (now: number): void => {
      raf = requestAnimationFrame(tick);
      elapsedRef.current += now - last;
      last = now;
      const p = Math.min(1, elapsedRef.current / 700);
      for (const [id, pts] of prevPtsRef.current) {
        if (pts.length < 2) continue;
        const p0 = pts[pts.length - 2]!;
        const p1 = pts[pts.length - 1]!;
        const cx = x(p0.lap + (p1.lap - p0.lap) * p);
        const cy = y(p0.pos + (p1.pos - p0.pos) * p);
        const pathEl = pathsRef.current.get(id);
        if (pathEl) {
          let d = "";
          for (let i = 0; i < pts.length - 2; i++) {
            d += `${i === 0 ? "M" : "L"}${x(pts[i].lap).toFixed(1)},${y(pts[i].pos).toFixed(1)} `;
          }
          if (pts.length === 2) {
            d += `M${x(p0.lap).toFixed(1)},${y(p0.pos).toFixed(1)} `;
          }
          d += `L${cx.toFixed(1)},${cy.toFixed(1)}`;
          pathEl.setAttribute("d", d);
        }
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [x, y]);

  const setPathRef = (id: number) => (el: SVGPathElement | null): void => {
    if (el) pathsRef.current.set(id, el);
    else pathsRef.current.delete(id);
  };

  const gridLines = [];
  for (let i = 1; i <= plannedLaps; i += 2) {
    gridLines.push(<line key={`gx${i}`} x1={x(i)} y1={0} x2={x(i)} y2={H} className="graph-grid" />);
  }
  for (let i = 1; i <= maxDrivers; i++) {
    gridLines.push(
      <g key={`gy${i}`}>
        <line x1={0} y1={y(i)} x2={W} y2={y(i)} className="graph-grid" />
        <text x={PAD - 4} y={y(i) + 3} className="graph-pos">
          P{i}
        </text>
      </g>
    );
  }

  return (
    <svg className="race-graph" viewBox={`0 0 ${W} ${H}`} aria-label="race position history">
      {gridLines}
      {drivers.map((driver) => {
        const pts = points.get(driver.id) ?? [];
        if (pts.length < 2) return null;
        const path = pts
          .map((pt, i) => `${i === 0 ? "M" : "L"}${x(pt.lap).toFixed(1)},${y(pt.pos).toFixed(1)}`)
          .join(" ");
        const isLeader = driver.id === leaderId;
        return (
          <path
            key={driver.id}
            ref={setPathRef(driver.id)}
            d={path}
            className={`graph-line${isLeader ? " graph-lead" : ""}`}
          />
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
            <IconAlert className="ticker-ico" size={14} />
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
  const [conn, setConn] = useState<"connecting" | "online" | "offline">("connecting");
  const [clock, setClock] = useState(() => new Date());
  const [bgIndex, setBgIndex] = useState(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const historyRef = useRef<Map<number, { lap: number; pos: number }[]>>(new Map());
  const prevSnapRef = useRef<RaceSnapshot | null>(null);
  const [flashes, setFlashes] = useState<Record<number, FlashKind>>({});
  const [entering, setEntering] = useState<Record<number, boolean>>({});

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let fadeTimer: number | undefined;
    const onLoaded = (): void => {
      video.style.opacity = "1";
      const p = video.play();
      if (p !== undefined) p.catch(() => undefined);
    };
    const onEnded = (): void => {
      video.style.opacity = "0";
      fadeTimer = window.setTimeout(() => {
        setBgIndex((index) => (index + 1) % BG_VIDEOS.length);
      }, 900);
    };
    video.style.opacity = "0";
    video.addEventListener("loadeddata", onLoaded);
    video.addEventListener("ended", onEnded);
    return () => {
      video.removeEventListener("loadeddata", onLoaded);
      video.removeEventListener("ended", onEnded);
      if (fadeTimer !== undefined) window.clearTimeout(fadeTimer);
    };
  }, [bgIndex]);

  useEffect(() => {
    const timer = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const applySnapshot = useCallback((next: RaceSnapshot) => {
    const prev = prevSnapRef.current;
    if (prev) {
      const nextFlashes: Record<number, FlashKind> = {};
      const prevById = new Map(prev.standings.map((s) => [s.driverId, s]));
      for (const s of next.standings) {
        const before = prevById.get(s.driverId);
        if (!before) continue;
        if (s.position < before.position) nextFlashes[s.driverId] = "up";
        else if (s.position > before.position) nextFlashes[s.driverId] = "down";
        else if (
          s.bestLapMs !== null &&
          (before.bestLapMs === null || s.bestLapMs < before.bestLapMs)
        ) {
          nextFlashes[s.driverId] = "best";
        } else if (s.lastLapMs !== null && s.lastLapMs !== before.lastLapMs) {
          nextFlashes[s.driverId] = "lap";
        }
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
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const connect = (): void => {
      setConn("connecting");
      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(`${protocol}://${window.location.host}/ws`);
      socket.addEventListener("open", () => {
        attempt = 0;
        setConn("online");
        fetch("/api/session")
          .then((response) => response.json())
          .then((body: { race: RaceSnapshot }) => {
            if (!disposed) applySnapshot(body.race);
          })
          .catch(() => undefined);
      });
      socket.addEventListener("message", (event) => {
        try {
          const message = JSON.parse(event.data as string) as {
            type: string;
            snapshot?: RaceSnapshot;
          };
          if (message.type === "race" && message.snapshot) applySnapshot(message.snapshot);
        } catch {
          setConn("offline");
        }
      });
      const reconnect = (): void => {
        if (disposed) return;
        setConn("offline");
        const delay = Math.min(2000 * 2 ** attempt, 15000);
        attempt += 1;
        retryTimer = setTimeout(connect, delay);
      };
      socket.addEventListener("close", reconnect);
      socket.addEventListener("error", reconnect);
    };

    connect();
    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      socket?.close();
    };
  }, [applySnapshot]);

  const control = useCallback(
    (action: "start" | "pause" | "resume" | "reset") => {
      void fetch("/api/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      })
        .then((response) => response.json())
        .then((body: { race: RaceSnapshot }) => applySnapshot(body.race))
        .catch(() => setConn("offline"));
    },
    [applySnapshot]
  );

  const standings = snapshot?.standings ?? [];
  const drivers = snapshot?.drivers ?? [];
  const driverById = useMemo(() => new Map(drivers.map((d) => [d.id, d])), [drivers]);
  const session = snapshot?.session ?? null;
  const leader = standings[0] ?? null;
  const phase = session?.phase ?? "idle";
  const phaseInfo = PHASE_INFO[phase];

  const hasTrack = useMemo(() => {
    if (!snapshot) return false;
    return drivers.some((d) => (historyRef.current.get(d.id)?.length ?? 0) >= 2);
  }, [snapshot, drivers]);

  const leaderProgress = useMemo(() => {
    if (!leader) return 0;
    return leader.state === "pit" ? 0 : leader.progress;
  }, [leader]);

  const phaseControls =
    phase === "running" ? (
      <ControlButton label="PAUSE" icon={<IconPause size={14} />} onClick={() => control("pause")} />
    ) : phase === "paused" ? (
      <ControlButton label="RESUME" tone="lime" icon={<IconPlay size={14} />} onClick={() => control("resume")} />
    ) : (
      <ControlButton
        label={phase === "finished" ? "RESTART" : "LIGHTS OUT"}
        tone="lime"
        icon={<IconPlay size={14} />}
        onClick={() => control("start")}
      />
    );

  return (
    <div className="app">
      {phase !== "idle" && (
        <div className="bg">
          <video
            key={bgIndex}
            className="bg-video"
            ref={videoRef}
            muted
            playsInline
            preload="auto"
            aria-hidden="true"
            src={BG_VIDEOS[bgIndex]}
          />
        </div>
      )}
      {conn === "offline" && (
        <div className="offline">
          <span className="offline-dot" />
          link lost — reconnecting…
        </div>
      )}

      <header className="top">
        <div className="brand">
          <span className="brand-name">
            RED<span>LINE</span>
          </span>
          <span className="brand-tag">
            race monitor · <a href={REPO_URL} target="_blank" rel="noreferrer">github</a>
          </span>
        </div>
        <div className="top-status">
          <span className={`phase ${phaseInfo.cls}`}>{phaseInfo.label}</span>
          <span
            className={`dot${phase === "running" ? " dot-live" : ""}${
              conn === "online" ? "" : conn === "connecting" ? " dot-conn" : " dot-off"
            }`}
          />
        </div>
        <div className="top-clock">
          <span className="clock-time">{formatClock(clock)}</span>
          <span className="clock-race">race time {session ? formatRaceTime(session.simMs) : "—"}</span>
        </div>
      </header>

      <main className="timing">
        <div className="timing-head">
          <div className="lap-title">
            <span className="lap-label">LAP</span>
            <span className="lap-value">
              {session ? String(Math.min(session.currentLap + 1, session.plannedLaps)) : "—"}
            </span>
            <span className="lap-total">/ {session?.plannedLaps ?? "—"}</span>
          </div>
          {phaseControls}
          <ControlButton label="RESET" tone="red" icon={<IconRotate size={14} />} onClick={() => control("reset")} />
        </div>

        <div className="board">
          <div className="board-head">
            <span className="col-pos">POS</span>
            <span className="col-num">Nº</span>
            <span className="col-name">DRIVER</span>
            <span className="col-laps">LAPS</span>
            <span className="col-last">LAST</span>
            <span className="col-best">BEST</span>
            <span className="col-delta">
              <IconSwap size={12} />
            </span>
            <span className="col-gap">GAP</span>
          </div>
          <div className="board-rows">
            {standings.map((row, index) => {
              const driver = driverById.get(row.driverId);
              if (!driver) return null;
              return (
                <LeaderRow
                  key={driver.id}
                  row={row}
                  driver={driver}
                  plannedLaps={session?.plannedLaps ?? 0}
                  isLeader={row.position === 1}
                  flash={flashes[driver.id] ?? null}
                  index={index}
                  entering={entering[driver.id] ?? false}
                />
              );
            })}
          </div>
        </div>

        <div className="graph-panel">
          <div className="panel-head">
            <span className="panel-title">POSITION HISTORY</span>
            {leader && (
              <span className="panel-sub">
                leader {driverById.get(leader.driverId)?.name ?? ""} · laps done {session?.leaderLaps ?? 0}
              </span>
            )}
          </div>
          <div className="race-graph-wrap">
            <RaceGraph
              points={snapshot ? new Map(historyRef.current) : new Map()}
              drivers={drivers}
              leaderId={session?.leaderId ?? null}
              plannedLaps={session?.plannedLaps ?? 12}
            />
            {!hasTrack && (
              <div className="graph-empty">
                no position data yet
                <em>lights out starts the trace</em>
              </div>
            )}
          </div>
          <div className="laps-axis">
            {Array.from({ length: (session?.plannedLaps ?? 12) + 1 }, (_, i) => (
              <span key={i} className="axis-tick">
                {i}
              </span>
            ))}
          </div>
        </div>

        <div className="metrics">
          <MetricTile label="AIR" value={session ? String(session.airTempC) : "—"} right="°C" />
          <MetricTile label="TRACK" value={session ? String(session.trackTempC) : "—"} right="°C" />
          <MetricTile label="HUMIDITY" value={session ? String(session.humidityPct) : "—"} right="%" />
          <MetricTile
            label="LEADER PACE"
            value={leader?.paceMs ? `${(leader.paceMs / 1000).toFixed(2)}s` : "—"}
            right={leader?.state === "pit" ? "PIT" : undefined}
          />
          <MetricTile label="LAP" value={session ? String(session.currentLap + 1) : "—"} right={`of ${session?.plannedLaps ?? "—"}`} />
          <MetricTile label="GRID" value={String(drivers.length)} right="DRIVERS" />
        </div>

        <Ticker events={snapshot?.events ?? []} />

        <footer className="foot">
          <span>
            redline · every lap is a signal — pit stops, gaps and positions stream live over a single
            websocket.{" "}
            <a href={REPO_URL} target="_blank" rel="noreferrer">
              source on github
            </a>
            .
          </span>
        </footer>
      </main>
    </div>
  );
}