// my-agent - (c) 2026 Apache-2.0 - See LICENSE file for details
/**
 * my-agent export <file.conf>
 * Export an agent definition as a reusable Skill or MCP server.
 */

import { loadConf } from '../conf/parser.js';
import { resolve } from 'path';
import { existsSync, writeFileSync, mkdirSync } from 'fs';

/** Smart section lookup: supports both [bracket] and name { brace } styles */
function smartGet(conf, section, key, def = undefined) {
  // Direct section (bracket style)
  let val = conf.get(section, key);
  if (val !== undefined && val !== null) return val;

  // Dotted section (brace style) - try first agent section
  const firstSection = conf.sectionsList().filter(s => s !== '_root')[0];
  if (firstSection) {
    val = conf.get(`${firstSection}.${section}`, key);
    if (val !== undefined && val !== null) return val;
  }

  // Global search
  return conf.smartGet(key, def);
}

export async function exportCommand(confPath, options) {
  const absPath = resolve(confPath);
  if (!existsSync(absPath)) {
    console.error(`❌ File not found: ${confPath}`);
    process.exit(1);
  }

  const conf = loadConf(absPath);
  const format = options.format || 'all';
  const outputDir = resolve(options.output || '.');

  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const agentName = conf.get('agent', 'name', 'unnamed-agent');
  const agentDesc = smartGet(conf, 'agent', 'desc', '') || conf.get('agent', 'desc', '');
  const systemPrompt = smartGet(conf, 'prompt', 'system', '');

  const results = [];

  if (format === 'skill' || format === 'all') {
    const skillPath = await exportSkill(agentName, agentDesc, systemPrompt, conf, outputDir);
    results.push({ format: 'Skill', path: skillPath });
  }

  if (format === 'mcp' || format === 'all') {
    const mcpPath = await exportMCP(agentName, agentDesc, systemPrompt, conf, outputDir);
    results.push({ format: 'MCP Server', path: mcpPath });
  }

  console.log(`\n  📤 Exported "${agentName}"\n`);
  for (const r of results) {
    console.log(`  ✅ ${r.format}: ${r.path}`);
  }
  console.log('');
}

function safeFileName(name) {
  // Remove shell special chars and unsafe filename chars, replace with '-'
  return name
    .replace(/[\$@!%^&*()\[\]{}:;'"\/\\<>|?`~#=+]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase() || 'agent';
}

async function exportSkill(agentName, agentDesc, systemPrompt, conf, outputDir) {
  const safeName = safeFileName(agentName);
  const skillFile = resolve(outputDir, `${safeName}.skill.json`);

  const skill = {
    schema: 'my-agent/skill/v1',
    name: safeName,
    displayName: agentName,
    description: agentDesc || `Agent: ${agentName}`,
    version: conf.get('agent', 'version', '1.0.0'),

    prompt: {
      system: systemPrompt,
      welcome: smartGet(conf, 'prompt', 'welcome', ''),
      before_reply: smartGet(conf, 'prompt', 'before_reply', ''),
      after_reply: smartGet(conf, 'prompt', 'after_reply', ''),
    },

    settings: {
      temperature: smartGet(conf, 'settings', 'temperature', 0.7),
      max_tokens: smartGet(conf, 'settings', 'max_tokens', 4096),
      stream: smartGet(conf, 'settings', 'stream', true),
      interactive: smartGet(conf, 'settings', 'interactive', false),
    },

    tools: {
      allow: smartGet(conf, 'tools', 'allow', []),
    },

    ui: (conf.hasSection('ui') || conf.findSectionWith('icon')) ? {
      icon: smartGet(conf, 'ui', 'icon', '🤖'),
      color: smartGet(conf, 'ui', 'color', '#6366f1'),
      theme: smartGet(conf, 'ui', 'theme', 'modern'),
    } : undefined,

    usage: {
      runtime: 'my-agent run <file.conf>',
      environment: {
        MY_AGENT_KEY: 'Your API key',
        MY_AGENT_BASE_URL: 'Optional: API base URL override',
        MY_AGENT_MODEL: 'Optional: model override',
      },
    },
  };

  writeFileSync(skillFile, JSON.stringify(skill, null, 2));
  return skillFile;
}

async function exportMCP(agentName, agentDesc, systemPrompt, conf, outputDir) {
  const safeName = safeFileName(agentName);
  const mcpFile = resolve(outputDir, `${safeName}-mcp.json`);
  const mcpScript = resolve(outputDir, `${safeName}-mcp-server.js`);

  const mcpManifest = {
    schema: 'my-agent/mcp/v1',
    name: safeName,
    displayName: `${agentName} MCP`,
    description: agentDesc || `MCP server wrapping agent: ${agentName}`,
    version: conf.get('agent', 'version', '1.0.0'),

    server: {
      command: 'node',
      args: [safeName + '-mcp-server.js'],
      env: {
        MY_AGENT_KEY: '',
        MY_AGENT_BASE_URL: '',
        MY_AGENT_MODEL: '',
      },
    },

    tools: [
      {
        name: safeName,
        description: agentDesc || agentName,
        input_schema: {
          type: 'object',
          properties: {
            prompt: {
              type: 'string',
              description: 'Input prompt for the agent',
            },
          },
          required: ['prompt'],
        },
      },
    ],
  };

  const maxTokens = smartGet(conf, 'settings', 'max_tokens', 4096);
  const temperature = smartGet(conf, 'settings', 'temperature', 0.7);

  const serverScript = `#!/usr/bin/env node
// my-agent MCP Server for "${agentName}"

import { createInterface } from 'readline';

const SYSTEM_PROMPT = ${JSON.stringify(systemPrompt)};
const API_KEY = process.env.MY_AGENT_KEY || '';
const BASE_URL = process.env.MY_AGENT_BASE_URL || 'https://api.openai.com/v1';
const MODEL = process.env.MY_AGENT_MODEL || 'gpt-4o';

const rl = createInterface({ input: process.stdin });

async function callLLM(prompt) {
  const response = await fetch(BASE_URL + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': \`Bearer \${API_KEY}\`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      max_tokens: ${maxTokens},
      temperature: ${temperature},
    }),
  });

  if (!response.ok) {
    throw new Error(\`API error: \${response.status}\`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

function respond(id, result, error) {
  const msg = { jsonrpc: '2.0', id };
  if (error) msg.error = { code: -32000, message: error.message };
  else msg.result = result;
  process.stdout.write(JSON.stringify(msg) + '\\n');
}

rl.on('line', async (line) => {
  try {
    const req = JSON.parse(line);
    const { id, method, params } = req;

    switch (method) {
      case 'initialize':
        respond(id, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: '${safeName}', version: '${conf.get('agent', 'version', '1.0.0')}' },
        });
        break;

      case 'tools/list':
        respond(id, {
          tools: [
            {
              name: '${safeName}',
              description: ${JSON.stringify(agentDesc || agentName)},
              inputSchema: {
                type: 'object',
                properties: {
                  prompt: { type: 'string', description: 'Input prompt for the agent' },
                },
                required: ['prompt'],
              },
            },
          ],
        });
        break;

      case 'tools/call':
        try {
          const prompt = params.arguments?.prompt || '';
          const result = await callLLM(prompt);
          respond(id, {
            content: [{ type: 'text', text: result }],
          });
        } catch (e) {
          respond(id, null, e);
        }
        break;

      default:
        respond(id, null, new Error(\`Unknown method: \${method}\`));
    }
  } catch (e) {
    // Malformed JSON, skip
  }
});

// Send initialized notification
process.stdout.write(JSON.stringify({
  jsonrpc: '2.0',
  method: 'initialized',
  params: {},
}) + '\\n');
`;

  writeFileSync(mcpFile, JSON.stringify(mcpManifest, null, 2));
  writeFileSync(mcpScript, serverScript);

  // Make executable
  try {
    const { execSync } = await import('child_process');
    execSync(`chmod +x "${mcpScript}"`);
  } catch {}

  return mcpScript;
}
