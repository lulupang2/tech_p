import svelteConfig from './apps/web/svelte.config.js';

import js from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: [
      '**/.svelte-kit/**',
      '**/coverage/**',
      '**/dist/**',
      '**/node_modules/**',
      'docs/**',
      'experiments/**',
    ],
  },
  {
    files: ['**/*.{cjs,cts,js,mjs,mts,ts}'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...svelte.configs.recommended,
  {
    files: ['**/*.svelte', '**/*.svelte.{js,ts}'],
    languageOptions: {
      parserOptions: {
        extraFileExtensions: ['.svelte'],
        parser: tseslint.parser,
        svelteConfig,
      },
    },
  },
  eslintConfigPrettier,
];
