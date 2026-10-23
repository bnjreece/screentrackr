/* eslint-disable no-control-regex */
import { describe, expect, it } from 'vitest';
import { cleanCell, safeJson, sanitizeTerminal } from '../src/cli/sanitize.js';

describe('sanitizeTerminal', () => {
  it('strips escape sequences, C1 controls and bidi overrides from untrusted text', () => {
    const evil = 'Night\u001b]0;pwned\u0007 Owl\u009b2J\u202eedoc';
    const out = sanitizeTerminal(evil);
    expect(out).not.toMatch(/[\u001b\u0007\u009b\u202e]/);
    expect(out).toContain('Night');
    expect(out).toContain('Owl');
  });

  it('keeps newlines, tabs and the formatter bold sequences', () => {
    expect(sanitizeTerminal('a\tb\nc')).toBe('a\tb\nc');
    expect(sanitizeTerminal('\u001b[1mTitle\u001b[22m')).toBe('\u001b[1mTitle\u001b[22m');
  });

  it('cleanCell also flattens newlines and tabs', () => {
    expect(cleanCell('a\nb\tc')).toBe('a b c');
  });
});

describe('safeJson', () => {
  it('escapes C1 and bidi characters but parses back to the same value', () => {
    const v = { title: 'A\u009b2JB\u202eC\u007f' };
    const s = safeJson(v);
    expect(s).not.toMatch(/[\u007f-\u009f\u202e]/);
    expect(JSON.parse(s)).toEqual(v);
  });
});
