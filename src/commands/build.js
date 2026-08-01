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
import { existsSync, mkdirSync, writeFileSync, copyFileSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';

const TARGETS = {
  'linux-x64':   { node: 'node18-linux-x64',  ext: '',     type: 'ELF' },
  'linux-arm64': { node: 'node18-linux-arm64', ext: '',     type: 'ELF' },
  'win-x64':     { node: 'node18-win-x64',     ext: '.exe', type: 'PE (EXE)' },
  'mac-x64':     { node: 'node18-macos-x64',   ext: '',     type: 'Mach-O' },
  'mac-arm64':   { node: 'node18-macos-arm64', ext: '',     type: 'Mach-O' },
};

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

  // Check if pkg is available
  let hasPkg = false;
  try {
    execSync('npx pkg --version', { stdio: 'pipe' });
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
const { parseConf } = require('./parser.cjs');
const conf = parseConf(confData, '${basename(confPath)}');

const apiKey = process.env.OUR_AGENT_KEY || '';
const baseURL = conf.get('settings', 'base_url', process.env.OUR_AGENT_BASE_URL || 'https://api.openai.com/v1');
const model = conf.get('settings', 'model', process.env.OUR_AGENT_MODEL || 'gpt-4o');

async function main() {
  const { AgentEngine } = require('./engine.cjs');
  
  if (!apiKey) {
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
    const key = await new Promise(res => rl.question('🔑 Enter your API key: ', res));
    rl.close();
    if (!key) { console.error('API key required'); process.exit(1); }
    process.env.OUR_AGENT_KEY = key;
  }

  const engine = new AgentEngine(conf, {
    apiKey: apiKey || process.env.OUR_AGENT_KEY,
    baseURL,
    model,
  });

  const args = process.argv.slice(2);
  if (args.length > 0) {
    const input = args.join(' ');
    let full = '';
    const onChunk = c => { process.stdout.write(c); full += c; };
    const { result } = await engine.runPrompt(input, [], onChunk);
    if (!result) console.log('');
  } else {
    await engine.runInteractive();
  }
}
main().catch(e => { console.error('\\n❌', e.message); process.exit(1); });
`;

  writeFileSync(resolve(tmpDir, 'runner.js'), runnerCode);

  // Copy dependencies as CJS (pkg doesn't support ESM well)
  const parserContent = `'use strict';
${readFileSync(resolve(dirname(new URL(import.meta.url).pathname), '../conf/parser.js'), 'utf-8')
  .replace(/export class/g, 'class')
  .replace(/export function/g, 'function')
  .replace(/import .+ from/g, '')}
module.exports = { ConfValue, ConfDocument, parseConf, loadConf };
`;
  
  const engineContent = `'use strict';
${readFileSync(resolve(dirname(new URL(import.meta.url).pathname), '../runtime/engine.js'), 'utf-8')
  .replace(/export class/g, 'class')
  .replace(/import .+ from/g, '')}
module.exports = { AgentEngine };
`;

  const llmContent = `'use strict';
${readFileSync(resolve(dirname(new URL(import.meta.url).pathname), '../runtime/llm.js'), 'utf-8')
  .replace(/export class/g, 'class')}
module.exports = { LLMClient };
`;

  writeFileSync(resolve(tmpDir, 'parser.cjs'), parserContent);
  writeFileSync(resolve(tmpDir, 'engine.cjs'), engineContent);
  writeFileSync(resolve(tmpDir, 'llm.cjs'), llmContent);

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

      // Copy runner, parser, engine, llm, tools, providers, session, variables
      const depFiles = [
        ['parser.cjs', 'parser.cjs'],
        ['engine.cjs', 'engine.cjs'],
        ['llm.cjs', 'llm.cjs'],
      ];
      for (const [src, dst] of depFiles) {
        copyFileSync(resolve(tmpDir, src), resolve(fallbackDir, dst));
      }

      // Copy tools, providers, session, variables as CJS
      const extraModules = ['tools.js', 'providers.js', 'session.js', 'variables.js'];
      for (const mod of extraModules) {
        const srcPath = resolve(dirname(new URL(import.meta.url).pathname), `../runtime/${mod}`);
        if (existsSync(srcPath)) {
          let content = readFileSync(srcPath, 'utf-8')
            .replace(/export class/g, 'class')
            .replace(/export function/g, 'function')
            .replace(/import .+ from/g, '');
          // Export all classes/functions
          const exports = [];
          if (content.includes('class ToolRegistry')) exports.push('ToolRegistry');
          if (content.includes('class LLMFactory')) exports.push('LLMFactory');
          if (content.includes('class LLMClient')) exports.push('LLMClient');
          if (content.includes('class SessionManager')) exports.push('SessionManager');
          if (content.includes('function substituteConf')) exports.push('substituteConf');
          if (content.includes('function loadToolFromConf')) exports.push('loadToolFromConf');
          if (content.includes('function getToolDescriptions')) exports.push('getToolDescriptions');
          if (content.includes('function executeToolCall')) exports.push('executeToolCall');
          if (content.includes('function saveSession')) exports.push('saveSession');
          if (content.includes('function listSessions')) exports.push('listSessions');
          if (content.includes('function printSessions')) exports.push('printSessions');
          if (exports.length > 0) {
            content += `\nmodule.exports = { ${exports.join(', ')} };\n`;
          }
          writeFileSync(resolve(fallbackDir, mod.replace('.js', '.cjs')), `'use strict';\n${content}`);
        }
      }

      // Copy duck-duck-scrape dependency (needed at runtime)
      const nodeModulesSrc = resolve(dirname(new URL(import.meta.url).pathname), '../../node_modules');
      const nodeModulesDst = resolve(fallbackDir, 'node_modules');
      if (existsSync(nodeModulesSrc)) {
        try {
          execSync(`cp -R "${resolve(nodeModulesSrc, 'duck-duck-scrape')}" "${resolve(nodeModulesDst, 'duck-duck-scrape')}" 2>/dev/null; mkdir -p "${resolve(nodeModulesDst, 'undici')}" 2>/dev/null; true`, { stdio: 'pipe' });
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
    // Cleanup
    try {
      execSync(`rm -rf "${tmpDir}"`);
    } catch {}
  }
}

