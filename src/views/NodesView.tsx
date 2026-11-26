import { useEffect, useState, type FormEvent } from 'react';
import { Copy, KeyRound, Network, Plus, RefreshCw, Server, Trash2 } from 'lucide-react';
import { apiRequest, copyToClipboard, formatBytes } from '../lib/api';

interface NodeItem {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  tokenHint: string;
  status: {
    online: boolean;
    latencyMs?: number;
    activeLinks?: number;
    liveConnections?: number;
    totalBytes?: number;
    cpu?: number;
    mem?: number;
    error: string;
  } | null;
}

export function NodesView({
  onToast,
}: {
  onToast: (msg: string, tone?: 'ok' | 'error' | 'info') => void;
}) {
  const [nodes, setNodes] = useState<NodeItem[]>([]);
  const [tokenState, setTokenState] = useState<{ enabled: boolean; token: string | null; createdAt: string | null }>({
    enabled: false,
    token: null,
    createdAt: null,
  });
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [testing, setTesting] = useState(false);

  const load = async () => {
    try {
      const [nRes, tRes] = await Promise.all([
        apiRequest<{ nodes: NodeItem[] }>('/api/nodes'),
        apiRequest<{ enabled: boolean; token: string | null; createdAt: string | null }>('/api/node/token'),
      ]);
      setNodes(nRes.nodes || []);
      setTokenState(tRes);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const handleRotateToken = async () => {
    try {
      const res = await apiRequest<{ enabled: boolean; token: string; createdAt: string }>('/api/node/token', {
        method: 'POST',
      });
      setTokenState(res);
      onToast('Node federation token generated', 'ok');
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Failed to generate token', 'error');
    }
  };

  const handleDisableToken = async () => {
    try {
      await apiRequest('/api/node/token', { method: 'DELETE' });
      setTokenState({ enabled: false, token: null, createdAt: null });
      onToast('Node federation token disabled', 'info');
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Failed to disable token', 'error');
    }
  };

  const handleTestConnection = async () => {
    setTesting(true);
    try {
      const res = await apiRequest<{ status: { online: boolean; latencyMs?: number; error?: string } }>('/api/nodes/test', {
        method: 'POST',
        body: { url, token },
      });
      if (res.status.online) {
        onToast(`Remote node reachable (${res.status.latencyMs} ms)`, 'ok');
      } else {
        onToast(`Probe failed: ${res.status.error}`, 'error');
      }
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Test failed', 'error');
    } finally {
      setTesting(false);
    }
  };

  const handleAddNode = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await apiRequest('/api/nodes', { method: 'POST', body: { name, url, token } });
      setName('');
      setUrl('');
      setToken('');
      await load();
      onToast('Federated Artena node added', 'ok');
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Failed to add node', 'error');
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-display text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-50">
          Multi-Node Federation Mesh
        </h2>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
          Link multiple Artena Panel deployments to monitor remote capacity and aggregate endpoints into unified subscriptions.
        </p>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
        {/* Local Node Mode */}
        <div className="xl:col-span-5 artena-card p-5 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                Local Node Federation Token
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 leading-relaxed">
                Allow another primary Artena Panel controller to monitor and link endpoints from this server.
              </p>
            </div>
            <div className="w-8 h-8 rounded-xl bg-teal-50 dark:bg-teal-950/60 text-teal-600 dark:text-teal-400 flex items-center justify-center shrink-0">
              <KeyRound className="w-4 h-4" />
            </div>
          </div>

          {tokenState.enabled && tokenState.token ? (
            <div className="space-y-2.5">
              <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 font-mono text-xs break-all text-slate-700 dark:text-slate-200">
                {tokenState.token}
              </div>
              <div className="flex items-center gap-2 text-xs">
                <button
                  type="button"
                  onClick={() => void copyToClipboard(tokenState.token!).then(() => onToast('Node token copied', 'ok'))}
                  className="px-3 py-1.5 rounded-xl border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5 font-medium"
                >
                  <Copy className="w-3.5 h-3.5" /> Copy
                </button>
                <button
                  type="button"
                  onClick={handleRotateToken}
                  className="px-3 py-1.5 rounded-xl border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 font-medium"
                >
                  Rotate
                </button>
                <button
                  type="button"
                  onClick={handleDisableToken}
                  className="px-3 py-1.5 rounded-xl text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/50 font-medium"
                >
                  Disable
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={handleRotateToken}
              className="h-9 px-4 rounded-xl bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 text-xs font-medium hover:opacity-90 transition-opacity"
            >
              Generate Node Token
            </button>
          )}
        </div>

        {/* Add Remote Node */}
        <div className="xl:col-span-7 artena-card p-5 space-y-3.5">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-teal-50 dark:bg-teal-950/60 text-teal-600 dark:text-teal-400 flex items-center justify-center">
              <Network className="w-4 h-4" />
            </div>
            <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
              Connect Remote Artena Node
            </h3>
          </div>
          <form onSubmit={handleAddNode} className="space-y-3 text-xs">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Node Name (e.g., Tokyo-Edge)"
                className="h-9 px-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 focus:outline-none focus:ring-2 focus:ring-teal-500/30"
              />
              <input
                type="url"
                required
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://node.example.com"
                className="h-9 px-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 font-mono focus:outline-none focus:ring-2 focus:ring-teal-500/30"
              />
            </div>
            <input
              type="password"
              required
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Remote Node Federation Bearer Token"
              className="w-full h-9 px-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 font-mono focus:outline-none focus:ring-2 focus:ring-teal-500/30"
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={testing || !url || !token}
                onClick={handleTestConnection}
                className="h-9 px-3.5 rounded-xl border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 font-medium disabled:opacity-50 transition-colors"
              >
                {testing ? 'Probing...' : 'Test Probe'}
              </button>
              <button
                type="submit"
                className="h-9 px-4 rounded-xl bg-gradient-to-b from-[#E8AE5C] to-[#D08F35] hover:from-[#F0BC70] hover:to-[#DC9E49] text-[#0A131C] font-semibold shadow-[0_2px_10px_-2px_rgba(225,159,72,0.45)] font-medium inline-flex items-center gap-1.5 shadow-sm shadow-teal-600/20 transition-all"
              >
                <Plus className="w-3.5 h-3.5" /> Register Node
              </button>
            </div>
          </form>
        </div>
      </div>

      {/* Remote Nodes List */}
      <div className="artena-card overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
          <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
            Federated Nodes ({nodes.length})
          </h3>
          {nodes.length > 0 && (
            <button
              type="button"
              onClick={() =>
                void apiRequest('/api/nodes/check-all', { method: 'POST' }).then(() => {
                  void load();
                  onToast('Refreshed all node statuses', 'ok');
                })
              }
              className="text-xs font-medium text-teal-600 dark:text-teal-400 inline-flex items-center gap-1 hover:underline"
            >
              <RefreshCw className="w-3.5 h-3.5" /> Check All
            </button>
          )}
        </div>
        {loading ? (
          <div className="p-8 text-center text-xs text-slate-500">Loading nodes...</div>
        ) : nodes.length === 0 ? (
          <div className="p-12 text-center space-y-2.5 text-xs text-slate-500 dark:text-slate-400">
            <div className="w-10 h-10 rounded-2xl bg-slate-100 dark:bg-slate-800 text-slate-400 flex items-center justify-center mx-auto">
              <Server className="w-5 h-5" />
            </div>
            <p className="font-medium text-slate-700 dark:text-slate-200">No remote nodes connected yet</p>
            <p className="max-w-md mx-auto">
              Register another Artena Panel instance above to monitor health and aggregate endpoints centrally.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-slate-100 dark:divide-slate-800/80">
            {nodes.map((n) => (
              <div key={n.id} className="p-4 sm:px-5 flex flex-wrap items-center justify-between gap-4 text-xs hover:bg-slate-50/70 dark:hover:bg-slate-800/30 transition-colors">
                <div>
                  <div className="font-semibold text-slate-900 dark:text-slate-100">{n.name}</div>
                  <div className="font-mono text-[11px] text-slate-400 mt-0.5">
                    {n.url} · Token {n.tokenHint}
                  </div>
                </div>
                <div className="font-mono tabular-nums text-slate-600 dark:text-slate-300">
                  {n.status?.online ? (
                    <span className="text-emerald-700 dark:text-emerald-400 font-medium">
                      Online · {n.status.latencyMs}ms · CPU {n.status.cpu}% · {n.status.activeLinks} links ·{' '}
                      {formatBytes(n.status.totalBytes || 0)}
                    </span>
                  ) : (
                    <span className="text-red-600 dark:text-red-400">{n.status?.error || 'Unchecked'}</span>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => void apiRequest(`/api/nodes/${n.id}/check`, { method: 'POST' }).then(() => void load())}
                    className="px-2.5 py-1 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 font-medium"
                  >
                    Probe
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void apiRequest(`/api/nodes/${n.id}`, { method: 'DELETE' }).then(() => {
                        void load();
                        onToast(`Removed node "${n.name}"`, 'info');
                      })
                    }
                    aria-label={`Delete node ${n.name}`}
                    className="p-1.5 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/50 transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
