// our-agent - (c) 2026 Apache-2.0 - See LICENSE file for details
/**
 * our-agent build <file.conf>
 * Package an agent into a standalone executable.
 *
 * Uses the system's Node.js (via pkg or ncc) to create cross-platform binaries.
 * Supports: ELF (Linux), EXE (Windows), Mach-O (macOS)
 */

import { loadConf } from '../conf/parser.js';
import { resolve, basename, dirname } from 'path';
import { existsSync, mkdirSync, writeFileSync, copyFileSync, readFileSync, readdirSync, rmSync, cpSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';

// fileURLToPath (not new URL(...).pathname): pathname yields "/C:/..." on
// Windows, which breaks every path derived from it.
const HERE = dirname(fileURLToPath(import.meta.url));

const TARGETS = {
  'linux-x64':   { node: 'node18-linux-x64',  ext: '',     type: 'ELF' },
  'linux-arm64': { node: 'node18-linux-arm64', ext: '',     type: 'ELF' },
  'win-x64':     { node: 'node18-win-x64',     ext: '.exe', type: 'PE (EXE)' },
  'mac-x64':     { node: 'node18-macos-x64',   ext: '',     type: 'Mach-O' },
  'mac-arm64':   { node: 'node18-macos-arm64', ext: '',     type: 'Mach-O' },
};

// ESM runtime modules converted to CJS for packaging (both pkg and the
// fallback bundle consume these). The `requires` lines replace the stripped
// `import` statements — without them the generated modules throw
// ReferenceError the moment they run.
const CJS_MODULES = [
  {
    out: 'parser.cjs', src: '../conf/parser.js',
    exports: ['ConfValue', 'ConfDocument', 'parseConf', 'loadConf'],
    requires: [
      "const { readFileSync } = require('fs');",
      "const { dirname, resolve } = require('path');",
    ],
  },
  {
    out: 'engine.cjs', src: '../runtime/engine.js',
    exports: ['AgentEngine'],
    requires: [
      "const { createInterface } = require('readline/promises');",
      "const { LLMFactory } = require('./providers.cjs');",
      "const { ToolRegistry, loadToolFromConf, executeToolCall } = require('./tools.cjs');",
      "const { saveSession, printSessions } = require('./session.cjs');",
    ],
  },
  {
    out: 'llm.cjs', src: '../runtime/llm.js',
    exports: ['LLMClient'],
    requires: [],
  },
  {
    out: 'tools.cjs', src: '../runtime/tools.js',
    exports: ['ToolRegistry', 'loadToolFromConf', 'getToolDescriptions', 'executeToolCall'],
    requires: [
      "const { readFileSync, readdirSync, statSync, existsSync, writeFileSync } = require('fs');",
      "const { resolve, relative, sep } = require('path');",
      "const { execSync } = require('child_process');",
    ],
  },
  {
    out: 'providers.cjs', src: '../runtime/providers.js',
    exports: ['LLMFactory'],
    requires: [],
  },
  {
    out: 'session.cjs', src: '../runtime/session.js',
    exports: ['saveSession', 'listSessions', 'printSessions', 'loadSession'],
    requires: [
      "const { resolve } = require('path');",
      "const { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } = require('fs');",
      "const { homedir } = require('os');",
    ],
  },
  {
    out: 'variables.cjs', src: '../runtime/variables.js',
    exports: ['substituteVars', 'substituteConf'],
    requires: [],
  },
];

function toCJS(mod) {
  const content = readFileSync(resolve(HERE, mod.src), 'utf-8')
    // Strip `export ` from any top-level declaration: `export class`,
    // `export function`, and `export async function` all end up as plain
    // declarations; module.exports below re-exports what the runner needs.
    .replace(/^export /gm, '')
    .replace(/import .+ from/g, '');
  const prelude = mod.requires.length ? `${mod.requires.join('\n')}\n` : '';
  return `'use strict';\n${prelude}${content}\nmodule.exports = { ${mod.exports.join(', ')} };\n`;
}

export async function buildCommand(confPath, options) {
  const absPath = resolve(confPath);
  if (!existsSync(absPath)) {
    console.error(`❌ File not found: ${confPath}`);
    process.exit(1);
  }

  const conf = loadConf(absPath);
  const agentName = (conf.get('agent', 'name', 'unnamed-agent') || '')
    .replace(/[\/:*?"<>| ]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'agent';
  const outputDir = resolve(options.output || '.');
  
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  await buildCLI(confPath, conf, agentName, outputDir, options);
}

async function buildCLI(confPath, conf, agentName, outputDir, options) {
  const target = options.target || (process.platform === 'darwin' ? 'mac-arm64' 
    : process.platform === 'win32' ? 'win-x64' 
    : 'linux-x64');
  
  const targetInfo = TARGETS[target];
  if (!targetInfo) {
    console.error(`❌ Unknown target: ${target}. Available: ${Object.keys(TARGETS).join(', ')}`);
    process.exit(1);
  }

  // Check if pkg is available (input:'' closes stdin so npx cannot hang on
  // an interactive install prompt)
  let hasPkg = false;
  try {
    execSync('npx pkg --version', { stdio: 'pipe', timeout: 60000, input: '' });
    hasPkg = true;
  } catch {
    hasPkg = false;
  }

  const outputName = options.name || `${agentName}-agent`;
  const outputPath = resolve(outputDir, `${outputName}${targetInfo.ext}`);

  // Generate a standalone runner script that embeds the conf path
  const buildId = randomBytes(4).toString('hex');
  const tmpDir = resolve(tmpdir(), `our-agent-build-${buildId}`);
  mkdirSync(tmpDir, { recursive: true });

  const confData = readFileSync(confPath, 'utf-8');
  
  // Create minimal runner that embeds the .conf
  const runnerCode = `
#!/usr/bin/env node
const confData = ${JSON.stringify(confData)};

async function main() {
  const { parseConf } = require('./parser.cjs');
  const { substituteConf } = require('./variables.cjs');
  const { AgentEngine } = require('./engine.cjs');
  const { LLMFactory } = require('./providers.cjs');

  const conf = parseConf(confData, '${basename(confPath).replace(/'/g, "\\'")}');
  substituteConf(conf);

  // No CLI flags in a built agent: env vars override whatever the .conf says
  const engine = new AgentEngine(conf, {
    apiKey: process.env.OUR_AGENT_KEY || '',
    baseURL: process.env.OUR_AGENT_BASE_URL || undefined,
    model: process.env.OUR_AGENT_MODEL || undefined,
  });

  // Keyless providers (e.g. ollama) must not demand a key
  if (!engine.apiKey && LLMFactory.getProviderConfig(engine.provider).auth !== 'none') {
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
    const key = await new Promise(res => rl.question('🔑 Enter your API key: ', res));
    rl.close();
    if (!key) { console.error('API key required'); process.exit(1); }
    engine.apiKey = key;
  }

  const args = process.argv.slice(2);
  if (args.length > 0) {
    const input = args.join(' ');
    const onChunk = c => process.stdout.write(c);
    await engine.runPrompt(input, [], onChunk);
    console.log('');
  } else {
    await engine.runInteractive();
  }
}
main().catch(e => { console.error('\\n❌', e.message); process.exit(1); });
`;

  writeFileSync(resolve(tmpDir, 'runner.js'), runnerCode);

  // Convert the ESM runtime to CJS (pkg doesn't support ESM well)
  for (const mod of CJS_MODULES) {
    writeFileSync(resolve(tmpDir, mod.out), toCJS(mod));
  }

  // Package.json for pkg
  writeFileSync(resolve(tmpDir, 'package.json'), JSON.stringify({
    name: agentName,
    version: '1.0.0',
    private: true,
    bin: 'runner.js',
  }));

  try {
    console.log(`\n  📦 Building ${targetInfo.type} executable...`);
    console.log(`  Target: ${target}\n`);

    let built = false;
    if (hasPkg) {
      try {
        execSync(`npx pkg . --targets ${targetInfo.node} --output "${outputPath}"`, {
          cwd: tmpDir,
          stdio: 'pipe',
          timeout: 120000, // 2 min timeout for binary download
          env: { ...process.env },
        });
        built = true;
        console.log(`  ✅ Built standalone binary: ${outputPath}`);
      } catch (pkgErr) {
        console.log(`  ⚠️  pkg binary download failed (network may be restricted).`);
        console.log(`  ℹ️  Falling back to standalone Node.js script...`);
      }
    }

    if (!built) {
      // Fallback: create standalone script + copy deps alongside
      const runnerPath = resolve(tmpDir, 'runner.js');
      const fallbackDirName = `${agentName}-agent-pkg`;
      const fallbackDir = resolve(outputDir, fallbackDirName);
      mkdirSync(fallbackDir, { recursive: true });

      // Copy every generated CJS module alongside the runner
      for (const file of readdirSync(tmpDir)) {
        if (file.endsWith('.cjs')) {
          copyFileSync(resolve(tmpDir, file), resolve(fallbackDir, file));
        }
      }

      // Copy runtime dependencies (duck-duck-scrape + its closure) with fs
      // instead of `cp -R`, which does not exist on Windows
      const nodeModulesSrc = resolve(HERE, '../../node_modules');
      const nodeModulesDst = resolve(fallbackDir, 'node_modules');
      if (existsSync(nodeModulesSrc)) {
        try {
          cpSync(nodeModulesSrc, nodeModulesDst, { recursive: true });
        } catch {}
      }

      // Write the runner as main script
      const runnerContent = readFileSync(runnerPath, 'utf-8')
        .replace(/^#!.*$/m, '// shebang stripped');
      const mainScript = `#!/usr/bin/env node
'use strict';
// Standalone agent - embed conf and dependencies
process.env.OUR_AGENT_STANDALONE = '1';
const path = require('path');
const fs = require('fs');
// Adjust module paths to find local deps
const modulePath = path.join(__dirname, 'node_modules');
if (fs.existsSync(modulePath)) {
  require('module').globalPaths.push(modulePath);
}
${runnerContent}
`;
      writeFileSync(resolve(fallbackDir, 'index.js'), mainScript);
      try {
        execSync(`chmod +x "${resolve(fallbackDir, 'index.js')}"`);
      } catch {}

      // Create wrapper symlink/script at output path
      const wrapperScript = `#!/usr/bin/env node
'use strict';
const { resolve } = require('path');
const { execSync } = require('child_process');
const target = resolve(__dirname, '${fallbackDirName}', 'index.js');
if (!require('fs').existsSync(target)) {
  console.error('Agent files not found. Expected at:', target);
  process.exit(1);
}
const args = process.argv.slice(2).map(a => JSON.stringify(a)).join(' ');
try {
  execSync('node ' + JSON.stringify(target) + (args ? ' ' + args : ''), { stdio: 'inherit' });
} catch(e) {
  process.exit(e.status || 1);
}
`;
      // Write wrapper script (avoid naming conflict when outputPath == fallbackDir)
      if (outputPath !== fallbackDir) {
        writeFileSync(outputPath, wrapperScript);
        try {
          execSync(`chmod +x "${outputPath}"`);
        } catch {}
      }

      console.log(`  ✅ Built agent package: ${fallbackDir}`);
      console.log(`  ✅ Wrapper script: ${outputPath}`);
      console.log(`  ℹ️  To run:`);
      console.log(`     node "${resolve(fallbackDir, 'index.js')}"`);
      console.log(`  ℹ️  Or install pkg with a proxy to build true standalone binaries:`);
      console.log(`     npm install -g pkg`);
      console.log(`     HTTPS_PROXY=http://your-proxy:port our-agent build ...`);
    }

    // Build for additional targets if --all is specified (only with pkg)
    if (options.all && built) {
      for (const [t, info] of Object.entries(TARGETS)) {
        if (t === target) continue;
        const altPath = resolve(outputDir, `${agentName}-agent-${t}${info.ext}`);
        try {
          execSync(`npx pkg . --targets ${info.node} --output "${altPath}"`, {
            cwd: tmpDir,
            stdio: 'pipe',
            timeout: 120000,
          });
          console.log(`  ✅ Built: ${altPath}`);
        } catch (e) {
          console.log(`  ⚠️  Skipped ${t}: ${e.message}`);
        }
      }
    }

  } finally {
    // Cleanup (rmSync, not `rm -rf`: no shell, works on Windows)
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

