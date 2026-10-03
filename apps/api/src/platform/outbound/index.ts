/** Business-agnostic helpers for outbound HTTP connectors (HubSpot, Sugar, …). */
export { backoffDelayMs, parseRetryAfterMs } from './retry';
export { SlidingWindowRateLimiter } from './rate-limiter';
