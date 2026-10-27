/** `screentrackr pick`: what to watch tonight, from the search filters. */
import type { Command } from '../command.js';
import { notBuiltYet } from './stub.js';

export const pick: Command = {
  name: 'pick',
  summary: 'Pick a movie to watch from your library, at random within filters',
  usage: 'pick [filters] [-n <1-10>] [--seed <n>] [--priority-first] [--any-status]',
  options: {},
  run() {
    notBuiltYet('pick');
  },
};
