import { useEffect, useState, type FormEvent } from 'react';
import {
  Activity,
  ArrowUpRight,
  Cpu,
  Globe,
  HardDrive,
  Radio,
  RefreshCw,
  Server,
  ShieldCheck,
  Sparkles,
  Users,
  Zap,
} from 'lucide-react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { apiRequest, formatBytes, formatTimestamp, formatUptime } from '../lib/api';

interface TelemetryPayload {
  system: {
    cpuPct: number;
    memPct: number;
    usedMemBytes: number;
    totalMemBytes: number;
    cpuCores: number;
    loadAvg: number[];
    uptimeSec: number;
    nodeVersion: string;
    platform: string;
  };
  summary: {
    totalServices: number;
    activeServices: number;
    expiredServices: number;
    nearLimit: number;
    totalSubscriptions: number;
    liveConnections: number;
    totalBytes: number;
    totalRequests: number;
    totalErrors: number;
    nodesOnline: number;
    nodesTotal: number;
    proxiesCount: number;
    sales: { orders: number; stars: number; customers: number };
  };
  relays: {
    wsActive: boolean;
    xhttpActive: boolean;
    tcp: { active: boolean; configured: boolean; port: number | null; reason?: string };
  };
  bot: {
    running: boolean;
    configured: boolean;
    username: string;
  };
  hourlyTraffic: Array<{ hour: string; bytes: number }>;
}

interface ActivityItem {
  id: string;
  kind: string;
  message: string;
  level: 'info' | 'ok' | 'warn' | 'error';
  time: string;
}

const PING_PRESETS = [
  { label: 'Cloudflare', host: '1.1.1.1', port: '443' },
  { label: 'Google DNS', host: '8.8.8.8', port: '443' },
  { label: 'Google Edge', host: 'google.com', port: '443' },
];

export function OverviewView({
  onNavigate,
  onQuickCreate,
}: {
  onNavigate: (tab: string) => void;
  onQuickCreate: () => void;
}) {
  const [data, setData] = useState<TelemetryPayload | null>(null);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [pingHost, setPingHost] = useState('1.1.1.1');
  const [pingPort, setPingPort] = useState('443');
  const [pingLoading, setPingLoading] = useState(false);
  const [pingResult, setPingResult] = useState<{ ok: boolean; latencyMs: number | null; error?: string } | null>(null);

  const load = async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      const [tel, act] = await Promise.all([
        apiRequest<TelemetryPayload>('/api/telemetry'),
        apiRequest<{ logs: ActivityItem[] }>('/api/activity').catch(() => ({ logs: [] })),
      ]);
      setData(tel);
      setActivity((act.logs || []).slice(0, 8));
    } finally {
      setLoading(false);
      if (manual) setRefreshing(false);
    }
  };

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, []);

  const executeProbe = async (host: string, port: string) => {
    setPingLoading(true);
    setPingResult(null);
    try {
      const res = await apiRequest<{ ok: boolean; latencyMs: number | null; error?: string }>('/api/network/tcp-ping', {
        method: 'POST',
        body: { host, port: Number(port) || 443 },
      });
      setPingResult(res);
    } catch (err) {
      setPingResult({ ok: false, latencyMs: null, error: err instanceof Error ? err.message : 'Ping failed' });
    } finally {
      setPingLoading(false);
    }
  };

  const runTcpPing = async (e: FormEvent) => {
    e.preventDefault();
    await executeProbe(pingHost, pingPort);
  };

  if (loading || !data) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-32 artena-card opacity-60" />
          ))}
        </div>
        <div className="h-72 artena-card opacity-60" />
      </div>
    );
  }

  const chartData = data.hourlyTraffic.map((b) => ({
    hour: b.hour,
    mb: Math.round((b.bytes / (1024 * 1024)) * 100) / 100,
  }));
  const peakMb = chartData.reduce((max, item) => (item.mb > max ? item.mb : max), 0);
  const total24hBytes = data.hourlyTraffic.reduce((sum, item) => sum + item.bytes, 0);
  const activeRatio =
    data.summary.totalServices > 0
      ? Math.round((data.summary.activeServices / data.summary.totalServices) * 100)
      : 0;

  return (
    <div className="space-y-6">
      {/* Editorial Overview Header Strip */}
      <section className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="font-display text-xl sm:text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-50">
            Relay Mesh Command
          </h2>
          <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 mt-1">
            {data.system.platform} · Node {data.system.nodeVersion} · Uptime {formatUptime(data.system.uptimeSec)} ·{' '}
            {data.summary.nodesOnline}/{data.summary.nodesTotal} federated nodes online
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onQuickCreate}
            className="h-9 px-3.5 rounded-xl bg-gradient-to-b from-[#E8AE5C] to-[#D08F35] hover:from-[#F0BC70] hover:to-[#DC9E49] text-[#0A131C] font-semibold shadow-[0_2px_10px_-2px_rgba(225,159,72,0.45)] text-xs font-medium inline-flex items-center gap-1.5 shadow-sm shadow-teal-600/20 transition-all whitespace-nowrap"
          >
            <Sparkles className="w-3.5 h-3.5" />
            Quick Provision
          </button>
          <button
            type="button"
            onClick={() => void load(true)}
            aria-label="Refresh telemetry"
            className="h-9 px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5 transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </section>

      {/* KPI Strip */}
      <section aria-label="Key metrics" className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="artena-card p-5 flex flex-col justify-between gap-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400">Active Services</span>
            <div className="w-8 h-8 rounded-xl bg-teal-50 dark:bg-teal-950/60 text-teal-600 dark:text-teal-400 flex items-center justify-center">
              <ShieldCheck className="w-4 h-4" />
            </div>
          </div>
          <div>
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-mono tabular-nums text-3xl font-semibold tracking-tight text-slate-900 dark:text-slate-50">
                {data.summary.activeServices}
                <span className="text-sm font-normal text-slate-400 ml-1">/ {data.summary.totalServices}</span>
              </span>
              <button
                type="button"
                onClick={() => onNavigate('services')}
                className="text-xs font-medium text-teal-600 dark:text-teal-400 hover:underline inline-flex items-center gap-0.5"
              >
                Manage <ArrowUpRight className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="mt-3 h-1.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
              <div
                className="h-full rounded-full bg-teal-600 dark:bg-teal-400 transition-all duration-500"
                style={{ width: `${activeRatio}%` }}
              />
            </div>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-2">
              {data.summary.nearLimit} near quota · {data.summary.expiredServices} expired
            </p>
          </div>
        </div>

        <div className="artena-card p-5 flex flex-col justify-between gap-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400">Live Relay Sessions</span>
            <div className="w-8 h-8 rounded-xl bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 flex items-center justify-center">
              <Radio className="w-4 h-4" />
            </div>
          </div>
          <div>
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-mono tabular-nums text-3xl font-semibold tracking-tight text-slate-900 dark:text-slate-50">
                {data.summary.liveConnections}
              </span>
              <button
                type="button"
                onClick={() => onNavigate('reports')}
                className="text-xs font-medium text-teal-600 dark:text-teal-400 hover:underline inline-flex items-center gap-0.5"
              >
                Inspect <ArrowUpRight className="w-3.5 h-3.5" />
              </button>
            </div>
            <p className="text-[11px] font-mono tabular-nums text-slate-500 dark:text-slate-400 mt-4">
              {data.summary.totalRequests.toLocaleString()} frames · {data.summary.totalErrors} errors
            </p>
          </div>
        </div>

        <div className="artena-card p-5 flex flex-col justify-between gap-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400">Total Transferred</span>
            <div className="w-8 h-8 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 flex items-center justify-center">
              <Activity className="w-4 h-4" />
            </div>
          </div>
          <div>
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-mono tabular-nums text-3xl font-semibold tracking-tight text-slate-900 dark:text-slate-50">
                {formatBytes(data.summary.totalBytes)}
              </span>
              <button
                type="button"
                onClick={() => onNavigate('subscriptions')}
                className="text-xs font-medium text-slate-500 dark:text-slate-400 hover:text-teal-600 dark:hover:text-teal-400"
              >
                {data.summary.totalSubscriptions} groups
              </button>
            </div>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-4">
              {data.summary.proxiesCount} outbound proxies · {data.summary.nodesOnline}/{data.summary.nodesTotal} nodes online
            </p>
          </div>
        </div>

        <div className="artena-card p-5 flex flex-col justify-between gap-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400">Subscriptions & Sales</span>
            <div className="w-8 h-8 rounded-xl bg-amber-50 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400 flex items-center justify-center">
              <Users className="w-4 h-4" />
            </div>
          </div>
          <div>
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-mono tabular-nums text-3xl font-semibold tracking-tight text-slate-900 dark:text-slate-50">
                {data.summary.sales.stars.toLocaleString()}
                <span className="text-xs font-sans font-normal text-slate-500 ml-1">Stars</span>
              </span>
              <button
                type="button"
                onClick={() => onNavigate('sales')}
                className="text-xs font-medium text-teal-600 dark:text-teal-400 hover:underline inline-flex items-center gap-0.5"
              >
                Ledger <ArrowUpRight className="w-3.5 h-3.5" />
              </button>
            </div>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-4">
              {data.summary.sales.orders} paid orders · {data.summary.sales.customers} customers
            </p>
          </div>
        </div>
      </section>

      {/* Main Grid: 24h Traffic Chart + Relay & System Health */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
        <div className="xl:col-span-8 artena-card p-6">
          <div className="flex flex-wrap items-start justify-between gap-4 mb-5">
            <div>
              <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
                24-Hour Relay Throughput
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                Hourly aggregate volume across VLESS-WS, XHTTP, and VLESS-TCP listeners (MB)
              </p>
            </div>
            <div className="flex items-center gap-5 text-xs">
              <div>
                <div className="text-[10px] uppercase tracking-wider text-slate-400">24h Volume</div>
                <div className="font-mono tabular-nums font-semibold text-slate-900 dark:text-slate-100 mt-0.5">
                  {formatBytes(total24hBytes)}
                </div>
              </div>
              <div className="h-7 w-px bg-slate-200 dark:bg-slate-800" />
              <div>
                <div className="text-[10px] uppercase tracking-wider text-slate-400">Peak Hour</div>
                <div className="font-mono tabular-nums font-semibold text-teal-600 dark:text-teal-400 mt-0.5">
                  {peakMb.toLocaleString()} MB
                </div>
              </div>
            </div>
          </div>

          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                <defs>
                  <linearGradient id="artenaTrafficGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#2E8A94" stopOpacity={0.28} />
                    <stop offset="95%" stopColor="#2E8A94" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.18)" vertical={false} />
                <XAxis
                  dataKey="hour"
                  tick={{ fontSize: 11, fill: '#64748B' }}
                  axisLine={false}
                  tickLine={false}
                  interval={3}
                />
                <YAxis tick={{ fontSize: 11, fill: '#64748B' }} axisLine={false} tickLine={false} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#0A131C',
                    border: '1px solid #17334A',
                    borderRadius: '12px',
                    fontSize: '12px',
                    color: '#F6FAFD',
                    boxShadow: '0 10px 25px rgba(15, 23, 42, 0.25)',
                  }}
                  formatter={(v: unknown) => [`${v} MB`, 'Traffic']}
                />
                <Area
                  type="monotone"
                  dataKey="mb"
                  stroke="#2E8A94"
                  strokeWidth={2.25}
                  fill="url(#artenaTrafficGrad)"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* System Health & Live Listeners */}
        <div className="xl:col-span-4 artena-card p-6 flex flex-col justify-between gap-5">
          <div>
            <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
              Runtime & Listeners
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Load avg {data.system.loadAvg.map((n) => n.toFixed(2)).join(' · ')}
            </p>
          </div>

          <div className="space-y-4">
            <div>
              <div className="flex items-center justify-between text-xs mb-1.5">
                <span className="inline-flex items-center gap-1.5 text-slate-600 dark:text-slate-300">
                  <Cpu className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400" /> CPU Load ({data.system.cpuCores} cores)
                </span>
                <span className="font-mono tabular-nums font-semibold text-slate-900 dark:text-slate-100">
                  {data.system.cpuPct}%
                </span>
              </div>
              <div className="h-2 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                <div
                  className="h-full bg-teal-600 dark:bg-teal-400 rounded-full transition-all duration-500"
                  style={{ width: `${Math.min(100, Math.max(2, data.system.cpuPct))}%` }}
                />
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between text-xs mb-1.5">
                <span className="inline-flex items-center gap-1.5 text-slate-600 dark:text-slate-300">
                  <HardDrive className="w-3.5 h-3.5 text-slate-500" /> Memory ({formatBytes(data.system.usedMemBytes)} / {formatBytes(data.system.totalMemBytes)})
                </span>
                <span className="font-mono tabular-nums font-semibold text-slate-900 dark:text-slate-100">
                  {data.system.memPct}%
                </span>
              </div>
              <div className="h-2 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${
                    data.system.memPct > 85 ? 'bg-red-600' : 'bg-slate-800 dark:bg-slate-300'
                  }`}
                  style={{ width: `${Math.min(100, Math.max(2, data.system.memPct))}%` }}
                />
              </div>
            </div>
          </div>

          <div className="border-t border-slate-100 dark:border-slate-800 pt-4 space-y-2.5 text-xs">
            <div className="flex items-center justify-between py-0.5">
              <span className="text-slate-600 dark:text-slate-400">VLESS · WebSocket Relay</span>
              <span className="font-mono text-emerald-700 dark:text-emerald-400 font-medium">Active (/ws/:uuid)</span>
            </div>
            <div className="flex items-center justify-between py-0.5">
              <span className="text-slate-600 dark:text-slate-400">XHTTP Packet & Stream</span>
              <span className="font-mono text-emerald-700 dark:text-emerald-400 font-medium">Active (/xhttp/*)</span>
            </div>
            <div className="flex items-center justify-between py-0.5">
              <span className="text-slate-600 dark:text-slate-400">VLESS · Raw TCP Relay</span>
              <button
                type="button"
                onClick={() => onNavigate('settings')}
                className={`font-mono font-medium hover:underline ${
                  data.relays.tcp.active
                    ? 'text-emerald-700 dark:text-emerald-400'
                    : data.relays.tcp.configured
                      ? 'text-red-600 dark:text-red-400'
                      : 'text-amber-600 dark:text-amber-400'
                }`}
              >
                {data.relays.tcp.active
                  ? `Listening :${data.relays.tcp.port}`
                  : data.relays.tcp.configured
                    ? `Stopped (:${data.relays.tcp.port})`
                    : 'Pending TCP_LISTEN_PORT'}
              </button>
            </div>
            <div className="flex items-center justify-between py-0.5">
              <span className="text-slate-600 dark:text-slate-400">Telegram Bot Worker</span>
              <button
                type="button"
                onClick={() => onNavigate('telegram')}
                className={`font-mono font-medium hover:underline ${
                  data.bot.running ? 'text-emerald-700 dark:text-emerald-400' : 'text-slate-500'
                }`}
              >
                {data.bot.running ? `@${data.bot.username || 'running'}` : data.bot.configured ? 'Stopped' : 'Not configured'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Bottom Row: TCP Connectivity Diagnostic + Recent Activity */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-5 artena-card p-6 flex flex-col justify-between gap-4">
          <div>
            <div className="flex items-center justify-between gap-2 mb-3">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-lg bg-teal-50 dark:bg-teal-950/60 text-teal-600 dark:text-teal-400 flex items-center justify-center">
                  <Globe className="w-4 h-4" />
                </div>
                <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Outbound TCP Reachability Probe
                </h3>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-1.5 mb-3">
              <span className="text-[11px] text-slate-400 mr-1">Quick targets:</span>
              {PING_PRESETS.map((preset) => (
                <button
                  key={preset.host}
                  type="button"
                  onClick={() => {
                    setPingHost(preset.host);
                    setPingPort(preset.port);
                    void executeProbe(preset.host, preset.port);
                  }}
                  className="px-2 py-1 rounded-lg border border-slate-200 dark:border-slate-700/80 bg-slate-50/80 dark:bg-slate-900 text-[11px] font-mono text-slate-600 dark:text-slate-300 hover:border-teal-400 dark:hover:border-teal-600 hover:text-teal-700 dark:hover:text-teal-300 transition-colors"
                >
                  {preset.label}
                </button>
              ))}
            </div>

            <form onSubmit={runTcpPing} className="flex flex-wrap sm:flex-nowrap items-end gap-2.5">
              <div className="flex-1 min-w-[140px]">
                <label htmlFor="ping-host" className="block text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-1">
                  Host / IP
                </label>
                <input
                  id="ping-host"
                  type="text"
                  required
                  value={pingHost}
                  onChange={(e) => setPingHost(e.target.value)}
                  placeholder="1.1.1.1"
                  className="w-full h-9 px-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 text-xs font-mono text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-teal-500/30"
                />
              </div>
              <div className="w-24">
                <label htmlFor="ping-port" className="block text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-1">
                  Port
                </label>
                <input
                  id="ping-port"
                  type="number"
                  min={1}
                  max={65535}
                  value={pingPort}
                  onChange={(e) => setPingPort(e.target.value)}
                  className="w-full h-9 px-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 text-xs font-mono tabular-nums text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-teal-500/30"
                />
              </div>
              <button
                type="submit"
                disabled={pingLoading}
                className="h-9 px-4 rounded-xl bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 text-xs font-medium inline-flex items-center gap-1.5 hover:opacity-90 disabled:opacity-50 whitespace-nowrap transition-opacity"
              >
                <Zap className="w-3.5 h-3.5" />
                {pingLoading ? 'Probing...' : 'Ping'}
              </button>
            </form>
          </div>

          {pingResult && (
            <div
              className={`px-3.5 py-2.5 rounded-xl border text-xs font-mono ${
                pingResult.ok
                  ? 'bg-emerald-50/80 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800/80 text-emerald-800 dark:text-emerald-200'
                  : 'bg-red-50/80 dark:bg-red-950/40 border-red-200 dark:border-red-800/80 text-red-800 dark:text-red-200'
              }`}
            >
              {pingResult.ok
                ? `Connected to ${pingHost}:${pingPort} in ${pingResult.latencyMs} ms`
                : `Failed: ${pingResult.error || 'Unreachable'}`}
            </div>
          )}
        </div>

        <div className="lg:col-span-7 artena-card p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-300 flex items-center justify-center">
                <Server className="w-4 h-4" />
              </div>
              <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                Recent Audit Activity
              </h3>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('reports')}
              className="text-xs font-medium text-teal-600 dark:text-teal-400 hover:underline inline-flex items-center gap-0.5"
            >
              View all logs <ArrowUpRight className="w-3.5 h-3.5" />
            </button>
          </div>
          {activity.length === 0 ? (
            <p className="text-xs text-slate-500 dark:text-slate-400 py-8 text-center">No recent events recorded yet.</p>
          ) : (
            <div className="divide-y divide-slate-100 dark:divide-slate-800/80">
              {activity.map((item) => (
                <div key={item.id} className="py-2.5 flex items-center justify-between gap-4 text-xs">
                  <div className="min-w-0 truncate">
                    <span
                      className={`font-mono text-[11px] font-semibold mr-2.5 uppercase ${
                        item.level === 'error'
                          ? 'text-red-600 dark:text-red-400'
                          : item.level === 'warn'
                            ? 'text-amber-600 dark:text-amber-400'
                            : item.level === 'ok'
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : 'text-slate-500 dark:text-slate-400'
                      }`}
                    >
                      {item.kind}
                    </span>
                    <span className="text-slate-800 dark:text-slate-200">{item.message}</span>
                  </div>
                  <span className="font-mono tabular-nums text-[11px] text-slate-400 whitespace-nowrap shrink-0">
                    {formatTimestamp(item.time)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
