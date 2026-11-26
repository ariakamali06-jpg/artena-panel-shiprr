import crypto from 'node:crypto';
import path from 'node:path';
import type { SalesOrder, SalesPlan, ServiceRecord } from '../types';
import { atomicWriteJson, readJsonFile, stateStore } from '../store/stateStore';
import {
  ACCEPTED_SALES_PROTOCOLS,
  formatMissingConfigMessage,
  resolveRuntimeConfig,
} from '../config/envConfig';

const DEFAULT_PLANS: Record<string, SalesPlan> = {
  starter: {
    id: 'starter',
    name: 'Starter',
    days: 30,
    volumeGb: 50,
    speedMbps: 30,
    ipLimit: 1,
    stars: 99,
    badge: 'Essential',
    featured: false,
    order: 1,
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    days: 90,
    volumeGb: 200,
    speedMbps: 80,
    ipLimit: 2,
    stars: 249,
    badge: 'Most Popular',
    featured: true,
    order: 2,
  },
  ultra: {
    id: 'ultra',
    name: 'Ultra',
    days: 180,
    volumeGb: 500,
    speedMbps: 150,
    ipLimit: 3,
    stars: 499,
    badge: 'Best Value',
    featured: false,
    order: 3,
  },
};

interface SalesLedger {
  orders: SalesOrder[];
  customers: Record<string, { userId: string; username: string; orders: number; totalStars: number }>;
}

class SalesEngine {
  private readonly plansFile: string;
  private readonly salesFile: string;
  public plans: Record<string, SalesPlan> = {};
  public ledger: SalesLedger = { orders: [], customers: {} };

  constructor() {
    this.plansFile = path.join(stateStore.dataDir, 'kestrel_plans.json');
    this.salesFile = path.join(stateStore.dataDir, 'kestrel_sales.json');
    this.load();
  }

  private load(): void {
    const savedPlans = readJsonFile<Record<string, SalesPlan> | null>(this.plansFile, null);
    if (savedPlans && Object.keys(savedPlans).length > 0) {
      this.plans = savedPlans;
    } else {
      this.plans = structuredClone(DEFAULT_PLANS);
      atomicWriteJson(this.plansFile, this.plans);
    }

    const savedSales = readJsonFile<SalesLedger | null>(this.salesFile, null);
    if (savedSales && Array.isArray(savedSales.orders)) {
      this.ledger = savedSales;
    }
  }

  private savePlans(): void {
    atomicWriteJson(this.plansFile, this.plans);
  }

  private saveSales(): void {
    atomicWriteJson(this.salesFile, this.ledger);
  }

  public listPlans(): SalesPlan[] {
    return Object.values(this.plans).sort((a, b) => a.order - b.order);
  }

  public getPlan(planId: string): SalesPlan | undefined {
    return this.plans[planId];
  }

  public upsertPlan(input: Partial<SalesPlan> & { id?: string; name: string }): SalesPlan {
    const id =
      (input.id || input.name)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .slice(0, 32) || crypto.randomBytes(4).toString('hex');

    const existing = this.plans[id];
    const plan: SalesPlan = {
      id,
      name: input.name.trim().slice(0, 40),
      days: Math.max(1, Math.min(3650, Number(input.days) || existing?.days || 30)),
      volumeGb: Math.max(1, Math.min(100_000, Number(input.volumeGb) || existing?.volumeGb || 50)),
      speedMbps: Math.max(0, Math.min(10_000, Number(input.speedMbps ?? existing?.speedMbps ?? 50))),
      ipLimit: Math.max(0, Math.min(100, Number(input.ipLimit ?? existing?.ipLimit ?? 2))),
      stars: Math.max(1, Math.min(100_000, Number(input.stars) || existing?.stars || 99)),
      badge: (input.badge ?? existing?.badge ?? '').trim().slice(0, 32),
      featured: Boolean(input.featured ?? existing?.featured ?? false),
      order: Number(input.order ?? existing?.order ?? Object.keys(this.plans).length + 1),
    };

    this.plans[id] = plan;
    this.savePlans();
    stateStore.logActivity('sales', `Saved subscription plan "${plan.name}" (${plan.stars} Stars)`, 'ok');
    return plan;
  }

  public deletePlan(planId: string): boolean {
    if (!this.plans[planId]) return false;
    const name = this.plans[planId].name;
    delete this.plans[planId];
    this.savePlans();
    stateStore.logActivity('sales', `Deleted subscription plan "${name}"`, 'warn');
    return true;
  }

  public createInvoicePayload(planId: string, userId: string | number): string {
    return `ks|${planId}|${userId}|${crypto.randomBytes(5).toString('hex')}`;
  }

  public fulfillOrder(params: {
    userId: string;
    username?: string;
    planId: string;
    telegramChargeId?: string;
    protocol?: string;
    port?: number;
  }): { order: SalesOrder; service: ServiceRecord } {
    const plan = this.plans[params.planId];
    if (!plan) throw new Error('Unknown subscription plan');

    const cfg = resolveRuntimeConfig();
    const explicitProtocol = (params.protocol || '').trim().toLowerCase();
    const explicitPort = params.port !== undefined && params.port !== null && String(params.port) !== ''
      ? Number(params.port)
      : null;

    let resolvedProtocol: string | null = null;
    if (explicitProtocol) {
      if (!ACCEPTED_SALES_PROTOCOLS.includes(explicitProtocol as never)) {
        throw new Error(
          `Unsupported sales protocol "${explicitProtocol}". Accepted values: ${ACCEPTED_SALES_PROTOCOLS.join(', ')}.`
        );
      }
      resolvedProtocol = explicitProtocol;
    } else if (cfg.salesDefaultProtocol.invalid) {
      throw new Error(
        `SALES_DEFAULT_PROTOCOL "${cfg.salesDefaultProtocol.raw}" is invalid. Accepted values: ${ACCEPTED_SALES_PROTOCOLS.join(', ')}. See ENVIRONMENT_CONFIGURATION_GUIDE.md.`
      );
    } else {
      resolvedProtocol = cfg.salesDefaultProtocol.value;
    }

    let resolvedPort: number | null = null;
    if (explicitPort !== null) {
      if (!Number.isInteger(explicitPort) || explicitPort < 1 || explicitPort > 65535) {
        throw new Error('Sales port must be an integer between 1 and 65535.');
      }
      resolvedPort = explicitPort;
    } else if (cfg.salesDefaultPort.invalid) {
      throw new Error('SALES_DEFAULT_PORT is invalid (must be an integer between 1 and 65535). See ENVIRONMENT_CONFIGURATION_GUIDE.md.');
    } else {
      resolvedPort = cfg.salesDefaultPort.value;
    }

    const missing: string[] = [];
    if (!resolvedProtocol) missing.push('SALES_DEFAULT_PROTOCOL');
    if (!resolvedPort) missing.push('SALES_DEFAULT_PORT');
    if (missing.length > 0) {
      throw new Error(
        formatMissingConfigMessage({
          feature: 'Automated sales provisioning',
          missingVars: missing,
          reason:
            'Configure default sales protocol and port in your environment variables, or specify them explicitly when fulfilling an order manually.',
        })
      );
    }

    const expiresAt = new Date(Date.now() + plan.days * 86400_000).toISOString();
    const cleanUser = (params.username || '').trim().replace(/^@/, '');
    const label = `${plan.name}-${cleanUser || params.userId}`.slice(0, 60);

    const service = stateStore.createService({
      label,
      limitBytes: Math.floor(plan.volumeGb * 1024 ** 3),
      expiresAt,
      protocol: resolvedProtocol!,
      port: resolvedPort!,
      fingerprint: 'chrome',
      alpn: resolvedProtocol!.startsWith('xhttp') ? 'h2,http/1.1' : 'http/1.1',
      ipLimit: plan.ipLimit,
      speedLimitBytes: plan.speedMbps > 0 ? Math.floor((plan.speedMbps * 1024 * 1024) / 8) : 0,
      note: `Provisioned via ${plan.name} plan (${plan.stars} Stars)`,
    });

    const order: SalesOrder = {
      id: `ord_${crypto.randomBytes(6).toString('hex')}`,
      userId: String(params.userId),
      username: cleanUser,
      planId: plan.id,
      planName: plan.name,
      amountStars: plan.stars,
      telegramChargeId: params.telegramChargeId || '',
      serviceId: service.id,
      createdAt: new Date().toISOString(),
      expiresAt,
      status: 'paid',
    };

    this.ledger.orders.unshift(order);
    if (this.ledger.orders.length > 5000) this.ledger.orders.length = 5000;

    const existingCust = this.ledger.customers[order.userId] || {
      userId: order.userId,
      username: cleanUser,
      orders: 0,
      totalStars: 0,
    };
    existingCust.username = cleanUser || existingCust.username;
    existingCust.orders += 1;
    existingCust.totalStars += plan.stars;
    this.ledger.customers[order.userId] = existingCust;

    stateStore.bumpDailyStat('orders', 1);
    stateStore.bumpDailyStat('stars', plan.stars);
    stateStore.logActivity('sales', `Fulfilled ${plan.name} order for ${cleanUser || order.userId} (${plan.stars} Stars)`, 'ok');
    this.saveSales();

    return { order, service };
  }

  public getStats() {
    const paid = this.ledger.orders.filter((o) => o.status === 'paid');
    return {
      orders: paid.length,
      stars: paid.reduce((sum, o) => sum + o.amountStars, 0),
      customers: Object.keys(this.ledger.customers).length,
    };
  }
}

export const salesEngine = new SalesEngine();
