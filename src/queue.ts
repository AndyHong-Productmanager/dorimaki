import { DorimakiError } from "./contracts.js";

export class ConversationQueue {
  private readonly pending = new Map<string, Promise<void>>();
  private readonly counts = new Map<string, number>();

  async run<T>(key: string, action: () => Promise<T>): Promise<T> {
    const count = this.counts.get(key) ?? 0;
    if (count >= 20) throw new DorimakiError("queue_full", "This conversation has 20 pending operations. Wait or stop its current turn.");
    this.counts.set(key, count + 1);
    const previous = this.pending.get(key) ?? Promise.resolve();
    const completion = Promise.withResolvers<void>();
    this.pending.set(key, completion.promise);
    await previous;
    try {
      return await action();
    } finally {
      completion.resolve();
      const remaining = (this.counts.get(key) ?? 1) - 1;
      if (remaining === 0) {
        this.counts.delete(key);
        this.pending.delete(key);
      } else {
        this.counts.set(key, remaining);
      }
    }
  }

  async drain(): Promise<void> {
    await Promise.all(this.pending.values());
  }
}
