import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IDLE_HEAL_MS, createIdleHeal } from '../idle-heal.js';

describe('idle heal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const setup = () => {
    const onIdle = vi.fn();
    return { onIdle, heal: createIdleHeal({ onIdle }) };
  };

  it('runs no timer while the stack is empty', () => {
    const { onIdle, heal } = setup();

    heal.setActive(false);
    heal.activity();
    vi.advanceTimersByTime(IDLE_HEAL_MS * 3);

    expect(onIdle).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('heals at exactly 60 s after the stack opens', () => {
    const { onIdle, heal } = setup();

    heal.setActive(true);
    vi.advanceTimersByTime(59_999);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(IDLE_HEAL_MS).toBe(60_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('pushes the deadline to 119 s when the lifter acts at 59 s', () => {
    const { onIdle, heal } = setup();

    heal.setActive(true);
    vi.advanceTimersByTime(59_000);
    heal.activity();
    vi.advanceTimersByTime(59_999);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('cancels the deadline when the lifter empties the stack', () => {
    const { onIdle, heal } = setup();

    heal.setActive(true);
    vi.advanceTimersByTime(30_000);
    heal.setActive(false);
    vi.advanceTimersByTime(IDLE_HEAL_MS);

    expect(onIdle).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not restart the deadline on poll-style re-reports of an open stack', () => {
    const { onIdle, heal } = setup();

    heal.setActive(true);
    for (let elapsed = 0; elapsed < IDLE_HEAL_MS; elapsed += 2_000) {
      vi.advanceTimersByTime(2_000);
      heal.setActive(true);
    }

    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('fires once per idle period and re-arms when the stack opens again', () => {
    const { onIdle, heal } = setup();

    heal.setActive(true);
    vi.advanceTimersByTime(IDLE_HEAL_MS);
    heal.setActive(false);
    heal.setActive(true);
    vi.advanceTimersByTime(IDLE_HEAL_MS);

    expect(onIdle).toHaveBeenCalledTimes(2);
  });

  it('stops the deadline on dispose', () => {
    const { onIdle, heal } = setup();

    heal.setActive(true);
    heal.dispose();
    vi.advanceTimersByTime(IDLE_HEAL_MS);

    expect(onIdle).not.toHaveBeenCalled();
  });
});
