/**
 * OpenRouter-backed chat model for the Data Agent.
 *
 * Routes langchain-openai ChatOpenAI through the OpenRouter OpenAI-compatible
 * endpoint.
 *
 * Default is DeepSeek V3.2. It does NOT exhibit the cumulative / doubled
 * content behaviour that V4 Pro shows on OpenRouter+SiliconFlow, so the
 * streaming path can forward tokens directly without dedup (Persona-style).
 *
 * Caveat: V3.2 sometimes emits a short text preamble before its `tool_calls`
 * chunks, and a few OpenRouter providers close the message after the
 * preamble — dropping the tool call. If that surfaces, fall back to
 * `deepseek/deepseek-v4-pro` via the `DATA_AGENT_MODEL` env or UI override.
 */
import { ChatOpenAI } from '@langchain/openai';

const DEFAULT_MODEL = 'deepseek/deepseek-v3.2';
const _cache = new Map<string, ChatOpenAI>();

export function getLLM(model?: string, apiKeyOverride?: string): ChatOpenAI {
  const chosen = model || process.env.DATA_AGENT_MODEL || DEFAULT_MODEL;

  // BYOK: prefer a per-request key (from the UI via header), fall back to env.
  const apiKey = apiKeyOverride || process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error(
      'OpenRouter API key missing; provide it via the x-openrouter-key header or OPENROUTER_API_KEY in .env.'
    );
  }

  // Cache per (model + key) so different users' keys never collide.
  const cacheKey = `${chosen}::${apiKey}`;
  const cached = _cache.get(cacheKey);
  if (cached) return cached;

  // DeepSeek V4 Pro on SiliconFlow needs reasoning fully disabled to avoid
  // doubled output. V3.2 rejects `reasoning.enabled:false` with HTTP 400,
  // so we only apply those kwargs when the chosen model is V4 Pro.
  const isV4Pro = /deepseek-v4-pro/i.test(chosen);
  const modelKwargs: Record<string, unknown> = isV4Pro
    ? { reasoning: { enabled: false }, include_reasoning: false }
    : {};

  const llm = new ChatOpenAI({
    model: chosen,
    apiKey,
    streaming: true,
    temperature: 0.3,
    // Without a timeout, a stalled provider connection hangs forever (no token,
    // no error). Cap it so a stall surfaces as a visible error instead.
    timeout: 60_000,
    maxRetries: 2,
    configuration: {
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        'HTTP-Referer': process.env.OPENROUTER_APP_URL || 'https://manuscriptguide.com',
        'X-Title': process.env.OPENROUTER_APP_NAME || 'ManuscriptGuide',
      },
    },
    modelKwargs: modelKwargs,
  });

  _cache.set(cacheKey, llm);
  return llm;
}
