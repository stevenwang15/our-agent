// my-agent - (c) 2026 Apache-2.0 - See LICENSE file for details
/**
 * my-agent run <file.conf> - Run an agent from a .conf file.
 * Supports: multi-provider, tools, variable substitution, JSON mode.
 */

import { loadConf } from '../conf/parser.js';
import { AgentEngine } from '../runtime/engine.js';
import { substituteConf } from '../runtime/variables.js';
import { listSessions, loadSession, printSessions } from '../runtime/session.js';
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

  // Get API key: CLI arg > env var > prompt
  let apiKey = options.key || process.env.MY_AGENT_KEY;
  if (!apiKey && options.interactive !== false) {
    const rl = (await import('readline/promises')).createInterface({
      input: process.stdin, output: process.stdout,
    });
    apiKey = await rl.question('🔑 Enter your API key: ');
    rl.close();
  }

  if (!apiKey) {
    console.error('❌ API key is required. Use --key, MY_AGENT_KEY env, or run interactively.');
    process.exit(1);
  }

  // Build engine with provider support
  const engine = new AgentEngine(conf, {
    apiKey,
    provider: options.provider,
    baseURL: options.baseURL,
    model: options.model,
    jsonMode: options.json,
  });

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
