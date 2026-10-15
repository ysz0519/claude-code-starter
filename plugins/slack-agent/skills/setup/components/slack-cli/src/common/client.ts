import { WebClient } from '@slack/web-api';
import { resolveToken, type TokenKind } from './token.js';

export function makeWebClient(kind: TokenKind): WebClient {
  const token = resolveToken(kind);
  return new WebClient(token, {
    retryConfig: {
      retries: 0,
    },
  });
}
