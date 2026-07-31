// my-agent - (c) 2026 Apache-2.0 - See LICENSE file for details
/**
 * Session management - Save, list, and resume conversations.
 */

import { resolve, dirname } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { homedir } from 'os';

const SESSION_DIR = resolve(homedir(), '.my-agent', 'sessions');

function ensureDir() {
  if (!existsSync(SESSION_DIR)) {
    mkdirSync(SESSION_DIR, { recursive: true });
  }
}

export function saveSession(agentName, messages, metadata = {}) {
  ensureDir();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeName = agentName.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '_').slice(0, 30);
  const fileName = `${safeName}_${timestamp}.json`;
  const filePath = resolve(SESSION_DIR, fileName);

  const session = {
    agent: agentName,
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    messages: messages.map(m => ({
      role: m.role,
      content: m.content?.slice(0, 200) + (m.content?.length > 200 ? '...' : ''),
      contentFull: m.content,
    })),
    metadata,
    messageCount: messages.length,
  };

  writeFileSync(filePath, JSON.stringify(session, null, 2));
  return filePath;
}

export function listSessions(agentName = null) {
  ensureDir();
  const files = readdirSync(SESSION_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, 50); // Last 50 sessions

  return files.map(f => {
    const filePath = resolve(SESSION_DIR, f);
    try {
      const data = JSON.parse(readFileSync(filePath, 'utf-8'));
      if (agentName && data.agent !== agentName) return null;
      return {
        id: f.replace(/\.json$/, ''),
        file: filePath,
        agent: data.agent,
        created: data.created,
        messages: data.messageCount,
        preview: data.messages?.[data.messages.length - 1]?.content?.slice(0, 80) || '(empty)',
      };
    } catch {
      return null;
    }
  }).filter(Boolean);
}

export function loadSession(sessionId) {
  ensureDir();
  const filePath = resolve(SESSION_DIR, `${sessionId}.json`);
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

export function printSessions(agentName = null) {
  const sessions = listSessions(agentName);
  if (sessions.length === 0) {
    console.log('  📭 No saved sessions' + (agentName ? ` for "${agentName}"` : ''));
    return;
  }

  console.log(`\n  📂 Sessions${agentName ? ` for "${agentName}"` : ''}:`);
  console.log(`  ${'─'.repeat(50)}`);
  
  for (const s of sessions.slice(0, 10)) {
    const date = new Date(s.created).toLocaleString('zh-CN');
    console.log(`  [${s.id.slice(0, 24)}]`);
    console.log(`  Agent: ${s.agent}  |  ${s.messages} msgs  |  ${date}`);
    console.log(`  Last: ${s.preview}`);
    console.log(`  ${'─'.repeat(50)}`);
  }
  
  console.log(`  Total: ${sessions.length} sessions\n`);
}
