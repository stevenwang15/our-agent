// our-agent - (c) 2026 Apache-2.0 - See LICENSE file for details
/**
 * LLM Client - Communicates with OpenAI-compatible APIs.
 * Keys are supplied at runtime by the user, never stored in .conf files.
 */

export class LLMClient {
  /**
   * @param {string} apiKey - User-provided API key
   * @param {object} options
   * @param {string} [options.baseURL] - API base URL (default: OpenAI)
   * @param {string} [options.model] - Model name
   */
  constructor(apiKey, options = {}) {
    if (!apiKey) throw new Error('API key is required');
    this.apiKey = apiKey;
    this.baseURL = options.baseURL || 'https://api.openai.com/v1';
    this.model = options.model || 'gpt-4o';
    this.maxTokens = options.maxTokens || 4096;
    this.temperature = options.temperature ?? 0.7;
    this.stream = options.stream !== false;
  }

  async chat(messages, onChunk = null) {
    const url = `${this.baseURL}/chat/completions`;
    const body = {
      model: this.model,
      messages,
      max_tokens: this.maxTokens,
      temperature: this.temperature,
      stream: this.stream && !!onChunk,
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const err = await response.text().catch(() => 'Unknown error');
      throw new Error(`API error ${response.status}: ${err}`);
    }

    if (this.stream && onChunk) {
      return await this._handleStream(response, onChunk);
    } else {
      const data = await response.json();
      return data.choices[0].message.content;
    }
  }

  async *_streamRaw(messages, signal = null) {
    const url = `${this.baseURL}/chat/completions`;
    const body = {
      model: this.model,
      messages,
      max_tokens: this.maxTokens,
      temperature: this.temperature,
      stream: true,
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const err = await response.text().catch(() => 'Unknown error');
      throw new Error(`API error ${response.status}: ${err}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') return;
        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.delta?.content || '';
          if (content) yield content;
        } catch { /* skip malformed chunks */ }
      }
    }
  }

  async _handleStream(response, onChunk) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullContent = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') return fullContent;
        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.delta?.content || '';
          if (content) {
            fullContent += content;
            onChunk(content);
          }
        } catch { /* skip malformed chunks */ }
      }
    }
    return fullContent;
  }
}
