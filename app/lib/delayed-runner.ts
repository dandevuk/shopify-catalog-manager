/**
 * Runs a task once, a given time after the last request for its key.
 * Requesting the same key again before it runs restarts the wait with the new
 * delay, so a burst of events for one product causes one run.
 *
 * In-process only: pending tasks are lost when the server restarts. It stands
 * in for delayed jobs until the BullMQ queue exists (Phase 1, step 5).
 */
export interface DelayedRunner {
  schedule(key: string, delayMs: number, task: () => Promise<void>): void;
  readonly pendingCount: number;
}

export function createDelayedRunner(
  onError: (key: string, error: unknown) => void = (key, error) =>
    console.error(`Delayed task ${key} failed`, error),
): DelayedRunner {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  return {
    schedule(key, delayMs, task) {
      const existing = timers.get(key);
      if (existing) clearTimeout(existing);

      timers.set(
        key,
        setTimeout(() => {
          timers.delete(key);
          task().catch((error) => onError(key, error));
        }, delayMs),
      );
    },
    get pendingCount() {
      return timers.size;
    },
  };
}
