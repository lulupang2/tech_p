import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [sveltekit()],
  test: {
    include: ['test/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
    environment: 'node',
  },
});
