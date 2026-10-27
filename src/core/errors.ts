/**
 * The user-facing error every core module throws for bad input or a missing
 * record. Kept in its own module so core files that library.ts imports (such
 * as viewings.ts) can throw it without an import cycle. The CLI maps it to
 * exit code 1; the MCP server reports it as a tool error.
 */
export class LibraryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LibraryError';
  }
}
