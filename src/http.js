// A small "polite" HTTP client. Every request to an outside API goes through
// getJson(), which:
//   1. Spaces requests out per host so we never exceed a requests-per-second
//      budget (a simple rate limiter).
//   2. Retries on HTTP 429 (rate limited) and 5xx errors with exponential
//      backoff, honouring the server's Retry-After header.
//   3. Caches successful responses in memory for a short time, so the same
//      URL fetched twice in one refresh only hits the network once.

import { config } from './config.js';

const nextSlot = new Map(); // host -> timestamp (ms) when the next request may start
const cache = new Map();    // url  -> { expires, value }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForSlot(host) {
  const rps = config.rateLimits[host] ?? config.defaultRps;
  const gap = 1000 / rps;
  const now = Date.now();
  const slot = Math.max(now, nextSlot.get(host) ?? 0);
  nextSlot.set(host, slot + gap); // reserve our slot before awaiting
  if (slot > now) await sleep(slot - now);
}

// Never let an API key end up in logs or on the dashboard.
export const redact = (url) => String(url).replace(/(apiKey=)[^&]+/gi, '$1***');

export class HttpError extends Error {
  constructor(status, url, body) {
    super(`HTTP ${status} for ${redact(url)}${body ? `: ${body.slice(0, 200)}` : ''}`);
    this.status = status;
    this.url = url;
  }
}

/**
 * Fetch JSON from `url` with rate limiting, retries and caching.
 * @param {string} url
 * @param {{ ttlMs?: number, retries?: number, timeoutMs?: number, withHeaders?: boolean }} [opts]
 *   withHeaders: return { body, headers } instead of just the body (not cached).
 */
export async function getJson(url, { ttlMs = 0, retries = 4, timeoutMs = 20000, withHeaders = false } = {}) {
  const hit = cache.get(url);
  if (hit && hit.expires > Date.now()) return hit.value;

  const host = new URL(url).host;
  for (let attempt = 0; ; attempt++) {
    await waitForSlot(host);
    let res;
    try {
      res = await fetch(url, {
        headers: { accept: 'application/json', 'user-agent': 'consensus-bets/1.0 (read-only dashboard)' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // Network error or timeout: retry like a 5xx.
      if (attempt >= retries) {
        err.message = redact(err.message);
        throw err;
      }
      await sleep(backoff(attempt));
      continue;
    }

    if (res.ok) {
      const value = await res.json();
      if (withHeaders) return { body: value, headers: res.headers };
      if (ttlMs > 0) cache.set(url, { expires: Date.now() + ttlMs, value });
      return value;
    }

    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= retries) {
      throw new HttpError(res.status, url, await res.text().catch(() => ''));
    }
    const retryAfter = Number(res.headers.get('retry-after'));
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt));
  }
}

// 1s, 2s, 4s, 8s ... plus a little randomness so retries don't line up.
const backoff = (attempt) => 1000 * 2 ** attempt + Math.random() * 250;

/** Build a URL with query params; arrays become repeated params (a=1&a=2). */
export function buildUrl(base, path, params = {}) {
  const url = new URL(base.replace(/\/$/, '') + path);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) v.forEach((item) => url.searchParams.append(k, String(item)));
    else url.searchParams.set(k, String(v));
  }
  return url.toString();
}

/** Run `fn` over `items` with at most `limit` running at once. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

export function clearCache() {
  cache.clear();
}
