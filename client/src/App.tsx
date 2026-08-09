import { useCallback, useEffect, useRef, useState } from "react";

export type Column = "todo" | "doing" | "done";

export const COLUMNS: Column[] = ["todo", "doing", "done"];

export const COLUMN_LABELS: Record<Column, string> = {
  todo: "To do",
  doing: "In progress",
  done: "Done",
};

export const COLUMN_WORK: Record<Column, Column> = {
  todo: "doing",
  doing: "done",
  done: "todo",
};

export const COLUMN_BACK: Record<Column, Column> = {
  todo: "done",
  doing: "todo",
  done: "doing",
};

export interface Board {
  id: number;
  name: string;
  createdAt: number;
}

export interface Task {
  id: number;
  boardId: number;
  title: string;
  column: Column;
  position: number;
  createdAt: number;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }
  return body;
}

type WsState = "connecting" | "online" | "offline";

export default function App(): React.ReactElement {
  const [boards, setBoards] = useState<Board[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [title, setTitle] = useState("");
  const [wsState, setWsState] = useState<WsState>("connecting");
  const [error, setError] = useState<string | null>(null);

  const activeIdRef = useRef<number | null>(null);
  activeIdRef.current = activeId;

  const refreshTasks = useCallback(async (boardId: number) => {
    const data = await requestJson<{ board: Board; tasks: Task[] }>(
      `/api/boards/${boardId}`
    );
    setTasks(data.tasks);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        let data = await requestJson<{ boards: Board[] }>("/api/boards");
        if (data.boards.length === 0) {
          await requestJson<{ board: Board }>("/api/boards", {
            method: "POST",
            body: JSON.stringify({ name: "Team Sprint" }),
          });
          data = await requestJson<{ boards: Board[] }>("/api/boards");
        }
        setBoards(data.boards);
        setActiveId(data.boards[0]?.id ?? null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "failed to load boards");
      }
    })();
  }, []);

  useEffect(() => {
    if (activeId === null) return;
    void refreshTasks(activeId).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "failed to load tasks");
    });
  }, [activeId, refreshTasks]);

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${protocol}://${window.location.host}/ws`);

    socket.addEventListener("open", () => setWsState("online"));
    socket.addEventListener("close", () => setWsState("offline"));
    socket.addEventListener("error", () => setWsState("offline"));
    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(event.data as string) as {
          type: string;
          boardId?: number;
        };
        if (message.type === "board-updated" && message.boardId === activeIdRef.current) {
          void refreshTasks(message.boardId).catch(() => undefined);
        }
      } catch {
        setWsState("offline");
      }
    });

    return () => {
      socket.close();
    };
  }, [refreshTasks]);

  const addTask = useCallback(
    (column: Column = "todo") => {
      const trimmed = title.trim();
      if (!trimmed || activeId === null) return;
      setTitle("");
      void requestJson<{ task: Task }>(`/api/boards/${activeId}/tasks`, {
        method: "POST",
        body: JSON.stringify({ title: trimmed, column }),
      }).catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "failed to add task");
      });
    },
    [title, activeId]
  );

  const moveTask = useCallback((taskId: number, column: Column) => {
    void requestJson<{ task: Task }>(`/api/tasks/${taskId}/move`, {
      method: "POST",
      body: JSON.stringify({ column }),
    }).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "failed to move task");
    });
  }, []);

  const removeTask = useCallback((taskId: number) => {
    void requestJson<{ ok: boolean }>(`/api/tasks/${taskId}`, {
      method: "DELETE",
    }).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "failed to delete task");
    });
  }, []);

  const groups = COLUMNS.map((column) => ({
    column,
    items: tasks.filter((task) => task.column === column),
  }));

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-dot" />
          <span className="brand-name">taskboard</span>
          <span className="brand-tag">real-time kanban</span>
        </div>
        <div className="topbar-right">
          <span className={`ws-badge ws-${wsState}`}>
            <span className="ws-dot" />
            {wsState}
          </span>
          <a
            className="gh-link"
            href="https://github.com/AlexBlack-Dev/taskboard"
            target="_blank"
            rel="noreferrer"
          >
            github ↗
          </a>
        </div>
      </header>

      {error && (
        <div className="error-bar" role="alert">
          {error}
          <button type="button" className="error-dismiss" onClick={() => setError(null)}>
            dismiss
          </button>
        </div>
      )}

      <main className="board">
        <div className="board-head">
          <div className="board-title">
            {boards.length > 1 && (
              <select
                className="board-select"
                value={activeId ?? 0}
                onChange={(event) => setActiveId(Number(event.target.value))}
              >
                {boards.map((board) => (
                  <option key={board.id} value={board.id}>
                    {board.name}
                  </option>
                ))}
              </select>
            )}
            {boards.length <= 1 && (
              <h1>{boards.find((board) => board.id === activeId)?.name ?? "—"}</h1>
            )}
            <span className="board-meta">
              board #{activeId ?? "—"} · {tasks.length} tasks
            </span>
          </div>
          <form
            className="composer"
            onSubmit={(event) => {
              event.preventDefault();
              addTask();
            }}
          >
            <input
              className="composer-input"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="New task title — Enter to add"
              maxLength={200}
            />
            <button className="composer-add" type="submit">
              + Add
            </button>
          </form>
        </div>

        <div className="columns">
          {groups.map(({ column, items }) => (
            <section key={column} className={`column column-${column}`}>
              <header className="column-head">
                <span className="column-name">{COLUMN_LABELS[column]}</span>
                <span className="column-count">{items.length}</span>
              </header>
              <div className="column-body">
                {items.length === 0 && <p className="column-empty">no tasks yet</p>}
                {items.map((task) => (
                  <article key={task.id} className="card">
                    <p className="card-title">{task.title}</p>
                    <footer className="card-foot">
                      <button
                        type="button"
                        className="card-btn"
                        disabled={task.column === "done"}
                        title="move forward"
                        onClick={() => moveTask(task.id, COLUMN_WORK[task.column])}
                      >
                        →
                      </button>
                      <button
                        type="button"
                        className="card-btn"
                        disabled={task.column === "todo"}
                        title="move back"
                        onClick={() => moveTask(task.id, COLUMN_BACK[task.column])}
                      >
                        ←
                      </button>
                      <button
                        type="button"
                        className="card-btn card-del"
                        title="delete task"
                        onClick={() => removeTask(task.id)}
                      >
                        ×
                      </button>
                    </footer>
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>
      </main>

      <footer className="statusbar">
        <span>storage: SQLite · transport: WebSocket</span>
        <span>every change is broadcast to all connected clients</span>
      </footer>
    </div>
  );
}