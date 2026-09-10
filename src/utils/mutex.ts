/**
 * A mutex keyed by string.
 *
 * This is load-bearing for correct user attribution: subscribe and teardown
 * for a given `guildId:userId` must never interleave, or a late
 * `speaking.start` could bind a receive stream to a `UserAudioStream` that is
 * mid-teardown — which is precisely how audio ends up attributed to the wrong
 * person.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();

  /** Run `fn` with exclusive access to `key`. FIFO among waiters. */
  async runExclusive<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();

    // Chain onto the previous holder, ignoring whether it succeeded.
    const run = previous.then(
      () => fn(),
      () => fn(),
    );

    // The tail must never reject, or every future waiter on this key inherits
    // the rejection.
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);

    try {
      return await run;
    } finally {
      // Only clear if we are still the tail; otherwise a newer waiter owns it.
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    }
  }

  /** Number of keys with in-flight or queued work. Diagnostics only. */
  get size(): number {
    return this.tails.size;
  }
}
