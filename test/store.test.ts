import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../src/db";

describe("Store (SQLite)", () => {
  it("creates and lists boards", () => {
    const store = new Store();
    const board = store.createBoard("Alpha");
    expect(board.id).toBeGreaterThan(0);
    expect(board.name).toBe("Alpha");
    expect(store.listBoards()).toHaveLength(1);
    store.close();
  });

  it("adds tasks with per-column positions", () => {
    const store = new Store();
    const board = store.createBoard("Beta");
    const first = store.addTask(board.id, "one", "todo");
    const second = store.addTask(board.id, "two", "todo");
    const parked = store.addTask(board.id, "three", "done");
    expect(first?.position).toBe(1000);
    expect(second?.position).toBe(2000);
    expect(parked?.column).toBe("done");
    expect(store.listTasks(board.id)).toHaveLength(3);
    store.close();
  });

  it("rejects tasks for missing boards and empty titles", () => {
    const store = new Store();
    expect(store.addTask(999, "ghost", "todo")).toBeNull();
    expect(store.addTask(1, "", "todo")).toBeNull();
    store.close();
  });

  it("moves tasks between columns in FIFO order", () => {
    const store = new Store();
    const board = store.createBoard("Gamma");
    const a = store.addTask(board.id, "a", "todo");
    const b = store.addTask(board.id, "b", "todo");
    const moved = store.moveTask(a!.id, "doing");
    expect(moved?.column).toBe("doing");
    const list = store.listTasks(board.id);
    const movedAgain = store.moveTask(b!.id, "doing");
    expect(movedAgain?.position).toBeGreaterThan(moved?.position ?? 0);
    expect(list).toHaveLength(2);
    store.close();
  });

  it("deletes tasks", () => {
    const store = new Store();
    const board = store.createBoard("Delta");
    const task = store.addTask(board.id, "doomed", "doing");
    expect(store.deleteTask(task!.id)).toBe(true);
    expect(store.deleteTask(task!.id)).toBe(false);
    expect(store.listTasks(board.id)).toHaveLength(0);
    store.close();
  });

  it("persists to a file and reloads", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "taskboard-"));
    const file = path.join(dir, "board.db");
    try {
      const first = new Store(file);
      const board = first.createBoard("Persistent");
      first.addTask(board.id, "survives", "todo");
      first.close();

      const second = new Store(file);
      expect(second.listBoards()[0]?.name).toBe("Persistent");
      expect(second.listTasks(board.id)[0]?.title).toBe("survives");
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});