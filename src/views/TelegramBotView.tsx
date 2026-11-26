import { useEffect, useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  Bot,
  ExternalLink,
  MessageSquare,
  Play,
  Save,
  Smartphone,
  Square,
} from 'lucide-react';
import { apiRequest } from '../lib/api';

interface BotStatus {
  running: boolean;
  configured: boolean;
  username: string;
  lastError: string;
  adminCount: number;
}

interface SettingsData {
  hasBotToken: boolean;
  botTokenMasked: string;
  botAdminIds: string;
  botAutoStart: boolean;
  alertsEnabled: boolean;
  publicBaseUrl: string;
  supportUsername: string;
  channelUsername: string;
}

const BOT_COMMANDS = [
  { cmd: '/start', desc: 'Open welcome menu & plan store (or Admin panel for admins)' },
  { cmd: '/admin, /menu', desc: 'Open inline administration dashboard' },
  { cmd: '/new, /quick', desc: 'Guided wizard or instant service creation' },
  { cmd: '/server', desc: 'CPU, memory, uptime, relay listeners & live count' },
  { cmd: '/online', desc: 'List currently connected clients & source IPs' },
  { cmd: '/top, /expiring', desc: 'Top bandwidth consumers & expiring accounts' },
  { cmd: '/find <query>', desc: 'Search services by label, UUID, or protocol' },
  { cmd: '/bulk', desc: 'Bulk operations across active services' },
  { cmd: '/backup', desc: 'Export encrypted/sanitized JSON state backup' },
  { cmd: '/alerts', desc: 'Toggle automated quota/expiry alert broadcasts' },
  { cmd: '/seturl <https://...>', desc: 'Update public HTTPS origin & Mini App menu button' },
  { cmd: '/id, /help', desc: 'Show your numeric Telegram user ID & command reference' },
];

export function TelegramBotView({
  onToast,
  onNavigate,
}: {
  onToast: (type: 'success' | 'error' | 'info', msg: string) => void;
  onNavigate: (tab: string) => void;
}) {
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [bot, setBot] = useState<BotStatus | null>(null);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [botTokenInput, setBotTokenInput] = useState('');
  const [botAdminIds, setBotAdminIds] = useState('');
  const [botAutoStart, setBotAutoStart] = useState(true);
  const [alertsEnabled, setAlertsEnabled] = useState(true);
  const [savingConfig, setSavingConfig] = useState(false);
  const [savingTexts, setSavingTexts] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [publicUrlConfigured, setPublicUrlConfigured] = useState(false);

  const load = async () => {
    const [setRes, txtRes, cfgRes] = await Promise.all([
      apiRequest<{ settings: SettingsData; bot: BotStatus }>('/api/settings').catch(() => null),
      apiRequest<{ texts: Record<string, string> }>('/api/bot/texts').catch(() => ({ texts: {} })),
      apiRequest<{ items: Array<{ key: string; state: string }> }>('/api/config/status').catch(() => ({ items: [] })),
    ]);
    if (setRes) {
      setSettings(setRes.settings);
      setBot(setRes.bot);
      setBotAdminIds(setRes.settings.botAdminIds || '');
      setBotAutoStart(Boolean(setRes.settings.botAutoStart));
      setAlertsEnabled(Boolean(setRes.settings.alertsEnabled));
    }
    setTexts(txtRes.texts || {});
    const pubItem = (cfgRes.items || []).find((i) => i.key === 'PUBLIC_BASE_URL');
    setPublicUrlConfigured(pubItem?.state === 'configured');
  };

  useEffect(() => {
    void load();
  }, []);

  const saveBotSettings = async (e: FormEvent) => {
    e.preventDefault();
    setSavingConfig(true);
    try {
      const body: Record<string, unknown> = {
        botAdminIds,
        botAutoStart,
        alertsEnabled,
      };
      if (botTokenInput.trim()) body.botToken = botTokenInput.trim();
      const res = await apiRequest<{ bot: BotStatus }>('/api/settings', { method: 'POST', body });
      setBot(res.bot);
      setBotTokenInput('');
      onToast('success', 'Telegram Bot configuration saved');
      await load();
    } catch (err) {
      onToast('error', err instanceof Error ? err.message : 'Failed to save bot config');
    } finally {
      setSavingConfig(false);
    }
  };

  const clearToken = async () => {
    try {
      await apiRequest('/api/settings', { method: 'POST', body: { clearBotToken: true } });
      onToast('info', 'Bot token cleared');
      await load();
    } catch (err) {
      onToast('error', err instanceof Error ? err.message : 'Failed to clear token');
    }
  };

  const toggleWorker = async () => {
    if (!bot) return;
    setToggling(true);
    try {
      const endpoint = bot.running ? '/api/settings/bot/stop' : '/api/settings/bot/start';
      const res = await apiRequest<{ bot: BotStatus }>(endpoint, { method: 'POST' });
      setBot(res.bot);
      onToast('info', res.bot.running ? 'Telegram Bot started' : 'Telegram Bot stopped');
    } catch (err) {
      onToast('error', err instanceof Error ? err.message : 'Failed to toggle bot');
    } finally {
      setToggling(false);
    }
  };

  const saveTexts = async (e: FormEvent) => {
    e.preventDefault();
    setSavingTexts(true);
    try {
      await apiRequest('/api/bot/texts', { method: 'POST', body: { texts } });
      onToast('success', 'Bot message templates updated');
    } catch (err) {
      onToast('error', err instanceof Error ? err.message : 'Failed to update templates');
    } finally {
      setSavingTexts(false);
    }
  };

  return (
    <div className="space-y-6">
      {!publicUrlConfigured && (
        <div className="bg-amber-50/80 dark:bg-amber-950/30 border border-amber-200/90 dark:border-amber-800/80 rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
            <div className="text-xs text-amber-900 dark:text-amber-200 space-y-1">
              <p className="font-semibold">PUBLIC_BASE_URL is not configured yet.</p>
              <p className="text-amber-800/90 dark:text-amber-300/80 leading-relaxed">
                Telegram requires an HTTPS origin to register the Mini App menu button and send public subscription portal links. Configure PUBLIC_BASE_URL in your environment or Settings.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => onNavigate('settings')}
            className="h-9 px-3.5 rounded-xl border border-amber-300 dark:border-amber-700 bg-white/70 dark:bg-amber-950/40 text-xs font-medium text-amber-900 dark:text-amber-100 hover:bg-amber-100/60 dark:hover:bg-amber-900/40 whitespace-nowrap transition-colors"
          >
            Configure URL
          </button>
        </div>
      )}

      {/* Bot Worker Control & Credentials */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
        <div className="xl:col-span-7 artena-card p-6">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-teal-50 dark:bg-teal-950/60 text-teal-600 dark:text-teal-400 flex items-center justify-center shrink-0">
                <Bot className="w-5 h-5" />
              </div>
              <div>
                <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
                  Telegram Bot Worker
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  {bot?.running
                    ? `Running as @${bot.username || 'bot'} · ${bot.adminCount} authorized admin(s)`
                    : bot?.configured
                      ? 'Configured · Worker stopped'
                      : 'Not configured'}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => void toggleWorker()}
              disabled={toggling || !bot?.configured}
              className={`h-9 px-3.5 rounded-xl text-xs font-medium inline-flex items-center gap-1.5 disabled:opacity-50 transition-all ${
                bot?.running
                  ? 'border border-red-200 dark:border-red-900 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30'
                  : 'bg-gradient-to-b from-[#E8AE5C] to-[#D08F35] hover:from-[#F0BC70] hover:to-[#DC9E49] text-[#0A131C] font-semibold shadow-[0_2px_10px_-2px_rgba(225,159,72,0.45)] shadow-sm shadow-teal-600/20'
              }`}
            >
              {bot?.running ? <Square className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
              {bot?.running ? 'Stop Worker' : 'Start Worker'}
            </button>
          </div>

          {bot?.lastError && (
            <div className="mb-4 p-3 rounded-xl border border-red-200 dark:border-red-900 bg-red-50/70 dark:bg-red-950/30 text-xs text-red-700 dark:text-red-300 font-mono">
              Last worker error: {bot.lastError}
            </div>
          )}

          <form onSubmit={saveBotSettings} className="space-y-4">
            <div>
              <div className="flex items-center justify-between mb-1">
                <label htmlFor="tg-token" className="text-xs font-medium text-slate-700 dark:text-slate-300">
                  Bot Token (from @BotFather)
                </label>
                {settings?.hasBotToken && (
                  <button
                    type="button"
                    onClick={() => void clearToken()}
                    className="text-[11px] text-red-600 dark:text-red-400 hover:underline"
                  >
                    Clear stored token
                  </button>
                )}
              </div>
              <input
                id="tg-token"
                type="password"
                value={botTokenInput}
                onChange={(e) => setBotTokenInput(e.target.value)}
                placeholder={
                  settings?.hasBotToken
                    ? `Stored (${settings.botTokenMasked}) — enter new value to rotate`
                    : '123456789:AA...'
                }
                className="w-full h-9 px-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 text-xs font-mono text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-teal-500/30"
              />
            </div>

            <div>
              <label htmlFor="tg-admins" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Authorized Admin Telegram IDs (comma-separated)
              </label>
              <input
                id="tg-admins"
                type="text"
                value={botAdminIds}
                onChange={(e) => setBotAdminIds(e.target.value)}
                placeholder="123456789, 987654321"
                className="w-full h-9 px-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 text-xs font-mono text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-teal-500/30"
              />
            </div>

            <div className="flex flex-wrap gap-6 pt-1">
              <label className="inline-flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={botAutoStart}
                  onChange={(e) => setBotAutoStart(e.target.checked)}
                  className="rounded border-slate-300 text-teal-600 focus:ring-teal-500"
                />
                Auto-start bot on server boot
              </label>
              <label className="inline-flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={alertsEnabled}
                  onChange={(e) => setAlertsEnabled(e.target.checked)}
                  className="rounded border-slate-300 text-teal-600 focus:ring-teal-500"
                />
                Send automated quota & expiry alerts
              </label>
            </div>

            <button
              type="submit"
              disabled={savingConfig}
              className="h-9 px-4 rounded-xl bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 text-xs font-medium inline-flex items-center gap-1.5 hover:opacity-90 disabled:opacity-50 transition-opacity"
            >
              <Save className="w-3.5 h-3.5" />
              {savingConfig ? 'Saving...' : 'Save Bot Settings'}
            </button>
          </form>
        </div>

        {/* Mini App Preview & Command Reference */}
        <div className="xl:col-span-5 artena-card p-6 flex flex-col justify-between gap-5">
          <div>
            <div className="flex items-center gap-2.5 mb-2.5">
              <div className="w-8 h-8 rounded-xl bg-teal-50 dark:bg-teal-950/60 text-teal-600 dark:text-teal-400 flex items-center justify-center">
                <Smartphone className="w-4 h-4" />
              </div>
              <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                Artena Telegram Mini App
              </h3>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed mb-4">
              Mobile-first control interface served at <code className="font-mono text-slate-700 dark:text-slate-300">/miniapp</code> (and <code className="font-mono text-slate-700 dark:text-slate-300">/app</code>). Verifies Telegram WebAppData HMAC-SHA256 signatures automatically when opened from Telegram, or accepts an active admin session in browser preview.
            </p>
            <a
              href="/miniapp"
              className="w-full h-10 rounded-xl border border-teal-600/30 bg-teal-50/70 dark:bg-teal-950/40 text-teal-700 dark:text-teal-300 text-xs font-semibold inline-flex items-center justify-center gap-1.5 hover:bg-teal-50 dark:hover:bg-teal-950/70 transition-colors"
            >
              Open Artena Mini App <ExternalLink className="w-3.5 h-3.5" />
            </a>
          </div>

          <div className="border-t border-slate-100 dark:border-slate-800 pt-4">
            <h4 className="text-xs font-semibold text-slate-700 dark:text-slate-300 mb-2.5">
              Supported Bot Commands
            </h4>
            <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
              {BOT_COMMANDS.map((c) => (
                <div key={c.cmd} className="flex items-baseline justify-between gap-3 text-xs">
                  <code className="font-mono text-teal-700 dark:text-teal-400 shrink-0">{c.cmd}</code>
                  <span className="text-slate-500 dark:text-slate-400 text-right truncate">{c.desc}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Editable Bot Message Templates */}
      <div className="artena-card p-6">
        <div className="flex items-center gap-2.5 mb-4">
          <div className="w-8 h-8 rounded-xl bg-teal-50 dark:bg-teal-950/60 text-teal-600 dark:text-teal-400 flex items-center justify-center">
            <MessageSquare className="w-4 h-4" />
          </div>
          <div>
            <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
              Bot Message Templates
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Customize greetings and notifications sent by your Artena Telegram Bot
            </p>
          </div>
        </div>
        <form onSubmit={saveTexts} className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {Object.entries(texts).map(([key, val]) => (
              <div key={key}>
                <label className="block text-xs font-mono text-slate-600 dark:text-slate-400 mb-1">
                  {key}
                </label>
                <textarea
                  rows={2}
                  value={val}
                  onChange={(e) => setTexts((prev) => ({ ...prev, [key]: e.target.value }))}
                  className="w-full p-2.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-teal-500/30"
                />
              </div>
            ))}
          </div>
          <button
            type="submit"
            disabled={savingTexts}
            className="h-9 px-4 rounded-xl bg-gradient-to-b from-[#E8AE5C] to-[#D08F35] hover:from-[#F0BC70] hover:to-[#DC9E49] text-[#0A131C] font-semibold shadow-[0_2px_10px_-2px_rgba(225,159,72,0.45)] text-xs font-medium inline-flex items-center gap-1.5 shadow-sm shadow-teal-600/20"
          >
            <Save className="w-3.5 h-3.5" />
            {savingTexts ? 'Saving...' : 'Save Templates'}
          </button>
        </form>
      </div>
    </div>
  );
}
