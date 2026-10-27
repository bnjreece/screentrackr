/** `screentrackr config`: get, set or unset a saved setting (config.json). */
import type { Command } from '../command.js';
import { notBuiltYet } from './stub.js';

export const configCmd: Command = {
  name: 'config',
  summary: 'Get, set or unset a saved setting',
  usage: 'config <get|set|unset> <key> [<value>]',
  options: {},
  run() {
    notBuiltYet('config');
  },
};
