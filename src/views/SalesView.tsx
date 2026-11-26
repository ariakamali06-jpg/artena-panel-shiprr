import { useEffect, useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Package,
  Plus,
  ShoppingBag,
  Sparkles,
  Star,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { apiRequest, formatTimestamp } from '../lib/api';

interface Plan {
  id: string;
  name: string;
  volumeGb: number;
  days: number;
  stars: number;
  ipLimit: number;
  speedMbps: number;
  badge: string;
  featured: boolean;
  order: number;
}

interface Order {
  id: string;
  userId: string;
  username: string;
  planId: string;
  planName: string;
  amountStars: number;
  serviceId: string;
  createdAt: string;
}

interface Customer {
  userId: string;
  username: string;
  orders: number;
  totalStars: number;
}

interface ConfigStatusItem {
  key: string;
  state: 'configured' | 'not_configured' | 'fallback' | 'invalid';
  summary: string;
}

const PROTOCOL_OPTIONS = [
  { value: '', label: 'Use SALES_DEFAULT_PROTOCOL env' },
  { value: 'vless-ws', label: 'vless-ws (VLESS WebSocket)' },
  { value: 'xhttp-packet-up', label: 'xhttp-packet-up (XHTTP Packet-Up)' },
  { value: 'xhttp-stream-up', label: 'xhttp-stream-up (XHTTP Stream-Up)' },
  { value: 'xhttp-stream-one', label: 'xhttp-stream-one (XHTTP Stream-One)' },
  { value: 'vless-tcp', label: 'vless-tcp (VLESS Raw TCP)' },
  { value: 'vmess-ws', label: 'vmess-ws (VMess WebSocket)' },
  { value: 'trojan-ws', label: 'trojan-ws (Trojan WebSocket)' },
];

export function SalesView({
  onToast,
  onNavigate,
}: {
  onToast: (type: 'success' | 'error' | 'info', msg: string) => void;
  onNavigate: (tab: string) => void;
}) {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [stats, setStats] = useState({ orders: 0, stars: 0, customers: 0 });
  const [salesConfig, setSalesConfig] = useState<{ proto?: ConfigStatusItem; port?: ConfigStatusItem }>({});
  const [loading, setLoading] = useState(true);

  // Plan editor state
  const [showPlanModal, setShowPlanModal] = useState(false);
  const [planName, setPlanName] = useState('');
  const [planGb, setPlanGb] = useState('50');
  const [planDays, setPlanDays] = useState('30');
  const [planStars, setPlanStars] = useState('150');
  const [planIpLimit, setPlanIpLimit] = useState('2');
  const [planSpeed, setPlanSpeed] = useState('50');
  const [planBadge, setPlanBadge] = useState('');
  const [savingPlan, setSavingPlan] = useState(false);

  // Manual fulfillment state
  const [fulfillPlanId, setFulfillPlanId] = useState('');
  const [fulfillUserId, setFulfillUserId] = useState('');
  const [fulfillUsername, setFulfillUsername] = useState('');
  const [fulfillProtocol, setFulfillProtocol] = useState('');
  const [fulfillPort, setFulfillPort] = useState('');
  const [fulfilling, setFulfilling] = useState(false);
  const [fulfillError, setFulfillError] = useState('');
  const [lastProvisioned, setLastProvisioned] = useState<{ label: string; id: string; subUrl: string } | null>(null);

  const load = async () => {
    try {
      const [pRes, oRes, cRes] = await Promise.all([
        apiRequest<{ plans: Plan[] }>('/api/plans'),
        apiRequest<{ orders: Order[]; customers: Customer[]; stats: { orders: number; stars: number; customers: number } }>(
          '/api/sales/orders',
        ).catch(() => ({ orders: [], customers: [], stats: { orders: 0, stars: 0, customers: 0 } })),
        apiRequest<{ items: ConfigStatusItem[] }>('/api/config/status').catch(() => ({ items: [] })),
      ]);
      setPlans(pRes.plans || []);
      if (!fulfillPlanId && pRes.plans?.length) {
        setFulfillPlanId(pRes.plans[0].id);
      }
      setOrders(oRes.orders || []);
      setCustomers(oRes.customers || []);
      setStats(oRes.stats || { orders: 0, stars: 0, customers: 0 });
      const items = cRes.items || [];
      setSalesConfig({
        proto: items.find((i) => i.key === 'SALES_DEFAULT_PROTOCOL'),
        port: items.find((i) => i.key === 'SALES_DEFAULT_PORT'),
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const createPlan = async (e: FormEvent) => {
    e.preventDefault();
    setSavingPlan(true);
    try {
      await apiRequest('/api/plans', {
        method: 'POST',
        body: {
          name: planName,
          volumeGb: Number(planGb) || 50,
          days: Number(planDays) || 30,
          stars: Number(planStars) || 100,
          ipLimit: Number(planIpLimit) || 2,
          speedMbps: Number(planSpeed) || 0,
          badge: planBadge,
          featured: false,
        },
      });
      onToast('success', `Plan "${planName}" created`);
      setPlanName('');
      setPlanBadge('');
      setShowPlanModal(false);
      await load();
    } catch (err) {
      onToast('error', err instanceof Error ? err.message : 'Failed to create plan');
    } finally {
      setSavingPlan(false);
    }
  };

  const toggleFeatured = async (plan: Plan) => {
    try {
      await apiRequest('/api/plans', {
        method: 'POST',
        body: { ...plan, featured: !plan.featured },
      });
      await load();
    } catch (err) {
      onToast('error', err instanceof Error ? err.message : 'Failed to update plan');
    }
  };

  const removePlan = async (id: string, name: string) => {
    try {
      await apiRequest(`/api/plans/${id}`, { method: 'DELETE' });
      onToast('info', `Removed plan "${name}"`);
      await load();
    } catch (err) {
      onToast('error', err instanceof Error ? err.message : 'Failed to delete plan');
    }
  };

  const handleFulfill = async (e: FormEvent) => {
    e.preventDefault();
    setFulfillError('');
    setLastProvisioned(null);
    setFulfilling(true);
    try {
      const body: Record<string, unknown> = {
        planId: fulfillPlanId,
        userId: fulfillUserId.trim() || undefined,
        username: fulfillUsername.trim() || undefined,
      };
      if (fulfillProtocol) body.protocol = fulfillProtocol;
      if (fulfillPort.trim()) body.port = Number(fulfillPort.trim());

      const res = await apiRequest<{
        order: Order;
        service: { id: string; label: string; subUrl: string };
      }>('/api/sales/fulfill', {
        method: 'POST',
        body,
      });
      setLastProvisioned({
        label: res.service.label,
        id: res.service.id,
        subUrl: res.service.subUrl,
      });
      onToast('success', `Order fulfilled and service "${res.service.label}" provisioned`);
      setFulfillUserId('');
      setFulfillUsername('');
      await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Fulfillment failed';
      setFulfillError(msg);
    } finally {
      setFulfilling(false);
    }
  };

  const defaultsPending =
    salesConfig.proto?.state !== 'configured' || salesConfig.port?.state !== 'configured';

  return (
    <div className="space-y-6">
      {/* Sales Defaults Status Notice */}
      {defaultsPending && (
        <div className="bg-amber-50/80 dark:bg-amber-950/30 border border-amber-200/90 dark:border-amber-800/80 rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
            <div className="text-xs text-amber-900 dark:text-amber-200 space-y-1">
              <p className="font-semibold">
                Automated sales defaults are pending configuration (SALES_DEFAULT_PROTOCOL / SALES_DEFAULT_PORT).
              </p>
              <p className="text-amber-800/90 dark:text-amber-300/80 leading-relaxed">
                Telegram Stars auto-fulfillment requires both environment variables. You can still fulfill orders manually below by selecting an explicit protocol and port.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => onNavigate('settings')}
            className="h-9 px-3.5 rounded-xl border border-amber-300 dark:border-amber-700 bg-white/70 dark:bg-amber-950/40 text-xs font-medium text-amber-900 dark:text-amber-100 hover:bg-amber-100/70 dark:hover:bg-amber-900/40 whitespace-nowrap shrink-0 transition-colors"
          >
            View Config Status
          </button>
        </div>
      )}

      {/* KPI Row */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="artena-card p-5 flex flex-col justify-between gap-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400">Total Revenue</span>
            <div className="w-8 h-8 rounded-xl bg-amber-50 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400 flex items-center justify-center">
              <Sparkles className="w-4 h-4" />
            </div>
          </div>
          <div className="font-mono tabular-nums text-3xl font-semibold tracking-tight text-slate-900 dark:text-slate-50">
            {stats.stars.toLocaleString()}
            <span className="text-xs font-sans font-normal text-slate-500 ml-1.5">XTR Stars</span>
          </div>
        </div>
        <div className="artena-card p-5 flex flex-col justify-between gap-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400">Fulfilled Orders</span>
            <div className="w-8 h-8 rounded-xl bg-teal-50 dark:bg-teal-950/60 text-teal-600 dark:text-teal-400 flex items-center justify-center">
              <ShoppingBag className="w-4 h-4" />
            </div>
          </div>
          <div className="font-mono tabular-nums text-3xl font-semibold tracking-tight text-slate-900 dark:text-slate-50">
            {stats.orders}
          </div>
        </div>
        <div className="artena-card p-5 flex flex-col justify-between gap-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400">Unique Customers</span>
            <div className="w-8 h-8 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 flex items-center justify-center">
              <Users className="w-4 h-4" />
            </div>
          </div>
          <div className="font-mono tabular-nums text-3xl font-semibold tracking-tight text-slate-900 dark:text-slate-50">
            {stats.customers}
          </div>
        </div>
      </div>

      {/* Plans + Manual Fulfillment Grid */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
        {/* Plans List */}
        <div className="xl:col-span-7 artena-card p-6">
          <div className="flex items-center justify-between gap-3 mb-5">
            <div>
              <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
                Subscription Plans
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                Sold via Telegram Bot Stars (XTR) invoices and direct Artena fulfillment
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowPlanModal(true)}
              className="h-9 px-3.5 rounded-xl bg-gradient-to-b from-[#E8AE5C] to-[#D08F35] hover:from-[#F0BC70] hover:to-[#DC9E49] text-[#0A131C] font-semibold shadow-[0_2px_10px_-2px_rgba(225,159,72,0.45)] text-xs font-medium inline-flex items-center gap-1.5 shadow-sm shadow-teal-600/20 transition-all"
            >
              <Plus className="w-3.5 h-3.5" /> New Plan
            </button>
          </div>

          {loading ? (
            <div className="h-32 bg-slate-50 dark:bg-slate-800/40 rounded-xl" />
          ) : plans.length === 0 ? (
            <p className="text-xs text-slate-500 py-10 text-center">No plans configured yet.</p>
          ) : (
            <div className="divide-y divide-slate-100 dark:divide-slate-800/80">
              {plans.map((p) => (
                <div key={p.id} className="py-3.5 flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Package className="w-4 h-4 text-teal-600 dark:text-teal-400 shrink-0" />
                      <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">{p.name}</span>
                      {p.badge && (
                        <span className="text-[11px] font-mono text-teal-700 dark:text-teal-400">
                          · {p.badge}
                        </span>
                      )}
                      {p.featured && (
                        <span className="text-[11px] font-mono text-amber-600 dark:text-amber-400 inline-flex items-center gap-0.5">
                          <Star className="w-3 h-3 fill-current" /> Featured
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 font-mono tabular-nums">
                      {p.volumeGb} GB · {p.days}d · {p.ipLimit} IP
                      {p.speedMbps > 0 ? ` · ${p.speedMbps} Mbps` : ''} · {p.stars} Stars
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void toggleFeatured(p)}
                      className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                    >
                      {p.featured ? 'Unfeature' : 'Feature'}
                    </button>
                    <button
                      type="button"
                      onClick={() => void removePlan(p.id, p.name)}
                      aria-label={`Delete ${p.name}`}
                      className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Manual Order Fulfillment */}
        <div className="xl:col-span-5 artena-card p-6">
          <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
            Fulfill Order
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 mb-4 leading-relaxed">
            Provision a plan directly for a customer. Uses SALES_DEFAULT_PROTOCOL and SALES_DEFAULT_PORT unless explicitly overridden.
          </p>

          <form onSubmit={handleFulfill} className="space-y-3.5">
            <div>
              <label htmlFor="fulfill-plan" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Plan
              </label>
              <select
                id="fulfill-plan"
                value={fulfillPlanId}
                onChange={(e) => setFulfillPlanId(e.target.value)}
                required
                className="w-full h-9 px-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 text-xs text-slate-900 dark:text-slate-100"
              >
                {plans.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.volumeGb} GB, {p.days}d, {p.stars} Stars)
                  </option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="fulfill-uid" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Customer ID (optional)
                </label>
                <input
                  id="fulfill-uid"
                  type="text"
                  value={fulfillUserId}
                  onChange={(e) => setFulfillUserId(e.target.value)}
                  placeholder="Telegram ID or ref"
                  className="w-full h-9 px-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 text-xs font-mono text-slate-900 dark:text-slate-100"
                />
              </div>
              <div>
                <label htmlFor="fulfill-uname" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Username (optional)
                </label>
                <input
                  id="fulfill-uname"
                  type="text"
                  value={fulfillUsername}
                  onChange={(e) => setFulfillUsername(e.target.value)}
                  placeholder="@handle"
                  className="w-full h-9 px-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 text-xs text-slate-900 dark:text-slate-100"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="sm:col-span-2">
                <label htmlFor="fulfill-proto" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Protocol Override
                </label>
                <select
                  id="fulfill-proto"
                  value={fulfillProtocol}
                  onChange={(e) => setFulfillProtocol(e.target.value)}
                  className="w-full h-9 px-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 text-xs text-slate-900 dark:text-slate-100"
                >
                  {PROTOCOL_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="fulfill-port" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Port Override
                </label>
                <input
                  id="fulfill-port"
                  type="number"
                  min={1}
                  max={65535}
                  value={fulfillPort}
                  onChange={(e) => setFulfillPort(e.target.value)}
                  placeholder="Env default"
                  className="w-full h-9 px-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 text-xs font-mono tabular-nums text-slate-900 dark:text-slate-100"
                />
              </div>
            </div>

            {fulfillError && (
              <div
                role="alert"
                className="p-3 rounded-xl border border-red-200 dark:border-red-900 bg-red-50/70 dark:bg-red-950/40 text-xs text-red-700 dark:text-red-300 leading-relaxed"
              >
                {fulfillError}
              </div>
            )}

            {lastProvisioned && (
              <div className="p-3 rounded-xl border border-emerald-200 dark:border-emerald-900 bg-emerald-50/70 dark:bg-emerald-950/30 text-xs text-emerald-800 dark:text-emerald-200 flex items-start gap-2">
                <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <p className="font-medium">Provisioned: {lastProvisioned.label}</p>
                  <p className="font-mono text-[11px] truncate opacity-80">{lastProvisioned.id}</p>
                </div>
              </div>
            )}

            <button
              type="submit"
              disabled={fulfilling || !fulfillPlanId}
              className="w-full h-10 rounded-xl bg-gradient-to-b from-[#E8AE5C] to-[#D08F35] hover:from-[#F0BC70] hover:to-[#DC9E49] text-[#0A131C] font-semibold shadow-[0_2px_10px_-2px_rgba(225,159,72,0.45)] text-xs font-medium shadow-sm shadow-teal-600/20 disabled:opacity-50 transition-all"
            >
              {fulfilling ? 'Provisioning...' : 'Fulfill Order & Provision Service'}
            </button>
          </form>
        </div>
      </div>

      {/* Orders Ledger + Customers */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
        <div className="xl:col-span-8 artena-card p-6">
          <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100 mb-4">
            Order Ledger
          </h3>
          {orders.length === 0 ? (
            <p className="text-xs text-slate-500 py-8 text-center">No orders fulfilled yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 text-[11px] text-slate-500 dark:text-slate-400">
                    <th className="py-2.5 pr-3 font-medium">Order</th>
                    <th className="py-2.5 pr-3 font-medium">Customer</th>
                    <th className="py-2.5 pr-3 font-medium">Plan</th>
                    <th className="py-2.5 pr-3 font-medium">Amount</th>
                    <th className="py-2.5 font-medium">Time</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
                  {orders.map((o) => (
                    <tr key={o.id} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/30 transition-colors">
                      <td className="py-3 pr-3 font-mono text-slate-700 dark:text-slate-300">{o.id}</td>
                      <td className="py-3 pr-3 font-medium text-slate-900 dark:text-slate-100">
                        {o.username ? `@${o.username}` : o.userId}
                      </td>
                      <td className="py-3 pr-3 text-slate-700 dark:text-slate-300">{o.planName}</td>
                      <td className="py-3 pr-3 font-mono tabular-nums font-medium text-amber-700 dark:text-amber-400">
                        {o.amountStars} XTR
                      </td>
                      <td className="py-3 font-mono tabular-nums text-slate-500">
                        {formatTimestamp(o.createdAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="xl:col-span-4 artena-card p-6">
          <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100 mb-4">
            Top Customers
          </h3>
          {customers.length === 0 ? (
            <p className="text-xs text-slate-500 py-8 text-center">No customer records yet.</p>
          ) : (
            <div className="divide-y divide-slate-100 dark:divide-slate-800/80">
              {customers.slice(0, 12).map((c) => (
                <div key={c.userId} className="py-3 flex items-center justify-between text-xs">
                  <div className="min-w-0">
                    <p className="font-semibold text-slate-900 dark:text-slate-100 truncate">
                      {c.username ? `@${c.username}` : c.userId}
                    </p>
                    <p className="text-[11px] text-slate-500 font-mono tabular-nums">
                      {c.orders} order{c.orders === 1 ? '' : 's'}
                    </p>
                  </div>
                  <span className="font-mono tabular-nums font-semibold text-amber-700 dark:text-amber-400">
                    {c.totalStars} XTR
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Create Plan Modal */}
      {showPlanModal && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/55 backdrop-blur-xs flex items-center justify-center p-4"
          onClick={() => setShowPlanModal(false)}
        >
          <div
            className="w-full max-w-md artena-card p-6 shadow-2xl artena-enter"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
                Create Subscription Plan
              </h3>
              <button
                type="button"
                onClick={() => setShowPlanModal(false)}
                aria-label="Close"
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={createPlan} className="space-y-3.5">
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Name</label>
                <input
                  type="text"
                  required
                  value={planName}
                  onChange={(e) => setPlanName(e.target.value)}
                  placeholder="Pro 100GB"
                  className="w-full h-9 px-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 text-xs text-slate-900 dark:text-slate-100"
                />
              </div>
              <div className="grid grid-cols-3 gap-2.5">
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Volume (GB)</label>
                  <input
                    type="number"
                    min={1}
                    value={planGb}
                    onChange={(e) => setPlanGb(e.target.value)}
                    className="w-full h-9 px-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 text-xs font-mono tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Days</label>
                  <input
                    type="number"
                    min={1}
                    value={planDays}
                    onChange={(e) => setPlanDays(e.target.value)}
                    className="w-full h-9 px-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 text-xs font-mono tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Stars (XTR)</label>
                  <input
                    type="number"
                    min={1}
                    value={planStars}
                    onChange={(e) => setPlanStars(e.target.value)}
                    className="w-full h-9 px-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 text-xs font-mono tabular-nums"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">IP Limit</label>
                  <input
                    type="number"
                    min={0}
                    value={planIpLimit}
                    onChange={(e) => setPlanIpLimit(e.target.value)}
                    className="w-full h-9 px-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 text-xs font-mono tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Speed (Mbps)</label>
                  <input
                    type="number"
                    min={0}
                    value={planSpeed}
                    onChange={(e) => setPlanSpeed(e.target.value)}
                    className="w-full h-9 px-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 text-xs font-mono tabular-nums"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Tier Label (optional)</label>
                <input
                  type="text"
                  value={planBadge}
                  onChange={(e) => setPlanBadge(e.target.value)}
                  placeholder="Most Popular"
                  className="w-full h-9 px-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 text-xs"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowPlanModal(false)}
                  className="h-9 px-3.5 rounded-xl border border-slate-200 dark:border-slate-700 text-xs text-slate-600 dark:text-slate-300"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingPlan}
                  className="h-9 px-4 rounded-xl bg-gradient-to-b from-[#E8AE5C] to-[#D08F35] hover:from-[#F0BC70] hover:to-[#DC9E49] text-[#0A131C] font-semibold shadow-[0_2px_10px_-2px_rgba(225,159,72,0.45)] text-xs font-medium shadow-sm shadow-teal-600/20"
                >
                  {savingPlan ? 'Saving...' : 'Create Plan'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
