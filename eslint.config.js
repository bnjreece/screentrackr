import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'build/', 'coverage/', 'node_modules/', 'docs/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/core/**/*.ts'],
    rules: {
      // core/ must never write to stdout (stdout belongs to JSON-RPC in mcp mode).
      'no-console': ['error', { allow: ['error', 'warn'] }],
    },
  },
);
