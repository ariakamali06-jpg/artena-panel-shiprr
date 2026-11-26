import { useEffect, useState, type FormEvent } from 'react';
import { Copy, ExternalLink, Layers, Lock, Plus, Trash2, X } from 'lucide-react';
import { apiRequest, copyToClipboard, formatTimestamp } from '../lib/api';
import type { ServiceItem } from './ServicesView';

interface SubscriptionGroupItem {
  id: string;
  uuidKey: string;
  name: string;
  description: string;
  hasPassword: boolean;
  linkIds: string[];
  remoteLinks: Array<{
    refId: string;
    nodeName: string;
    label: string;
    orphaned?: boolean;
  }>;
  createdAt: string;
  subFeedUrl: string;
  portalUrl: string;
}

export function SubscriptionsView({
  onToast,
}: {
  onToast: (msg: string, tone?: 'ok' | 'error' | 'info') => void;
}) {
  const [groups, setGroups] = useState<SubscriptionGroupItem[]>([]);
  const [services, setServices] = useState<ServiceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [password, setPassword] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const load = async () => {
    try {
      const [gRes, sRes] = await Promise.all([
        apiRequest<{ subscriptions: SubscriptionGroupItem[] }>('/api/subscriptions'),
        apiRequest<{ services: ServiceItem[] }>('/api/services'),
      ]);
      setGroups(gRes.subscriptions || []);
      setServices(sRes.services || []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await apiRequest('/api/subscriptions', {
        method: 'POST',
        body: { name, description, password, linkIds: selectedIds },
      });
      setShowModal(false);
      setName('');
      setDescription('');
      setPassword('');
      setSelectedIds([]);
      await load();
      onToast('Subscription group created', 'ok');
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Failed to create group', 'error');
    }
  };

  const handleDelete = async (id: string, groupName: string) => {
    try {
      await apiRequest(`/api/subscriptions/${id}`, { method: 'DELETE' });
      await load();
      onToast(`Removed "${groupName}"`, 'info');
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Delete failed', 'error');
    }
  };

  const handleExportAll = async () => {
    try {
      const b64 = await apiRequest<string>('/sub-all', { rawText: true });
      await copyToClipboard(b64);
      onToast('Copied Base64 feed of all active services', 'ok');
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Export failed', 'error');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="font-display text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-50">
            Subscription Groups & Client Portals
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Bundle local services and federated node endpoints into unified Base64 subscription feeds and shareable Artena portals.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleExportAll}
            className="h-9 px-3.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors whitespace-nowrap"
          >
            Copy All Active Feed
          </button>
          <button
            type="button"
            onClick={() => setShowModal(true)}
            className="h-9 px-3.5 rounded-xl bg-gradient-to-b from-[#E8AE5C] to-[#D08F35] hover:from-[#F0BC70] hover:to-[#DC9E49] text-[#0A131C] font-semibold shadow-[0_2px_10px_-2px_rgba(225,159,72,0.45)] text-xs font-medium inline-flex items-center gap-1.5 shadow-sm shadow-teal-600/20 transition-all whitespace-nowrap"
          >
            <Plus className="w-3.5 h-3.5" />
            New Group
          </button>
        </div>
      </div>

      {loading ? (
        <div className="artena-card p-10 text-center text-xs text-slate-500">Loading subscription groups...</div>
      ) : groups.length === 0 ? (
        <div className="artena-card p-12 text-center space-y-3">
          <div className="w-11 h-11 rounded-2xl bg-teal-50 dark:bg-teal-950/60 text-teal-600 dark:text-teal-400 flex items-center justify-center mx-auto">
            <Layers className="w-5 h-5" />
          </div>
          <p className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
            No subscription groups yet
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400 max-w-md mx-auto leading-relaxed">
            Create a group to combine multiple protocol endpoints into a single subscription link compatible with v2rayNG, Hiddify, and Streisand.
          </p>
          <button
            type="button"
            onClick={() => setShowModal(true)}
            className="px-4 py-2 rounded-xl bg-gradient-to-b from-[#E8AE5C] to-[#D08F35] hover:from-[#F0BC70] hover:to-[#DC9E49] text-[#0A131C] font-semibold shadow-[0_2px_10px_-2px_rgba(225,159,72,0.45)] text-xs font-medium shadow-sm shadow-teal-600/20"
          >
            Create First Group
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {groups.map((g) => (
            <div key={g.id} className="artena-card p-5 flex flex-col justify-between gap-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">
                      {g.name}
                    </h3>
                    {g.hasPassword && (
                      <Lock className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0" aria-label="Password protected" />
                    )}
                  </div>
                  <p className="text-[11px] font-mono text-slate-500 dark:text-slate-400 mt-1">
                    {g.linkIds.length} local · {g.remoteLinks.length} federated · {formatTimestamp(g.createdAt)}
                  </p>
                  {g.description && (
                    <p className="text-xs text-slate-600 dark:text-slate-300 mt-2 leading-relaxed">{g.description}</p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => void handleDelete(g.id, g.name)}
                  aria-label={`Delete group ${g.name}`}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/50 transition-colors"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>

              <div className="pt-3.5 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between gap-3 text-xs">
                <span className="font-mono text-[11px] text-slate-500 dark:text-slate-400 truncate bg-slate-50 dark:bg-slate-950 px-2.5 py-1.5 rounded-lg border border-slate-200/80 dark:border-slate-800 flex-1">
                  {g.subFeedUrl}
                </span>
                <div className="flex items-center gap-3 shrink-0">
                  <button
                    type="button"
                    onClick={() => void copyToClipboard(g.subFeedUrl).then(() => onToast('Feed URL copied', 'ok'))}
                    className="inline-flex items-center gap-1 text-teal-600 dark:text-teal-400 font-medium hover:underline"
                  >
                    <Copy className="w-3.5 h-3.5" /> Feed
                  </button>
                  <a
                    href={g.portalUrl}
                    className="inline-flex items-center gap-1 text-slate-700 dark:text-slate-200 font-medium hover:underline"
                  >
                    Portal <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {showModal && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/55 backdrop-blur-xs flex items-center justify-center p-4"
          onClick={() => setShowModal(false)}
        >
          <div
            className="w-full max-w-lg artena-card p-6 space-y-4 text-xs shadow-2xl artena-enter"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
                New Subscription Group
              </h3>
              <button
                type="button"
                onClick={() => setShowModal(false)}
                aria-label="Close"
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleCreate} className="space-y-3.5">
              <div>
                <label htmlFor="sub-name" className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Group Name
                </label>
                <input
                  id="sub-name"
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g., Europe Multi-Node Pack"
                  className="w-full h-9 px-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 focus:outline-none focus:ring-2 focus:ring-teal-500/30"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label htmlFor="sub-desc" className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Description
                  </label>
                  <input
                    id="sub-desc"
                    type="text"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Optional note"
                    className="w-full h-9 px-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700"
                  />
                </div>
                <div>
                  <label htmlFor="sub-pass" className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Portal Password (Optional)
                  </label>
                  <input
                    id="sub-pass"
                    type="text"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Leave blank for public"
                    className="w-full h-9 px-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700"
                  />
                </div>
              </div>
              <div>
                <span className="block font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                  Included Services ({selectedIds.length})
                </span>
                <div className="max-h-44 overflow-y-auto border border-slate-200 dark:border-slate-800 rounded-xl divide-y divide-slate-100 dark:divide-slate-800">
                  {services.map((s) => (
                    <label
                      key={s.id}
                      className="flex items-center justify-between px-3 py-2 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/40"
                    >
                      <span className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={selectedIds.includes(s.id)}
                          onChange={(e) =>
                            setSelectedIds((prev) =>
                              e.target.checked ? [...prev, s.id] : prev.filter((x) => x !== s.id),
                            )
                          }
                        />
                        <span className="font-medium text-slate-800 dark:text-slate-200">{s.label}</span>
                      </span>
                      <span className="text-[11px] text-slate-400">{s.protocolLabel}</span>
                    </label>
                  ))}
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="h-9 px-4 rounded-xl border border-slate-200 dark:border-slate-700"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="h-9 px-5 rounded-xl bg-gradient-to-b from-[#E8AE5C] to-[#D08F35] hover:from-[#F0BC70] hover:to-[#DC9E49] text-[#0A131C] font-semibold shadow-[0_2px_10px_-2px_rgba(225,159,72,0.45)] font-medium shadow-sm shadow-teal-600/20"
                >
                  Create Group
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
