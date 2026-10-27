/** Reading a secret (a password or token) without echoing it or keeping it anywhere. */
import { readFileSync } from 'node:fs';
import { UserError } from './context.js';

/** All of stdin, without the one trailing newline a pipe or `echo` adds. */
export function readStdinSecret(what: string, flag: string): string {
  // Typed into a terminal, stdin echoes: refuse rather than show the secret.
  if (process.stdin.isTTY) {
    throw new UserError(`${flag} reads the ${what} from a pipe or file, not from the terminal (where it would show as you type).`);
  }
  let text: string;
  try {
    text = readFileSync(0, 'utf8');
  } catch (err) {
    throw new UserError(`Could not read the ${what} from stdin: ${(err as NodeJS.ErrnoException).code ?? 'read failed'}`);
  }
  return text.replace(/\r?\n$/, '');
}

/** The parts of a TTY stdin promptHidden uses. */
export interface SecretInput {
  setRawMode(mode: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
  setEncoding(encoding: BufferEncoding): unknown;
  on(event: 'data', listener: (chunk: string) => void): unknown;
  removeListener(event: 'data', listener: (chunk: string) => void): unknown;
}

/**
 * Ask on the terminal with the typed characters hidden. Only call when stdin
 * is a TTY. Echo is turned off before the question is shown, so a password
 * manager that types as soon as it sees the prompt is never echoed.
 */
export function promptHidden(
  question: string,
  input: SecretInput = process.stdin as unknown as SecretInput,
  output: { write(text: string): unknown } = process.stderr,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = '';
    input.setRawMode(true);
    input.setEncoding('utf8');
    const done = (err?: Error) => {
      input.removeListener('data', onData);
      input.setRawMode(false);
      input.pause();
      output.write('\n');
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return done();
        if (ch === '\u0003') return done(new UserError('Cancelled.'));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    input.on('data', onData);
    input.resume();
    output.write(question);
  });
}
