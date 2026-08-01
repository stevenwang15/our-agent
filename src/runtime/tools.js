// our-agent - (c) 2026 Apache-2.0 - See LICENSE file for details
/**
 * Tool Execution System - Registry, built-in tools, and helper functions
 * for executing tools in response to LLM function calls.
 */

import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from 'fs';
import { resolve, relative, sep, isAbsolute } from 'path';
import { execSync } from 'child_process';

// ---------------------------------------------------------------------------
// Path validation
// ---------------------------------------------------------------------------

function isPathSafe(targetPath, allowedDirs) {
  const resolved = resolve(targetPath);
  const allowed = allowedDirs.map(d => resolve(d));
  // Reject paths containing '..' segments that would escape
  const normalized = resolve(targetPath);
  if (!allowed.some(dir => normalized.startsWith(dir + sep) || normalized === dir)) {
    return false;
  }
  // Extra check: the target must not contain a '..' segment that resolves outside
  return true;
}

function assertSafePath(targetPath, allowedDirs) {
  if (!isPathSafe(targetPath, allowedDirs)) {
    throw new Error(`Access denied: "${targetPath}" is outside allowed directories`);
  }
}

function getDefaultAllowedDirs() {
  return [process.cwd()];
}

// ---------------------------------------------------------------------------
// Built-in tool implementations
// ---------------------------------------------------------------------------

const builtinTools = {
  web_search: {
    description: 'Search the web for information using DuckDuckGo',
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query' },
        count: { type: 'number', description: 'Number of results (default 5)', default: 5 },
      },
      required: ['query'],
    },
    async handler(args) {
      const query = String(args.query ?? '');
      const count = Math.min(Math.max(Number(args.count) || 5, 1), 20);
      // Use duck-duck-scrape library (MIT license, no API key needed)
      const { search, SafeSearchType } = await import('duck-duck-scrape');
      const result = await search(query, {
        safeSearch: SafeSearchType.STRICT,
      });
      const rawResults = result.results || [];
      const items = rawResults.slice(0, count).map(r => ({
        title: r.title || '',
        snippet: (r.description || '').replace(/<[^>]+>/g, ''),
        url: r.url || '',
      }));
      if (items.length === 0) {
        return { results: [], message: 'No results found.' };
      }
      return { results: items };
    },
  },

  read_file: {
    description: 'Read the contents of a file from the local filesystem',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file (relative or absolute)' },
      },
      required: ['path'],
    },
    handler(args) {
      const targetPath = String(args.path ?? '');
      const allowedDirs = getDefaultAllowedDirs();
      assertSafePath(targetPath, allowedDirs);
      const fullPath = resolve(targetPath);
      if (!existsSync(fullPath)) {
        throw new Error(`File not found: "${fullPath}"`);
      }
      const buf = readFileSync(fullPath);
      // Heuristic for binary content: check for null bytes
      if (buf.includes(0)) {
        return { content: `[Binary file: ${relative(process.cwd(), fullPath)} — cannot display content]` };
      }
      return { content: buf.toString('utf-8') };
    },
  },

  write_file: {
    description: 'Write content to a file on the local filesystem',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path where to write the file' },
        content: { type: 'string', description: 'Content to write' },
      },
      required: ['path', 'content'],
    },
    handler(args) {
      const targetPath = String(args.path ?? '');
      const content = String(args.content ?? '');
      const allowedDirs = getDefaultAllowedDirs();
      assertSafePath(targetPath, allowedDirs);
      const fullPath = resolve(targetPath);
      if (existsSync(fullPath)) {
        const stats = statSync(fullPath);
        if (stats.isFile()) {
          console.warn(`[tools] Warning: Overwriting existing file "${fullPath}"`);
        }
      }
      writeFileSync(fullPath, content, 'utf-8');
      return { success: true, path: fullPath, size: content.length };
    },
  },

  list_files: {
    description: 'List files and directories at a given path',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path (defaults to current directory)', default: '.' },
      },
    },
    handler(args) {
      const targetPath = String(args.path ?? '.');
      const allowedDirs = getDefaultAllowedDirs();
      assertSafePath(targetPath, allowedDirs);
      const fullPath = resolve(targetPath);
      if (!existsSync(fullPath)) {
        throw new Error(`Directory not found: "${fullPath}"`);
      }
      const stats = statSync(fullPath);
      if (!stats.isDirectory()) {
        throw new Error(`Not a directory: "${fullPath}"`);
      }
      const entries = readdirSync(fullPath);
      const items = entries.map(name => {
        const abs = resolve(fullPath, name);
        let isDir = false;
        let size = 0;
        try {
          const s = statSync(abs);
          isDir = s.isDirectory();
          size = s.size;
        } catch {
          // Permission or other error reading stats
        }
        return { name, type: isDir ? 'directory' : 'file', size };
      });
      // Sort: directories first, then files, alphabetically
      items.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      return {
        path: fullPath,
        items,
        total: items.length,
      };
    },
  },

  execute_command: {
    description: 'Execute a shell command and return its output',
    schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to run' },
        timeout: { type: 'number', description: 'Timeout in milliseconds (default 10000)', default: 10000 },
      },
      required: ['command'],
    },
    handler(args) {
      const command = String(args.command ?? '');
      const timeout = Math.max(1, Number(args.timeout) || 10000);
      console.warn(`[tools] Executing command: ${command}`);
      const start = performance.now();
      let stdout = '';
      let stderr = '';
      let exitCode = -1;
      try {
        const result = execSync(command, {
          encoding: 'utf-8',
          timeout,
          maxBuffer: 10 * 1024 * 1024, // 10 MB
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        stdout = result;
        exitCode = 0;
      } catch (err) {
        if (err.stdout) stdout = String(err.stdout);
        if (err.stderr) stderr = String(err.stderr);
        exitCode = err.status ?? -1;
        if (err.signal === 'SIGTERM' || err.killed) {
          stderr = (stderr ? stderr + '\n' : '') + `Command timed out after ${timeout}ms`;
        }
      }
      const elapsed = Math.round(performance.now() - start);
      console.warn(`[tools] Command finished in ${elapsed}ms (exit code: ${exitCode})`);
      return { stdout, stderr, exitCode, elapsed };
    },
  },

  current_time: {
    description: 'Get the current date and time',
    schema: {
      type: 'object',
      properties: {
        format: {
          type: 'string',
          description: 'Output format: "iso" (default), "unix" (epoch seconds), or "local" (locale string)',
          enum: ['iso', 'unix', 'local'],
          default: 'iso',
        },
      },
    },
    handler(args) {
      const now = new Date();
      const format = String(args.format ?? 'iso');
      let value;
      switch (format) {
        case 'unix':
          value = Math.floor(now.getTime() / 1000);
          break;
        case 'local':
          value = now.toLocaleString();
          break;
        case 'iso':
        default:
          value = now.toISOString();
          break;
      }
      return {
        format,
        value,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        timestamp: now.toISOString(),
      };
    },
  },
};

// ---------------------------------------------------------------------------
// ToolRegistry
// ---------------------------------------------------------------------------

export class ToolRegistry {
  constructor() {
    /** @type {Map<string, { handler: Function, description: string, schema: object }>} */
    this.tools = new Map();

    // Register built-in tools
    for (const [name, def] of Object.entries(builtinTools)) {
      this.register(name, def.handler, def.description, def.schema);
    }
  }

  register(name, handler, description, schema = {}) {
    if (typeof handler !== 'function') {
      throw new Error(`Tool "${name}" handler must be a function`);
    }
    this.tools.set(name, { handler, description, schema });
  }

  get(name) {
    return this.tools.get(name) || null;
  }

  list() {
    const entries = [];
    for (const [name, def] of this.tools) {
      entries.push({
        name,
        description: def.description,
        schema: def.schema,
      });
    }
    return entries;
  }

  async call(name, args = {}) {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Unknown tool: "${name}"`);
    }
    try {
      const result = await tool.handler(args);
      return { name, success: true, result };
    } catch (err) {
      return { name, success: false, error: err.message || String(err) };
    }
  }
}

// ---------------------------------------------------------------------------
// Conf helpers
// ---------------------------------------------------------------------------

/**
 * Read the allowed tool list from a parsed .conf document.
 * Supports both bracket-style [tools] and brace-style agent.tools sections.
 *
 * @param {import('../conf/parser.js').ConfDocument} confDoc
 * @returns {string[]} Array of tool names allowed for this agent
 */
export function loadToolFromConf(confDoc) {
  // Try bracket style: [tools] allow = [...]
  let tools = confDoc.get('tools', 'allow');
  if (tools === undefined) {
    // Try brace style: agent.tools or settings.tools
    tools = confDoc.deepGet('agent', 'tools');
  }
  if (tools === undefined) {
    // Try dot-separated smart lookup
    const val = confDoc.smartGet('allow');
    tools = val;
  }
  if (tools === undefined) {
    return [];
  }
  if (Array.isArray(tools)) {
    return tools;
  }
  if (typeof tools === 'string') {
    return tools.split(',').map(s => s.trim()).filter(Boolean);
  }
  return [];
}

/**
 * Build tool descriptions in OpenAI function-calling format.
 * Only includes tools listed in the conf document's allowed list.
 *
 * @param {import('../conf/parser.js').ConfDocument} confDoc
 * @returns {object[]} Array of tool objects suitable for `tools` in an LLM request
 */
export function getToolDescriptions(confDoc) {
  const allowed = loadToolFromConf(confDoc);
  if (allowed.length === 0) return [];

  const registry = new ToolRegistry();
  const allTools = registry.list();

  // If allowed contains '*', return all built-in tools
  if (allowed.includes('*')) {
    return allTools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.schema,
      },
    }));
  }

  return allTools
    .filter(t => allowed.includes(t.name))
    .map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.schema,
      },
    }));
}

/**
 * Execute a tool call from an LLM response and format the result.
 *
 * @param {ToolRegistry} registry - The tool registry
 * @param {{ name: string, arguments: string|object }} toolCall - Tool call object from LLM
 * @returns {Promise<{ role: string, content: string, tool_call_id?: string }>}
 */
export async function executeToolCall(registry, toolCall) {
  const name = toolCall.name || toolCall.function?.name;
  let args = toolCall.arguments || toolCall.function?.arguments || {};

  // Parse arguments if they come as a JSON string
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      args = {};
    }
  }

  const result = await registry.call(name, args);

  let content;
  if (result.success) {
    content = JSON.stringify(result.result, null, 2);
  } else {
    content = JSON.stringify({ error: result.error }, null, 2);
  }

  return {
    role: 'tool',
    content,
    tool_call_id: toolCall.id || toolCall.tool_call_id || `call_${name}_${Date.now()}`,
  };
}
