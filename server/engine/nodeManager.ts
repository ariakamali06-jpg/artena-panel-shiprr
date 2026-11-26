import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { NodeHealthStatus, NodeRecord } from '../types';
import { atomicWriteJson, readJsonFile, stateStore } from '../store/stateStore';
import { nodeAuthLimiter, validateExternalHttpUrl } from './security';

const MAX_NODES = 50;
const ALLOWED_FORWARD_PREFIXES = [
  '/api/node/info',
  '/api/services',
  '/api/links',
  '/api/subscriptions',
  '/api/subs',
  '/api/categories',
  '/api/proxies',
  '/api/stats',
  '/api/telemetry',
  '/api/connections',
  '/api/reports',
];

export function isNodePathAllowed(targetPath: string): boolean {
  const normalized = targetPath.startsWith('/') ? targetPath : `/${targetPath}`;
  if (normalized.includes('..')) return false;
  return ALLOWED_FORWARD_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
}

interface NodeTokenStore {
  token: string;
  createdAt: string;
}

class NodeFederationManager {
  private readonly nodesFile: string;
  private readonly tokenFile: string;
  public nodes = new Map<string, NodeRecord>();
  public statuses = new Map<string, NodeHealthStatus>();
  public localToken: NodeTokenStore = { token: '', createdAt: '' };

  constructor() {
    this.nodesFile = path.join(stateStore.dataDir, 'kestrel_nodes.json');
    this.tokenFile = path.join(stateStore.dataDir, 'kestrel_node_token.json');
    this.load();
  }

  private load(): void {
    const savedNodes = readJsonFile<Record<string, NodeRecord>>(this.nodesFile, {});
    this.nodes.clear();
    for (const [id, n] of Object.entries(savedNodes)) this.nodes.set(id, n);
    this.localToken = readJsonFile<NodeTokenStore>(this.tokenFile, { token: '', createdAt: '' });
  }

  private saveNodes(): void {
    const obj: Record<string, NodeRecord> = {};
    for (const [id, n] of this.nodes.entries()) obj[id] = n;
    atomicWriteJson(this.nodesFile, obj);
  }

  private saveToken(): void {
    atomicWriteJson(this.tokenFile, this.localToken);
  }

  public getTokenState() {
    return {
      enabled: Boolean(this.localToken.token),
      token: this.localToken.token || null,
      createdAt: this.localToken.createdAt || null,
    };
  }

  public rotateLocalToken(): NodeTokenStore {
    const hadExisting = Boolean(this.localToken.token);
    this.localToken = {
      token: `kn_${crypto.randomBytes(24).toString('base64url')}`,
      createdAt: new Date().toISOString(),
    };
    this.saveToken();
    stateStore.logActivity(
      'network',
      hadExisting ? 'Rotated node federation token (previous token invalidated)' : 'Generated node federation token',
      hadExisting ? 'warn' : 'ok'
    );
    return this.localToken;
  }

  public disableLocalToken(): void {
    this.localToken = { token: '', createdAt: '' };
    this.saveToken();
    stateStore.logActivity('network', 'Disabled node federation token', 'warn');
  }

  public authorizeNodeBearer(authHeader: string | undefined, requestPath: string, ip: string): { ok: boolean; status?: number; error?: string } {
    if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
      return { ok: false };
    }
    if (nodeAuthLimiter.isBlocked(ip)) {
      return { ok: false, status: 429, error: 'Too many failed node authentication attempts' };
    }
    const presented = authHeader.slice(7).trim();
    if (!this.localToken.token) {
      nodeAuthLimiter.registerFailure(ip);
      return { ok: false };
    }
    const a = Buffer.from(presented);
    const b = Buffer.from(this.localToken.token);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      nodeAuthLimiter.registerFailure(ip);
      return { ok: false };
    }
    if (!isNodePathAllowed(requestPath)) {
      return { ok: false, status: 403, error: 'Path is not allowed via node federation token' };
    }
    nodeAuthLimiter.clear(ip);
    return { ok: true };
  }

  public getLocalNodeInfo() {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const memPct = totalMem > 0 ? Math.round(((totalMem - freeMem) / totalMem) * 1000) / 10 : 0;
    const load = os.loadavg()[0] || 0;
    const cpuCount = Math.max(1, os.cpus().length);
    const cpuPct = Math.min(100, Math.round((load / cpuCount) * 1000) / 10);
    const services = Object.values(stateStore.state.services);
    return {
      ok: true,
      version: '2.0.0',
      uptimeSec: Math.floor((Date.now() - stateStore.startedAt) / 1000),
      totalLinks: services.length,
      activeLinks: services.filter((s) => s.active).length,
      liveConnections: stateStore.connections.size,
      totalBytes: stateStore.state.stats.totalBytes,
      cpu: cpuPct,
      mem: memPct,
      time: new Date().toISOString(),
    };
  }

  public publicNode(n: NodeRecord) {
    return {
      id: n.id,
      name: n.name,
      url: n.url,
      enabled: n.enabled,
      createdAt: n.createdAt,
      tokenHint: n.token ? `…${n.token.slice(-4)}` : '',
      status: this.statuses.get(n.id) || null,
    };
  }

  public list() {
    return Array.from(this.nodes.values())
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((n) => this.publicNode(n));
  }

  public upsert(input: { id?: string; name?: string; url: string; token?: string; enabled?: boolean }): NodeRecord {
    const validated = validateExternalHttpUrl(input.url);
    if (!validated.ok) throw new Error(validated.error);

    const existing = input.id ? this.nodes.get(input.id) : undefined;
    if (input.id && !existing) throw new Error('Node not found');

    if (!existing) {
      if (this.nodes.size >= MAX_NODES) throw new Error(`Maximum of ${MAX_NODES} nodes reached`);
      if (!input.token?.trim()) throw new Error('Node token is required');
      for (const n of this.nodes.values()) {
        if (n.url === validated.origin) throw new Error('A node with this URL already exists');
      }
    }

    const id = existing?.id || crypto.randomBytes(6).toString('hex');
    const record: NodeRecord = {
      id,
      name: (input.name || existing?.name || validated.url.hostname).trim().slice(0, 60),
      url: validated.origin,
      token: input.token?.trim() || existing?.token || '',
      enabled: input.enabled !== undefined ? Boolean(input.enabled) : existing?.enabled ?? true,
      createdAt: existing?.createdAt || new Date().toISOString(),
    };

    this.nodes.set(id, record);
    this.statuses.delete(id);
    this.saveNodes();
    stateStore.logActivity('network', `${existing ? 'Updated' : 'Added'} federated node "${record.name}"`, 'ok');
    return record;
  }

  public delete(id: string): boolean {
    const existing = this.nodes.get(id);
    if (!existing) return false;
    this.nodes.delete(id);
    this.statuses.delete(id);
    this.saveNodes();
    stateStore.markNodeOrphanedInSubs(id);
    stateStore.logActivity('network', `Removed federated node "${existing.name}"`, 'warn');
    return true;
  }

  public async probeNode(url: string, token: string): Promise<NodeHealthStatus> {
    const validated = validateExternalHttpUrl(url);
    if (!validated.ok) {
      return { online: false, checkedAt: new Date().toISOString(), error: validated.error };
    }
    const start = performance.now();
    try {
      const resp = await fetch(`${validated.origin}/api/node/info`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'User-Agent': 'Artena-Panel/2.0',
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(7000),
      });
      const latencyMs = Math.round(performance.now() - start);
      if (resp.status === 401 || resp.status === 403) {
        return { online: false, checkedAt: new Date().toISOString(), latencyMs, error: 'Invalid node token' };
      }
      if (!resp.ok) {
        return { online: false, checkedAt: new Date().toISOString(), latencyMs, error: `HTTP ${resp.status}` };
      }
      const data = (await resp.json()) as Record<string, unknown>;
      return {
        online: true,
        checkedAt: new Date().toISOString(),
        latencyMs,
        version: String(data.version || ''),
        activeLinks: Number(data.activeLinks ?? data.active_links ?? 0),
        totalLinks: Number(data.totalLinks ?? data.total_links ?? 0),
        liveConnections: Number(data.liveConnections ?? data.connections ?? 0),
        totalBytes: Number(data.totalBytes ?? data.total_bytes ?? 0),
        cpu: Number(data.cpu ?? 0),
        mem: Number(data.mem ?? 0),
        error: '',
      };
    } catch (err) {
      return {
        online: false,
        checkedAt: new Date().toISOString(),
        error: err instanceof Error ? err.message : 'Node unreachable',
      };
    }
  }

  public async checkNode(id: string): Promise<NodeHealthStatus | null> {
    const node = this.nodes.get(id);
    if (!node) return null;
    const status = await this.probeNode(node.url, node.token);
    this.statuses.set(id, status);
    return status;
  }

  public async checkAll(): Promise<void> {
    await Promise.all(
      Array.from(this.nodes.values())
        .filter((n) => n.enabled)
        .map((n) => this.checkNode(n.id))
    );
  }

  public async callNodeJson<T = Record<string, unknown>>(
    nodeId: string,
    method: string,
    targetPath: string,
    body?: unknown
  ): Promise<T> {
    const node = this.nodes.get(nodeId);
    if (!node) throw new Error('Node not found');
    if (!node.enabled) throw new Error(`Node "${node.name}" is disabled`);
    if (!isNodePathAllowed(targetPath)) throw new Error('Path is not allowed on remote nodes');

    const resp = await fetch(`${node.url}${targetPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${node.token}`,
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(12_000),
    });

    if (resp.status === 401 || resp.status === 403) {
      throw new Error(`Authentication failed against node "${node.name}"`);
    }
    if (!resp.ok) {
      throw new Error(`Node "${node.name}" responded with HTTP ${resp.status}`);
    }
    return (await resp.json()) as T;
  }
}

export const nodeManager = new NodeFederationManager();
