/** `screentrackr mcp`: serve the MCP tools over stdio. Stdout carries JSON-RPC only. */
import { serveStdio } from '../../mcp/server.js';
import type { Command } from '../command.js';
import { UserError } from '../context.js';

export const mcp: Command = {
  name: 'mcp',
  summary: 'Start the MCP server on stdio',
  usage: 'mcp',
  details: [
    'For MCP clients such as Claude Code:',
    '  claude mcp add screentrackr -- npx -y screentrackr mcp',
    'Stdout carries JSON-RPC only; notices go to stderr. Stops when the client disconnects.',
  ].join('\n'),
  options: {},
  async run(ctx, pos) {
    if (pos.length) throw new UserError('Usage: screentrackr mcp');
    const db = ctx.db();
    ctx.log(`screentrackr MCP server on stdio (data: ${ctx.home})`);
    await serveStdio(db);
  },
};
