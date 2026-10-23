/**
 * Strip terminal control characters from text before it reaches a terminal.
 * Titles, names and file contents are untrusted: an imported title could carry
 * escape sequences that rewrite the screen or spoof output. Keeps newlines and
 * tabs, plus the two bold sequences the table formatter itself emits.
 */
// eslint-disable-next-line no-control-regex
const OWN_SEQUENCES = /(\u001b\[1m|\u001b\[22m)/;
// C0 controls except \t and \n, DEL, C1 controls, and bidi override/isolate characters.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

export function sanitizeTerminal(text: string): string {
  return text
    .split(OWN_SEQUENCES)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(UNSAFE, ' ')))
    .join('');
}

/** Flatten one cell value: also turns newlines and tabs into spaces. */
export function cleanCell(s: string): string {
  return sanitizeTerminal(s).replace(/[\t\n]+/g, ' ');
}

// DEL, C1 controls and bidi characters survive JSON.stringify unescaped.
const JSON_UNSAFE = /[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

/** JSON.stringify, with characters a terminal could act on written as \uXXXX. Parses to the same value. */
export function safeJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(JSON_UNSAFE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
