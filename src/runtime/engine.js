// our-agent - (c) 2026 Apache-2.0 - See LICENSE file for details
/**
 * Agent Engine - Executes agents defined in .conf files.
 * Supports: multi-provider, tools, sessions, structured output, chaining.
 */

import { LLMFactory } from './providers.js';
import { ToolRegistry, loadToolFromConf, getToolDescriptions, executeToolCall } from './tools.js';
import { substituteConf } from './variables.js';
import { createInterface } from 'readline/promises';
import { saveSession, listSessions, printSessions } from './session.js';

export class AgentEngine {
  constructor(confDoc, options = {}) {
    this.conf = confDoc;
    this.apiKey = options.apiKey;
    this.agentName = this._getSmart('agent', 'name', 'Agent');
    this.provider = options.provider || this._getSetting('provider', 'openai');
    this.baseURL = options.baseURL || this._getSetting('base_url', '');
    this.model = options.model || this._getSetting('model', '');
    this.temperature = this._getSetting('temperature', 0.7);
    this.maxTokens = this._getSetting('max_tokens', 4096);
    this.stream = this._getSetting('stream', true);
    this.jsonMode = options.jsonMode ?? (this._getSetting('json_mode', false) || this._getSetting('json', false));

    // Tool system
    this.toolRegistry = new ToolRegistry();
    this.toolsEnabled = loadToolFromConf(confDoc);
    this._initSession();
  }

  // ---- Smart section lookup (brace + bracket compatible) ----
  _getSmart(section, key, def = undefined) {
    const v = this.conf.get(section, key);
    if (v !== undefined && v !== null) return v;
    const first = this._firstSection();
    if (first) {
      const d = this.conf.get(`${first}.${section}`, key);
      if (d !== undefined && d !== null) return d;
    }
    return this.conf.smartGet(key, def);
  }

  _firstSection() {
    return this.conf.sectionsList().filter(s => s !== '_root')[0] || null;
  }

  _getSetting(key, def) {
    return this._getSmart('settings', key, def);
  }

  _getPrompt(key, def = '') {
    return this._getSmart('prompt', key, def);
  }

  _initSession() {
    this.messages = [];
    this.sessionId = null;
  }

  // ---- Build messages with system prompt ----
  _buildMessages(userInput, history = []) {
    const systemPrompt = this._getPrompt('system', '');
    const welcome = this._getPrompt('welcome', '');
    const decorators = this._getDecorators();

    const messages = [...history];

    if (systemPrompt || this.jsonMode) {
      let fullSystem = systemPrompt || '';
      if (decorators.beforeReply) fullSystem += (fullSystem ? '\n\n' : '') + decorators.beforeReply;
      if (decorators.afterReply) fullSystem += (fullSystem ? '\n\n' : '') + decorators.afterReply;

      // Add tool instructions if tools are enabled
      if (this.toolsEnabled.length > 0) {
        fullSystem += (fullSystem ? '\n\n' : '') + `You have access to the following tools:\n${this.toolsEnabled.map(t => `- ${t}: ${this._getToolDesc(t)}`).join('\n')}\nWhen you need to use a tool, respond with a JSON block: \`\`\`tool\n{"name": "tool_name", "arguments": {...}}\n\`\`\``;
      }

      // OpenAI-style JSON mode requires the word "json" in the messages
      if (this.jsonMode) {
        fullSystem += (fullSystem ? '\n\n' : '') + 'Respond with valid JSON only.';
      }

      messages.unshift({ role: 'system', content: fullSystem });
    }

    if (userInput) {
      messages.push({ role: 'user', content: userInput });
    }

    return { messages, welcome };
  }

  _getDecorators() {
    return {
      beforeReply: this._getPrompt('before_reply', ''),
      afterReply: this._getPrompt('after_reply', ''),
    };
  }

  _getToolDesc(name) {
    const tool = this.toolRegistry.get(name);
    return tool ? tool.description : 'a tool';
  }

  // ---- Call LLM with provider routing ----
  async _callLLM(messages, onChunk) {
    const providerConfig = LLMFactory.getProviderConfig(this.provider);
    const model = this.model || providerConfig.defaultModel;

    return await LLMFactory.chat(this.provider, this.apiKey, messages, {
      baseURL: this.baseURL,
      model,
      maxTokens: this.maxTokens,
      temperature: this.temperature,
      jsonMode: this.jsonMode,
    }, onChunk);
  }

  // ---- Detect and execute tool calls in LLM output ----
  async _processToolCalls(text) {
    // Look for ```tool\n{...}\n``` blocks
    const toolRegex = /```tool\n([\s\S]*?)```/g;
    let match;
    let result = text;

    while ((match = toolRegex.exec(text)) !== null) {
      const block = match[0];
      let toolCall = null;
      try {
        toolCall = JSON.parse(match[1].trim());
      } catch {
        // Malformed JSON — handled below
      }

      if (toolCall && toolCall.name && this.toolRegistry.get(toolCall.name)) {
        const toolResult = await executeToolCall(this.toolRegistry, toolCall);
        // Replace the tool block with the result (executeToolCall returns
        // { role, content, ... } — use .content, not the object itself)
        result = result.replace(block, `\n[Tool: ${toolCall.name}]\n${toolResult.content}\n[/Tool]\n`);
      } else if (toolCall && toolCall.name) {
        // Never leave raw ```tool JSON visible to the user
        result = result.replace(block, `[Tool error: unknown tool "${toolCall.name}"]`);
      } else {
        result = result.replace(block, '[Tool error: malformed tool call]');
      }
    }

    return result;
  }

  // Providers with auth: 'none' (e.g. ollama) never require a key
  _needsApiKey() {
    return LLMFactory.getProviderConfig(this.provider).auth !== 'none';
  }

  // ---- Run a single prompt ----
  async runPrompt(userInput, history = [], onChunk = null) {
    if (!this.apiKey && this._needsApiKey()) {
      throw new Error('API key required. Use --key or OUR_AGENT_KEY env.');
    }

    const { messages } = this._buildMessages(userInput, history);

    // Tool blocks are rewritten after the fact, so stream only when there is
    // nothing to rewrite — otherwise raw ```tool JSON hits the terminal.
    const streamable = this.toolsEnabled.length === 0;

    let fullResult;
    if (onChunk && streamable) {
      fullResult = await this._callLLM(messages, onChunk);
    } else {
      fullResult = await this._callLLM(messages, null);
    }

    // Process tool calls in result
    fullResult = await this._processToolCalls(fullResult);

    // Deliver the rewritten text when it could not be streamed chunk by chunk
    if (onChunk && !streamable) onChunk(fullResult);

    return { result: fullResult };
  }

  // ---- Interactive REPL ----
  async runInteractive() {
    if (!this.apiKey && this._needsApiKey()) throw new Error('API key required.');

    const name = this.conf.get('agent', 'name', 'Agent');
    const welcome = this._getPrompt('welcome', `Hello! I am ${name}, how can I help you?`);

    // Banner
    const providerConfig = LLMFactory.getProviderConfig(this.provider);
    const model = this.model || providerConfig.defaultModel;
    const modelLine = this.baseURL ? `${this.provider} / ${model}` : model;

    const bar = '─'.repeat(Math.max(name.length + 4, 36));
    console.log(`\n  ╭${bar}╮`);
    console.log(`  │  🤖 ${name.padEnd(name.length + 2)}│`);
    console.log(`  ├${bar}┤`);
    console.log(`  │  Model:  ${modelLine.padEnd(26)}│`);
    console.log(`  │  Temp:   ${String(this.temperature).padEnd(26)}│`);
    console.log(`  │  Tools:  ${(this.toolsEnabled.length > 0 ? this.toolsEnabled.join(', ') : 'none').padEnd(26)}│`);
    console.log(`  ╰${bar}╯\n`);
    console.log(`  ${welcome}\n`);
    console.log(`  Commands: /exit  /clear  /save  /sessions  /help\n`);

    const history = [];
    this.messages = [];
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    // question() never settles once stdin closes; resolve to null so a piped
    // stdin exits the loop cleanly instead of hanging the process
    const stdinClosed = new Promise((res) => rl.once('close', () => res(null)));

    try {
      while (true) {
        const input = await Promise.race([rl.question('  You > '), stdinClosed]);
        if (input === null) break;
        if (!input.trim()) continue;

        const cmd = input.toLowerCase().trim();

        if (cmd === '/exit' || cmd === '/quit') break;

        if (cmd === '/clear' || cmd === '/reset') {
          history.length = 0;
          this.messages = [];
          console.log('  ── Conversation reset ──\n');
          continue;
        }

        if (cmd === '/save') {
          const path = saveSession(name, history);
          console.log(`  ✅ Saved: ${path}\n`);
          continue;
        }

        if (cmd === '/sessions') {
          printSessions(name);
          continue;
        }

        if (cmd === '/help') {
          console.log('  Commands:');
          console.log('    /exit     - Exit the session');
          console.log('    /clear    - Clear conversation history');
          console.log('    /save     - Save session to disk');
          console.log('    /sessions - List saved sessions');
          console.log('    /help     - Show this help\n');
          continue;
        }

        const { messages } = this._buildMessages(input, history);

        // Stream only when there is no tool block to rewrite afterwards
        const streamable = this.toolsEnabled.length === 0;
        process.stdout.write('  AI > ');
        const onChunk = streamable ? (chunk) => process.stdout.write(chunk) : null;

        try {
          let full = await this._callLLM(messages, onChunk);
          full = await this._processToolCalls(full);
          if (!onChunk) process.stdout.write(full);

          console.log('\n');
          history.push({ role: 'user', content: input });
          history.push({ role: 'assistant', content: full });
          this.messages = history;
        } catch (e) {
          console.error(`\n  ❌ Error: ${e.message}\n`);
        }
      }
    } finally {
      // Auto-save on exit
      if (history.length > 0) {
        try {
          saveSession(name, history, { provider: this.provider, model });
        } catch {}
      }
      rl.close();
    }
    console.log('');
  }

  // ---- Describe the agent ----
  describe() {
    const sysPrompt = this._getPrompt('system', '');
    return {
      name: this.conf.get('agent', 'name', 'Unnamed Agent'),
      version: this.conf.get('agent', 'version', '1.0.0'),
      description: this.conf.get('agent', 'desc', ''),
      provider: this.provider,
      model: this.model || LLMFactory.getProviderConfig(this.provider).defaultModel,
      temperature: this.temperature,
      maxTokens: this.maxTokens,
      stream: this.stream,
      jsonMode: this.jsonMode,
      tools: this.toolsEnabled,
      systemPrompt: (sysPrompt || '').slice(0, 200) + (sysPrompt.length > 200 ? '...' : ''),
    };
  }
}
