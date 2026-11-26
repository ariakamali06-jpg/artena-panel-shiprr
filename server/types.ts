export type ProtocolPreset =
  | 'vless-ws'
  | 'vless-tcp'
  | 'xhttp-packet-up'
  | 'xhttp-stream-up'
  | 'xhttp-stream-one'
  | 'vmess-ws'
  | 'trojan-ws'
  | 'manual';

export type ManualBaseProtocol = 'vless' | 'vmess' | 'trojan' | 'shadowsocks';
export type NetworkTransport = 'tcp' | 'ws' | 'grpc' | 'xhttp';
export type SecurityMode = 'none' | 'tls' | 'reality';
export type XhttpMode = 'auto' | 'packet-up' | 'stream-up' | 'stream-one';

export const LIVE_PROTOCOLS = new Set<ProtocolPreset>([
  'vless-ws',
  'vless-tcp',
  'xhttp-packet-up',
  'xhttp-stream-up',
  'xhttp-stream-one',
]);

export const ALL_PROTOCOLS: ProtocolPreset[] = [
  'vless-ws',
  'vless-tcp',
  'xhttp-packet-up',
  'xhttp-stream-up',
  'xhttp-stream-one',
  'vmess-ws',
  'trojan-ws',
  'manual',
];

export const PROTOCOL_LABELS: Record<ProtocolPreset, string> = {
  'vless-ws': 'VLESS · WebSocket · TLS',
  'vless-tcp': 'VLESS · Raw TCP',
  'xhttp-packet-up': 'VLESS · XHTTP (Packet-Up)',
  'xhttp-stream-up': 'VLESS · XHTTP (Stream-Up)',
  'xhttp-stream-one': 'VLESS · XHTTP (Stream-One)',
  'vmess-ws': 'VMess · WebSocket · TLS',
  'trojan-ws': 'Trojan · WebSocket · TLS',
  manual: 'Custom / Manual Builder',
};

export const TLS_FINGERPRINTS = [
  'chrome',
  'firefox',
  'safari',
  'ios',
  'android',
  'edge',
  '360',
  'qq',
  'random',
  'randomized',
] as const;

export const SHADOWSOCKS_METHODS = [
  'chacha20-ietf-poly1305',
  'aes-128-gcm',
  'aes-256-gcm',
  '2022-blake3-aes-128-gcm',
  '2022-blake3-aes-256-gcm',
] as const;

export const ALL_PERMISSIONS = [
  { key: 'dashboard', label: 'View Dashboard', group: 'core' },
  { key: 'inbounds', label: 'Manage Services & Inbounds', group: 'core' },
  { key: 'clients', label: 'Manage Child Clients', group: 'core' },
  { key: 'subscriptions', label: 'Manage Subscription Groups', group: 'core' },
  { key: 'categories', label: 'Manage Categories', group: 'core' },
  { key: 'reports', label: 'Analytics & Reports', group: 'core' },
  { key: 'messages', label: 'Activity & Error Logs', group: 'core' },
  { key: 'bot', label: 'Telegram Bot & Texts', group: 'core' },
  { key: 'admins', label: 'Admins & Access Requests', group: 'core' },
  { key: 'settings', label: 'System Settings', group: 'core' },
  { key: 'inbound_create', label: 'Create Inbounds', group: 'granular' },
  { key: 'inbound_edit', label: 'Edit Inbounds', group: 'granular' },
  { key: 'inbound_delete', label: 'Delete Inbounds', group: 'granular' },
  { key: 'client_create', label: 'Create Child Clients', group: 'granular' },
  { key: 'client_edit', label: 'Edit / Toggle Clients', group: 'granular' },
  { key: 'client_delete', label: 'Delete Clients', group: 'granular' },
  { key: 'client_reset', label: 'Reset Usage Counters', group: 'granular' },
  { key: 'outbound_manage', label: 'Manage Outbound Proxies', group: 'granular' },
  { key: 'live_connections', label: 'Inspect Live Connections', group: 'granular' },
] as const;

export type PermissionKey = (typeof ALL_PERMISSIONS)[number]['key'];

export const GRANULAR_PERMISSIONS = new Set<string>([
  'inbound_create',
  'inbound_edit',
  'inbound_delete',
  'client_create',
  'client_edit',
  'client_delete',
  'client_reset',
  'outbound_manage',
  'live_connections',
]);

export interface ManualFields {
  baseProtocol: ManualBaseProtocol;
  network: NetworkTransport;
  security: SecurityMode;
  address: string;
  path: string;
  hostHeader: string;
  sni: string;
  flow: string;
  grpcServiceName: string;
  grpcMode: string;
  xhttpMode: XhttpMode;
  headerType: string;
  allowInsecure: boolean;
  realityPublicKey: string;
  realityShortId: string;
  realitySpiderX: string;
  ssMethod: string;
  ssPassword: string;
}

export interface UsageSample {
  ts: string;
  bytes: number;
}

export interface ServiceRecord {
  id: string;
  label: string;
  active: boolean;
  limitBytes: number;
  usedBytes: number;
  createdAt: string;
  expiresAt: string | null;
  note: string;
  isDefault: boolean;
  subId: string | null;
  parentInboundId: string | null;
  protocol: ProtocolPreset;
  fingerprint: string;
  alpn: string;
  port: number;
  ipLimit: number;
  speedLimitBytes: number;
  connectionLimit: number;
  fragment: string;
  cleanIps: string[];
  alarmEnabled: boolean;
  categoryId: string;
  outboundProxyId: string;
  manual?: ManualFields;
  usageHistory: UsageSample[];
}

export interface RemoteLinkRef {
  refId: string;
  nodeId: string;
  nodeName: string;
  remoteUid: string;
  label: string;
  uri: string;
  usedBytes: number;
  limitBytes: number;
  expiresAt: string | null;
  active: boolean;
  orphaned?: boolean;
  lastSyncedAt: string;
}

export interface SubscriptionGroup {
  id: string;
  uuidKey: string;
  name: string;
  description: string;
  password: string;
  linkIds: string[];
  remoteLinks: RemoteLinkRef[];
  createdAt: string;
  comboMeta?: {
    exits: string[];
    pairsPerExit: number;
  };
}

export interface CategoryRecord {
  id: string;
  name: string;
  color: string;
  description: string;
  createdAt: string;
}

export interface AdminAccount {
  id: string;
  username: string;
  passwordHash: string;
  role: 'admin';
  active: boolean;
  permissions: string[];
  allowedInbounds: string[];
  permV2: boolean;
  note: string;
  createdAt: string;
}

export interface AdminAccessRequest {
  id: string;
  username: string;
  passwordHash: string;
  contact: string;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
  reviewedAt?: string;
}

export interface PanelSettings {
  ownerUsername: string;
  ownerPasswordHash: string;
  publicBaseUrl: string;
  tcpPublicHost: string;
  tcpPublicPort: string;
  supportUsername: string;
  channelUsername: string;
  nameStyleEnabled: boolean;
  subRemarkShowName: boolean;
  subRemarkShowVolume: boolean;
  subRemarkShowId: boolean;
  subRemarkShowInbound: boolean;
  subInfoLineEnabled: boolean;
  subInfoLineShowVolume: boolean;
  subInfoLineShowExpiry: boolean;
  botToken: string;
  botAdminIds: string;
  botUsername: string;
  botAutoStart: boolean;
  alertsEnabled: boolean;
  botTexts: Record<string, string>;
}

export interface OutboundProxyRecord {
  id: string;
  name: string;
  scheme: 'socks5' | 'socks4' | 'http';
  host: string;
  port: number;
  username: string;
  password: string;
  enabled: boolean;
  createdAt: string;
  countryCode?: string;
  country?: string;
  flag?: string;
  lastTest?: {
    ok: boolean;
    latencyMs: number | null;
    tlsOk: boolean;
    speedKbps: number | null;
    score: number;
    grade: string;
    error: string;
    testedAt: string;
  };
}

export interface NodeRecord {
  id: string;
  name: string;
  url: string;
  token: string;
  enabled: boolean;
  createdAt: string;
}

export interface NodeHealthStatus {
  online: boolean;
  checkedAt: string;
  latencyMs?: number;
  version?: string;
  activeLinks?: number;
  totalLinks?: number;
  liveConnections?: number;
  totalBytes?: number;
  cpu?: number;
  mem?: number;
  error: string;
}

export interface SalesPlan {
  id: string;
  name: string;
  days: number;
  volumeGb: number;
  speedMbps: number;
  ipLimit: number;
  stars: number;
  badge: string;
  featured: boolean;
  order: number;
}

export interface SalesOrder {
  id: string;
  userId: string;
  username: string;
  planId: string;
  planName: string;
  amountStars: number;
  telegramChargeId: string;
  serviceId: string;
  createdAt: string;
  expiresAt: string;
  status: 'paid' | 'refunded';
}

export interface ActiveConnection {
  connId: string;
  serviceId: string;
  label: string;
  ip: string;
  transport: 'vless-ws' | 'vless-tcp' | 'xhttp-packet-up' | 'xhttp-stream-up';
  target?: string;
  connectedAt: string;
  bytes: number;
  close?: () => void;
}

export interface ActivityEntry {
  id: string;
  kind: 'system' | 'auth' | 'service' | 'connection' | 'network' | 'sales' | 'bot';
  message: string;
  level: 'info' | 'ok' | 'warn' | 'error';
  time: string;
}

export interface ErrorEntry {
  id: string;
  source: string;
  error: string;
  time: string;
}

export interface DailyStatBucket {
  trafficBytes: number;
  newLinks: number;
  orders: number;
  stars: number;
}
