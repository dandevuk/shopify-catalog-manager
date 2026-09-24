import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDelayedRunner } from "./delayed-runner";

describe("createDelayedRunner", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("runs the task after its delay", async () => {
    const runner = createDelayedRunner();
    const task = vi.fn().mockResolvedValue(undefined);

    runner.schedule("a", 30_000, task);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(task).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(task).toHaveBeenCalledOnce();
    expect(runner.pendingCount).toBe(0);
  });

  it("restarts the wait when the same key is scheduled again, and runs once", async () => {
    const runner = createDelayedRunner();
    const first = vi.fn().mockResolvedValue(undefined);
    const second = vi.fn().mockResolvedValue(undefined);

    runner.schedule("a", 30_000, first);
    await vi.advanceTimersByTimeAsync(20_000);
    runner.schedule("a", 30_000, second);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(second).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });

  it("keeps different keys separate, each with its own delay", async () => {
    const runner = createDelayedRunner();
    const a = vi.fn().mockResolvedValue(undefined);
    const b = vi.fn().mockResolvedValue(undefined);

    runner.schedule("a", 1_000, a);
    runner.schedule("b", 5_000, b);
    expect(runner.pendingCount).toBe(2);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(a).toHaveBeenCalledOnce();
    expect(b).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(b).toHaveBeenCalledOnce();
  });

  it("reports a failed task instead of throwing", async () => {
    const onError = vi.fn();
    const runner = createDelayedRunner(onError);
    const error = new Error("boom");

    runner.schedule("a", 1_000, () => Promise.reject(error));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(onError).toHaveBeenCalledWith("a", error);
  });
});
