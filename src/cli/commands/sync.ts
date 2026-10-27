/** `screentrackr sync`: re-run the saved import sources (Plex, Jellyfin, the TV app). */
import type { Command } from '../command.js';
import { notBuiltYet } from './stub.js';

export const sync: Command = {
  name: 'sync',
  summary: 'Re-import your saved sources (Plex, Jellyfin, the TV app)',
  usage: 'sync [add <kind> | list | remove <kind> | status | launchd] [--only <kind>] [--dry-run]',
  options: {},
  run() {
    notBuiltYet('sync');
  },
};
