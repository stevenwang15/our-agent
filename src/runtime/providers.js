// our-agent - (c) 2026 Apache-2.0 - See LICENSE file for details
/**
 * Multi-model provider support for our-agent.
 * Supports OpenAI, Anthropic, Google, DeepSeek, Ollama, and OpenRouter.
 */

// ---------------------------------------------------------------------------
// Provider definitions
// ---------------------------------------------------------------------------

const PROVIDERS = {
  openai:     { baseURL: 'https://api.openai.com/v1',                  model: 'gpt-4o',               auth: 'bearer', format: 'openai' },
  anthropic:  { baseURL: 'https://api.anthropic.com/v1',               model: 'claude-3-opus-20240229', auth: 'x-api-key', format: 'anthropic' },
  google:     { baseURL: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-1.5-pro',   auth: 'query',    format: 'google' },
  deepseek:   { baseURL: 'https://api.deepseek.com/v1',                model: 'deepseek-chat',          auth: 'bearer',   format: 'openai' },
  ollama:     { baseURL: 'http://localhost:11434/v1',                  model: 'llama3',                auth: 'none',     format: 'openai' },
  openrouter: { baseURL: 'https://openrouter.ai/api/v1',               model: 'openai/gpt-4o',         auth: 'bearer',   format: 'openai' },
};

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Build headers for a request.
 * @param {object} extra - Extra headers to merge.
 * @returns {object}
 */
function jsonHeaders(extra = {}) {
  return { 'Content-Type': 'application/json', ...extra };
}

/**
 * Throw a consolidated error for non-OK responses.
 */
async function throwOnError(response) {
  if (response.ok) return;
  const body = await response.text().catch(() => 'Unknown error');
  throw new Error(`API error ${response.status} from ${response.url}: ${body}`);
}

// ---------------------------------------------------------------------------
// Provider-specific chat implementations
// ---------------------------------------------------------------------------

/**
 * OpenAI-compatible streaming (SSE).
 */
async function chatOpenAI(baseURL, apiKey, messages, options, onChunk) {
  const model     = options.model || PROVIDERS.openai.model;
  const maxTokens = options.maxTokens ?? 4096;
  const temperature = options.temperature ?? 0.7;
  const stream = !!onChunk;

  const body = { model, messages, max_tokens: maxTokens, temperature, stream };

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const res = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  await throwOnError(res);

  if (stream) {
    return await readSSE(res, onChunk);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

/**
 * Anthropic messages API.
 */
async function chatAnthropic(baseURL, apiKey, messages, options, onChunk) {
  const model     = options.model || PROVIDERS.anthropic.model;
  const maxTokens = options.maxTokens ?? 4096;
  const temperature = options.temperature ?? 0.7;
  const stream = !!onChunk;

  // Convert generic messages to Anthropic format (system prompt extracted)
  const systemMessages = messages.filter(m => m.role === 'system');
  const nonSystem      = messages.filter(m => m.role !== 'system');
  const system         = systemMessages.map(m => m.content).join('\n');

  const body = {
    model,
    max_tokens: maxTokens,
    temperature,
    system: system || undefined,
    messages: nonSystem.map(m => ({ role: m.role, content: m.content })),
    stream,
  };

  const res = await fetch(`${baseURL}/messages`, {
    method: 'POST',
    headers: jsonHeaders({ 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }),
    body: JSON.stringify(body),
  });
  await throwOnError(res);

  if (stream) {
    return await readAnthropicStream(res, onChunk);
  }
  const data = await res.json();
  return data.content?.map(c => c.text).join('') ?? '';
}

/**
 * Google Gemini API.
 */
async function chatGoogle(baseURL, apiKey, messages, options, onChunk) {
  const model     = options.model || PROVIDERS.google.model;
  const maxTokens = options.maxTokens ?? 4096;
  const temperature = options.temperature ?? 0.7;
  const stream = !!onChunk;

  // Convert generic messages to Gemini contents format
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const body = {
    contents,
    generationConfig: { maxOutputTokens: maxTokens, temperature },
  };

  const sep = baseURL.includes('?') ? '&' : '?';
  const ep = `${baseURL}/models/${model}:streamGenerateContent${sep}key=${apiKey}`;
  const nonStreamEp = `${baseURL}/models/${model}:generateContent${sep}key=${apiKey}`;

  if (stream) {
    const res = await fetch(ep, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify(body),
    });
    await throwOnError(res);
    return await readGoogleStream(res, onChunk);
  }

  const res = await fetch(nonStreamEp, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify(body),
  });
  await throwOnError(res);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.map(p => p.text).join('') ?? '';
}

// ---------------------------------------------------------------------------
// Streaming readers
// ---------------------------------------------------------------------------

/**
 * Read SSE stream (OpenAI-compatible).
 */
async function readSSE(response, onChunk) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data: ')) continue;
      const payload = t.slice(6);
      if (payload === '[DONE]') return full;
      try {
        const parsed = JSON.parse(payload);
        const delta = parsed.choices?.[0]?.delta?.content || '';
        if (delta) {
          full += delta;
          onChunk(delta);
        }
      } catch { /* skip malformed */ }
    }
  }
  return full;
}

/**
 * Read Anthropic SSE stream (server-sent events with event types).
 *
 * Anthropic stream emits lines like:
 *   event: content_block_delta
 *   data: {"type":"content_block_delta","delta":{"text":"Hello"}}
 */
async function readAnthropicStream(response, onChunk) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let currentEvent = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const t = line.trim();
      if (t.startsWith('event: ')) {
        currentEvent = t.slice(7);
      } else if (t.startsWith('data: ')) {
        const payload = t.slice(6);
        if (currentEvent === 'content_block_delta') {
          try {
            const parsed = JSON.parse(payload);
            const text = parsed.delta?.text || '';
            if (text) {
              full += text;
              onChunk(text);
            }
          } catch { /* skip */ }
        } else if (currentEvent === 'message_stop' || currentEvent === 'error') {
          // no text content to accumulate
        }
      }
    }
  }
  return full;
}

/**
 * Read Google Gemini SSE stream.
 *
 * Each `data: ` line contains a JSON object with candidates[].content.parts[].text
 */
async function readGoogleStream(response, onChunk) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data: ')) continue;
      const payload = t.slice(6);
      if (!payload) continue;
      try {
        const parsed = JSON.parse(payload);
        const parts = parsed.candidates?.[0]?.content?.parts || [];
        for (const p of parts) {
          if (p.text) {
            full += p.text;
            onChunk(p.text);
          }
        }
      } catch { /* skip */ }
    }
  }
  return full;
}

// ---------------------------------------------------------------------------
// LLMFactory
// ---------------------------------------------------------------------------

export class LLMFactory {
  /**
   * Get configuration for a provider.
   * @param {string} provider
   * @returns {object}
   */
  static getProviderConfig(provider) {
    const cfg = PROVIDERS[provider];
    if (!cfg) throw new Error(`Unsupported provider: ${provider}. Use listProviders() to see available options.`);
    return { ...cfg };
  }

  /**
   * Send a chat completion request.
   *
   * @param {string}   provider  - Provider name.
   * @param {string}   apiKey    - API key (may be empty for Ollama).
   * @param {object[]} messages  - Array of { role, content }.
   * @param {object}   [options] - { model?, maxTokens?, temperature? }.
   * @param {function} [onChunk] - Callback receiving text deltas when streaming.
   * @returns {Promise<string>} Full response text.
   */
  static async chat(provider, apiKey, messages, options = {}, onChunk = null) {
    const cfg = LLMFactory.getProviderConfig(provider);
    const baseURL = cfg.baseURL;
    const opts = { model: options.model || cfg.model, maxTokens: options.maxTokens, temperature: options.temperature };

    switch (cfg.format) {
      case 'openai':
        return chatOpenAI(baseURL, apiKey, messages, opts, onChunk);
      case 'anthropic':
        return chatAnthropic(baseURL, apiKey, messages, opts, onChunk);
      case 'google':
        return chatGoogle(baseURL, apiKey, messages, opts, onChunk);
      default:
        throw new Error(`Unknown format: ${cfg.format}`);
    }
  }

  /**
   * List available providers with descriptions.
   * @returns {object[]}
   */
  static listProviders() {
    const descriptions = {
      openai:     'OpenAI GPT-4o and other models (Bearer auth)',
      anthropic:  'Anthropic Claude models (x-api-key auth)',
      google:     'Google Gemini models (API key in query param)',
      deepseek:   'DeepSeek Chat models (OpenAI-compatible)',
      ollama:     'Local Ollama models (no auth required)',
      openrouter: 'OpenRouter unified API (OpenAI-compatible)',
    };

    return Object.entries(PROVIDERS).map(([name, cfg]) => ({
      name,
      description: descriptions[name] || '',
      baseURL: cfg.baseURL,
      defaultModel: cfg.model,
    }));
  }

  /**
   * Quick validation: send a single-turn request with max_tokens=1 (non-streaming).
   *
   * @param {string} provider
   * @param {string} apiKey
   * @returns {Promise<{ valid: boolean, error?: string }>}
   */
  static async validateKey(provider, apiKey) {
    try {
      const messages = [{ role: 'user', content: 'Reply with just "ok".' }];
      const text = await LLMFactory.chat(provider, apiKey, messages, { maxTokens: 1 }, null);
      return { valid: text.length > 0 };
    } catch (err) {
      return { valid: false, error: err.message };
    }
  }
}
