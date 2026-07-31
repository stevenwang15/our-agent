// my-agent - (c) 2026 Apache-2.0 - See LICENSE file for details
/**
 * my-agent gui [file.conf]
 * Launch the modern web-based GUI.
 * 
 * If a .conf file is provided, loads that agent.
 * Otherwise, shows the agent manager/dashboard.
 */

import { loadConf } from '../conf/parser.js';
import { AgentEngine } from '../runtime/engine.js';
import { resolve } from 'path';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'gui', 'public');

/**
 * Get the HTML content, injecting agent data if available
 */
function getHTML(agentData = null) {
  let html = readFileSync(join(PUBLIC_DIR, 'index.html'), 'utf-8');

  // Inject agent data (CSS & JS already inlined in the HTML file)
  if (agentData) {
    html = html.replace('</head>', `<script>const INITIAL_AGENT = ${JSON.stringify(agentData)};</script></head>`);
  } else {
    html = html.replace('</head>', `<script>const INITIAL_AGENT = null;</script></head>`);
  }

  return html;
}

function extractAgentData(conf, absPath) {
  const engine = new AgentEngine(conf, { apiKey: '_dummy_' });
  const desc = engine.describe();
  const rawConf = readFileSync(absPath, 'utf-8');
  
  // Use engine's smart section finding to get UI config
  const icon = conf.get('ui', 'icon') ?? conf.smartGet('icon') ?? '🤖';
  const color = conf.get('ui', 'color') ?? conf.smartGet('color') ?? '#6366f1';

  return {
    name: desc.name,
    version: desc.version,
    description: desc.description,
    systemPrompt: engine._getPrompt('system', ''),
    welcome: engine._getPrompt('welcome', ''),
    temperature: desc.temperature,
    maxTokens: desc.maxTokens,
    tools: desc.tools,
    icon: icon,
    color: color,
    confPath: absPath,
    rawConf: rawConf,
  };
}

export async function guiCommand(confPath, options) {
  let agentData = null;
  
  if (confPath) {
    const absPath = resolve(confPath);
    if (!existsSync(absPath)) {
      console.error(`❌ File not found: ${confPath}`);
      process.exit(1);
    }
    const conf = loadConf(absPath);
    agentData = extractAgentData(conf, absPath);
  }

  const port = options.port || 3000;
  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    
    // API endpoints
    if (url.pathname === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, version: '1.0.0' }));
      return;
    }

    if (url.pathname === '/api/agent' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          const { prompt, apiKey, baseURL, model } = data;
          handleLLMRequest(res, prompt, apiKey, baseURL, model);
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // Export API endpoints
    if (url.pathname.startsWith('/api/export-')) {
      const confPath = url.searchParams.get('path');
      if (!confPath || !existsSync(confPath)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid path' }));
        return;
      }
      if (url.pathname === '/api/export-skill') {
        handleExportSkill(res, confPath);
      } else if (url.pathname === '/api/export-mcp') {
        handleExportMCP(res, confPath);
      } else if (url.pathname === '/api/export-build') {
        handleExportBuild(res, confPath);
      }
      return;
    }

    // Load .conf from file content
    if (url.pathname === '/api/load-conf' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          // Write to temp file first, then parse from path
          const tmpDir = resolve(process.cwd(), '.my-agent-tmp');
          if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
          const tmpPath = resolve(tmpDir, data.fileName || 'agent.conf');
          writeFileSync(tmpPath, data.content);
          const conf = loadConf(tmpPath);
          const agentData = extractAgentData(conf, tmpPath);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, agent: agentData }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: e.message }));
        }
      });
      return;
    }

    // Serve HTML
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getHTML(agentData));
  });

  server.listen(port, () => {
    console.log(`\n  🖥️  my-agent GUI`);
    console.log(`  ${'─'.repeat(30)}`);
    if (agentData) {
      console.log(`  Agent: ${agentData.name} ${agentData.icon}`);
    } else {
      console.log(`  Mode: Agent Manager`);
    }
    console.log(`  Local:   http://localhost:${port}`);
    console.log(`  `);
    console.log(`  Press Ctrl+C to stop\n`);
  });

  // Try to open browser
  try {
    const openModule = await import('open');
    await openModule.default(`http://localhost:${port}`);
  } catch {
    // Browser auto-open not available, user can open manually
  }

  // Wait for interrupt
  return new Promise((resolve) => {
    process.on('SIGINT', () => {
      console.log('\n  👋 Goodbye!\n');
      server.close();
      resolve();
      process.exit(0);
    });
  });
}

function safeFileName(name) {
  return name.replace(/[\/:*?"<>| ]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'agent';
}

async function handleExportSkill(res, confPath) {
  try {
    const { exportCommand } = await import('./export.js');
    // Mock stdout to capture result
    const outDir = resolve(process.cwd(), 'exports');
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    
    const conf = loadConf(confPath);
    const agentName = conf.get('agent', 'name', 'unnamed-agent');
    const safeName = safeFileName(agentName);
    const skillFile = resolve(outDir, `${safeName}.skill.json`);
    
    const { writeFileSync } = await import('fs');
    writeFileSync(skillFile, JSON.stringify({
      name: safeName,
      displayName: agentName,
      description: conf.get('agent', 'desc', ''),
      version: conf.get('agent', 'version', '1.0.0'),
      prompt: { system: conf.get('prompt', 'system', '') },
      schema: 'my-agent/skill/v1',
    }, null, 2));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, path: skillFile }));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

async function handleExportMCP(res, confPath) {
  try {
    const outDir = resolve(process.cwd(), 'exports');
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    
    const { exportCommand } = await import('./export.js');
    const conf = loadConf(confPath);
    const agentName = conf.get('agent', 'name', 'unnamed-agent');
    const safeName = safeFileName(agentName);
    const mcpFile = resolve(outDir, `${safeName}-mcp.json`);
    const mcpScript = resolve(outDir, `${safeName}-mcp-server.js`);
    
    const systemPrompt = conf.get('prompt', 'system', '');
    
    const mcpManifest = {
      schema: 'my-agent/mcp/v1',
      name: safeName,
      displayName: `${agentName} MCP`,
      description: conf.get('agent', 'desc', ''),
      server: {
        command: 'node',
        args: [`${safeName}-mcp-server.js`],
        env: { MY_AGENT_KEY: '', MY_AGENT_BASE_URL: '', MY_AGENT_MODEL: '' },
      },
    };

    const serverScript = `#!/usr/bin/env node
import { createInterface } from 'readline';
const SYSTEM_PROMPT = ${JSON.stringify(systemPrompt)};
const API_KEY = process.env.MY_AGENT_KEY || '';
const BASE_URL = process.env.MY_AGENT_BASE_URL || 'https://api.openai.com/v1';
const MODEL = process.env.MY_AGENT_MODEL || 'gpt-4o';
const rl = createInterface({ input: process.stdin });
const callLLM = async (prompt) => {
  const r = await fetch(BASE_URL + '/chat/completions', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': \`Bearer \${API_KEY}\` },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: prompt }] }) });
  if (!r.ok) throw new Error(\`API error \${r.status}\`);
  return (await r.json()).choices[0].message.content;
};
const respond = (id, result, error) => { const m = { jsonrpc: '2.0', id }; if (error) m.error = { code: -32000, message: error.message }; else m.result = result; process.stdout.write(JSON.stringify(m) + '\\n'); };
rl.on('line', async (line) => { try { const req = JSON.parse(line); switch(req.method) {
  case 'initialize': respond(req.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: '${safeName}', version: '1.0.0' } }); break;
  case 'tools/list': respond(req.id, { tools: [{ name: '${safeName}', description: ${JSON.stringify(conf.get('agent', 'desc', ''))}, inputSchema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] } }] }); break;
  case 'tools/call': try { const r = await callLLM(req.params.arguments.prompt); respond(req.id, { content: [{ type: 'text', text: r }] }); } catch(e) { respond(req.id, null, e); } break;
  default: respond(req.id, null, new Error('Unknown method'));
}} catch(e) {}});
process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }) + '\\n');
`;

    const { writeFileSync, chmodSync } = await import('fs');
    writeFileSync(mcpFile, JSON.stringify(mcpManifest, null, 2));
    writeFileSync(mcpScript, serverScript);
    try { chmodSync(mcpScript, 0o755); } catch {}

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, path: mcpScript }));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

async function handleExportBuild(res, confPath) {
  try {
    const outDir = resolve(process.cwd(), 'exports');
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    
    const conf = loadConf(confPath);
    const agentName = conf.get('agent', 'name', 'unnamed-agent');
    const safeName = safeFileName(agentName);
    const outputPath = resolve(outDir, `${safeName}-agent`);

    // Create standalone runner that embeds the .conf
    const confData = readFileSync(confPath, 'utf-8');
    const runnerScript = `#!/usr/bin/env node
const confData = ${JSON.stringify(confData)};
const { parseConf } = require('./src/conf/parser.cjs');
const conf = parseConf(confData, '${safeName}.conf');
const apiKey = process.env.MY_AGENT_KEY || '';
async function main() {
  if (!apiKey) {
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
    const key = await new Promise(res => rl.question('🔑 Enter API key: ', res));
    rl.close();
    if (!key) { console.error('API key required'); process.exit(1); }
    process.env.MY_AGENT_KEY = key;
  }
  const { AgentEngine } = require('./src/runtime/engine.cjs');
  const engine = new AgentEngine(conf, { apiKey: process.env.MY_AGENT_KEY });
  const args = process.argv.slice(2);
  if (args.length > 0) {
    const { result } = await engine.runPrompt(args.join(' '), []);
    console.log(result);
  } else {
    await engine.runInteractive();
  }
}
main().catch(e => { console.error('\\n❌', e.message); process.exit(1); });
`;
    writeFileSync(outputPath, runnerScript);
    try { execSync(`chmod +x "${outputPath}"`); } catch {}

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, path: outputPath }));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

async function handleLLMRequest(res, prompt, apiKey, baseURL, model) {
  if (!apiKey) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'API key is required' }));
    return;
  }

  let llm;
  let messages;
  try {
    const { LLMClient } = await import('../runtime/llm.js');
    llm = new LLMClient(apiKey, { baseURL, model });

    messages = [];
    if (prompt.systemPrompt) {
      messages.push({ role: 'system', content: prompt.systemPrompt });
    }
    if (prompt.userInput) {
      messages.push({ role: 'user', content: prompt.userInput });
    }
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
    return;
  }

  // Create the async generator with a 25s timeout signal
  const llmController = new AbortController();
  const llmTimeout = setTimeout(() => llmController.abort(), 25000);
  const gen = llm._streamRaw(messages, llmController.signal);

  try {
    // Get the first chunk – this triggers the actual external API call
    const firstResult = await gen.next();
    clearTimeout(llmTimeout);

    // API call succeeded – now send SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    if (firstResult.done) {
      res.write(`data: ${JSON.stringify({ done: true, fullText: '' })}\n\n`);
      res.end();
      return;
    }

    // Send the first chunk
    const firstChunk = firstResult.value;
    res.write(`data: ${JSON.stringify({ text: firstChunk })}\n\n`);
    let fullText = firstChunk;

    // Stream remaining chunks
    for await (const chunk of gen) {
      fullText += chunk;
      res.write(`data: ${JSON.stringify({ text: chunk })}\n\n`);
    }

    res.write(`data: ${JSON.stringify({ done: true, fullText })}\n\n`);
    res.end();
  } catch (e) {
    clearTimeout(llmTimeout);
    // Build a helpful error message
    let errorMsg = e.message;
    if (e.name === 'AbortError') {
      errorMsg = 'LLM request timed out after 25s. Check your API endpoint and network.';
    } else if (errorMsg === 'fetch failed' || errorMsg.includes('fetch')) {
      errorMsg = `Cannot reach API at ${baseURL}. Check your API key, base URL, and network connection.`;
    }

    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: errorMsg }));
    } else {
      try {
        res.write(`data: ${JSON.stringify({ error: errorMsg })}\n\n`);
        res.end();
      } catch { /* connection already closed */ }
    }
  }
}
