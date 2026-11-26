import crypto from 'node:crypto';
import os from 'node:os';
import express, { type NextFunction, type Request, type Response } from 'express';
import { stateStore } from '../store/stateStore';
import {
  buildInfoLineRemark,
  buildServiceUri,
  buildSubscriptionHeaders,
  formatBytes,
  generateNameSuggestions,
  generateRealityKeypair,
  isManualComboLive,
  normalizeProtocol,
  parseSizeToBytes,
  parseSpeedToBytes,
  protocolDisplayLabel,
  remainingTimeText,
} from '../engine/uriBuilder';
import {
  hashPassword,
  loginLimiter,
  sessionManager,
  validateExternalHttpUrl,
  verifyTelegramInitData,
  type SessionRecord,
} from '../engine/security';
import { outboundProxyManager, parseProxyLine, tcpPingHost } from '../engine/outboundProxy';
import { nodeManager } from '../engine/nodeManager';
import { salesEngine } from '../engine/salesEngine';
import { telegramBotService } from '../telegram/botService';
import { getTcpRelayStatus } from '../engine/relays';
import { isServiceExpired, speedLimiter } from '../engine/rateLimiter';
import {
  ALL_PERMISSIONS,
  ALL_PROTOCOLS,
  LIVE_PROTOCOLS,
  PROTOCOL_LABELS,
  SHADOWSOCKS_METHODS,
  TLS_FINGERPRINTS,
  type ServiceRecord,
} from '../types';

import {
  buildConfigStatusList,
  formatMissingConfigMessage,
  resolveRuntimeConfig,
} from '../config/envConfig';

declare global {
  namespace Express {
    interface Request {
      authSession?: SessionRecord;
      isNodeAuth?: boolean;
    }
  }
}

const adminRequestCooldown = new Map<string, number>();

function getClientIp(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.trim()) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function getPublicHostAndBase(req: Request): {
  host: string;
  baseUrl: string;
  scheme: string;
  isConfigured: boolean;
} {
  const cfg = resolveRuntimeConfig(stateStore.state.settings);
  if (cfg.publicBaseUrl.value) {
    const u = new URL(cfg.publicBaseUrl.value);
    return { host: u.hostname, baseUrl: u.origin, scheme: u.protocol.replace(':', ''), isConfigured: true };
  }
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const hostHeader = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const hostname = hostHeader.split(':')[0] || '';
  return {
    host: hostname,
    baseUrl: hostHeader ? `${proto}://${hostHeader}` : '',
    scheme: proto,
    isConfigured: false,
  };
}

function enrichService(svc: ServiceRecord, req: Request) {
  const { host, baseUrl, isConfigured: publicBaseConfigured } = getPublicHostAndBase(req);
  const cfg = resolveRuntimeConfig(stateStore.state.settings);
  const parent = svc.parentInboundId ? stateStore.state.services[svc.parentInboundId] : undefined;
  const tcpStatus = getTcpRelayStatus();

  const missingTcpVars: string[] = [];
  if (svc.protocol === 'vless-tcp') {
    if (!tcpStatus.configured) missingTcpVars.push('TCP_LISTEN_PORT');
    if (!cfg.tcpPublicHost.value) missingTcpVars.push('TCP_PUBLIC_HOST');
    if (!cfg.tcpPublicPort.value) missingTcpVars.push('TCP_PUBLIC_PORT');
  }

  const tcpConfigWarning =
    missingTcpVars.length > 0
      ? formatMissingConfigMessage({
          feature: 'VLESS-TCP public networking',
          missingVars: missingTcpVars,
          reason: 'Configure these values in your environment before distributing VLESS-TCP endpoints.',
        })
      : '';

  const uri =
    svc.protocol === 'vless-tcp' && (!cfg.tcpPublicHost.value || !cfg.tcpPublicPort.value)
      ? ''
      : host
        ? buildServiceUri(svc, host, {
            settings: stateStore.state.settings,
            parentLabel: parent?.label,
            tcpPublicHost: cfg.tcpPublicHost.value || undefined,
            tcpPublicPort: cfg.tcpPublicPort.value || undefined,
          })
        : '';

  const isLive =
    svc.protocol === 'vless-tcp'
      ? tcpStatus.active
      : svc.protocol === 'manual'
        ? isManualComboLive(svc.manual)
        : LIVE_PROTOCOLS.has(svc.protocol);
  const proxy = svc.outboundProxyId ? outboundProxyManager.get(svc.outboundProxyId) : undefined;
  const childCount = Object.values(stateStore.state.services).filter((s) => s.parentInboundId === svc.id).length;

  return {
    ...svc,
    uri,
    subUrl: baseUrl ? `${baseUrl}/sub/${svc.id}` : '',
    portalUrl: baseUrl ? `${baseUrl}/subscription/${svc.id}` : '',
    publicBaseConfigured,
    configWarning: tcpConfigWarning,
    protocolLabel: protocolDisplayLabel(svc),
    isLive,
    expired: isServiceExpired(svc),
    remainingText: remainingTimeText(svc.expiresAt),
    onlineIps: stateStore.getOnlineIpCount(svc.id),
    childCount,
    outboundProxyName: proxy ? `${proxy.name} (${proxy.scheme}://${proxy.host}:${proxy.port})` : '',
  };
}

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
    const token = authHeader.slice(7).trim();
    const sess = sessionManager.get(token);
    if (sess) {
      req.authSession = sess;
      next();
      return;
    }
    const nodeCheck = nodeManager.authorizeNodeBearer(authHeader, req.path, getClientIp(req));
    if (nodeCheck.ok) {
      req.isNodeAuth = true;
      req.authSession = {
        token: 'node',
        adminId: 'owner',
        username: 'federated-node',
        role: 'owner',
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      };
      next();
      return;
    }
    if (nodeCheck.status) {
      res.status(nodeCheck.status).json({ error: nodeCheck.error });
      return;
    }
  }
  res.status(401).json({ error: 'Authentication required' });
}

function requireOwner(req: Request, res: Response, next: NextFunction): void {
  requireAuth(req, res, () => {
    if (req.authSession?.role !== 'owner' || req.isNodeAuth) {
      res.status(403).json({ error: 'Owner privilege required' });
      return;
    }
    next();
  });
}

function requirePerm(permission: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    requireAuth(req, res, () => {
      const adminId = req.authSession?.adminId || '';
      if (!stateStore.hasPermission(adminId, permission)) {
        res.status(403).json({ error: `Missing permission: ${permission}` });
        return;
      }
      next();
    });
  };
}

export function createApiRouter(): express.Router {
  const router = express.Router();

  // ═════════════════════════════════════════════════════════════════════════
  // HEALTH & AUTHENTICATION
  // ═════════════════════════════════════════════════════════════════════════

  router.get('/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'artena-panel',
      uptimeSec: Math.floor((Date.now() - stateStore.startedAt) / 1000),
      tcpRelay: getTcpRelayStatus(),
      activeConnections: stateStore.connections.size,
      time: new Date().toISOString(),
    });
  });

  router.get('/api/auth/status', (_req, res) => {
    res.json({
      ok: true,
      needsSetup: stateStore.needsInitialOwnerSetup(),
      envPasswordConfigured: Boolean((process.env.ADMIN_PASSWORD || '').trim()),
    });
  });

  router.post('/api/auth/setup', (req, res) => {
    if (!stateStore.needsInitialOwnerSetup()) {
      res.status(409).json({ error: 'Owner account is already initialized' });
      return;
    }
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    if (username.length < 3 || username.length > 40) {
      res.status(400).json({ error: 'Username must be between 3 and 40 characters' });
      return;
    }
    if (password.length < 8) {
      res.status(400).json({ error: 'Password must be at least 8 characters' });
      return;
    }
    stateStore.claimInitialOwner(username, password);
    const session = sessionManager.create('owner', username, 'owner');
    res.json({
      ok: true,
      token: session.token,
      user: {
        adminId: 'owner',
        username,
        role: 'owner',
        permissions: ALL_PERMISSIONS.map((p) => p.key),
      },
    });
  });

  router.post('/api/login', (req, res) => {
    const ip = getClientIp(req);
    if (loginLimiter.isBlocked(ip)) {
      res.status(429).json({ error: 'Too many failed login attempts. Try again in a few minutes.' });
      return;
    }
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    const verified = stateStore.verifyCredentials(username, password);
    if (!verified) {
      loginLimiter.registerFailure(ip);
      stateStore.logActivity('auth', `Failed login attempt for "${username || 'unknown'}" from ${ip}`, 'warn');
      res.status(401).json({ error: 'Invalid username or password' });
      return;
    }
    loginLimiter.clear(ip);
    const session = sessionManager.create(verified.adminId, verified.username, verified.role);
    stateStore.logActivity('auth', `Admin "${verified.username}" signed in from ${ip}`, 'ok');
    const perms =
      verified.role === 'owner'
        ? ALL_PERMISSIONS.map((p) => p.key)
        : stateStore.state.admins[verified.adminId]?.permissions || ['dashboard'];
    res.json({
      ok: true,
      token: session.token,
      user: {
        adminId: verified.adminId,
        username: verified.username,
        role: verified.role,
        permissions: perms,
      },
    });
  });

  router.post('/api/logout', requireAuth, (req, res) => {
    if (req.authSession?.token) sessionManager.destroy(req.authSession.token);
    res.json({ ok: true });
  });

  router.get('/api/me', requireAuth, (req, res) => {
    const sess = req.authSession!;
    const perms =
      sess.role === 'owner'
        ? ALL_PERMISSIONS.map((p) => p.key)
        : stateStore.state.admins[sess.adminId]?.permissions || ['dashboard'];
    res.json({
      ok: true,
      user: {
        adminId: sess.adminId,
        username: sess.username,
        role: sess.role,
        permissions: perms,
      },
      activeSessions: sessionManager.activeCount(),
    });
  });

  router.post('/api/security/revoke-other-sessions', requireAuth, (req, res) => {
    const sess = req.authSession!;
    const removed = sessionManager.revokeOthers(sess.adminId, sess.token);
    stateStore.logActivity('auth', `Revoked ${removed} other session(s) for ${sess.username}`, 'warn');
    res.json({ ok: true, revoked: removed });
  });

  router.post('/api/change-password', requireAuth, (req, res) => {
    const sess = req.authSession!;
    const currentPassword = String(req.body?.currentPassword || '');
    const newPassword = String(req.body?.newPassword || '');
    if (newPassword.length < 8) {
      res.status(400).json({ error: 'New password must be at least 8 characters' });
      return;
    }
    if (!stateStore.verifyCredentials(sess.username, currentPassword)) {
      res.status(400).json({ error: 'Current password is incorrect' });
      return;
    }
    if (sess.role === 'owner') {
      if ((process.env.ADMIN_PASSWORD || '').trim()) {
        res.status(400).json({ error: 'Owner password is controlled by ADMIN_PASSWORD environment variable' });
        return;
      }
      stateStore.state.settings.ownerPasswordHash = hashPassword(newPassword);
    } else if (stateStore.state.admins[sess.adminId]) {
      stateStore.state.admins[sess.adminId].passwordHash = hashPassword(newPassword);
    }
    stateStore.saveNow();
    stateStore.logActivity('auth', `Password updated for "${sess.username}"`, 'ok');
    res.json({ ok: true });
  });

  router.post('/api/change-username', requireOwner, (req, res) => {
    const newUsername = String(req.body?.newUsername || '').trim();
    if (newUsername.length < 3 || newUsername.length > 40) {
      res.status(400).json({ error: 'Username must be between 3 and 40 characters' });
      return;
    }
    if ((process.env.ADMIN_USERNAME || '').trim()) {
      res.status(400).json({ error: 'Owner username is controlled by ADMIN_USERNAME environment variable' });
      return;
    }
    stateStore.state.settings.ownerUsername = newUsername;
    if (req.authSession) req.authSession.username = newUsername;
    stateStore.saveNow();
    stateStore.logActivity('auth', `Owner username changed to "${newUsername}"`, 'ok');
    res.json({ ok: true, username: newUsername });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // TELEMETRY, STATS, DIAGNOSTICS & NETWORK TOOLS
  // ═════════════════════════════════════════════════════════════════════════

  router.get('/api/telemetry', requirePerm('dashboard'), (req, res) => {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memPct = totalMem > 0 ? Math.round((usedMem / totalMem) * 1000) / 10 : 0;
    const cpuCount = Math.max(1, os.cpus().length);
    const load1 = os.loadavg()[0] || 0;
    const cpuPct = Math.min(100, Math.round((load1 / cpuCount) * 1000) / 10);

    const adminId = req.authSession!.adminId;
    const services = Object.values(stateStore.state.services).filter((s) => stateStore.isServiceInScope(adminId, s.id));
    const activeServices = services.filter((s) => s.active && !isServiceExpired(s)).length;
    const expiredServices = services.filter((s) => isServiceExpired(s)).length;
    const nearLimit = services.filter((s) => {
      if (!s.active) return false;
      const quotaWarn = s.limitBytes > 0 && s.usedBytes / s.limitBytes >= 0.85;
      const expWarn = s.expiresAt ? Date.parse(s.expiresAt) - Date.now() <= 3 * 86400_000 : false;
      return quotaWarn || expWarn;
    }).length;

    const hourly = Array.from({ length: 24 }, (_, h) => {
      const key = `${String(h).padStart(2, '0')}:00`;
      return { hour: key, bytes: stateStore.state.hourlyTraffic[key] || 0 };
    });

    res.json({
      ok: true,
      system: {
        cpuPct,
        memPct,
        usedMemBytes: usedMem,
        totalMemBytes: totalMem,
        cpuCores: cpuCount,
        loadAvg: os.loadavg().map((n) => Math.round(n * 100) / 100),
        uptimeSec: Math.floor((Date.now() - stateStore.startedAt) / 1000),
        nodeVersion: process.version,
        platform: `${os.platform()} ${os.arch()}`,
      },
      summary: {
        totalServices: services.length,
        activeServices,
        expiredServices,
        nearLimit,
        totalSubscriptions: Object.keys(stateStore.state.subscriptions).length,
        liveConnections: stateStore.connections.size,
        totalBytes: stateStore.state.stats.totalBytes,
        totalRequests: stateStore.state.stats.totalRequests,
        totalErrors: stateStore.state.stats.totalErrors,
        nodesOnline: nodeManager.list().filter((n) => n.status?.online).length,
        nodesTotal: nodeManager.nodes.size,
        proxiesCount: outboundProxyManager.proxies.size,
        sales: salesEngine.getStats(),
      },
      relays: {
        wsActive: true,
        xhttpActive: true,
        tcp: getTcpRelayStatus(),
      },
      bot: telegramBotService.getStatus(),
      hourlyTraffic: hourly,
    });
  });

  router.get('/api/config/status', requireAuth, (_req, res) => {
    const items = buildConfigStatusList(stateStore.state.settings);
    res.json({
      ok: true,
      items,
      tcpRelay: getTcpRelayStatus(),
    });
  });

  router.get('/api/system/diagnostics', requirePerm('dashboard'), (req, res) => {
    const { host, baseUrl } = getPublicHostAndBase(req);
    const tcp = getTcpRelayStatus();
    res.json({
      ok: true,
      host,
      baseUrl,
      dataDir: stateStore.dataDir,
      activeSessions: sessionManager.activeCount(),
      tcpRelay: tcp,
      wsRelayPath: '/ws/:uuid',
      xhttpPaths: ['/xhttp/packet-up/:uuid/:sessionId', '/xhttp/stream-up/:uuid/:sessionId'],
      botStatus: telegramBotService.getStatus(),
      memoryUsageMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
    });
  });

  router.post('/api/network/tcp-ping', requirePerm('dashboard'), async (req, res) => {
    const host = String(req.body?.host || '').trim();
    const port = Math.max(1, Math.min(65535, Number(req.body?.port) || 443));
    if (!host) {
      res.status(400).json({ error: 'Host is required' });
      return;
    }
    const result = await tcpPingHost(host, port, 4500);
    res.json({ host, port, ...result });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // PROTOCOLS & REALITY KEYPAIR GENERATOR
  // ═════════════════════════════════════════════════════════════════════════

  router.get('/api/protocols', requireAuth, (_req, res) => {
    res.json({
      ok: true,
      protocols: ALL_PROTOCOLS.map((id) => ({
        id,
        label: PROTOCOL_LABELS[id],
        live: LIVE_PROTOCOLS.has(id),
      })),
      fingerprints: TLS_FINGERPRINTS,
      shadowsocksMethods: SHADOWSOCKS_METHODS,
    });
  });

  router.get('/api/reality-keypair', requireAuth, (_req, res) => {
    res.json({ ok: true, ...generateRealityKeypair() });
  });

  router.get('/api/name-suggestions', requireAuth, (req, res) => {
    const base = String(req.query.base || '');
    const n = Math.max(4, Math.min(20, Number(req.query.n) || 10));
    res.json({ ok: true, suggestions: generateNameSuggestions(base, n) });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // SERVICES / INBOUNDS & CHILD CLIENTS
  // ═════════════════════════════════════════════════════════════════════════

  router.get('/api/services', requireAuth, (req, res) => {
    const adminId = req.authSession!.adminId;
    const list = Object.values(stateStore.state.services)
      .filter((s) => stateStore.isServiceInScope(adminId, s.id))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((s) => enrichService(s, req));
    res.json({ ok: true, services: list });
  });

  // Alias for federated node compatibility
  router.get('/api/links', requireAuth, (req, res) => {
    const adminId = req.authSession!.adminId;
    const list = Object.values(stateStore.state.services)
      .filter((s) => stateStore.isServiceInScope(adminId, s.id))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((s) => enrichService(s, req));
    res.json({ ok: true, links: list, services: list });
  });

  router.post('/api/services', requirePerm('inbound_create'), (req, res) => {
    const b = req.body || {};
    const limitBytes =
      b.limitBytes !== undefined
        ? Math.max(0, Number(b.limitBytes) || 0)
        : parseSizeToBytes(Number(b.volume || 0), String(b.volumeUnit || 'GB'));
    const speedLimitBytes =
      b.speedLimitBytes !== undefined
        ? Math.max(0, Number(b.speedLimitBytes) || 0)
        : parseSpeedToBytes(Number(b.speed || 0), String(b.speedUnit || 'Mbps'));
    const days = Math.max(0, Number(b.days || 0));
    const expiresAt = b.expiresAt
      ? String(b.expiresAt)
      : days > 0
        ? new Date(Date.now() + days * 86400_000).toISOString()
        : null;

    const svc = stateStore.createService({
      label: b.label,
      limitBytes,
      expiresAt,
      note: b.note,
      subId: b.subId || null,
      protocol: normalizeProtocol(b.protocol),
      fingerprint: b.fingerprint,
      alpn: b.alpn,
      port: Number(b.port) || undefined,
      ipLimit: Number(b.ipLimit) || 0,
      speedLimitBytes,
      connectionLimit: Number(b.connectionLimit) || 0,
      fragment: b.fragment,
      cleanIps: Array.isArray(b.cleanIps) ? b.cleanIps : [],
      alarmEnabled: Boolean(b.alarmEnabled),
      categoryId: b.categoryId || 'general',
      outboundProxyId: b.outboundProxyId || '',
      manual: b.manual,
    });
    res.status(201).json({ ok: true, service: enrichService(svc, req) });
  });

  router.post('/api/services/auto', requirePerm('inbound_create'), (req, res) => {
    const b = req.body || {};
    const gb = Math.max(0, Number(b.gb ?? 50));
    const days = Math.max(0, Number(b.days ?? 30));
    const svc = stateStore.createService({
      label: String(b.label || '').trim() || generateNameSuggestions('', 1)[0],
      protocol: normalizeProtocol(b.protocol || 'vless-ws'),
      limitBytes: gb > 0 ? parseSizeToBytes(gb, 'GB') : 0,
      expiresAt: days > 0 ? new Date(Date.now() + days * 86400_000).toISOString() : null,
      ipLimit: Number(b.ipLimit || 2),
      outboundProxyId: String(b.outboundProxyId || ''),
    });
    res.status(201).json({ ok: true, service: enrichService(svc, req) });
  });

  router.post('/api/services/combo', requirePerm('inbound_create'), (req, res) => {
    const b = req.body || {};
    const exits: string[] = Array.isArray(b.exits) && b.exits.length ? b.exits.map(String) : [''];
    const pairsPerExit = Math.max(1, Math.min(4, Number(b.pairsPerExit) || 1));
    const gb = Math.max(0, Number(b.gb ?? 100));
    const days = Math.max(0, Number(b.days ?? 30));
    const groupName = String(b.groupName || b.label || 'Combo Bundle').trim();
    const limitBytes = gb > 0 ? parseSizeToBytes(gb, 'GB') : 0;
    const expiresAt = days > 0 ? new Date(Date.now() + days * 86400_000).toISOString() : null;

    const createdIds: string[] = [];
    for (const exitId of exits) {
      const proxy = exitId ? outboundProxyManager.get(exitId) : undefined;
      const tag = proxy ? proxy.name : 'Direct';
      for (let i = 0; i < pairsPerExit; i++) {
        const suffix = pairsPerExit > 1 ? ` #${i + 1}` : '';
        const wsSvc = stateStore.createService({
          label: `${groupName} · ${tag} WS${suffix}`,
          protocol: 'vless-ws',
          limitBytes,
          expiresAt,
          outboundProxyId: exitId,
          ipLimit: Number(b.ipLimit || 2),
        });
        const xhttpSvc = stateStore.createService({
          label: `${groupName} · ${tag} XHTTP${suffix}`,
          protocol: 'xhttp-packet-up',
          limitBytes,
          expiresAt,
          outboundProxyId: exitId,
          ipLimit: Number(b.ipLimit || 2),
        });
        createdIds.push(wsSvc.id, xhttpSvc.id);
      }
    }

    const group = stateStore.createSubscriptionGroup({
      name: groupName,
      description: `Multi-exit combo bundle (${createdIds.length} endpoints)`,
      linkIds: createdIds,
      comboMeta: { exits, pairsPerExit },
    });

    res.status(201).json({ ok: true, group, createdCount: createdIds.length });
  });

  router.post('/api/services/outbound', requirePerm('outbound_manage'), (req, res) => {
    const ids: string[] = Array.isArray(req.body?.serviceIds) ? req.body.serviceIds.map(String) : [];
    const proxyId = String(req.body?.outboundProxyId || '').trim();
    if (proxyId && !outboundProxyManager.get(proxyId)) {
      res.status(404).json({ error: 'Outbound proxy not found' });
      return;
    }
    let updated = 0;
    for (const id of ids) {
      const svc = stateStore.state.services[id];
      if (svc && stateStore.isServiceInScope(req.authSession!.adminId, id)) {
        svc.outboundProxyId = proxyId;
        updated += 1;
      }
    }
    stateStore.saveNow();
    res.json({ ok: true, updated });
  });

  router.patch('/api/services/:uid', requirePerm('inbound_edit'), (req, res) => {
    const uid = req.params.uid;
    if (!stateStore.isServiceInScope(req.authSession!.adminId, uid)) {
      res.status(403).json({ error: 'Service is outside your assigned scope' });
      return;
    }
    const svc = stateStore.state.services[uid];
    if (!svc) {
      res.status(404).json({ error: 'Service not found' });
      return;
    }
    const b = req.body || {};
    if (b.label !== undefined) svc.label = String(b.label).trim().slice(0, 80) || svc.label;
    if (b.active !== undefined) svc.active = Boolean(b.active);
    if (b.note !== undefined) svc.note = String(b.note).trim().slice(0, 500);
    if (b.limitBytes !== undefined) svc.limitBytes = Math.max(0, Math.floor(Number(b.limitBytes) || 0));
    if (b.expiresAt !== undefined) svc.expiresAt = b.expiresAt ? String(b.expiresAt) : null;
    if (b.protocol !== undefined) svc.protocol = normalizeProtocol(b.protocol);
    if (b.port !== undefined) svc.port = Math.max(1, Math.min(65535, Number(b.port) || 443));
    if (b.fingerprint !== undefined) svc.fingerprint = String(b.fingerprint).trim().toLowerCase();
    if (b.alpn !== undefined) svc.alpn = String(b.alpn).trim().slice(0, 100);
    if (b.ipLimit !== undefined) svc.ipLimit = Math.max(0, Math.floor(Number(b.ipLimit) || 0));
    if (b.connectionLimit !== undefined) svc.connectionLimit = Math.max(0, Math.floor(Number(b.connectionLimit) || 0));
    if (b.speedLimitBytes !== undefined) {
      svc.speedLimitBytes = Math.max(0, Math.floor(Number(b.speedLimitBytes) || 0));
      speedLimiter.reset(uid);
    }
    if (b.categoryId !== undefined) svc.categoryId = String(b.categoryId || 'general');
    if (b.outboundProxyId !== undefined) svc.outboundProxyId = String(b.outboundProxyId || '').trim();
    if (b.fragment !== undefined) svc.fragment = String(b.fragment || 'off').trim();
    if (Array.isArray(b.cleanIps)) svc.cleanIps = b.cleanIps.map(String).filter(Boolean).slice(0, 20);
    if (b.manual && typeof b.manual === 'object') {
      svc.manual = { ...(svc.manual || ({} as NonNullable<ServiceRecord['manual']>)), ...b.manual };
    }
    stateStore.saveNow();
    stateStore.logActivity('service', `Updated service "${svc.label}"`, 'ok');
    res.json({ ok: true, service: enrichService(svc, req) });
  });

  router.post('/api/services/:uid/reset-usage', requirePerm('client_reset'), (req, res) => {
    const svc = stateStore.state.services[req.params.uid];
    if (!svc) {
      res.status(404).json({ error: 'Service not found' });
      return;
    }
    svc.usedBytes = 0;
    stateStore.saveNow();
    stateStore.logActivity('service', `Reset traffic counter for "${svc.label}"`, 'info');
    res.json({ ok: true, service: enrichService(svc, req) });
  });

  router.post('/api/services/:uid/regenerate', requirePerm('inbound_edit'), (req, res) => {
    const updated = stateStore.regenerateServiceUuid(req.params.uid);
    if (!updated) {
      res.status(404).json({ error: 'Service not found' });
      return;
    }
    res.json({ ok: true, service: enrichService(updated, req) });
  });

  router.post('/api/services/:uid/action', requirePerm('client_edit'), (req, res) => {
    const svc = stateStore.state.services[req.params.uid];
    if (!svc) {
      res.status(404).json({ error: 'Service not found' });
      return;
    }
    const action = String(req.body?.action || '');
    const value = Number(req.body?.value || 0);
    if (action === 'toggle') svc.active = !svc.active;
    else if (action === 'add_gb' && value > 0) svc.limitBytes += parseSizeToBytes(value, 'GB');
    else if (action === 'extend_days' && value > 0) {
      const base = svc.expiresAt ? Math.max(Date.now(), Date.parse(svc.expiresAt)) : Date.now();
      svc.expiresAt = new Date(base + value * 86400_000).toISOString();
    } else if (action === 'reset') svc.usedBytes = 0;
    else {
      res.status(400).json({ error: 'Unsupported action' });
      return;
    }
    stateStore.saveNow();
    res.json({ ok: true, service: enrichService(svc, req) });
  });

  router.delete('/api/services/:uid', requirePerm('inbound_delete'), (req, res) => {
    if (!stateStore.removeService(req.params.uid)) {
      res.status(404).json({ error: 'Service not found' });
      return;
    }
    res.json({ ok: true });
  });

  // Child Clients under a Parent Inbound
  router.get('/api/services/:uid/clients', requireAuth, (req, res) => {
    const parentId = req.params.uid;
    const clients = Object.values(stateStore.state.services)
      .filter((s) => s.parentInboundId === parentId)
      .map((c) => enrichService(c, req));
    res.json({ ok: true, clients });
  });

  router.post('/api/services/:uid/clients', requirePerm('client_create'), (req, res) => {
    const parent = stateStore.state.services[req.params.uid];
    if (!parent) {
      res.status(404).json({ error: 'Parent inbound not found' });
      return;
    }
    const b = req.body || {};
    const gb = Number(b.volumeGb ?? 0);
    const days = Number(b.days ?? 0);
    const child = stateStore.createService({
      label: String(b.label || '').trim() || `${parent.label}-client-${Date.now().toString(36).slice(-3)}`,
      parentInboundId: parent.id,
      protocol: parent.protocol,
      port: parent.port,
      fingerprint: parent.fingerprint,
      alpn: parent.alpn,
      categoryId: parent.categoryId,
      outboundProxyId: parent.outboundProxyId,
      manual: parent.manual,
      limitBytes: gb > 0 ? parseSizeToBytes(gb, 'GB') : parent.limitBytes,
      expiresAt: days > 0 ? new Date(Date.now() + days * 86400_000).toISOString() : parent.expiresAt,
      ipLimit: b.ipLimit !== undefined ? Number(b.ipLimit) : parent.ipLimit,
      speedLimitBytes: b.speedMbps ? parseSpeedToBytes(Number(b.speedMbps), 'Mbps') : parent.speedLimitBytes,
    });
    res.status(201).json({ ok: true, client: enrichService(child, req) });
  });

  router.delete('/api/services/:uid/clients/:clientId', requirePerm('client_delete'), (req, res) => {
    const child = stateStore.state.services[req.params.clientId];
    if (!child || child.parentInboundId !== req.params.uid) {
      res.status(404).json({ error: 'Child client not found' });
      return;
    }
    stateStore.removeService(child.id);
    res.json({ ok: true });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // SUBSCRIPTION GROUPS, REMOTE LINKS & PUBLIC SUBSCRIPTION FEEDS
  // ═════════════════════════════════════════════════════════════════════════

  router.get('/api/subscriptions', requirePerm('subscriptions'), (req, res) => {
    const { baseUrl } = getPublicHostAndBase(req);
    const list = Object.values(stateStore.state.subscriptions)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((g) => ({
        ...g,
        hasPassword: Boolean(g.password),
        password: '',
        subFeedUrl: `${baseUrl}/sub-group/${g.uuidKey}`,
        portalUrl: `${baseUrl}/p/${g.uuidKey}`,
      }));
    res.json({ ok: true, subscriptions: list });
  });

  router.post('/api/subscriptions', requirePerm('subscriptions'), (req, res) => {
    const b = req.body || {};
    const group = stateStore.createSubscriptionGroup({
      name: String(b.name || 'New Group'),
      description: String(b.description || ''),
      password: String(b.password || ''),
      linkIds: Array.isArray(b.linkIds) ? b.linkIds.map(String) : [],
    });
    const { baseUrl } = getPublicHostAndBase(req);
    res.status(201).json({
      ok: true,
      subscription: {
        ...group,
        hasPassword: Boolean(group.password),
        password: '',
        subFeedUrl: `${baseUrl}/sub-group/${group.uuidKey}`,
        portalUrl: `${baseUrl}/p/${group.uuidKey}`,
      },
    });
  });

  router.patch('/api/subscriptions/:id', requirePerm('subscriptions'), (req, res) => {
    const g = stateStore.state.subscriptions[req.params.id];
    if (!g) {
      res.status(404).json({ error: 'Subscription group not found' });
      return;
    }
    const b = req.body || {};
    if (b.name !== undefined) g.name = String(b.name).trim().slice(0, 80) || g.name;
    if (b.description !== undefined) g.description = String(b.description).trim().slice(0, 300);
    if (b.password !== undefined) g.password = String(b.password).trim().slice(0, 64);
    if (Array.isArray(b.linkIds)) {
      g.linkIds = Array.from(
        new Set((b.linkIds as unknown[]).map(String).filter((id: string) => Boolean(stateStore.state.services[id])))
      );
    }
    stateStore.saveNow();
    res.json({ ok: true, subscription: { ...g, hasPassword: Boolean(g.password), password: '' } });
  });

  router.delete('/api/subscriptions/:id', requirePerm('subscriptions'), (req, res) => {
    if (!stateStore.removeSubscriptionGroup(req.params.id)) {
      res.status(404).json({ error: 'Subscription group not found' });
      return;
    }
    res.json({ ok: true });
  });

  router.post('/api/subscriptions/:id/remote-links', requireOwner, async (req, res) => {
    const sub = stateStore.state.subscriptions[req.params.id];
    if (!sub) {
      res.status(404).json({ error: 'Subscription group not found' });
      return;
    }
    const nodeId = String(req.body?.nodeId || '');
    const remoteUid = String(req.body?.remoteUid || '');
    const node = nodeManager.nodes.get(nodeId);
    if (!node) {
      res.status(404).json({ error: 'Node not found' });
      return;
    }
    try {
      const remoteData = await nodeManager.callNodeJson<{ services?: Array<Record<string, unknown>>; links?: Array<Record<string, unknown>> }>(
        nodeId,
        'GET',
        '/api/links'
      );
      const list = remoteData.services || remoteData.links || [];
      const found = list.find((item) => String(item.id || item.uuid) === remoteUid);
      if (!found) {
        res.status(404).json({ error: 'Remote service not found on node' });
        return;
      }
      const ref = {
        refId: crypto.randomBytes(6).toString('hex'),
        nodeId,
        nodeName: node.name,
        remoteUid,
        label: String(found.label || remoteUid.slice(0, 8)),
        uri: String(found.uri || found.vless_link || ''),
        usedBytes: Number(found.usedBytes ?? found.used_bytes ?? 0),
        limitBytes: Number(found.limitBytes ?? found.limit_bytes ?? 0),
        expiresAt: found.expiresAt ? String(found.expiresAt) : null,
        active: Boolean(found.active ?? true),
        lastSyncedAt: new Date().toISOString(),
      };
      sub.remoteLinks.push(ref);
      stateStore.saveNow();
      res.status(201).json({ ok: true, remoteLink: ref });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'Failed to fetch remote node link' });
    }
  });

  router.delete('/api/subscriptions/:id/remote-links/:refId', requireOwner, (req, res) => {
    const sub = stateStore.state.subscriptions[req.params.id];
    if (!sub) {
      res.status(404).json({ error: 'Subscription group not found' });
      return;
    }
    sub.remoteLinks = sub.remoteLinks.filter((r) => r.refId !== req.params.refId);
    stateStore.saveNow();
    res.json({ ok: true });
  });

  router.post('/api/mix-sub', requireAuth, (req, res) => {
    const ids: string[] = Array.isArray(req.body?.serviceIds) ? req.body.serviceIds.map(String) : [];
    const { host } = getPublicHostAndBase(req);
    const uris = ids
      .map((id) => stateStore.state.services[id])
      .filter((s): s is ServiceRecord => Boolean(s && s.active))
      .map((s) => buildServiceUri(s, host, { settings: stateStore.state.settings }));
    const raw = uris.join('\n');
    res.json({ ok: true, count: uris.length, raw, base64: Buffer.from(raw).toString('base64') });
  });

  // Public single-service subscription feed (for v2rayNG / Hiddify / Streisand)
  router.get('/sub/:uuid', (req, res) => {
    const svc = stateStore.state.services[req.params.uuid];
    if (!svc) {
      res.status(404).send('Service not found');
      return;
    }
    const { host, baseUrl } = getPublicHostAndBase(req);
    const cfg = resolveRuntimeConfig(stateStore.state.settings);
    if (svc.protocol === 'vless-tcp' && (!cfg.tcpPublicHost.value || !cfg.tcpPublicPort.value)) {
      res
        .status(409)
        .type('text/plain; charset=utf-8')
        .send(
          formatMissingConfigMessage({
            feature: 'VLESS-TCP subscription link generation',
            missingVars: [
              ...(!cfg.tcpPublicHost.value ? ['TCP_PUBLIC_HOST'] : []),
              ...(!cfg.tcpPublicPort.value ? ['TCP_PUBLIC_PORT'] : []),
            ],
            reason: 'Set these variables before requesting VLESS-TCP subscription feeds.',
          })
        );
      return;
    }
    const uri = buildServiceUri(svc, host, {
      settings: stateStore.state.settings,
      tcpPublicHost: cfg.tcpPublicHost.value || undefined,
      tcpPublicPort: cfg.tcpPublicPort.value || undefined,
    });
    const lines = [uri];
    if (stateStore.state.settings.subInfoLineEnabled) {
      const infoRemark = buildInfoLineRemark(svc.usedBytes, svc.limitBytes, svc.expiresAt, stateStore.state.settings);
      lines.unshift(buildServiceUri(svc, host, { settings: stateStore.state.settings, remarkOverride: infoRemark }));
    }
    const headers = buildSubscriptionHeaders({
      usedBytes: svc.usedBytes,
      limitBytes: svc.limitBytes,
      expiresAt: svc.expiresAt,
      title: svc.label,
      infoUrl: `${baseUrl}/subscription/${svc.id}`,
    });
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    res.type('text/plain; charset=utf-8').send(Buffer.from(lines.join('\n')).toString('base64'));
  });

  router.get('/sub-all', requireAuth, (req, res) => {
    const { host } = getPublicHostAndBase(req);
    const lines = Object.values(stateStore.state.services)
      .filter((s) => s.active)
      .map((s) => buildServiceUri(s, host, { settings: stateStore.state.settings }));
    res.type('text/plain; charset=utf-8').send(Buffer.from(lines.join('\n')).toString('base64'));
  });

  // Public group subscription feed
  router.get('/sub-group/:uuidKey', (req, res) => {
    const group = Object.values(stateStore.state.subscriptions).find((g) => g.uuidKey === req.params.uuidKey);
    if (!group) {
      res.status(404).send('Subscription group not found');
      return;
    }
    if (group.password && String(req.query.pass || '') !== group.password) {
      res.status(401).send('Password required');
      return;
    }
    const { host, baseUrl } = getPublicHostAndBase(req);
    const localSvcs = group.linkIds
      .map((id) => stateStore.state.services[id])
      .filter((s): s is ServiceRecord => Boolean(s && s.active));

    const uris = localSvcs.map((s) => buildServiceUri(s, host, { settings: stateStore.state.settings }));
    for (const remote of group.remoteLinks) {
      if (remote.active && !remote.orphaned && remote.uri) uris.push(remote.uri);
    }

    const totalUsed = localSvcs.reduce((acc, s) => acc + s.usedBytes, 0);
    const totalLimit = localSvcs.reduce((acc, s) => acc + s.limitBytes, 0);
    const latestExpiry = localSvcs
      .map((s) => s.expiresAt)
      .filter((x): x is string => Boolean(x))
      .sort()
      .pop() || null;

    const headers = buildSubscriptionHeaders({
      usedBytes: totalUsed,
      limitBytes: totalLimit,
      expiresAt: latestExpiry,
      title: group.name,
      infoUrl: `${baseUrl}/p/${group.uuidKey}`,
    });
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    res.type('text/plain; charset=utf-8').send(Buffer.from(uris.join('\n')).toString('base64'));
  });

  // Public JSON APIs powering the client-facing React Subscription Portal (/subscription/:uuid and /p/:uuidKey)
  router.get('/api/subscription/:uuid', (req, res) => {
    const svc = stateStore.state.services[req.params.uuid];
    if (!svc) {
      res.status(404).json({ error: 'Subscription not found' });
      return;
    }
    const enriched = enrichService(svc, req);
    res.json({
      ok: true,
      type: 'single',
      title: svc.label,
      active: svc.active && !enriched.expired,
      usedBytes: svc.usedBytes,
      limitBytes: svc.limitBytes,
      expiresAt: svc.expiresAt,
      remainingText: enriched.remainingText,
      subFeedUrl: enriched.subUrl,
      supportUsername: stateStore.state.settings.supportUsername,
      channelUsername: stateStore.state.settings.channelUsername,
      endpoints: [
        {
          id: svc.id,
          label: svc.label,
          protocolLabel: enriched.protocolLabel,
          uri: enriched.uri,
        },
      ],
    });
  });

  router.get('/api/public/sub/:uuidKey', (req, res) => {
    const group = Object.values(stateStore.state.subscriptions).find((g) => g.uuidKey === req.params.uuidKey);
    if (!group) {
      res.status(404).json({ error: 'Subscription group not found' });
      return;
    }
    if (group.password && String(req.query.pass || '') !== group.password) {
      res.status(401).json({ error: 'Password required', passwordProtected: true, title: group.name });
      return;
    }
    const { host, baseUrl } = getPublicHostAndBase(req);
    const localSvcs = group.linkIds
      .map((id) => stateStore.state.services[id])
      .filter((s): s is ServiceRecord => Boolean(s));

    const endpoints = [
      ...localSvcs.map((s) => ({
        id: s.id,
        label: s.label,
        protocolLabel: protocolDisplayLabel(s),
        uri: buildServiceUri(s, host, { settings: stateStore.state.settings }),
      })),
      ...group.remoteLinks
        .filter((r) => r.active && !r.orphaned && r.uri)
        .map((r) => ({
          id: r.refId,
          label: `${r.nodeName} · ${r.label}`,
          protocolLabel: 'Federated Node',
          uri: r.uri,
        })),
    ];

    const usedBytes = localSvcs.reduce((acc, s) => acc + s.usedBytes, 0);
    const limitBytes = localSvcs.reduce((acc, s) => acc + s.limitBytes, 0);
    const latestExpiry = localSvcs.map((s) => s.expiresAt).filter((x): x is string => Boolean(x)).sort().pop() || null;

    res.json({
      ok: true,
      type: 'group',
      title: group.name,
      description: group.description,
      active: endpoints.length > 0,
      usedBytes,
      limitBytes,
      expiresAt: latestExpiry,
      remainingText: remainingTimeText(latestExpiry),
      subFeedUrl: `${baseUrl}/sub-group/${group.uuidKey}${group.password ? `?pass=${encodeURIComponent(group.password)}` : ''}`,
      supportUsername: stateStore.state.settings.supportUsername,
      channelUsername: stateStore.state.settings.channelUsername,
      endpoints,
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // CATEGORIES
  // ═════════════════════════════════════════════════════════════════════════

  router.get('/api/categories', requireAuth, (_req, res) => {
    res.json({ ok: true, categories: Object.values(stateStore.state.categories) });
  });

  router.post('/api/categories', requirePerm('categories'), (req, res) => {
    const name = String(req.body?.name || '').trim().slice(0, 48);
    if (!name) {
      res.status(400).json({ error: 'Category name is required' });
      return;
    }
    const id = crypto.randomBytes(4).toString('hex');
    const rec = {
      id,
      name,
      color: String(req.body?.color || '#0D9488').slice(0, 16),
      description: String(req.body?.description || '').trim().slice(0, 160),
      createdAt: new Date().toISOString(),
    };
    stateStore.state.categories[id] = rec;
    stateStore.saveNow();
    res.status(201).json({ ok: true, category: rec });
  });

  router.delete('/api/categories/:id', requirePerm('categories'), (req, res) => {
    if (req.params.id === 'general') {
      res.status(400).json({ error: 'Default category cannot be removed' });
      return;
    }
    if (!stateStore.state.categories[req.params.id]) {
      res.status(404).json({ error: 'Category not found' });
      return;
    }
    delete stateStore.state.categories[req.params.id];
    for (const s of Object.values(stateStore.state.services)) {
      if (s.categoryId === req.params.id) s.categoryId = 'general';
    }
    stateStore.saveNow();
    res.json({ ok: true });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // OUTBOUND PROXIES & LIVE SCANNER
  // ═════════════════════════════════════════════════════════════════════════

  router.get('/api/proxies', requireAuth, (_req, res) => {
    res.json({ ok: true, proxies: outboundProxyManager.list() });
  });

  router.post('/api/proxies', requirePerm('outbound_manage'), (req, res) => {
    try {
      const rec = outboundProxyManager.upsert(req.body || {});
      res.status(201).json({ ok: true, proxy: { ...rec, password: '', hasPassword: Boolean(rec.password) } });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid proxy configuration' });
    }
  });

  router.delete('/api/proxies/:id', requirePerm('outbound_manage'), (req, res) => {
    if (!outboundProxyManager.delete(req.params.id)) {
      res.status(404).json({ error: 'Proxy not found' });
      return;
    }
    res.json({ ok: true });
  });

  router.post('/api/proxies/:id/test', requirePerm('outbound_manage'), async (req, res) => {
    const tested = await outboundProxyManager.testSavedProxy(req.params.id);
    if (!tested) {
      res.status(404).json({ error: 'Proxy not found' });
      return;
    }
    res.json({ ok: true, proxy: { ...tested, password: '', hasPassword: Boolean(tested.password) } });
  });

  router.post('/api/proxies/bulk', requirePerm('outbound_manage'), (req, res) => {
    const raw = String(req.body?.lines || '');
    const defaultScheme = (req.body?.defaultScheme || 'socks5') as 'socks5' | 'socks4' | 'http';
    const added: string[] = [];
    const errors: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const parsed = parseProxyLine(line, defaultScheme);
      if (!parsed) continue;
      try {
        const rec = outboundProxyManager.upsert(parsed);
        added.push(rec.id);
      } catch (err) {
        errors.push(`${parsed.host}:${parsed.port} - ${err instanceof Error ? err.message : 'invalid'}`);
      }
    }
    res.json({ ok: true, addedCount: added.length, errors });
  });

  router.post('/api/proxies/scan/start', requirePerm('outbound_manage'), (req, res) => {
    const raw = String(req.body?.lines || '');
    const defaultScheme = (req.body?.defaultScheme || 'socks5') as 'socks5' | 'socks4' | 'http';
    const candidates = raw
      .split(/\r?\n/)
      .map((line) => parseProxyLine(line, defaultScheme))
      .filter((c): c is NonNullable<typeof c> => Boolean(c))
      .slice(0, 150);
    if (!candidates.length) {
      res.status(400).json({ error: 'No valid proxy candidates found' });
      return;
    }
    const job = outboundProxyManager.startScanJob('list', candidates, {
      checkTls: req.body?.checkTls !== false,
      concurrency: Number(req.body?.concurrency) || 8,
    });
    res.status(201).json({ ok: true, jobId: job.id, total: job.total });
  });

  router.post('/api/proxies/scan/saved', requirePerm('outbound_manage'), (_req, res) => {
    const candidates = Array.from(outboundProxyManager.proxies.values()).map((p) => ({
      scheme: p.scheme,
      host: p.host,
      port: p.port,
      username: p.username,
      password: p.password,
      raw: `${p.scheme}://${p.host}:${p.port}`,
    }));
    if (!candidates.length) {
      res.status(400).json({ error: 'No saved proxies to scan' });
      return;
    }
    const job = outboundProxyManager.startScanJob('saved', candidates, { checkTls: true });
    res.status(201).json({ ok: true, jobId: job.id, total: job.total });
  });

  router.get('/api/proxies/scan/:jobId', requirePerm('outbound_manage'), (req, res) => {
    const job = outboundProxyManager.scanJobs.get(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Scan job not found' });
      return;
    }
    res.json({ ok: true, job });
  });

  router.post('/api/proxies/scan/:jobId/cancel', requirePerm('outbound_manage'), (req, res) => {
    const job = outboundProxyManager.scanJobs.get(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Scan job not found' });
      return;
    }
    job.cancelled = true;
    res.json({ ok: true });
  });

  router.post('/api/proxies/scan/:jobId/import', requirePerm('outbound_manage'), (req, res) => {
    const job = outboundProxyManager.scanJobs.get(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Scan job not found' });
      return;
    }
    const minScore = Number(req.body?.minScore ?? 40);
    let imported = 0;
    for (const r of job.results) {
      if (r.ok && r.score >= minScore) {
        try {
          const rec = outboundProxyManager.upsert({
            name: `${r.candidate.scheme.toUpperCase()} ${r.candidate.host}:${r.candidate.port}`,
            ...r.candidate,
          });
          rec.lastTest = {
            ok: r.ok,
            latencyMs: r.latencyMs,
            tlsOk: r.tlsOk,
            speedKbps: r.speedKbps,
            score: r.score,
            grade: r.grade,
            error: r.error,
            testedAt: r.testedAt,
          };
          imported += 1;
        } catch {
          // Skip invalid
        }
      }
    }
    res.json({ ok: true, imported });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // MULTI-NODE FEDERATION
  // ═════════════════════════════════════════════════════════════════════════

  router.get('/api/node/info', requireAuth, (_req, res) => {
    res.json(nodeManager.getLocalNodeInfo());
  });

  router.get('/api/node/token', requireOwner, (_req, res) => {
    res.json({ ok: true, ...nodeManager.getTokenState() });
  });

  router.post('/api/node/token', requireOwner, (_req, res) => {
    const tok = nodeManager.rotateLocalToken();
    res.json({ ok: true, enabled: true, token: tok.token, createdAt: tok.createdAt });
  });

  router.delete('/api/node/token', requireOwner, (_req, res) => {
    nodeManager.disableLocalToken();
    res.json({ ok: true, enabled: false, token: null });
  });

  router.get('/api/nodes', requireOwner, (_req, res) => {
    res.json({ ok: true, nodes: nodeManager.list(), tokenEnabled: Boolean(nodeManager.localToken.token) });
  });

  router.post('/api/nodes/test', requireOwner, async (req, res) => {
    const url = String(req.body?.url || '').trim();
    let token = String(req.body?.token || '').trim();
    if (!token && req.body?.id) {
      token = nodeManager.nodes.get(String(req.body.id))?.token || '';
    }
    if (!url || !token) {
      res.status(400).json({ error: 'Node URL and token are required' });
      return;
    }
    const status = await nodeManager.probeNode(url, token);
    res.json({ ok: true, status });
  });

  router.post('/api/nodes', requireOwner, async (req, res) => {
    try {
      const rec = nodeManager.upsert(req.body || {});
      if (rec.enabled) await nodeManager.checkNode(rec.id);
      res.status(201).json({ ok: true, node: nodeManager.publicNode(rec) });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid node input' });
    }
  });

  router.delete('/api/nodes/:id', requireOwner, (req, res) => {
    if (!nodeManager.delete(req.params.id)) {
      res.status(404).json({ error: 'Node not found' });
      return;
    }
    res.json({ ok: true });
  });

  router.post('/api/nodes/check-all', requireOwner, async (_req, res) => {
    await nodeManager.checkAll();
    res.json({ ok: true, nodes: nodeManager.list() });
  });

  router.post('/api/nodes/:id/check', requireOwner, async (req, res) => {
    const st = await nodeManager.checkNode(req.params.id);
    if (!st) {
      res.status(404).json({ error: 'Node not found' });
      return;
    }
    res.json({ ok: true, node: nodeManager.publicNode(nodeManager.nodes.get(req.params.id)!) });
  });

  router.get('/api/nodes/:id/inbounds', requireOwner, async (req, res) => {
    try {
      const data = await nodeManager.callNodeJson(req.params.id, 'GET', '/api/links');
      res.json({ ok: true, data });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'Failed to list remote inbounds' });
    }
  });

  router.all('/api/nodes/:id/fwd/*', requireOwner, async (req, res) => {
    const targetPath = `/${req.params[0] || ''}`;
    try {
      const data = await nodeManager.callNodeJson(
        req.params.id,
        req.method,
        targetPath,
        req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined
      );
      res.json(data);
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'Forwarding failed' });
    }
  });

  // ═════════════════════════════════════════════════════════════════════════
  // SALES PLANS & ORDER FULFILLMENT
  // ═════════════════════════════════════════════════════════════════════════

  router.get('/api/plans', requireAuth, (_req, res) => {
    res.json({ ok: true, plans: salesEngine.listPlans() });
  });

  router.post('/api/plans', requireOwner, (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name) {
      res.status(400).json({ error: 'Plan name is required' });
      return;
    }
    const plan = salesEngine.upsertPlan({ ...req.body, name });
    res.status(201).json({ ok: true, plan });
  });

  router.delete('/api/plans/:id', requireOwner, (req, res) => {
    if (!salesEngine.deletePlan(req.params.id)) {
      res.status(404).json({ error: 'Plan not found' });
      return;
    }
    res.json({ ok: true });
  });

  router.get('/api/sales/orders', requirePerm('reports'), (_req, res) => {
    res.json({
      ok: true,
      orders: salesEngine.ledger.orders.slice(0, 200),
      customers: Object.values(salesEngine.ledger.customers),
      stats: salesEngine.getStats(),
    });
  });

  router.post('/api/sales/fulfill', requireOwner, (req, res) => {
    const planId = String(req.body?.planId || '');
    const userId = String(req.body?.userId || `manual_${Date.now().toString(36)}`);
    const username = String(req.body?.username || '').trim();
    try {
      const { order, service } = salesEngine.fulfillOrder({
        planId,
        userId,
        username,
        protocol: req.body?.protocol,
        port: req.body?.port,
      });
      res.status(201).json({ ok: true, order, service: enrichService(service, req) });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Fulfillment failed' });
    }
  });

  // ═════════════════════════════════════════════════════════════════════════
  // TELEGRAM MINI APP API (/api/tma/:action)
  // Authenticates via Telegram WebAppData HMAC-SHA256 OR active Admin Bearer token
  // ═════════════════════════════════════════════════════════════════════════

  router.post('/api/tma/:action', (req, res) => {
    const tgInit = String(req.headers['x-tg-init'] || '');
    let authorized = false;

    if (tgInit) {
      const check = verifyTelegramInitData(tgInit, stateStore.state.settings.botToken);
      if (!check.ok) {
        res.status(401).json({ error: check.error });
        return;
      }
      if (!telegramBotService.parseAdminIds().includes(check.user.id)) {
        res.status(403).json({ error: 'Telegram account is not in TELEGRAM_ADMIN_IDS' });
        return;
      }
      authorized = true;
    } else if (req.headers.authorization?.toLowerCase().startsWith('bearer ')) {
      const tok = req.headers.authorization.slice(7).trim();
      if (sessionManager.get(tok)) authorized = true;
    }

    if (!authorized) {
      res.status(401).json({ error: 'Telegram WebApp authentication or admin session required' });
      return;
    }

    const action = req.params.action;
    const b = req.body || {};
    const { host, baseUrl } = getPublicHostAndBase(req);

    if (action === 'state') {
      const items = Object.values(stateStore.state.services)
        .sort((a, b2) => b2.createdAt.localeCompare(a.createdAt))
        .map((s) => enrichService(s, req));
      const totalMem = os.totalmem();
      const memPct = totalMem > 0 ? Math.round(((totalMem - os.freemem()) / totalMem) * 100) : 0;
      const cpuPct = Math.min(100, Math.round(((os.loadavg()[0] || 0) / Math.max(1, os.cpus().length)) * 100));
      res.json({
        ok: true,
        services: items,
        total: items.length,
        active: items.filter((i) => i.active && !i.expired).length,
        near: items.filter((i) => i.active && ((i.limitBytes > 0 && i.usedBytes / i.limitBytes >= 0.85) || (i.expiresAt && Date.parse(i.expiresAt) - Date.now() <= 3 * 86400_000))).length,
        traffic: items.reduce((sum, i) => sum + i.usedBytes, 0),
        online: stateStore.connections.size,
        protocols: Array.from(LIVE_PROTOCOLS),
        groups: Object.values(stateStore.state.subscriptions).map((g) => ({
          id: g.id,
          name: g.name,
          linkIds: g.linkIds,
          count: g.linkIds.length,
          url: `${baseUrl}/p/${g.uuidKey}`,
        })),
        server: { cpu: cpuPct, ram: memPct, uptimeSec: Math.floor((Date.now() - stateStore.startedAt) / 1000) },
        host,
        support: stateStore.state.settings.supportUsername,
      });
      return;
    }

    if (action === 'create') {
      const gb = Math.max(0, Number(b.gb) || 0);
      const days = Math.max(0, Number(b.days) || 0);
      const svc = stateStore.createService({
        label: String(b.label || '').trim() || generateNameSuggestions('', 1)[0],
        protocol: normalizeProtocol(b.protocol || 'vless-ws'),
        limitBytes: gb > 0 ? parseSizeToBytes(gb, 'GB') : 0,
        expiresAt: days > 0 ? new Date(Date.now() + days * 86400_000).toISOString() : null,
        ipLimit: Math.max(0, Number(b.ipLimit) || 0),
        note: String(b.note || ''),
      });
      res.json({ ok: true, service: enrichService(svc, req) });
      return;
    }

    if (action === 'edit') {
      const uid = String(b.id || '');
      const op = String(b.op || '');
      const svc = stateStore.state.services[uid];
      if (!svc) {
        res.status(404).json({ error: 'Service not found' });
        return;
      }
      if (op === 'del') stateStore.removeService(uid);
      else if (op === 'toggle') {
        svc.active = !svc.active;
        stateStore.saveNow();
      } else if (op === 'gb') {
        svc.limitBytes += parseSizeToBytes(Number(b.v) || 10, 'GB');
        stateStore.saveNow();
      } else if (op === 'd') {
        const base = svc.expiresAt ? Math.max(Date.now(), Date.parse(svc.expiresAt)) : Date.now();
        svc.expiresAt = new Date(base + (Number(b.v) || 30) * 86400_000).toISOString();
        stateStore.saveNow();
      } else if (op === 'reset') {
        svc.usedBytes = 0;
        stateStore.saveNow();
      } else if (op === 'rname') {
        svc.label = generateNameSuggestions('', 1)[0];
        stateStore.saveNow();
      }
      res.json({ ok: true });
      return;
    }

    if (action === 'group_create') {
      const group = stateStore.createSubscriptionGroup({
        name: String(b.name || 'Mobile Group'),
        linkIds: Array.isArray(b.ids) ? b.ids.map(String) : [],
      });
      res.json({ ok: true, group });
      return;
    }

    if (action === 'group_del') {
      stateStore.removeSubscriptionGroup(String(b.gid || ''));
      res.json({ ok: true });
      return;
    }

    if (action === 'activity') {
      res.json({ ok: true, logs: stateStore.state.activityLogs.slice(0, 60) });
      return;
    }

    if (action === 'support') {
      stateStore.state.settings.supportUsername = String(b.v || '').trim().replace(/^@/, '').slice(0, 32);
      stateStore.saveNow();
      res.json({ ok: true });
      return;
    }

    res.status(404).json({ error: 'Unknown Mini App action' });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // ADMINS, RBAC & PUBLIC ACCESS REQUESTS
  // ═════════════════════════════════════════════════════════════════════════

  router.get('/api/permissions', requireAuth, (_req, res) => {
    res.json({ ok: true, permissions: ALL_PERMISSIONS });
  });

  router.get('/api/admins', requireOwner, (_req, res) => {
    const admins = Object.values(stateStore.state.admins).map(({ passwordHash: _ph, ...rest }) => rest);
    res.json({ ok: true, admins });
  });

  router.post('/api/admins', requireOwner, (req, res) => {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    if (username.length < 3 || password.length < 6) {
      res.status(400).json({ error: 'Username (min 3 chars) and password (min 6 chars) are required' });
      return;
    }
    const exists = Object.values(stateStore.state.admins).some((a) => a.username === username);
    if (exists || username === stateStore.state.settings.ownerUsername) {
      res.status(409).json({ error: 'Username already exists' });
      return;
    }
    const id = crypto.randomBytes(6).toString('hex');
    const perms = Array.isArray(req.body?.permissions) ? req.body.permissions.map(String) : ['dashboard'];
    const allowedInbounds = Array.isArray(req.body?.allowedInbounds) ? req.body.allowedInbounds.map(String) : [];
    const account = {
      id,
      username,
      passwordHash: hashPassword(password),
      role: 'admin' as const,
      active: true,
      permissions: perms,
      allowedInbounds,
      permV2: true,
      note: String(req.body?.note || '').trim().slice(0, 200),
      createdAt: new Date().toISOString(),
    };
    stateStore.state.admins[id] = account;
    stateStore.saveNow();
    stateStore.logActivity('auth', `Created sub-admin "${username}"`, 'ok');
    const { passwordHash: _ph, ...pub } = account;
    res.status(201).json({ ok: true, admin: pub });
  });

  router.patch('/api/admins/:id', requireOwner, (req, res) => {
    const admin = stateStore.state.admins[req.params.id];
    if (!admin) {
      res.status(404).json({ error: 'Admin not found' });
      return;
    }
    const b = req.body || {};
    if (b.active !== undefined) {
      admin.active = Boolean(b.active);
      if (!admin.active) sessionManager.revokeForAdmin(admin.id);
    }
    if (Array.isArray(b.permissions)) admin.permissions = b.permissions.map(String);
    if (Array.isArray(b.allowedInbounds)) admin.allowedInbounds = b.allowedInbounds.map(String);
    if (b.note !== undefined) admin.note = String(b.note).trim().slice(0, 200);
    if (b.password && String(b.password).length >= 6) {
      admin.passwordHash = hashPassword(String(b.password));
    }
    stateStore.saveNow();
    const { passwordHash: _ph, ...pub } = admin;
    res.json({ ok: true, admin: pub });
  });

  router.delete('/api/admins/:id', requireOwner, (req, res) => {
    const admin = stateStore.state.admins[req.params.id];
    if (!admin) {
      res.status(404).json({ error: 'Admin not found' });
      return;
    }
    delete stateStore.state.admins[req.params.id];
    sessionManager.revokeForAdmin(req.params.id);
    stateStore.saveNow();
    stateStore.logActivity('auth', `Deleted sub-admin "${admin.username}"`, 'warn');
    res.json({ ok: true });
  });

  // Public sub-admin access request submission
  router.post('/api/admin-requests', (req, res) => {
    const ip = getClientIp(req);
    const last = adminRequestCooldown.get(ip) || 0;
    if (Date.now() - last < 60_000) {
      res.status(429).json({ error: 'Please wait 60 seconds before submitting another request' });
      return;
    }
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    const contact = String(req.body?.contact || '').trim().slice(0, 120);
    const reason = String(req.body?.reason || '').trim().slice(0, 300);
    if (username.length < 3 || password.length < 6) {
      res.status(400).json({ error: 'Username (min 3 chars) and password (min 6 chars) are required' });
      return;
    }
    const id = crypto.randomBytes(6).toString('hex');
    stateStore.state.adminRequests[id] = {
      id,
      username,
      passwordHash: hashPassword(password),
      contact,
      reason,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    adminRequestCooldown.set(ip, Date.now());
    stateStore.saveNow();
    stateStore.logActivity('auth', `New admin access request from "${username}"`, 'info');
    res.status(201).json({ ok: true, requestId: id });
  });

  router.get('/api/admin-requests', requireOwner, (_req, res) => {
    const list = Object.values(stateStore.state.adminRequests)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(({ passwordHash: _ph, ...rest }) => rest);
    res.json({ ok: true, requests: list });
  });

  router.post('/api/admin-requests/:id/approve', requireOwner, (req, res) => {
    const item = stateStore.state.adminRequests[req.params.id];
    if (!item || item.status !== 'pending') {
      res.status(404).json({ error: 'Pending request not found' });
      return;
    }
    const permissions = Array.isArray(req.body?.permissions) ? req.body.permissions.map(String) : ['dashboard', 'inbounds'];
    const allowedInbounds = Array.isArray(req.body?.allowedInbounds) ? req.body.allowedInbounds.map(String) : [];
    const adminId = crypto.randomBytes(6).toString('hex');
    stateStore.state.admins[adminId] = {
      id: adminId,
      username: item.username,
      passwordHash: item.passwordHash,
      role: 'admin',
      active: true,
      permissions,
      allowedInbounds,
      permV2: true,
      note: `Approved request (${item.contact || 'no contact'})`,
      createdAt: new Date().toISOString(),
    };
    item.status = 'approved';
    item.reviewedAt = new Date().toISOString();
    stateStore.saveNow();
    stateStore.logActivity('auth', `Approved admin request for "${item.username}"`, 'ok');
    res.json({ ok: true, adminId });
  });

  router.post('/api/admin-requests/:id/reject', requireOwner, (req, res) => {
    const item = stateStore.state.adminRequests[req.params.id];
    if (!item) {
      res.status(404).json({ error: 'Request not found' });
      return;
    }
    item.status = 'rejected';
    item.reviewedAt = new Date().toISOString();
    stateStore.saveNow();
    res.json({ ok: true });
  });

  router.delete('/api/admin-requests/:id', requireOwner, (req, res) => {
    delete stateStore.state.adminRequests[req.params.id];
    stateStore.saveNow();
    res.json({ ok: true });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // ACTIVITY, ERRORS, LIVE CONNECTIONS & REPORTS
  // ═════════════════════════════════════════════════════════════════════════

  router.get('/api/activity', requirePerm('messages'), (_req, res) => {
    res.json({ ok: true, logs: stateStore.state.activityLogs });
  });

  router.get('/api/errors', requirePerm('messages'), (_req, res) => {
    res.json({ ok: true, errors: stateStore.state.errorLogs });
  });

  router.post('/api/errors/clear', requireOwner, (_req, res) => {
    stateStore.state.errorLogs = [];
    stateStore.saveNow();
    res.json({ ok: true });
  });

  router.get('/api/connections', requirePerm('live_connections'), (_req, res) => {
    const list = Array.from(stateStore.connections.values()).map(({ close: _c, ...rest }) => rest);
    res.json({ ok: true, connections: list });
  });

  router.delete('/api/connections/:connId', requirePerm('live_connections'), (req, res) => {
    const conn = stateStore.connections.get(req.params.connId);
    if (!conn) {
      res.status(404).json({ error: 'Connection not found' });
      return;
    }
    conn.close?.();
    stateStore.connections.delete(req.params.connId);
    res.json({ ok: true });
  });

  router.get('/api/reports/summary', requirePerm('reports'), (req, res) => {
    const days = Math.max(1, Math.min(180, Number(req.query.days) || 14));
    const series = [];
    const now = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 86400_000);
      const key = d.toISOString().slice(0, 10);
      const bucket = stateStore.state.dailyStats[key] || { trafficBytes: 0, newLinks: 0, orders: 0, stars: 0 };
      series.push({
        date: key,
        trafficMb: Math.round((bucket.trafficBytes / (1024 * 1024)) * 100) / 100,
        newLinks: bucket.newLinks,
        orders: bucket.orders,
        stars: bucket.stars,
      });
    }

    const services = Object.values(stateStore.state.services);
    const protoMap = new Map<string, number>();
    for (const s of services) {
      const lbl = protocolDisplayLabel(s);
      protoMap.set(lbl, (protoMap.get(lbl) || 0) + 1);
    }

    const topServices = [...services]
      .sort((a, b) => b.usedBytes - a.usedBytes)
      .slice(0, 10)
      .map((s) => ({
        id: s.id,
        label: s.label,
        protocol: protocolDisplayLabel(s),
        usedBytes: s.usedBytes,
        limitBytes: s.limitBytes,
        active: s.active,
      }));

    res.json({
      ok: true,
      series,
      protocolDistribution: Array.from(protoMap.entries()).map(([protocol, count]) => ({ protocol, count })),
      topServices,
      sales: salesEngine.getStats(),
    });
  });

  router.get('/api/reports/export.csv', requirePerm('reports'), (_req, res) => {
    const rows = ['id,label,protocol,active,used_bytes,limit_bytes,expires_at,created_at'];
    for (const s of Object.values(stateStore.state.services)) {
      rows.push(
        [
          s.id,
          `"${s.label.replace(/"/g, '""')}"`,
          s.protocol,
          String(s.active),
          String(s.usedBytes),
          String(s.limitBytes),
          s.expiresAt || '',
          s.createdAt,
        ].join(',')
      );
    }
    res.setHeader('Content-Disposition', 'attachment; filename="artena-services-report.csv"');
    res.type('text/csv; charset=utf-8').send(rows.join('\n'));
  });

  // ═════════════════════════════════════════════════════════════════════════
  // SETTINGS & TELEGRAM BOT CONTROLS
  // ═════════════════════════════════════════════════════════════════════════

  router.get('/api/settings', requireOwner, (_req, res) => {
    const { ownerPasswordHash: _ph, botToken, ...safe } = stateStore.state.settings;
    res.json({
      ok: true,
      settings: {
        ...safe,
        hasBotToken: Boolean(botToken),
        botTokenMasked: botToken ? `${botToken.slice(0, 6)}…${botToken.slice(-4)}` : '',
      },
      bot: telegramBotService.getStatus(),
      tcpRelay: getTcpRelayStatus(),
    });
  });

  router.post('/api/settings', requireOwner, async (req, res) => {
    const b = req.body || {};
    const s = stateStore.state.settings;
    let botChanged = false;

    if (b.publicBaseUrl !== undefined) {
      const raw = String(b.publicBaseUrl || '').trim();
      if (raw) {
        const check = validateExternalHttpUrl(raw);
        if (!check.ok) {
          res.status(400).json({ error: check.error });
          return;
        }
        s.publicBaseUrl = check.origin;
      } else {
        s.publicBaseUrl = '';
      }
    }
    if (b.tcpPublicHost !== undefined) s.tcpPublicHost = String(b.tcpPublicHost || '').trim();
    if (b.tcpPublicPort !== undefined) s.tcpPublicPort = String(b.tcpPublicPort || '').trim();
    if (b.supportUsername !== undefined) s.supportUsername = String(b.supportUsername || '').trim().replace(/^@/, '').slice(0, 32);
    if (b.channelUsername !== undefined) s.channelUsername = String(b.channelUsername || '').trim().replace(/^@/, '').slice(0, 32);

    const boolKeys = [
      'nameStyleEnabled',
      'subRemarkShowName',
      'subRemarkShowVolume',
      'subRemarkShowId',
      'subRemarkShowInbound',
      'subInfoLineEnabled',
      'subInfoLineShowVolume',
      'subInfoLineShowExpiry',
      'botAutoStart',
      'alertsEnabled',
    ] as const;
    for (const k of boolKeys) {
      if (b[k] !== undefined) s[k] = Boolean(b[k]);
    }

    if (typeof b.botToken === 'string' && b.botToken.trim().length > 0) {
      s.botToken = b.botToken.trim();
      botChanged = true;
    }
    if (b.clearBotToken === true) {
      s.botToken = '';
      botChanged = true;
    }
    if (b.botAdminIds !== undefined) {
      s.botAdminIds = String(b.botAdminIds || '').trim();
      botChanged = true;
    }

    stateStore.saveNow();
    if (botChanged && telegramBotService.getStatus().running) {
      if (s.botToken) await telegramBotService.restart();
      else await telegramBotService.stop();
    }
    stateStore.logActivity('system', 'Panel configuration saved', 'ok');
    res.json({ ok: true, bot: telegramBotService.getStatus() });
  });

  router.get('/api/bot/texts', requirePerm('bot'), (_req, res) => {
    res.json({ ok: true, texts: stateStore.state.settings.botTexts });
  });

  router.post('/api/bot/texts', requirePerm('bot'), (req, res) => {
    const incoming = req.body?.texts;
    if (!incoming || typeof incoming !== 'object') {
      res.status(400).json({ error: 'Invalid texts object' });
      return;
    }
    for (const [k, v] of Object.entries(incoming)) {
      if (typeof v === 'string') {
        stateStore.state.settings.botTexts[k] = v.slice(0, 1000);
      }
    }
    stateStore.saveNow();
    stateStore.logActivity('bot', 'Updated Telegram bot message templates', 'ok');
    res.json({ ok: true, texts: stateStore.state.settings.botTexts });
  });

  router.post('/api/settings/bot/start', requireOwner, async (_req, res) => {
    await telegramBotService.start();
    res.json({ ok: true, bot: telegramBotService.getStatus() });
  });

  router.post('/api/settings/bot/stop', requireOwner, async (_req, res) => {
    await telegramBotService.stop();
    res.json({ ok: true, bot: telegramBotService.getStatus() });
  });

  return router;
}
