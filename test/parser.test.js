// Parser and variable-substitution tests.
//
// These two modules are the floor of the whole project: every command (run,
// build, lint, export) reads a .conf through them. Neither had a single test.
//
//   node --test test/
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

import { parseConf, ParseError } from '../src/conf/parser.js';
import { substituteVars, substituteConf } from '../src/runtime/variables.js';

const BRACKET = `
# leading comment
[agent]
name = "Default Assistant"
version = "1.0.0"

[settings]
temperature = 0.7
max_tokens = 4096
stream = true

[tools]
allow = []
`;

const BRACE = `
agent {
    name = "Braced";
    version = "2.0.0";

    prompt {
        system = "You are braced.";
    }

    settings {
        temperature = 0.3;
        stream = false;
    }
}
`;

describe('bracket syntax', () => {
  const doc = parseConf(BRACKET);

  test('sections appear in order, with an implicit _root', () => {
    assert.deepEqual(doc.sectionsList(), ['_root', 'agent', 'settings', 'tools']);
  });

  test('strings lose their quotes', () => {
    assert.equal(doc.get('agent', 'name'), 'Default Assistant');
    assert.equal(doc.get('agent', 'version'), '1.0.0');
  });

  test('numbers and booleans are typed, not strings', () => {
    assert.equal(doc.get('settings', 'temperature'), 0.7);
    assert.equal(typeof doc.get('settings', 'temperature'), 'number');
    assert.equal(doc.get('settings', 'max_tokens'), 4096);
    assert.equal(doc.get('settings', 'stream'), true);
  });

  test('empty array parses to an empty array', () => {
    assert.deepEqual(doc.get('tools', 'allow'), []);
  });

  test('a missing key returns the supplied default', () => {
    assert.equal(doc.get('agent', 'nope'), undefined);
    assert.equal(doc.get('agent', 'nope', 'fallback'), 'fallback');
    assert.equal(doc.get('no-such-section', 'x', 42), 42);
  });

  test('comments and blank lines do not create keys', () => {
    assert.deepEqual(doc.keys('agent'), ['name', 'version']);
  });
});

describe('brace syntax', () => {
  const doc = parseConf(BRACE);

  test('nested blocks become dotted sections', () => {
    assert.ok(doc.hasSection('agent'));
    assert.ok(doc.hasSection('agent.prompt'));
    assert.ok(doc.hasSection('agent.settings'));
  });

  test('values inside nested blocks are readable', () => {
    assert.equal(doc.get('agent', 'name'), 'Braced');
    assert.equal(doc.get('agent.prompt', 'system'), 'You are braced.');
    assert.equal(doc.get('agent.settings', 'temperature'), 0.3);
    assert.equal(doc.get('agent.settings', 'stream'), false);
  });

  test('smartGet finds a key without knowing its section', () => {
    assert.equal(doc.smartGet('temperature'), 0.3);
    assert.equal(doc.smartGet('missing', 'dflt'), 'dflt');
  });

  test('toFlatObject is a plain nested object', () => {
    const flat = doc.toFlatObject();
    assert.equal(typeof flat, 'object');
    assert.ok(Object.keys(flat).includes('agent'));
  });
});

describe('malformed input', () => {
  test('an unterminated string reports a ConfError with a position', () => {
    assert.throws(
      () => parseConf('[a]\nk = "unterminated\n'),
      (err) => err instanceof ParseError && typeof err.pos === 'object' && err.pos.line >= 1,
    );
  });

  test('a stray closing brace is rejected', () => {
    assert.throws(() => parseConf('}\n'), (err) => err instanceof ParseError);
  });

  test('an empty section name is rejected', () => {
    assert.throws(() => parseConf('[]\nk = "v"\n'), /Empty section name/);
  });

  test('an unterminated section header is rejected', () => {
    assert.throws(() => parseConf('[agent\nk = "v"\n'), /Unterminated section header/);
  });

  test('an unterminated triple-quoted string is rejected', () => {
    assert.throws(() => parseConf('[a]\nk = """open\n'), /Unterminated triple-quoted string/);
  });

  test('a value keeps no stray quote when the string closes properly', () => {
    const doc = parseConf('[a]\nk = "ok"\n');
    assert.equal(doc.get('a', 'k'), 'ok');
  });
});

describe('variable substitution', () => {
  test('a plain reference resolves from the environment', () => {
    process.env.OUR_AGENT_TEST_VAR = 'from-env';
    assert.equal(substituteVars('v=${OUR_AGENT_TEST_VAR}'), 'v=from-env');
    delete process.env.OUR_AGENT_TEST_VAR;
  });

  test(':- supplies a default when the variable is unset', () => {
    delete process.env.OUR_AGENT_ABSENT;
    assert.equal(substituteVars('${OUR_AGENT_ABSENT:-fallback}'), 'fallback');
  });

  test(':- does not override a variable that is set', () => {
    process.env.OUR_AGENT_SET = 'real';
    assert.equal(substituteVars('${OUR_AGENT_SET:-fallback}'), 'real');
    delete process.env.OUR_AGENT_SET;
  });

  test(':? throws when the variable is unset', () => {
    delete process.env.OUR_AGENT_REQUIRED;
    assert.throws(
      () => substituteVars('${OUR_AGENT_REQUIRED:?you must set this}'),
      /you must set this/,
    );
  });

  test('a bare unset reference becomes an empty string', () => {
    delete process.env.OUR_AGENT_NOPE;
    assert.equal(substituteVars('a${OUR_AGENT_NOPE}b'), 'ab');
  });

  test('extra vars win over the environment', () => {
    process.env.OUR_AGENT_BOTH = 'env';
    assert.equal(substituteVars('${OUR_AGENT_BOTH}', { OUR_AGENT_BOTH: 'extra' }), 'extra');
    delete process.env.OUR_AGENT_BOTH;
  });

  test('non-strings pass straight through', () => {
    assert.equal(substituteVars(42), 42);
    assert.equal(substituteVars(null), null);
  });

  test('several references in one value all resolve', () => {
    process.env.OUR_AGENT_A = 'x';
    process.env.OUR_AGENT_B = 'y';
    assert.equal(substituteVars('${OUR_AGENT_A}-${OUR_AGENT_B}-${OUR_AGENT_A}'), 'x-y-x');
    delete process.env.OUR_AGENT_A;
    delete process.env.OUR_AGENT_B;
  });
});

describe('substituteConf', () => {
  test('rewrites string values across sections in place', () => {
    process.env.OUR_AGENT_NAME = 'Injected';
    const doc = parseConf('[agent]\nname = "${OUR_AGENT_NAME}"\n');
    substituteConf(doc);
    assert.equal(doc.get('agent', 'name'), 'Injected');
    delete process.env.OUR_AGENT_NAME;
  });

  test('a failure names the section and key that caused it', () => {
    delete process.env.OUR_AGENT_MISSING;
    const doc = parseConf('[agent]\nname = "${OUR_AGENT_MISSING:?boom}"\n');
    assert.throws(() => substituteConf(doc), /\[agent\]\.name.*boom/s);
  });

  test('array entries are substituted too', () => {
    process.env.OUR_AGENT_ELEM = 'E';
    const doc = parseConf('[tools]\nallow = ["${OUR_AGENT_ELEM}"]\n');
    substituteConf(doc);
    assert.deepEqual(doc.get('tools', 'allow'), ['E']);
    delete process.env.OUR_AGENT_ELEM;
  });
});


describe('shipped examples', () => {
  // If one of these stops parsing, the docs are lying to the reader.
  const dir = new URL('../examples/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.conf'));

  test('there is more than one example', () => {
    assert.ok(files.length > 1, `expected examples, found ${files.length}`);
  });

  for (const file of files) {
    test(`${file} parses`, () => {
      const text = readFileSync(new URL(file, dir), 'utf8');
      const doc = parseConf(text, file);
      assert.ok(doc.sectionsList().length > 0);
    });
  }
});
