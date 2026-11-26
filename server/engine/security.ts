import crypto from 'node:crypto';
import net from 'node:net';

// ── Password Hashing (scrypt + salt, timing-safe verification) ──────────────

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  if (!storedHash || !password) return false;
  const parts = storedHash.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, expectedHex] = parts;
  const actual = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHex, 'hex');
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

// ── Session Management (Bearer tokens in server memory with expiry) ─────────

export interface SessionRecord {
  token: string;
  adminId: string;
  username: string;
  role: 'owner' | 'admin';
  createdAt: number;
  expiresAt: number;
}

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const EPHEMERAL_FALLBACK_KEY = crypto.randomBytes(32).toString('hex');

function getActiveSessionSecret(): string {
  const configured = (process.env.SESSION_SECRET || '').trim();
  return configured || EPHEMERAL_FALLBACK_KEY;
}

function signSessionId(sessionId: string): string {
  return crypto.createHmac('sha256', getActiveSessionSecret()).update(sessionId).digest('base64url');
}

export function verifySignedSessionToken(token: string): boolean {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return false;
  const sessionId = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = signSessionId(sessionId);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export class SessionManager {
  private sessions = new Map<string, SessionRecord>();

  create(adminId: string, username: string, role: 'owner' | 'admin'): SessionRecord {
    const sessionId = crypto.randomBytes(24).toString('base64url');
    const token = `${sessionId}.${signSessionId(sessionId)}`;
    const now = Date.now();
    const record: SessionRecord = {
      token,
      adminId,
      username,
      role,
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
    };
    this.sessions.set(token, record);
    this.prune();
    return record;
  }

  get(token: string | undefined | null): SessionRecord | null {
    if (!token) return null;
    if (!verifySignedSessionToken(token)) return null;
    const rec = this.sessions.get(token);
    if (!rec) return null;
    if (Date.now() > rec.expiresAt) {
      this.sessions.delete(token);
      return null;
    }
    return rec;
  }

  destroy(token: string | undefined | null): void {
    if (token) this.sessions.delete(token);
  }

  revokeOthers(adminId: string, keepToken: string): number {
    let removed = 0;
    for (const [tok, rec] of this.sessions.entries()) {
      if (rec.adminId === adminId && tok !== keepToken) {
        this.sessions.delete(tok);
        removed += 1;
      }
    }
    return removed;
  }

  revokeForAdmin(adminId: string): number {
    let removed = 0;
    for (const [tok, rec] of this.sessions.entries()) {
      if (rec.adminId === adminId) {
        this.sessions.delete(tok);
        removed += 1;
      }
    }
    return removed;
  }

  activeCount(): number {
    this.prune();
    return this.sessions.size;
  }

  private prune(): void {
    const now = Date.now();
    for (const [tok, rec] of this.sessions.entries()) {
      if (now > rec.expiresAt) this.sessions.delete(tok);
    }
  }
}

export const sessionManager = new SessionManager();

// ── Per-IP Brute Force Rate Limiter ─────────────────────────────────────────

export class LoginRateLimiter {
  private attempts = new Map<string, { count: number; firstMs: number }>();
  constructor(
    private readonly maxFailures = 10,
    private readonly windowMs = 5 * 60 * 1000
  ) {}

  isBlocked(ip: string): boolean {
    const rec = this.attempts.get(ip);
    if (!rec) return false;
    if (Date.now() - rec.firstMs > this.windowMs) {
      this.attempts.delete(ip);
      return false;
    }
    return rec.count >= this.maxFailures;
  }

  registerFailure(ip: string): void {
    const now = Date.now();
    const rec = this.attempts.get(ip);
    if (!rec || now - rec.firstMs > this.windowMs) {
      this.attempts.set(ip, { count: 1, firstMs: now });
    } else {
      rec.count += 1;
    }
    if (this.attempts.size > 2000) {
      const oldest = this.attempts.keys().next().value;
      if (oldest) this.attempts.delete(oldest);
    }
  }

  clear(ip: string): void {
    this.attempts.delete(ip);
  }
}

export const loginLimiter = new LoginRateLimiter();
export const nodeAuthLimiter = new LoginRateLimiter(10, 5 * 60 * 1000);

// ── SSRF & Host Validation ──────────────────────────────────────────────────

export function isPrivateOrBlockedIp(ip: string): boolean {
  const clean = ip.replace(/^\[|\]$/g, '').trim().toLowerCase();
  if (!clean) return true;
  if (clean === 'localhost' || clean.endsWith('.local') || clean.endsWith('.internal')) return true;

  if (net.isIPv4(clean)) {
    const parts = clean.split('.').map(Number);
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local & cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast / reserved
    return false;
  }

  if (net.isIPv6(clean)) {
    if (clean === '::' || clean === '::1') return true;
    if (clean.startsWith('fc') || clean.startsWith('fd')) return true; // ULA
    if (clean.startsWith('fe80') || clean.startsWith('ff')) return true; // link-local / multicast
    if (clean.startsWith('::ffff:')) {
      return isPrivateOrBlockedIp(clean.slice(7));
    }
    return false;
  }

  return false;
}

export function validateExternalHttpUrl(rawUrl: string): { ok: true; origin: string; url: URL } | { ok: false; error: string } {
  const trimmed = rawUrl.trim();
  if (!trimmed) return { ok: false, error: 'URL is required' };
  let parsed: URL;
  try {
    parsed = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
  } catch {
    return { ok: false, error: 'Invalid URL format' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'Only http:// and https:// schemes are permitted' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: 'URL must not contain embedded credentials' };
  }
  if (!parsed.hostname || isPrivateOrBlockedIp(parsed.hostname)) {
    return { ok: false, error: 'Private, loopback, or metadata hosts are blocked' };
  }
  return { ok: true, origin: parsed.origin, url: parsed };
}

// ── Telegram Mini App WebAppData HMAC-SHA256 Validation ─────────────────────

export interface VerifiedTelegramUser {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export function verifyTelegramInitData(
  initDataRaw: string,
  botToken: string,
  maxAgeSec = 86400,
  nowSec = Math.floor(Date.now() / 1000)
): { ok: true; user: VerifiedTelegramUser; authDate: number } | { ok: false; error: string } {
  if (!botToken || !initDataRaw) {
    return { ok: false, error: 'Missing Telegram initData or bot token' };
  }

  const params = new URLSearchParams(initDataRaw);
  const receivedHash = params.get('hash') || '';
  if (!receivedHash || !/^[0-9a-f]{64}$/i.test(receivedHash)) {
    return { ok: false, error: 'Malformed Telegram signature' };
  }

  const pairs: string[] = [];
  for (const [k, v] of params.entries()) {
    if (k !== 'hash') pairs.push(`${k}=${v}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expectedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  const a = Buffer.from(receivedHash.toLowerCase(), 'hex');
  const b = Buffer.from(expectedHash.toLowerCase(), 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, error: 'Invalid Telegram signature' };
  }

  const authDate = Number(params.get('auth_date') || '0');
  if (!Number.isFinite(authDate) || nowSec - authDate > maxAgeSec || authDate > nowSec + 300) {
    return { ok: false, error: 'Telegram session expired' };
  }

  try {
    const userJson = params.get('user');
    if (!userJson) return { ok: false, error: 'Missing Telegram user payload' };
    const user = JSON.parse(userJson) as VerifiedTelegramUser;
    if (!user || typeof user.id !== 'number') {
      return { ok: false, error: 'Invalid Telegram user ID' };
    }
    return { ok: true, user, authDate };
  } catch {
    return { ok: false, error: 'Failed to parse Telegram user JSON' };
  }
}
