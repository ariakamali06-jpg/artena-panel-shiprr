import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildServiceUri,
  buildSubscriptionHeaders,
  formatBytes,
  generateRealityKeypair,
  isManualComboLive,
  parseSizeToBytes,
  parseSpeedToBytes,
} from './uriBuilder';
import type { ServiceRecord } from '../types';

function mockService(overrides: Partial<ServiceRecord> = {}): ServiceRecord {
  return {
    id: '11111111-2222-3333-4444-555555555555',
    label: 'Frankfurt-Edge',
    active: true,
    limitBytes: 50 * 1024 ** 3,
    usedBytes: 5 * 1024 ** 3,
    createdAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2027-01-01T00:00:00.000Z',
    note: '',
    isDefault: false,
    subId: null,
    parentInboundId: null,
    protocol: 'vless-ws',
    fingerprint: 'chrome',
    alpn: 'http/1.1',
    port: 443,
    ipLimit: 2,
    speedLimitBytes: 0,
    connectionLimit: 0,
    fragment: 'off',
    cleanIps: [],
    alarmEnabled: false,
    categoryId: 'general',
    outboundProxyId: '',
    usageHistory: [],
    ...overrides,
  };
}

test('buildServiceUri generates valid VLESS-WS TLS URI', () => {
  const uri = buildServiceUri(mockService(), 'edge.example.com');
  assert.ok(uri.startsWith('vless://11111111-2222-3333-4444-555555555555@edge.example.com:443?'));
  assert.ok(uri.includes('type=ws'));
  assert.ok(uri.includes('security=tls'));
  assert.ok(uri.includes('path=/ws/11111111-2222-3333-4444-555555555555'));
  assert.ok(uri.endsWith('#Frankfurt-Edge'));
});

test('buildServiceUri generates valid XHTTP packet-up URI', () => {
  const uri = buildServiceUri(mockService({ protocol: 'xhttp-packet-up', alpn: 'h2,http/1.1' }), 'edge.example.com');
  assert.ok(uri.includes('type=xhttp'));
  assert.ok(uri.includes('mode=packet-up'));
  assert.ok(uri.includes('path=/xhttp/packet-up/11111111-2222-3333-4444-555555555555'));
});

test('buildServiceUri generates valid Manual Reality & Shadowsocks URIs', () => {
  const kp = generateRealityKeypair();
  assert.ok(kp.publicKey.length >= 40);
  assert.ok(kp.privateKey.length >= 40);
  assert.equal(kp.shortId.length, 8);

  const realityUri = buildServiceUri(
    mockService({
      protocol: 'manual',
      manual: {
        baseProtocol: 'vless',
        network: 'tcp',
        security: 'reality',
        address: 'node.example.com',
        path: '',
        hostHeader: '',
        sni: 'www.cloudflare.com',
        flow: 'xtls-rprx-vision',
        grpcServiceName: '',
        grpcMode: 'gun',
        xhttpMode: 'packet-up',
        headerType: '',
        allowInsecure: false,
        realityPublicKey: kp.publicKey,
        realityShortId: kp.shortId,
        realitySpiderX: '/',
        ssMethod: 'chacha20-ietf-poly1305',
        ssPassword: '',
      },
    }),
    'edge.example.com'
  );
  assert.ok(realityUri.includes('security=reality'));
  assert.ok(realityUri.includes(`pbk=${kp.publicKey}`));
  assert.ok(realityUri.includes('flow=xtls-rprx-vision'));
  assert.equal(isManualComboLive({ baseProtocol: 'vless', network: 'tcp', security: 'reality' }), false);
  assert.equal(isManualComboLive({ baseProtocol: 'vless', network: 'ws', security: 'tls' }), true);

  const ssUri = buildServiceUri(
    mockService({
      protocol: 'manual',
      port: 8388,
      manual: {
        baseProtocol: 'shadowsocks',
        network: 'tcp',
        security: 'none',
        address: 'ss.example.com',
        path: '',
        hostHeader: '',
        sni: '',
        flow: '',
        grpcServiceName: '',
        grpcMode: 'gun',
        xhttpMode: 'packet-up',
        headerType: '',
        allowInsecure: false,
        realityPublicKey: '',
        realityShortId: '',
        realitySpiderX: '/',
        ssMethod: 'aes-256-gcm',
        ssPassword: 'secret-password',
      },
    }),
    'edge.example.com'
  );
  assert.ok(ssUri.startsWith('ss://'));
  assert.ok(ssUri.includes('@ss.example.com:8388#'));
});

test('subscription headers and byte/speed formatters compute accurately', () => {
  assert.equal(parseSizeToBytes(2, 'GB'), 2 * 1024 ** 3);
  assert.equal(parseSpeedToBytes(80, 'Mbps'), 10 * 1024 * 1024);
  assert.equal(formatBytes(1024 * 1024), '1.00 MB');

  const hdrs = buildSubscriptionHeaders({
    usedBytes: 1000,
    limitBytes: 5000,
    expiresAt: '2027-01-01T00:00:00.000Z',
    title: 'My Bundle',
    infoUrl: 'https://panel.example.com/subscription/abc',
  });
  assert.ok(hdrs['Subscription-Userinfo'].includes('download=1000; total=5000;'));
  assert.ok(hdrs['Profile-Title'].startsWith('base64:'));
});
