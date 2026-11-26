import { useState, type FormEvent } from 'react';
import { ArrowRight, Eye, EyeOff, KeyRound, Lock, UserPlus } from 'lucide-react';
import { apiRequest, setAuthToken, type AuthUser } from '../lib/api';
import { ArtenaLogoMark } from './ArtenaBrand';

interface AuthScreenProps {
  needsSetup: boolean;
  onAuthenticated: (user: AuthUser) => void;
  onToast: (msg: string, tone?: 'ok' | 'error' | 'info') => void;
}

export function AuthScreen({ needsSetup, onAuthenticated, onToast }: AuthScreenProps) {
  const [mode, setMode] = useState<'login' | 'setup' | 'request'>(needsSetup ? 'setup' : 'login');
  const [username, setUsername] = useState(needsSetup ? 'admin' : '');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [contact, setContact] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [requestDone, setRequestDone] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      if (mode === 'setup') {
        if (password !== confirmPassword) {
          setError('Passwords do not match');
          setSubmitting(false);
          return;
        }
        const res = await apiRequest<{ token: string; user: AuthUser }>('/api/auth/setup', {
          method: 'POST',
          body: { username, password },
        });
        setAuthToken(res.token);
        onToast('Owner account initialized', 'ok');
        onAuthenticated(res.user);
      } else if (mode === 'login') {
        const res = await apiRequest<{ token: string; user: AuthUser }>('/api/login', {
          method: 'POST',
          body: { username, password },
        });
        setAuthToken(res.token);
        onAuthenticated(res.user);
      } else {
        await apiRequest('/api/admin-requests', {
          method: 'POST',
          body: { username, password, contact, reason },
        });
        setRequestDone(true);
        onToast('Access request submitted for owner review', 'ok');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen artena-canvas flex items-center justify-center p-5 sm:p-8">
      <div className="w-full max-w-[960px] grid grid-cols-1 lg:grid-cols-12 bg-white dark:bg-slate-900 border border-slate-200/90 dark:border-slate-800 rounded-3xl overflow-hidden shadow-xl shadow-slate-900/[0.05] dark:shadow-black/40">
        {/* Left Architectural Showcase Panel */}
        <div className="lg:col-span-5 relative bg-[#0B1120] text-white p-8 lg:p-10 flex flex-col justify-between gap-10 overflow-hidden">
          {/* Subtle Architectural Grid + Soft Teal Glow */}
          <svg
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 w-full h-full opacity-[0.14]"
            xmlns="http://www.w3.org/2000/svg"
          >
            <defs>
              <pattern id="artenaAuthGrid" width="32" height="32" patternUnits="userSpaceOnUse">
                <path d="M 32 0 L 0 0 0 32" fill="none" stroke="#4CBAC4" strokeWidth="0.7" />
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill="url(#artenaAuthGrid)" />
          </svg>
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -top-24 -right-24 w-72 h-72 rounded-full bg-teal-500/20 blur-3xl"
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -bottom-24 -left-16 w-60 h-60 rounded-full bg-teal-600/15 blur-3xl"
          />

          <div className="relative space-y-6">
            <div className="inline-flex items-center gap-3">
              <ArtenaLogoMark className="w-10 h-10 shadow-md shadow-teal-950/50" />
              <div>
                <span className="font-display text-lg font-bold tracking-tight block leading-none">
                  Artena Panel
                </span>
                <span className="text-[11px] text-teal-300/80 font-medium mt-1 block">
                  Proxy &amp; Relay Orchestration
                </span>
              </div>
            </div>

            <div className="space-y-3 pt-2">
              <h1 className="font-display text-[26px] font-semibold tracking-tight leading-[1.2] text-balance text-white">
                Precision control for every relay, tunnel, and node
              </h1>
              <p className="text-[13.5px] text-slate-300/85 leading-relaxed">
                Orchestrate live VLESS WebSocket, XHTTP, and raw TCP relays with token-bucket shaping, SOCKS outbound routing, multi-node federation, and Telegram automation.
              </p>
            </div>
          </div>

          <div className="relative space-y-3 border-t border-white/10 pt-6 text-xs">
            <div className="flex items-center justify-between gap-4">
              <span className="text-slate-400">Live Relays</span>
              <span className="font-mono text-teal-200/95">WS · XHTTP · TCP</span>
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className="text-slate-400">Protocol Suite</span>
              <span className="font-mono text-slate-200">VLESS · VMess · Trojan · SS</span>
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className="text-slate-400">Ecosystem</span>
              <span className="font-mono text-slate-200">Telegram Bot &amp; Mini App</span>
            </div>
          </div>
        </div>

        {/* Right Interactive Form Panel */}
        <div className="lg:col-span-7 p-8 sm:p-10 lg:p-12 flex flex-col justify-center">
          <div className="mb-7">
            <div className="inline-flex items-center gap-1.5 text-xs font-medium text-teal-600 dark:text-teal-400 mb-2">
              <Lock className="w-3.5 h-3.5" />
              <span>
                {mode === 'setup'
                  ? 'Initial Instance Setup'
                  : mode === 'request'
                    ? 'Delegated Team Access'
                    : 'Administrator Workspace'}
              </span>
            </div>
            <h2 className="font-display text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
              {mode === 'setup'
                ? 'Initialize Owner Account'
                : mode === 'request'
                  ? 'Request Sub-Admin Access'
                  : 'Welcome back to Artena Panel'}
            </h2>
            <p className="mt-1.5 text-sm text-slate-500 dark:text-slate-400 leading-relaxed">
              {mode === 'setup'
                ? 'Create the primary administrator credentials for this server. One-time setup locks immediately once claimed.'
                : mode === 'request'
                  ? 'Submit your credentials and scope note. The owner can approve and assign granular permissions.'
                  : 'Sign in with your administrator credentials to manage services, nodes, and subscriptions.'}
            </p>
          </div>

          {!needsSetup && (
            <div className="inline-flex items-center gap-1 p-1 bg-slate-100/90 dark:bg-slate-800/90 rounded-xl mb-6 w-fit">
              <button
                type="button"
                onClick={() => {
                  setMode('login');
                  setError('');
                  setRequestDone(false);
                }}
                className={`px-3.5 py-1.5 text-xs font-medium rounded-lg transition-all whitespace-nowrap ${
                  mode === 'login'
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                Administrator Sign In
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode('request');
                  setError('');
                  setRequestDone(false);
                }}
                className={`px-3.5 py-1.5 text-xs font-medium rounded-lg transition-all whitespace-nowrap ${
                  mode === 'request'
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                Request Access
              </button>
            </div>
          )}

          {requestDone ? (
            <div className="p-6 rounded-2xl bg-teal-50/70 dark:bg-teal-950/40 border border-teal-200 dark:border-teal-800/80 space-y-3">
              <p className="text-sm font-semibold text-teal-900 dark:text-teal-100">
                Your access request has been queued.
              </p>
              <p className="text-xs text-teal-800/90 dark:text-teal-300 leading-relaxed">
                Once the owner approves your account from the Admins &amp; RBAC panel, you can sign in using the credentials you provided.
              </p>
              <button
                type="button"
                onClick={() => {
                  setMode('login');
                  setRequestDone(false);
                }}
                className="text-xs font-semibold text-teal-700 dark:text-teal-300 hover:underline"
              >
                Back to Sign In
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              {error && (
                <div
                  role="alert"
                  className="px-4 py-3 rounded-xl bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800/80 text-xs font-medium text-red-700 dark:text-red-200"
                >
                  {error}
                </div>
              )}

              <div>
                <label htmlFor="auth-username" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                  Username
                </label>
                <input
                  id="auth-username"
                  type="text"
                  required
                  minLength={3}
                  autoComplete="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="admin"
                  className="w-full h-11 px-3.5 rounded-xl bg-slate-50/80 dark:bg-slate-950 border border-slate-200 dark:border-slate-700/90 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:bg-white dark:focus:bg-slate-950 focus:outline-none focus:ring-2 focus:ring-teal-500/30 focus:border-teal-600 transition-colors"
                />
              </div>

              <div>
                <label htmlFor="auth-password" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                  Password
                </label>
                <div className="relative">
                  <input
                    id="auth-password"
                    type={showPassword ? 'text' : 'password'}
                    required
                    minLength={mode === 'setup' ? 8 : 1}
                    autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={mode === 'setup' ? 'Minimum 8 characters' : 'Enter password'}
                    className="w-full h-11 pl-3.5 pr-10 rounded-xl bg-slate-50/80 dark:bg-slate-950 border border-slate-200 dark:border-slate-700/90 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:bg-white dark:focus:bg-slate-950 focus:outline-none focus:ring-2 focus:ring-teal-500/30 focus:border-teal-600 transition-colors"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {mode === 'setup' && (
                <div>
                  <label htmlFor="auth-confirm" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                    Confirm Password
                  </label>
                  <input
                    id="auth-confirm"
                    type={showPassword ? 'text' : 'password'}
                    required
                    minLength={8}
                    autoComplete="new-password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Repeat password"
                    className="w-full h-11 px-3.5 rounded-xl bg-slate-50/80 dark:bg-slate-950 border border-slate-200 dark:border-slate-700/90 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:bg-white dark:focus:bg-slate-950 focus:outline-none focus:ring-2 focus:ring-teal-500/30 focus:border-teal-600 transition-colors"
                  />
                </div>
              )}

              {mode === 'request' && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="auth-contact" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                      Contact
                    </label>
                    <input
                      id="auth-contact"
                      type="text"
                      value={contact}
                      onChange={(e) => setContact(e.target.value)}
                      placeholder="@telegram or email"
                      className="w-full h-11 px-3.5 rounded-xl bg-slate-50/80 dark:bg-slate-950 border border-slate-200 dark:border-slate-700/90 text-sm text-slate-900 dark:text-slate-100 focus:bg-white dark:focus:bg-slate-950 focus:outline-none focus:ring-2 focus:ring-teal-500/30 focus:border-teal-600 transition-colors"
                    />
                  </div>
                  <div>
                    <label htmlFor="auth-reason" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                      Requested Scope
                    </label>
                    <input
                      id="auth-reason"
                      type="text"
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder="Manage subscriptions"
                      className="w-full h-11 px-3.5 rounded-xl bg-slate-50/80 dark:bg-slate-950 border border-slate-200 dark:border-slate-700/90 text-sm text-slate-900 dark:text-slate-100 focus:bg-white dark:focus:bg-slate-950 focus:outline-none focus:ring-2 focus:ring-teal-500/30 focus:border-teal-600 transition-colors"
                    />
                  </div>
                </div>
              )}

              <button
                type="submit"
                disabled={submitting}
                className="w-full h-11 px-5 mt-2 rounded-xl bg-teal-600 hover:bg-teal-700 active:scale-[0.99] disabled:opacity-50 text-white text-sm font-medium inline-flex items-center justify-center gap-2 transition-all shadow-sm shadow-teal-600/25 whitespace-nowrap"
              >
                {mode === 'setup' ? (
                  <>
                    <KeyRound className="w-4 h-4" />
                    {submitting ? 'Initializing...' : 'Claim Owner Account'}
                  </>
                ) : mode === 'request' ? (
                  <>
                    <UserPlus className="w-4 h-4" />
                    {submitting ? 'Submitting...' : 'Submit Access Request'}
                  </>
                ) : (
                  <>
                    {submitting ? 'Signing in...' : 'Sign In to Artena Panel'}
                    <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
