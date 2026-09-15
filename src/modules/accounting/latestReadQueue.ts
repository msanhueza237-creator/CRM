// A refresh requested after a mutation must not reuse a read started before it.
export class LatestReadQueue<T> {
  private active: Promise<void> | null = null;
  private requested = 0;

  request(read: () => Promise<T>, publish: (value: T) => void, invalidate = false): Promise<void> {
    if (this.active) {
      if (invalidate) this.requested += 1;
      return this.active;
    }
    this.requested += 1;
    this.active = Promise.resolve().then(async () => {
      for (;;) {
        const version = this.requested;
        try {
          const value = await read();
          if (version !== this.requested) continue;
          publish(value);
          return;
        } catch (error) {
          if (version === this.requested) throw error;
        }
      }
    }).finally(() => { this.active = null; });
    return this.active;
  }
}
