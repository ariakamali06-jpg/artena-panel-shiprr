import { useEffect, useState, type FormEvent } from 'react';
import { Download, Globe2, Play, Plus, Radar, RefreshCw, Square, Trash2 } from 'lucide-react';
import { apiRequest } from '../lib/api';

interface ProxyItem {
  id: string;
  name: string;
  scheme: 'socks5' | 'socks4' | 'http';
  host: string;
  port: number;
  username: string;
  hasPassword: boolean;
  enabled: boolean;
  usageCount: number;
  lastTest?: {
    ok: boolean;
    latencyMs: number | null;
    tlsOk: boolean;
    score: number;
    grade: string;
    error: string;
    testedAt: string;
  };
}

interface ScanJobState {
  id: string;
  status: 'running' | 'completed' | 'cancelled';
  total: number;
  done: number;
  passed: number;
  results: Array<{
    candidate: { scheme: string; host: string; port: number };
    ok: boolean;
    latencyMs: number | null;
    tlsOk: boolean;
    score: number;
    grade: string;
    error: string;
  }>;
}

export function ProxiesView({
  onToast,
}: {
  onToast: (msg: string, tone?: 'ok' | 'error' | 'info') => void;
}) {
  const [proxies, setProxies] = useState<ProxyItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [testingId, setTestingId] = useState<string | null>(null);

  // Add form
  const [name, setName] = useState('');
  const [scheme, setScheme] = useState<'socks5' | 'socks4' | 'http'>('socks5');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('1080');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  // Live Scanner
  const [scanText, setScanText] = useState('');
  const [scanScheme, setScanScheme] = useState<'socks5' | 'socks4' | 'http'>('socks5');
  const [scanJob, setScanJob] = useState<ScanJobState | null>(null);

  const load = async () => {
    try {
      const res = await apiRequest<{ proxies: ProxyItem[] }>('/api/proxies');
      setProxies(res.proxies || []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (!scanJob || scanJob.status !== 'running') return;
    const timer = setInterval(async () => {
      try {
        const res = await apiRequest<{ job: ScanJobState }>(`/api/proxies/scan/${scanJob.id}`);
        setScanJob(res.job);
      } catch {
        clearInterval(timer);
      }
    }, 1200);
    return () => clearInterval(timer);
  }, [scanJob?.id, scanJob?.status]);

  const handleAdd = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await apiRequest('/api/proxies', {
        method: 'POST',
        body: { name, scheme, host, port: Number(port), username, password },
      });
      setName('');
      setHost('');
      setUsername('');
      setPassword('');
      await load();
      onToast('Outbound proxy saved', 'ok');
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Failed to save proxy', 'error');
    }
  };

  const handleTest = async (id: string) => {
    setTestingId(id);
    try {
      const res = await apiRequest<{ proxy: ProxyItem }>(`/api/proxies/${id}/test`, { method: 'POST' });
      await load();
      const lt = res.proxy.lastTest;
      onToast(
        lt?.ok ? `Proxy healthy (${lt.latencyMs} ms, Grade ${lt.grade})` : `Test failed: ${lt?.error}`,
        lt?.ok ? 'ok' : 'error',
      );
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Test failed', 'error');
    } finally {
      setTestingId(null);
    }
  };

  const handleStartScan = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const res = await apiRequest<{ jobId: string; total: number }>('/api/proxies/scan/start', {
        method: 'POST',
        body: { lines: scanText, defaultScheme: scanScheme, checkTls: true },
      });
      const initial = await apiRequest<{ job: ScanJobState }>(`/api/proxies/scan/${res.jobId}`);
      setScanJob(initial.job);
      onToast(`Started live scan of ${res.total} candidates`, 'info');
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Scan failed to start', 'error');
    }
  };

  const handleImportScan = async () => {
    if (!scanJob) return;
    try {
      const res = await apiRequest<{ imported: number }>(`/api/proxies/scan/${scanJob.id}/import`, {
        method: 'POST',
        body: { minScore: 40 },
      });
      await load();
      onToast(`Imported ${res.imported} verified outbound proxies`, 'ok');
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Import failed', 'error');
    }
  };

  const scanPct = scanJob && scanJob.total > 0 ? Math.round((scanJob.done / scanJob.total) * 100) : 0;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-display text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-50">
          Outbound Proxy Routing & Live Scanner
        </h2>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
          Chain Artena relay traffic through verified SOCKS5, SOCKS4, or HTTP CONNECT exit proxies.
        </p>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
        {/* Add Proxy Form */}
        <div className="xl:col-span-5 artena-card p-5 space-y-4">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-teal-50 dark:bg-teal-950/60 text-teal-600 dark:text-teal-400 flex items-center justify-center">
              <Globe2 className="w-4 h-4" />
            </div>
            <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
              Add Outbound Exit Proxy
            </h3>
          </div>
          <form onSubmit={handleAdd} className="space-y-3 text-xs">
            <div className="grid grid-cols-3 gap-2">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Label (e.g. NL-Exit)"
                className="col-span-2 h-9 px-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 focus:outline-none focus:ring-2 focus:ring-teal-500/30"
              />
              <select
                aria-label="Proxy scheme"
                value={scheme}
                onChange={(e) => setScheme(e.target.value as 'socks5' | 'socks4' | 'http')}
                className="h-9 px-2.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 uppercase"
              >
                <option value="socks5">SOCKS5</option>
                <option value="socks4">SOCKS4</option>
                <option value="http">HTTP</option>
              </select>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <input
                type="text"
                required
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="Public host or IP"
                className="col-span-2 h-9 px-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 font-mono focus:outline-none focus:ring-2 focus:ring-teal-500/30"
              />
              <input
                type="number"
                required
                min={1}
                max={65535}
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder="Port"
                className="h-9 px-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 font-mono"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Username (optional)"
                className="h-9 px-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700"
              />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password (optional)"
                className="h-9 px-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700"
              />
            </div>
            <button
              type="submit"
              className="h-9 px-4 rounded-xl bg-gradient-to-b from-[#E8AE5C] to-[#D08F35] hover:from-[#F0BC70] hover:to-[#DC9E49] text-[#0A131C] font-semibold shadow-[0_2px_10px_-2px_rgba(225,159,72,0.45)] font-medium inline-flex items-center gap-1.5 shadow-sm shadow-teal-600/20 transition-all"
            >
              <Plus className="w-3.5 h-3.5" /> Save Proxy
            </button>
          </form>
        </div>

        {/* Live Proxy Scanner */}
        <div className="xl:col-span-7 artena-card p-5 space-y-3.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-teal-50 dark:bg-teal-950/60 text-teal-600 dark:text-teal-400 flex items-center justify-center">
                <Radar className="w-4 h-4" />
              </div>
              <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                Live Outbound Proxy Scanner
              </h3>
            </div>
            <select
              aria-label="Default scan scheme"
              value={scanScheme}
              onChange={(e) => setScanScheme(e.target.value as 'socks5' | 'socks4' | 'http')}
              className="h-8 px-2.5 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 text-xs"
            >
              <option value="socks5">Default: SOCKS5</option>
              <option value="socks4">Default: SOCKS4</option>
              <option value="http">Default: HTTP</option>
            </select>
          </div>

          <form onSubmit={handleStartScan} className="space-y-3 text-xs">
            <textarea
              rows={3}
              value={scanText}
              onChange={(e) => setScanText(e.target.value)}
              placeholder="Paste one proxy per line: socks5://user:pass@host:port or host:port"
              className="w-full p-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 font-mono text-[11px] focus:outline-none focus:ring-2 focus:ring-teal-500/30"
            />
            {scanJob && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between font-mono tabular-nums text-[11px] text-slate-500 dark:text-slate-400">
                  <span className="capitalize">{scanJob.status}</span>
                  <span>
                    {scanJob.done}/{scanJob.total} tested · {scanJob.passed} passed ({scanPct}%)
                  </span>
                </div>
                <div className="h-1.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-teal-600 dark:bg-teal-400 transition-all duration-300"
                    style={{ width: `${scanPct}%` }}
                  />
                </div>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="submit"
                className="h-9 px-4 rounded-xl bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 font-medium inline-flex items-center gap-1.5 hover:opacity-90 transition-opacity"
              >
                <Play className="w-3.5 h-3.5" /> Start Live Probe
              </button>
              {scanJob?.status === 'running' && (
                <button
                  type="button"
                  onClick={() => void apiRequest(`/api/proxies/scan/${scanJob.id}/cancel`, { method: 'POST' })}
                  className="h-9 px-3 rounded-xl border border-red-300 dark:border-red-800 text-red-600 dark:text-red-400 inline-flex items-center gap-1"
                >
                  <Square className="w-3 h-3" /> Cancel
                </button>
              )}
              {scanJob && scanJob.passed > 0 && (
                <button
                  type="button"
                  onClick={handleImportScan}
                  className="h-9 px-3.5 rounded-xl bg-gradient-to-b from-[#E8AE5C] to-[#D08F35] hover:from-[#F0BC70] hover:to-[#DC9E49] text-[#0A131C] font-semibold shadow-[0_2px_10px_-2px_rgba(225,159,72,0.45)] font-medium inline-flex items-center gap-1.5 shadow-sm shadow-teal-600/20"
                >
                  <Download className="w-3.5 h-3.5" /> Import {scanJob.passed} Passing
                </button>
              )}
            </div>
          </form>
        </div>
      </div>

      {/* Saved Outbound Proxies Table */}
      <div className="artena-card overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
          <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
            Saved Outbound Proxies ({proxies.length})
          </h3>
        </div>
        {loading ? (
          <div className="p-8 text-center text-xs text-slate-500">Loading proxies...</div>
        ) : proxies.length === 0 ? (
          <div className="p-10 text-center text-xs text-slate-500 dark:text-slate-400">
            No outbound proxies configured. Services currently route traffic directly from the Artena relay server.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-[11px] font-medium text-slate-500 dark:text-slate-400">
                  <th className="py-3 px-4">Proxy</th>
                  <th className="py-3 px-4">Endpoint</th>
                  <th className="py-3 px-4">Last Probe</th>
                  <th className="py-3 px-4 text-right">Assigned Services</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
                {proxies.map((p) => (
                  <tr key={p.id} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40 transition-colors">
                    <td className="py-3.5 px-4 font-medium text-slate-900 dark:text-slate-100">{p.name}</td>
                    <td className="py-3.5 px-4 font-mono text-slate-600 dark:text-slate-300">
                      {p.scheme}://{p.host}:{p.port}
                    </td>
                    <td className="py-3.5 px-4 font-mono">
                      {p.lastTest ? (
                        p.lastTest.ok ? (
                          <span className="text-emerald-700 dark:text-emerald-400 font-medium">
                            Grade {p.lastTest.grade} · {p.lastTest.latencyMs}ms · {p.lastTest.tlsOk ? 'TLS OK' : 'No TLS'}
                          </span>
                        ) : (
                          <span className="text-red-600 dark:text-red-400">{p.lastTest.error || 'Unreachable'}</span>
                        )
                      ) : (
                        <span className="text-slate-400">Not tested</span>
                      )}
                    </td>
                    <td className="py-3.5 px-4 text-right font-mono tabular-nums text-slate-700 dark:text-slate-300">
                      {p.usageCount}
                    </td>
                    <td className="py-3.5 px-4 text-right">
                      <div className="inline-flex items-center gap-1.5">
                        <button
                          type="button"
                          disabled={testingId === p.id}
                          onClick={() => void handleTest(p.id)}
                          aria-label={`Test proxy ${p.name}`}
                          className="px-2.5 py-1 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1 transition-colors"
                        >
                          <RefreshCw className={`w-3 h-3 ${testingId === p.id ? 'animate-spin' : ''}`} />
                          Test
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            void apiRequest(`/api/proxies/${p.id}`, { method: 'DELETE' }).then(() => {
                              void load();
                              onToast(`Deleted proxy "${p.name}"`, 'info');
                            })
                          }
                          aria-label={`Delete proxy ${p.name}`}
                          className="p-1.5 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/50 transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
