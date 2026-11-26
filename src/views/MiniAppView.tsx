import { useEffect, useState, type FormEvent } from 'react';
import {
  Activity,
  ArrowLeft,
  Copy,
  Cpu,
  FolderKanban,
  LayoutDashboard,
  Plus,
  QrCode,
  Radio,
  RefreshCw,
  Server,
  ShieldCheck,
  Wrench,
  X,
} from 'lucide-react';
import { copyToClipboard as copyText, formatBytes, formatTimestamp, getAuthToken } from '../lib/api';
import { ArtenaLogoMark } from '../components/ArtenaBrand';
import { QrCodeCanvas } from '../components/QrCodeCanvas';

declare global {
  interface Window {
    Telegram?: {
      WebApp?: {
        initData?: string;
        ready?: () => void;
        expand?: () => void;
      };
    };
  }
}

interface TmaService {
  id: string;
  label: string;
  protocolLabel: string;
  active: boolean;
  expired: boolean;
  usedBytes: number;
  limitBytes: number;
  remainingText: string;
  uri: string;
  subUrl: string;
}

interface TmaState {
  services: TmaService[];
  total: number;
  active: number;
  near: number;
  traffic: number;
  online: number;
  protocols: string[];
  groups: Array<{ id: string; name: string; count: number; url: string }>;
  server: { cpu: number; ram: number; uptimeSec: number };
  host: string;
  support: string;
}

async function tmaCall<T>(action: string, body?: unknown): Promise<T> {
  const tgInit = window.Telegram?.WebApp?.initData || '';
  const bearer = getAuthToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (tgInit) headers['x-tg-init'] = tgInit;
  else if (bearer) headers.Authorization = `Bearer ${bearer}`;

  const res = await fetch(`/api/tma/${action}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data as T;
}

export function MiniAppView({ onBackToPanel }: { onBackToPanel: () => void }) {
  const [tab, setTab] = useState<'overview' | 'services' | 'groups' | 'tools'>('overview');
  const [state, setState] = useState<TmaState | null>(null);
  const [logs, setLogs] = useState<Array<{ id: string; kind: string; message: string; time: string }>>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [qrService, setQrService] = useState<TmaService | null>(null);

  // Quick create form
  const [showCreate, setShowCreate] = useState(false);
  const [label, setLabel] = useState('');
  const [protocol, setProtocol] = useState('vless-ws');
  const [gb, setGb] = useState('50');
  const [days, setDays] = useState('30');

  // New group
  const [groupName, setGroupName] = useState('');

  const flash = (msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice(''), 2600);
  };

  const load = async () => {
    setError('');
    try {
      const s = await tmaCall<TmaState>('state');
      setState(s);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to authenticate Mini App');
    }
  };

  const loadLogs = async () => {
    try {
      const res = await tmaCall<{ logs: Array<{ id: string; kind: string; message: string; time: string }> }>('activity');
      setLogs(res.logs || []);
    } catch {
      // Ignore
    }
  };

  useEffect(() => {
    window.Telegram?.WebApp?.ready?.();
    window.Telegram?.WebApp?.expand?.();
    void load();
  }, []);

  useEffect(() => {
    if (tab === 'tools') void loadLogs();
  }, [tab]);

  const createQuick = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await tmaCall('create', { label, protocol, gb: Number(gb) || 0, days: Number(days) || 0 });
      setLabel('');
      setShowCreate(false);
      flash('Service provisioned');
      await load();
    } catch (err) {
      flash(err instanceof Error ? err.message : 'Create failed');
    }
  };

  const runOp = async (id: string, op: string, v?: number) => {
    try {
      await tmaCall('edit', { id, op, v });
      flash('Updated');
      await load();
    } catch (err) {
      flash(err instanceof Error ? err.message : 'Action failed');
    }
  };

  const createGroup = async (e: FormEvent) => {
    e.preventDefault();
    if (!groupName.trim()) return;
    try {
      const activeIds = (state?.services || []).filter((s) => s.active).map((s) => s.id);
      await tmaCall('group_create', { name: groupName.trim(), ids: activeIds });
      setGroupName('');
      flash('Group created');
      await load();
    } catch (err) {
      flash(err instanceof Error ? err.message : 'Failed to create group');
    }
  };

  const deleteGroup = async (gid: string) => {
    try {
      await tmaCall('group_del', { gid });
      flash('Group deleted');
      await load();
    } catch {
      flash('Delete failed');
    }
  };

  return (
    <div className="min-h-screen artena-canvas text-slate-900 dark:text-slate-100 pb-20">
      {/* Compact 56px Sticky Top Bar */}
      <header className="sticky top-0 z-30 h-14 px-4 bg-white/90 dark:bg-[#0A131C]/90 backdrop-blur-md border-b border-slate-200/80 dark:border-slate-800/80 flex items-center justify-between max-w-lg mx-auto">
        <div className="flex items-center gap-2 min-w-0">
          <button
            type="button"
            onClick={onBackToPanel}
            aria-label="Back to admin panel"
            className="w-9 h-9 rounded-xl flex items-center justify-center text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <ArtenaLogoMark className="w-6 h-6 shrink-0" />
          <span className="font-display text-sm font-semibold tracking-tight truncate">Artena Mini App</span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="h-9 px-3 rounded-xl bg-gradient-to-b from-[#E8AE5C] to-[#D08F35] hover:from-[#F0BC70] hover:to-[#DC9E49] text-[#0A131C] font-semibold shadow-[0_2px_10px_-2px_rgba(225,159,72,0.45)] text-xs font-medium inline-flex items-center gap-1 shadow-sm shadow-teal-600/20"
          >
            <Plus className="w-3.5 h-3.5" /> New
          </button>
          <button
            type="button"
            onClick={() => void load()}
            aria-label="Refresh Mini App"
            className="w-9 h-9 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 flex items-center justify-center text-slate-600 dark:text-slate-300"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </header>

      {notice && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-xl bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 text-xs font-medium shadow-xl artena-enter">
          {notice}
        </div>
      )}

      <main className="max-w-lg mx-auto px-4 py-4 space-y-4">
        {error ? (
          <div className="artena-card p-6 space-y-3 text-center">
            <ArtenaLogoMark className="w-10 h-10 mx-auto" />
            <p className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
              Authentication Required
            </p>
            <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">{error}</p>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Open this page from your Telegram Bot menu button (with valid WebAppData), or sign in to Artena Panel first.
            </p>
            <button
              type="button"
              onClick={onBackToPanel}
              className="w-full h-11 rounded-xl bg-gradient-to-b from-[#E8AE5C] to-[#D08F35] hover:from-[#F0BC70] hover:to-[#DC9E49] text-[#0A131C] font-semibold shadow-[0_2px_10px_-2px_rgba(225,159,72,0.45)] text-xs font-medium shadow-sm shadow-teal-600/20"
            >
              Sign in via Artena Panel
            </button>
          </div>
        ) : !state ? (
          <div className="space-y-3">
            <div className="h-24 artena-card opacity-60" />
            <div className="h-32 artena-card opacity-60" />
          </div>
        ) : tab === 'overview' ? (
          <div className="space-y-4 artena-enter">
            <div className="grid grid-cols-2 gap-3">
              <div className="artena-card p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-medium text-slate-500">Active Services</span>
                  <ShieldCheck className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400" />
                </div>
                <p className="font-mono tabular-nums text-2xl font-semibold">
                  {state.active} <span className="text-xs font-normal text-slate-400">/ {state.total}</span>
                </p>
              </div>
              <div className="artena-card p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-medium text-slate-500">Online Streams</span>
                  <Radio className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                </div>
                <p className="font-mono tabular-nums text-2xl font-semibold">{state.online}</p>
              </div>
              <div className="artena-card p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-medium text-slate-500">Transferred</span>
                  <Activity className="w-3.5 h-3.5 text-slate-500" />
                </div>
                <p className="font-mono tabular-nums text-lg font-semibold">{formatBytes(state.traffic)}</p>
              </div>
              <div className="artena-card p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-medium text-slate-500">CPU / RAM</span>
                  <Cpu className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400" />
                </div>
                <p className="font-mono tabular-nums text-lg font-semibold">
                  {state.server.cpu}% · {state.server.ram}%
                </p>
              </div>
            </div>

            <div className="artena-card p-4 space-y-2.5">
              <div className="flex items-center justify-between">
                <h2 className="font-display text-sm font-semibold">Recent Services</h2>
                <button
                  type="button"
                  onClick={() => setTab('services')}
                  className="text-xs font-medium text-teal-600 dark:text-teal-400 hover:underline"
                >
                  View all
                </button>
              </div>
              {state.services.length === 0 ? (
                <p className="text-xs text-slate-500 py-5 text-center">No services yet. Tap New to provision one.</p>
              ) : (
                state.services.slice(0, 4).map((s) => (
                  <div
                    key={s.id}
                    className="py-2.5 border-t border-slate-100 dark:border-slate-800/80 flex items-center justify-between gap-2"
                  >
                    <div className="min-w-0">
                      <p className="text-xs font-semibold truncate">{s.label}</p>
                      <p className="text-[11px] font-mono text-slate-500 mt-0.5">
                        {formatBytes(s.usedBytes)} / {s.limitBytes > 0 ? formatBytes(s.limitBytes) : '∞'} · {s.remainingText}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setQrService(s)}
                      className="h-9 px-2.5 rounded-xl border border-slate-200 dark:border-slate-700 text-xs font-medium inline-flex items-center gap-1 shrink-0"
                    >
                      <QrCode className="w-3.5 h-3.5" /> QR
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        ) : tab === 'services' ? (
          <div className="space-y-3 artena-enter">
            {state.services.length === 0 ? (
              <div className="artena-card p-8 text-center text-xs text-slate-500">
                No services provisioned yet.
              </div>
            ) : (
              state.services.map((s) => {
                const pct = s.limitBytes > 0 ? Math.min(100, Math.round((s.usedBytes / s.limitBytes) * 100)) : 0;
                return (
                  <div key={s.id} className="artena-card p-4 space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold truncate">{s.label}</p>
                        <p className="text-[11px] font-mono text-slate-500 mt-0.5">
                          {s.protocolLabel} ·{' '}
                          <span
                            className={
                              s.expired
                                ? 'text-red-600 dark:text-red-400'
                                : s.active
                                  ? 'text-emerald-700 dark:text-emerald-400'
                                  : 'text-amber-600 dark:text-amber-400'
                            }
                          >
                            {s.active && !s.expired ? 'Active' : s.expired ? 'Expired' : 'Paused'}
                          </span>
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setQrService(s)}
                        className="h-9 px-2.5 rounded-xl border border-slate-200 dark:border-slate-700 text-xs font-medium inline-flex items-center gap-1 shrink-0"
                      >
                        <QrCode className="w-3.5 h-3.5" /> QR
                      </button>
                    </div>
                    <div className="space-y-1.5">
                      <div className="text-xs font-mono tabular-nums text-slate-600 dark:text-slate-300 flex items-center justify-between">
                        <span>
                          {formatBytes(s.usedBytes)} / {s.limitBytes > 0 ? formatBytes(s.limitBytes) : 'Unlimited'}
                        </span>
                        <span>{s.remainingText}</span>
                      </div>
                      {s.limitBytes > 0 && (
                        <div className="h-1.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                          <div
                            className={`h-full rounded-full ${pct > 85 ? 'bg-amber-500' : 'bg-teal-600 dark:bg-teal-400'}`}
                            style={{ width: `${Math.max(2, pct)}%` }}
                          />
                        </div>
                      )}
                    </div>
                    <div className="grid grid-cols-4 gap-1.5">
                      <button
                        type="button"
                        onClick={() => void runOp(s.id, 'toggle')}
                        className="h-11 rounded-xl border border-slate-200 dark:border-slate-700 text-[11px] font-medium"
                      >
                        {s.active ? 'Pause' : 'Enable'}
                      </button>
                      <button
                        type="button"
                        onClick={() => void runOp(s.id, 'gb', 10)}
                        className="h-11 rounded-xl border border-slate-200 dark:border-slate-700 text-[11px] font-mono"
                      >
                        +10GB
                      </button>
                      <button
                        type="button"
                        onClick={() => void runOp(s.id, 'd', 30)}
                        className="h-11 rounded-xl border border-slate-200 dark:border-slate-700 text-[11px] font-mono"
                      >
                        +30d
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          if (s.uri) {
                            await copyText(s.uri);
                            flash('URI copied');
                          }
                        }}
                        className="h-11 rounded-xl bg-gradient-to-b from-[#E8AE5C] to-[#D08F35] hover:from-[#F0BC70] hover:to-[#DC9E49] text-[#0A131C] font-semibold shadow-[0_2px_10px_-2px_rgba(225,159,72,0.45)] text-[11px] font-medium inline-flex items-center justify-center gap-1"
                      >
                        <Copy className="w-3 h-3" /> URI
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        ) : tab === 'groups' ? (
          <div className="space-y-4 artena-enter">
            <form onSubmit={createGroup} className="artena-card p-4 flex gap-2">
              <input
                type="text"
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
                placeholder="New subscription group name"
                className="flex-1 h-11 px-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 text-xs"
              />
              <button
                type="submit"
                className="h-11 px-4 rounded-xl bg-gradient-to-b from-[#E8AE5C] to-[#D08F35] hover:from-[#F0BC70] hover:to-[#DC9E49] text-[#0A131C] font-semibold shadow-[0_2px_10px_-2px_rgba(225,159,72,0.45)] text-xs font-medium shrink-0"
              >
                Create
              </button>
            </form>

            {state.groups.map((g) => (
              <div key={g.id} className="artena-card p-4 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-semibold truncate">{g.name}</p>
                  <p className="text-xs font-mono text-slate-500 mt-0.5">{g.count} endpoint(s)</p>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={async () => {
                      await copyText(g.url);
                      flash('Portal URL copied');
                    }}
                    className="h-11 px-3 rounded-xl border border-slate-200 dark:border-slate-700 text-xs font-medium"
                  >
                    Copy Link
                  </button>
                  <button
                    type="button"
                    onClick={() => void deleteGroup(g.id)}
                    className="h-11 px-3 rounded-xl border border-red-200 dark:border-red-900 text-xs font-medium text-red-600"
                  >
                    Del
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="artena-card p-4 space-y-3 artena-enter">
            <div className="flex items-center gap-2">
              <Activity className="w-4 h-4 text-teal-600 dark:text-teal-400" />
              <h2 className="font-display text-sm font-semibold">Recent Activity</h2>
            </div>
            {logs.length === 0 ? (
              <p className="text-xs text-slate-500 py-5 text-center">No recent logs.</p>
            ) : (
              <div className="divide-y divide-slate-100 dark:divide-slate-800/80">
                {logs.slice(0, 15).map((l) => (
                  <div key={l.id} className="py-2.5 text-xs">
                    <p className="text-slate-800 dark:text-slate-200">{l.message}</p>
                    <p className="text-[11px] font-mono text-slate-400 mt-0.5">{formatTimestamp(l.time)}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </main>

      {/* Fixed 4-Tab Bottom Navigation (64px height, >=44px tap targets) */}
      <nav
        aria-label="Mini App navigation"
        className="fixed bottom-0 inset-x-0 z-30 h-16 bg-white/95 dark:bg-[#0A131C]/95 backdrop-blur-md border-t border-slate-200/80 dark:border-slate-800/80 grid grid-cols-4 max-w-lg mx-auto"
      >
        {[
          { id: 'overview', label: 'Overview', icon: LayoutDashboard },
          { id: 'services', label: 'Services', icon: Server },
          { id: 'groups', label: 'Groups', icon: FolderKanban },
          { id: 'tools', label: 'Tools', icon: Wrench },
        ].map((item) => {
          const Icon = item.icon;
          const active = tab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id as typeof tab)}
              className={`flex flex-col items-center justify-center gap-1 min-h-[44px] text-[11px] font-medium transition-colors ${
                active ? 'text-teal-600 dark:text-teal-400' : 'text-slate-500 dark:text-slate-400'
              }`}
            >
              <Icon className="w-4 h-4" />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>

      {/* Quick Create Sheet */}
      {showCreate && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-end sm:items-center justify-center p-4"
          onClick={() => setShowCreate(false)}
        >
          <div
            className="w-full max-w-md artena-card p-5 space-y-4 shadow-2xl artena-enter"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="font-display text-sm font-semibold">Quick Provision</h3>
              <button type="button" onClick={() => setShowCreate(false)} className="p-1.5 text-slate-400">
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={createQuick} className="space-y-3">
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Label (optional)"
                className="w-full h-11 px-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 text-xs"
              />
              <select
                value={protocol}
                onChange={(e) => setProtocol(e.target.value)}
                className="w-full h-11 px-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 text-xs"
              >
                <option value="vless-ws">VLESS WebSocket</option>
                <option value="xhttp-packet-up">XHTTP Packet-Up</option>
                <option value="xhttp-stream-up">XHTTP Stream-Up</option>
                <option value="vless-tcp">VLESS Raw TCP</option>
              </select>
              <div className="grid grid-cols-2 gap-2.5">
                <input
                  type="number"
                  min={0}
                  value={gb}
                  onChange={(e) => setGb(e.target.value)}
                  placeholder="GB"
                  className="h-11 px-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 text-xs font-mono"
                />
                <input
                  type="number"
                  min={0}
                  value={days}
                  onChange={(e) => setDays(e.target.value)}
                  placeholder="Days"
                  className="h-11 px-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 text-xs font-mono"
                />
              </div>
              <button
                type="submit"
                className="w-full h-11 rounded-xl bg-gradient-to-b from-[#E8AE5C] to-[#D08F35] hover:from-[#F0BC70] hover:to-[#DC9E49] text-[#0A131C] font-semibold shadow-[0_2px_10px_-2px_rgba(225,159,72,0.45)] text-xs font-medium shadow-sm shadow-teal-600/20"
              >
                Provision Service
              </button>
            </form>
          </div>
        </div>
      )}

      {/* QR Sheet */}
      {qrService && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-end sm:items-center justify-center p-4"
          onClick={() => setQrService(null)}
        >
          <div
            className="w-full max-w-sm artena-card p-5 space-y-3 shadow-2xl artena-enter"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="font-display text-sm font-semibold truncate">{qrService.label}</h3>
              <button type="button" onClick={() => setQrService(null)} className="p-1.5 text-slate-400">
                <X className="w-4 h-4" />
              </button>
            </div>
            {qrService.uri ? (
              <QrCodeCanvas value={qrService.uri} label={qrService.label} />
            ) : (
              <p className="text-xs text-amber-600 py-4 text-center">
                URI unavailable — check TCP_PUBLIC_HOST / TCP_PUBLIC_PORT or PUBLIC_BASE_URL configuration.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
