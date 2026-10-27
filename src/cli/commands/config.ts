/** `screentrackr config`: get, set or unset a saved setting (config.json). */
import { CONFIG_KEYS, getConfigValue, loadConfig, setConfigValue, unsetConfigValue, updateConfig, type ConfigKey } from '../../core/config.js';
import { justWatchCountry } from '../../core/where.js';
import type { Command } from '../command.js';
import { UserError } from '../context.js';

const USAGE = 'config <get|set|unset> <key> [<value>]';

function key(k: string | undefined): ConfigKey {
  if (k === undefined) throw new UserError(`Usage: screentrackr ${USAGE} (settings: ${CONFIG_KEYS.join(', ')})`);
  if (!(CONFIG_KEYS as readonly string[]).includes(k)) throw new UserError(`Unknown setting "${k}" (settings: ${CONFIG_KEYS.join(', ')})`);
  return k as ConfigKey;
}

/** A note on what a value means where it is used: `gb` is JustWatch's `uk`. */
function note(k: ConfigKey, v: string): string {
  if (k === 'country' && justWatchCountry(v) !== v) return ` (JustWatch's path for it is ${justWatchCountry(v)})`;
  return '';
}

export const configCmd: Command = {
  name: 'config',
  summary: 'Get, set or unset a saved setting',
  usage: USAGE,
  details: `Settings: country (the two-letter country for where-to-watch links, such as us, uk or de).\nSaved in config.json in the data directory, owner-only. Tokens and passwords are never saved there.\n\`config get\` with no key prints every setting.`,
  options: {},
  run(ctx, pos) {
    const [action, k, value, ...extra] = pos;
    if (extra.length) throw new UserError(`Unexpected argument "${extra[0]}"`);
    switch (action) {
      case 'get': {
        if (value !== undefined) throw new UserError(`Unexpected argument "${value}"`);
        const config = loadConfig(ctx.home);
        if (k === undefined) {
          const all = Object.fromEntries(CONFIG_KEYS.map((c) => [c, getConfigValue(config, c) ?? null]));
          ctx.emit(all, () => CONFIG_KEYS.map((c) => `${c} = ${all[c] ?? '(not set)'}`).join('\n'));
          return;
        }
        const name = key(k);
        const v = getConfigValue(config, name) ?? null;
        ctx.emit({ key: name, value: v }, () => (v === null ? `${name} is not set` : v));
        return;
      }
      case 'set': {
        const name = key(k);
        if (value === undefined || value.trim() === '') throw new UserError(`Usage: screentrackr config set ${name} <value>`);
        if (name === 'country') justWatchCountry(value);
        const next = updateConfig(ctx.home, (c) => setConfigValue(c, name, value));
        const v = getConfigValue(next, name) as string;
        ctx.emit({ key: name, value: v }, () => `${name} = ${v}${note(name, v)}`);
        return;
      }
      case 'unset': {
        const name = key(k);
        if (value !== undefined) throw new UserError(`Unexpected argument "${value}"`);
        const was = getConfigValue(loadConfig(ctx.home), name);
        if (was !== undefined) updateConfig(ctx.home, (c) => unsetConfigValue(c, name));
        ctx.emit({ key: name, value: null, removed: was !== undefined }, () => (was === undefined ? `${name} was not set` : `${name} unset`));
        return;
      }
      default:
        throw new UserError(action === undefined ? `Usage: screentrackr ${USAGE}` : `Unknown action "${action}". Use get, set or unset.`);
    }
  },
};
