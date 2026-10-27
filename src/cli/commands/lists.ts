/** `screentrackr lists` and `screentrackr list`: your own lists of movies. */
import type { Command } from '../command.js';
import { notBuiltYet } from './stub.js';

export const lists: Command = {
  name: 'lists',
  summary: 'Show your lists with their counts',
  usage: 'lists',
  options: {},
  run() {
    notBuiltYet('lists');
  },
};

export const list: Command = {
  name: 'list',
  summary: 'Create, fill, show, rename or delete one of your lists',
  usage: 'list <create|add|remove|show|rename|delete> <name> [<id|tconst|title>...]',
  options: {},
  run() {
    notBuiltYet('list');
  },
};
