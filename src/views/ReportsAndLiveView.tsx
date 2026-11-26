import { useEffect, useState } from 'react';
import {
  Activity,
  AlertCircle,
  Download,
  PlugZap,
  Radio,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { apiRequest, formatBytes, formatTimestamp, getAuthToken } from '../lib/api';

interface LiveConnection {
  id: string;
  serviceId: string;
  serviceLabel: string;
  protocol: string;
  clientIp: string;
  target: string;
  bytesUp: number;
  bytesDown: number;
  connectedAt: string;
}

interface ReportSummary {
  series: Array<{ date: string; trafficMb: number; newLinks: number; orders: number; stars: number }>;
  protocolDistribution: Array<{ protocol: string; count: number }>;
  topServices: Array<{ id: string; label: string; protocol: string; usedBytes: number; limitBytes: number; active: boolean }>;
}

interface ActivityLog {
  id: string;
  kind: string;
  message: string;
  level: 'info' | 'ok' | 'warn' | 'error';
  time: string;
}

interface ErrorLog {
  id: string;
  source: string;
  message: string;
  detail?: string;
  time: string;
}

export function ReportsAndLiveView({
  onToast,
}: {
  onToast: (type: 'success' | 'error' | 'info', msg: string) => void;
}) {
  const [subTab, setSubTab] = useState<'live' | 'analytics' | 'activity' | 'errors'>('live');
  const [connections, setConnections] = useState<LiveConnection[]>([]);
  const [report, setReport] = useState<ReportSummary | null>(null);
  const [activity, setActivity] = useState<ActivityLog[]>([]);
  const [errors, setErrors] = useState<ErrorLog[]>([]);
  const [days, setDays] = useState(14);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      const [cRes, rRes, aRes, eRes] = await Promise.all([
        apiRequest<{ connections: LiveConnection[] }>('/api/connections').catch(() => ({ connections: [] })),
        apiRequest<ReportSummary>(`/api/reports/summary?days=${days}`).catch(() => null),
        apiRequest<{ logs: ActivityLog[] }>('/api/activity').catch(() => ({ logs: [] })),
        apiRequest<{ errors: ErrorLog[] }>('/api/errors').catch(() => ({ errors: [] })),
      ]);
      setConnections(cRes.connections || []);
      setReport(rRes);
      setActivity(aRes.logs || []);
      setErrors(eRes.errors || []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [days]);

  const disconnect = async (connId: string) => {
    try {
      await apiRequest(`/api/connections/${connId}`, { method: 'DELETE' });
      onToast('info', 'Connection terminated');
      await load();
    } catch (err) {
      onToast('error', err instanceof Error ? err.message : 'Failed to disconnect session');
    }
  };

  const clearErrors = async () => {
    try {
      await apiRequest('/api/errors/clear', { method: 'POST' });
      onToast('info', 'Error log cleared');
      await load();
    } catch (err) {
      onToast('error', err instanceof Error ? err.message : 'Failed to clear errors');
    }
  };

  const exportCsv = async () => {
    try {
      const token = getAuthToken();
      const res = await fetch('/api/reports/export.csv', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'artena-services-report.csv';
      a.click();
      URL.revokeObjectURL(url);
      onToast('success', 'CSV report downloaded');
    } catch {
      onToast('error', 'Failed to export CSV');
    }
  };

  const totalProtoCount = (report?.protocolDistribution || []).reduce((acc, p) => acc + p.count, 0);

  return (
    <div className="space-y-6">
      {/* Sub-navigation bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex flex-wrap rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-1 gap-0.5">
          {[
            { id: 'live', label: `Live Sessions (${connections.length})` },
            { id: 'analytics', label: 'Analytics & Reports' },
            { id: 'activity', label: 'Audit Activity' },
            { id: 'errors', label: `Error Center (${errors.length})` },
          ].map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setSubTab(t.id as typeof subTab)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                subTab === t.id
                  ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void exportCsv()}
            className="h-9 px-3.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5 transition-colors"
          >
            <Download className="w-3.5 h-3.5" /> Export CSV
          </button>
          <button
            type="button"
            onClick={() => void load()}
            className="w-9 h-9 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center justify-center transition-colors"
            aria-label="Refresh logs"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {loading ? (
        <div className="h-64 artena-card opacity-60" />
      ) : subTab === 'live' ? (
        <div className="artena-card p-6">
          <div className="flex items-center gap-2.5 mb-4">
            <div className="w-8 h-8 rounded-xl bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 flex items-center justify-center">
              <Radio className="w-4 h-4" />
            </div>
            <div>
              <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
                Active Relay Connections
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Live VLESS-WS, XHTTP, and VLESS-TCP client tunnels routed through Artena
              </p>
            </div>
          </div>
          {connections.length === 0 ? (
            <p className="text-xs text-slate-500 dark:text-slate-400 py-12 text-center">
              No active client tunnels at this moment. Active VLESS-WS, XHTTP, and VLESS-TCP streams appear here in real time.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 text-[11px] text-slate-500">
                    <th className="py-2.5 pr-3 font-medium">Service</th>
                    <th className="py-2.5 pr-3 font-medium">Protocol</th>
                    <th className="py-2.5 pr-3 font-medium">Client IP</th>
                    <th className="py-2.5 pr-3 font-medium">Destination</th>
                    <th className="py-2.5 pr-3 font-medium">Traffic</th>
                    <th className="py-2.5 font-medium text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
                  {connections.map((c) => (
                    <tr key={c.id} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/30 transition-colors">
                      <td className="py-3 pr-3 font-semibold text-slate-900 dark:text-slate-100">{c.serviceLabel}</td>
                      <td className="py-3 pr-3 font-mono text-slate-600 dark:text-slate-300">{c.protocol}</td>
                      <td className="py-3 pr-3 font-mono text-slate-700 dark:text-slate-300">{c.clientIp}</td>
                      <td className="py-3 pr-3 font-mono text-slate-500 truncate max-w-[200px]">{c.target}</td>
                      <td className="py-3 pr-3 font-mono tabular-nums text-slate-700 dark:text-slate-300">
                        ↑{formatBytes(c.bytesUp)} / ↓{formatBytes(c.bytesDown)}
                      </td>
                      <td className="py-3 text-right">
                        <button
                          type="button"
                          onClick={() => void disconnect(c.id)}
                          className="px-2.5 py-1 rounded-lg border border-red-200 dark:border-red-900 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 inline-flex items-center gap-1 transition-colors"
                        >
                          <PlugZap className="w-3 h-3" /> Disconnect
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : subTab === 'analytics' && report ? (
        <div className="space-y-6">
          <div className="artena-card p-6">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
                  Daily Throughput (MB)
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  Aggregate traffic volume across all Artena relay protocols
                </p>
              </div>
              <select
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
                className="h-9 px-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 text-xs"
              >
                <option value={7}>Last 7 days</option>
                <option value={14}>Last 14 days</option>
                <option value={30}>Last 30 days</option>
              </select>
            </div>
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={report.series} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.18)" vertical={false} />
                  <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#64748B' }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: '#64748B' }} axisLine={false} tickLine={false} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#0A131C',
                      border: '1px solid #17334A',
                      borderRadius: '12px',
                      fontSize: '12px',
                      color: '#F6FAFD',
                    }}
                  />
                  <Bar dataKey="trafficMb" fill="#2E8A94" radius={[6, 6, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="artena-card p-6">
              <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100 mb-4">
                Protocol Distribution
              </h3>
              {report.protocolDistribution.length === 0 ? (
                <p className="text-xs text-slate-500 py-8 text-center">No services yet.</p>
              ) : (
                <div className="space-y-3">
                  {report.protocolDistribution.map((p) => {
                    const pct = totalProtoCount > 0 ? Math.round((p.count / totalProtoCount) * 100) : 0;
                    return (
                      <div key={p.protocol} className="space-y-1 text-xs">
                        <div className="flex items-center justify-between">
                          <span className="text-slate-700 dark:text-slate-300 font-medium">{p.protocol}</span>
                          <span className="font-mono tabular-nums font-semibold text-slate-900 dark:text-slate-100">
                            {p.count} ({pct}%)
                          </span>
                        </div>
                        <div className="h-1.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                          <div className="h-full rounded-full bg-teal-600 dark:bg-teal-400" style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="artena-card p-6">
              <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100 mb-4">
                Top Bandwidth Consumers
              </h3>
              {report.topServices.length === 0 ? (
                <p className="text-xs text-slate-500 py-8 text-center">No service usage recorded yet.</p>
              ) : (
                <div className="divide-y divide-slate-100 dark:divide-slate-800/80">
                  {report.topServices.map((s) => (
                    <div key={s.id} className="py-2.5 flex items-center justify-between text-xs">
                      <div className="min-w-0">
                        <p className="font-semibold text-slate-900 dark:text-slate-100 truncate">{s.label}</p>
                        <p className="text-[11px] text-slate-500">{s.protocol}</p>
                      </div>
                      <span className="font-mono tabular-nums text-slate-700 dark:text-slate-300">
                        {formatBytes(s.usedBytes)} / {s.limitBytes > 0 ? formatBytes(s.limitBytes) : '∞'}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : subTab === 'activity' ? (
        <div className="artena-card p-6">
          <div className="flex items-center gap-2.5 mb-4">
            <div className="w-8 h-8 rounded-xl bg-teal-50 dark:bg-teal-950/60 text-teal-600 dark:text-teal-400 flex items-center justify-center">
              <Activity className="w-4 h-4" />
            </div>
            <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
              Audit Activity Log
            </h2>
          </div>
          {activity.length === 0 ? (
            <p className="text-xs text-slate-500 py-8 text-center">No events recorded.</p>
          ) : (
            <div className="divide-y divide-slate-100 dark:divide-slate-800/80">
              {activity.map((item) => (
                <div key={item.id} className="py-2.5 flex items-center justify-between gap-4 text-xs">
                  <div className="min-w-0 truncate">
                    <span
                      className={`font-mono uppercase text-[11px] font-semibold mr-2.5 ${
                        item.level === 'error'
                          ? 'text-red-600 dark:text-red-400'
                          : item.level === 'warn'
                            ? 'text-amber-600 dark:text-amber-400'
                            : item.level === 'ok'
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : 'text-slate-500'
                      }`}
                    >
                      {item.kind}
                    </span>
                    <span className="text-slate-800 dark:text-slate-200">{item.message}</span>
                  </div>
                  <span className="font-mono tabular-nums text-[11px] text-slate-400 whitespace-nowrap">
                    {formatTimestamp(item.time)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="artena-card p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-xl bg-red-50 dark:bg-red-950/60 text-red-600 dark:text-red-400 flex items-center justify-center">
                <AlertCircle className="w-4 h-4" />
              </div>
              <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
                Error Center
              </h2>
            </div>
            {errors.length > 0 && (
              <button
                type="button"
                onClick={() => void clearErrors()}
                className="h-9 px-3 rounded-xl border border-red-200 dark:border-red-900 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 inline-flex items-center gap-1.5"
              >
                <Trash2 className="w-3.5 h-3.5" /> Clear Log
              </button>
            )}
          </div>
          {errors.length === 0 ? (
            <p className="text-xs text-slate-500 py-10 text-center">No runtime errors logged.</p>
          ) : (
            <div className="divide-y divide-slate-100 dark:divide-slate-800/80">
              {errors.map((err) => (
                <div key={err.id} className="py-3 text-xs space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="font-mono font-semibold text-red-600 dark:text-red-400">{err.source}</span>
                    <span className="font-mono tabular-nums text-slate-400">{formatTimestamp(err.time)}</span>
                  </div>
                  <p className="text-slate-800 dark:text-slate-200">{err.message}</p>
                  {err.detail && <p className="font-mono text-[11px] text-slate-500">{err.detail}</p>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
