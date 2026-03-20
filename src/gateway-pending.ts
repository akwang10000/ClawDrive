type PendingEntry = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export class PendingRequestStore {
  private readonly entries = new Map<string, PendingEntry>();

  add(
    id: string,
    method: string,
    timeoutMs: number,
    resolve: (value: unknown) => void,
    reject: (error: Error) => void,
    onTimeout?: (method: string, durationMs: number) => void
  ): void {
    const timer = setTimeout(() => {
      const entry = this.take(id);
      if (!entry) {
        return;
      }
      onTimeout?.(method, timeoutMs);
      entry.reject(new Error(`Gateway request timed out: ${method}`));
    }, timeoutMs);

    this.entries.set(id, { method, resolve, reject, timer });
  }

  get(id: string): PendingEntry | undefined {
    return this.entries.get(id);
  }

  take(id: string): PendingEntry | undefined {
    const entry = this.entries.get(id);
    if (!entry) {
      return undefined;
    }
    clearTimeout(entry.timer);
    this.entries.delete(id);
    return entry;
  }

  clear(error: Error): void {
    for (const [id, entry] of this.entries.entries()) {
      clearTimeout(entry.timer);
      this.entries.delete(id);
      entry.reject(error);
    }
  }
}
