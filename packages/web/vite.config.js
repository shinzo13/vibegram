import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
  build: { outDir: 'dist', emptyOutDir: true },
  // Development runs against the live hub; in production the same hub serves
  // the built bundle.
  server: { proxy: { '/api': 'http://localhost:4321' } },
});
