// Syntax gate over every shipped JS file. Cross-platform on purpose: the old
// shell one-liners break on Windows, and this repo ships install.ps1.
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = ['bin', 'src', 'test'];
const SKIP = new Set(['node_modules', '.git']);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.js') || full.endsWith('.mjs')) out.push(full);
  }
  return out;
}

const files = ROOTS.filter((r) => {
  try { return statSync(r).isDirectory(); } catch { return false; }
}).flatMap((r) => walk(r));

for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    console.error(`syntax error in ${file}\n${err.stderr?.toString() ?? err.message}`);
    process.exit(1);
  }
}

console.log(`ok — ${files.length} file(s) parsed`);
