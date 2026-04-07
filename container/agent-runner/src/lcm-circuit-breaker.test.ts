import { describe, it, expect, beforeEach } from 'vitest';
import { CircuitBreaker } from './lcm-circuit-breaker.js';

describe('CircuitBreaker', () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker(3, 1000); // threshold=3, cooldown=1s
  });

  it('starts closed', () => {
    expect(breaker.isOpen('test')).toBe(false);
  });

  it('stays closed below threshold', () => {
    breaker.recordFailure('test');
    breaker.recordFailure('test');
    expect(breaker.isOpen('test')).toBe(false);
  });

  it('opens at threshold', () => {
    breaker.recordFailure('test');
    breaker.recordFailure('test');
    breaker.recordFailure('test');
    expect(breaker.isOpen('test')).toBe(true);
  });

  it('resets on success', () => {
    breaker.recordFailure('test');
    breaker.recordFailure('test');
    breaker.recordSuccess('test');
    breaker.recordFailure('test');
    breaker.recordFailure('test');
    // Only 2 failures since reset — still closed
    expect(breaker.isOpen('test')).toBe(false);
  });

  it('auto-resets after cooldown', async () => {
    breaker.recordFailure('test');
    breaker.recordFailure('test');
    breaker.recordFailure('test');
    expect(breaker.isOpen('test')).toBe(true);

    // Wait for cooldown
    await new Promise(r => setTimeout(r, 1100));
    expect(breaker.isOpen('test')).toBe(false);
  });

  it('tracks keys independently', () => {
    breaker.recordFailure('a');
    breaker.recordFailure('a');
    breaker.recordFailure('a');
    expect(breaker.isOpen('a')).toBe(true);
    expect(breaker.isOpen('b')).toBe(false);
  });

  it('exposes internal state for testing', () => {
    breaker.recordFailure('test');
    const state = breaker._getState('test');
    expect(state).toBeDefined();
    expect(state!.failures).toBe(1);
    expect(state!.openSince).toBeNull();
  });

  it('records openSince when tripped', () => {
    breaker.recordFailure('test');
    breaker.recordFailure('test');
    breaker.recordFailure('test');
    const state = breaker._getState('test');
    expect(state!.openSince).toBeTypeOf('number');
  });
});
