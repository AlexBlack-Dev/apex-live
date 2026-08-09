import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { Store } from "../src/db";
import { createApp, ServerHandle } from "../src/server";

let db: Store;
let handle: ServerHandle;
let base: string;

beforeAll(async () => {
  db = new Store();
  handle = createApp(db, { port: 0 });
  await new Promise((resolve) => setTimeout(resolve, 200));
  base = `http://127.0.0.1:${handle.port}/api`;
});

afterAll(async () => {
  await handle.close();
  db.close();
});

describe("REST API", () => {
  it("lists boards (initially empty)", async () => {
    const response = await fetch(`${base}/boards`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ boards: [] });
  });

  it("creates a board and rejects empty names", async () => {
    const bad = await fetch(`${base}/boards`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "   " }),
    });
    expect(bad.status).toBe(400);

    const good = await fetch(`${base}/boards`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Sprint 42" }),
    });
    expect(good.status).toBe(201);
    const body = (await good.json()) as { board: { id: number; name: string } };
    expect(body.board.name).toBe("Sprint 42");
  });

  it("fails on malformed json", async () => {
    const response = await fetch(`${base}/boards`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(response.status).toBe(400);
  });

  it("adds and lists tasks for a board", async () => {
    const boards = await (await fetch(`${base}/boards`)).json() as {
      boards: Array<{ id: number }>;
    };
    const boardId = boards.boards[0]!.id;

    const created = await fetch(`${base}/boards/${boardId}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "First task" }),
    });
    expect(created.status).toBe(201);

    const detail = await (await fetch(`${base}/boards/${boardId}`)).json() as {
      board: { id: number };
      tasks: Array<{ title: string }>;
    };
    expect(detail.board.id).toBe(boardId);
    expect(detail.tasks).toHaveLength(1);
    expect(detail.tasks[0]!.title).toBe("First task");
  });

  it("moves a task between columns", async () => {
    const boards = await (await fetch(`${base}/boards`)).json() as {
      boards: Array<{ id: number }>;
    };
    const boardId = boards.boards[0]!.id;
    const detail = await (await fetch(`${base}/boards/${boardId}`)).json() as {
      tasks: Array<{ id: number }>;
    };
    const taskId = detail.tasks[0]!.id;

    const moved = await fetch(`${base}/tasks/${taskId}/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ column: "done" }),
    });
    expect(moved.status).toBe(200);
    const body = (await moved.json()) as { task: { column: string } };
    expect(body.task.column).toBe("done");
  });

  it("returns 404 for unknown resources", async () => {
    const board = await fetch(`${base}/boards/4242`);
    expect(board.status).toBe(404);
    const task = await fetch(`${base}/tasks/4242/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ column: "todo" }),
    });
    expect(task.status).toBe(404);
  });

  it("deletes a task", async () => {
    const boards = await (await fetch(`${base}/boards`)).json() as {
      boards: Array<{ id: number }>;
    };
    const boardId = boards.boards[0]!.id;
    const created = await fetch(`${base}/boards/${boardId}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "To delete" }),
    });
    const { task } = (await created.json()) as { task: { id: number } };

    const removed = await fetch(`${base}/tasks/${task.id}`, { method: "DELETE" });
    expect(removed.status).toBe(200);
    const again = await fetch(`${base}/tasks/${task.id}`, { method: "DELETE" });
    expect(again.status).toBe(404);
  });
});

describe("WebSocket broadcast", () => {
  it("receives board-updated after a task change", async () => {
    const boards = await (await fetch(`${base}/boards`)).json() as {
      boards: Array<{ id: number }>;
    };
    const boardId = boards.boards[0]!.id;

    const socket = new WebSocket(`ws://127.0.0.1:${handle.port}/ws`);
    const opened = new Promise<void>((resolve) => socket.once("open", resolve));
    await opened;

    const message = new Promise<{ type: string; boardId: number }>((resolve) =>
      socket.once("message", (data) => resolve(JSON.parse(data.toString()) as never))
    );

    await fetch(`${base}/boards/${boardId}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Broadcast me", column: "doing" }),
    });

    const event = await message;
    expect(event.type).toBe("board-updated");
    expect(event.boardId).toBe(boardId);
    socket.close();
  });

  it("replies pong to ping", async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${handle.port}/ws`);
    await new Promise<void>((resolve) => socket.once("open", resolve));
    const pong = new Promise<{ type: string }>((resolve) =>
      socket.once("message", (data) => resolve(JSON.parse(data.toString()) as never))
    );
    socket.send(JSON.stringify({ type: "ping" }));
    expect((await pong).type).toBe("pong");
    socket.close();
  });

  it("replies error to an invalid message", async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${handle.port}/ws`);
    await new Promise<void>((resolve) => socket.once("open", resolve));
    const reply = new Promise<{ type: string }>((resolve) =>
      socket.once("message", (data) => resolve(JSON.parse(data.toString()) as never))
    );
    socket.send("garbage");
    expect((await reply).type).toBe("error");
    socket.close();
  });
});