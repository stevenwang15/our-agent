// our-agent - (c) 2026 Apache-2.0 - See LICENSE file for details
/**
 * our-agent lint <file.conf> - Validate .conf files and check for issues.
 */

import { loadConf } from '../conf/parser.js';

export async function lintCommand(confPath, options) {
  const { resolve, basename } = await import('path');
  const { existsSync, readFileSync } = await import('fs');
  const absPath = resolve(confPath);

  if (!existsSync(absPath)) {
    console.error(`❌ File not found: ${absPath}`);
    process.exit(1);
  }

  const warnings = [];
  const errors = [];
  const info = [];

  info.push(`📄 File: ${basename(absPath)}`);

  // Try to parse
  let conf;
  try {
    const text = readFileSync(absPath, 'utf-8');
    const now = Date.now();
    conf = loadConf(absPath);
    const parseTime = Date.now() - now;
    info.push(`✅ Parsed successfully (${parseTime}ms)`);
    info.push(`📑 Sections: ${conf.sectionsList().filter(s => s !== '_root').join(', ') || '(none)'}`);
  } catch (e) {
    errors.push(`❌ Parse error: ${e.message}`);
    printReport(info, warnings, errors, options.verbose);
    process.exit(1);
  }

  // Check required fields
  const agentName = conf.get('agent', 'name');
  if (!agentName) {
    warnings.push('⚠️  [agent].name is not set (will use "Unnamed Agent")');
  }

  const systemPrompt = conf.get('prompt', 'system') 
    || conf.get('agent.prompt', 'system')
    || conf.smartGet('system');
  if (!systemPrompt) {
    warnings.push('⚠️  prompt.system is not set (agent will have no system prompt)');
  } else if (systemPrompt.length < 10) {
    warnings.push('⚠️  prompt.system is very short (< 10 chars)');
  }

  // Check settings
  const temp = conf.get('settings', 'temperature') ?? conf.get('agent.settings', 'temperature');
  if (temp !== undefined && (temp < 0 || temp > 2)) {
    errors.push(`❌ settings.temperature must be 0-2, got ${temp}`);
  }

  const maxTk = conf.get('settings', 'max_tokens') ?? conf.get('agent.settings', 'max_tokens');
  if (maxTk !== undefined && (maxTk < 1 || maxTk > 128000)) {
    warnings.push(`⚠️  settings.max_tokens seems unusual: ${maxTk}`);
  }

  // Check for model/key in conf (should NOT be there)
  const vals = conf.toFlatObject();
  const sensitiveKeys = ['api_key', 'api-key', 'apikey', 'secret', 'password', 'token'];
  for (const [section, map] of Object.entries(vals)) {
    for (const [key, val] of Object.entries(map)) {
      const keyLower = key.toLowerCase();
      if (sensitiveKeys.some(sk => keyLower.includes(sk))) {
        if (typeof val === 'string' && val.length > 4) {
          warnings.push(`⚠️  [${section}].${key} appears to contain sensitive credentials! .conf should NOT store secrets.`);
        }
      }
    }
  }

  // Check tools
  const tools = conf.get('tools', 'allow') ?? conf.get('agent.tools', 'allow') ?? [];
  if (Array.isArray(tools) && tools.length > 0) {
    info.push(`🔧 Tools: ${tools.join(', ')}`);
  }

  // Section structure suggestions
  const sections = conf.sectionsList();
  const recommendSections = ['agent', 'prompt', 'settings'];
  for (const sec of recommendSections) {
    const hasFlat = sections.includes(sec);
    const hasDotted = sections.some(s => s.endsWith(`.${sec}`));
    if (!hasFlat && !hasDotted) {
      warnings.push(`💡 Consider adding a [${sec}] section`);
    }
  }

  // Check for unused env vars in values
  if (options.verbose) {
    const text = readFileSync(absPath, 'utf-8');
    const envRefs = text.match(/\$\{([^}]+)\}/g);
    if (envRefs) {
      info.push(`📌 Environment variable references: ${envRefs.join(', ')}`);
    }
  }

  if (options.fix) {
    // Auto-fix simple issues
    const { writeFileSync } = await import('fs');
    let fixed = false;
    if (!agentName) {
      const baseName = basename(absPath).replace(/\.conf$/, '');
      const text = readFileSync(absPath, 'utf-8');
      // Add name to agent section if it exists
      if (text.includes('[agent]')) {
        const fixedText = text.replace('[agent]', `[agent]\nname = "${baseName}"`);
        writeFileSync(absPath, fixedText);
        info.push(`🔧 Added name = "${baseName}" to [agent]`);
        fixed = true;
      }
    }
    if (fixed) {
      info.push('✅ Auto-fix applied');
    } else {
      info.push('ℹ️  No auto-fixable issues found');
    }
  }

  printReport(info, warnings, errors, options.verbose);
  
  if (errors.length > 0) process.exit(1);
}

function printReport(info, warnings, errors, verbose) {
  console.log('\n  📋 Lint Report\n');

  for (const msg of info) {
    if (verbose || !msg.startsWith('📑') && !msg.startsWith('🔧') && !msg.startsWith('🔌')) {
      console.log(`  ${msg}`);
    }
  }

  for (const msg of warnings) {
    console.log(`  ${msg}`);
  }

  for (const msg of errors) {
    console.log(`  ${msg}`);
  }

  console.log(`\n  ${errors.length} errors, ${warnings.length} warnings\n`);
}
