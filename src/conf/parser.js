// our-agent - (c) 2026 Apache-2.0 - See LICENSE file for details
/**
 * .conf parser - Custom config format for describing AI agents.
 *
 * NOT .ini. Supports TWO syntax styles:
 *
 * Style 1 - Bracket sections (existing):
 *   [agent]
 *   name = "assistant"
 *
 * Style 2 - Brace sections (NEW):
 *   agent {
 *       name = "assistant";
 *       prompt = """...""";
 *       settings {
 *           temperature = 0.7;
 *       }
 *   }
 *
 * Features:
 *   - key = value pairs (values: string, number, boolean, array, object)
 *   - Triple-quoted multi-line strings: """..."""
 *   - Comments: # ...  and  // ...
 *   - Arrays: [1, 2, "three"]
 *   - Inline objects: { key = val }
 *   - Includes: @include "path.conf"
 *   - Semicolons optional: key = val  OR  key = val;
 */

import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';

export class ConfValue {
  constructor(type, value, pos) {
    this.type = type;       // 'string' | 'number' | 'boolean' | 'array' | 'object' | 'null'
    this.value = value;
    this.pos = pos;
  }

  toString() {
    if (this.type === 'array') return `[${this.value.map(v => v.toString()).join(', ')}]`;
    if (this.type === 'object') return `{...}`;
    return String(this.value);
  }

  toRaw() {
    if (this.type === 'array') return this.value.map(v => v.toRaw());
    if (this.type === 'object') {
      const obj = {};
      for (const [k, v] of this.value) obj[k] = v.toRaw();
      return obj;
    }
    return this.value;
  }
}

export class ConfDocument {
  constructor() {
    this.sections = new Map();
    this.variables = new Map();
    this._order = [];
  }

  keys(section) {
    const s = this.sections.get(section);
    return s ? [...s.keys()] : [];
  }

  get(section, key, def = undefined) {
    const s = this.sections.get(section);
    if (!s) return def;
    const v = s.get(key);
    return v ? v.toRaw() : def;
  }

  getRaw(section, key) {
    const s = this.sections.get(section);
    return s ? s.get(key) : undefined;
  }

  sectionsList() {
    return [...this._order];
  }

  hasSection(name) {
    return this.sections.has(name);
  }

  /** Deep get: supports dotted paths like "settings.advanced.rag" */
  deepGet(path, key, def = undefined) {
    const s = this.sections.get(path);
    if (!s) return def;
    const v = s.get(key);
    return v ? v.toRaw() : def;
  }

  /**
   * Smart get: tries section.key, then walks all dotted sections.
   * Allows brace-style conf (agent.prompt.system) to work like
   * bracket-style (prompt.system = ...).
   */
  smartGet(key, def = undefined) {
    // Direct section lookup: e.g. conf.get('agent', 'name')
    // This already works via the `get` method
    
    // For scout-style: find first section that contains this key
    for (const [name, map] of this.sections) {
      if (map.has(key)) return map.get(key).toRaw();
    }
    return def;
  }

  /**
   * Find the first section that contains the given key
   */
  findSectionWith(key) {
    for (const [name, map] of this.sections) {
      if (map.has(key)) return name;
    }
    return null;
  }

  merge(other) {
    for (const [name, map] of other.sections) {
      if (!this.sections.has(name)) {
        this.sections.set(name, new Map());
        this._order.push(name);
      }
      for (const [k, v] of map) {
        this.sections.get(name).set(k, v);
      }
    }
    for (const [k, v] of other.variables) {
      this.variables.set(k, v);
    }
  }

  /** Merge all values into a flat object */
  toFlatObject() {
    const obj = {};
    for (const [name, map] of this.sections) {
      obj[name] = {};
      for (const [k, v] of map) {
        obj[name][k] = v.toRaw();
      }
    }
    return obj;
  }
}

class ParseError extends Error {
  constructor(message, pos) {
    super(`${pos.file}:${pos.line}:${pos.col}: ${message}`);
    this.pos = pos;
  }
}

function pos(file, line, col) {
  return { file, line, col };
}

/**
 * Parse a .conf text into a ConfDocument.
 * Supports both [bracket] and name { brace } section styles.
 */
export function parseConf(text, filePath = '<string>') {
  const doc = new ConfDocument();
  let i = 0;
  let ch = '';  // current character

  function next() { if (i < text.length) { ch = text[i]; i++; return ch; } return ''; }
  function peek() { return i < text.length ? text[i] : ''; }
  function skipWS() { while (i < text.length && (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n')) next(); }
  function skipLine() { while (i < text.length && ch !== '\n') next(); if (ch === '\n') next(); }
  function error(msg) { 
    const lineNum = text.slice(0, i).split('\n').length;
    const lastNewline = text.lastIndexOf('\n', i - 1);
    const col = i - lastNewline;
    throw new ParseError(msg, pos(filePath, lineNum, col));
  }

  // Initialize
  i = 0;
  next();

  // Parse file as sequence of top-level elements
  // Each element is either a section header, a brace-section, or a key=value pair in the root section
  function parseFile(currentSection) {
    if (!doc.sections.has(currentSection)) {
      doc.sections.set(currentSection, new Map());
      doc._order.push(currentSection);
    }

    while (i < text.length) {
      skipWS();
      if (i >= text.length) break;

      // Comments
      if (ch === '#') { skipLine(); continue; }
      if (ch === '/' && peek() === '/') { skipLine(); continue; }

      // @include
      if (ch === '@') {
        let line = '';
        while (ch !== '\n' && i < text.length) { line += ch; next(); }
        const match = line.match(/@include\s+"([^"]+)"/);
        if (match) {
          const incPath = resolve(dirname(filePath), match[1]);
          try {
            const incText = readFileSync(incPath, 'utf-8');
            const incDoc = parseConf(incText, incPath);
            doc.merge(incDoc);
          } catch (e) {
            error(`Cannot include "${match[1]}": ${e.message}`);
          }
        }
        if (ch === '\n') next();
        continue;
      }

      // End of brace block
      if (ch === '}') { next(); return; }

      // Bracket section header: [section]
      if (ch === '[') {
        let secName = '';
        next();
        while (ch !== ']' && i < text.length) { secName += ch; next(); }
        if (ch === ']') next();
        currentSection = secName.trim();
        parseFile(currentSection);
        continue;
      }

      // Brace section: name { ... }  OR  name{...}
      // Try to read a name + optional {
      const savedI = i;
      let name = '';
      while (ch !== '=' && ch !== '{' && ch !== '\n' && ch !== ';' && i < text.length) {
        if (ch !== ' ' && ch !== '\t') name += ch;
        next();
      }
      name = name.trim();

      if (ch === '{' && name) {
        // Brace section
        next(); // skip {
        const subSection = currentSection === '_root' ? name : `${currentSection}.${name}`;
        parseFile(subSection);
        // } already consumed by the end-of-block check
        skipWS();
        if (ch === ';') next(); // optional ;
        continue;
      }

      if (ch === '\n' || ch === ';') {
        // stray newline/semicolon
        if (ch === ';') next();
        continue;
      }

      // key = value
      if (ch === '=') {
        const key = name;
        if (!key && name === '') error('Expected key before "="');

        next(); // skip =
        skipWS();

        let valStr = '';
        let inQuote = false;
        let quoteChar = null;

        // Check for multi-line string
        if (ch === '"' && peek() === '"' && text[i+1] === '"') {
          // Triple-quoted string
          next(); next(); next(); // skip """
          valStr = '';
          while (i < text.length) {
            if (ch === '"' && peek() === '"' && text[i+1] === '"') {
              next(); next(); next(); // skip """
              break;
            }
            valStr += ch;
            next();
          }
          // Trim leading/trailing newline
          if (valStr.startsWith('\n')) valStr = valStr.slice(1);
          if (valStr.endsWith('\n')) valStr = valStr.slice(0, -1);

          const map = doc.sections.get(currentSection);
          map.set(key, new ConfValue('string', valStr, pos(filePath, 0, 0)));
          
          skipWS();
          if (ch === ';') next();
          continue;
        }

        // Read value until newline or ;
        while (i < text.length) {
          if (inQuote) {
            valStr += ch;
            if (ch === quoteChar) inQuote = false;
            next();
          } else if (ch === '"' || ch === "'") {
            inQuote = true;
            quoteChar = ch;
            valStr += ch;
            next();
          } else if (ch === ';' || ch === '\n') {
            break;
          } else {
            valStr += ch;
            next();
          }
        }

        valStr = valStr.trim();
        if (ch === ';') next(); // consume ;

        const parsedVal = parseValue(valStr, filePath, 0, 0);
        const map = doc.sections.get(currentSection);
        map.set(key, parsedVal);
        continue;
      }

      // Unknown token, skip line
      if (ch === '\n') { next(); continue; }
      // If we read a name and found newline instead of = or {, skip
      skipLine();
    }
  }

  parseFile('_root');
  return doc;
}

function parseValue(str, file, line, col) {
  // Handle arrays
  if (str.startsWith('[') && str.endsWith(']')) {
    const inner = str.slice(1, -1).trim();
    if (inner === '') return new ConfValue('array', [], pos(file, line, col));
    
    const items = [];
    let current = '';
    let inQuote = false;
    let quoteChar = null;
    let depth = 0;
    
    for (const ch of inner) {
      if (inQuote) {
        current += ch;
        if (ch === quoteChar) inQuote = false;
      } else if ((ch === '"' || ch === "'") && depth === 0) {
        inQuote = true;
        quoteChar = ch;
        current += ch;
      } else if (ch === '[' || ch === '{') {
        depth++;
        current += ch;
      } else if (ch === ']' || ch === '}') {
        depth--;
        current += ch;
      } else if (ch === ',' && depth === 0) {
        items.push(parseValue(current.trim(), file, line, col));
        current = '';
      } else {
        current += ch;
      }
    }
    if (current.trim()) items.push(parseValue(current.trim(), file, line, col));
    
    return new ConfValue('array', items, pos(file, line, col));
  }

  // Handle inline objects
  if (str.startsWith('{') && str.endsWith('}')) {
    const inner = str.slice(1, -1).trim();
    if (inner === '') return new ConfValue('object', [], pos(file, line, col));
    const pairs = [];
    const pairRegex = /(\w+)\s*=\s*([^,]+)/g;
    let m;
    while ((m = pairRegex.exec(inner)) !== null) {
      pairs.push([m[1], parseValue(m[2].trim(), file, line, col)]);
    }
    return new ConfValue('object', pairs, pos(file, line, col));
  }

  // Booleans
  if (str === 'true') return new ConfValue('boolean', true, pos(file, line, col));
  if (str === 'false') return new ConfValue('boolean', false, pos(file, line, col));
  if (str === 'null') return new ConfValue('null', null, pos(file, line, col));

  // Numbers
  if (/^-?\d+(\.\d+)?$/.test(str)) {
    return new ConfValue('number', str.includes('.') ? parseFloat(str) : parseInt(str, 10), pos(file, line, col));
  }

  // Quoted string
  if ((str.startsWith('"') && str.endsWith('"')) || (str.startsWith("'") && str.endsWith("'"))) {
    return new ConfValue('string', str.slice(1, -1), pos(file, line, col));
  }

  // Unquoted string
  return new ConfValue('string', str, pos(file, line, col));
}

export function loadConf(filePath) {
  const text = readFileSync(filePath, 'utf-8');
  return parseConf(text, filePath);
}
