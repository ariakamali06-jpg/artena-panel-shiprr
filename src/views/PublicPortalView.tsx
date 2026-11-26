import { useEffect, useState, type FormEvent } from 'react';
import { Check, Copy, Lock, QrCode, Smartphone, X } from 'lucide-react';
import { copyToClipboard as copyText, formatBytes } from '../lib/api';
import { ArtenaLogoMark } from '../components/ArtenaBrand';
import { QrCodeCanvas } from '../components/QrCodeCanvas';

interface PortalPayload {
  type: 'single' | 'group';
  title: string;
  description?: string;
  active: boolean;
  usedBytes: number;
  limitBytes: number;
  expiresAt: string | null;
  remainingText: string;
  subFeedUrl: string;
  supportUsername: string;
  channelUsername: string;
  endpoints: Array<{ id: string; label: string; protocolLabel: string; uri: string }>;
}

const CLIENT_APPS = [
  { platform: 'Android', apps: 'v2rayNG · Hiddify' },
  { platform: 'iOS / macOS', apps: 'Streisand · FoXray · V2Box' },
  { platform: 'Desktop', apps: 'v2rayN · Hiddify Next' },
];

export function PublicPortalView({
  mode,
  identifier,
}: {
  mode: 'single' | 'group';
  identifier: string;
}) {
  const [data, setData] = useState<PortalPayload | null>(null);
  const [passwordRequired, setPasswordRequired] = useState(false);
  const [passwordInput, setPasswordInput] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [copiedId, setCopiedId] = useState('');
  const [qrTarget, setQrTarget] = useState<{ label: string; uri: string } | null>(null);

  const load = async (pass?: string) => {
    setLoading(true);
    setError('');
    try {
      const url =
        mode === 'single'
          ? `/api/subscription/${encodeURIComponent(identifier)}`
          : `/api/public/sub/${encodeURIComponent(identifier)}${pass ? `?pass=${encodeURIComponent(pass)}` : ''}`;
      const res = await fetch(url);
      const body = await res.json().catch(() => ({}));
      if (res.status === 401 && body.passwordProtected) {
        setPasswordRequired(true);
        setLoading(false);
        return;
      }
      if (!res.ok) {
        throw new Error(body.error || 'Subscription not found');
      }
      setPasswordRequired(false);
      setData(body as PortalPayload);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load subscription');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [mode, identifier]);

  const handleUnlock = (e: FormEvent) => {
    e.preventDefault();
    void load(passwordInput);
  };

  const handleCopy = async (id: string, value: string) => {
    await copyText(value);
    setCopiedId(id);
    setTimeout(() => setCopiedId(''), 1800);
  };

  const pct =
    data && data.limitBytes > 0
      ? Math.min(100, Math.round((data.usedBytes / data.limitBytes) * 100))
      : 0;

  return (
    <div className="min-h-screen artena-canvas text-slate-900 dark:text-slate-100 py-10 px-4">
      <div className="max-w-xl mx-auto space-y-6 artena-enter">
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <ArtenaLogoMark className="w-9 h-9 shrink-0" />
            <div>
              <p className="font-display text-sm font-semibold tracking-tight text-slate-900 dark:text-slate-50">
                Artena Subscription Portal
              </p>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">Encrypted endpoint configuration delivery</p>
            </div>
          </div>
          {data?.supportUsername && (
            <a
              href={`https://t.me/${data.supportUsername}`}
              target="_blank"
              rel="noreferrer"
              className="text-xs font-medium text-teal-600 dark:text-teal-400 hover:underline"
            >
              Support @{data.supportUsername}
            </a>
          )}
        </header>

        {loading ? (
          <div className="h-56 artena-card opacity-60" />
        ) : passwordRequired ? (
          <form onSubmit={handleUnlock} className="artena-card p-6 space-y-4">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-xl bg-teal-50 dark:bg-teal-950/60 text-teal-600 dark:text-teal-400 flex items-center justify-center">
                <Lock className="w-4 h-4" />
              </div>
              <h1 className="font-display text-base font-semibold">Password-Protected Subscription</h1>
            </div>
            <input
              type="password"
              required
              value={passwordInput}
              onChange={(e) => setPasswordInput(e.target.value)}
              placeholder="Enter access password"
              className="w-full h-10 px-3.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500/30"
            />
            <button
              type="submit"
              className="w-full h-10 rounded-xl bg-gradient-to-b from-[#E8AE5C] to-[#D08F35] hover:from-[#F0BC70] hover:to-[#DC9E49] text-[#0A131C] font-semibold shadow-[0_2px_10px_-2px_rgba(225,159,72,0.45)] text-xs font-medium shadow-sm shadow-teal-600/20"
            >
              Unlock Portal
            </button>
          </form>
        ) : error || !data ? (
          <div className="artena-card p-8 text-center text-sm text-slate-500 dark:text-slate-400">
            {error || 'Subscription unavailable'}
          </div>
        ) : (
          <>
            <div className="artena-card p-6 space-y-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h1 className="font-display text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-50">
                    {data.title}
                  </h1>
                  {data.description && (
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">{data.description}</p>
                  )}
                </div>
                <span
                  className={`text-xs font-mono font-semibold ${
                    data.active ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'
                  }`}
                >
                  {data.active ? 'Active' : 'Inactive'}
                </span>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs font-mono tabular-nums text-slate-600 dark:text-slate-300">
                  <span>
                    Used {formatBytes(data.usedBytes)} / {data.limitBytes > 0 ? formatBytes(data.limitBytes) : 'Unlimited'}
                  </span>
                  <span>{data.remainingText}</span>
                </div>
                <div className="h-2 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                  <div
                    className="h-full bg-teal-600 dark:bg-teal-400 rounded-full transition-all duration-500"
                    style={{ width: `${Math.max(2, pct)}%` }}
                  />
                </div>
              </div>

              {data.subFeedUrl && (
                <div className="pt-1 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void handleCopy('feed', data.subFeedUrl)}
                    className="flex-1 h-10 px-4 rounded-xl bg-gradient-to-b from-[#E8AE5C] to-[#D08F35] hover:from-[#F0BC70] hover:to-[#DC9E49] text-[#0A131C] font-semibold shadow-[0_2px_10px_-2px_rgba(225,159,72,0.45)] text-xs font-medium inline-flex items-center justify-center gap-1.5 shadow-sm shadow-teal-600/20 transition-all"
                  >
                    {copiedId === 'feed' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    {copiedId === 'feed' ? 'Feed URL Copied' : 'Copy Auto-Update Subscription URL'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setQrTarget({ label: `${data.title} Feed`, uri: data.subFeedUrl })}
                    className="h-10 px-3.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-medium inline-flex items-center gap-1.5 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                  >
                    <QrCode className="w-3.5 h-3.5" /> Feed QR
                  </button>
                </div>
              )}
            </div>

            <div className="artena-card p-6 space-y-3">
              <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                Endpoints ({data.endpoints.length})
              </h2>
              <div className="divide-y divide-slate-100 dark:divide-slate-800/80">
                {data.endpoints.map((ep) => (
                  <div key={ep.id} className="py-3 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-slate-900 dark:text-slate-100 truncate">{ep.label}</p>
                      <p className="text-[11px] font-mono text-slate-500 mt-0.5">{ep.protocolLabel}</p>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        disabled={!ep.uri}
                        onClick={() => void handleCopy(ep.id, ep.uri)}
                        className="h-8 px-2.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium inline-flex items-center gap-1 disabled:opacity-40 hover:bg-slate-50 dark:hover:bg-slate-800"
                      >
                        {copiedId === ep.id ? (
                          <Check className="w-3.5 h-3.5 text-emerald-600" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" />
                        )}
                        Copy
                      </button>
                      <button
                        type="button"
                        disabled={!ep.uri}
                        onClick={() => setQrTarget({ label: ep.label, uri: ep.uri })}
                        className="h-8 px-2.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium inline-flex items-center gap-1 disabled:opacity-40 hover:bg-slate-50 dark:hover:bg-slate-800"
                      >
                        <QrCode className="w-3.5 h-3.5" /> QR
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="artena-card p-5 space-y-3">
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-900 dark:text-slate-100">
                <Smartphone className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400" />
                Compatible Clients
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 text-xs">
                {CLIENT_APPS.map((item) => (
                  <div
                    key={item.platform}
                    className="p-3 rounded-xl bg-slate-50/90 dark:bg-slate-950/70 border border-slate-200/70 dark:border-slate-800"
                  >
                    <p className="font-semibold text-slate-800 dark:text-slate-200">{item.platform}</p>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">{item.apps}</p>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>

      {qrTarget && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-center justify-center p-4"
          onClick={() => setQrTarget(null)}
        >
          <div
            className="w-full max-w-sm artena-card p-5 space-y-3 shadow-2xl artena-enter"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="font-display text-sm font-semibold truncate">{qrTarget.label}</h3>
              <button type="button" onClick={() => setQrTarget(null)} className="p-1 text-slate-400">
                <X className="w-4 h-4" />
              </button>
            </div>
            <QrCodeCanvas value={qrTarget.uri} label={qrTarget.label} />
          </div>
        </div>
      )}
    </div>
  );
}
