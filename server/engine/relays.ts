import crypto from 'node:crypto';
import type http from 'node:http';
import net from 'node:net';
import express, { type Request, type Response } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { parseVlessHeader, VLESS_RESPONSE_PREFIX } from './vless';
import { evaluateIpAndConnectionLimit, isServiceAllowed, speedLimiter } from './rateLimiter';
import { outboundProxyManager } from './outboundProxy';
import { stateStore } from '../store/stateStore';
import { validateExternalHttpUrl } from './security';

const HIGH_WATER_MARK = 256 * 1024;
const XHTTP_IDLE_MS = 60_000;

function extractClientIp(headers: http.IncomingHttpHeaders, remoteAddress?: string): string {
  const fwd = headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.trim()) return fwd.split(',')[0].trim();
  const real = headers['x-real-ip'];
  if (typeof real === 'string' && real.trim()) return real.trim();
  return remoteAddress || 'unknown';
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. VLESS over WebSocket Relay (/ws/:uuid and /vless/:uuid)
// ═══════════════════════════════════════════════════════════════════════════

export function attachWebSocketRelay(server: http.Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    const pathname = (req.url || '').split('?')[0];
    const match = pathname.match(/^\/(?:ws|vless)\/([0-9a-fA-F-]{32,36})\/?$/);
    if (!match) {
      // Leave non-relay upgrades untouched
      return;
    }
    const uuid = match[1];
    wss.handleUpgrade(req, socket, head, (ws) => {
      void handleWsTunnel(ws, req, uuid);
    });
  });

  return wss;
}

async function handleWsTunnel(ws: WebSocket, req: http.IncomingMessage, uuid: string): Promise<void> {
  const service = stateStore.state.services[uuid];
  if (!isServiceAllowed(service)) {
    ws.close(1008, 'Unauthorized or quota/expiry exceeded');
    return;
  }

  const ip = extractClientIp(req.headers, req.socket.remoteAddress);
  const limitCheck = evaluateIpAndConnectionLimit(service, ip, stateStore.connections.values());
  if (!limitCheck.allowed) {
    stateStore.logActivity('connection', `WS connection from ${ip} blocked for "${service.label}" (${limitCheck.reason})`, 'warn');
    ws.close(1008, limitCheck.reason || 'Limit reached');
    return;
  }

  const connId = crypto.randomBytes(5).toString('hex');
  let targetSocket: net.Socket | null = null;
  let initialized = false;
  let firstDownlink = true;
  let closed = false;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (targetSocket && !targetSocket.destroyed) targetSocket.destroy();
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
    stateStore.connections.delete(connId);
  };

  stateStore.connections.set(connId, {
    connId,
    serviceId: uuid,
    label: service.label,
    ip,
    transport: 'vless-ws',
    connectedAt: new Date().toISOString(),
    bytes: 0,
    close: cleanup,
  });

  stateStore.logActivity('connection', `WS session opened from ${ip} on "${service.label}"`, 'info');

  const initTimer = setTimeout(() => {
    if (!initialized) {
      stateStore.logError('vless-ws', 'Initial VLESS header timeout');
      cleanup();
    }
  }, 15_000);

  ws.on('message', async (rawData) => {
    const chunk = Buffer.isBuffer(rawData)
      ? rawData
      : Array.isArray(rawData)
        ? Buffer.concat(rawData)
        : Buffer.from(rawData as ArrayBuffer);

    if (!chunk.length || closed) return;

    if (!stateStore.recordTraffic(uuid, chunk.length)) {
      ws.close(1008, 'Quota exceeded or disabled');
      cleanup();
      return;
    }

    const activeService = stateStore.state.services[uuid];
    if (activeService?.speedLimitBytes) {
      await speedLimiter.throttle(uuid, chunk.length, activeService.speedLimitBytes);
    }

    stateStore.state.stats.totalRequests += 1;
    const conn = stateStore.connections.get(connId);
    if (conn) conn.bytes += chunk.length;

    if (!initialized) {
      initialized = true;
      clearTimeout(initTimer);
      try {
        const parsed = parseVlessHeader(chunk);
        if (conn) conn.target = `${parsed.address}:${parsed.port}`;
        targetSocket = await outboundProxyManager.openTargetConnection(
          activeService,
          parsed.address,
          parsed.port,
          10_000
        );

        targetSocket.on('data', async (downChunk: Buffer) => {
          if (closed || ws.readyState !== WebSocket.OPEN) return;
          if (!stateStore.recordTraffic(uuid, downChunk.length)) {
            cleanup();
            return;
          }
          const svc = stateStore.state.services[uuid];
          if (svc?.speedLimitBytes) {
            targetSocket?.pause();
            await speedLimiter.throttle(uuid, downChunk.length, svc.speedLimitBytes);
            targetSocket?.resume();
          }
          const c = stateStore.connections.get(connId);
          if (c) c.bytes += downChunk.length;

          const frame = firstDownlink ? Buffer.concat([VLESS_RESPONSE_PREFIX, downChunk]) : downChunk;
          firstDownlink = false;
          ws.send(frame, (err) => {
            if (err) cleanup();
          });
        });

        targetSocket.on('error', (err) => {
          stateStore.logError('vless-ws', `Target error: ${err.message}`);
          cleanup();
        });
        targetSocket.on('close', cleanup);

        if (parsed.payload.length > 0) {
          targetSocket.write(parsed.payload);
        }
      } catch (err) {
        stateStore.logError('vless-ws', err instanceof Error ? err.message : String(err));
        cleanup();
      }
      return;
    }

    if (targetSocket && !targetSocket.destroyed) {
      targetSocket.write(chunk);
    }
  });

  ws.on('close', () => {
    clearTimeout(initTimer);
    cleanup();
  });
  ws.on('error', () => {
    clearTimeout(initTimer);
    cleanup();
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. VLESS over Raw TCP Relay (configurable port, default 6543)
// ═══════════════════════════════════════════════════════════════════════════

let tcpServer: net.Server | null = null;
let tcpListeningPort: number | null = null;
let tcpErrorReason: string | null = null;

export function getTcpRelayStatus(): {
  active: boolean;
  configured: boolean;
  port: number | null;
  reason?: string;
} {
  const raw = (process.env.TCP_LISTEN_PORT || '').trim();
  if (!raw) {
    return {
      active: false,
      configured: false,
      port: null,
      reason: 'TCP_LISTEN_PORT is not configured. Raw VLESS-TCP listener is paused.',
    };
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    return {
      active: false,
      configured: false,
      port: null,
      reason: `TCP_LISTEN_PORT "${raw}" is invalid (expected integer 1-65535).`,
    };
  }
  return {
    active: Boolean(tcpServer && tcpServer.listening),
    configured: true,
    port: tcpListeningPort ?? parsed,
    reason: tcpErrorReason || undefined,
  };
}

export function startTcpRelay(): Promise<void> {
  const raw = (process.env.TCP_LISTEN_PORT || '').trim();
  if (!raw) {
    tcpServer = null;
    tcpListeningPort = null;
    tcpErrorReason = 'TCP_LISTEN_PORT is empty';
    return Promise.resolve();
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    tcpErrorReason = `Invalid TCP_LISTEN_PORT value: ${raw}`;
    stateStore.logError('vless-tcp', tcpErrorReason);
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const srv = net.createServer((clientSocket) => {
      void handleTcpClient(clientSocket);
    });
    srv.on('error', (err) => {
      tcpErrorReason = `Could not bind port ${port}: ${err.message}`;
      stateStore.logError('vless-tcp', tcpErrorReason);
      tcpServer = null;
      tcpListeningPort = null;
      resolve();
    });
    srv.listen(port, '0.0.0.0', () => {
      tcpServer = srv;
      tcpListeningPort = port;
      tcpErrorReason = null;
      stateStore.logActivity('network', `VLESS-TCP relay listening on 0.0.0.0:${port}`, 'ok');
      resolve();
    });
  });
}

export function stopTcpRelay(): Promise<void> {
  return new Promise((resolve) => {
    if (!tcpServer) return resolve();
    tcpServer.close(() => {
      tcpServer = null;
      tcpListeningPort = null;
      resolve();
    });
  });
}

async function handleTcpClient(clientSocket: net.Socket): Promise<void> {
  clientSocket.setNoDelay(true);
  const ip = clientSocket.remoteAddress || 'unknown';
  const connId = crypto.randomBytes(5).toString('hex');
  let targetSocket: net.Socket | null = null;
  let boundUuid: string | null = null;
  let firstDownlink = true;
  let closed = false;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (targetSocket && !targetSocket.destroyed) targetSocket.destroy();
    if (!clientSocket.destroyed) clientSocket.destroy();
    stateStore.connections.delete(connId);
  };

  const initTimer = setTimeout(() => {
    if (!boundUuid) cleanup();
  }, 15_000);

  clientSocket.on('data', async (chunk: Buffer) => {
    if (closed || !chunk.length) return;

    if (!boundUuid) {
      clearTimeout(initTimer);
      try {
        const parsed = parseVlessHeader(chunk);
        const service = stateStore.state.services[parsed.uuid];
        if (!isServiceAllowed(service)) {
          cleanup();
          return;
        }
        const limitCheck = evaluateIpAndConnectionLimit(service, ip, stateStore.connections.values());
        if (!limitCheck.allowed) {
          stateStore.logActivity('connection', `TCP connection from ${ip} blocked for "${service.label}"`, 'warn');
          cleanup();
          return;
        }
        boundUuid = parsed.uuid;
        stateStore.connections.set(connId, {
          connId,
          serviceId: parsed.uuid,
          label: service.label,
          ip,
          transport: 'vless-tcp',
          target: `${parsed.address}:${parsed.port}`,
          connectedAt: new Date().toISOString(),
          bytes: chunk.length,
          close: cleanup,
        });

        if (!stateStore.recordTraffic(parsed.uuid, chunk.length)) {
          cleanup();
          return;
        }
        stateStore.state.stats.totalRequests += 1;

        targetSocket = await outboundProxyManager.openTargetConnection(
          service,
          parsed.address,
          parsed.port,
          10_000
        );

        targetSocket.on('data', async (downChunk: Buffer) => {
          if (closed || !boundUuid) return;
          if (!stateStore.recordTraffic(boundUuid, downChunk.length)) {
            cleanup();
            return;
          }
          const svc = stateStore.state.services[boundUuid];
          if (svc?.speedLimitBytes) {
            targetSocket?.pause();
            await speedLimiter.throttle(boundUuid, downChunk.length, svc.speedLimitBytes);
            targetSocket?.resume();
          }
          const conn = stateStore.connections.get(connId);
          if (conn) conn.bytes += downChunk.length;
          const out = firstDownlink ? Buffer.concat([VLESS_RESPONSE_PREFIX, downChunk]) : downChunk;
          firstDownlink = false;
          if (!clientSocket.write(out) && targetSocket) {
            targetSocket.pause();
            clientSocket.once('drain', () => targetSocket?.resume());
          }
        });

        targetSocket.on('error', cleanup);
        targetSocket.on('close', cleanup);

        if (parsed.payload.length > 0) {
          targetSocket.write(parsed.payload);
        }
      } catch (err) {
        stateStore.logError('vless-tcp', err instanceof Error ? err.message : String(err));
        cleanup();
      }
      return;
    }

    if (!stateStore.recordTraffic(boundUuid, chunk.length)) {
      cleanup();
      return;
    }
    const svc = stateStore.state.services[boundUuid];
    if (svc?.speedLimitBytes) {
      clientSocket.pause();
      await speedLimiter.throttle(boundUuid, chunk.length, svc.speedLimitBytes);
      clientSocket.resume();
    }
    const conn = stateStore.connections.get(connId);
    if (conn) conn.bytes += chunk.length;
    if (targetSocket && !targetSocket.destroyed) {
      if (!targetSocket.write(chunk) && targetSocket.writableLength > HIGH_WATER_MARK) {
        clientSocket.pause();
        targetSocket.once('drain', () => clientSocket.resume());
      }
    }
  });

  clientSocket.on('error', cleanup);
  clientSocket.on('close', () => {
    clearTimeout(initTimer);
    cleanup();
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. XHTTP Relay (packet-up sequenced & stream-up continuous)
//    Mounted at both /xhttp/... and /xhttp-siz10/... for client compatibility
// ═══════════════════════════════════════════════════════════════════════════

interface XhttpSession {
  sessionId: string;
  serviceId: string;
  mode: 'packet-up' | 'stream-up';
  connId: string;
  targetSocket: net.Socket | null;
  downlinkRes: Response | null;
  pendingDownlink: Buffer[];
  seqBuf: Map<number, Buffer>;
  nextSeq: number;
  firstDownlink: boolean;
  lastSeen: number;
  closed: boolean;
}

const xhttpSessions = new Map<string, XhttpSession>();

const xhttpReaper = setInterval(() => {
  const now = Date.now();
  for (const [sid, sess] of xhttpSessions.entries()) {
    if (now - sess.lastSeen > XHTTP_IDLE_MS && !sess.targetSocket) {
      teardownXhttp(sid);
    }
  }
}, 20_000);
xhttpReaper.unref?.();

function teardownXhttp(sessionId: string): void {
  const sess = xhttpSessions.get(sessionId);
  if (!sess || sess.closed) return;
  sess.closed = true;
  if (sess.targetSocket && !sess.targetSocket.destroyed) sess.targetSocket.destroy();
  if (sess.downlinkRes && !sess.downlinkRes.writableEnded) {
    try {
      sess.downlinkRes.end();
    } catch {
      // Ignore already ended response
    }
  }
  stateStore.connections.delete(sess.connId);
  xhttpSessions.delete(sessionId);
}

function getOrCreateXhttpSession(
  uuid: string,
  mode: 'packet-up' | 'stream-up',
  sessionId: string,
  ip: string
): XhttpSession | { error: string; status: number } {
  const existing = xhttpSessions.get(sessionId);
  if (existing) {
    existing.lastSeen = Date.now();
    return existing;
  }

  const service = stateStore.state.services[uuid];
  if (!isServiceAllowed(service)) {
    return { error: 'Not authorized or quota exceeded', status: 403 };
  }

  const limitCheck = evaluateIpAndConnectionLimit(service, ip, stateStore.connections.values());
  if (!limitCheck.allowed) {
    return { error: limitCheck.reason || 'IP limit reached', status: 403 };
  }

  const connId = crypto.randomBytes(5).toString('hex');
  const session: XhttpSession = {
    sessionId,
    serviceId: uuid,
    mode,
    connId,
    targetSocket: null,
    downlinkRes: null,
    pendingDownlink: [],
    seqBuf: new Map(),
    nextSeq: 0,
    firstDownlink: true,
    lastSeen: Date.now(),
    closed: false,
  };

  xhttpSessions.set(sessionId, session);
  stateStore.connections.set(connId, {
    connId,
    serviceId: uuid,
    label: service.label,
    ip,
    transport: mode === 'stream-up' ? 'xhttp-stream-up' : 'xhttp-packet-up',
    connectedAt: new Date().toISOString(),
    bytes: 0,
    close: () => teardownXhttp(sessionId),
  });

  return session;
}

async function openXhttpUpstream(session: XhttpSession, firstChunk: Buffer): Promise<void> {
  const parsed = parseVlessHeader(firstChunk);
  const service = stateStore.state.services[session.serviceId];
  const conn = stateStore.connections.get(session.connId);
  if (conn) conn.target = `${parsed.address}:${parsed.port}`;

  const sock = await outboundProxyManager.openTargetConnection(service, parsed.address, parsed.port, 10_000);
  session.targetSocket = sock;

  sock.on('data', async (chunk: Buffer) => {
    if (session.closed) return;
    if (!stateStore.recordTraffic(session.serviceId, chunk.length)) {
      teardownXhttp(session.sessionId);
      return;
    }
    const svc = stateStore.state.services[session.serviceId];
    if (svc?.speedLimitBytes) {
      sock.pause();
      await speedLimiter.throttle(session.serviceId, chunk.length, svc.speedLimitBytes);
      sock.resume();
    }
    const c = stateStore.connections.get(session.connId);
    if (c) c.bytes += chunk.length;
    session.lastSeen = Date.now();

    const payload = session.firstDownlink ? Buffer.concat([VLESS_RESPONSE_PREFIX, chunk]) : chunk;
    session.firstDownlink = false;

    if (session.downlinkRes && !session.downlinkRes.writableEnded) {
      session.downlinkRes.write(payload);
    } else if (session.pendingDownlink.length < 256) {
      session.pendingDownlink.push(payload);
    }
  });

  sock.on('error', () => teardownXhttp(session.sessionId));
  sock.on('close', () => teardownXhttp(session.sessionId));

  if (parsed.payload.length > 0) {
    sock.write(parsed.payload);
  }
}

export function createRelayRouter(): express.Router {
  const router = express.Router();

  // XHTTP Downlink GET
  const handleDownlink = (req: Request, res: Response) => {
    const mode = req.params.mode;
    const uuid = req.params.uuid;
    const sessionId = req.params.sessionId;
    if (mode !== 'packet-up' && mode !== 'stream-up') {
      res.status(404).json({ error: 'Unknown XHTTP mode' });
      return;
    }
    const ip = extractClientIp(req.headers, req.socket.remoteAddress);
    const sessOrErr = getOrCreateXhttpSession(uuid, mode, sessionId, ip);
    if ('error' in sessOrErr) {
      res.status(sessOrErr.status).json({ error: sessOrErr.error });
      return;
    }
    const fp = String(req.query.fp || 'chrome').toLowerCase();
    res.setHeader('Content-Type', fp === 'plain' ? 'application/octet-stream' : 'application/grpc');
    res.setHeader('Cache-Control', 'no-cache, no-store');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    sessOrErr.downlinkRes = res;
    while (sessOrErr.pendingDownlink.length > 0) {
      const buf = sessOrErr.pendingDownlink.shift();
      if (buf) res.write(buf);
    }

    req.on('close', () => {
      teardownXhttp(sessionId);
    });
  };

  // XHTTP Packet-Up Uplink POST (sequenced chunks)
  const handlePacketUp = async (req: Request, res: Response) => {
    const { uuid, sessionId } = req.params;
    const seq = Number(req.params.seq);
    if (!Number.isInteger(seq) || seq < 0) {
      res.status(400).json({ error: 'Invalid sequence number' });
      return;
    }

    const ip = extractClientIp(req.headers, req.socket.remoteAddress);
    const sessOrErr = getOrCreateXhttpSession(uuid, 'packet-up', sessionId, ip);
    if ('error' in sessOrErr) {
      res.status(sessOrErr.status).json({ error: sessOrErr.error });
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks);
    if (!body.length) {
      res.json({ ok: true });
      return;
    }

    if (!stateStore.recordTraffic(uuid, body.length)) {
      teardownXhttp(sessionId);
      res.status(403).json({ error: 'Quota exceeded or disabled' });
      return;
    }
    const svc = stateStore.state.services[uuid];
    if (svc?.speedLimitBytes) {
      await speedLimiter.throttle(uuid, body.length, svc.speedLimitBytes);
    }
    stateStore.state.stats.totalRequests += 1;
    const conn = stateStore.connections.get(sessOrErr.connId);
    if (conn) conn.bytes += body.length;

    try {
      if (!sessOrErr.targetSocket) {
        if (seq !== 0) {
          sessOrErr.seqBuf.set(seq, body);
          res.json({ ok: true, buffered: true });
          return;
        }
        await openXhttpUpstream(sessOrErr, body);
        const openedSocket = sessOrErr.targetSocket as net.Socket | null;
        let next = 1;
        while (sessOrErr.seqBuf.has(next)) {
          const pending = sessOrErr.seqBuf.get(next)!;
          sessOrErr.seqBuf.delete(next);
          openedSocket?.write(pending);
          next += 1;
        }
        sessOrErr.nextSeq = next;
        res.json({ ok: true, connected: true });
        return;
      }

      if (seq === sessOrErr.nextSeq) {
        sessOrErr.targetSocket.write(body);
        sessOrErr.nextSeq += 1;
        while (sessOrErr.seqBuf.has(sessOrErr.nextSeq)) {
          const pending = sessOrErr.seqBuf.get(sessOrErr.nextSeq)!;
          sessOrErr.seqBuf.delete(sessOrErr.nextSeq);
          sessOrErr.targetSocket.write(pending);
          sessOrErr.nextSeq += 1;
        }
      } else {
        sessOrErr.seqBuf.set(seq, body);
      }
      res.json({ ok: true });
    } catch (err) {
      stateStore.logError('xhttp-packet-up', err instanceof Error ? err.message : String(err));
      teardownXhttp(sessionId);
      res.status(502).json({ error: 'Upstream write failed' });
    }
  };

  // XHTTP Stream-Up Uplink POST (continuous stream)
  const handleStreamUp = async (req: Request, res: Response) => {
    const { uuid, sessionId } = req.params;
    const ip = extractClientIp(req.headers, req.socket.remoteAddress);
    const sessOrErr = getOrCreateXhttpSession(uuid, 'stream-up', sessionId, ip);
    if ('error' in sessOrErr) {
      res.status(sessOrErr.status).json({ error: sessOrErr.error });
      return;
    }

    try {
      for await (const raw of req) {
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        if (!chunk.length) continue;
        sessOrErr.lastSeen = Date.now();
        if (!stateStore.recordTraffic(uuid, chunk.length)) {
          teardownXhttp(sessionId);
          res.status(403).json({ error: 'Quota exceeded or disabled' });
          return;
        }
        const svc = stateStore.state.services[uuid];
        if (svc?.speedLimitBytes) {
          await speedLimiter.throttle(uuid, chunk.length, svc.speedLimitBytes);
        }
        stateStore.state.stats.totalRequests += 1;
        const conn = stateStore.connections.get(sessOrErr.connId);
        if (conn) conn.bytes += chunk.length;

        if (!sessOrErr.targetSocket) {
          await openXhttpUpstream(sessOrErr, chunk);
        } else {
          sessOrErr.targetSocket.write(chunk);
        }
      }
      res.json({ ok: true });
    } catch (err) {
      stateStore.logError('xhttp-stream-up', err instanceof Error ? err.message : String(err));
      teardownXhttp(sessionId);
      if (!res.headersSent) res.status(502).json({ error: 'Stream relay error' });
    }
  };

  for (const prefix of ['/xhttp', '/xhttp-siz10']) {
    router.get(`${prefix}/:mode/:uuid/:sessionId`, handleDownlink);
    router.post(`${prefix}/packet-up/:uuid/:sessionId/:seq`, handlePacketUp);
    router.post(`${prefix}/stream-up/:uuid/:sessionId`, handleStreamUp);
  }

  // Safe SSRF-guarded HTTP Reverse Proxy (/proxy/*)
  router.all('/proxy/*', async (req: Request, res: Response) => {
    const rawTarget = req.params[0] || '';
    const check = validateExternalHttpUrl(rawTarget);
    if (!check.ok) {
      res.status(400).json({ error: check.error });
      return;
    }
    try {
      const upstream = await fetch(check.url.toString(), {
        method: req.method,
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      });
      res.status(upstream.status);
      const ct = upstream.headers.get('content-type');
      if (ct) res.setHeader('Content-Type', ct);
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.send(buf);
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'Upstream proxy failed' });
    }
  });

  return router;
}
