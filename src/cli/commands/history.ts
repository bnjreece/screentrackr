/** `screentrackr log` and `screentrackr history`: record plays and list them. */
import type { Command } from '../command.js';
import { notBuiltYet } from './stub.js';

export const log: Command = {
  name: 'log',
  summary: 'Record a play of a movie (default today)',
  usage: 'log <id|tconst|title> [--on <date>] [--rewatch] [--rating <1-10>] [--keep-status]',
  options: {},
  run() {
    notBuiltYet('log');
  },
};

export const history: Command = {
  name: 'history',
  summary: 'List your plays, newest first',
  usage: 'history [<id|tconst|title>] [--year <yyyy>] [--from <date>] [--to <date>] [--source <source>] [-n <limit>] [--remove <viewing-id>]',
  options: {},
  run() {
    notBuiltYet('history');
  },
};
