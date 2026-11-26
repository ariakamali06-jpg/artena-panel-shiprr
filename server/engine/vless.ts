export interface ParsedVlessHeader {
  version: number;
  uuid: string;
  command: number; // 1 = TCP, 2 = UDP, 3 = MUX
  addressType: number; // 1 = IPv4, 2 = Domain, 3 = IPv6
  address: string;
  port: number;
  payload: Buffer;
}

/**
 * Formats a 16-byte buffer as a canonical lowercase hyphenated UUID string.
 */
export function formatUuidBytes(buf: Buffer): string {
  if (buf.length !== 16) {
    throw new Error('UUID buffer must be 16 bytes');
  }
  const hex = buf.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/**
 * Parses a binary VLESS protocol v0 request header according to the Xray VLESS specification:
 * [1B version][16B UUID][1B addonLen][addonLen B addons][1B command][2B port BE][1B addrType][addr][payload...]
 */
export function parseVlessHeader(chunk: Buffer): ParsedVlessHeader {
  if (!Buffer.isBuffer(chunk) || chunk.length < 24) {
    throw new Error('VLESS header truncated: minimum 24 bytes required');
  }

  const version = chunk[0];
  let offset = 1;

  const uuid = formatUuidBytes(chunk.subarray(offset, offset + 16));
  offset += 16;

  const addonLength = chunk[offset];
  offset += 1 + addonLength;

  if (offset + 4 > chunk.length) {
    throw new Error('VLESS header truncated before command/port/address');
  }

  const command = chunk[offset];
  offset += 1;

  const port = chunk.readUInt16BE(offset);
  offset += 2;

  const addressType = chunk[offset];
  offset += 1;

  let address = '';
  if (addressType === 1) {
    // IPv4 (4 bytes)
    if (offset + 4 > chunk.length) {
      throw new Error('VLESS header truncated inside IPv4 address');
    }
    address = `${chunk[offset]}.${chunk[offset + 1]}.${chunk[offset + 2]}.${chunk[offset + 3]}`;
    offset += 4;
  } else if (addressType === 2) {
    // Domain (1B length + UTF-8 hostname)
    if (offset + 1 > chunk.length) {
      throw new Error('VLESS header truncated before domain length');
    }
    const domainLen = chunk[offset];
    offset += 1;
    if (offset + domainLen > chunk.length) {
      throw new Error('VLESS header truncated inside domain name');
    }
    address = chunk.subarray(offset, offset + domainLen).toString('utf8');
    offset += domainLen;
  } else if (addressType === 3) {
    // IPv6 (16 bytes)
    if (offset + 16 > chunk.length) {
      throw new Error('VLESS header truncated inside IPv6 address');
    }
    const groups: string[] = [];
    for (let i = 0; i < 16; i += 2) {
      groups.push(chunk.readUInt16BE(offset + i).toString(16));
    }
    address = groups.join(':');
    offset += 16;
  } else {
    throw new Error(`Unsupported VLESS address type: ${addressType}`);
  }

  return {
    version,
    uuid,
    command,
    addressType,
    address,
    port,
    payload: chunk.subarray(offset),
  };
}

/**
 * Standard VLESS v0 downlink response prefix: version (0x00) + addon length (0x00).
 */
export const VLESS_RESPONSE_PREFIX = Buffer.from([0x00, 0x00]);
