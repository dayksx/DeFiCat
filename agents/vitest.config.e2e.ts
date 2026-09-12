import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    // Ces tests démarrent de vrais serveurs éphémères — Temporal télécharge le
    // sien au premier lancement — et bundlent le code de workflow.
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
