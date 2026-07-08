/**
 * SSE event formatter and Data Agent run orchestration.
 *
 * Wire protocol:
 *
 *   event: thinking     data: {"delta": "..."}   (heal / recovery notices only)
 *   event: tool_call    data: {"tool": "run_python", "args": {...}, "id": "..."}
 *   event: tool_output  data: {"stream": "stdout|stderr", "delta": "..."}  (LIVE)
 *   event: tool_result  data: {"tool": "run_python", "id": "...", "output": "..."}
 *   event: artifact     data: {"id": "...", "filename": "...", "url": "...", ...}
 *   event: token        data: {"delta": "..."}   (assistant text, live delta)
 *   event: done         data: {}
 *   event: error        data: {"message": "..."}
 *
 * Design:
 *   - `streamMode: ['messages', 'updates']` splits the surface: text lives on
 *     `messages` as AIMessageChunk; tool calls / tool results live on
 *     `updates`. Text is emitted ONLY from `messages`, tool events ONLY from
 *     `updates`, so the same bytes never traverse two paths.
 *   - Graph events AND side-channel events (live sandbox stdout/stderr,
 *     artifacts) are merged into a SINGLE async queue. The graph runs in a
 *     background task pushing into the queue while this generator drains it.
 *     This is what makes sandbox output truly real-time: while a tool is
 *     executing (and the graph stream is blocked awaiting the next step),
 *     E2B's onStdout/onStderr callbacks push into the same queue and are
 *     flushed to the client immediately, instead of being buffered until the
 *     graph produces its next event.
 */
import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { buildAgent, type AgentKeys } from './graph';
import type { SinkEvent, EventSink } from './tools';

// ---------------------------------------------------------------------------
// SSE helper
// ---------------------------------------------------------------------------
function sse(event: string, data: Record<string, unknown> | string): string {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  return `event: ${event}\ndata: ${payload}\n\n`;
}

// ---------------------------------------------------------------------------
// Minimal async queue: push from any producer, await from a single consumer.
// Used to merge the graph stream with the live side-channel (sandbox output).
// ---------------------------------------------------------------------------
class AsyncQueue<T> {
  private items: T[] = [];
  private resolvers: Array<(r: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const r = this.resolvers.shift();
    if (r) r({ value: item, done: false });
    else this.items.push(item);
  }

  close(): void {
    this.closed = true;
    let r: ((r: IteratorResult<T>) => void) | undefined;
    while ((r = this.resolvers.shift())) r({ value: undefined as any, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.items.length) {
          return Promise.resolve({ value: this.items.shift() as T, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as any, done: true });
        }
        return new Promise((resolve) => this.resolvers.push(resolve));
      },
    };
  }
}

// Unified event flowing through the merged queue.
type MergedEvent =
  | { k: 'graph'; raw: any }
  | { k: 'side'; evt: SinkEvent }
  | { k: 'err'; message: string };

// ---------------------------------------------------------------------------
// History healing: repair dangling AIMessage tool_calls from a prior crash.
// ---------------------------------------------------------------------------
async function healDanglingToolCalls(agent: any, config: any): Promise<number> {
  let state: any;
  try {
    state = await agent.getState(config);
  } catch {
    return 0;
  }
  const messages: any[] = state?.values?.messages || [];
  if (messages.length === 0) return 0;

  const satisfied = new Set<string>();
  for (const m of messages) {
    if (m instanceof ToolMessage) {
      const tid = (m as any).tool_call_id;
      if (tid) satisfied.add(tid);
    }
  }

  const dangling: Array<{ id: string; name: string }> = [];
  for (const m of messages) {
    if (m instanceof AIMessage) {
      const toolCalls = (m as any).tool_calls || [];
      for (const tc of toolCalls) {
        const tid = tc?.id;
        const tname = tc?.name || 'unknown_tool';
        if (tid && !satisfied.has(tid)) dangling.push({ id: tid, name: tname });
      }
    }
  }
  if (dangling.length === 0) return 0;

  const synthetic = dangling.map(
    (d) =>
      new ToolMessage({
        content: '[tool execution was interrupted; please retry the previous step]',
        tool_call_id: d.id,
        name: d.name,
      })
  );
  try {
    await agent.updateState(config, { messages: synthetic });
  } catch {
    return 0;
  }
  return synthetic.length;
}

// ---------------------------------------------------------------------------
// Extract text pieces from an AIMessageChunk's content field, which may be a
// string OR an array of content-part objects depending on provider.
// ---------------------------------------------------------------------------
function extractTextPieces(content: unknown): string[] {
  if (typeof content === 'string') return content ? [content] : [];
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const part of content) {
    if (part && typeof part === 'object') {
      const ptype = (part as any).type;
      const ptext = (part as any).text || '';
      if (ptype === 'text' && ptext) out.push(ptext);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public entry point: stream one user turn as SSE strings.
// ---------------------------------------------------------------------------
export async function* runAgentStream(
  threadId: string,
  userId: string,
  userMessage: string,
  model?: string,
  keys?: AgentKeys
): AsyncGenerator<string, void, unknown> {
  const merged = new AsyncQueue<MergedEvent>();
  // Side-channel (sandbox stdout/stderr, artifacts) feeds the SAME queue so it
  // interleaves with graph events in real time.
  const sink: EventSink = { push: (e) => merged.push({ k: 'side', evt: e }) };

  console.log(
    `[chat] start thread=${threadId} model=${model || '(default)'} orKey=${!!keys
      ?.openrouterKey} e2bKey=${!!keys?.e2bKey}`
  );

  let agent: any;
  try {
    agent = await buildAgent(threadId, userId, model, sink, keys);
  } catch (e: any) {
    console.error('[chat] buildAgent failed:', e?.message ?? e);
    yield sse('error', { message: `agent build failed: ${e?.message ?? e}` });
    yield sse('done', {});
    return;
  }

  const config = {
    configurable: { thread_id: threadId },
    // ReAct loop can legitimately take many steps on data-analysis tasks
    // (load → inspect → clean → compute → visualise → save → explain).
    recursionLimit: 80,
  };

  // Self-heal any dangling tool_calls left by a previous crash/interrupt.
  try {
    const healed = await healDanglingToolCalls(agent, config);
    if (healed > 0) {
      yield sse('thinking', {
        delta: `(recovered ${healed} interrupted tool call${
          healed !== 1 ? 's' : ''
        } from a previous run)\n`,
      });
    }
  } catch {
    /* best-effort */
  }

  const inputs = { messages: [new HumanMessage(userMessage)] };
  const emittedToolCalls = new Set<string>();

  // Allows us to hard-stop a hung/looping graph — e.g. an upstream LLM call
  // that never returns. Aborting propagates the signal into the model call so
  // it actually cancels; the graph task then settles and closes the queue.
  const abort = new AbortController();

  // Drive the graph in the background, funnelling every raw event into the
  // merged queue. Runs to completion independently of the consumer.
  const graphTask = (async () => {
    try {
      const stream = await agent.stream(inputs, {
        ...config,
        streamMode: ['messages', 'updates'],
        signal: abort.signal,
      });
      for await (const raw of stream) merged.push({ k: 'graph', raw });
    } catch (e: any) {
      const rawMsg = e?.message ?? String(e);
      console.error('[chat] stream error:', rawMsg);
      let friendlyMsg = rawMsg;
      if (/Recursion limit of \d+ reached/i.test(rawMsg)) {
        friendlyMsg =
          'The agent took too many steps before finishing. Try breaking the task into smaller requests, or ask for a narrower output (e.g. fewer columns / charts).';
      } else if (/abort/i.test(rawMsg)) {
        friendlyMsg =
          'The agent was stopped after a long period with no response from the model. Please try again.';
      }
      merged.push({ k: 'err', message: friendlyMsg });
    } finally {
      merged.close();
    }
  })();

  let tokenCount = 0;

  // If NOTHING flows for this long, assume the run has stalled (commonly an
  // upstream model/provider hang) and recover instead of freezing the UI.
  // Any event — a token, live sandbox output, a tool result — resets the clock.
  const IDLE_MS = Number(process.env.DATA_AGENT_IDLE_TIMEOUT_MS || 120_000);
  const iterator = merged[Symbol.asyncIterator]();
  let stalled = false;

  try {
    while (true) {
      const nextP = iterator.next();
      let timer: ReturnType<typeof setTimeout>;
      const timeoutP = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), IDLE_MS);
      });
      const winner = await Promise.race([nextP, timeoutP]);
      clearTimeout(timer!);

      if (winner === 'timeout') {
        stalled = true;
        break;
      }
      const result = winner as IteratorResult<MergedEvent>;
      if (result.done) break;
      const ev = result.value;

      // -------------------------------------------------------------------
      // Live side-channel: sandbox stdout/stderr + artifacts, forwarded as-is.
      // -------------------------------------------------------------------
      if (ev.k === 'side') {
        yield sse(ev.evt.type, ev.evt.data ?? {});
        continue;
      }
      if (ev.k === 'err') {
        yield sse('error', { message: ev.message });
        continue;
      }

      // -------------------------------------------------------------------
      // Graph event: split tuple [mode, chunk].
      // -------------------------------------------------------------------
      const raw = ev.raw;
      let streamMode: string;
      let chunk: any;
      if (Array.isArray(raw) && raw.length === 2 && typeof raw[0] === 'string') {
        streamMode = raw[0];
        chunk = raw[1];
      } else {
        streamMode = 'updates';
        chunk = raw;
      }

      if (streamMode === 'messages') {
        // TEXT CONTENT — forwarded directly, no dedup, no rewriting.
        const msgChunk = Array.isArray(chunk) ? chunk[0] : chunk;
        if (!(msgChunk instanceof AIMessageChunk)) continue;

        const pieces = extractTextPieces((msgChunk as any).content);
        for (const piece of pieces) {
          if (piece) {
            tokenCount += 1;
            yield sse('token', { delta: piece });
          }
        }
      } else if (streamMode === 'updates') {
        // TOOL EVENTS — tool_calls from AIMessage, outputs from ToolMessage.
        for (const nodeName of Object.keys(chunk || {})) {
          const update = chunk[nodeName] || {};
          const messages = update.messages || [];
          for (const m of messages) {
            const isAIMsg = m instanceof AIMessage || m instanceof AIMessageChunk;
            const isToolMsg = m instanceof ToolMessage;

            if (isAIMsg) {
              const toolCalls = (m as any).tool_calls || [];
              for (const tc of toolCalls) {
                const tid = tc?.id || '';
                if (tid && emittedToolCalls.has(tid)) continue;
                if (tid) emittedToolCalls.add(tid);
                yield sse('tool_call', {
                  id: tid,
                  tool: tc?.name,
                  args: tc?.args || {},
                });
              }
            } else if (isToolMsg) {
              let output: any = (m as any).content;
              if (Array.isArray(output)) {
                output = output
                  .map((p: any) =>
                    p && typeof p === 'object' ? p.text || '' : String(p)
                  )
                  .join('\n');
              }
              yield sse('tool_result', {
                id: (m as any).tool_call_id || '',
                tool: (m as any).name || '',
                output:
                  output !== null && output !== undefined ? String(output) : '',
              });
            }
          }
        }
      }
    }
  } finally {
    // Leaving the loop (normal finish, stall, or client disconnect): tear down
    // the background graph so it can't keep running a hung call.
    abort.abort();
  }

  if (stalled) {
    console.error(`[chat] idle-timeout thread=${threadId} after ${IDLE_MS}ms`);
    yield sse('error', {
      message:
        'The agent stopped responding (no activity for a while). This is usually an upstream model/provider stall — please try again or rephrase your request.',
    });
  }

  // Don't hang forever waiting on a task we've just aborted.
  await Promise.race([graphTask, new Promise((r) => setTimeout(r, 1500))]);
  console.log(`[chat] done thread=${threadId} tokens=${tokenCount}`);
  yield sse('done', {});
}
