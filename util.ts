// Deterministic helpers: the clock, request ids, hashing. Nothing here reads the wall clock
// (no Date.now / new Date / Math.random): every timestamp the entry emits derives from
// MAKEFUN_TRIAL_NOW plus a monotonic counter, so a replayed trial is byte-identical.

import { createHash } from 'node:crypto';

/** The trial's fixed "now", seconds since epoch. MAKEFUN_TRIAL_NOW may be ISO or epoch seconds/ms. */
function parseTrialNow(): number {
  const raw = (process.env.MAKEFUN_TRIAL_NOW ?? '').trim();
  const fallback = Math.floor(Date.parse('2026-11-14T06:30:00.000Z') / 1000);
  if (raw === '') return fallback;
  if (/^-?\d+$/.test(raw)) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    if (Math.abs(n) >= 1e12) return Math.floor(n / 1000);
    return n;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : fallback;
}

/** The trial's fixed epoch, seconds. */
export const TRIAL_NOW_SEC: number = parseTrialNow();

/** Monotonic tick counter: every created object gets the next second after the trial's now. */
let tickCounter = 0;

/**
 * The next deterministic timestamp, seconds since epoch: trial now plus one second per tick.
 * Strictly increasing across the process, so created_at order always matches creation order.
 */
export function tickSec(): number {
  tickCounter += 1;
  return TRIAL_NOW_SEC + tickCounter;
}

/** The next deterministic timestamp as an ISO-8601 UTC string. */
export function tickIso(): string {
  return new Date(tickSec() * 1000).toISOString();
}

/** An ISO-8601 UTC string for a fixed epoch second (no wall clock involved). */
export function isoOfSec(sec: number): string {
  return new Date(sec * 1000).toISOString();
}

/** Request-id counter: every reply carries a non-empty X-GitHub-Request-Id. */
let requestCounter = 0;

/** The next deterministic request id. */
export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

/** SHA-1 of a buffer, lowercase hex. */
export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The git object id of `type` + `data`: sha1("<type> <len>\0" + data). */
export function hashObject(type: string, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

/** Base64-encode a buffer (standard alphabet, with padding). */
export function b64encode(data: Buffer): string {
  return data.toString('base64');
}

/** Base64-decode a string; returns null when it is not valid base64. */
export function b64decode(text: string): Buffer | null {
  const clean = text.replace(/\s+/g, '');
  if (clean === '') return Buffer.alloc(0);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 !== 0) return null;
  return Buffer.from(clean, 'base64');
}

/** The all-zero object id. */
export const ZERO_OID = '0000000000000000000000000000000000000000';

/** Whether `value` is a 40-hex object id. */
export function isObjectId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-fA-F]{40}$/.test(value);
}

/** Lowercase a string, or '' when it is not one. */
export function lower(value: unknown): string {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

/** The token the env presents on every API call (empty when the env did not set one). */
export const SHOP_TOKEN: string = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** Whether an Authorization header presents the shop token. */
export function authorized(authHeader: string | undefined): boolean {
  if (SHOP_TOKEN === '') return true;
  if (authHeader === undefined) return false;
  return authHeader === `Bearer ${SHOP_TOKEN}`;
}

/** One HTTP answer: status, extra headers, and a body (string is sent as-is). */
export interface HttpResult {
  status: number;
  headers?: Record<string, string>;
  body: Buffer | string;
}

/** A JSON answer. */
export function jsonResult(status: number, body: unknown, headers?: Record<string, string>): HttpResult {
  return { status, headers, body: `${JSON.stringify(body)}\n` };
}

/** A JSON error answer: {message: <non-empty string>}. */
export function errorResult(status: number, message: string): HttpResult {
  return jsonResult(status, { message });
}
