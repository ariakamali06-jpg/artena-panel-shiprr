import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  hashPassword,
  isPrivateOrBlockedIp,
  validateExternalHttpUrl,
  verifyPassword,
  verifyTelegramInitData,
} from './security';
import { evaluateIpAndConnectionLimit, isServiceAllowed, SpeedLimiter } from './rateLimiter';
import { parseProxyLine, scoreProxyProbe } from './outboundProxy';

test('scrypt password hashing verifies matching passwords and rejects wrong ones', () => {
  const hash = hashPassword('ArtenaStrongPass!42');
  assert.ok(hash.startsWith('scrypt$'));
  assert.equal(verifyPassword('ArtenaStrongPass!42', hash), true);
  assert.equal(verifyPassword('WrongPass', hash), false);
});

test('SSRF guards block loopback, RFC1918 private, and cloud metadata addresses', () => {
  assert.equal(isPrivateOrBlockedIp('127.0.0.1'), true);
  assert.equal(isPrivateOrBlockedIp('169.254.169.254'), true);
  assert.equal(isPrivateOrBlockedIp('10.0.0.5'), true);
  assert.equal(isPrivateOrBlockedIp('192.168.1.10'), true);
  assert.equal(isPrivateOrBlockedIp('localhost'), true);
  assert.equal(isPrivateOrBlockedIp('1.1.1.1'), false);
  assert.equal(isPrivateOrBlockedIp('panel.example.com'), false);

  assert.equal(validateExternalHttpUrl('http://169.254.169.254/latest/meta-data').ok, false);
  assert.equal(validateExternalHttpUrl('https://node1.example.com:8443/path').ok, true);
});

test('Telegram WebAppData HMAC-SHA256 verification validates genuine initData and rejects tampered data', () => {
  const botToken = '123456:TEST_BOT_TOKEN_SECRET';
  const authDate = Math.floor(Date.now() / 1000);
  const userJson = JSON.stringify({ id: 987654321, username: 'ops_admin' });
  const params = new URLSearchParams({ auth_date: String(authDate), query_id: 'AAE', user: userJson });
  const checkStr = Array.from(params.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secret).update(checkStr).digest('hex');
  params.set('hash', hash);

  const valid = verifyTelegramInitData(params.toString(), botToken);
  assert.equal(valid.ok, true);
  if (valid.ok) assert.equal(valid.user.id, 987654321);

  params.set('query_id', 'TAMPERED');
  const tampered = verifyTelegramInitData(params.toString(), botToken);
  assert.equal(tampered.ok, false);
});

test('proxy line parser and grading engine handle standard formats', () => {
  const p1 = parseProxyLine('socks5://alice:pass123@203.0.113.10:1080');
  assert.ok(p1);
  assert.equal(p1.scheme, 'socks5');
  assert.equal(p1.username, 'alice');
  assert.equal(p1.port, 1080);

  const p2 = parseProxyLine('198.51.100.22:8080:bob:secret', 'http');
  assert.ok(p2);
  assert.equal(p2.scheme, 'http');
  assert.equal(p2.username, 'bob');

  const high = scoreProxyProbe({ ok: true, latencyMs: 85, tlsOk: true, speedKbps: 6000 });
  assert.equal(high.grade, 'A');
  const fail = scoreProxyProbe({ ok: false, latencyMs: null, tlsOk: false, speedKbps: null });
  assert.equal(fail.grade, 'F');
});

test('IP limit, quota, expiry checks and speed limiter behave deterministically', async () => {
  const svc = {
    id: 'svc-1',
    active: true,
    limitBytes: 1000,
    usedBytes: 500,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ipLimit: 1,
    connectionLimit: 2,
  };
  assert.equal(isServiceAllowed(svc as never), true);
  assert.equal(isServiceAllowed({ ...svc, usedBytes: 1000 } as never), false);
  assert.equal(isServiceAllowed({ ...svc, expiresAt: new Date(Date.now() - 1000).toISOString() } as never), false);

  const active = [{ serviceId: 'svc-1', ip: '203.0.113.1' }];
  assert.equal(evaluateIpAndConnectionLimit(svc, '203.0.113.1', active).allowed, true);
  assert.equal(evaluateIpAndConnectionLimit(svc, '203.0.113.2', active).allowed, false);

  const limiter = new SpeedLimiter();
  await limiter.throttle('svc-1', 1024, 1024 * 1024);
  limiter.reset('svc-1');
});

import { buildConfigStatusList, resolveRuntimeConfig } from '../config/envConfig';
import { SessionManager, verifySignedSessionToken } from './security';

test('deferred empty env variables resolve safely without fabricating fake values', () => {
  const keys = [
    'SESSION_SECRET',
    'PUBLIC_BASE_URL',
    'TCP_LISTEN_PORT',
    'TCP_PUBLIC_HOST',
    'TCP_PUBLIC_PORT',
    'SALES_DEFAULT_PROTOCOL',
    'SALES_DEFAULT_PORT',
  ] as const;
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) {
    saved[k] = process.env[k];
    process.env[k] = '';
  }
  try {
    const cfg = resolveRuntimeConfig();
    assert.equal(cfg.sessionSecret.fromEnv, false);
    assert.ok(cfg.sessionSecret.secret.length >= 64);
    assert.equal(cfg.publicBaseUrl.value, null);
    assert.equal(cfg.tcpListenPort.value, null);
    assert.equal(cfg.tcpPublicHost.value, null);
    assert.equal(cfg.tcpPublicPort.value, null);
    assert.equal(cfg.salesDefaultProtocol.value, null);
    assert.equal(cfg.salesDefaultPort.value, null);

    const status = buildConfigStatusList();
    const byKey = Object.fromEntries(status.map((i) => [i.key, i]));
    assert.equal(byKey.SESSION_SECRET.state, 'fallback');
    assert.equal(byKey.PUBLIC_BASE_URL.state, 'not_configured');
    assert.equal(byKey.TCP_LISTEN_PORT.state, 'not_configured');
    assert.equal(byKey.TCP_PUBLIC_HOST.state, 'not_configured');
    assert.equal(byKey.TCP_PUBLIC_PORT.state, 'not_configured');
    assert.equal(byKey.SALES_DEFAULT_PROTOCOL.state, 'not_configured');
    assert.equal(byKey.SALES_DEFAULT_PORT.state, 'not_configured');
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test('SessionManager issues HMAC-signed tokens and rejects tampered signatures', () => {
  const sm = new SessionManager();
  const s = sm.create('owner', 'admin', 'owner');
  assert.equal(verifySignedSessionToken(s.token), true);
  assert.ok(sm.get(s.token));
  assert.equal(verifySignedSessionToken(`${s.token}tampered`), false);
  assert.equal(sm.get(`${s.token}tampered`), null);
});

