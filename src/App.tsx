import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  ArrowRight,
  Bot,
  Command,
  FolderKanban,
  Globe2,
  LayoutDashboard,
  LogOut,
  Menu,
  Moon,
  Network,
  Plus,
  Search,
  Server,
  Settings,
  Shield,
  ShoppingBag,
  Smartphone,
  Sun,
  X,
} from 'lucide-react';
import { apiRequest, setAuthToken, type AuthUser } from './lib/api';
import { ArtenaLogoMark } from './components/ArtenaBrand';
import { ArtenaMark } from './components/ArtenaMark';
import { AuthScreen } from './components/AuthScreen';
import { ToastStack, type ToastItem } from './components/Toast';
import { OverviewView } from './views/OverviewView';
import { ServicesView } from './views/ServicesView';
import { SubscriptionsView } from './views/SubscriptionsView';
import { ProxiesView } from './views/ProxiesView';
import { NodesView } from './views/NodesView';
import { SalesView } from './views/SalesView';
import { TelegramBotView } from './views/TelegramBotView';
import { ReportsAndLiveView } from './views/ReportsAndLiveView';
import { AdminsView } from './views/AdminsView';
import { SettingsView } from './views/SettingsView';
import { MiniAppView } from './views/MiniAppView';
import { PublicPortalView } from './views/PublicPortalView';

type NavKey =
  | 'overview'
  | 'services'
  | 'subscriptions'
  | 'proxies'
  | 'nodes'
  | 'sales'
  | 'telegram'
  | 'reports'
  | 'admins'
  | 'settings';

type NavGroupKey = 'core' | 'network' | 'operations';

interface NavItem {
  key: NavKey;
  label: string;
  subtitle: string;
  group: NavGroupKey;
  icon: typeof LayoutDashboard;
  ownerOnly?: boolean;
}

const NAV_GROUPS: Array<{ key: NavGroupKey; label: string }> = [
  { key: 'core', label: 'Core' },
  { key: 'network', label: 'Network & Mesh' },
  { key: 'operations', label: 'Operations & System' },
];

const NAV_ITEMS: NavItem[] = [
  {
    key: 'overview',
    label: 'Overview',
    subtitle: 'Telemetry, listeners & health',
    group: 'core',
    icon: LayoutDashboard,
  },
  {
    key: 'services',
    label: 'Services & Relays',
    subtitle: 'VLESS WS, XHTTP, TCP & manual configs',
    group: 'core',
    icon: Server,
  },
  {
    key: 'subscriptions',
    label: 'Subscriptions',
    subtitle: 'Client portals & Base64 feeds',
    group: 'core',
    icon: FolderKanban,
  },
  {
    key: 'proxies',
    label: 'Outbound Proxies',
    subtitle: 'SOCKS5/HTTP exits & live scanner',
    group: 'network',
    icon: Globe2,
  },
  {
    key: 'nodes',
    label: 'Multi-Node Mesh',
    subtitle: 'Federated Artena servers',
    group: 'network',
    icon: Network,
    ownerOnly: true,
  },
  {
    key: 'sales',
    label: 'Plans & Sales',
    subtitle: 'Catalog, Stars orders & customers',
    group: 'operations',
    icon: ShoppingBag,
  },
  {
    key: 'telegram',
    label: 'Telegram Bot',
    subtitle: 'Worker controls, commands & templates',
    group: 'operations',
    icon: Bot,
  },
  {
    key: 'reports',
    label: 'Live & Analytics',
    subtitle: 'Active sockets, CSV reports & logs',
    group: 'operations',
    icon: Activity,
  },
  {
    key: 'admins',
    label: 'Admins & RBAC',
    subtitle: 'Sub-administrators & permissions',
    group: 'operations',
    icon: Shield,
    ownerOnly: true,
  },
  {
    key: 'settings',
    label: 'Config & Settings',
    subtitle: 'Environment readiness & security',
    group: 'operations',
    icon: Settings,
  },
];

export default function App() {
  const [pathname, setPathname] = useState(() => window.location.pathname);
  const [dark, setDark] = useState(true);
  const [booting, setBooting] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [activeTab, setActiveTab] = useState<NavKey>('overview');
  const [createSignal, setCreateSignal] = useState(0);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const pushToast = (message: string, tone: ToastItem['tone'] = 'info') => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setToasts((prev) => [...prev.slice(-3), { id, tone, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4200);
  };

  const pushTypedToast = (type: 'success' | 'error' | 'info', message: string) => {
    pushToast(message, type === 'success' ? 'ok' : type);
  };

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
  }, [dark]);

  useEffect(() => {
    const onPop = () => setPathname(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        if (!user) return;
        e.preventDefault();
        setPaletteOpen((open) => {
          const next = !open;
          if (next) setPaletteQuery('');
          return next;
        });
      } else if (e.key === 'Escape' && paletteOpen) {
        setPaletteOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [user, paletteOpen]);

  const navigatePath = (next: string) => {
    window.history.pushState({}, '', next);
    setPathname(next);
  };

  useEffect(() => {
    if (pathname.startsWith('/subscription/') || pathname.startsWith('/p/')) {
      setBooting(false);
      return;
    }
    apiRequest<{ needsSetup: boolean }>('/api/auth/status')
      .then((st) => setNeedsSetup(Boolean(st.needsSetup)))
      .catch(() => {})
      .finally(() => setBooting(false));
  }, []);

  const visibleNav = useMemo(
    () => NAV_ITEMS.filter((item) => !item.ownerOnly || user?.role === 'owner'),
    [user?.role],
  );

  const paletteMatches = useMemo(() => {
    const q = paletteQuery.trim().toLowerCase();
    if (!q) return visibleNav;
    return visibleNav.filter(
      (item) =>
        item.label.toLowerCase().includes(q) ||
        item.subtitle.toLowerCase().includes(q) ||
        item.key.toLowerCase().includes(q),
    );
  }, [paletteQuery, visibleNav]);

  // Route 1: Public single-service portal
  if (pathname.startsWith('/subscription/')) {
    const uuid = pathname.slice('/subscription/'.length).split('/')[0];
    return <PublicPortalView mode="single" identifier={uuid} />;
  }

  // Route 2: Public subscription group portal
  if (pathname.startsWith('/p/')) {
    const uuidKey = pathname.slice('/p/'.length).split('/')[0];
    return <PublicPortalView mode="group" identifier={uuidKey} />;
  }

  // Route 3: Mobile-first Telegram Mini App
  if (pathname === '/miniapp' || pathname === '/app') {
    return <MiniAppView onBackToPanel={() => navigatePath('/')} />;
  }

  if (booting) {
    return (
      <div className="min-h-screen artena-canvas flex flex-col items-center justify-center gap-3">
        <div className="relative">
          <div className="absolute -inset-1.5 rounded-xl bg-amber-400/15 blur-md" />
          <ArtenaLogoMark className="w-10 h-10 relative" />
        </div>
        <div className="text-xs font-mono tracking-wide text-slate-500 dark:text-slate-400">
          Initializing Artena Panel...
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <>
        <AuthScreen
          needsSetup={needsSetup}
          onAuthenticated={(u) => {
            setUser(u);
            setNeedsSetup(false);
          }}
          onToast={pushToast}
        />
        <ToastStack toasts={toasts} onDismiss={(id) => setToasts((p) => p.filter((t) => t.id !== id))} />
      </>
    );
  }

  const handleLogout = async () => {
    try {
      await apiRequest('/api/logout', { method: 'POST' });
    } catch {
      // Ignore
    }
    setAuthToken(null);
    setUser(null);
  };

  const activeMeta = NAV_ITEMS.find((i) => i.key === activeTab) || NAV_ITEMS[0];

  const handleQuickCreate = async () => {
    try {
      const res = await apiRequest<{ service: { label: string } }>('/api/services/auto', {
        method: 'POST',
        body: { protocol: 'vless-ws', gb: 50, days: 30 },
      });
      pushToast(`Quick-provisioned "${res.service.label}"`, 'ok');
      setActiveTab('services');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : 'Quick provision failed', 'error');
    }
  };

  const renderNavGroups = (onPick?: () => void) => (
    <div className="space-y-5">
      {NAV_GROUPS.map((group) => {
        const items = visibleNav.filter((i) => i.group === group.key);
        if (items.length === 0) return null;
        return (
          <div key={group.key}>
            <div className="px-3 mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400 dark:text-slate-500">
              {group.label}
            </div>
            <div className="space-y-0.5">
              {items.map((item) => {
                const Icon = item.icon;
                const active = activeTab === item.key;
                return (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => {
                      setActiveTab(item.key);
                      onPick?.();
                    }}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-[13px] font-medium transition-all ${
                      active
                        ? 'bg-teal-50/90 dark:bg-teal-950/60 text-teal-700 dark:text-teal-300 shadow-[inset_0_0_0_1px_rgba(13,148,136,0.16)] dark:shadow-[inset_0_0_0_1px_rgba(20,184,166,0.22)]'
                        : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100/80 dark:hover:bg-slate-800/60 hover:text-slate-900 dark:hover:text-slate-100'
                    }`}
                  >
                    <Icon
                      className={`w-4 h-4 shrink-0 transition-colors ${
                        active ? 'text-teal-600 dark:text-teal-400' : 'text-slate-400 dark:text-slate-500'
                      }`}
                    />
                    <span className="truncate">{item.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );

  return (
    <div className="min-h-screen artena-canvas text-slate-900 dark:text-slate-100 flex">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex lg:flex-col w-64 shrink-0 bg-white/95 dark:bg-[#101F30]/95 backdrop-blur-md border-r border-slate-200/90 dark:border-slate-800/90 sticky top-0 h-screen">
        <div className="h-16 px-5 flex items-center gap-3 border-b border-slate-200/80 dark:border-slate-800/80">
          <ArtenaLogoMark className="w-8 h-8 shrink-0" />
          <div className="min-w-0">
            <p className="font-display text-[15px] font-semibold tracking-tight text-slate-900 dark:text-slate-50 truncate">
              Artena Panel
            </p>
            <p className="text-[10px] font-mono tracking-wider text-slate-400 dark:text-slate-500 uppercase">
              Proxy & Relay Mesh
            </p>
          </div>
        </div>

        <nav aria-label="Primary navigation" className="flex-1 overflow-y-auto px-3 py-5">
          {renderNavGroups()}
        </nav>

        <div className="p-3.5 border-t border-slate-200/80 dark:border-slate-800/80 space-y-2.5 bg-slate-50/60 dark:bg-slate-900/40">
          <button
            type="button"
            onClick={() => navigatePath('/miniapp')}
            className="w-full flex items-center justify-between px-3 py-2.5 rounded-xl border border-slate-200/90 dark:border-slate-700/80 bg-white dark:bg-slate-900 text-xs font-medium text-slate-700 dark:text-slate-200 hover:border-teal-300 dark:hover:border-teal-700 hover:text-teal-700 dark:hover:text-teal-300 transition-colors"
          >
            <span className="inline-flex items-center gap-2">
              <Smartphone className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400" />
              <span>Open Mini App</span>
            </span>
            <ArrowRight className="w-3.5 h-3.5 text-slate-400" />
          </button>

          <div className="flex items-center justify-between gap-2 px-1.5 pt-0.5">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="w-7 h-7 rounded-lg bg-slate-900 dark:bg-teal-950 text-white dark:text-teal-300 border border-slate-800 dark:border-teal-800/60 flex items-center justify-center text-xs font-semibold uppercase shrink-0">
                {user.username.slice(0, 1)}
              </div>
              <div className="min-w-0">
                <p className="text-xs font-semibold text-slate-800 dark:text-slate-100 truncate">{user.username}</p>
                <p className="text-[10px] font-mono uppercase tracking-wider text-slate-400 dark:text-slate-500">
                  {user.role}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => void handleLogout()}
              aria-label="Sign out"
              title="Sign out"
              className="p-2 rounded-lg text-slate-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </aside>

      {/* Mobile Drawer */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-slate-950/60 backdrop-blur-xs"
            onClick={() => setMobileMenuOpen(false)}
          />
          <div className="relative w-72 max-w-[82vw] bg-white dark:bg-[#101F30] h-full flex flex-col border-r border-slate-200 dark:border-slate-800 shadow-2xl">
            <div className="h-16 px-4 flex items-center justify-between border-b border-slate-200 dark:border-slate-800">
              <div className="flex items-center gap-2.5">
                <ArtenaLogoMark className="w-7 h-7" />
                <span className="font-display text-sm font-semibold tracking-tight">Artena Panel</span>
              </div>
              <button
                type="button"
                onClick={() => setMobileMenuOpen(false)}
                aria-label="Close menu"
                className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <nav className="flex-1 overflow-y-auto p-3.5">{renderNavGroups(() => setMobileMenuOpen(false))}</nav>
            <div className="p-3.5 border-t border-slate-200 dark:border-slate-800 space-y-2">
              <button
                type="button"
                onClick={() => {
                  setMobileMenuOpen(false);
                  navigatePath('/miniapp');
                }}
                className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200"
              >
                <Smartphone className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400" />
                Open Mini App
              </button>
              <button
                type="button"
                onClick={() => {
                  setMobileMenuOpen(false);
                  void handleLogout();
                }}
                className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-xl text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40"
              >
                <LogOut className="w-3.5 h-3.5" /> Sign Out ({user.username})
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Main Content Shell */}
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="sticky top-0 z-20 h-16 px-4 sm:px-7 bg-white/85 dark:bg-[#0A131C]/85 backdrop-blur-md border-b border-slate-200/80 dark:border-slate-800/80 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              aria-label="Open menu"
              className="lg:hidden p-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200"
            >
              <Menu className="w-4 h-4" />
            </button>
            <div className="min-w-0">
              <div className="hidden sm:flex items-center gap-1.5 text-[11px] text-slate-400 dark:text-slate-500">
                <span>Artena Panel</span>
                <span>/</span>
                <span className="text-slate-600 dark:text-slate-300">{activeMeta.label}</span>
              </div>
              <h1 className="font-display text-base sm:text-[17px] font-semibold tracking-tight text-slate-900 dark:text-slate-50 truncate">
                {activeMeta.label}
              </h1>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setPaletteQuery('');
                setPaletteOpen(true);
              }}
              aria-label="Open quick jump palette"
              className="hidden md:inline-flex items-center gap-2.5 h-9 px-3 rounded-xl border border-slate-200/90 dark:border-slate-700/80 bg-slate-50/70 dark:bg-slate-900/80 text-xs text-slate-500 dark:text-slate-400 hover:border-slate-300 dark:hover:border-slate-600 hover:text-slate-700 dark:hover:text-slate-200 transition-colors"
            >
              <Search className="w-3.5 h-3.5" />
              <span>Quick jump...</span>
              <kbd className="ml-2 inline-flex items-center gap-0.5 font-mono text-[10px] text-slate-400 dark:text-slate-500">
                <Command className="w-2.5 h-2.5" />K
              </kbd>
            </button>

            <button
              type="button"
              onClick={() => {
                setActiveTab('services');
                setCreateSignal((n) => n + 1);
              }}
              className="h-9 px-3.5 rounded-xl bg-gradient-to-b from-[#E8AE5C] to-[#D08F35] hover:from-[#F0BC70] hover:to-[#DC9E49] text-[#0A131C] font-semibold shadow-[0_2px_10px_-2px_rgba(225,159,72,0.45)] text-xs font-medium inline-flex items-center gap-1.5 shadow-sm shadow-teal-600/20 transition-all whitespace-nowrap"
            >
              <Plus className="w-3.5 h-3.5" /> New Service
            </button>

            <button
              type="button"
              onClick={() => setDark((d) => !d)}
              aria-label="Toggle color theme"
              title={dark ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
              className="w-9 h-9 rounded-xl border border-slate-200/90 dark:border-slate-700/80 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center justify-center transition-colors"
            >
              {dark ? <Sun className="w-4 h-4 text-amber-400" /> : <Moon className="w-4 h-4" />}
            </button>
          </div>
        </header>

        <main className="flex-1 p-4 sm:p-6 lg:p-7 max-w-[1440px] w-full mx-auto">
          <div key={activeTab} className="artena-enter">
            {activeTab === 'overview' && (
              <OverviewView
                onNavigate={(tab) => setActiveTab(tab as NavKey)}
                onQuickCreate={() => void handleQuickCreate()}
              />
            )}
            {activeTab === 'services' && <ServicesView onToast={pushToast} openCreateSignal={createSignal} />}
            {activeTab === 'subscriptions' && <SubscriptionsView onToast={pushToast} />}
            {activeTab === 'proxies' && <ProxiesView onToast={pushToast} />}
            {activeTab === 'nodes' && <NodesView onToast={pushToast} />}
            {activeTab === 'sales' && (
              <SalesView onToast={pushTypedToast} onNavigate={(tab) => setActiveTab(tab as NavKey)} />
            )}
            {activeTab === 'telegram' && (
              <TelegramBotView onToast={pushTypedToast} onNavigate={(tab) => setActiveTab(tab as NavKey)} />
            )}
            {activeTab === 'reports' && <ReportsAndLiveView onToast={pushTypedToast} />}
            {activeTab === 'admins' && <AdminsView onToast={pushTypedToast} />}
            {activeTab === 'settings' && (
              <SettingsView
                currentUsername={user.username}
                onUsernameUpdated={(next) => setUser((u) => (u ? { ...u, username: next } : u))}
                onToast={pushTypedToast}
              />
            )}
          </div>
        </main>
      </div>

      {/* Quick Jump Command Palette */}
      {paletteOpen && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/50 backdrop-blur-xs flex items-start justify-center pt-[14vh] p-4"
          onClick={() => setPaletteOpen(false)}
        >
          <div
            className="w-full max-w-lg artena-card overflow-hidden shadow-2xl artena-enter"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2.5 px-4 py-3 border-b border-slate-200 dark:border-slate-800">
              <Search className="w-4 h-4 text-teal-600 dark:text-teal-400 shrink-0" />
              <input
                type="text"
                autoFocus
                value={paletteQuery}
                onChange={(e) => setPaletteQuery(e.target.value)}
                placeholder="Jump to a section or action..."
                className="flex-1 bg-transparent text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setPaletteOpen(false)}
                aria-label="Close palette"
                className="text-[11px] font-mono text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 px-1.5 py-0.5 rounded border border-slate-200 dark:border-slate-700"
              >
                ESC
              </button>
            </div>

            <div className="max-h-80 overflow-y-auto p-2 space-y-1">
              {paletteMatches.map((item) => {
                const Icon = item.icon;
                const active = activeTab === item.key;
                return (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => {
                      setActiveTab(item.key);
                      setPaletteOpen(false);
                    }}
                    className={`w-full flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl text-left transition-colors ${
                      active
                        ? 'bg-amber-400/10 text-amber-600 dark:text-amber-300'
                        : 'hover:bg-slate-100/80 dark:hover:bg-slate-800/70 text-slate-700 dark:text-slate-200'
                    }`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <Icon className="w-4 h-4 shrink-0 text-teal-600 dark:text-teal-400" />
                      <div className="min-w-0">
                        <div className="text-xs font-semibold truncate">{item.label}</div>
                        <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate">{item.subtitle}</div>
                      </div>
                    </div>
                    <ArrowRight className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                  </button>
                );
              })}

              <div className="pt-2 mt-2 border-t border-slate-100 dark:border-slate-800 grid grid-cols-2 gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    setPaletteOpen(false);
                    setActiveTab('services');
                    setCreateSignal((n) => n + 1);
                  }}
                  className="flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-medium text-teal-700 dark:text-teal-300 bg-teal-50/70 dark:bg-teal-950/40 hover:bg-teal-100/70 dark:hover:bg-teal-950/70"
                >
                  <Plus className="w-3.5 h-3.5" /> New Relay Service
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setDark((d) => !d);
                    setPaletteOpen(false);
                  }}
                  className="flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-medium text-slate-700 dark:text-slate-200 bg-slate-100/80 dark:bg-slate-800/80 hover:bg-slate-200/70 dark:hover:bg-slate-800"
                >
                  {dark ? <Sun className="w-3.5 h-3.5 text-amber-400" /> : <Moon className="w-3.5 h-3.5" />}
                  {dark ? 'Switch to Light' : 'Switch to Dark'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <ToastStack toasts={toasts} onDismiss={(id) => setToasts((p) => p.filter((t) => t.id !== id))} />
    </div>
  );
}
