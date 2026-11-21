// Provider request wiring tests: base URL override, JSON mode, and API-key
// hygiene. globalThis.fetch is stubbed — no network, no real keys.
//
//   node --test test/
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { LLMFactory } from '../src/runtime/providers.js';

const realFetch = globalThis.fetch;
let calls = [];

afterEach(() => {
  globalThis.fetch = realFetch;
  calls = [];
});

function stubFetch({ ok = true, status = 200, body = {}, url = null } = {}) {
  globalThis.fetch = async (rawUrl, init = {}) => {
    const finalUrl = url || String(rawUrl);
    calls.push({ url: finalUrl, init });
    return {
      ok,
      status,
      url: finalUrl,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
}

const MSGS = [{ role: 'user', content: 'hi' }];

describe('base URL override', () => {
  test('options.baseURL wins over the provider default', async () => {
    stubFetch({ body: { choices: [{ message: { content: 'ok' } }] } });
    await LLMFactory.chat('openai', 'key', MSGS, { baseURL: 'http://localhost:9999/v1' }, null);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.startsWith('http://localhost:9999/v1/'), calls[0].url);
  });

  test('without an override the provider default is used', async () => {
    stubFetch({ body: { choices: [{ message: { content: 'ok' } }] } });
    await LLMFactory.chat('openai', 'key', MSGS, {}, null);
    assert.ok(calls[0].url.startsWith('https://api.openai.com/v1/'), calls[0].url);
  });
});

describe('JSON mode', () => {
  test('jsonMode adds response_format to openai-format requests', async () => {
    stubFetch({ body: { choices: [{ message: { content: '{}' } }] } });
    await LLMFactory.chat('openai', 'key', MSGS, { jsonMode: true }, null);
    const body = JSON.parse(calls[0].init.body);
    assert.deepEqual(body.response_format, { type: 'json_object' });
  });

  test('no response_format unless jsonMode is set', async () => {
    stubFetch({ body: { choices: [{ message: { content: 'ok' } }] } });
    await LLMFactory.chat('openai', 'key', MSGS, {}, null);
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.response_format, undefined);
  });
});

describe('API key handling', () => {
  test('google sends the key as a header, never in the URL', async () => {
    stubFetch({ body: {} });
    await LLMFactory.chat('google', 'SECRET-KEY-123', MSGS, {}, null);
    assert.equal(calls[0].init.headers['x-goog-api-key'], 'SECRET-KEY-123');
    assert.ok(!calls[0].url.includes('SECRET-KEY-123'), calls[0].url);
  });

  test('error messages redact key= query parameters', async () => {
    stubFetch({ ok: false, status: 401, body: { error: 'bad key' }, url: 'https://example.com/v1?key=SECRET-KEY-123' });
    await assert.rejects(
      () => LLMFactory.chat('openai', 'key', MSGS, {}, null),
      (err) => {
        assert.match(err.message, /API error 401/);
        assert.match(err.message, /key=\*\*\*/);
        assert.ok(!err.message.includes('SECRET-KEY-123'), err.message);
        return true;
      },
    );
  });

  test('an unknown provider lists the available ones', () => {
    assert.throws(
      () => LLMFactory.getProviderConfig('nope'),
      (err) => /Unsupported provider: nope/.test(err.message) && /openai/.test(err.message),
    );
  });

  test('provider config exposes defaultModel for the engine banner', () => {
    assert.equal(LLMFactory.getProviderConfig('openai').defaultModel, 'gpt-4o');
    assert.equal(LLMFactory.getProviderConfig('anthropic').defaultModel, 'claude-3-opus-20240229');
  });
});
