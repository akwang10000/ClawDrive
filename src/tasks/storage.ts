import * as fs from "fs/promises";
import * as path from "path";
import type { TaskEventRecord, TaskSnapshot } from "./types";

interface TaskIndexFile {
  order: string[];
}

export class TaskStorage {
  private readonly tasksPath: string;
  private readonly indexPath: string;
  private readonly historyLimit: number;

  constructor(rootPath: string, historyLimit: number) {
    this.tasksPath = path.join(rootPath, "tasks");
    this.indexPath = path.join(this.tasksPath, "index.json");
    this.historyLimit = Math.max(1, historyLimit);
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.tasksPath, { recursive: true });
    try {
      await fs.access(this.indexPath);
    } catch {
      await fs.writeFile(this.indexPath, JSON.stringify({ order: [] }, null, 2), "utf8");
    }
  }

  async listSnapshots(): Promise<TaskSnapshot[]> {
    await this.initialize();
    const index = await this.readIndex();
    const snapshots: TaskSnapshot[] = [];
    for (const taskId of index.order) {
      const snapshot = await this.readSnapshot(taskId);
      if (snapshot) {
        snapshots.push(snapshot);
      }
    }
    return snapshots.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async readSnapshot(taskId: string): Promise<TaskSnapshot | null> {
    try {
      const raw = await fs.readFile(this.snapshotPath(taskId), "utf8");
      return JSON.parse(raw) as TaskSnapshot;
    } catch {
      return null;
    }
  }

  async saveSnapshot(snapshot: TaskSnapshot): Promise<void> {
    await this.initialize();
    await fs.mkdir(this.taskDir(snapshot.taskId), { recursive: true });
    await fs.writeFile(this.snapshotPath(snapshot.taskId), JSON.stringify(snapshot, null, 2), "utf8");

    const index = await this.readIndex();
    index.order = [snapshot.taskId, ...index.order.filter((taskId) => taskId !== snapshot.taskId)];
    await this.prune(index);
    await this.writeIndex(index);
  }

  async appendEvent(event: TaskEventRecord): Promise<void> {
    await fs.mkdir(this.taskDir(event.taskId), { recursive: true });
    await fs.appendFile(this.eventsPath(event.taskId), `${JSON.stringify(event)}\n`, "utf8");
  }

  async deleteTask(taskId: string): Promise<void> {
    await this.initialize();
    const index = await this.readIndex();
    const nextOrder = index.order.filter((entry) => entry !== taskId);
    await fs.rm(this.taskDir(taskId), { recursive: true, force: true });
    if (nextOrder.length !== index.order.length) {
      await this.writeIndex({ order: nextOrder });
    }
  }

  async readEvents(taskId: string): Promise<TaskEventRecord[]> {
    try {
      const raw = await fs.readFile(this.eventsPath(taskId), "utf8");
      return raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as TaskEventRecord);
    } catch {
      return [];
    }
  }

  private async prune(index: TaskIndexFile): Promise<void> {
    const kept: string[] = [];
    let terminalCount = 0;

    for (const taskId of index.order) {
      const snapshot = await this.readSnapshot(taskId);
      if (!snapshot) {
        continue;
      }

      const terminal =
        snapshot.state === "completed" ||
        snapshot.state === "failed" ||
        snapshot.state === "cancelled";

      if (terminal) {
        terminalCount += 1;
        if (terminalCount > this.historyLimit) {
          await fs.rm(this.taskDir(taskId), { recursive: true, force: true });
          continue;
        }
      }

      kept.push(taskId);
    }

    index.order = kept;
  }

  private async readIndex(): Promise<TaskIndexFile> {
    try {
      const raw = await fs.readFile(this.indexPath, "utf8");
      const parsed = JSON.parse(raw) as TaskIndexFile;
      return { order: Array.isArray(parsed.order) ? parsed.order.filter((item) => typeof item === "string") : [] };
    } catch {
      return { order: [] };
    }
  }

  private async writeIndex(index: TaskIndexFile): Promise<void> {
    await fs.writeFile(this.indexPath, JSON.stringify(index, null, 2), "utf8");
  }

  private taskDir(taskId: string): string {
    return path.join(this.tasksPath, taskId);
  }

  private snapshotPath(taskId: string): string {
    return path.join(this.taskDir(taskId), "snapshot.json");
  }

  private eventsPath(taskId: string): string {
    return path.join(this.taskDir(taskId), "events.jsonl");
  }
}
