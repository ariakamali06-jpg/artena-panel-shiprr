import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  ActiveConnection,
  ActivityEntry,
  AdminAccessRequest,
  AdminAccount,
  CategoryRecord,
  DailyStatBucket,
  ErrorEntry,
  ManualFields,
  PanelSettings,
  ProtocolPreset,
  ServiceRecord,
  SubscriptionGroup,
} from '../types';
import { GRANULAR_PERMISSIONS } from '../types';
import { hashPassword, verifyPassword } from '../engine/security';
import { normalizeProtocol } from '../engine/uriBuilder';
import { speedLimiter } from '../engine/rateLimiter';

const DEFAULT_BOT_TEXTS: Record<string, string> = {
  welcome_admin: 'Artena Panel Bot is online. Use the menu below to manage services, subscription groups, and live nodes.',
  welcome_customer: 'Welcome to Artena Relay Service. Choose a plan below to activate instant multi-protocol access.',
  purchase_success: 'Your service has been provisioned. Open the subscription link below to configure your client.',
  help_text: 'Commands: /menu, /new, /quick, /online, /top, /expiring, /server, /backup, /bulk, /alerts, /find, /seturl, /id',
};

export interface PersistedState {
  services: Record<string, ServiceRecord>;
  subscriptions: Record<string, SubscriptionGroup>;
  categories: Record<string, CategoryRecord>;
  admins: Record<string, AdminAccount>;
  adminRequests: Record<string, AdminAccessRequest>;
  settings: PanelSettings;
  stats: {
    totalBytes: number;
    totalRequests: number;
    totalErrors: number;
  };
  dailyStats: Record<string, DailyStatBucket>;
  hourlyTraffic: Record<string, number>;
  activityLogs: ActivityEntry[];
  errorLogs: ErrorEntry[];
}

export function resolveDataDir(): string {
  const configured = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || './data';
  return path.resolve(process.cwd(), configured);
}

export function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
}

export function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(raw) as T;
    }
  } catch {
    // Fall back gracefully if file is missing or unreadable
  }
  return fallback;
}

class StateStore {
  public readonly dataDir: string;
  public readonly stateFile: string;
  public readonly startedAt: number = Date.now();
  public readonly connections = new Map<string, ActiveConnection>();
  public state: PersistedState;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private historyInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.dataDir = resolveDataDir();
    this.stateFile = path.join(this.dataDir, 'kestrel_state.json');
    this.state = this.createEmptyState();
    this.load();
    this.ensureDefaults();
    this.startHistorySampler();
  }

  private createEmptyState(): PersistedState {
    return {
      services: {},
      subscriptions: {},
      categories: {},
      admins: {},
      adminRequests: {},
      settings: {
        ownerUsername: (process.env.ADMIN_USERNAME || 'admin').trim() || 'admin',
        ownerPasswordHash: '',
        publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').trim(),
        tcpPublicHost: (process.env.TCP_PUBLIC_HOST || '').trim(),
        tcpPublicPort: (process.env.TCP_PUBLIC_PORT || '').trim(),
        supportUsername: '',
        channelUsername: '',
        nameStyleEnabled: true,
        subRemarkShowName: true,
        subRemarkShowVolume: false,
        subRemarkShowId: false,
        subRemarkShowInbound: false,
        subInfoLineEnabled: true,
        subInfoLineShowVolume: true,
        subInfoLineShowExpiry: true,
        botToken: (process.env.TELEGRAM_BOT_TOKEN || '').trim(),
        botAdminIds: (process.env.TELEGRAM_ADMIN_IDS || '').trim(),
        botUsername: (process.env.TELEGRAM_BOT_USERNAME || '').trim(),
        botAutoStart: true,
        alertsEnabled: false,
        botTexts: { ...DEFAULT_BOT_TEXTS },
      },
      stats: {
        totalBytes: 0,
        totalRequests: 0,
        totalErrors: 0,
      },
      dailyStats: {},
      hourlyTraffic: {},
      activityLogs: [],
      errorLogs: [],
    };
  }

  private load(): void {
    const loaded = readJsonFile<Partial<PersistedState> | null>(this.stateFile, null);
    if (!loaded || typeof loaded !== 'object') return;
    const base = this.createEmptyState();
    this.state = {
      services: loaded.services ?? {},
      subscriptions: loaded.subscriptions ?? {},
      categories: loaded.categories ?? {},
      admins: loaded.admins ?? {},
      adminRequests: loaded.adminRequests ?? {},
      settings: {
        ...base.settings,
        ...(loaded.settings ?? {}),
        botTexts: { ...DEFAULT_BOT_TEXTS, ...(loaded.settings?.botTexts ?? {}) },
      },
      stats: { ...base.stats, ...(loaded.stats ?? {}) },
      dailyStats: loaded.dailyStats ?? {},
      hourlyTraffic: loaded.hourlyTraffic ?? {},
      activityLogs: Array.isArray(loaded.activityLogs) ? loaded.activityLogs.slice(0, 500) : [],
      errorLogs: Array.isArray(loaded.errorLogs) ? loaded.errorLogs.slice(0, 300) : [],
    };

    // Environment overrides take precedence when explicitly provided
    if (process.env.TELEGRAM_BOT_TOKEN && !this.state.settings.botToken) {
      this.state.settings.botToken = process.env.TELEGRAM_BOT_TOKEN.trim();
    }
    if (process.env.TELEGRAM_ADMIN_IDS && !this.state.settings.botAdminIds) {
      this.state.settings.botAdminIds = process.env.TELEGRAM_ADMIN_IDS.trim();
    }
    if (process.env.PUBLIC_BASE_URL && !this.state.settings.publicBaseUrl) {
      this.state.settings.publicBaseUrl = process.env.PUBLIC_BASE_URL.trim();
    }
  }

  private ensureDefaults(): void {
    let changed = false;
    if (!this.state.categories['general']) {
      this.state.categories['general'] = {
        id: 'general',
        name: 'General',
        color: '#0D9488',
        description: 'Default service tier',
        createdAt: new Date().toISOString(),
      };
      changed = true;
    }
    if (!this.state.categories['premium']) {
      this.state.categories['premium'] = {
        id: 'premium',
        name: 'Dedicated',
        color: '#2563EB',
        description: 'High-throughput dedicated endpoints',
        createdAt: new Date().toISOString(),
      };
      changed = true;
    }

    if (Object.keys(this.state.services).length === 0) {
      const uid = crypto.randomUUID();
      this.state.services[uid] = {
        id: uid,
        label: 'Primary-WS-Edge',
        active: true,
        limitBytes: 100 * 1024 ** 3,
        usedBytes: 0,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
        note: 'Initial VLESS-WS relay endpoint',
        isDefault: true,
        subId: null,
        parentInboundId: null,
        protocol: 'vless-ws',
        fingerprint: 'chrome',
        alpn: 'http/1.1',
        port: 443,
        ipLimit: 3,
        speedLimitBytes: 0,
        connectionLimit: 0,
        fragment: 'off',
        cleanIps: [],
        alarmEnabled: true,
        categoryId: 'general',
        outboundProxyId: '',
        usageHistory: [],
      };
      this.logActivity('system', 'Initialized default VLESS-WS relay service', 'info');
      changed = true;
    }

    if (changed) {
      this.saveNow();
    }
  }

  private startHistorySampler(): void {
    if (this.historyInterval) return;
    this.historyInterval = setInterval(() => {
      const ts = new Date().toISOString();
      let updated = false;
      for (const svc of Object.values(this.state.services)) {
        const last = svc.usageHistory[svc.usageHistory.length - 1];
        if (!last || last.bytes !== svc.usedBytes) {
          svc.usageHistory.push({ ts, bytes: svc.usedBytes });
          if (svc.usageHistory.length > 48) {
            svc.usageHistory = svc.usageHistory.slice(-48);
          }
          updated = true;
        }
      }
      if (updated) this.scheduleSave();
    }, 5 * 60 * 1000);
    this.historyInterval.unref?.();
  }

  public stopTimers(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.historyInterval) {
      clearInterval(this.historyInterval);
      this.historyInterval = null;
    }
    this.saveNow();
  }

  public saveNow(): void {
    try {
      atomicWriteJson(this.stateFile, this.state);
    } catch (err) {
      console.error('[stateStore] Failed to persist state:', err);
    }
  }

  public scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow();
    }, 350);
  }

  public todayKey(): string {
    return new Date().toISOString().slice(0, 10);
  }

  public hourKey(): string {
    return `${String(new Date().getHours()).padStart(2, '0')}:00`;
  }

  public bumpDailyStat(field: keyof DailyStatBucket, amount = 1): void {
    const key = this.todayKey();
    if (!this.state.dailyStats[key]) {
      this.state.dailyStats[key] = { trafficBytes: 0, newLinks: 0, orders: 0, stars: 0 };
    }
    this.state.dailyStats[key][field] += amount;
  }

  public recordTraffic(serviceId: string, bytes: number): boolean {
    const svc = this.state.services[serviceId];
    if (!svc || !svc.active) return false;
    if (svc.expiresAt && Date.parse(svc.expiresAt) <= Date.now()) return false;
    if (svc.limitBytes > 0 && svc.usedBytes >= svc.limitBytes) return false;

    svc.usedBytes += bytes;
    this.state.stats.totalBytes += bytes;
    this.bumpDailyStat('trafficBytes', bytes);
    const hk = this.hourKey();
    this.state.hourlyTraffic[hk] = (this.state.hourlyTraffic[hk] || 0) + bytes;
    this.scheduleSave();
    return true;
  }

  public logActivity(kind: ActivityEntry['kind'], message: string, level: ActivityEntry['level'] = 'info'): void {
    this.state.activityLogs.unshift({
      id: crypto.randomBytes(6).toString('hex'),
      kind,
      message,
      level,
      time: new Date().toISOString(),
    });
    if (this.state.activityLogs.length > 500) {
      this.state.activityLogs.length = 500;
    }
    this.scheduleSave();
  }

  public logError(source: string, error: string): void {
    this.state.stats.totalErrors += 1;
    this.state.errorLogs.unshift({
      id: crypto.randomBytes(6).toString('hex'),
      source,
      error: String(error).slice(0, 500),
      time: new Date().toISOString(),
    });
    if (this.state.errorLogs.length > 300) {
      this.state.errorLogs.length = 300;
    }
    this.scheduleSave();
  }

  // ── Owner & Admin Authentication ──────────────────────────────────────────

  public needsInitialOwnerSetup(): boolean {
    const envPass = (process.env.ADMIN_PASSWORD || '').trim();
    if (envPass.length > 0) return false;
    return !this.state.settings.ownerPasswordHash;
  }

  public claimInitialOwner(username: string, password: string): void {
    if (!this.needsInitialOwnerSetup()) {
      throw new Error('Owner account has already been configured');
    }
    this.state.settings.ownerUsername = username.trim();
    this.state.settings.ownerPasswordHash = hashPassword(password);
    this.logActivity('auth', `Initial owner account "${username.trim()}" claimed`, 'ok');
    this.saveNow();
  }

  public verifyCredentials(username: string, password: string): {
    adminId: string;
    username: string;
    role: 'owner' | 'admin';
  } | null {
    const cleanUser = username.trim();
    const envUser = (process.env.ADMIN_USERNAME || '').trim();
    const envPass = (process.env.ADMIN_PASSWORD || '').trim();
    const ownerUser = envUser || this.state.settings.ownerUsername || 'admin';

    // 1. Check owner account (env password overrides stored hash when present)
    if (cleanUser === ownerUser) {
      if (envPass.length > 0) {
        const a = Buffer.from(password);
        const b = Buffer.from(envPass);
        if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
          return { adminId: 'owner', username: ownerUser, role: 'owner' };
        }
      } else if (this.state.settings.ownerPasswordHash) {
        if (verifyPassword(password, this.state.settings.ownerPasswordHash)) {
          return { adminId: 'owner', username: ownerUser, role: 'owner' };
        }
      }
      return null;
    }

    // 2. Check sub-admins
    for (const admin of Object.values(this.state.admins)) {
      if (admin.username === cleanUser && admin.active) {
        if (verifyPassword(password, admin.passwordHash)) {
          return { adminId: admin.id, username: admin.username, role: 'admin' };
        }
        return null;
      }
    }
    return null;
  }

  public hasPermission(adminId: string, permission: string): boolean {
    if (adminId === 'owner') return true;
    const admin = this.state.admins[adminId];
    if (!admin || !admin.active) return false;
    if (admin.permissions.includes(permission)) return true;
    if (GRANULAR_PERMISSIONS.has(permission) && !admin.permV2) {
      return admin.permissions.includes('inbounds');
    }
    return false;
  }

  public getAdminScope(adminId: string): Set<string> | null {
    if (adminId === 'owner') return null;
    const admin = this.state.admins[adminId];
    if (!admin || !admin.allowedInbounds?.length) return null;
    return new Set(admin.allowedInbounds);
  }

  public isServiceInScope(adminId: string, serviceId: string): boolean {
    const scope = this.getAdminScope(adminId);
    if (!scope) return true;
    if (scope.has(serviceId)) return true;
    const svc = this.state.services[serviceId];
    if (svc?.parentInboundId && scope.has(svc.parentInboundId)) return true;
    return false;
  }

  // ── Services CRUD ─────────────────────────────────────────────────────────

  public createService(params: {
    label?: string;
    limitBytes?: number;
    expiresAt?: string | null;
    note?: string;
    subId?: string | null;
    parentInboundId?: string | null;
    protocol?: ProtocolPreset | string;
    fingerprint?: string;
    alpn?: string;
    port?: number;
    ipLimit?: number;
    speedLimitBytes?: number;
    connectionLimit?: number;
    fragment?: string;
    cleanIps?: string[];
    alarmEnabled?: boolean;
    categoryId?: string;
    outboundProxyId?: string;
    manual?: Partial<ManualFields>;
  }): ServiceRecord {
    const id = crypto.randomUUID();
    const protocol = normalizeProtocol(params.protocol);
    const port = Math.max(1, Math.min(65535, Number(params.port) || (protocol === 'vless-tcp' ? 6543 : 443)));

    const record: ServiceRecord = {
      id,
      label: (params.label || '').trim().slice(0, 80) || `Service-${id.slice(0, 6)}`,
      active: true,
      limitBytes: Math.max(0, Math.floor(Number(params.limitBytes) || 0)),
      usedBytes: 0,
      createdAt: new Date().toISOString(),
      expiresAt: params.expiresAt || null,
      note: (params.note || '').trim().slice(0, 500),
      isDefault: false,
      subId: params.subId || null,
      parentInboundId: params.parentInboundId || null,
      protocol,
      fingerprint: (params.fingerprint || 'chrome').trim().toLowerCase(),
      alpn: (params.alpn || '').trim().slice(0, 100),
      port,
      ipLimit: Math.max(0, Math.floor(Number(params.ipLimit) || 0)),
      speedLimitBytes: Math.max(0, Math.floor(Number(params.speedLimitBytes) || 0)),
      connectionLimit: Math.max(0, Math.floor(Number(params.connectionLimit) || 0)),
      fragment: (params.fragment || 'off').trim().toLowerCase(),
      cleanIps: Array.isArray(params.cleanIps) ? params.cleanIps.filter(Boolean).slice(0, 20) : [],
      alarmEnabled: Boolean(params.alarmEnabled),
      categoryId: params.categoryId || 'general',
      outboundProxyId: (params.outboundProxyId || '').trim(),
      usageHistory: [],
    };

    if (protocol === 'manual') {
      const m = params.manual ?? {};
      record.manual = {
        baseProtocol: (m.baseProtocol || 'vless') as ManualFields['baseProtocol'],
        network: (m.network || 'ws') as ManualFields['network'],
        security: (m.security || 'tls') as ManualFields['security'],
        address: (m.address || '').trim().slice(0, 255),
        path: (m.path || '').trim().slice(0, 255),
        hostHeader: (m.hostHeader || '').trim().slice(0, 255),
        sni: (m.sni || '').trim().slice(0, 255),
        flow: (m.flow || '').trim().slice(0, 64),
        grpcServiceName: (m.grpcServiceName || '').trim().slice(0, 128),
        grpcMode: (m.grpcMode || 'gun').trim().slice(0, 32),
        xhttpMode: (m.xhttpMode || 'packet-up') as ManualFields['xhttpMode'],
        headerType: (m.headerType || '').trim().slice(0, 32),
        allowInsecure: Boolean(m.allowInsecure),
        realityPublicKey: (m.realityPublicKey || '').trim().slice(0, 128),
        realityShortId: (m.realityShortId || '').trim().slice(0, 32),
        realitySpiderX: (m.realitySpiderX || '/').trim().slice(0, 128),
        ssMethod: (m.ssMethod || 'chacha20-ietf-poly1305').trim().slice(0, 80),
        ssPassword: (m.ssPassword || id).trim().slice(0, 255),
      };
    }

    this.state.services[id] = record;
    this.bumpDailyStat('newLinks', 1);

    if (record.subId && this.state.subscriptions[record.subId]) {
      const sub = this.state.subscriptions[record.subId];
      if (!sub.linkIds.includes(id)) sub.linkIds.push(id);
    }

    this.logActivity('service', `Created service "${record.label}" (${record.protocol})`, 'ok');
    this.saveNow();
    return record;
  }

  public removeService(uid: string): boolean {
    const existing = this.state.services[uid];
    if (!existing) return false;

    // Also detach/remove child clients if removing a parent inbound
    for (const [cid, child] of Object.entries(this.state.services)) {
      if (child.parentInboundId === uid) {
        delete this.state.services[cid];
        speedLimiter.reset(cid);
      }
    }

    delete this.state.services[uid];
    speedLimiter.reset(uid);

    // Close active connections for this service
    for (const [connId, conn] of this.connections.entries()) {
      if (conn.serviceId === uid) {
        conn.close?.();
        this.connections.delete(connId);
      }
    }

    // Remove from subscription groups
    for (const sub of Object.values(this.state.subscriptions)) {
      sub.linkIds = sub.linkIds.filter((x) => x !== uid);
    }

    // Remove from admin scopes
    for (const admin of Object.values(this.state.admins)) {
      admin.allowedInbounds = admin.allowedInbounds.filter((x) => x !== uid);
    }

    this.logActivity('service', `Deleted service "${existing.label}"`, 'warn');
    this.saveNow();
    return true;
  }

  public regenerateServiceUuid(oldUid: string): ServiceRecord | null {
    const existing = this.state.services[oldUid];
    if (!existing) return null;
    const newUid = crypto.randomUUID();
    const updated: ServiceRecord = { ...existing, id: newUid };

    delete this.state.services[oldUid];
    this.state.services[newUid] = updated;
    speedLimiter.reset(oldUid);

    for (const child of Object.values(this.state.services)) {
      if (child.parentInboundId === oldUid) {
        child.parentInboundId = newUid;
      }
    }
    for (const sub of Object.values(this.state.subscriptions)) {
      sub.linkIds = sub.linkIds.map((x) => (x === oldUid ? newUid : x));
    }
    for (const admin of Object.values(this.state.admins)) {
      admin.allowedInbounds = admin.allowedInbounds.map((x) => (x === oldUid ? newUid : x));
    }

    this.logActivity('service', `Regenerated UUID for "${updated.label}"`, 'warn');
    this.saveNow();
    return updated;
  }

  public createSubscriptionGroup(params: {
    name: string;
    description?: string;
    password?: string;
    linkIds?: string[];
    comboMeta?: SubscriptionGroup['comboMeta'];
  }): SubscriptionGroup {
    const id = crypto.randomBytes(6).toString('hex');
    const uuidKey = crypto.randomBytes(12).toString('base64url');
    const validLinks = (params.linkIds || []).filter((uid) => Boolean(this.state.services[uid]));

    const group: SubscriptionGroup = {
      id,
      uuidKey,
      name: params.name.trim().slice(0, 80) || 'Subscription Group',
      description: (params.description || '').trim().slice(0, 300),
      password: (params.password || '').trim().slice(0, 64),
      linkIds: Array.from(new Set(validLinks)),
      remoteLinks: [],
      createdAt: new Date().toISOString(),
      comboMeta: params.comboMeta,
    };

    this.state.subscriptions[id] = group;
    for (const uid of group.linkIds) {
      if (this.state.services[uid]) this.state.services[uid].subId = id;
    }
    this.logActivity('service', `Created subscription group "${group.name}"`, 'ok');
    this.saveNow();
    return group;
  }

  public setServiceSubscription(uid: string, subId: string | null): boolean {
    const svc = this.state.services[uid];
    if (!svc) return false;
    for (const sub of Object.values(this.state.subscriptions)) {
      sub.linkIds = sub.linkIds.filter((x) => x !== uid);
    }
    if (subId && this.state.subscriptions[subId]) {
      this.state.subscriptions[subId].linkIds.push(uid);
      svc.subId = subId;
    } else {
      svc.subId = null;
    }
    this.saveNow();
    return true;
  }

  public removeSubscriptionGroup(subId: string): boolean {
    const sub = this.state.subscriptions[subId];
    if (!sub) return false;
    for (const uid of sub.linkIds) {
      if (this.state.services[uid]?.subId === subId) {
        this.state.services[uid].subId = null;
      }
    }
    delete this.state.subscriptions[subId];
    this.logActivity('service', `Removed subscription group "${sub.name}"`, 'warn');
    this.saveNow();
    return true;
  }

  public markNodeOrphanedInSubs(nodeId: string): void {
    let changed = false;
    for (const sub of Object.values(this.state.subscriptions)) {
      for (const remote of sub.remoteLinks) {
        if (remote.nodeId === nodeId && !remote.orphaned) {
          remote.orphaned = true;
          changed = true;
        }
      }
    }
    if (changed) this.saveNow();
  }

  public getOnlineIpCount(serviceId: string): number {
    const ips = new Set<string>();
    for (const conn of this.connections.values()) {
      if (conn.serviceId === serviceId) ips.add(conn.ip);
    }
    return ips.size;
  }
}

export const stateStore = new StateStore();
