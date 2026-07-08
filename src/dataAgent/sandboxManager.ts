/**
 * Per-thread E2B sandbox pool with warm reuse and idle eviction.
 *
 * Each chat thread gets its own long-lived Python process so variables,
 * dataframes and imports persist across tool calls within the conversation.
 * Sandboxes are killed after 30 minutes of inactivity.
 */
import { Sandbox } from '@e2b/code-interpreter';

export const UPLOADS_DIR_IN_SANDBOX = '/home/user/uploads';
export const ARTIFACTS_DIR_IN_SANDBOX = '/home/user/artifacts';

const IDLE_EVICTION_MS = 30 * 60 * 1000; // 30 minutes
const EVICTION_SWEEP_MS = 5 * 60 * 1000; // check every 5 minutes

type Entry = {
  sandbox: Sandbox;
  lastUsed: number;
};

class SandboxManager {
  private pool: Map<string, Entry> = new Map();
  private creating: Map<string, Promise<Sandbox>> = new Map();
  private sweeper: NodeJS.Timeout | null = null;

  constructor() {
    // Kick off the idle-eviction sweeper once.
    this.sweeper = setInterval(() => {
      this.evictIdle().catch(() => {});
    }, EVICTION_SWEEP_MS);
    // Don't keep the event loop alive solely for the sweeper.
    if (this.sweeper && typeof this.sweeper.unref === 'function') {
      this.sweeper.unref();
    }
  }

  async getOrCreate(threadId: string, apiKeyOverride?: string): Promise<Sandbox> {
    const existing = this.pool.get(threadId);
    if (existing) {
      existing.lastUsed = Date.now();
      return existing.sandbox;
    }
    // Coalesce concurrent requests for the same thread.
    const inFlight = this.creating.get(threadId);
    if (inFlight) return inFlight;

    const p = (async () => {
      // BYOK: prefer a per-request key (from the UI via header), fall back to env.
      const apiKey = apiKeyOverride || process.env.E2B_API_KEY;
      if (!apiKey) {
        throw new Error(
          'E2B API key missing; provide it via the x-e2b-key header or E2B_API_KEY in .env.'
        );
      }
      const timeoutS = Number(process.env.DATA_AGENT_SANDBOX_TIMEOUT || 3600);
      const sandbox = await Sandbox.create({
        apiKey,
        timeoutMs: timeoutS * 1000,
      });
      // Prepare working dirs.
      await sandbox.commands.run(
        `mkdir -p ${UPLOADS_DIR_IN_SANDBOX} ${ARTIFACTS_DIR_IN_SANDBOX}`
      );
      this.pool.set(threadId, { sandbox, lastUsed: Date.now() });
      return sandbox;
    })();

    this.creating.set(threadId, p);
    try {
      return await p;
    } finally {
      this.creating.delete(threadId);
    }
  }

  async close(threadId: string): Promise<void> {
    const entry = this.pool.get(threadId);
    if (!entry) return;
    this.pool.delete(threadId);
    try {
      await entry.sandbox.kill();
    } catch {
      // best-effort
    }
  }

  async evictIdle(): Promise<number> {
    const now = Date.now();
    const toEvict: string[] = [];
    for (const [tid, entry] of this.pool.entries()) {
      if (now - entry.lastUsed > IDLE_EVICTION_MS) toEvict.push(tid);
    }
    for (const tid of toEvict) {
      await this.close(tid);
    }
    return toEvict.length;
  }

  async shutdown(): Promise<void> {
    if (this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
    const entries = Array.from(this.pool.values());
    this.pool.clear();
    await Promise.all(
      entries.map(async (e) => {
        try {
          await e.sandbox.kill();
        } catch {
          // best-effort
        }
      })
    );
  }
}

export const sandboxManager = new SandboxManager();
