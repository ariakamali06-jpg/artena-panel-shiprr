import 'dotenv/config';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import { createApiRouter } from './server/routes/api';
import { attachWebSocketRelay, createRelayRouter, startTcpRelay, stopTcpRelay } from './server/engine/relays';
import { telegramBotService } from './server/telegram/botService';
import { stateStore } from './server/store/stateStore';
import { logStartupConfigSummary } from './server/config/envConfig';

const PORT = Number(process.env.PORT || 3000);
const IS_PROD = process.env.NODE_ENV === 'production';

async function bootstrap(): Promise<void> {
  logStartupConfigSummary(stateStore.state.settings);
  const app = express();
  app.set('trust proxy', true);
  app.disable('x-powered-by');

  // Mount streaming XHTTP relay before JSON body parser so binary streams aren't consumed
  app.use(createRelayRouter());

  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: false }));

  // Mount REST API & public subscription feed routes
  app.use(createApiRouter());

  // Frontend delivery: Vite dev middleware in development, built static bundle in production
  const distDir = path.resolve(process.cwd(), 'dist');
  if (!IS_PROD) {
    let createViteServer: any;
    try {
      ({ createServer: createViteServer } = await import('vite'));
    } catch {
      throw new Error('vite not installed - dev mode requires npm install (see package.source.json)');
    }
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else if (fs.existsSync(distDir)) {
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  // Global error handler (never leak internal stack traces)
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const msg = err instanceof Error ? err.message : 'Internal server error';
    stateStore.logError('http', msg);
    if (!res.headersSent) {
      res.status(500).json({ error: 'An unexpected server error occurred' });
    }
  });

  const server = http.createServer(app);
  attachWebSocketRelay(server);

  await startTcpRelay();

  if (stateStore.state.settings.botToken && stateStore.state.settings.botAutoStart) {
    void telegramBotService.start();
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[artena] Server listening on port ${PORT}`);
  });

  const shutdown = async () => {
    await telegramBotService.stop();
    await stopTcpRelay();
    stateStore.stopTimers();
    server.close(() => process.exit(0));
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

void bootstrap();
