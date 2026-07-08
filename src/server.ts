/**
 * Data Agent backend HTTP server.
 *
 * Wires the Data Agent router into an Express app, with CORS + JSON parsing,
 * a health check, and graceful shutdown that tears down sandboxes and the
 * shared Postgres checkpointer.
 */
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';

import { dataAgentRouter } from './dataAgent/routes';
import { shutdownAgent } from './dataAgent/graph';
import { sandboxManager } from './dataAgent/sandboxManager';
import { isDbConfigured } from './dataAgent/artifactStore';

const app = express();

const corsOrigin = process.env.CORS_ORIGIN || '*';
app.use(
  cors({
    origin: corsOrigin === '*' ? true : corsOrigin.split(',').map((s) => s.trim()),
    credentials: true,
  })
);
app.use(express.json({ limit: '5mb' }));

// Serve the minimal web UI (settings + chat) from /public.
app.use(express.static(path.resolve(process.cwd(), 'public')));

// Health check.
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'data-agent-backend', time: new Date().toISOString() });
});

// Data Agent API.
app.use('/api/data-agent', dataAgentRouter);

const PORT = Number(process.env.PORT || 8080);
const server = app.listen(PORT, () => {
  console.log(`[data-agent] listening on http://localhost:${PORT}`);
});

// ---------------------------------------------------------------------------
// Graceful shutdown.
// ---------------------------------------------------------------------------
let shuttingDown = false;
async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[data-agent] received ${signal}, shutting down...`);

  // Release port 8080 IMMEDIATELY so a hot-reload restart can rebind without
  // EADDRINUSE. closeAllConnections() drops keep-alive/SSE sockets that would
  // otherwise keep the listener open; server.close() then frees the port.
  try {
    (server as any).closeAllConnections?.();
  } catch {
    /* best-effort */
  }
  server.close();

  // Hard safety net: if any async cleanup hangs (e.g. a slow E2B kill over the
  // network), force-exit so we never linger holding the port.
  const hardExit = setTimeout(() => process.exit(0), 2000);
  hardExit.unref?.();

  try {
    await sandboxManager.shutdown();
  } catch (e) {
    console.error('[data-agent] sandbox shutdown error', e);
  }
  try {
    await shutdownAgent();
  } catch (e) {
    console.error('[data-agent] checkpointer shutdown error', e);
  }
  // Only touch Prisma when a real database is configured. In local SQLite mode
  // Prisma is never imported, so students don't need `prisma generate` and the
  // server can't crash on a missing generated client.
  try {
    if (isDbConfigured()) {
      const { prisma } = await import('./utils/prisma');
      await prisma.$disconnect();
    }
  } catch (e) {
    console.error('[data-agent] prisma disconnect error', e);
  }
  clearTimeout(hardExit);
  process.exit(0);
}

process.on('SIGINT', () => void gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
