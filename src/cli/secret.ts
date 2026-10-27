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

/** Ask on the terminal with the typed characters hidden. Only call when stdin is a TTY. */
export function promptHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  return new Promise((resolve, reject) => {
    let value = '';
    process.stderr.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const done = (err?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stderr.write('\n');
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
    stdin.on('data', onData);
  });
}
