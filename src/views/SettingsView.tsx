import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  KeyRound,
  LogOut,
  RefreshCw,
  Save,
  ShieldAlert,
  SlidersHorizontal,
} from 'lucide-react';
import { apiRequest } from '../lib/api';

interface ConfigStatusItem {
  key: string;
  label: string;
  category:
    | 'required'
    | 'optional'
    | 'deployment-dependent'
    | 'network-dependent'
    | 'telegram-dependent'
    | 'sales-dependent';
  state: 'configured' | 'not_configured' | 'fallback' | 'invalid';
  sensitive: boolean;
  source: 'env' | 'settings' | 'ephemeral' | 'none';
  summary: string;
  requiredWhen: string;
  guidance: string;
}

interface PanelSettings {
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
}

export function SettingsView({
  currentUsername,
  onUsernameUpdated,
  onToast,
}: {
  currentUsername: string;
  onUsernameUpdated: (next: string) => void;
  onToast: (type: 'success' | 'error' | 'info', msg: string) => void;
}) {
  const [configItems, setConfigItems] = useState<ConfigStatusItem[]>([]);
  const [configFilter, setConfigFilter] = useState<'all' | 'pending' | 'configured'>('all');
  const [settings, setSettings] = useState<PanelSettings | null>(null);
  const [saving, setSaving] = useState(false);

  // Account security forms
  const [newUsername, setNewUsername] = useState(currentUsername);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [updatingAuth, setUpdatingAuth] = useState(false);

  const load = async () => {
    const [cfgRes, setRes] = await Promise.all([
      apiRequest<{ items: ConfigStatusItem[] }>('/api/config/status'),
      apiRequest<{ settings: PanelSettings }>('/api/settings').catch(() => null),
    ]);
    setConfigItems(cfgRes.items || []);
    if (setRes?.settings) setSettings(setRes.settings);
  };

  useEffect(() => {
    void load();
  }, []);

  const readiness = useMemo(() => {
    const configured = configItems.filter((i) => i.state === 'configured').length;
    const fallback = configItems.filter((i) => i.state === 'fallback').length;
    const pending = configItems.filter((i) => i.state === 'not_configured' || i.state === 'invalid').length;
    return { configured, fallback, pending };
  }, [configItems]);

  const filteredConfigItems = useMemo(() => {
    if (configFilter === 'configured') return configItems.filter((i) => i.state === 'configured');
    if (configFilter === 'pending') return configItems.filter((i) => i.state !== 'configured');
    return configItems;
  }, [configItems, configFilter]);

  const saveSettings = async (e: FormEvent) => {
    e.preventDefault();
    if (!settings) return;
    setSaving(true);
    try {
      await apiRequest('/api/settings', { method: 'POST', body: settings });
      onToast('success', 'Settings saved');
      await load();
    } catch (err) {
      onToast('error', err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  const changeUsername = async (e: FormEvent) => {
    e.preventDefault();
    setUpdatingAuth(true);
    try {
      const res = await apiRequest<{ username: string }>('/api/change-username', {
        method: 'POST',
        body: { newUsername },
      });
      onUsernameUpdated(res.username);
      onToast('success', `Owner username updated to "${res.username}"`);
    } catch (err) {
      onToast('error', err instanceof Error ? err.message : 'Failed to update username');
    } finally {
      setUpdatingAuth(false);
    }
  };

  const changePassword = async (e: FormEvent) => {
    e.preventDefault();
    setUpdatingAuth(true);
    try {
      await apiRequest('/api/change-password', {
        method: 'POST',
        body: { currentPassword, newPassword },
      });
      setCurrentPassword('');
      setNewPassword('');
      onToast('success', 'Password updated');
    } catch (err) {
      onToast('error', err instanceof Error ? err.message : 'Failed to update password');
    } finally {
      setUpdatingAuth(false);
    }
  };

  const revokeOthers = async () => {
    try {
      const res = await apiRequest<{ revoked: number }>('/api/security/revoke-other-sessions', { method: 'POST' });
      onToast('info', `Revoked ${res.revoked} other active session(s)`);
    } catch (err) {
      onToast('error', err instanceof Error ? err.message : 'Failed to revoke sessions');
    }
  };

  const stateIndicator = (state: ConfigStatusItem['state']) => {
    if (state === 'configured') {
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
          <CheckCircle2 className="w-3.5 h-3.5" /> Configured
        </span>
      );
    }
    if (state === 'fallback') {
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">
          <AlertTriangle className="w-3.5 h-3.5" /> Fallback
        </span>
      );
    }
    if (state === 'invalid') {
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-red-600 dark:text-red-400">
          <ShieldAlert className="w-3.5 h-3.5" /> Invalid
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">
        Not configured
      </span>
    );
  };

  return (
    <div className="space-y-6">
      {/* Configuration Status Matrix (Never exposes secrets) */}
      <section aria-label="Configuration Status" className="artena-card p-6">
        <div className="flex flex-wrap items-start justify-between gap-4 mb-5">
          <div>
            <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
              Environment & Configuration Status
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 font-mono tabular-nums">
              <span className="text-emerald-700 dark:text-emerald-400 font-medium">{readiness.configured} configured</span> ·{' '}
              <span className="text-amber-600 dark:text-amber-400 font-medium">{readiness.fallback} fallback</span> ·{' '}
              <span>{readiness.pending} pending</span> · Secrets are never displayed
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex p-1 rounded-xl bg-slate-100/90 dark:bg-slate-800/80 gap-0.5">
              {(['all', 'pending', 'configured'] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setConfigFilter(tab)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium capitalize transition-all ${
                    configFilter === tab
                      ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                  }`}
                >
                  {tab}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => void load()}
              className="h-9 px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5 transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" /> Re-check
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-[11px] text-slate-500 dark:text-slate-400">
                <th className="py-2.5 pr-4 font-medium">Variable</th>
                <th className="py-2.5 pr-4 font-medium">Category</th>
                <th className="py-2.5 pr-4 font-medium">Status</th>
                <th className="py-2.5 pr-4 font-medium">Current State</th>
                <th className="py-2.5 font-medium">Action / Guidance</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
              {filteredConfigItems.map((item) => (
                <tr key={item.key} className="align-top hover:bg-slate-50/60 dark:hover:bg-slate-800/30 transition-colors">
                  <td className="py-3.5 pr-4">
                    <div className="font-mono font-semibold text-slate-900 dark:text-slate-100">{item.key}</div>
                    <div className="text-[11px] text-slate-500 mt-0.5">{item.label}</div>
                  </td>
                  <td className="py-3.5 pr-4">
                    <span className="font-mono text-[11px] text-slate-600 dark:text-slate-400">{item.category}</span>
                  </td>
                  <td className="py-3.5 pr-4 whitespace-nowrap">{stateIndicator(item.state)}</td>
                  <td className="py-3.5 pr-4 text-slate-700 dark:text-slate-300 max-w-xs leading-relaxed">
                    {item.sensitive && item.state === 'configured' ? 'Configured (hidden)' : item.summary}
                  </td>
                  <td className="py-3.5 text-slate-500 dark:text-slate-400 max-w-sm leading-relaxed">
                    <p>{item.guidance}</p>
                    <p className="text-[11px] text-slate-400 mt-0.5">{item.requiredWhen}</p>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Runtime & Networking Settings Form */}
      {settings && (
        <form onSubmit={saveSettings} className="artena-card p-6 space-y-5">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-teal-50 dark:bg-teal-950/60 text-teal-600 dark:text-teal-400 flex items-center justify-center">
              <SlidersHorizontal className="w-4 h-4" />
            </div>
            <div>
              <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
                Networking, Branding & Subscription Formatting
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Customize Artena client remarks, support links, and runtime endpoint overrides
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Public Base URL Override (HTTPS origin)
              </label>
              <input
                type="url"
                value={settings.publicBaseUrl}
                onChange={(e) => setSettings({ ...settings, publicBaseUrl: e.target.value })}
                placeholder="Leave empty until deployed domain is ready"
                className="w-full h-9 px-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-teal-500/30"
              />
            </div>
            <div className="grid grid-cols-3 gap-2.5">
              <div className="col-span-2">
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  TCP Public Host Override
                </label>
                <input
                  type="text"
                  value={settings.tcpPublicHost}
                  onChange={(e) => setSettings({ ...settings, tcpPublicHost: e.target.value })}
                  placeholder="Pending TCP proxy host"
                  className="w-full h-9 px-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 text-xs font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  TCP Public Port
                </label>
                <input
                  type="text"
                  value={settings.tcpPublicPort}
                  onChange={(e) => setSettings({ ...settings, tcpPublicPort: e.target.value })}
                  placeholder="Port"
                  className="w-full h-9 px-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 text-xs font-mono tabular-nums"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Support Telegram Username
              </label>
              <input
                type="text"
                value={settings.supportUsername}
                onChange={(e) => setSettings({ ...settings, supportUsername: e.target.value })}
                placeholder="support_handle"
                className="w-full h-9 px-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 text-xs"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Channel Telegram Username
              </label>
              <input
                type="text"
                value={settings.channelUsername}
                onChange={(e) => setSettings({ ...settings, channelUsername: e.target.value })}
                placeholder="channel_handle"
                className="w-full h-9 px-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 text-xs"
              />
            </div>
          </div>

          <div className="border-t border-slate-100 dark:border-slate-800 pt-4">
            <p className="text-xs font-semibold text-slate-700 dark:text-slate-300 mb-3">
              Client Subscription Remark & Status Info-Line
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5 text-xs text-slate-700 dark:text-slate-300">
              {[
                ['subRemarkShowName', 'Include label in URI remark'],
                ['subRemarkShowVolume', 'Include quota in URI remark'],
                ['subRemarkShowId', 'Include short ID in URI remark'],
                ['subRemarkShowInbound', 'Include parent inbound tag'],
                ['subInfoLineEnabled', 'Prepend subscription status info-line'],
                ['subInfoLineShowVolume', 'Show used/limit in info-line'],
                ['subInfoLineShowExpiry', 'Show remaining days in info-line'],
              ].map(([key, label]) => (
                <label key={key} className="inline-flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={Boolean(settings[key as keyof PanelSettings])}
                    onChange={(e) => setSettings({ ...settings, [key]: e.target.checked })}
                    className="rounded border-slate-300 text-teal-600 focus:ring-teal-500"
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
          </div>

          <button
            type="submit"
            disabled={saving}
            className="h-9 px-4 rounded-xl bg-gradient-to-b from-[#E8AE5C] to-[#D08F35] hover:from-[#F0BC70] hover:to-[#DC9E49] text-[#0A131C] font-semibold shadow-[0_2px_10px_-2px_rgba(225,159,72,0.45)] text-xs font-medium inline-flex items-center gap-1.5 shadow-sm shadow-teal-600/20"
          >
            <Save className="w-3.5 h-3.5" /> {saving ? 'Saving...' : 'Save Settings'}
          </button>
        </form>
      )}

      {/* Owner Credentials & Session Hygiene */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <form onSubmit={changeUsername} className="artena-card p-6 space-y-4">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-300 flex items-center justify-center">
              <KeyRound className="w-4 h-4" />
            </div>
            <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
              Owner Username & Sessions
            </h3>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Username</label>
            <input
              type="text"
              minLength={3}
              required
              value={newUsername}
              onChange={(e) => setNewUsername(e.target.value)}
              className="w-full h-9 px-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 text-xs"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              type="submit"
              disabled={updatingAuth}
              className="h-9 px-3.5 rounded-xl bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 text-xs font-medium hover:opacity-90 transition-opacity"
            >
              Update Username
            </button>
            <button
              type="button"
              onClick={() => void revokeOthers()}
              className="h-9 px-3.5 rounded-xl border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5 transition-colors"
            >
              <LogOut className="w-3.5 h-3.5" /> Revoke Other Sessions
            </button>
          </div>
        </form>

        <form onSubmit={changePassword} className="artena-card p-6 space-y-4">
          <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
            Change Password
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Current Password
              </label>
              <input
                type="password"
                required
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                className="w-full h-9 px-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 text-xs"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                New Password (min 8 chars)
              </label>
              <input
                type="password"
                required
                minLength={8}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="w-full h-9 px-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 text-xs"
              />
            </div>
          </div>
          <button
            type="submit"
            disabled={updatingAuth}
            className="h-9 px-4 rounded-xl bg-gradient-to-b from-[#E8AE5C] to-[#D08F35] hover:from-[#F0BC70] hover:to-[#DC9E49] text-[#0A131C] font-semibold shadow-[0_2px_10px_-2px_rgba(225,159,72,0.45)] text-xs font-medium shadow-sm shadow-teal-600/20"
          >
            Update Password
          </button>
        </form>
      </div>
    </div>
  );
}
