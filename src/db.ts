import Database from "better-sqlite3";

export type Column = "todo" | "doing" | "done";

export const COLUMNS: Column[] = ["todo", "doing", "done"];

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

export class Store {
  private db: Database.Database;
  private insertBoard: Database.Statement;
  private insertTask: Database.Statement;
  private moveTaskStmt: Database.Statement;
  private deleteTaskStmt: Database.Statement;

  constructor(file = ":memory:") {
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS boards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        column TEXT NOT NULL CHECK (column IN ('todo','doing','done')),
        position INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    this.insertBoard = this.db.prepare(
      "INSERT INTO boards (name, created_at) VALUES (?, ?)"
    );
    this.insertTask = this.db.prepare(`
      INSERT INTO tasks (board_id, title, column, position, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    this.moveTaskStmt = this.db.prepare(`
      UPDATE tasks SET column = ?,
        position = (
          SELECT COALESCE(MAX(t2.position), 0) + 1
          FROM tasks t2
          WHERE t2.board_id = tasks.board_id AND t2.column = ?
        )
      WHERE id = ?
    `);
    this.deleteTaskStmt = this.db.prepare("DELETE FROM tasks WHERE id = ?");
  }

  createBoard(name: string): Board {
    const info = this.insertBoard.run(name, Date.now());
    const board = this.getBoard(Number(info.lastInsertRowid));
    if (!board) throw new Error("board not found after insert");
    return board;
  }

  listBoards(): Board[] {
    return this.db
      .prepare("SELECT id, name, created_at AS createdAt FROM boards ORDER BY id DESC")
      .all() as Board[];
  }

  getBoard(id: number): Board | null {
    const row = this.db
      .prepare("SELECT id, name, created_at AS createdAt FROM boards WHERE id = ?")
      .get(id) as Board | undefined;
    return row ?? null;
  }

  addTask(boardId: number, title: string, column: Column): Task | null {
    if (!this.getBoard(boardId)) return null;
    const position = (this.countByColumn(boardId, column) + 1) * 1000;
    const info = this.insertTask.run(boardId, title.trim(), column, position, Date.now());
    const task = this.getTask(Number(info.lastInsertRowid));
    return task;
  }

  getTask(id: number): Task | null {
    const row = this.db
      .prepare(`
        SELECT id, board_id AS boardId, title, column, position, created_at AS createdAt
        FROM tasks WHERE id = ?
      `)
      .get(id) as Task | undefined;
    return row ?? null;
  }

  listTasks(boardId: number): Task[] {
    return this.db
      .prepare(`
        SELECT id, board_id AS boardId, title, column, position, created_at AS createdAt
        FROM tasks WHERE board_id = ?
        ORDER BY position ASC, id ASC
      `)
      .all(boardId) as Task[];
  }

  moveTask(taskId: number, column: Column): Task | null {
    const info = this.moveTaskStmt.run(column, column, taskId);
    if (info.changes === 0) return null;
    return this.getTask(taskId);
  }

  deleteTask(taskId: number): boolean {
    return this.deleteTaskStmt.run(taskId).changes > 0;
  }

  private countByColumn(boardId: number, column: Column): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM tasks WHERE board_id = ? AND column = ?"
      )
      .get(boardId, column) as { n: number };
    return row.n;
  }

  close(): void {
    this.db.close();
  }
}