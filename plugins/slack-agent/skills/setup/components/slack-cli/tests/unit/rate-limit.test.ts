import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withRetry } from '../../src/common/rate-limit.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('withRetry', () => {
  it('returns the result on the first attempt when fn resolves', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    await expect(withRetry(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries after Retry-After and eventually succeeds', async () => {
    const rateLimitErr = Object.assign(new Error('rate limited'), {
      code: 'slack_webapi_rate_limited_error',
      data: { retry_after: 2 },
    });
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(rateLimitErr)
      .mockResolvedValueOnce('ok');

    const promise = withRetry(fn, 3);
    // First attempt rejects -> schedules a 2000ms sleep.
    await vi.advanceTimersByTimeAsync(2000);
    await expect(promise).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws non-rate-limit errors immediately without retrying', async () => {
    const otherErr = new Error('boom');
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(otherErr);
    await expect(withRetry(fn, 3)).rejects.toBe(otherErr);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws after exhausting maxAttempts on continuous rate-limit', async () => {
    const rateLimitErr = Object.assign(new Error('rate limited'), {
      code: 'slack_webapi_rate_limited_error',
      data: { retry_after: 1 },
    });
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(rateLimitErr);

    const promise = withRetry(fn, 3);
    // Catch promise rejection ahead of time so it does not become unhandled
    // while we advance timers in between sleeps.
    const expectation = expect(promise).rejects.toBe(rateLimitErr);
    // First failure -> 1s sleep -> retry; second failure -> 1s sleep -> retry;
    // third failure -> no more retries -> throw.
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await expectation;
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('treats data.retry_after even without slack_webapi_rate_limited_error code', async () => {
    const rateLimitErr = Object.assign(new Error('rate limited'), {
      data: { retry_after: 1 },
    });
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(rateLimitErr)
      .mockResolvedValueOnce('ok');

    const promise = withRetry(fn, 2);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(promise).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
