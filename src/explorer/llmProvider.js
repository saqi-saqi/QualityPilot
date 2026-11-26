/**
 * llmProvider.js — pluggable LLM provider interface for the Explorer.
 *
 * The Explorer never calls an SDK directly; it calls this module. That way:
 *   • Tests can inject a MockProvider with canned responses
 *   • Users can swap z-ai-web-dev-sdk for OpenAI / Anthropic / local Llama
 *     by writing a thin adapter and calling setDefaultProvider(adapter).
 *
 * Provider interface:
 *   {
 *     name:    string,
 *     chat:    async ({ system, user, json, temperature }) =>
 *                { ok: true,  content: string } |
 *                { ok: false, error: string }
 *   }
 *
 * `json: true` tells the provider to enforce JSON-only output. The caller
 * still parses — providers may wrap JSON in markdown fences despite the
 * instruction, so we strip fences defensively in parseJsonResponse().
 *
 * NOTE: z-ai-web-dev-sdk is loaded lazily — the project doesn't depend on
 * it being installed at import time. Tests use MockProvider and never
 * trigger the lazy import; production users install the SDK and call
 * `await ZaiSdkProvider.create()` (or just use the default).
 */
import { createRequire } from 'node:module';

// ─── provider registry ───────────────────────────────────────────────

let defaultProvider = null;

export function setDefaultProvider(provider) {
  if (!provider || typeof provider.chat !== 'function') {
    throw new Error('Provider must have a chat() function');
  }
  defaultProvider = provider;
}

export function resetDefaultProvider() {
  defaultProvider = null;
}

export function getDefaultProvider() {
  if (!defaultProvider) {
    defaultProvider = createProvider();
  }
  return defaultProvider;
}

// ─── default provider: z-ai-web-dev-sdk (lazy import) ────────────────

export class ZaiSdkProvider {
  constructor() {
    this.name = 'zai-sdk';
    this._zai = null;
    this._initPromise = null;
  }

  /**
   * Explicit initialization — useful if the caller wants to fail fast
   * when the SDK isn't installed. Returns the same instance.
   */
  async create() {
    if (!this._initPromise) {
      this._initPromise = (async () => {
        // Lazy import so the project compiles + tests run without the SDK
        // installed. The SDK is required only when the default provider
        // is actually used (i.e. production runs against a real LLM).
        const ZAIModule = await import('z-ai-web-dev-sdk').catch(err => {
          throw new Error(
            `z-ai-web-dev-sdk is not installed. Install it with 'npm i z-ai-web-dev-sdk' ` +
            `or call setDefaultProvider() with a different provider. Original error: ${err.message}`
          );
        });
        const ZAI = ZAIModule.default || ZAIModule;
        this._zai = await ZAI.create();
        return this._zai;
      })();
    }
    return this._initPromise;
  }

  async chat({ system, user, json = false, temperature = 0.2 }) {
    try {
      const zai = await this.create();

      // The skill examples use role:'assistant' for the system message
      // (z-ai-web-dev-sdk quirk). We follow the same convention here.
      const messages = [];
      if (system) {
        messages.push({
          role: 'assistant',
          content: json
            ? `${system}\n\nRespond with valid JSON only. No markdown fences, no prose.`
            : system,
        });
      }
      messages.push({ role: 'user', content: user });

      const completion = await zai.chat.completions.create({
        model: process.env.SQA_LLM_MODEL || 'glm-4.7-flash',
        messages,
        thinking: { type: 'disabled' },
        temperature,
      });

      const content = completion?.choices?.[0]?.message?.content;
      if (!content || !content.trim()) {
        return { ok: false, error: 'Empty LLM response' };
      }
      return { ok: true, content };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  }
}

// ─── OpenAI-compatible provider (plain fetch, no SDK) ────────────────

/**
 * OpenAIProvider — talks to any OpenAI-compatible /chat/completions endpoint
 * (OpenAI, Azure-style gateways, Ollama, vLLM, …) using the global fetch.
 *
 * Env:
 *   OPENAI_API_KEY   — required for real calls
 *   OPENAI_BASE_URL  — default https://api.openai.com/v1
 *   OPENAI_MODEL     — default gpt-4o-mini
 *
 * Message/parsing behavior mirrors ZaiSdkProvider: the system message gets a
 * "Respond with valid JSON only" suffix in JSON mode, and the response is
 * read from choices[0].message.content (callers still parse defensively via
 * parseJsonResponse — providers may wrap JSON in fences).
 */
export class OpenAIProvider {
  constructor(opts = {}) {
    this.name = 'openai';
    this.apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY ?? '';
    this.baseUrl = (opts.baseUrl ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
    // A preset may deliberately pass null ("the server names its own model");
    // only an absent value falls back to the env/default.
    this.model = opts.model !== undefined
      ? opts.model
      : (process.env.OPENAI_MODEL ?? 'gpt-4o-mini');
    this.extraHeaders = opts.extraHeaders || {};
    this._fetch = opts.fetchImpl || globalThis.fetch;
  }

  async chat({ system, user, json = false, temperature = 0.2 }) {
    try {
      if (!this.apiKey) {
        return { ok: false, error: 'OPENAI_API_KEY is not set' };
      }
      if (!this.model) {
        return { ok: false, error: 'No model configured — set OPENAI_MODEL (or SQA_LLM_MODEL) to the model name your endpoint serves' };
      }
      if (typeof this._fetch !== 'function') {
        return { ok: false, error: 'No fetch implementation available (Node 18+ required)' };
      }

      const messages = [];
      if (system) {
        messages.push({
          role: 'system',
          content: json
            ? `${system}\n\nRespond with valid JSON only. No markdown fences, no prose.`
            : system,
        });
      }
      messages.push({ role: 'user', content: user });

      const body = {
        model: this.model,
        messages,
        temperature,
      };
      if (json) {
        body.response_format = { type: 'json_object' };
      }

      const response = await this._fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          ...this.extraHeaders,
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        let detail = '';
        try { detail = (await response.text()).slice(0, 300); } catch { /* ignore */ }
        return { ok: false, error: `OpenAI API error ${response.status}: ${detail}` };
      }

      const completion = await response.json();
      const content = completion?.choices?.[0]?.message?.content;
      if (!content || !content.trim()) {
        return { ok: false, error: 'Empty LLM response' };
      }
      return { ok: true, content };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  }
}

// ─── provider presets ────────────────────────────────────────────────

/**
 * First-class endpoints for the local-first LLM story.
 *
 * A preset is only a resolved configuration — the transport stays the single
 * OpenAI-compatible OpenAIProvider, so every preset speaks the same
 * /chat/completions dialect and no vendor SDK is involved.
 *
 * Precedence per field: <PRESET>_BASE_URL / <PRESET>_API_KEY → OPENAI_* →
 * preset default. OPENAI_MODEL (or SQA_LLM_MODEL) overrides a preset model.
 */
export const LLM_PRESETS = {
  ollama: {
    label: 'Ollama (local)',
    baseUrl: 'http://127.0.0.1:11434/v1',
    baseUrlEnv: 'OLLAMA_BASE_URL',
    apiKeyEnv: ['OLLAMA_API_KEY'],
    // Ollama ignores the bearer token, but the client requires a non-empty one.
    placeholderApiKey: 'ollama',
    defaultModel: 'qwen2.5:7b',
    contextWindowTokens: 4096,
  },
  vllm: {
    label: 'vLLM (local)',
    baseUrl: 'http://127.0.0.1:8000/v1',
    baseUrlEnv: 'VLLM_BASE_URL',
    apiKeyEnv: ['VLLM_API_KEY'],
    // vLLM accepts any bearer token unless started with --api-key.
    placeholderApiKey: 'EMPTY',
    // The served model name is deployment-specific — never guess it.
    defaultModel: null,
    contextWindowTokens: null,
  },
  openrouter: {
    label: 'OpenRouter (hosted, OpenAI-compatible)',
    baseUrl: 'https://openrouter.ai/api/v1',
    baseUrlEnv: 'OPENROUTER_BASE_URL',
    apiKeyEnv: ['OPENROUTER_API_KEY', 'OPENAI_API_KEY'],
    defaultModel: 'openai/gpt-4o-mini',
    contextWindowTokens: null,
    extraHeaders: {
      'HTTP-Referer': 'https://github.com/saqi-saqi/Testigator',
      'X-Title': 'Testigator',
    },
  },
  openai: {
    label: 'OpenAI (hosted)',
    baseUrl: 'https://api.openai.com/v1',
    baseUrlEnv: 'OPENAI_BASE_URL',
    apiKeyEnv: ['OPENAI_API_KEY'],
    defaultModel: 'gpt-4o-mini',
    contextWindowTokens: null,
  },
  byo: {
    label: 'Bring your own OpenAI-compatible endpoint',
    // No default: BYO means you supply the URL.
    baseUrl: null,
    baseUrlEnv: 'OPENAI_BASE_URL',
    apiKeyEnv: ['OPENAI_API_KEY'],
    placeholderApiKey: 'none',
    defaultModel: null,
    contextWindowTokens: null,
  },
};

export const LLM_PRESET_NAMES = Object.keys(LLM_PRESETS);

/**
 * Warnings a preset should surface before the first call. Kept separate from
 * resolvePreset so tests can assert the text without capturing console output.
 */
export function presetWarnings(name, env = process.env, model = null) {
  const warnings = [];
  if (env.SQA_LLM_NO_WARN) return warnings;

  if (name === 'ollama' && !env.OLLAMA_CONTEXT_LENGTH) {
    warnings.push(
      'Ollama preset active: Ollama serves a small context by default (num_ctx — 4096 tokens on recent ' +
      'versions, less on older ones) and older prompt tokens are dropped once it overflows. Raise it with ' +
      'OLLAMA_CONTEXT_LENGTH=8192 (Ollama >= 0.6) or num_ctx in a Modelfile if plans come back truncated. ' +
      'Silence with SQA_LLM_NO_WARN=1.'
    );
  }
  if (name === 'vllm' && !model) {
    warnings.push(
      'vLLM preset has no model name — set OPENAI_MODEL to the model your server is serving ' +
      '(vLLM does not choose one for you).'
    );
  }
  if (name === 'openrouter' && !env.OPENROUTER_API_KEY && !env.OPENAI_API_KEY) {
    warnings.push('OpenRouter preset has no API key — set OPENROUTER_API_KEY (or OPENAI_API_KEY).');
  }
  return warnings;
}

/**
 * Resolve a preset name against an environment without constructing anything.
 * Returns { ok: true, name, baseUrl, apiKey, model, extraHeaders, warnings }
 * or { ok: false, error }.
 */
export function resolvePreset(name, env = process.env) {
  const key = String(name || '').toLowerCase().trim();
  const preset = LLM_PRESETS[key];
  if (!preset) {
    return { ok: false, error: `Unknown LLM preset "${name}". Choose one of: ${LLM_PRESET_NAMES.join(', ')}` };
  }

  const baseUrl = String(env[preset.baseUrlEnv] || preset.baseUrl || '').replace(/\/+$/, '');
  if (!baseUrl) {
    return { ok: false, error: `The ${key} preset needs a base URL — set ${preset.baseUrlEnv}` };
  }

  // Presets with a placeholderApiKey that do not declare OPENAI_API_KEY in
  // apiKeyEnv (ollama, vllm) must not leak a user's OpenAI cloud key to local
  // servers. Explicitly configured keys (<PRESET>_API_KEY) still win; byo
  // includes OPENAI_API_KEY in apiKeyEnv directly.
  const apiKey = preset.apiKeyEnv.map((k) => env[k]).find((v) => v)
    || preset.placeholderApiKey
    || env.OPENAI_API_KEY
    || '';
  const model = env.OPENAI_MODEL || env.SQA_LLM_MODEL || preset.defaultModel || null;

  return {
    ok: true,
    name: key,
    label: preset.label,
    baseUrl,
    apiKey,
    model,
    extraHeaders: preset.extraHeaders || {},
    warnings: presetWarnings(key, env, model),
  };
}

/**
 * A provider whose configuration is broken. It fails every call with the
 * configuration error instead of silently degrading to MockProvider — a scan
 * that reports why planning produced nothing is recoverable; a silent mock is
 * not.
 */
class UnconfiguredProvider {
  constructor(error) {
    this.name = 'unconfigured';
    this.error = error;
  }

  async chat() {
    return { ok: false, error: this.error };
  }
}

function providerFromPreset(name, env) {
  const resolved = resolvePreset(name, env);
  if (!resolved.ok) {
    console.warn(`[llmProvider] ${resolved.error}`);
    return new UnconfiguredProvider(resolved.error);
  }
  for (const warning of resolved.warnings) {
    console.warn(`[llmProvider] ${warning}`);
  }
  return new OpenAIProvider({
    apiKey: resolved.apiKey,
    baseUrl: resolved.baseUrl,
    model: resolved.model,
    extraHeaders: resolved.extraHeaders,
  });
}

// ─── provider factory ────────────────────────────────────────────────

/**
 * Is the z-ai-web-dev-sdk installed? (Synchronous resolution — no import
 * side effects. Module resolution failure = not installed.)
 */
function zaiSdkInstalled() {
  try {
    createRequire(import.meta.url).resolve('z-ai-web-dev-sdk');
    return true;
  } catch {
    return false;
  }
}

/**
 * Select a provider from the environment:
 *   SQA_LLM_PROVIDER = 'glm' | 'openai' | 'mock'  — explicit choice
 *   auto-detect (no/unknown value):
 *     OPENAI_API_KEY set   → OpenAIProvider
 *     z-ai-web-dev-sdk present → ZaiSdkProvider (glm)
 *     otherwise            → MockProvider (with a warning — no real AI calls)
 */
export function createProvider(env = process.env) {
  // SQA_LLM_PRESET is the explicit, documented switch; SQA_LLM_PROVIDER also
  // accepts a preset name so existing setups keep working.
  const preset = String(env.SQA_LLM_PRESET || env.SQA_LLM_PROVIDER || '').toLowerCase().trim();
  if (LLM_PRESETS[preset]) {
    return providerFromPreset(preset, env);
  }
  if (env.SQA_LLM_PRESET) {
    console.warn(`[llmProvider] Unknown SQA_LLM_PRESET "${env.SQA_LLM_PRESET}" — choose one of: ${LLM_PRESET_NAMES.join(', ')}; auto-detecting instead`);
  }

  const pref = String(env.SQA_LLM_PROVIDER || '').toLowerCase().trim();

  if (pref === 'glm' || pref === 'zai') {
    return new ZaiSdkProvider();
  }
  if (pref === 'mock') {
    return new MockProvider();
  }
  if (pref && pref !== 'auto') {
    console.warn(`[llmProvider] Unknown SQA_LLM_PROVIDER "${pref}" — auto-detecting instead`);
  }

  // Auto-detect
  if (env.OPENAI_API_KEY) {
    return new OpenAIProvider({ apiKey: env.OPENAI_API_KEY });
  }
  if (zaiSdkInstalled()) {
    return new ZaiSdkProvider();
  }
  console.warn('[llmProvider] No LLM provider configured (no OPENAI_API_KEY, z-ai-web-dev-sdk not installed) — using MockProvider; AI features will return empty results');
  return new MockProvider();
}

// ─── mock provider (for tests) ───────────────────────────────────────

/**
 * MockProvider — returns canned responses based on a key matched against
 * the user prompt. Lets tests drive the Explorer deterministically.
 *
 * Usage:
 *   const mock = new MockProvider({
 *     'infer-flows':  { flows: [...] },
 *     'infer-api':    { endpoints: [...] },
 *     'summarize':    { pages: [...] },
 *   });
 *   setDefaultProvider(mock);
 *
 * Keys are matched by substring against the user prompt.
 */
export class MockProvider {
  constructor(responses = {}) {
    this.name = 'mock';
    this.responses = responses;
    this.calls = [];  // record of all invocations for assertions
  }

  async chat({ system, user, json = false }) {
    this.calls.push({ system, user, json });

    for (const [key, value] of Object.entries(this.responses)) {
      if (user.includes(key) || (system && system.includes(key))) {
        const content = typeof value === 'string' ? value : JSON.stringify(value);
        return { ok: true, content };
      }
    }
    // Default: return empty JSON object so callers can still parse
    return { ok: true, content: json ? '{}' : '' };
  }
}

// ─── helpers ─────────────────────────────────────────────────────────

/**
 * Defensive JSON parse — strips markdown fences + leading/trailing prose.
 * Returns { ok: true, data } | { ok: false, error }.
 */
export function parseJsonResponse(content) {
  if (!content || typeof content !== 'string') {
    return { ok: false, error: 'No content to parse' };
  }

  let text = content.trim();

  // Strip ```json ... ``` or ``` ... ``` fences
  const fenceMatch = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }

  // If there's still leading prose, try to slice from the first { or [
  const firstBrace = text.search(/[{[]/);
  if (firstBrace > 0) {
    text = text.slice(firstBrace);
  }

  try {
    return { ok: true, data: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: `JSON parse failed: ${err.message}` };
  }
}

/**
 * High-level helper: ask the LLM for JSON, parse, return data.
 * Falls back to {} on error (and logs).
 */
export async function chatJson({ system, user, temperature }, opts = {}) {
  const provider = opts.provider || getDefaultProvider();
  const res = await provider.chat({ system, user, json: true, temperature });
  if (!res.ok) {
    return { ok: false, error: res.error, data: null };
  }
  const parsed = parseJsonResponse(res.content);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error, data: null, raw: res.content };
  }
  return { ok: true, data: parsed.data, raw: res.content };
}
