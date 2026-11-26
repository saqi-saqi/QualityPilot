import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  LLM_PRESETS,
  LLM_PRESET_NAMES,
  resolvePreset,
  createProvider,
  chatJson,
  OpenAIProvider,
} from '../src/explorer/llmProvider.js';
import { parseArgs } from '../src/cli/check.js';

// Every test passes an explicit env object, so process.env never leaks in.
const EMPTY_ENV = Object.freeze({});

describe('llmProvider — preset registry', () => {
  it('exposes exactly the documented preset names', () => {
    assert.deepEqual(LLM_PRESET_NAMES.sort(), ['byo', 'ollama', 'openai', 'openrouter', 'vllm']);
    for (const name of LLM_PRESET_NAMES) {
      assert.ok(LLM_PRESETS[name].label, `${name} has a label`);
      assert.ok(LLM_PRESETS[name].baseUrlEnv, `${name} declares its base-url env var`);
    }
  });
});

describe('llmProvider — resolvePreset', () => {
  it('resolves ollama to the local OpenAI-compatible endpoint', () => {
    const r = resolvePreset('ollama', EMPTY_ENV);
    assert.equal(r.ok, true);
    assert.equal(r.baseUrl, 'http://127.0.0.1:11434/v1');
    assert.equal(r.apiKey, 'ollama', 'Ollama ignores auth but the client needs a token');
    assert.equal(r.model, 'qwen2.5:7b');
  });

  it('lets OPENAI_MODEL and the preset base-url env override the defaults', () => {
    const r = resolvePreset('ollama', {
      OPENAI_MODEL: 'llama3.1:8b',
      OLLAMA_BASE_URL: 'http://192.168.1.9:11434/v1/',
    });
    assert.equal(r.ok, true);
    assert.equal(r.model, 'llama3.1:8b');
    assert.equal(r.baseUrl, 'http://192.168.1.9:11434/v1', 'trailing slash is stripped');
  });

  it('warns about the Ollama context window and can be silenced', () => {
    const warned = resolvePreset('ollama', EMPTY_ENV);
    assert.equal(warned.warnings.length, 1);
    assert.match(warned.warnings[0], /num_ctx/);
    assert.match(warned.warnings[0], /OLLAMA_CONTEXT_LENGTH/);

    assert.deepEqual(resolvePreset('ollama', { OLLAMA_CONTEXT_LENGTH: '8192' }).warnings, []);
    assert.deepEqual(resolvePreset('ollama', { SQA_LLM_NO_WARN: '1' }).warnings, []);
  });

  it('never invents a vLLM model name', () => {
    const r = resolvePreset('vllm', EMPTY_ENV);
    assert.equal(r.ok, true);
    assert.equal(r.model, null, 'the served model name is deployment-specific');
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /no model name/);
  });

  it('resolves openrouter with its ranking headers and OR-specific key', () => {
    const r = resolvePreset('openrouter', { OPENROUTER_API_KEY: 'or-key' });
    assert.equal(r.ok, true);
    assert.equal(r.baseUrl, 'https://openrouter.ai/api/v1');
    assert.equal(r.apiKey, 'or-key');
    assert.equal(r.extraHeaders['X-Title'], 'Testigator');
    assert.deepEqual(resolvePreset('openrouter', EMPTY_ENV).warnings.length, 1, 'missing key is surfaced');
  });

  it('rejects an unknown preset name with the valid choices', () => {
    const r = resolvePreset('gpt5', EMPTY_ENV);
    assert.equal(r.ok, false);
    assert.match(r.error, /Unknown LLM preset/);
    assert.match(r.error, /ollama/);
  });

  it('requires an explicit base URL for the byo preset', () => {
    const r = resolvePreset('byo', EMPTY_ENV);
    assert.equal(r.ok, false);
    assert.match(r.error, /OPENAI_BASE_URL/);

    const withUrl = resolvePreset('byo', { OPENAI_BASE_URL: 'http://10.0.0.5:8000/v1', OPENAI_API_KEY: 'byo-key' });
    assert.equal(withUrl.ok, true);
    assert.equal(withUrl.baseUrl, 'http://10.0.0.5:8000/v1');
    assert.equal(withUrl.apiKey, 'byo-key');
  });

  it('does not leak OPENAI_API_KEY into local ollama or vllm presets', () => {
    const o = resolvePreset('ollama', { OPENAI_API_KEY: 'sk-cloud-secret' });
    assert.equal(o.ok, true);
    assert.equal(o.apiKey, 'ollama');

    const v = resolvePreset('vllm', { OPENAI_API_KEY: 'sk-cloud-secret', OPENAI_MODEL: 'qwen2.5' });
    assert.equal(v.ok, true);
    assert.equal(v.apiKey, 'EMPTY');
  });
});

describe('llmProvider — preset-backed createProvider', () => {
  it('builds an OpenAI-compatible provider for SQA_LLM_PRESET=ollama and prints the context warning', () => {
    const warnings = [];
    const original = console.warn;
    console.warn = (m) => warnings.push(String(m));
    try {
      const p = createProvider({ SQA_LLM_PRESET: 'ollama' });
      assert.ok(p instanceof OpenAIProvider);
      assert.equal(p.baseUrl, 'http://127.0.0.1:11434/v1');
      assert.equal(p.model, 'qwen2.5:7b');
      assert.ok(warnings.some((w) => /num_ctx/.test(w)), 'context warning reaches stderr');
    } finally {
      console.warn = original;
    }
  });

  it('still accepts a preset name through SQA_LLM_PROVIDER', () => {
    const p = createProvider({ SQA_LLM_PROVIDER: 'ollama' });
    assert.ok(p instanceof OpenAIProvider);
    assert.equal(p.baseUrl, 'http://127.0.0.1:11434/v1');
  });

  it('fails the call with an actionable error instead of silently mocking a misconfigured byo preset', async () => {
    const original = console.warn;
    console.warn = () => {};
    try {
      const p = createProvider({ SQA_LLM_PRESET: 'byo' });
      assert.equal(p.name, 'unconfigured');
      const res = await p.chat({ user: 'plan this app' });
      assert.equal(res.ok, false);
      assert.match(res.error, /OPENAI_BASE_URL/);
    } finally {
      console.warn = original;
    }
  });

  it('reports a missing vLLM model at call time, before any request', async () => {
    const p = createProvider({ SQA_LLM_PRESET: 'vllm' });
    assert.equal(p.model, null, 'a null preset model must not fall back to gpt-4o-mini');
    const res = await p.chat({ user: 'plan this app' });
    assert.equal(res.ok, false);
    assert.match(res.error, /OPENAI_MODEL/);
  });

  it('keeps the openrouter headers on the provider it builds', () => {
    const p = createProvider({ SQA_LLM_PRESET: 'openrouter', OPENROUTER_API_KEY: 'or-key' });
    assert.equal(p.baseUrl, 'https://openrouter.ai/api/v1');
    assert.equal(p.extraHeaders['HTTP-Referer'], 'https://github.com/saqi-saqi/Testigator');
  });
});

describe('check CLI — --llm-preset', () => {  it('parses a valid preset', () => {
    const opts = parseArgs(['node', 'check', 'https://example.com', '--llm-preset', 'ollama']);
    assert.equal(opts.llmPreset, 'ollama');
  });

  it('is case-insensitive', () => {
    const opts = parseArgs(['node', 'check', 'https://example.com', '--llm-preset', 'vLLM']);
    assert.equal(opts.llmPreset, 'vllm');
  });

  it('rejects an unknown preset as a usage error', () => {
    assert.throws(
      () => parseArgs(['node', 'check', 'https://example.com', '--llm-preset', 'gpt5']),
      /Invalid --llm-preset/,
    );
  });
});

describe('llmProvider — Ollama-shaped endpoint, end to end', () => {
  it('completes a planning call against a local server with no cloud key', async () => {
    let seen = null;
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        seen = {
          url: req.url,
          auth: req.headers.authorization,
          body: JSON.parse(body),
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ flows: [{ name: 'login' }] }) } }],
        }));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    try {
      const provider = createProvider({
        SQA_LLM_PRESET: 'ollama',
        OLLAMA_BASE_URL: `http://127.0.0.1:${port}/v1`,
        OLLAMA_API_KEY: 'local',
      });
      const result = await chatJson({ system: 'plan the app', user: 'infer flows' }, { provider });

      assert.equal(result.ok, true);
      assert.equal(result.data.flows[0].name, 'login');
      assert.equal(seen.url, '/v1/chat/completions');
      assert.equal(seen.auth, 'Bearer local');
      assert.equal(seen.body.model, 'qwen2.5:7b');
      assert.deepEqual(seen.body.response_format, { type: 'json_object' });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
