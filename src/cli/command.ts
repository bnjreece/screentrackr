import type { Ctx } from './context.js';

export interface OptionSpec {
  type: 'string' | 'boolean';
  multiple?: boolean;
  short?: string;
  /** Shown in help, e.g. `<name>`. */
  value?: string;
  description: string;
}

export type Values = Record<string, string | boolean | string[] | boolean[] | undefined>;

export interface Command {
  name: string;
  summary: string;
  /** Usage after `screentrackr`, e.g. `show <id|tconst|title>`. */
  usage: string;
  /** Extra help text shown under the usage line. */
  details?: string;
  options: Record<string, OptionSpec>;
  run(ctx: Ctx, positionals: string[], values: Values): Promise<void> | void;
}

export function str(values: Values, key: string): string | undefined {
  const v = values[key];
  return typeof v === 'string' ? v : undefined;
}

export function strs(values: Values, key: string): string[] | undefined {
  const v = values[key];
  return Array.isArray(v) && v.length ? (v as string[]) : undefined;
}

export function bool(values: Values, key: string): boolean {
  return values[key] === true;
}
