/**
 * LangGraph.js ReAct agent factory with Postgres-backed checkpointing.
 *
 * Because tools are thread-bound (they need the thread_id to address the
 * right E2B sandbox and to persist artifacts), we build a fresh agent per
 * request. The checkpointer is shared across all agents so conversation
 * memory persists.
 */
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';

import { getLLM } from './llm';
import { DATA_ANALYST_SYSTEM_PROMPT } from './prompts';
import { buildTools, type EventSink } from './tools';
import { isDbConfigured } from './artifactStore';

type Checkpointer = PostgresSaver | SqliteSaver;

let _checkpointer: Checkpointer | null = null;
let _setupPromise: Promise<Checkpointer> | null = null;

/** Local SQLite file used when no real Postgres/Supabase URL is configured. */
const SQLITE_PATH = process.env.SQLITE_PATH || './data-agent.sqlite';

/**
 * Lazily create a shared checkpoint saver.
 *
 * - When a real Postgres/Supabase URL is set -> PostgresSaver.
 * - Otherwise -> local SQLite file (no cloud, no server).
 *
 * Safe to call concurrently — the first caller runs setup(), everyone else
 * awaits the same promise.
 */
export async function ensureCheckpointer(): Promise<Checkpointer> {
  if (_checkpointer) return _checkpointer;
  if (!_setupPromise) {
    _setupPromise = (async () => {
      if (isDbConfigured()) {
        const connString =
          process.env.CHECKPOINT_DATABASE_URL ||
          process.env.DATABASE_URL ||
          '';
        const saver = PostgresSaver.fromConnString(connString);
        await saver.setup();
        console.log('[data-agent] checkpointer: Postgres (Supabase)');
        _checkpointer = saver;
        return saver;
      }
      const saver = SqliteSaver.fromConnString(SQLITE_PATH);
      await saver.setup();
      console.log(`[data-agent] checkpointer: local SQLite (${SQLITE_PATH})`);
      _checkpointer = saver;
      return saver;
    })();
  }
  return _setupPromise;
}

export type AgentKeys = {
  openrouterKey?: string;
  e2bKey?: string;
};

export async function buildAgent(
  threadId: string,
  userId: string,
  model: string | undefined,
  eventSink: EventSink,
  keys?: AgentKeys
) {
  const cp = await ensureCheckpointer();
  const llm = getLLM(model, keys?.openrouterKey);
  const tools = buildTools(threadId, userId, eventSink, keys?.e2bKey);
  // NOTE: createReactAgent is the LangGraph.js prebuilt executor. We pass
  // `prompt` as a string — it is prepended as a SystemMessage on every call.
  const agent = createReactAgent({
    llm,
    tools,
    checkpointSaver: cp,
    prompt: DATA_ANALYST_SYSTEM_PROMPT,
  });
  return agent;
}

export type HistoryMessage = {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  tool_call_id?: string;
  name?: string;
};

/** Detect a LangChain message's type from an instance OR its serialized form. */
function messageType(m: any): string {
  if (!m) return '';
  if (typeof m._getType === 'function') {
    try {
      return m._getType();
    } catch {
      /* fall through */
    }
  }
  if (typeof m.type === 'string') return m.type;
  const cls = Array.isArray(m.id)
    ? String(m.id[m.id.length - 1] || '')
    : String(m.constructor?.name || '');
  if (/Human/.test(cls)) return 'human';
  if (/System/.test(cls)) return 'system';
  if (/Tool/.test(cls)) return 'tool';
  if (/AI/.test(cls)) return 'ai';
  return '';
}

/** Read a field from a message instance, falling back to its serialized kwargs. */
function field(m: any, key: string): any {
  if (m == null) return undefined;
  if (m[key] !== undefined) return m[key];
  if (m.kwargs && m.kwargs[key] !== undefined) return m.kwargs[key];
  return undefined;
}

function contentToString(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : p?.text ?? ''))
      .join('');
  }
  return content == null ? '' : String(content);
}

/**
 * Reconstruct a conversation's message history from the checkpointer so the UI
 * can reload a past chat. Reads the checkpoint tuple directly (no LLM key or
 * agent build required) and normalizes each message into a UI-friendly shape.
 */
export async function getThreadMessages(threadId: string): Promise<HistoryMessage[]> {
  const cp = await ensureCheckpointer();
  let tuple: any;
  try {
    tuple = await cp.getTuple({ configurable: { thread_id: threadId } });
  } catch {
    return [];
  }
  const raw = tuple?.checkpoint?.channel_values?.messages;
  if (!Array.isArray(raw)) return [];

  const out: HistoryMessage[] = [];
  for (const m of raw) {
    const t = messageType(m);
    if (t === 'human') {
      out.push({ role: 'user', content: contentToString(field(m, 'content')) });
    } else if (t === 'ai') {
      const toolCalls = (field(m, 'tool_calls') || [])
        .filter((tc: any) => tc && (tc.name || tc.function))
        .map((tc: any) => ({
          id: String(tc.id || ''),
          name: String(tc.name || tc.function?.name || 'tool'),
          args: tc.args || tc.function?.arguments || {},
        }));
      out.push({
        role: 'assistant',
        content: contentToString(field(m, 'content')),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
    } else if (t === 'tool') {
      out.push({
        role: 'tool',
        content: contentToString(field(m, 'content')),
        tool_call_id: String(field(m, 'tool_call_id') || ''),
        name: String(field(m, 'name') || ''),
      });
    }
    // system messages are not part of the visible transcript — skip.
  }
  return out;
}

export async function shutdownAgent(): Promise<void> {
  if (_checkpointer) {
    try {
      // Only PostgresSaver holds a pool that needs closing; SqliteSaver does not.
      const end = (_checkpointer as any).end;
      if (typeof end === 'function') await end.call(_checkpointer);
    } catch {
      // best-effort
    }
    _checkpointer = null;
    _setupPromise = null;
  }
}
