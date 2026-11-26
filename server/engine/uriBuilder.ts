import crypto from 'node:crypto';
import type {
  ManualBaseProtocol,
  ManualFields,
  NetworkTransport,
  PanelSettings,
  ProtocolPreset,
  SecurityMode,
  ServiceRecord,
  XhttpMode,
} from '../types';
import {
  ALL_PROTOCOLS,
  PROTOCOL_LABELS,
  SHADOWSOCKS_METHODS,
  TLS_FINGERPRINTS,
} from '../types';

export const MANUAL_LIVE_COMBOS = new Set([
  'ws:tls',
  'ws:none',
  'xhttp:tls',
  'xhttp:none',
  'tcp:none',
]);

export function formatBytes(bytes: number): string {
  const n = Math.max(0, Number(bytes) || 0);
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let idx = 0;
  while (v >= 1024 && idx < units.length - 1) {
    v /= 1024;
    idx += 1;
  }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[idx]}`;
}

export function parseSizeToBytes(value: number, unit = 'GB'): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const multipliers: Record<string, number> = {
    B: 1,
    KB: 1024,
    MB: 1024 ** 2,
    GB: 1024 ** 3,
    TB: 1024 ** 4,
  };
  return Math.floor(n * (multipliers[unit.toUpperCase()] ?? 1024 ** 3));
}

export function parseSpeedToBytes(value: number, unit = 'Mbps'): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  switch (unit.toLowerCase()) {
    case 'kbps':
      return Math.floor((n * 1024) / 8);
    case 'mbps':
      return Math.floor((n * 1024 * 1024) / 8);
    case 'kb/s':
      return Math.floor(n * 1024);
    case 'mb/s':
      return Math.floor(n * 1024 * 1024);
    default:
      return Math.floor((n * 1024 * 1024) / 8);
  }
}

export function normalizeProtocol(input?: string): ProtocolPreset {
  const val = String(input || 'vless-ws').trim().toLowerCase();
  const aliases: Record<string, ProtocolPreset> = {
    ws: 'vless-ws',
    vless: 'vless-ws',
    tcp: 'vless-tcp',
    xhttp: 'xhttp-packet-up',
    'xhttp-siz10': 'xhttp-packet-up',
    vmess: 'vmess-ws',
    trojan: 'trojan-ws',
  };
  const resolved = (aliases[val] ?? val) as ProtocolPreset;
  return ALL_PROTOCOLS.includes(resolved) ? resolved : 'vless-ws';
}

export function isManualComboLive(manual?: Partial<ManualFields>): boolean {
  if (!manual) return false;
  const base = (manual.baseProtocol || 'vless').toLowerCase();
  if (base !== 'vless') return false;
  const net = (manual.network || 'tcp').toLowerCase();
  const sec = (manual.security || 'none').toLowerCase();
  return MANUAL_LIVE_COMBOS.has(`${net}:${sec}`);
}

export function protocolDisplayLabel(service: Pick<ServiceRecord, 'protocol' | 'manual'>): string {
  if (service.protocol !== 'manual') {
    return PROTOCOL_LABELS[service.protocol] || service.protocol;
  }
  const m = service.manual;
  const base = (m?.baseProtocol || 'vless').toUpperCase();
  const net = (m?.network || 'tcp').toUpperCase();
  const sec = (m?.security || 'none').toUpperCase();
  if (base === 'SHADOWSOCKS') return `Shadowsocks · ${net}`;
  return `${base} · ${net} · ${sec}`;
}

export function remainingTimeText(expiresAt: string | null, nowMs = Date.now()): string {
  if (!expiresAt) return 'Unlimited';
  const targetMs = Date.parse(expiresAt);
  if (Number.isNaN(targetMs)) return 'Unlimited';
  const diffSec = Math.floor((targetMs - nowMs) / 1000);
  if (diffSec <= 0) return 'Expired';
  const days = Math.floor(diffSec / 86400);
  const hours = Math.floor((diffSec % 86400) / 3600);
  const mins = Math.floor((diffSec % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

export function buildConfigRemark(
  service: ServiceRecord,
  settings: Partial<PanelSettings>,
  parentLabel?: string
): string {
  const showName = settings.subRemarkShowName ?? true;
  const showVolume = settings.subRemarkShowVolume ?? false;
  const showId = settings.subRemarkShowId ?? false;
  const showInbound = settings.subRemarkShowInbound ?? false;

  const parts: string[] = [];
  if (showName) parts.push(service.label || 'Artena');
  if (showVolume) {
    parts.push(service.limitBytes > 0 ? formatBytes(service.limitBytes) : 'Unlimited');
  }
  if (showId) parts.push(service.id.slice(0, 8));
  if (showInbound && parentLabel) parts.push(parentLabel);

  return parts.join(' | ') || service.label || 'Artena';
}

export function buildInfoLineRemark(
  usedBytes: number,
  limitBytes: number,
  expiresAt: string | null,
  settings: Partial<PanelSettings>,
  nowMs = Date.now()
): string {
  const parts = ['Artena Status'];
  if (settings.subInfoLineShowVolume ?? true) {
    if (limitBytes > 0) {
      const rem = Math.max(0, limitBytes - usedBytes);
      parts.push(`${formatBytes(usedBytes)}/${formatBytes(limitBytes)} (${formatBytes(rem)} left)`);
    } else {
      parts.push(`${formatBytes(usedBytes)} / ∞`);
    }
  }
  if (settings.subInfoLineShowExpiry ?? true) {
    parts.push(remainingTimeText(expiresAt, nowMs));
  }
  return parts.join(' | ');
}

function encodeQuery(params: Record<string, string | undefined>): string {
  return Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v)).replace(/%2F/g, '/').replace(/%2C/g, ',')}`)
    .join('&');
}

export function buildServiceUri(
  service: ServiceRecord,
  host: string,
  options?: {
    settings?: Partial<PanelSettings>;
    parentLabel?: string;
    portOverride?: number;
    tcpPublicHost?: string;
    tcpPublicPort?: number;
    remarkOverride?: string;
  }
): string {
  const settings = options?.settings ?? {};
  const remark = options?.remarkOverride ?? buildConfigRemark(service, settings, options?.parentLabel);
  const encodedRemark = encodeURIComponent(remark);
  const fp = TLS_FINGERPRINTS.includes(service.fingerprint as (typeof TLS_FINGERPRINTS)[number])
    ? service.fingerprint
    : 'chrome';

  if (service.protocol === 'manual' && service.manual) {
    const m = service.manual;
    const base: ManualBaseProtocol = m.baseProtocol || 'vless';
    const network: NetworkTransport = m.network || 'tcp';
    const security: SecurityMode = m.security || 'none';
    const address = m.address?.trim() || host;
    const port = options?.portOverride ?? (service.port || 443);
    const defaultAlpn = network === 'xhttp' ? 'h2,http/1.1' : 'http/1.1';
    const alpn = service.alpn?.trim() || defaultAlpn;
    const xhttpMode: XhttpMode = m.xhttpMode === 'auto' ? 'packet-up' : (m.xhttpMode || 'packet-up');
    const path =
      network === 'xhttp'
        ? m.path?.trim() || `/xhttp/${xhttpMode}/${service.id}`
        : m.path?.trim() || `/${network}/${service.id}`;
    const hostHeader = m.hostHeader?.trim() || address;
    const sni = m.sni?.trim() || address;

    if (base === 'shadowsocks') {
      const method = SHADOWSOCKS_METHODS.includes(m.ssMethod as (typeof SHADOWSOCKS_METHODS)[number])
        ? m.ssMethod
        : 'chacha20-ietf-poly1305';
      const password = m.ssPassword?.trim() || service.id;
      const userinfo = Buffer.from(`${method}:${password}`).toString('base64url');
      return `ss://${userinfo}@${address}:${port}#${encodedRemark}`;
    }

    if (base === 'vmess') {
      const payload = {
        v: '2',
        ps: remark,
        add: address,
        port,
        id: service.id,
        aid: 0,
        scy: 'auto',
        net: network,
        type: 'none',
        host: network === 'ws' || network === 'xhttp' ? hostHeader : '',
        path: network === 'grpc' ? m.grpcServiceName || service.id : path,
        tls: security === 'none' ? '' : security,
        sni,
        fp,
      };
      return `vmess://${Buffer.from(JSON.stringify(payload)).toString('base64')}`;
    }

    const params: Record<string, string | undefined> = {};
    if (base === 'vless') params.encryption = 'none';
    if (security === 'tls') {
      params.security = 'tls';
      params.sni = sni;
      params.fp = fp;
      params.alpn = alpn;
      if (m.allowInsecure) params.allowInsecure = '1';
    } else if (security === 'reality') {
      params.security = 'reality';
      params.sni = sni;
      params.fp = fp;
      params.pbk = m.realityPublicKey?.trim();
      params.sid = m.realityShortId?.trim();
      params.spx = m.realitySpiderX?.trim() || '/';
    } else {
      params.security = 'none';
    }

    if (network === 'ws') {
      params.type = 'ws';
      params.path = path;
      params.host = hostHeader;
    } else if (network === 'grpc') {
      params.type = 'grpc';
      params.serviceName = m.grpcServiceName?.trim() || service.id;
      params.mode = m.grpcMode?.trim() || 'gun';
    } else if (network === 'xhttp') {
      params.type = 'xhttp';
      params.mode = xhttpMode;
      params.path = path;
      params.host = hostHeader;
    } else {
      params.type = 'tcp';
      if (m.headerType) params.headerType = m.headerType;
      if (m.flow) params.flow = m.flow;
    }

    const scheme = base === 'trojan' ? 'trojan' : 'vless';
    return `${scheme}://${service.id}@${address}:${port}?${encodeQuery(params)}#${encodedRemark}`;
  }

  // Preset protocols
  const port = options?.portOverride ?? (service.port || 443);

  if (service.protocol === 'vless-tcp') {
    const tcpHost = options?.tcpPublicHost?.trim() || host;
    const tcpPort = options?.tcpPublicPort || port || 6543;
    const qs = encodeQuery({ encryption: 'none', security: 'none', type: 'tcp' });
    return `vless://${service.id}@${tcpHost}:${tcpPort}?${qs}#${encodedRemark}`;
  }

  if (
    service.protocol === 'xhttp-packet-up' ||
    service.protocol === 'xhttp-stream-up' ||
    service.protocol === 'xhttp-stream-one'
  ) {
    const mode =
      service.protocol === 'xhttp-stream-up'
        ? 'stream-up'
        : service.protocol === 'xhttp-stream-one'
          ? 'stream-one'
          : 'packet-up';
    const routeMode = mode === 'stream-one' ? 'stream-up' : mode;
    const qs = encodeQuery({
      encryption: 'none',
      security: 'tls',
      sni: host,
      fp,
      alpn: service.alpn || 'h2,http/1.1',
      type: 'xhttp',
      mode,
      host,
      path: `/xhttp/${routeMode}/${service.id}`,
    });
    return `vless://${service.id}@${host}:${port}?${qs}#${encodedRemark}`;
  }

  if (service.protocol === 'vmess-ws') {
    const payload = {
      v: '2',
      ps: remark,
      add: host,
      port,
      id: service.id,
      aid: 0,
      scy: 'auto',
      net: 'ws',
      type: 'none',
      host,
      path: `/ws/${service.id}`,
      tls: 'tls',
      sni: host,
      fp,
    };
    return `vmess://${Buffer.from(JSON.stringify(payload)).toString('base64')}`;
  }

  if (service.protocol === 'trojan-ws') {
    const qs = encodeQuery({
      security: 'tls',
      sni: host,
      fp,
      alpn: service.alpn || 'http/1.1',
      type: 'ws',
      host,
      path: `/ws/${service.id}`,
    });
    return `trojan://${service.id}@${host}:${port}?${qs}#${encodedRemark}`;
  }

  // Default: vless-ws
  const qs = encodeQuery({
    encryption: 'none',
    security: 'tls',
    sni: host,
    fp,
    alpn: service.alpn || 'http/1.1',
    type: 'ws',
    host,
    path: `/ws/${service.id}`,
  });
  return `vless://${service.id}@${host}:${port}?${qs}#${encodedRemark}`;
}

export function buildSubscriptionHeaders(params: {
  usedBytes: number;
  limitBytes: number;
  expiresAt: string | null;
  title: string;
  infoUrl: string;
}): Record<string, string> {
  const expireTs = params.expiresAt ? Math.max(0, Math.floor(Date.parse(params.expiresAt) / 1000)) : 0;
  const userinfo = `upload=0; download=${Math.max(0, Math.floor(params.usedBytes))}; total=${Math.max(0, Math.floor(params.limitBytes))}; expire=${Number.isNaN(expireTs) ? 0 : expireTs}`;
  return {
    'Subscription-Userinfo': userinfo,
    'Profile-Update-Interval': '6',
    'Profile-Title': `base64:${Buffer.from(params.title || 'Artena').toString('base64')}`,
    'Profile-Web-Page-Url': params.infoUrl,
    'Cache-Control': 'no-store',
  };
}

/**
 * Generates a genuine X25519 keypair in Xray Reality base64url raw 32-byte format + random short ID.
 */
export function generateRealityKeypair(): {
  privateKey: string;
  publicKey: string;
  shortId: string;
} {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  const pubDer = publicKey.export({ type: 'spki', format: 'der' });
  const privDer = privateKey.export({ type: 'pkcs8', format: 'der' });
  // Raw 32-byte keys sit at the tail of X25519 SPKI/PKCS8 DER encodings
  const rawPub = pubDer.subarray(pubDer.length - 32);
  const rawPriv = privDer.subarray(privDer.length - 32);
  return {
    publicKey: rawPub.toString('base64url'),
    privateKey: rawPriv.toString('base64url'),
    shortId: crypto.randomBytes(4).toString('hex'),
  };
}

const REGIONS = ['Frankfurt', 'Zurich', 'Amsterdam', 'Helsinki', 'Tokyo', 'Singapore', 'Vienna', 'Stockholm', 'Toronto', 'London'];
const TIERS = ['Edge', 'Core', 'Relay', 'Bridge', 'Direct', 'Transit', 'Mesh', 'Stream'];

export function generateNameSuggestions(base = '', count = 10): string[] {
  const cleanBase = base.trim().replace(/[^\w\s-]/g, '').slice(0, 24);
  const results: string[] = [];
  for (let i = 0; i < count; i++) {
    const region = REGIONS[(i + Math.floor(Math.random() * REGIONS.length)) % REGIONS.length];
    const tier = TIERS[i % TIERS.length];
    const num = String(Math.floor(10 + Math.random() * 89));
    results.push(cleanBase ? `${cleanBase}-${tier}-${num}` : `${region}-${tier}-${num}`);
  }
  return Array.from(new Set(results)).slice(0, count);
}
