/**
 * Conversation registry.
 *
 * Stores lightweight metadata (title + timestamps) for every conversation so
 * the UI can show a persistent sidebar list and reload past chats. The actual
 * message history lives in the LangGraph checkpointer (keyed by thread_id);
 * this table only tracks id/title/ordering.
 *
 * Two backends, chosen automatically at runtime (same rule as artifactStore):
 *   - Postgres (Prisma) when a real DATABASE_URL / CHECKPOINT_DATABASE_URL is set.
 *   - Local SQLite (better-sqlite3) otherwise — same SQLITE_PATH file as the
 *     checkpointer and artifact metadata.
 */
import type Database from 'better-sqlite3';
import { isDbConfigured } from './artifactStore';

export type ConversationRow = {
  id: string; // == thread_id
  userId: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
};

// ---------------------------------------------------------------------------
// Local SQLite backend (better-sqlite3)
// ---------------------------------------------------------------------------
const SQLITE_PATH = process.env.SQLITE_PATH || './data-agent.sqlite';
let _db: Database.Database | null = null;

function db(): Database.Database {
  if (_db) return _db;
  const BetterSqlite3 = require('better-sqlite3') as typeof Database;
  const conn = new BetterSqlite3(SQLITE_PATH);
  conn.pragma('journal_mode = WAL');
  conn.exec(`
    CREATE TABLE IF NOT EXISTS data_agent_conversations (
      id        TEXT PRIMARY KEY,
      userId    TEXT NOT NULL,
      title     TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_convos_user
      ON data_agent_conversations (userId, updatedAt DESC);
  `);
  _db = conn;
  return conn;
}

function rowFromSqlite(r: any): ConversationRow {
  return {
    id: r.id,
    userId: r.userId,
    title: r.title,
    createdAt: new Date(r.createdAt),
    updatedAt: new Date(r.updatedAt),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Truncate a first-message into a short, human-friendly conversation title. */
export function deriveTitle(message: string): string {
  const clean = (message || '').replace(/\s+/g, ' ').trim();
  if (!clean) return 'New conversation';
  return clean.length > 60 ? `${clean.slice(0, 57)}…` : clean;
}

/**
 * Insert a conversation on first message (with title), or just bump its
 * updatedAt on subsequent messages. The title is set ONCE (from the first
 * message) and never overwritten.
 */
export async function upsertConversation(input: {
  id: string;
  userId: string;
  title: string;
}): Promise<void> {
  const now = Date.now();
  if (isDbConfigured()) {
    const { prisma } = await import('../utils/prisma');
    await (prisma as any).dataAgentConversation.upsert({
      where: { id: input.id },
      create: {
        id: input.id,
        userId: input.userId,
        title: input.title,
        createdAt: new Date(now),
        updatedAt: new Date(now),
      },
      update: { updatedAt: new Date(now) },
    });
    return;
  }
  db()
    .prepare(
      `INSERT INTO data_agent_conversations (id, userId, title, createdAt, updatedAt)
       VALUES (@id, @userId, @title, @now, @now)
       ON CONFLICT(id) DO UPDATE SET updatedAt = @now`
    )
    .run({ id: input.id, userId: input.userId, title: input.title, now });
}

export async function listConversations(userId: string): Promise<ConversationRow[]> {
  if (isDbConfigured()) {
    const { prisma } = await import('../utils/prisma');
    return (await (prisma as any).dataAgentConversation.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
    })) as ConversationRow[];
  }
  const rows = db()
    .prepare(
      `SELECT * FROM data_agent_conversations WHERE userId = ? ORDER BY updatedAt DESC`
    )
    .all(userId);
  return rows.map(rowFromSqlite);
}

export async function deleteConversation(id: string): Promise<void> {
  if (isDbConfigured()) {
    const { prisma } = await import('../utils/prisma');
    await (prisma as any).dataAgentConversation
      .delete({ where: { id } })
      .catch(() => undefined); // ignore "not found"
    return;
  }
  db().prepare(`DELETE FROM data_agent_conversations WHERE id = ?`).run(id);
}
