import crypto from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import path from 'node:path';
import type { OutboundProxyRecord, ServiceRecord } from '../types';
import { atomicWriteJson, readJsonFile, stateStore } from '../store/stateStore';
import { isPrivateOrBlockedIp } from './security';

export interface ParsedProxyCandidate {
  scheme: 'socks5' | 'socks4' | 'http';
  host: string;
  port: number;
  username: string;
  password: string;
  raw: string;
}

export interface ProxyProbeResult {
  candidate: ParsedProxyCandidate;
  ok: boolean;
  latencyMs: number | null;
  tlsOk: boolean;
  speedKbps: number | null;
  score: number;
  grade: string;
  error: string;
  testedAt: string;
}

export interface ScanJob {
  id: string;
  mode: 'list' | 'saved';
  status: 'running' | 'completed' | 'cancelled';
  total: number;
  done: number;
  passed: number;
  createdAt: string;
  finishedAt?: string;
  cancelled: boolean;
  results: ProxyProbeResult[];
}

/**
 * Parses proxy candidate strings in formats:
 * - socks5://user:pass@host:port
 * - socks4://host:port
 * - http://user:pass@host:port
 * - host:port
 * - host:port:user:pass
 */
export function parseProxyLine(
  line: string,
  defaultScheme: 'socks5' | 'socks4' | 'http' = 'socks5'
): ParsedProxyCandidate | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;

  if (trimmed.includes('://')) {
    try {
      const u = new URL(trimmed);
      const rawScheme = u.protocol.replace(':', '').toLowerCase();
      const scheme: 'socks5' | 'socks4' | 'http' =
        rawScheme === 'socks4' || rawScheme === 'socks4a'
          ? 'socks4'
          : rawScheme === 'http' || rawScheme === 'https'
            ? 'http'
            : 'socks5';
      const port = Number(u.port);
      if (!u.hostname || !Number.isInteger(port) || port < 1 || port > 65535) return null;
      return {
        scheme,
        host: u.hostname,
        port,
        username: decodeURIComponent(u.username || ''),
        password: decodeURIComponent(u.password || ''),
        raw: trimmed,
      };
    } catch {
      return null;
    }
  }

  const parts = trimmed.split(':');
  if (parts.length === 2 || parts.length === 4) {
    const host = parts[0].trim();
    const port = Number(parts[1]);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    return {
      scheme: defaultScheme,
      host,
      port,
      username: parts[2] || '',
      password: parts[3] || '',
      raw: trimmed,
    };
  }
  return null;
}

export function scoreProxyProbe(result: {
  ok: boolean;
  latencyMs: number | null;
  tlsOk: boolean;
  speedKbps: number | null;
}): { score: number; grade: string } {
  if (!result.ok) return { score: 0, grade: 'F' };
  let score = 45;
  if (result.latencyMs !== null) {
    if (result.latencyMs < 120) score += 30;
    else if (result.latencyMs < 250) score += 22;
    else if (result.latencyMs < 500) score += 14;
    else if (result.latencyMs < 1000) score += 6;
  }
  if (result.tlsOk) score += 15;
  if (result.speedKbps !== null && result.speedKbps > 0) {
    if (result.speedKbps >= 5000) score += 10;
    else if (result.speedKbps >= 1000) score += 6;
    else score += 2;
  }
  score = Math.max(0, Math.min(100, score));
  const grade = score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 55 ? 'C' : score >= 40 ? 'D' : 'F';
  return { score, grade };
}

function readExact(socket: net.Socket, length: number, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Proxy handshake timeout'));
    }, timeoutMs);

    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      total += chunk.length;
      if (total >= length) {
        const combined = Buffer.concat(chunks);
        const exact = combined.subarray(0, length);
        const extra = combined.subarray(length);
        cleanup();
        if (extra.length > 0) socket.unshift(extra);
        resolve(exact);
      }
    };
    const onErr = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('Proxy closed connection during handshake'));
    };

    const cleanup = () => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onErr);
      socket.off('close', onClose);
    };

    socket.on('data', onData);
    socket.on('error', onErr);
    socket.on('close', onClose);
  });
}

function readUntilDoubleCrlf(socket: net.Socket, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('HTTP CONNECT timeout'));
    }, timeoutMs);

    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx !== -1) {
        const header = buf.subarray(0, idx).toString('utf8');
        const extra = buf.subarray(idx + 4);
        cleanup();
        if (extra.length > 0) socket.unshift(extra);
        resolve(header);
      } else if (buf.length > 8192) {
        cleanup();
        reject(new Error('HTTP proxy response header too large'));
      }
    };
    const onErr = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('HTTP proxy closed before response'));
    };

    const cleanup = () => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onErr);
      socket.off('close', onClose);
    };

    socket.on('data', onData);
    socket.on('error', onErr);
    socket.on('close', onClose);
  });
}

/**
 * Establishes a real TCP tunnel through a SOCKS5, SOCKS4, or HTTP CONNECT proxy.
 */
export async function connectViaProxy(
  proxy: Pick<OutboundProxyRecord, 'scheme' | 'host' | 'port' | 'username' | 'password'>,
  targetHost: string,
  targetPort: number,
  timeoutMs = 8000
): Promise<net.Socket> {
  if (isPrivateOrBlockedIp(proxy.host)) {
    throw new Error('Outbound proxy host points to a private/loopback address');
  }

  const socket = await new Promise<net.Socket>((resolve, reject) => {
    const s = net.connect({ host: proxy.host, port: proxy.port });
    const timer = setTimeout(() => {
      s.destroy();
      reject(new Error('Proxy TCP connect timeout'));
    }, timeoutMs);
    s.once('connect', () => {
      clearTimeout(timer);
      s.setNoDelay(true);
      resolve(s);
    });
    s.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  try {
    if (proxy.scheme === 'http') {
      const authHeader = proxy.username
        ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}\r\n`
        : '';
      socket.write(
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n${authHeader}\r\n`
      );
      const header = await readUntilDoubleCrlf(socket, timeoutMs);
      if (!/^HTTP\/1\.[01]\s+200\b/i.test(header)) {
        throw new Error(`HTTP proxy rejected CONNECT: ${header.split('\r\n')[0]}`);
      }
      return socket;
    }

    if (proxy.scheme === 'socks4') {
      const hostBytes = Buffer.from(targetHost, 'utf8');
      const userBytes = Buffer.from(proxy.username || '', 'utf8');
      const isV4 = net.isIPv4(targetHost);
      const ipBuf = isV4
        ? Buffer.from(targetHost.split('.').map(Number))
        : Buffer.from([0, 0, 0, 1]);
      const req = Buffer.concat([
        Buffer.from([0x04, 0x01, (targetPort >> 8) & 0xff, targetPort & 0xff]),
        ipBuf,
        userBytes,
        Buffer.from([0x00]),
        isV4 ? Buffer.alloc(0) : Buffer.concat([hostBytes, Buffer.from([0x00])]),
      ]);
      socket.write(req);
      const resp = await readExact(socket, 8, timeoutMs);
      if (resp[1] !== 0x5a) {
        throw new Error(`SOCKS4 connect rejected (code 0x${resp[1].toString(16)})`);
      }
      return socket;
    }

    // SOCKS5 (RFC 1928 + RFC 1929 username/password auth)
    const hasAuth = Boolean(proxy.username);
    socket.write(hasAuth ? Buffer.from([0x05, 0x02, 0x00, 0x02]) : Buffer.from([0x05, 0x01, 0x00]));
    const greeting = await readExact(socket, 2, timeoutMs);
    if (greeting[0] !== 0x05) throw new Error('Invalid SOCKS5 greeting');

    if (greeting[1] === 0x02) {
      const uBuf = Buffer.from(proxy.username || '', 'utf8');
      const pBuf = Buffer.from(proxy.password || '', 'utf8');
      socket.write(Buffer.concat([Buffer.from([0x01, uBuf.length]), uBuf, Buffer.from([pBuf.length]), pBuf]));
      const authResp = await readExact(socket, 2, timeoutMs);
      if (authResp[1] !== 0x00) throw new Error('SOCKS5 authentication failed');
    } else if (greeting[1] !== 0x00) {
      throw new Error(`Unsupported SOCKS5 auth method: ${greeting[1]}`);
    }

    let addrPart: Buffer;
    if (net.isIPv4(targetHost)) {
      addrPart = Buffer.concat([Buffer.from([0x01]), Buffer.from(targetHost.split('.').map(Number))]);
    } else {
      const dBuf = Buffer.from(targetHost, 'utf8');
      addrPart = Buffer.concat([Buffer.from([0x03, dBuf.length]), dBuf]);
    }
    const portBuf = Buffer.alloc(2);
    portBuf.writeUInt16BE(targetPort, 0);
    socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), addrPart, portBuf]));

    const head = await readExact(socket, 4, timeoutMs);
    if (head[1] !== 0x00) {
      throw new Error(`SOCKS5 target connect failed (reply 0x${head[1].toString(16)})`);
    }
    if (head[3] === 0x01) {
      await readExact(socket, 6, timeoutMs);
    } else if (head[3] === 0x03) {
      const lenBuf = await readExact(socket, 1, timeoutMs);
      await readExact(socket, lenBuf[0] + 2, timeoutMs);
    } else if (head[3] === 0x04) {
      await readExact(socket, 18, timeoutMs);
    }
    return socket;
  } catch (err) {
    socket.destroy();
    throw err;
  }
}

export async function tcpPingHost(host: string, port: number, timeoutMs = 4000): Promise<{ ok: boolean; latencyMs: number | null; error?: string }> {
  if (isPrivateOrBlockedIp(host)) {
    return { ok: false, latencyMs: null, error: 'Private/loopback hosts are blocked' };
  }
  const start = performance.now();
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const timer = setTimeout(() => {
      s.destroy();
      resolve({ ok: false, latencyMs: null, error: 'Connection timed out' });
    }, timeoutMs);
    s.once('connect', () => {
      clearTimeout(timer);
      const latencyMs = Math.round(performance.now() - start);
      s.destroy();
      resolve({ ok: true, latencyMs });
    });
    s.once('error', (err) => {
      clearTimeout(timer);
      s.destroy();
      resolve({ ok: false, latencyMs: null, error: err.message });
    });
  });
}

class OutboundProxyManager {
  private readonly filePath: string;
  public proxies = new Map<string, OutboundProxyRecord>();
  public scanJobs = new Map<string, ScanJob>();

  constructor() {
    this.filePath = path.join(stateStore.dataDir, 'kestrel_proxies.json');
    this.load();
  }

  private load(): void {
    const data = readJsonFile<Record<string, OutboundProxyRecord>>(this.filePath, {});
    this.proxies.clear();
    for (const [id, rec] of Object.entries(data)) {
      this.proxies.set(id, rec);
    }
  }

  private save(): void {
    const obj: Record<string, OutboundProxyRecord> = {};
    for (const [id, rec] of this.proxies.entries()) obj[id] = rec;
    atomicWriteJson(this.filePath, obj);
  }

  public list(): Array<Omit<OutboundProxyRecord, 'password'> & { hasPassword: boolean; usageCount: number }> {
    const counts = new Map<string, number>();
    for (const svc of Object.values(stateStore.state.services)) {
      if (svc.outboundProxyId) {
        counts.set(svc.outboundProxyId, (counts.get(svc.outboundProxyId) || 0) + 1);
      }
    }
    return Array.from(this.proxies.values())
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((p) => {
        const { password, ...rest } = p;
        return {
          ...rest,
          hasPassword: Boolean(password),
          usageCount: counts.get(p.id) || 0,
        };
      });
  }

  public get(id: string): OutboundProxyRecord | undefined {
    return this.proxies.get(id);
  }

  public upsert(input: {
    id?: string;
    name?: string;
    scheme?: 'socks5' | 'socks4' | 'http';
    host: string;
    port: number;
    username?: string;
    password?: string;
    enabled?: boolean;
    countryCode?: string;
    country?: string;
  }): OutboundProxyRecord {
    const existing = input.id ? this.proxies.get(input.id) : undefined;
    const id = existing?.id || crypto.randomBytes(6).toString('hex');
    const host = input.host.trim();
    const port = Math.max(1, Math.min(65535, Number(input.port)));
    if (!host || isPrivateOrBlockedIp(host)) {
      throw new Error('Proxy host must be a valid public hostname or IP');
    }

    const record: OutboundProxyRecord = {
      id,
      name: (input.name || existing?.name || `${host}:${port}`).trim().slice(0, 64),
      scheme: input.scheme || existing?.scheme || 'socks5',
      host,
      port,
      username: input.username !== undefined ? input.username.trim() : existing?.username || '',
      password:
        input.password !== undefined && input.password !== ''
          ? input.password
          : existing?.password || '',
      enabled: input.enabled !== undefined ? Boolean(input.enabled) : existing?.enabled ?? true,
      createdAt: existing?.createdAt || new Date().toISOString(),
      countryCode: input.countryCode ?? existing?.countryCode,
      country: input.country ?? existing?.country,
      lastTest: existing?.lastTest,
    };

    this.proxies.set(id, record);
    this.save();
    stateStore.logActivity('network', `${existing ? 'Updated' : 'Added'} outbound proxy "${record.name}"`, 'ok');
    return record;
  }

  public delete(id: string): boolean {
    const existing = this.proxies.get(id);
    if (!existing) return false;
    this.proxies.delete(id);
    this.save();
    for (const svc of Object.values(stateStore.state.services)) {
      if (svc.outboundProxyId === id) svc.outboundProxyId = '';
    }
    stateStore.saveNow();
    stateStore.logActivity('network', `Deleted outbound proxy "${existing.name}"`, 'warn');
    return true;
  }

  /**
   * Opens a TCP connection directly or through the service's configured outbound proxy.
   */
  public async openTargetConnection(
    service: ServiceRecord | undefined | null,
    targetHost: string,
    targetPort: number,
    timeoutMs = 10000
  ): Promise<net.Socket> {
    if (isPrivateOrBlockedIp(targetHost)) {
      throw new Error('Blocked relay destination (private/loopback/metadata IP)');
    }

    const proxyId = service?.outboundProxyId;
    if (proxyId) {
      const proxy = this.proxies.get(proxyId);
      if (proxy && proxy.enabled) {
        return connectViaProxy(proxy, targetHost, targetPort, timeoutMs);
      }
    }

    return new Promise<net.Socket>((resolve, reject) => {
      const s = net.connect({ host: targetHost, port: targetPort });
      const timer = setTimeout(() => {
        s.destroy();
        reject(new Error('Target TCP connect timeout'));
      }, timeoutMs);
      s.once('connect', () => {
        clearTimeout(timer);
        s.setNoDelay(true);
        resolve(s);
      });
      s.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  public async probeCandidate(
    candidate: ParsedProxyCandidate,
    options?: { checkTls?: boolean; timeoutMs?: number }
  ): Promise<ProxyProbeResult> {
    const timeoutMs = options?.timeoutMs ?? 5000;
    const testedAt = new Date().toISOString();

    if (isPrivateOrBlockedIp(candidate.host)) {
      return {
        candidate,
        ok: false,
        latencyMs: null,
        tlsOk: false,
        speedKbps: null,
        score: 0,
        grade: 'F',
        error: 'Private/loopback host blocked',
        testedAt,
      };
    }

    const start = performance.now();
    try {
      const tunnel = await connectViaProxy(candidate, '1.1.1.1', 443, timeoutMs);
      const latencyMs = Math.round(performance.now() - start);
      let tlsOk = false;

      if (options?.checkTls !== false) {
        tlsOk = await new Promise<boolean>((resolve) => {
          const tlsSock = tls.connect({
            socket: tunnel,
            servername: 'cloudflare-dns.com',
            timeout: timeoutMs,
          });
          const timer = setTimeout(() => {
            tlsSock.destroy();
            resolve(false);
          }, timeoutMs);
          tlsSock.once('secureConnect', () => {
            clearTimeout(timer);
            tlsSock.destroy();
            resolve(true);
          });
          tlsSock.once('error', () => {
            clearTimeout(timer);
            tlsSock.destroy();
            resolve(false);
          });
        });
      } else {
        tunnel.destroy();
      }

      const { score, grade } = scoreProxyProbe({ ok: true, latencyMs, tlsOk, speedKbps: null });
      return {
        candidate,
        ok: true,
        latencyMs,
        tlsOk,
        speedKbps: null,
        score,
        grade,
        error: '',
        testedAt,
      };
    } catch (err) {
      return {
        candidate,
        ok: false,
        latencyMs: null,
        tlsOk: false,
        speedKbps: null,
        score: 0,
        grade: 'F',
        error: err instanceof Error ? err.message : String(err),
        testedAt,
      };
    }
  }

  public async testSavedProxy(id: string): Promise<OutboundProxyRecord | null> {
    const proxy = this.proxies.get(id);
    if (!proxy) return null;
    const res = await this.probeCandidate(
      {
        scheme: proxy.scheme,
        host: proxy.host,
        port: proxy.port,
        username: proxy.username,
        password: proxy.password,
        raw: `${proxy.scheme}://${proxy.host}:${proxy.port}`,
      },
      { checkTls: true }
    );
    proxy.lastTest = {
      ok: res.ok,
      latencyMs: res.latencyMs,
      tlsOk: res.tlsOk,
      speedKbps: res.speedKbps,
      score: res.score,
      grade: res.grade,
      error: res.error,
      testedAt: res.testedAt,
    };
    this.save();
    return proxy;
  }

  public startScanJob(
    mode: 'list' | 'saved',
    candidates: ParsedProxyCandidate[],
    options?: { concurrency?: number; checkTls?: boolean; timeoutMs?: number }
  ): ScanJob {
    // Keep only recent 20 jobs
    if (this.scanJobs.size > 20) {
      const oldest = this.scanJobs.keys().next().value;
      if (oldest) this.scanJobs.delete(oldest);
    }

    const job: ScanJob = {
      id: crypto.randomBytes(6).toString('hex'),
      mode,
      status: 'running',
      total: candidates.length,
      done: 0,
      passed: 0,
      createdAt: new Date().toISOString(),
      cancelled: false,
      results: [],
    };
    this.scanJobs.set(job.id, job);

    const concurrency = Math.max(1, Math.min(20, options?.concurrency ?? 8));
    let cursor = 0;

    const worker = async () => {
      while (!job.cancelled && cursor < candidates.length) {
        const idx = cursor++;
        const cand = candidates[idx];
        const res = await this.probeCandidate(cand, {
          checkTls: options?.checkTls ?? true,
          timeoutMs: options?.timeoutMs ?? 4500,
        });
        job.results.push(res);
        job.done += 1;
        if (res.ok) job.passed += 1;
      }
    };

    void Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, candidates.length)) }, worker)).then(() => {
      job.status = job.cancelled ? 'cancelled' : 'completed';
      job.finishedAt = new Date().toISOString();
    });

    return job;
  }
}

export const outboundProxyManager = new OutboundProxyManager();
