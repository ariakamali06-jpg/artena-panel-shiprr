import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  Check,
  Copy,
  KeyRound,
  Layers,
  Pause,
  Play,
  Plus,
  QrCode,
  RefreshCw,
  RotateCcw,
  Search,
  Sparkles,
  Trash2,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import { apiRequest, copyToClipboard, formatBytes, formatTimestamp } from '../lib/api';
import { QrCodeCanvas } from '../components/QrCodeCanvas';

export interface ServiceItem {
  id: string;
  label: string;
  active: boolean;
  limitBytes: number;
  usedBytes: number;
  createdAt: string;
  expiresAt: string | null;
  note: string;
  subId: string | null;
  parentInboundId: string | null;
  protocol: string;
  protocolLabel: string;
  fingerprint: string;
  alpn: string;
  port: number;
  ipLimit: number;
  speedLimitBytes: number;
  connectionLimit: number;
  categoryId: string;
  outboundProxyId: string;
  outboundProxyName: string;
  uri: string;
  subUrl: string;
  portalUrl: string;
  configWarning?: string;
  isLive: boolean;
  expired: boolean;
  remainingText: string;
  onlineIps: number;
  childCount: number;
}

interface CategoryItem {
  id: string;
  name: string;
  color: string;
}

interface ProxyOption {
  id: string;
  name: string;
  scheme: string;
  host: string;
  port: number;
}

export function ServicesView({
  onToast,
  openCreateSignal,
}: {
  onToast: (msg: string, tone?: 'ok' | 'error' | 'info') => void;
  openCreateSignal: number;
}) {
  const [services, setServices] = useState<ServiceItem[]>([]);
  const [categories, setCategories] = useState<CategoryItem[]>([]);
  const [proxies, setProxies] = useState<ProxyOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'paused' | 'expired'>('all');
  const [categoryFilter, setCategoryFilter] = useState('all');

  const [selectedService, setSelectedService] = useState<ServiceItem | null>(null);
  const [clients, setClients] = useState<ServiceItem[]>([]);
  const [drawerTab, setDrawerTab] = useState<'overview' | 'clients'>('overview');

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showComboModal, setShowComboModal] = useState(false);
  const [showCategoryModal, setShowCategoryModal] = useState(false);

  // Create form state
  const [label, setLabel] = useState('');
  const [protocol, setProtocol] = useState('vless-ws');
  const [volumeGb, setVolumeGb] = useState('50');
  const [days, setDays] = useState('30');
  const [speedMbps, setSpeedMbps] = useState('0');
  const [ipLimit, setIpLimit] = useState('2');
  const [port, setPort] = useState('443');
  const [fingerprint, setFingerprint] = useState('chrome');
  const [categoryId, setCategoryId] = useState('general');
  const [outboundProxyId, setOutboundProxyId] = useState('');
  const [note, setNote] = useState('');
  // Manual builder fields
  const [baseProtocol, setBaseProtocol] = useState('vless');
  const [network, setNetwork] = useState('ws');
  const [security, setSecurity] = useState('tls');
  const [manualAddress, setManualAddress] = useState('');
  const [manualSni, setManualSni] = useState('');
  const [manualPath, setManualPath] = useState('');
  const [realityPub, setRealityPub] = useState('');
  const [realitySid, setRealitySid] = useState('');
  const [manualFlow, setManualFlow] = useState('');
  const [ssMethod, setSsMethod] = useState('chacha20-ietf-poly1305');
  const [ssPassword, setSsPassword] = useState('');

  // Child client form
  const [clientLabel, setClientLabel] = useState('');
  const [clientGb, setClientGb] = useState('20');
  const [clientDays, setClientDays] = useState('30');

  // Combo form
  const [comboName, setComboName] = useState('Multi-Exit Bundle');
  const [comboGb, setComboGb] = useState('100');
  const [comboDays, setComboDays] = useState('30');
  const [comboExits, setComboExits] = useState<string[]>(['']);

  // Category form
  const [newCatName, setNewCatName] = useState('');

  const [copiedId, setCopiedId] = useState<string | null>(null);

  const loadAll = async () => {
    try {
      const [sRes, cRes, pRes] = await Promise.all([
        apiRequest<{ services: ServiceItem[] }>('/api/services'),
        apiRequest<{ categories: CategoryItem[] }>('/api/categories'),
        apiRequest<{ proxies: ProxyOption[] }>('/api/proxies').catch(() => ({ proxies: [] })),
      ]);
      setServices(sRes.services || []);
      setCategories(cRes.categories || []);
      setProxies(pRes.proxies || []);
      if (selectedService) {
        const refreshed = (sRes.services || []).find((x) => x.id === selectedService.id) || null;
        setSelectedService(refreshed);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadAll();
  }, []);

  useEffect(() => {
    if (openCreateSignal > 0) setShowCreateModal(true);
  }, [openCreateSignal]);

  const loadClients = async (uid: string) => {
    try {
      const res = await apiRequest<{ clients: ServiceItem[] }>(`/api/services/${uid}/clients`);
      setClients(res.clients || []);
    } catch {
      setClients([]);
    }
  };

  useEffect(() => {
    if (selectedService) {
      void loadClients(selectedService.id);
    }
  }, [selectedService?.id]);

  const parentStats = useMemo(() => {
    const parents = services.filter((s) => !s.parentInboundId);
    const active = parents.filter((s) => s.active && !s.expired).length;
    const paused = parents.filter((s) => !s.active && !s.expired).length;
    const expired = parents.filter((s) => s.expired).length;
    const totalUsed = parents.reduce((sum, s) => sum + s.usedBytes, 0);
    return { total: parents.length, active, paused, expired, totalUsed };
  }, [services]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return services.filter((s) => {
      if (s.parentInboundId) return false; // show parent services in main table; child clients appear in drawer
      if (statusFilter === 'active' && (!s.active || s.expired)) return false;
      if (statusFilter === 'paused' && s.active) return false;
      if (statusFilter === 'expired' && !s.expired) return false;
      if (categoryFilter !== 'all' && s.categoryId !== categoryFilter) return false;
      if (q && !s.label.toLowerCase().includes(q) && !s.id.toLowerCase().includes(q) && !s.protocolLabel.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [services, query, statusFilter, categoryFilter]);

  const handleSuggestName = async () => {
    try {
      const res = await apiRequest<{ suggestions: string[] }>('/api/name-suggestions?n=6');
      if (res.suggestions?.length) setLabel(res.suggestions[0]);
    } catch {
      // ignore
    }
  };

  const handleGenReality = async () => {
    try {
      const kp = await apiRequest<{ publicKey: string; shortId: string }>('/api/reality-keypair');
      setRealityPub(kp.publicKey);
      setRealitySid(kp.shortId);
      onToast('Generated X25519 Reality keypair', 'ok');
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Failed to generate keypair', 'error');
    }
  };

  const handleCreateService = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const res = await apiRequest<{ service: ServiceItem }>('/api/services', {
        method: 'POST',
        body: {
          label: label.trim() || undefined,
          protocol,
          volume: Number(volumeGb) || 0,
          volumeUnit: 'GB',
          days: Number(days) || 0,
          speed: Number(speedMbps) || 0,
          speedUnit: 'Mbps',
          ipLimit: Number(ipLimit) || 0,
          port: Number(port) || 443,
          fingerprint,
          categoryId,
          outboundProxyId,
          note,
          manual:
            protocol === 'manual'
              ? {
                  baseProtocol,
                  network,
                  security,
                  address: manualAddress,
                  sni: manualSni,
                  path: manualPath,
                  realityPublicKey: realityPub,
                  realityShortId: realitySid,
                  flow: manualFlow,
                  ssMethod,
                  ssPassword,
                }
              : undefined,
        },
      });
      setShowCreateModal(false);
      setLabel('');
      setNote('');
      await loadAll();
      setSelectedService(res.service);
      onToast(`Created "${res.service.label}"`, 'ok');
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Failed to create service', 'error');
    }
  };

  const handleQuickAuto = async () => {
    try {
      const res = await apiRequest<{ service: ServiceItem }>('/api/services/auto', {
        method: 'POST',
        body: { gb: 50, days: 30, protocol: 'vless-ws' },
      });
      await loadAll();
      setSelectedService(res.service);
      onToast(`Auto-provisioned "${res.service.label}"`, 'ok');
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Auto-provision failed', 'error');
    }
  };

  const handleCreateCombo = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const res = await apiRequest<{ createdCount: number }>('/api/services/combo', {
        method: 'POST',
        body: {
          groupName: comboName,
          gb: Number(comboGb) || 0,
          days: Number(comboDays) || 0,
          exits: comboExits.length ? comboExits : [''],
        },
      });
      setShowComboModal(false);
      await loadAll();
      onToast(`Created combo bundle with ${res.createdCount} endpoints`, 'ok');
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Combo creation failed', 'error');
    }
  };

  const handleAction = async (uid: string, action: string, value?: number) => {
    try {
      const res = await apiRequest<{ service: ServiceItem }>(`/api/services/${uid}/action`, {
        method: 'POST',
        body: { action, value },
      });
      await loadAll();
      if (selectedService?.id === uid) setSelectedService(res.service);
      onToast('Service updated', 'ok');
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Action failed', 'error');
    }
  };

  const handleRegenerateUuid = async (uid: string) => {
    try {
      const res = await apiRequest<{ service: ServiceItem }>(`/api/services/${uid}/regenerate`, {
        method: 'POST',
      });
      await loadAll();
      setSelectedService(res.service);
      onToast('UUID rotated; old client links invalidated', 'ok');
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'UUID rotation failed', 'error');
    }
  };

  const handleDelete = async (uid: string, name: string) => {
    try {
      await apiRequest(`/api/services/${uid}`, { method: 'DELETE' });
      if (selectedService?.id === uid) setSelectedService(null);
      await loadAll();
      onToast(`Deleted "${name}"`, 'info');
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Delete failed', 'error');
    }
  };

  const handleAddClient = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedService) return;
    try {
      await apiRequest(`/api/services/${selectedService.id}/clients`, {
        method: 'POST',
        body: {
          label: clientLabel.trim() || undefined,
          volumeGb: Number(clientGb) || 0,
          days: Number(clientDays) || 0,
        },
      });
      setClientLabel('');
      await loadClients(selectedService.id);
      await loadAll();
      onToast('Child client credential created', 'ok');
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Failed to create client', 'error');
    }
  };

  const handleDeleteClient = async (clientId: string) => {
    if (!selectedService) return;
    try {
      await apiRequest(`/api/services/${selectedService.id}/clients/${clientId}`, { method: 'DELETE' });
      await loadClients(selectedService.id);
      await loadAll();
      onToast('Client removed', 'info');
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Failed to remove client', 'error');
    }
  };

  const handleCreateCategory = async (e: FormEvent) => {
    e.preventDefault();
    if (!newCatName.trim()) return;
    try {
      await apiRequest('/api/categories', { method: 'POST', body: { name: newCatName.trim() } });
      setNewCatName('');
      await loadAll();
      onToast('Category added', 'ok');
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Failed to add category', 'error');
    }
  };

  const copyUri = async (svc: ServiceItem) => {
    if (!svc.uri) {
      onToast(svc.configWarning || 'URI unavailable until required host/port settings are configured', 'error');
      return;
    }
    if (await copyToClipboard(svc.uri)) {
      setCopiedId(svc.id);
      onToast(`Copied URI for "${svc.label}"`, 'ok');
      setTimeout(() => setCopiedId(null), 1500);
    }
  };

  return (
    <div className="space-y-5">
      {/* Unboxed Summary Stat Line */}
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h2 className="font-display text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-50">
            Relay Services & Inbounds
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 font-mono tabular-nums">
            {parentStats.total} total ·{' '}
            <span className="text-emerald-700 dark:text-emerald-400 font-medium">{parentStats.active} active</span> ·{' '}
            <span className="text-amber-600 dark:text-amber-400">{parentStats.paused} paused</span> ·{' '}
            <span className="text-red-600 dark:text-red-400">{parentStats.expired} expired</span> ·{' '}
            {formatBytes(parentStats.totalUsed)} transferred
          </p>
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2.5 flex-1 min-w-[260px]">
          <div className="relative flex-1 max-w-xs">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="search"
              aria-label="Search services"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name, UUID, protocol..."
              className="w-full h-9 pl-9 pr-3 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-teal-500/30"
            />
          </div>

          <div className="flex items-center gap-1 p-1 bg-slate-100/90 dark:bg-slate-800/80 rounded-xl">
            {(['all', 'active', 'paused', 'expired'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setStatusFilter(tab)}
                className={`px-2.5 py-1 text-xs font-medium rounded-lg capitalize transition-all whitespace-nowrap ${
                  statusFilter === tab
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                {tab}
              </button>
            ))}
          </div>

          <select
            aria-label="Filter by category"
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="h-9 px-3 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-xs text-slate-700 dark:text-slate-200"
          >
            <option value="all">All Categories</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setShowCategoryModal(true)}
            className="h-9 px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors whitespace-nowrap"
          >
            Categories
          </button>
          <button
            type="button"
            onClick={() => setShowComboModal(true)}
            className="h-9 px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5 transition-colors whitespace-nowrap"
          >
            <Layers className="w-3.5 h-3.5 text-slate-500" />
            Combo Bundle
          </button>
          <button
            type="button"
            onClick={handleQuickAuto}
            className="h-9 px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-medium text-slate-700 dark:text-slate-200 hover:border-teal-300 dark:hover:border-teal-700 inline-flex items-center gap-1.5 transition-colors whitespace-nowrap"
          >
            <Sparkles className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400" />
            Quick Auto
          </button>
          <button
            type="button"
            onClick={() => setShowCreateModal(true)}
            className="h-9 px-3.5 rounded-xl bg-gradient-to-b from-[#E8AE5C] to-[#D08F35] hover:from-[#F0BC70] hover:to-[#DC9E49] text-[#0A131C] font-semibold shadow-[0_2px_10px_-2px_rgba(225,159,72,0.45)] text-xs font-medium inline-flex items-center gap-1.5 shadow-sm shadow-teal-600/20 transition-all whitespace-nowrap"
          >
            <Plus className="w-3.5 h-3.5" />
            New Service
          </button>
        </div>
      </div>

      {/* Main Table */}
      <div className="artena-card overflow-hidden">
        {loading ? (
          <div className="p-10 text-center text-xs text-slate-500">Loading services...</div>
        ) : filtered.length === 0 ? (
          <div className="p-12 text-center space-y-3">
            <p className="text-sm font-medium text-slate-900 dark:text-slate-100">No services match your filter</p>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Create a new VLESS-WS, XHTTP, TCP, or Manual protocol endpoint to start relaying traffic.
            </p>
            <button
              type="button"
              onClick={() => setShowCreateModal(true)}
              className="px-4 py-2 rounded-lg bg-gradient-to-b from-[#E8AE5C] to-[#D08F35] hover:from-[#F0BC70] hover:to-[#DC9E49] text-[#0A131C] font-semibold shadow-[0_2px_10px_-2px_rgba(225,159,72,0.45)] text-xs font-medium"
            >
              Create First Service
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-[11px] font-medium text-slate-500 dark:text-slate-400">
                  <th className="py-3 px-4">Service & UUID</th>
                  <th className="py-3 px-4">Protocol</th>
                  <th className="py-3 px-4">State</th>
                  <th className="py-3 px-4 text-right">Usage / Quota</th>
                  <th className="py-3 px-4 text-right">Remaining</th>
                  <th className="py-3 px-4 text-right">Clients / IPs</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
                {filtered.map((svc) => {
                  const pct = svc.limitBytes > 0 ? Math.min(100, Math.round((svc.usedBytes / svc.limitBytes) * 100)) : 0;
                  return (
                    <tr
                      key={svc.id}
                      className="hover:bg-slate-50/80 dark:hover:bg-slate-800/40 transition-colors"
                    >
                      <td className="py-3 px-4">
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedService(svc);
                            setDrawerTab('overview');
                          }}
                          className="text-left group"
                        >
                          <div className="font-medium text-slate-900 dark:text-slate-100 group-hover:text-teal-600 dark:group-hover:text-teal-400">
                            {svc.label}
                          </div>
                          <div className="font-mono text-[11px] text-slate-400 mt-0.5">
                            {svc.id.slice(0, 13)}…{svc.outboundProxyName ? ` · via ${svc.outboundProxyName.split(' ')[0]}` : ''}
                          </div>
                        </button>
                      </td>
                      <td className="py-3 px-4">
                        <div className="text-slate-800 dark:text-slate-200">{svc.protocolLabel}</div>
                        <div className="text-[11px] text-slate-400 mt-0.5">
                          Port {svc.port} · {svc.isLive ? 'Live Relay' : svc.configWarning ? 'Config Pending' : 'URI Only'}
                        </div>
                      </td>
                      <td className="py-3 px-4">
                        <span
                          className={`font-medium ${
                            svc.expired
                              ? 'text-red-600 dark:text-red-400'
                              : svc.active
                                ? 'text-emerald-700 dark:text-emerald-400'
                                : 'text-amber-600 dark:text-amber-400'
                          }`}
                        >
                          {svc.expired ? 'Expired' : svc.active ? 'Active' : 'Paused'}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums">
                        <div className="text-slate-900 dark:text-slate-100">
                          {formatBytes(svc.usedBytes)} / {svc.limitBytes > 0 ? formatBytes(svc.limitBytes) : '∞'}
                        </div>
                        {svc.limitBytes > 0 && (
                          <div className="w-24 ml-auto mt-1 h-1.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                            <div
                              className={`h-full rounded-full ${pct > 85 ? 'bg-amber-500' : 'bg-teal-600'}`}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        )}
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-700 dark:text-slate-300 whitespace-nowrap">
                        {svc.remainingText}
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-600 dark:text-slate-300 whitespace-nowrap">
                        {svc.childCount} · {svc.onlineIps} IP
                      </td>
                      <td className="py-3 px-4">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            type="button"
                            onClick={() => void copyUri(svc)}
                            aria-label={`Copy URI for ${svc.label}`}
                            className="p-1.5 rounded-md text-slate-500 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800"
                          >
                            {copiedId === svc.id ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedService(svc);
                              setDrawerTab('overview');
                            }}
                            aria-label={`Inspect ${svc.label}`}
                            className="p-1.5 rounded-md text-slate-500 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800"
                          >
                            <QrCode className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleAction(svc.id, 'toggle')}
                            aria-label={`${svc.active ? 'Pause' : 'Activate'} ${svc.label}`}
                            className="p-1.5 rounded-md text-slate-500 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800"
                          >
                            {svc.active ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleDelete(svc.id, svc.label)}
                            aria-label={`Delete ${svc.label}`}
                            className="p-1.5 rounded-md text-slate-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/50"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Service Detail & Child Clients Drawer */}
      {selectedService && (
        <div
          className="fixed inset-0 z-40 bg-slate-950/55 backdrop-blur-xs flex justify-end"
          onClick={() => setSelectedService(null)}
        >
          <div
            className="w-full max-w-lg bg-white dark:bg-[#101F30] h-full border-l border-slate-200 dark:border-slate-800 shadow-2xl overflow-y-auto p-6 space-y-5 artena-enter"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4 border-b border-slate-100 dark:border-slate-800 pb-4">
              <div>
                <h3 className="font-display text-lg font-semibold text-slate-900 dark:text-slate-100">
                  {selectedService.label}
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  {selectedService.protocolLabel} · Created {formatTimestamp(selectedService.createdAt)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedService(null)}
                aria-label="Close service details"
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-800 dark:hover:text-slate-100"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg w-fit">
              <button
                type="button"
                onClick={() => setDrawerTab('overview')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md ${
                  drawerTab === 'overview'
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                    : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                Config & QR
              </button>
              <button
                type="button"
                onClick={() => setDrawerTab('clients')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md inline-flex items-center gap-1.5 ${
                  drawerTab === 'clients'
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                    : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                <Users className="w-3.5 h-3.5" />
                Child Clients ({clients.length})
              </button>
            </div>

            {drawerTab === 'overview' ? (
              <div className="space-y-5">
                {selectedService.configWarning && (
                  <div className="p-3.5 rounded-lg bg-amber-50 dark:bg-amber-950/50 border border-amber-200 dark:border-amber-800 text-xs text-amber-900 dark:text-amber-200 leading-relaxed">
                    {selectedService.configWarning}
                  </div>
                )}

                {selectedService.uri && (
                  <div className="flex flex-col items-center py-2">
                    <QrCodeCanvas value={selectedService.uri} label={selectedService.label} />
                  </div>
                )}

                <div className="space-y-2">
                  <span className="text-xs font-medium text-slate-600 dark:text-slate-400">Client URI</span>
                  <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 font-mono text-[11px] break-all text-slate-700 dark:text-slate-300">
                    {selectedService.uri || 'Unavailable until public endpoint variables are configured.'}
                  </div>
                </div>

                {selectedService.portalUrl && (
                  <div className="flex items-center justify-between gap-2 p-3 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-xs">
                    <span className="truncate font-mono text-slate-600 dark:text-slate-300">{selectedService.portalUrl}</span>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => void copyToClipboard(selectedService.subUrl).then(() => onToast('Subscription feed URL copied', 'ok'))}
                        className="text-teal-600 dark:text-teal-400 font-medium hover:underline"
                      >
                        Copy Sub
                      </button>
                      <a
                        href={selectedService.portalUrl}
                        className="text-slate-700 dark:text-slate-200 font-medium hover:underline"
                      >
                        Open Portal
                      </a>
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800">
                    <div className="text-slate-500">Traffic Used</div>
                    <div className="font-mono tabular-nums font-semibold text-sm mt-1">
                      {formatBytes(selectedService.usedBytes)} / {selectedService.limitBytes > 0 ? formatBytes(selectedService.limitBytes) : 'Unlimited'}
                    </div>
                  </div>
                  <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800">
                    <div className="text-slate-500">Speed & IP Caps</div>
                    <div className="font-mono tabular-nums font-semibold text-sm mt-1">
                      {selectedService.speedLimitBytes > 0 ? `${formatBytes(selectedService.speedLimitBytes)}/s` : 'Uncapped'} · {selectedService.ipLimit || '∞'} IP
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
                  <button
                    type="button"
                    onClick={() => void handleAction(selectedService.id, 'add_gb', 10)}
                    className="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium hover:bg-slate-50 dark:hover:bg-slate-800"
                  >
                    +10 GB
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleAction(selectedService.id, 'extend_days', 30)}
                    className="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium hover:bg-slate-50 dark:hover:bg-slate-800"
                  >
                    +30 Days
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleAction(selectedService.id, 'reset')}
                    className="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium inline-flex items-center gap-1 hover:bg-slate-50 dark:hover:bg-slate-800"
                  >
                    <RotateCcw className="w-3.5 h-3.5" /> Reset Usage
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleRegenerateUuid(selectedService.id)}
                    className="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium inline-flex items-center gap-1 hover:bg-slate-50 dark:hover:bg-slate-800"
                  >
                    <RefreshCw className="w-3.5 h-3.5" /> Rotate UUID
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <form onSubmit={handleAddClient} className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 space-y-3">
                  <div className="text-xs font-semibold text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
                    <UserPlus className="w-3.5 h-3.5 text-teal-600" /> Add Child Client Credential
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                    <input
                      type="text"
                      value={clientLabel}
                      onChange={(e) => setClientLabel(e.target.value)}
                      placeholder="Client label"
                      className="h-9 px-3 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-xs"
                    />
                    <input
                      type="number"
                      min={0}
                      value={clientGb}
                      onChange={(e) => setClientGb(e.target.value)}
                      placeholder="Quota GB"
                      className="h-9 px-3 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-xs font-mono"
                    />
                    <input
                      type="number"
                      min={0}
                      value={clientDays}
                      onChange={(e) => setClientDays(e.target.value)}
                      placeholder="Days"
                      className="h-9 px-3 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-xs font-mono"
                    />
                  </div>
                  <button
                    type="submit"
                    className="px-3.5 py-1.5 rounded-lg bg-gradient-to-b from-[#E8AE5C] to-[#D08F35] hover:from-[#F0BC70] hover:to-[#DC9E49] text-[#0A131C] font-semibold shadow-[0_2px_10px_-2px_rgba(225,159,72,0.45)] text-xs font-medium"
                  >
                    Add Client
                  </button>
                </form>

                {clients.length === 0 ? (
                  <p className="text-xs text-slate-500 text-center py-6">No child clients assigned to this inbound yet.</p>
                ) : (
                  <div className="divide-y divide-slate-100 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-xl">
                    {clients.map((c) => (
                      <div key={c.id} className="p-3.5 flex items-center justify-between gap-3 text-xs">
                        <div className="min-w-0">
                          <div className="font-medium text-slate-900 dark:text-slate-100 truncate">{c.label}</div>
                          <div className="font-mono text-[11px] text-slate-400">
                            {formatBytes(c.usedBytes)} / {c.limitBytes > 0 ? formatBytes(c.limitBytes) : '∞'} · {c.remainingText}
                          </div>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            onClick={() => void copyUri(c)}
                            aria-label={`Copy URI for client ${c.label}`}
                            className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500"
                          >
                            <Copy className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleDeleteClient(c.id)}
                            aria-label={`Delete client ${c.label}`}
                            className="p-1.5 rounded hover:bg-red-50 dark:hover:bg-red-950/50 text-slate-500 hover:text-red-600"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Create Service Modal (including Manual Protocol Builder) */}
      {showCreateModal && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/50 backdrop-blur-xs flex items-center justify-center p-4"
          onClick={() => setShowCreateModal(false)}
        >
          <div
            className="w-full max-w-2xl max-h-[90vh] overflow-y-auto bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-5">
              <h3 className="font-display text-lg font-semibold text-slate-900 dark:text-slate-100">
                Create Relay Service
              </h3>
              <button
                type="button"
                onClick={() => setShowCreateModal(false)}
                aria-label="Close modal"
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreateService} className="space-y-4 text-xs">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <div>
                  <label htmlFor="svc-label" className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Service Label
                  </label>
                  <div className="flex gap-1.5">
                    <input
                      id="svc-label"
                      type="text"
                      value={label}
                      onChange={(e) => setLabel(e.target.value)}
                      placeholder="e.g., Frankfurt-Edge-01"
                      className="flex-1 h-9 px-3 rounded-lg bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100"
                    />
                    <button
                      type="button"
                      onClick={handleSuggestName}
                      className="h-9 px-2.5 rounded-lg border border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
                    >
                      Suggest
                    </button>
                  </div>
                </div>

                <div>
                  <label htmlFor="svc-proto" className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Protocol
                  </label>
                  <select
                    id="svc-proto"
                    value={protocol}
                    onChange={(e) => setProtocol(e.target.value)}
                    className="w-full h-9 px-3 rounded-lg bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100"
                  >
                    <option value="vless-ws">VLESS · WebSocket · TLS (Live)</option>
                    <option value="xhttp-packet-up">VLESS · XHTTP Packet-Up (Live)</option>
                    <option value="xhttp-stream-up">VLESS · XHTTP Stream-Up (Live)</option>
                    <option value="vless-tcp">VLESS · Raw TCP (Requires TCP env)</option>
                    <option value="vmess-ws">VMess · WebSocket (URI)</option>
                    <option value="trojan-ws">Trojan · WebSocket (URI)</option>
                    <option value="manual">Manual Protocol Builder (3x-ui style)</option>
                  </select>
                </div>

                <div>
                  <label htmlFor="svc-vol" className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Traffic Quota (GB, 0 = Unlimited)
                  </label>
                  <input
                    id="svc-vol"
                    type="number"
                    min={0}
                    value={volumeGb}
                    onChange={(e) => setVolumeGb(e.target.value)}
                    className="w-full h-9 px-3 rounded-lg bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 font-mono"
                  />
                </div>

                <div>
                  <label htmlFor="svc-days" className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Expiry (Days, 0 = Never)
                  </label>
                  <input
                    id="svc-days"
                    type="number"
                    min={0}
                    value={days}
                    onChange={(e) => setDays(e.target.value)}
                    className="w-full h-9 px-3 rounded-lg bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 font-mono"
                  />
                </div>

                <div>
                  <label htmlFor="svc-speed" className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Speed Limit (Mbps, 0 = Uncapped)
                  </label>
                  <input
                    id="svc-speed"
                    type="number"
                    min={0}
                    value={speedMbps}
                    onChange={(e) => setSpeedMbps(e.target.value)}
                    className="w-full h-9 px-3 rounded-lg bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 font-mono"
                  />
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label htmlFor="svc-ip" className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                      IP Limit
                    </label>
                    <input
                      id="svc-ip"
                      type="number"
                      min={0}
                      value={ipLimit}
                      onChange={(e) => setIpLimit(e.target.value)}
                      className="w-full h-9 px-3 rounded-lg bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 font-mono"
                    />
                  </div>
                  <div>
                    <label htmlFor="svc-port" className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                      Client Port
                    </label>
                    <input
                      id="svc-port"
                      type="number"
                      min={1}
                      max={65535}
                      value={port}
                      onChange={(e) => setPort(e.target.value)}
                      className="w-full h-9 px-3 rounded-lg bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 font-mono"
                    />
                  </div>
                </div>

                <div>
                  <label htmlFor="svc-proxy" className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Outbound Exit Proxy
                  </label>
                  <select
                    id="svc-proxy"
                    value={outboundProxyId}
                    onChange={(e) => setOutboundProxyId(e.target.value)}
                    className="w-full h-9 px-3 rounded-lg bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700"
                  >
                    <option value="">Direct Server Egress</option>
                    {proxies.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.scheme}://{p.host}:{p.port})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label htmlFor="svc-cat" className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Category & TLS Fingerprint
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <select
                      id="svc-cat"
                      value={categoryId}
                      onChange={(e) => setCategoryId(e.target.value)}
                      className="h-9 px-2.5 rounded-lg bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700"
                    >
                      {categories.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                    <select
                      aria-label="TLS fingerprint"
                      value={fingerprint}
                      onChange={(e) => setFingerprint(e.target.value)}
                      className="h-9 px-2.5 rounded-lg bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700"
                    >
                      {['chrome', 'firefox', 'safari', 'ios', 'android', 'edge', 'random'].map((fp) => (
                        <option key={fp} value={fp}>
                          {fp}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>

              {/* Manual Protocol Builder Section */}
              {protocol === 'manual' && (
                <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-slate-800 dark:text-slate-200">Manual Protocol Builder</span>
                    {security === 'reality' && (
                      <button
                        type="button"
                        onClick={handleGenReality}
                        className="inline-flex items-center gap-1 text-teal-600 dark:text-teal-400 font-medium hover:underline"
                      >
                        <KeyRound className="w-3.5 h-3.5" /> Generate X25519 Reality Keypair
                      </button>
                    )}
                  </div>
                  <div className="grid grid-cols-3 gap-2.5">
                    <select
                      aria-label="Base protocol"
                      value={baseProtocol}
                      onChange={(e) => setBaseProtocol(e.target.value)}
                      className="h-9 px-2.5 rounded-lg bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700"
                    >
                      <option value="vless">VLESS</option>
                      <option value="vmess">VMess</option>
                      <option value="trojan">Trojan</option>
                      <option value="shadowsocks">Shadowsocks</option>
                    </select>
                    <select
                      aria-label="Network transport"
                      value={network}
                      onChange={(e) => setNetwork(e.target.value)}
                      className="h-9 px-2.5 rounded-lg bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700"
                    >
                      <option value="ws">WebSocket</option>
                      <option value="xhttp">XHTTP</option>
                      <option value="tcp">TCP</option>
                      <option value="grpc">gRPC</option>
                    </select>
                    <select
                      aria-label="Security layer"
                      value={security}
                      onChange={(e) => setSecurity(e.target.value)}
                      className="h-9 px-2.5 rounded-lg bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700"
                    >
                      <option value="tls">TLS</option>
                      <option value="reality">Reality</option>
                      <option value="none">None</option>
                    </select>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                    <input
                      type="text"
                      value={manualAddress}
                      onChange={(e) => setManualAddress(e.target.value)}
                      placeholder="Custom address / IP"
                      className="h-9 px-3 rounded-lg bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 font-mono"
                    />
                    <input
                      type="text"
                      value={manualSni}
                      onChange={(e) => setManualSni(e.target.value)}
                      placeholder="SNI (e.g. cloudflare.com)"
                      className="h-9 px-3 rounded-lg bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 font-mono"
                    />
                    <input
                      type="text"
                      value={manualPath}
                      onChange={(e) => setManualPath(e.target.value)}
                      placeholder="Path / ServiceName"
                      className="h-9 px-3 rounded-lg bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 font-mono"
                    />
                  </div>

                  {security === 'reality' && (
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                      <input
                        type="text"
                        value={realityPub}
                        onChange={(e) => setRealityPub(e.target.value)}
                        placeholder="Reality Public Key (pbk)"
                        className="h-9 px-3 rounded-lg bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 font-mono"
                      />
                      <input
                        type="text"
                        value={realitySid}
                        onChange={(e) => setRealitySid(e.target.value)}
                        placeholder="Short ID (sid)"
                        className="h-9 px-3 rounded-lg bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 font-mono"
                      />
                      <input
                        type="text"
                        value={manualFlow}
                        onChange={(e) => setManualFlow(e.target.value)}
                        placeholder="Flow (xtls-rprx-vision)"
                        className="h-9 px-3 rounded-lg bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 font-mono"
                      />
                    </div>
                  )}

                  {baseProtocol === 'shadowsocks' && (
                    <div className="grid grid-cols-2 gap-2.5">
                      <select
                        value={ssMethod}
                        onChange={(e) => setSsMethod(e.target.value)}
                        className="h-9 px-3 rounded-lg bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 font-mono"
                      >
                        <option value="chacha20-ietf-poly1305">chacha20-ietf-poly1305</option>
                        <option value="aes-256-gcm">aes-256-gcm</option>
                        <option value="aes-128-gcm">aes-128-gcm</option>
                      </select>
                      <input
                        type="text"
                        value={ssPassword}
                        onChange={(e) => setSsPassword(e.target.value)}
                        placeholder="Shadowsocks password (optional)"
                        className="h-9 px-3 rounded-lg bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 font-mono"
                      />
                    </div>
                  )}
                </div>
              )}

              <div>
                <label htmlFor="svc-note" className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Internal Note
                </label>
                <input
                  id="svc-note"
                  type="text"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Optional customer or deployment reference"
                  className="w-full h-9 px-3 rounded-lg bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700"
                />
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-100 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="h-9 px-4 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="h-9 px-5 rounded-lg bg-gradient-to-b from-[#E8AE5C] to-[#D08F35] hover:from-[#F0BC70] hover:to-[#DC9E49] text-[#0A131C] font-semibold shadow-[0_2px_10px_-2px_rgba(225,159,72,0.45)] font-medium"
                >
                  Create Service
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Combo Bundle Modal */}
      {showComboModal && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/50 backdrop-blur-xs flex items-center justify-center p-4"
          onClick={() => setShowComboModal(false)}
        >
          <div
            className="w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 space-y-4 text-xs"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="font-display text-base font-semibold">Create Multi-Exit Combo Bundle</h3>
              <button type="button" onClick={() => setShowComboModal(false)} aria-label="Close">
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-slate-500 dark:text-slate-400">
              Automatically provisions paired VLESS-WS + XHTTP services for each selected outbound exit and bundles them into one subscription group.
            </p>
            <form onSubmit={handleCreateCombo} className="space-y-3">
              <input
                type="text"
                required
                value={comboName}
                onChange={(e) => setComboName(e.target.value)}
                placeholder="Bundle name"
                className="w-full h-9 px-3 rounded-lg bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700"
              />
              <div className="grid grid-cols-2 gap-2.5">
                <input
                  type="number"
                  min={0}
                  value={comboGb}
                  onChange={(e) => setComboGb(e.target.value)}
                  placeholder="GB per endpoint"
                  className="h-9 px-3 rounded-lg bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 font-mono"
                />
                <input
                  type="number"
                  min={0}
                  value={comboDays}
                  onChange={(e) => setComboDays(e.target.value)}
                  placeholder="Validity days"
                  className="h-9 px-3 rounded-lg bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 font-mono"
                />
              </div>
              <div className="space-y-1.5">
                <span className="font-medium text-slate-700 dark:text-slate-300">Exits</span>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={comboExits.includes('')}
                    onChange={(e) =>
                      setComboExits((prev) => (e.target.checked ? [...prev, ''] : prev.filter((x) => x !== '')))
                    }
                  />
                  <span>Direct Server Egress</span>
                </label>
                {proxies.map((p) => (
                  <label key={p.id} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={comboExits.includes(p.id)}
                      onChange={(e) =>
                        setComboExits((prev) => (e.target.checked ? [...prev, p.id] : prev.filter((x) => x !== p.id)))
                      }
                    />
                    <span>
                      {p.name} ({p.host}:{p.port})
                    </span>
                  </label>
                ))}
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowComboModal(false)}
                  className="h-9 px-3 rounded-lg border border-slate-200 dark:border-slate-700"
                >
                  Cancel
                </button>
                <button type="submit" className="h-9 px-4 rounded-lg bg-teal-600 text-white font-medium">
                  Generate Bundle
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Categories Modal */}
      {showCategoryModal && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/50 backdrop-blur-xs flex items-center justify-center p-4"
          onClick={() => setShowCategoryModal(false)}
        >
          <div
            className="w-full max-w-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 space-y-4 text-xs"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="font-display text-base font-semibold">Service Categories</h3>
              <button type="button" onClick={() => setShowCategoryModal(false)} aria-label="Close">
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleCreateCategory} className="flex gap-2">
              <input
                type="text"
                value={newCatName}
                onChange={(e) => setNewCatName(e.target.value)}
                placeholder="New category name"
                className="flex-1 h-9 px-3 rounded-lg bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700"
              />
              <button type="submit" className="h-9 px-3.5 rounded-lg bg-teal-600 text-white font-medium">
                Add
              </button>
            </form>
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {categories.map((c) => (
                <div key={c.id} className="py-2 flex items-center justify-between">
                  <span className="font-medium">{c.name}</span>
                  {c.id !== 'general' && (
                    <button
                      type="button"
                      onClick={() =>
                        void apiRequest(`/api/categories/${c.id}`, { method: 'DELETE' }).then(() => {
                          void loadAll();
                          onToast('Category removed', 'info');
                        })
                      }
                      className="text-red-600 hover:underline"
                    >
                      Remove
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
