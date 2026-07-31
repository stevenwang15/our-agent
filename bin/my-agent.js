#!/usr/bin/env node
// my-agent - (c) 2026 Apache-2.0 - See LICENSE file for details

/**
 * my-agent CLI - Build and run AI agents from .conf files
 *
 * Usage:
 *   my-agent run <file.conf>     Run an agent (multi-provider, tools)
 *   my-agent init [name]         Scaffold a new agent interactively
 *   my-agent lint <file.conf>    Validate .conf file
 *   my-agent build <file.conf>   Package as executable
 *   my-agent export <file.conf>  Export as Skill or MCP
 *   my-agent gui [file.conf]    Launch modern GUI
 */

import { program } from 'commander';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = resolve(__dirname, '..');

const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf-8'));

function src(...parts) {
  return resolve(root, 'src', ...parts);
}

program
  .name('my-agent')
  .description('Build and run AI agents from .conf files')
  .version(pkg.version);

// ---- init command ----
program
  .command('init')
  .description('Scaffold a new agent from interactive prompts')
  .argument('[name]', 'Agent name (also used as filename)')
  .option('-o, --output <dir>', 'Output directory', '.')
  .option('-f, --force', 'Overwrite existing file')
  .action(async (name, opts) => {
    const { initCommand } = await import(src('commands/init.js'));
    await initCommand(name, opts);
  });

// ---- lint command ----
program
  .command('lint')
  .description('Validate a .conf file for errors and best practices')
  .argument('<file>', 'Path to .conf file')
  .option('-v, --verbose', 'Show detailed info')
  .option('--fix', 'Auto-fix simple issues')
  .action(async (file, opts) => {
    const { lintCommand } = await import(src('commands/lint.js'));
    await lintCommand(file, opts);
  });

// ---- run command ----
program
  .command('run')
  .description('Run an agent from a .conf file')
  .argument('<file>', 'Path to .conf file')
  .option('-k, --key <key>', 'API key (or use MY_AGENT_KEY env)')
  .option('-m, --model <model>', 'Model override')
  .option('-b, --base-url <url>', 'API base URL override')
  .option('-p, --provider <provider>', 'LLM provider (openai, anthropic, google, deepseek, ollama, openrouter)')
  .option('-P, --prompt <text>', 'One-shot prompt instead of interactive')
  .option('--no-stream', 'Disable streaming output')
  .option('--no-interactive', 'Non-interactive key prompt')
  .option('--json', 'Structured JSON output mode')
  .action(async (file, opts) => {
    const { runCommand } = await import(src('commands/run.js'));
    await runCommand(file, opts);
  });

// ---- build command ----
program
  .command('build')
  .description('Package an agent into a standalone executable')
  .argument('<file>', 'Path to .conf file')
  .option('-o, --output <dir>', 'Output directory', '.')
  .option('-n, --name <name>', 'Output executable name')
  .option('-t, --target <target>', 'Target platform (linux-x64, linux-arm64, win-x64, mac-x64, mac-arm64)')
  .option('--all', 'Build for all targets')
  .action(async (file, opts) => {
    const { buildCommand } = await import(src('commands/build.js'));
    await buildCommand(file, opts);
  });

// ---- export command ----
program
  .command('export')
  .description('Export an agent as a Skill or MCP server')
  .argument('<file>', 'Path to .conf file')
  .option('-o, --output <dir>', 'Output directory', '.')
  .option('-f, --format <format>', 'Export format (skill, mcp, all)', 'all')
  .action(async (file, opts) => {
    const { exportCommand } = await import(src('commands/export.js'));
    await exportCommand(file, opts);
  });

// ---- providers command ----
program
  .command('providers')
  .description('List available LLM providers')
  .action(async () => {
    const { LLMFactory } = await import(src('runtime/providers.js'));
    const providers = LLMFactory.listProviders();
    console.log('\n  📡 Available LLM Providers:\n');
    for (const p of providers) {
      console.log(`  ${p.emoji || '🤖'} ${p.name}`);
      console.log(`     ${p.description}`);
      console.log(`     Default: ${p.defaultModel}`);
      console.log(`     ${p.baseURL}\n`);
    }
  });

program.parse(process.argv);
