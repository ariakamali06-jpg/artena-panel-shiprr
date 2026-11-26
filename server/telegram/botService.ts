import os from 'node:os';
import QRCode from 'qrcode';
import { stateStore } from '../store/stateStore';
import { salesEngine } from '../engine/salesEngine';
import {
  buildServiceUri,
  formatBytes,
  generateNameSuggestions,
  parseSizeToBytes,
  parseSpeedToBytes,
  protocolDisplayLabel,
  remainingTimeText,
} from '../engine/uriBuilder';
import { validateExternalHttpUrl } from '../engine/security';
import type { ServiceRecord } from '../types';

interface WizardSession {
  kind: 'create_service' | 'create_client' | 'create_group';
  step: string;
  parentUid?: string;
  data: Record<string, string | number | boolean>;
}

interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number };
    from?: { id: number; username?: string; first_name?: string };
    text?: string;
    successful_payment?: {
      invoice_payload: string;
      telegram_payment_charge_id: string;
      total_amount: number;
    };
  };
  callback_query?: {
    id: string;
    from: { id: number; username?: string };
    message?: { message_id: number; chat: { id: number } };
    data?: string;
  };
  pre_checkout_query?: {
    id: string;
    from: { id: number; username?: string };
    invoice_payload: string;
  };
}

class TelegramBotService {
  private running = false;
  private abortCtrl: AbortController | null = null;
  private pollOffset = 0;
  private alertTimer: ReturnType<typeof setInterval> | null = null;
  private wizards = new Map<number, WizardSession>();
  private lastAlertSent = new Map<string, number>();
  private lastError = '';
  private botInfo: { username?: string; id?: number } | null = null;

  public getStatus() {
    const s = stateStore.state.settings;
    return {
      running: this.running,
      configured: Boolean(s.botToken),
      username: this.botInfo?.username || s.botUsername || '',
      adminIds: this.parseAdminIds(),
      alertsEnabled: Boolean(s.alertsEnabled),
      lastError: this.lastError,
      miniAppUrl: this.getMiniAppUrl(),
    };
  }

  public parseAdminIds(): number[] {
    return String(stateStore.state.settings.botAdminIds || '')
      .split(/[,\s]+/)
      .map((x) => Number(x.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
  }

  private isAdmin(chatId: number): boolean {
    return this.parseAdminIds().includes(chatId);
  }

  private getBaseUrl(): string {
    return (stateStore.state.settings.publicBaseUrl || process.env.PUBLIC_BASE_URL || '')
      .trim()
      .replace(/\/+$/, '');
  }

  private getPublicHost(): string {
    const base = this.getBaseUrl();
    if (!base) return '';
    try {
      return new URL(base).hostname;
    } catch {
      return '';
    }
  }

  private getMiniAppUrl(): string {
    const base = this.getBaseUrl();
    return base ? `${base}/miniapp` : '';
  }

  private async apiCall<T = unknown>(method: string, payload?: Record<string, unknown>, timeoutMs = 35_000): Promise<T | null> {
    const token = stateStore.state.settings.botToken;
    if (!token) return null;
    try {
      const resp = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload ? JSON.stringify(payload) : undefined,
        signal: this.abortCtrl
          ? AbortSignal.any([this.abortCtrl.signal, AbortSignal.timeout(timeoutMs)])
          : AbortSignal.timeout(timeoutMs),
      });
      const json = (await resp.json()) as { ok: boolean; result?: T; description?: string };
      if (!json.ok) {
        this.lastError = json.description || `Telegram API error on ${method}`;
        return null;
      }
      return json.result ?? null;
    } catch (err) {
      if (this.running) {
        this.lastError = err instanceof Error ? err.message : String(err);
      }
      return null;
    }
  }

  private async sendPhotoBuffer(chatId: number, png: Buffer, caption: string, replyMarkup?: unknown): Promise<void> {
    const token = stateStore.state.settings.botToken;
    if (!token) return;
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('caption', caption.slice(0, 1020));
    form.append('parse_mode', 'HTML');
    if (replyMarkup) form.append('reply_markup', JSON.stringify(replyMarkup));
    form.append('photo', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'qrcode.png');

    await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(15_000),
    }).catch(() => {});
  }

  private async sendDocumentBuffer(chatId: number, filename: string, content: Buffer, caption: string): Promise<void> {
    const token = stateStore.state.settings.botToken;
    if (!token) return;
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('caption', caption);
    form.append('document', new Blob([new Uint8Array(content)], { type: 'application/json' }), filename);

    await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(15_000),
    }).catch(() => {});
  }

  private async send(chatId: number, text: string, replyMarkup?: unknown): Promise<void> {
    await this.apiCall('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }

  private async edit(chatId: number, messageId: number, text: string, replyMarkup?: unknown): Promise<void> {
    const res = await this.apiCall('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
    if (!res) {
      await this.send(chatId, text, replyMarkup);
    }
  }

  private esc(v: unknown): string {
    return String(v ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  public async start(): Promise<void> {
    if (this.running) return;
    const token = stateStore.state.settings.botToken.trim();
    if (!token) {
      this.lastError = 'Bot token is not configured';
      return;
    }

    this.running = true;
    this.lastError = '';
    this.abortCtrl = new AbortController();

    const me = await this.apiCall<{ id: number; username: string }>('getMe', undefined, 10_000);
    if (!me) {
      this.running = false;
      stateStore.logError('telegram-bot', this.lastError || 'Failed to authenticate Telegram bot token');
      return;
    }
    this.botInfo = me;
    stateStore.state.settings.botUsername = me.username;
    stateStore.scheduleSave();

    // Configure Mini App menu button when public HTTPS URL is set
    const miniApp = this.getMiniAppUrl();
    if (miniApp.startsWith('https://')) {
      await this.apiCall('setChatMenuButton', {
        menu_button: { type: 'web_app', text: 'Open Control', web_app: { url: miniApp } },
      });
    }

    stateStore.logActivity('bot', `Telegram bot @${me.username} started`, 'ok');
    this.startAlertLoop();
    void this.pollLoop();
  }

  public async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.abortCtrl?.abort();
    this.abortCtrl = null;
    if (this.alertTimer) {
      clearInterval(this.alertTimer);
      this.alertTimer = null;
    }
    stateStore.logActivity('bot', 'Telegram bot stopped', 'warn');
  }

  public async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      const updates = await this.apiCall<TgUpdate[]>(
        'getUpdates',
        { offset: this.pollOffset, timeout: 25, allowed_updates: ['message', 'callback_query', 'pre_checkout_query'] },
        35_000
      );
      if (!this.running) break;
      if (Array.isArray(updates)) {
        for (const u of updates) {
          this.pollOffset = Math.max(this.pollOffset, u.update_id + 1);
          try {
            await this.handleUpdate(u);
          } catch (err) {
            stateStore.logError('telegram-bot', err instanceof Error ? err.message : String(err));
          }
        }
      } else {
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  private startAlertLoop(): void {
    if (this.alertTimer) clearInterval(this.alertTimer);
    this.alertTimer = setInterval(() => {
      if (!this.running || !stateStore.state.settings.alertsEnabled) return;
      void this.checkAlerts();
    }, 60_000);
    this.alertTimer.unref?.();
  }

  private async checkAlerts(): Promise<void> {
    const admins = this.parseAdminIds();
    if (!admins.length) return;
    const now = Date.now();
    const cooldownMs = 60 * 60 * 1000;
    const alerts: string[] = [];

    const totalMem = os.totalmem();
    const memPct = totalMem > 0 ? ((totalMem - os.freemem()) / totalMem) * 100 : 0;
    if (memPct > 90 && now - (this.lastAlertSent.get('ram') || 0) > cooldownMs) {
      alerts.push(`High server memory utilization: <b>${memPct.toFixed(1)}%</b>`);
      this.lastAlertSent.set('ram', now);
    }

    for (const svc of Object.values(stateStore.state.services)) {
      if (!svc.active) continue;
      if (svc.limitBytes > 0 && svc.usedBytes / svc.limitBytes >= 0.9) {
        const key = `quota:${svc.id}`;
        if (now - (this.lastAlertSent.get(key) || 0) > cooldownMs) {
          alerts.push(`Service <b>${this.esc(svc.label)}</b> exceeded 90% of quota (${formatBytes(svc.usedBytes)} / ${formatBytes(svc.limitBytes)})`);
          this.lastAlertSent.set(key, now);
        }
      }
      if (svc.expiresAt) {
        const leftMs = Date.parse(svc.expiresAt) - now;
        if (leftMs > 0 && leftMs < 48 * 3600_000) {
          const key = `exp:${svc.id}`;
          if (now - (this.lastAlertSent.get(key) || 0) > cooldownMs) {
            alerts.push(`Service <b>${this.esc(svc.label)}</b> expires in ${remainingTimeText(svc.expiresAt)}`);
            this.lastAlertSent.set(key, now);
          }
        }
      }
    }

    if (alerts.length) {
      const msg = `<b>Artena System Alerts</b>\n\n${alerts.map((a) => `• ${a}`).join('\n')}`;
      for (const adminId of admins) {
        await this.send(adminId, msg);
      }
    }
  }

  // ── Keyboards & Cards ─────────────────────────────────────────────────────

  private mainMenuKeyboard() {
    const miniApp = this.getMiniAppUrl();
    const rows: Array<Array<Record<string, unknown>>> = [
      [
        { text: 'Quick Create', callback_data: 'quick' },
        { text: 'New Service Wizard', callback_data: 'newcfg' },
      ],
      [
        { text: 'Services', callback_data: 'list:0' },
        { text: 'Subscription Groups', callback_data: 'subs:0' },
      ],
      [
        { text: 'Online Now', callback_data: 'online' },
        { text: 'Top Usage', callback_data: 'top' },
        { text: 'Expiring', callback_data: 'expiring' },
      ],
      [
        { text: 'Server Health', callback_data: 'server' },
        { text: 'Stats', callback_data: 'stats' },
        { text: 'Backup JSON', callback_data: 'backup' },
      ],
      [
        {
          text: `Alerts: ${stateStore.state.settings.alertsEnabled ? 'ON' : 'OFF'}`,
          callback_data: 'alerts:toggle',
        },
        { text: 'Help', callback_data: 'help' },
      ],
    ];
    if (miniApp.startsWith('https://')) {
      rows.unshift([{ text: 'Open Artena Mini App', web_app: { url: miniApp } }]);
    }
    return { inline_keyboard: rows };
  }

  private quickCreateKeyboard() {
    return {
      inline_keyboard: [
        [
          { text: '30d · 50 GB (WS)', callback_data: 'qc:50:30:vless-ws' },
          { text: '30d · 100 GB (WS)', callback_data: 'qc:100:30:vless-ws' },
        ],
        [
          { text: '90d · 200 GB (XHTTP)', callback_data: 'qc:200:90:xhttp-packet-up' },
          { text: 'Unlimited · 30d (WS)', callback_data: 'qc:0:30:vless-ws' },
        ],
        [{ text: 'Back to Menu', callback_data: 'menu' }],
      ],
    };
  }

  private serviceDetailText(svc: ServiceRecord): string {
    const host = this.getPublicHost();
    const base = this.getBaseUrl();
    const uri = host
      ? buildServiceUri(svc, host, {
          settings: stateStore.state.settings,
          tcpPublicHost: stateStore.state.settings.tcpPublicHost || undefined,
          tcpPublicPort: Number(stateStore.state.settings.tcpPublicPort) || undefined,
        })
      : '';
    const subUrl = base ? `${base}/subscription/${svc.id}` : 'Pending PUBLIC_BASE_URL configuration (/seturl)';
    const online = stateStore.getOnlineIpCount(svc.id);
    return [
      `<b>${this.esc(svc.label)}</b>`,
      `Status: <b>${svc.active ? 'Active' : 'Paused'}</b> · Online IPs: <b>${online}</b>`,
      `Protocol: <code>${this.esc(protocolDisplayLabel(svc))}</code>`,
      `Usage: <b>${formatBytes(svc.usedBytes)}</b> / <b>${svc.limitBytes > 0 ? formatBytes(svc.limitBytes) : 'Unlimited'}</b>`,
      `Remaining: <b>${remainingTimeText(svc.expiresAt)}</b>`,
      svc.speedLimitBytes > 0 ? `Speed Cap: <b>${formatBytes(svc.speedLimitBytes)}/s</b>` : '',
      `\nPortal: ${this.esc(subUrl)}`,
      uri
        ? `\n<code>${this.esc(uri)}</code>`
        : `\n<i>Configure PUBLIC_BASE_URL (or run /seturl) to generate shareable client URIs.</i>`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  private serviceDetailKeyboard(svc: ServiceRecord) {
    return {
      inline_keyboard: [
        [
          { text: svc.active ? 'Pause' : 'Activate', callback_data: `toggle:${svc.id}` },
          { text: 'Send QR & URI', callback_data: `link:${svc.id}` },
        ],
        [
          { text: '+10 GB', callback_data: `ed:gb10:${svc.id}` },
          { text: '+30 Days', callback_data: `ed:d30:${svc.id}` },
          { text: 'Reset Usage', callback_data: `ed:reset:${svc.id}` },
        ],
        [
          { text: 'Clients', callback_data: `clients:${svc.id}:0` },
          { text: 'Group', callback_data: `cfggroup:${svc.id}` },
          { text: 'Delete', callback_data: `del:${svc.id}` },
        ],
        [{ text: 'Back to Services', callback_data: 'list:0' }],
      ],
    };
  }

  private async sendServiceCardWithQr(chatId: number, svc: ServiceRecord): Promise<void> {
    const host = this.getPublicHost();
    const uri = buildServiceUri(svc, host, { settings: stateStore.state.settings });
    try {
      const qrPng = await QRCode.toBuffer(uri, { width: 320, margin: 2 });
      await this.sendPhotoBuffer(chatId, qrPng, this.serviceDetailText(svc), this.serviceDetailKeyboard(svc));
    } catch {
      await this.send(chatId, this.serviceDetailText(svc), this.serviceDetailKeyboard(svc));
    }
  }

  private statsSummaryText(): string {
    const svcs = Object.values(stateStore.state.services);
    const active = svcs.filter((s) => s.active).length;
    const sales = salesEngine.getStats();
    return [
      '<b>Artena Panel Overview</b>',
      `Services: <b>${active}</b> active / <b>${svcs.length}</b> total`,
      `Groups: <b>${Object.keys(stateStore.state.subscriptions).length}</b>`,
      `Live Connections: <b>${stateStore.connections.size}</b>`,
      `Total Traffic: <b>${formatBytes(stateStore.state.stats.totalBytes)}</b>`,
      `Sales: <b>${sales.orders}</b> orders · <b>${sales.stars}</b> Stars`,
    ].join('\n');
  }

  private serverHealthText(): string {
    const totalMem = os.totalmem();
    const usedMem = totalMem - os.freemem();
    const memPct = totalMem > 0 ? ((usedMem / totalMem) * 100).toFixed(1) : '0';
    const load = os.loadavg()[0]?.toFixed(2) || '0.00';
    const upSec = Math.floor((Date.now() - stateStore.startedAt) / 1000);
    const hours = Math.floor(upSec / 3600);
    const mins = Math.floor((upSec % 3600) / 60);
    return [
      '<b>Server Health</b>',
      `Memory: <b>${formatBytes(usedMem)} / ${formatBytes(totalMem)} (${memPct}%)</b>`,
      `CPU Load (1m): <b>${load}</b> (${os.cpus().length} cores)`,
      `Uptime: <b>${hours}h ${mins}m</b>`,
      `Public URL: <code>${this.esc(this.getBaseUrl())}</code>`,
    ].join('\n');
  }

  // ── Update Dispatcher ─────────────────────────────────────────────────────

  private async handleUpdate(u: TgUpdate): Promise<void> {
    if (u.pre_checkout_query) {
      await this.apiCall('answerPreCheckoutQuery', {
        pre_checkout_query_id: u.pre_checkout_query.id,
        ok: true,
      });
      return;
    }

    if (u.message?.successful_payment) {
      const sp = u.message.successful_payment;
      const parts = sp.invoice_payload.split('|');
      const planId = parts[1];
      if (planId && u.message.from) {
        const { service } = salesEngine.fulfillOrder({
          userId: String(u.message.from.id),
          username: u.message.from.username,
          planId,
          telegramChargeId: sp.telegram_payment_charge_id,
        });
        const intro = stateStore.state.settings.botTexts.purchase_success || 'Your subscription is active!';
        await this.send(u.message.chat.id, `<b>${this.esc(intro)}</b>`);
        await this.sendServiceCardWithQr(u.message.chat.id, service);
      }
      return;
    }

    if (u.callback_query) {
      await this.handleCallback(u.callback_query);
      return;
    }

    if (u.message) {
      await this.handleMessage(u.message);
    }
  }

  private async handleMessage(msg: NonNullable<TgUpdate['message']>): Promise<void> {
    const chatId = msg.chat.id;
    const text = (msg.text || '').trim();
    if (!text) return;

    const parts = text.split(/\s+/);
    const cmd = parts[0].toLowerCase().split('@')[0];
    const args = parts.slice(1);

    if (cmd === '/id') {
      await this.send(chatId, `Your Telegram Chat ID: <code>${chatId}</code>`);
      return;
    }

    // Customer flow for non-admins
    if (!this.isAdmin(chatId)) {
      const plans = salesEngine.listPlans();
      const welcome = stateStore.state.settings.botTexts.welcome_customer || 'Choose a subscription plan:';
      const rows = plans.map((p) => [
        {
          text: `${p.name} · ${p.volumeGb} GB · ${p.days}d — ${p.stars} ⭐`,
          callback_data: `buy:${p.id}`,
        },
      ]);
      await this.send(chatId, `<b>${this.esc(welcome)}</b>`, { inline_keyboard: rows });
      return;
    }

    if (cmd === '/cancel') {
      this.wizards.delete(chatId);
      await this.send(chatId, 'Operation cancelled.', this.mainMenuKeyboard());
      return;
    }

    // Active wizard text capture
    const wiz = this.wizards.get(chatId);
    if (wiz && !text.startsWith('/')) {
      await this.handleWizardInput(chatId, wiz, text);
      return;
    }

    if (cmd === '/start' || cmd === '/admin' || cmd === '/menu') {
      const welcome = stateStore.state.settings.botTexts.welcome_admin || 'Artena Panel Bot';
      await this.send(chatId, `<b>${this.esc(welcome)}</b>\n\n${this.statsSummaryText()}`, this.mainMenuKeyboard());
      return;
    }

    if (cmd === '/help') {
      await this.send(
        chatId,
        this.esc(stateStore.state.settings.botTexts.help_text || ''),
        this.mainMenuKeyboard()
      );
      return;
    }

    if (cmd === '/new' || cmd === '/quick') {
      await this.send(chatId, '<b>Quick Provision Service</b>\nSelect a preset:', this.quickCreateKeyboard());
      return;
    }

    if (cmd === '/server') {
      await this.send(chatId, this.serverHealthText(), this.mainMenuKeyboard());
      return;
    }

    if (cmd === '/backup') {
      const buf = Buffer.from(JSON.stringify(stateStore.state, null, 2), 'utf8');
      await this.sendDocumentBuffer(chatId, `artena-backup-${stateStore.todayKey()}.json`, buf, 'Artena Panel state backup');
      return;
    }

    if (cmd === '/online') {
      const conns = Array.from(stateStore.connections.values());
      const body = conns.length
        ? conns.slice(0, 20).map((c) => `• <b>${this.esc(c.label)}</b> · ${this.esc(c.ip)} · ${c.transport} · ${formatBytes(c.bytes)}`).join('\n')
        : 'No active connections right now.';
      await this.send(chatId, `<b>Live Connections (${conns.length})</b>\n${body}`, this.mainMenuKeyboard());
      return;
    }

    if (cmd === '/top') {
      const top = Object.values(stateStore.state.services)
        .sort((a, b) => b.usedBytes - a.usedBytes)
        .slice(0, 10);
      const body = top.map((s, i) => `${i + 1}. <b>${this.esc(s.label)}</b> — ${formatBytes(s.usedBytes)}`).join('\n') || 'No services yet.';
      await this.send(chatId, `<b>Top Traffic Services</b>\n${body}`, this.mainMenuKeyboard());
      return;
    }

    if (cmd === '/expiring') {
      const now = Date.now();
      const soon = Object.values(stateStore.state.services)
        .filter((s) => s.active && s.expiresAt && Date.parse(s.expiresAt) - now < 5 * 86400_000)
        .slice(0, 12);
      const body = soon.map((s) => `• <b>${this.esc(s.label)}</b> — ${remainingTimeText(s.expiresAt)}`).join('\n') || 'No services expiring within 5 days.';
      await this.send(chatId, `<b>Expiring Soon</b>\n${body}`, this.mainMenuKeyboard());
      return;
    }

    if (cmd === '/seturl') {
      const raw = args[0] || '';
      const valid = validateExternalHttpUrl(raw);
      if (!valid.ok) {
        await this.send(chatId, `Invalid URL: ${this.esc(valid.error)}\nUsage: <code>/seturl https://panel.example.com</code>`);
        return;
      }
      stateStore.state.settings.publicBaseUrl = valid.origin;
      stateStore.saveNow();
      await this.send(chatId, `Public base URL updated to <code>${this.esc(valid.origin)}</code>`);
      return;
    }

    if (cmd === '/bulk') {
      const count = Math.max(1, Math.min(20, Number(args[0]) || 0));
      const gb = Math.max(0, Number(args[1]) || 0);
      const days = Math.max(0, Number(args[2]) || 0);
      if (!count) {
        await this.send(chatId, 'Usage: <code>/bulk &lt;count 1-20&gt; &lt;gb&gt; &lt;days&gt;</code>');
        return;
      }
      const created: string[] = [];
      const host = this.getPublicHost();
      for (let i = 0; i < count; i++) {
        const svc = stateStore.createService({
          label: `Bulk-${i + 1}-${Date.now().toString(36).slice(-4)}`,
          limitBytes: gb > 0 ? parseSizeToBytes(gb, 'GB') : 0,
          expiresAt: days > 0 ? new Date(Date.now() + days * 86400_000).toISOString() : null,
          protocol: 'vless-ws',
        });
        created.push(`${svc.label}: ${buildServiceUri(svc, host, { settings: stateStore.state.settings })}`);
      }
      await this.send(chatId, `<b>Created ${count} services</b>\n\n<code>${this.esc(created.join('\n').slice(0, 3600))}</code>`);
      return;
    }

    if (cmd === '/alerts') {
      stateStore.state.settings.alertsEnabled = !stateStore.state.settings.alertsEnabled;
      stateStore.saveNow();
      await this.send(chatId, `System alerts are now <b>${stateStore.state.settings.alertsEnabled ? 'ENABLED' : 'DISABLED'}</b>.`);
      return;
    }

    // Search via /find or plain text
    const query = cmd === '/find' ? args.join(' ').toLowerCase() : text.toLowerCase();
    if (query.length >= 2) {
      const matches = Object.values(stateStore.state.services)
        .filter((s) => s.label.toLowerCase().includes(query) || s.id.toLowerCase().includes(query))
        .slice(0, 8);
      if (!matches.length) {
        await this.send(chatId, `No services matched "${this.esc(query)}".`);
        return;
      }
      const kb = {
        inline_keyboard: [
          ...matches.map((s) => [{ text: `${s.active ? '●' : '○'} ${s.label}`, callback_data: `view:${s.id}` }]),
          [{ text: 'Main Menu', callback_data: 'menu' }],
        ],
      };
      await this.send(chatId, `<b>Search results (${matches.length})</b>`, kb);
    }
  }

  private async handleWizardInput(chatId: number, wiz: WizardSession, text: string): Promise<void> {
    if (wiz.kind === 'create_group') {
      const group = stateStore.createSubscriptionGroup({ name: text });
      this.wizards.delete(chatId);
      await this.send(chatId, `Created group <b>${this.esc(group.name)}</b>\nPortal: ${this.esc(this.getBaseUrl())}/p/${group.uuidKey}`, this.mainMenuKeyboard());
      return;
    }

    if (wiz.kind === 'create_client' && wiz.parentUid) {
      const parent = stateStore.state.services[wiz.parentUid];
      if (!parent) {
        this.wizards.delete(chatId);
        await this.send(chatId, 'Parent service not found.');
        return;
      }
      if (wiz.step === 'label') {
        wiz.data.label = text;
        wiz.step = 'volume';
        await this.send(chatId, 'Enter quota in GB (or 0 for unlimited):');
        return;
      }
      if (wiz.step === 'volume') {
        wiz.data.gb = Math.max(0, Number(text) || 0);
        wiz.step = 'days';
        await this.send(chatId, 'Enter validity in days (or 0 for no expiry):');
        return;
      }
      if (wiz.step === 'days') {
        const days = Math.max(0, Number(text) || 0);
        const child = stateStore.createService({
          label: String(wiz.data.label || `${parent.label}-client`),
          parentInboundId: parent.id,
          protocol: parent.protocol,
          port: parent.port,
          fingerprint: parent.fingerprint,
          alpn: parent.alpn,
          outboundProxyId: parent.outboundProxyId,
          limitBytes: Number(wiz.data.gb) > 0 ? parseSizeToBytes(Number(wiz.data.gb), 'GB') : parent.limitBytes,
          expiresAt: days > 0 ? new Date(Date.now() + days * 86400_000).toISOString() : parent.expiresAt,
        });
        this.wizards.delete(chatId);
        await this.sendServiceCardWithQr(chatId, child);
      }
      return;
    }

    if (wiz.kind === 'create_service') {
      if (wiz.step === 'label') {
        wiz.data.label = text;
        wiz.step = 'volume';
        await this.send(chatId, 'Enter traffic quota in GB (0 for unlimited):');
        return;
      }
      if (wiz.step === 'volume') {
        wiz.data.gb = Math.max(0, Number(text) || 0);
        wiz.step = 'days';
        await this.send(chatId, 'Enter expiry in days (0 for no expiry):');
        return;
      }
      if (wiz.step === 'days') {
        wiz.data.days = Math.max(0, Number(text) || 0);
        wiz.step = 'speed';
        await this.send(chatId, 'Enter speed limit in Mbps (0 for unlimited):');
        return;
      }
      if (wiz.step === 'speed') {
        const mbps = Math.max(0, Number(text) || 0);
        const svc = stateStore.createService({
          label: String(wiz.data.label || generateNameSuggestions('', 1)[0]),
          protocol: String(wiz.data.protocol || 'vless-ws'),
          limitBytes: Number(wiz.data.gb) > 0 ? parseSizeToBytes(Number(wiz.data.gb), 'GB') : 0,
          expiresAt: Number(wiz.data.days) > 0 ? new Date(Date.now() + Number(wiz.data.days) * 86400_000).toISOString() : null,
          speedLimitBytes: mbps > 0 ? parseSpeedToBytes(mbps, 'Mbps') : 0,
        });
        this.wizards.delete(chatId);
        await this.sendServiceCardWithQr(chatId, svc);
      }
    }
  }

  private async handleCallback(cb: NonNullable<TgUpdate['callback_query']>): Promise<void> {
    const data = cb.data || '';
    const chatId = cb.message?.chat.id ?? cb.from.id;
    const messageId = cb.message?.message_id;

    await this.apiCall('answerCallbackQuery', { callback_query_id: cb.id });

    // Customer plan purchase
    if (data.startsWith('buy:')) {
      const planId = data.slice(4);
      const plan = salesEngine.getPlan(planId);
      if (!plan) return;
      await this.apiCall('sendInvoice', {
        chat_id: chatId,
        title: `Artena ${plan.name}`,
        description: `${plan.volumeGb} GB · ${plan.days} days · ${plan.speedMbps || 'Unlimited'} Mbps · ${plan.ipLimit} IP(s)`,
        payload: salesEngine.createInvoicePayload(plan.id, cb.from.id),
        currency: 'XTR',
        prices: [{ label: plan.name, amount: plan.stars }],
      });
      return;
    }

    if (!this.isAdmin(chatId)) return;

    const reply = (text: string, kb?: unknown) =>
      messageId ? this.edit(chatId, messageId, text, kb) : this.send(chatId, text, kb);

    if (data === 'menu') {
      await reply(this.statsSummaryText(), this.mainMenuKeyboard());
      return;
    }

    if (data === 'stats') {
      await reply(this.statsSummaryText(), this.mainMenuKeyboard());
      return;
    }

    if (data === 'server') {
      await reply(this.serverHealthText(), this.mainMenuKeyboard());
      return;
    }

    if (data === 'help') {
      await reply(this.esc(stateStore.state.settings.botTexts.help_text || ''), this.mainMenuKeyboard());
      return;
    }

    if (data === 'quick') {
      await reply('<b>Quick Provision</b>\nChoose a preset:', this.quickCreateKeyboard());
      return;
    }

    if (data.startsWith('qc:')) {
      const [, gbStr, daysStr, proto] = data.split(':');
      const gb = Number(gbStr) || 0;
      const days = Number(daysStr) || 0;
      const svc = stateStore.createService({
        label: generateNameSuggestions('', 1)[0],
        protocol: proto || 'vless-ws',
        limitBytes: gb > 0 ? parseSizeToBytes(gb, 'GB') : 0,
        expiresAt: days > 0 ? new Date(Date.now() + days * 86400_000).toISOString() : null,
      });
      await this.sendServiceCardWithQr(chatId, svc);
      return;
    }

    if (data === 'newcfg') {
      this.wizards.set(chatId, { kind: 'create_service', step: 'protocol', data: {} });
      await reply('<b>New Service Wizard</b>\nSelect protocol:', {
        inline_keyboard: [
          [
            { text: 'VLESS · WS', callback_data: 'w:proto:vless-ws' },
            { text: 'VLESS · TCP', callback_data: 'w:proto:vless-tcp' },
          ],
          [
            { text: 'XHTTP Packet-Up', callback_data: 'w:proto:xhttp-packet-up' },
            { text: 'XHTTP Stream-Up', callback_data: 'w:proto:xhttp-stream-up' },
          ],
          [{ text: 'Cancel', callback_data: 'w:cancel' }],
        ],
      });
      return;
    }

    if (data === 'w:cancel') {
      this.wizards.delete(chatId);
      await reply('Wizard cancelled.', this.mainMenuKeyboard());
      return;
    }

    if (data.startsWith('w:proto:')) {
      const proto = data.slice(8);
      this.wizards.set(chatId, { kind: 'create_service', step: 'label', data: { protocol: proto } });
      await reply(`Protocol: <b>${this.esc(proto)}</b>\nSend a name for this service (or /cancel):`);
      return;
    }

    if (data.startsWith('list:')) {
      const page = Math.max(0, Number(data.slice(5)) || 0);
      const all = Object.values(stateStore.state.services).sort((a, b) => a.label.localeCompare(b.label));
      const perPage = 8;
      const slice = all.slice(page * perPage, (page + 1) * perPage);
      const rows: Array<Array<Record<string, unknown>>> = slice.map((s) => [
        { text: `${s.active ? '●' : '○'} ${s.label} (${formatBytes(s.usedBytes)})`, callback_data: `view:${s.id}` },
      ]);
      const nav: Array<Record<string, unknown>> = [];
      if (page > 0) nav.push({ text: 'Prev', callback_data: `list:${page - 1}` });
      if ((page + 1) * perPage < all.length) nav.push({ text: 'Next', callback_data: `list:${page + 1}` });
      if (nav.length) rows.push(nav);
      rows.push([{ text: 'Main Menu', callback_data: 'menu' }]);
      await reply(`<b>Services (${all.length}) — Page ${page + 1}</b>`, { inline_keyboard: rows });
      return;
    }

    if (data.startsWith('view:')) {
      const svc = stateStore.state.services[data.slice(5)];
      if (!svc) return;
      await reply(this.serviceDetailText(svc), this.serviceDetailKeyboard(svc));
      return;
    }

    if (data.startsWith('link:')) {
      const svc = stateStore.state.services[data.slice(5)];
      if (!svc) return;
      await this.sendServiceCardWithQr(chatId, svc);
      return;
    }

    if (data.startsWith('toggle:')) {
      const svc = stateStore.state.services[data.slice(7)];
      if (!svc) return;
      svc.active = !svc.active;
      stateStore.saveNow();
      await reply(this.serviceDetailText(svc), this.serviceDetailKeyboard(svc));
      return;
    }

    if (data.startsWith('ed:')) {
      const [, op, uid] = data.split(':');
      const svc = stateStore.state.services[uid];
      if (!svc) return;
      if (op === 'gb10' && svc.limitBytes > 0) {
        svc.limitBytes += parseSizeToBytes(10, 'GB');
      } else if (op === 'd30') {
        const baseMs = svc.expiresAt ? Math.max(Date.now(), Date.parse(svc.expiresAt)) : Date.now();
        svc.expiresAt = new Date(baseMs + 30 * 86400_000).toISOString();
      } else if (op === 'reset') {
        svc.usedBytes = 0;
      }
      stateStore.saveNow();
      await reply(this.serviceDetailText(svc), this.serviceDetailKeyboard(svc));
      return;
    }

    if (data.startsWith('del:')) {
      const uid = data.slice(4);
      const svc = stateStore.state.services[uid];
      if (!svc) return;
      await reply(`Confirm deleting <b>${this.esc(svc.label)}</b>?`, {
        inline_keyboard: [
          [
            { text: 'Confirm Delete', callback_data: `delok:${uid}` },
            { text: 'Cancel', callback_data: `view:${uid}` },
          ],
        ],
      });
      return;
    }

    if (data.startsWith('delok:')) {
      stateStore.removeService(data.slice(6));
      await reply('Service deleted.', this.mainMenuKeyboard());
      return;
    }

    if (data.startsWith('clients:')) {
      const [, parentUid] = data.split(':');
      const children = Object.values(stateStore.state.services).filter((s) => s.parentInboundId === parentUid);
      const rows: Array<Array<Record<string, unknown>>> = children.slice(0, 10).map((c) => [
        { text: `${c.active ? '●' : '○'} ${c.label}`, callback_data: `view:${c.id}` },
      ]);
      rows.push([{ text: 'Add Child Client', callback_data: `addclient:${parentUid}` }]);
      rows.push([{ text: 'Back', callback_data: `view:${parentUid}` }]);
      await reply(`<b>Child Clients (${children.length})</b>`, { inline_keyboard: rows });
      return;
    }

    if (data.startsWith('addclient:')) {
      const parentUid = data.slice(10);
      this.wizards.set(chatId, { kind: 'create_client', step: 'label', parentUid, data: {} });
      await reply('Send a label for the new child client (or /cancel):');
      return;
    }

    if (data.startsWith('subs:')) {
      const subs = Object.values(stateStore.state.subscriptions);
      const rows: Array<Array<Record<string, unknown>>> = subs.slice(0, 10).map((g) => [
        { text: `${g.name} (${g.linkIds.length} links)`, callback_data: `subview:${g.id}` },
      ]);
      rows.push([{ text: 'New Group', callback_data: 'newsub' }]);
      rows.push([{ text: 'Main Menu', callback_data: 'menu' }]);
      await reply(`<b>Subscription Groups (${subs.length})</b>`, { inline_keyboard: rows });
      return;
    }

    if (data === 'newsub') {
      this.wizards.set(chatId, { kind: 'create_group', step: 'name', data: {} });
      await reply('Send a name for the new subscription group (or /cancel):');
      return;
    }

    if (data.startsWith('subview:')) {
      const sub = stateStore.state.subscriptions[data.slice(8)];
      if (!sub) return;
      const url = `${this.getBaseUrl()}/p/${sub.uuidKey}`;
      await reply(
        `<b>${this.esc(sub.name)}</b>\nServices: <b>${sub.linkIds.length}</b>\nPortal: ${this.esc(url)}`,
        {
          inline_keyboard: [
            [{ text: 'Delete Group', callback_data: `subdelok:${sub.id}` }],
            [{ text: 'Back to Groups', callback_data: 'subs:0' }],
          ],
        }
      );
      return;
    }

    if (data.startsWith('subdelok:')) {
      stateStore.removeSubscriptionGroup(data.slice(9));
      await reply('Subscription group removed.', this.mainMenuKeyboard());
      return;
    }

    if (data.startsWith('cfggroup:')) {
      const uid = data.slice(9);
      const subs = Object.values(stateStore.state.subscriptions);
      const rows = subs.slice(0, 8).map((g) => [
        { text: `Assign to ${g.name}`, callback_data: `cfgaddgroup:${uid}:${g.id}` },
      ]);
      rows.push([{ text: 'Remove from Group', callback_data: `cfgungroup:${uid}` }]);
      rows.push([{ text: 'Back', callback_data: `view:${uid}` }]);
      await reply('Select target subscription group:', { inline_keyboard: rows });
      return;
    }

    if (data.startsWith('cfgaddgroup:')) {
      const [, uid, gid] = data.split(':');
      stateStore.setServiceSubscription(uid, gid);
      const svc = stateStore.state.services[uid];
      if (svc) await reply(this.serviceDetailText(svc), this.serviceDetailKeyboard(svc));
      return;
    }

    if (data.startsWith('cfgungroup:')) {
      const uid = data.slice(11);
      stateStore.setServiceSubscription(uid, null);
      const svc = stateStore.state.services[uid];
      if (svc) await reply(this.serviceDetailText(svc), this.serviceDetailKeyboard(svc));
      return;
    }

    if (data === 'alerts:toggle') {
      stateStore.state.settings.alertsEnabled = !stateStore.state.settings.alertsEnabled;
      stateStore.saveNow();
      await reply(this.statsSummaryText(), this.mainMenuKeyboard());
      return;
    }

    if (data === 'backup') {
      const buf = Buffer.from(JSON.stringify(stateStore.state, null, 2), 'utf8');
      await this.sendDocumentBuffer(chatId, `artena-backup-${stateStore.todayKey()}.json`, buf, 'Artena Panel state backup');
      return;
    }

    if (data === 'online') {
      const conns = Array.from(stateStore.connections.values());
      const body = conns.length
        ? conns.slice(0, 15).map((c) => `• <b>${this.esc(c.label)}</b> (${this.esc(c.ip)}) — ${formatBytes(c.bytes)}`).join('\n')
        : 'No active connections.';
      await reply(`<b>Live Connections (${conns.length})</b>\n${body}`, this.mainMenuKeyboard());
      return;
    }

    if (data === 'top') {
      const top = Object.values(stateStore.state.services)
        .sort((a, b) => b.usedBytes - a.usedBytes)
        .slice(0, 10);
      const body = top.map((s, i) => `${i + 1}. <b>${this.esc(s.label)}</b> — ${formatBytes(s.usedBytes)}`).join('\n') || 'None';
      await reply(`<b>Top Traffic</b>\n${body}`, this.mainMenuKeyboard());
      return;
    }

    if (data === 'expiring') {
      const now = Date.now();
      const soon = Object.values(stateStore.state.services)
        .filter((s) => s.active && s.expiresAt && Date.parse(s.expiresAt) - now < 5 * 86400_000)
        .slice(0, 10);
      const body = soon.map((s) => `• <b>${this.esc(s.label)}</b> — ${remainingTimeText(s.expiresAt)}`).join('\n') || 'None';
      await reply(`<b>Expiring Soon</b>\n${body}`, this.mainMenuKeyboard());
    }
  }
}

export const telegramBotService = new TelegramBotService();
