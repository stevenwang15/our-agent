// our-agent - (c) 2026 Apache-2.0 - See LICENSE file for details
/**
 * our-agent run <file.conf> - Run an agent from a .conf file.
 * Supports: multi-provider, tools, variable substitution, JSON mode.
 */

import { loadConf } from '../conf/parser.js';
import { AgentEngine } from '../runtime/engine.js';
import { substituteConf } from '../runtime/variables.js';
import { LLMFactory } from '../runtime/providers.js';
import { resolve } from 'path';
import { existsSync } from 'fs';

export async function runCommand(confPath, options) {
  const absPath = resolve(confPath);
  if (!existsSync(absPath)) {
    console.error(`❌ File not found: ${confPath}`);
    process.exit(1);
  }

  // Parse and substitute variables
  const conf = loadConf(absPath);
  substituteConf(conf);

  // Build engine first: the resolved provider decides whether a key is
  // needed at all (e.g. ollama needs none). Precedence: CLI flag > env > .conf
  const engine = new AgentEngine(conf, {
    apiKey: options.key || process.env.OUR_AGENT_KEY,
    provider: options.provider,
    baseURL: options.baseUrl || process.env.OUR_AGENT_BASE_URL,
    model: options.model || process.env.OUR_AGENT_MODEL,
    jsonMode: options.json,
  });

  // Get API key: CLI arg > env var > prompt (skipped for keyless providers)
  const needsKey = LLMFactory.getProviderConfig(engine.provider).auth !== 'none';
  if (!engine.apiKey && needsKey && options.interactive !== false) {
    const rl = (await import('readline/promises')).createInterface({
      input: process.stdin, output: process.stdout,
    });
    // question() never settles once stdin closes (piped input) — race it
    // against 'close' so we fall through to the friendly error below
    let onClose;
    const closed = new Promise((res) => { onClose = () => res(''); rl.once('close', onClose); });
    try {
      engine.apiKey = await Promise.race([rl.question('🔑 Enter your API key: '), closed]);
    } finally {
      rl.removeListener('close', onClose);
      rl.close();
    }
  }

  if (!engine.apiKey && needsKey) {
    console.error('❌ API key is required. Use --key, OUR_AGENT_KEY env, or run interactively.');
    process.exit(1);
  }

  const desc = engine.describe();
  console.log(`\n  🤖 ${desc.name} v${desc.version}`);
  if (desc.description) console.log(`  ${desc.description}`);
  console.log(`  ${desc.provider} / ${desc.model}`);
  if (desc.tools.length > 0) console.log(`  Tools: ${desc.tools.join(', ')}`);
  if (desc.jsonMode) console.log(`  📋 JSON mode enabled`);
  console.log('');

  if (options.prompt) {
    // One-shot mode
    let fullText = '';
    const onChunk = options.stream !== false ? (chunk) => {
      process.stdout.write(chunk);
      fullText += chunk;
    } : null;

    try {
      const { result } = await engine.runPrompt(options.prompt, [], onChunk);
      if (!onChunk) {
        console.log(result);
      } else {
        console.log('\n');
      }
    } catch (e) {
      console.error(`\n❌ Error: ${e.message}`);
      process.exit(1);
    }
  } else {
    // Interactive mode
    await engine.runInteractive();
  }
}
