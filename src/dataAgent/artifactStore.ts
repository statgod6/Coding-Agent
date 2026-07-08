/**
 * Artifact store abstraction.
 *
 * Two backends, chosen automatically at runtime:
 *   - Postgres (Prisma) when a real DATABASE_URL / CHECKPOINT_DATABASE_URL is set.
 *   - Local SQLite (better-sqlite3) otherwise — no cloud, no server. Metadata is
 *     stored in the same SQLITE_PATH file the LangGraph checkpointer uses.
 *
 * Either way, artifact *files* live on local disk; only their metadata is
 * stored here.
 */
import crypto from 'crypto';
import type Database from 'better-sqlite3';

export type ArtifactRow = {
  id: string;
  threadId: string;
  userId: string;
  filename: string;
  kind: string;
  label: string;
  localPath: string;
  sandboxPath: string | null;
  sizeBytes: number;
  createdAt: Date;
};

export type ArtifactInput = {
  threadId: string;
  userId: string;
  filename: string;
  kind: string;
  label: string;
  localPath: string;
  sandboxPath: string | null;
  sizeBytes: number;
};

/**
 * A connection URL is considered "real" when it is non-empty AND does not
 * contain a '<' (our .env template uses <project-ref>, <password>, <region>
 * placeholders — real Postgres URLs never contain angle brackets).
 */
export function isDbConfigured(): boolean {
  const url =
    process.env.CHECKPOINT_DATABASE_URL || process.env.DATABASE_URL || '';
  return url.length > 0 && !url.includes('<');
}

// ---------------------------------------------------------------------------
// Local SQLite backend (better-sqlite3)
// ---------------------------------------------------------------------------
const SQLITE_PATH = process.env.SQLITE_PATH || './data-agent.sqlite';
let _db: Database.Database | null = null;

function db(): Database.Database {
  if (_db) return _db;
  // Lazy require so no SQLite file is opened when running in Postgres mode.
  const BetterSqlite3 = require('better-sqlite3') as typeof Database;
  const conn = new BetterSqlite3(SQLITE_PATH);
  conn.pragma('journal_mode = WAL');
  conn.exec(`
    CREATE TABLE IF NOT EXISTS data_agent_artifacts (
      id          TEXT PRIMARY KEY,
      threadId    TEXT NOT NULL,
      userId      TEXT NOT NULL,
      filename    TEXT NOT NULL,
      kind        TEXT NOT NULL,
      label       TEXT NOT NULL,
      localPath   TEXT NOT NULL,
      sandboxPath TEXT,
      sizeBytes   INTEGER NOT NULL,
      createdAt   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_artifacts_thread
      ON data_agent_artifacts (threadId, createdAt DESC);
  `);
  _db = conn;
  return conn;
}

function rowFromSqlite(r: any): ArtifactRow {
  return {
    id: r.id,
    threadId: r.threadId,
    userId: r.userId,
    filename: r.filename,
    kind: r.kind,
    label: r.label,
    localPath: r.localPath,
    sandboxPath: r.sandboxPath ?? null,
    sizeBytes: r.sizeBytes,
    createdAt: new Date(r.createdAt),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export async function createArtifact(input: ArtifactInput): Promise<ArtifactRow> {
  if (isDbConfigured()) {
    const { prisma } = await import('../utils/prisma');
    return (await (prisma as any).dataAgentArtifact.create({ data: input })) as ArtifactRow;
  }
  const row: ArtifactRow = {
    id: crypto.randomUUID(),
    createdAt: new Date(),
    ...input,
  };
  db()
    .prepare(
      `INSERT INTO data_agent_artifacts
        (id, threadId, userId, filename, kind, label, localPath, sandboxPath, sizeBytes, createdAt)
       VALUES
        (@id, @threadId, @userId, @filename, @kind, @label, @localPath, @sandboxPath, @sizeBytes, @createdAt)`
    )
    .run({ ...row, createdAt: row.createdAt.getTime() });
  return row;
}

export async function getArtifact(id: string): Promise<ArtifactRow | null> {
  if (isDbConfigured()) {
    const { prisma } = await import('../utils/prisma');
    return (await (prisma as any).dataAgentArtifact.findUnique({
      where: { id },
    })) as ArtifactRow | null;
  }
  const r = db()
    .prepare(`SELECT * FROM data_agent_artifacts WHERE id = ?`)
    .get(id);
  return r ? rowFromSqlite(r) : null;
}

export async function listByThread(threadId: string): Promise<ArtifactRow[]> {
  if (isDbConfigured()) {
    const { prisma } = await import('../utils/prisma');
    return (await (prisma as any).dataAgentArtifact.findMany({
      where: { threadId },
      orderBy: { createdAt: 'desc' },
    })) as ArtifactRow[];
  }
  const rows = db()
    .prepare(
      `SELECT * FROM data_agent_artifacts WHERE threadId = ? ORDER BY createdAt DESC`
    )
    .all(threadId);
  return rows.map(rowFromSqlite);
}
