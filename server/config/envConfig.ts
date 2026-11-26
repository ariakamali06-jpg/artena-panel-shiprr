import crypto from 'node:crypto';
import { ALL_PROTOCOLS, type ProtocolPreset } from '../types';
import { validateExternalHttpUrl } from '../engine/security';

export type ConfigCategory =
  | 'required'
  | 'optional'
  | 'deployment-dependent'
  | 'network-dependent'
  | 'telegram-dependent'
  | 'sales-dependent';

export type ConfigItemState = 'configured' | 'not_configured' | 'fallback' | 'invalid';

export interface ConfigStatusItem {
  key: string;
  label: string;
  category: ConfigCategory;
  state: ConfigItemState;
  sensitive: boolean;
  source: 'env' | 'settings' | 'ephemeral' | 'none';
  summary: string;
  requiredWhen: string;
  guidance: string;
}

export const ACCEPTED_SALES_PROTOCOLS: ProtocolPreset[] = ALL_PROTOCOLS.filter(
  (p) => p !== 'manual'
) as ProtocolPreset[];

// Ephemeral fallback secret generated once in memory when SESSION_SECRET is unset
const EPHEMERAL_SESSION_SECRET = crypto.randomBytes(32).toString('hex');

function parseStrictPort(raw: string | undefined): { value: number | null; invalid: boolean } {
  const trimmed = (raw || '').trim();
  if (!trimmed) return { value: null, invalid: false };
  if (!/^\d+$/.test(trimmed)) return { value: null, invalid: true };
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return { value: null, invalid: true };
  return { value: n, invalid: false };
}

export interface RuntimeConfigSnapshot {
  sessionSecret: {
    secret: string;
    fromEnv: boolean;
    weakWarning: boolean;
  };
  publicBaseUrl: {
    value: string | null;
    source: 'env' | 'settings' | 'none';
    invalid: boolean;
    error?: string;
  };
  tcpListenPort: {
    value: number | null;
    invalid: boolean;
  };
  tcpPublicHost: {
    value: string | null;
    source: 'env' | 'settings' | 'none';
  };
  tcpPublicPort: {
    value: number | null;
    source: 'env' | 'settings' | 'none';
    invalid: boolean;
  };
  salesDefaultProtocol: {
    value: ProtocolPreset | null;
    invalid: boolean;
    raw: string;
  };
  salesDefaultPort: {
    value: number | null;
    invalid: boolean;
  };
}

export function resolveRuntimeConfig(settingsOverrides?: {
  publicBaseUrl?: string;
  tcpPublicHost?: string;
  tcpPublicPort?: string;
}): RuntimeConfigSnapshot {
  const envSessionSecret = (process.env.SESSION_SECRET || '').trim();
  const sessionSecret = envSessionSecret
    ? { secret: envSessionSecret, fromEnv: true, weakWarning: envSessionSecret.length < 32 }
    : { secret: EPHEMERAL_SESSION_SECRET, fromEnv: false, weakWarning: false };

  // PUBLIC_BASE_URL (env or saved panel setting — never invented)
  const rawEnvBase = (process.env.PUBLIC_BASE_URL || '').trim();
  const rawSettingsBase = (settingsOverrides?.publicBaseUrl || '').trim();
  const rawBase = rawSettingsBase || rawEnvBase;
  const baseSource: 'env' | 'settings' | 'none' = rawSettingsBase ? 'settings' : rawEnvBase ? 'env' : 'none';
  let publicBaseUrl: RuntimeConfigSnapshot['publicBaseUrl'] = {
    value: null,
    source: 'none',
    invalid: false,
  };
  if (rawBase) {
    const check = validateExternalHttpUrl(rawBase);
    if (check.ok) {
      publicBaseUrl = { value: check.origin, source: baseSource, invalid: false };
    } else {
      publicBaseUrl = { value: null, source: baseSource, invalid: true, error: check.error };
    }
  }

  // TCP_LISTEN_PORT (never silently falls back to an invented port)
  const tcpListenPort = parseStrictPort(process.env.TCP_LISTEN_PORT);

  // TCP_PUBLIC_HOST
  const envTcpHost = (process.env.TCP_PUBLIC_HOST || '').trim();
  const settingsTcpHost = (settingsOverrides?.tcpPublicHost || '').trim();
  const resolvedTcpHost = settingsTcpHost || envTcpHost || null;
  const tcpHostSource: 'env' | 'settings' | 'none' = settingsTcpHost ? 'settings' : envTcpHost ? 'env' : 'none';

  // TCP_PUBLIC_PORT
  const envTcpPortRaw = (process.env.TCP_PUBLIC_PORT || '').trim();
  const settingsTcpPortRaw = (settingsOverrides?.tcpPublicPort || '').trim();
  const parsedTcpPublicPort = parseStrictPort(settingsTcpPortRaw || envTcpPortRaw);
  const tcpPortSource: 'env' | 'settings' | 'none' = settingsTcpPortRaw
    ? 'settings'
    : envTcpPortRaw
      ? 'env'
      : 'none';

  // SALES_DEFAULT_PROTOCOL
  const rawSalesProto = (process.env.SALES_DEFAULT_PROTOCOL || '').trim().toLowerCase();
  let salesProtoVal: ProtocolPreset | null = null;
  let salesProtoInvalid = false;
  if (rawSalesProto) {
    if (ACCEPTED_SALES_PROTOCOLS.includes(rawSalesProto as ProtocolPreset)) {
      salesProtoVal = rawSalesProto as ProtocolPreset;
    } else {
      salesProtoInvalid = true;
    }
  }

  // SALES_DEFAULT_PORT
  const salesDefaultPort = parseStrictPort(process.env.SALES_DEFAULT_PORT);

  return {
    sessionSecret,
    publicBaseUrl,
    tcpListenPort,
    tcpPublicHost: { value: resolvedTcpHost, source: tcpHostSource },
    tcpPublicPort: { value: parsedTcpPublicPort.value, source: tcpPortSource, invalid: parsedTcpPublicPort.invalid },
    salesDefaultProtocol: { value: salesProtoVal, invalid: salesProtoInvalid, raw: rawSalesProto },
    salesDefaultPort,
  };
}

export function buildConfigStatusList(settingsOverrides?: {
  publicBaseUrl?: string;
  tcpPublicHost?: string;
  tcpPublicPort?: string;
  botToken?: string;
  botAdminIds?: string;
}): ConfigStatusItem[] {
  const cfg = resolveRuntimeConfig(settingsOverrides);
  const hasBotToken = Boolean((settingsOverrides?.botToken || process.env.TELEGRAM_BOT_TOKEN || '').trim());
  const hasBotAdmins = Boolean((settingsOverrides?.botAdminIds || process.env.TELEGRAM_ADMIN_IDS || '').trim());

  const items: ConfigStatusItem[] = [
    {
      key: 'SESSION_SECRET',
      label: 'Session Secret',
      category: 'required',
      state: cfg.sessionSecret.fromEnv ? 'configured' : 'fallback',
      sensitive: true,
      source: cfg.sessionSecret.fromEnv ? 'env' : 'ephemeral',
      summary: cfg.sessionSecret.fromEnv
        ? cfg.sessionSecret.weakWarning
          ? 'Configured (recommended >= 32 chars)'
          : 'Configured via environment'
        : 'Not configured (using ephemeral in-memory key; sessions reset on restart)',
      requiredWhen: 'Required in production to keep session signatures deterministic and high-entropy.',
      guidance: 'Generate with `openssl rand -hex 32` and set SESSION_SECRET in your environment variables.',
    },
    {
      key: 'PUBLIC_BASE_URL',
      label: 'Public Base URL',
      category: 'deployment-dependent',
      state: cfg.publicBaseUrl.invalid
        ? 'invalid'
        : cfg.publicBaseUrl.value
          ? 'configured'
          : 'not_configured',
      sensitive: false,
      source: cfg.publicBaseUrl.source,
      summary: cfg.publicBaseUrl.invalid
        ? `Invalid URL: ${cfg.publicBaseUrl.error}`
        : cfg.publicBaseUrl.value
          ? cfg.publicBaseUrl.value
          : 'Not configured (pending public HTTPS domain)',
      requiredWhen: 'Required for Telegram Mini App button registration, Telegram Bot subscription links, and public client feeds behind reverse proxies.',
      guidance: 'Set PUBLIC_BASE_URL to your deployed HTTPS origin (e.g., Railway public domain or custom domain) in environment or Settings.',
    },
    {
      key: 'TCP_LISTEN_PORT',
      label: 'TCP Relay Listen Port',
      category: 'network-dependent',
      state: cfg.tcpListenPort.invalid
        ? 'invalid'
        : cfg.tcpListenPort.value
          ? 'configured'
          : 'not_configured',
      sensitive: false,
      source: cfg.tcpListenPort.value ? 'env' : 'none',
      summary: cfg.tcpListenPort.invalid
        ? 'Invalid port (must be integer 1–65535)'
        : cfg.tcpListenPort.value
          ? `Listening port ${cfg.tcpListenPort.value}`
          : 'Not configured (VLESS-TCP listener is paused until set)',
      requiredWhen: 'Required only when running the standalone raw VLESS-TCP relay server.',
      guidance: 'Set TCP_LISTEN_PORT to an open container/host port (e.g., 6543) and expose TCP networking on your host or Railway TCP Proxy.',
    },
    {
      key: 'TCP_PUBLIC_HOST',
      label: 'TCP Public Host',
      category: 'network-dependent',
      state: cfg.tcpPublicHost.value ? 'configured' : 'not_configured',
      sensitive: false,
      source: cfg.tcpPublicHost.source,
      summary: cfg.tcpPublicHost.value
        ? cfg.tcpPublicHost.value
        : 'Not configured (VLESS-TCP client links cannot advertise a public TCP endpoint)',
      requiredWhen: 'Required to generate valid client-facing VLESS-TCP URIs.',
      guidance: 'Set TCP_PUBLIC_HOST to the public hostname or IP from your VPS or Railway TCP Proxy.',
    },
    {
      key: 'TCP_PUBLIC_PORT',
      label: 'TCP Public Port',
      category: 'network-dependent',
      state: cfg.tcpPublicPort.invalid
        ? 'invalid'
        : cfg.tcpPublicPort.value
          ? 'configured'
          : 'not_configured',
      sensitive: false,
      source: cfg.tcpPublicPort.source,
      summary: cfg.tcpPublicPort.invalid
        ? 'Invalid port (must be integer 1–65535)'
        : cfg.tcpPublicPort.value
          ? `Port ${cfg.tcpPublicPort.value}`
          : 'Not configured (pending external TCP port mapping)',
      requiredWhen: 'Required alongside TCP_PUBLIC_HOST to generate connectable VLESS-TCP client URIs.',
      guidance: 'Set TCP_PUBLIC_PORT to the external port assigned by Railway TCP Proxy or your firewall.',
    },
    {
      key: 'SALES_DEFAULT_PROTOCOL',
      label: 'Sales Default Protocol',
      category: 'sales-dependent',
      state: cfg.salesDefaultProtocol.invalid
        ? 'invalid'
        : cfg.salesDefaultProtocol.value
          ? 'configured'
          : 'not_configured',
      sensitive: false,
      source: cfg.salesDefaultProtocol.value ? 'env' : 'none',
      summary: cfg.salesDefaultProtocol.invalid
        ? `Invalid protocol "${cfg.salesDefaultProtocol.raw}". Accepted: ${ACCEPTED_SALES_PROTOCOLS.join(', ')}`
        : cfg.salesDefaultProtocol.value
          ? cfg.salesDefaultProtocol.value
          : 'Not configured (must be set for automatic Telegram Stars fulfillment)',
      requiredWhen: 'Required for automated sales order provisioning when no explicit protocol is specified.',
      guidance: `Set SALES_DEFAULT_PROTOCOL to one of: ${ACCEPTED_SALES_PROTOCOLS.join(', ')}.`,
    },
    {
      key: 'SALES_DEFAULT_PORT',
      label: 'Sales Default Port',
      category: 'sales-dependent',
      state: cfg.salesDefaultPort.invalid
        ? 'invalid'
        : cfg.salesDefaultPort.value
          ? 'configured'
          : 'not_configured',
      sensitive: false,
      source: cfg.salesDefaultPort.value ? 'env' : 'none',
      summary: cfg.salesDefaultPort.invalid
        ? 'Invalid port (must be integer 1–65535)'
        : cfg.salesDefaultPort.value
          ? `Port ${cfg.salesDefaultPort.value}`
          : 'Not configured (must be set for automatic sales provisioning)',
      requiredWhen: 'Required alongside SALES_DEFAULT_PROTOCOL for automated sales fulfillment.',
      guidance: 'Set SALES_DEFAULT_PORT to the public port clients connect to (typically 443 for TLS WS/XHTTP or your TCP_PUBLIC_PORT for VLESS-TCP).',
    },
    {
      key: 'TELEGRAM_BOT_TOKEN',
      label: 'Telegram Bot Token',
      category: 'telegram-dependent',
      state: hasBotToken ? 'configured' : 'not_configured',
      sensitive: true,
      source: process.env.TELEGRAM_BOT_TOKEN ? 'env' : hasBotToken ? 'settings' : 'none',
      summary: hasBotToken ? 'Configured (hidden)' : 'Not configured (bot worker idle)',
      requiredWhen: 'Required to enable the Telegram Bot admin interface, Stars payments, and Mini App HMAC verification.',
      guidance: 'Create a bot via @BotFather and add TELEGRAM_BOT_TOKEN in environment variables or the Telegram Bot page.',
    },
    {
      key: 'TELEGRAM_ADMIN_IDS',
      label: 'Telegram Admin IDs',
      category: 'telegram-dependent',
      state: hasBotAdmins ? 'configured' : 'not_configured',
      sensitive: false,
      source: process.env.TELEGRAM_ADMIN_IDS ? 'env' : hasBotAdmins ? 'settings' : 'none',
      summary: hasBotAdmins ? 'Configured' : 'Not configured (no Telegram admin accounts authorized)',
      requiredWhen: 'Required for Telegram Bot administrative commands and Mini App admin authentication.',
      guidance: 'Send /id to your bot to read your numeric Telegram user ID and add it to TELEGRAM_ADMIN_IDS.',
    },
  ];

  return items;
}

export function formatMissingConfigMessage(params: {
  feature: string;
  missingVars: string[];
  reason: string;
}): string {
  return [
    `${params.feature} is not configured yet.`,
    `Missing: ${params.missingVars.join(', ')}.`,
    params.reason,
    'See ENVIRONMENT_CONFIGURATION_GUIDE.md for step-by-step instructions.',
  ].join(' ');
}

export function logStartupConfigSummary(settingsOverrides?: {
  publicBaseUrl?: string;
  tcpPublicHost?: string;
  tcpPublicPort?: string;
  botToken?: string;
  botAdminIds?: string;
}): void {
  const list = buildConfigStatusList(settingsOverrides);
  const pending = list.filter((i) => i.state === 'not_configured' || i.state === 'fallback');
  const invalid = list.filter((i) => i.state === 'invalid');

  console.log('[artena:config] Configuration validation complete:');
  for (const item of list) {
    const tag =
      item.state === 'configured'
        ? 'CONFIGURED'
        : item.state === 'fallback'
          ? 'FALLBACK  '
          : item.state === 'invalid'
            ? 'INVALID   '
            : 'PENDING   ';
    // Never log secret values — only key name, category, and safe status summary
    const safeSummary = item.sensitive
      ? item.state === 'configured'
        ? 'Set (value hidden)'
        : item.summary
      : item.summary;
    console.log(`  [${tag}] ${item.key} (${item.category}) -> ${safeSummary}`);
  }
  if (invalid.length) {
    console.warn(`[artena:config] ${invalid.length} invalid configuration value(s) detected. Review ENVIRONMENT_CONFIGURATION_GUIDE.md.`);
  } else if (pending.length) {
    console.log(`[artena:config] ${pending.length} deferred configuration variable(s) pending. Core HTTP/WS/XHTTP panel remains operational.`);
  }
}
