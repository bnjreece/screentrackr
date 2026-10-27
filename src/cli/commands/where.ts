/** `screentrackr where`: a JustWatch search link for a movie. */
import type { Command } from '../command.js';
import { notBuiltYet } from './stub.js';

export const where: Command = {
  name: 'where',
  summary: 'Print a JustWatch search link for where to watch a movie',
  usage: 'where <id|tconst|title> [--country <cc>] [--open]',
  options: {},
  run() {
    notBuiltYet('where');
  },
};
