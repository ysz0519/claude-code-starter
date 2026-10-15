import { ExitCode, SlackCliError } from './errors.js';
import { log } from './logger.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      const retryAfter = err?.data?.retry_after as number | undefined;
      const code = err?.code as string | undefined;
      const isRateLimited = code === 'slack_webapi_rate_limited_error' || typeof retryAfter === 'number';

      if (isRateLimited && attempt < maxAttempts) {
        const waitSec = retryAfter ?? 1;
        log(`Rate limited. Waiting ${waitSec}s (attempt ${attempt}/${maxAttempts})`);
        await sleep(waitSec * 1000);
        continue;
      }
      throw err;
    }
  }
  throw new SlackCliError(
    `Max retry attempts exceeded: ${(lastErr as Error)?.message ?? 'unknown'}`,
    ExitCode.RateLimit,
  );
}
