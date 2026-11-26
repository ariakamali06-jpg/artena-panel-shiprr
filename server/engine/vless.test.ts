import test from 'node:test';
import assert from 'node:assert/strict';
import { formatUuidBytes, parseVlessHeader } from './vless';

function buildVlessPacket(opts: {
  uuidHex: string;
  addon?: Buffer;
  command?: number;
  port: number;
  addrType: 1 | 2 | 3;
  addrBytes: Buffer;
  payload?: Buffer;
}): Buffer {
  const version = Buffer.from([0x00]);
  const uuid = Buffer.from(opts.uuidHex.replace(/-/g, ''), 'hex');
  const addon = opts.addon ?? Buffer.alloc(0);
  const addonLen = Buffer.from([addon.length]);
  const cmd = Buffer.from([opts.command ?? 1]);
  const port = Buffer.alloc(2);
  port.writeUInt16BE(opts.port, 0);
  const addrType = Buffer.from([opts.addrType]);
  return Buffer.concat([version, uuid, addonLen, addon, cmd, port, addrType, opts.addrBytes, opts.payload ?? Buffer.alloc(0)]);
}

test('formatUuidBytes converts 16 bytes to canonical hyphenated UUID', () => {
  const raw = Buffer.from('1234567890abcdef1234567890abcdef', 'hex');
  assert.equal(formatUuidBytes(raw), '12345678-90ab-cdef-1234-567890abcdef');
});

test('parseVlessHeader parses IPv4 target and preserves payload', () => {
  const pkt = buildVlessPacket({
    uuidHex: '11111111-2222-3333-4444-555555555555',
    port: 443,
    addrType: 1,
    addrBytes: Buffer.from([1, 1, 1, 1]),
    payload: Buffer.from('hello-vless'),
  });
  const parsed = parseVlessHeader(pkt);
  assert.equal(parsed.version, 0);
  assert.equal(parsed.uuid, '11111111-2222-3333-4444-555555555555');
  assert.equal(parsed.command, 1);
  assert.equal(parsed.address, '1.1.1.1');
  assert.equal(parsed.port, 443);
  assert.equal(parsed.payload.toString('utf8'), 'hello-vless');
});

test('parseVlessHeader parses domain name with addons', () => {
  const domain = Buffer.from('example.com', 'utf8');
  const pkt = buildVlessPacket({
    uuidHex: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    addon: Buffer.from([0x01, 0x02, 0x03]),
    port: 8443,
    addrType: 2,
    addrBytes: Buffer.concat([Buffer.from([domain.length]), domain]),
    payload: Buffer.from('GET / HTTP/1.1'),
  });
  const parsed = parseVlessHeader(pkt);
  assert.equal(parsed.address, 'example.com');
  assert.equal(parsed.port, 8443);
  assert.equal(parsed.payload.toString('utf8'), 'GET / HTTP/1.1');
});

test('parseVlessHeader parses IPv6 address', () => {
  const ipv6 = Buffer.from('26064700470000000000000000001111', 'hex');
  const pkt = buildVlessPacket({
    uuidHex: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    port: 443,
    addrType: 3,
    addrBytes: ipv6,
  });
  const parsed = parseVlessHeader(pkt);
  assert.equal(parsed.address, '2606:4700:4700:0:0:0:0:1111');
  assert.equal(parsed.port, 443);
});

test('parseVlessHeader rejects truncated buffers', () => {
  assert.throws(() => parseVlessHeader(Buffer.alloc(10)), /truncated/i);
});
