import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { appendFileSync } from 'node:fs';

const DEBUG_LOG_PATH = '/tmp/bv-debug.log';

// Dev-only endpoint: receives console log batches from the browser and writes
// them to /tmp/bv-debug.log so Claude/CLI can tail them.
function browserLogSink(): Plugin {
  return {
    name: 'bv-browser-log-sink',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__bvlog', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          try {
            appendFileSync(DEBUG_LOG_PATH, body + '\n', 'utf8');
            res.statusCode = 204;
            res.end();
          } catch (err) {
            res.statusCode = 500;
            res.end((err as Error).message);
          }
        });
      });
    },
  };
}

export default defineConfig({
  // GitHub Pages serves this repo at /BusinessVault/. Vite bakes BASE_URL into
  // asset paths, and React-Router's basename picks it up in main.tsx. Override
  // with BV_BASE=/ for a root-hosted deploy (e.g. custom domain).
  base: process.env.BV_BASE ?? '/BusinessVault/',
  plugins: [react(), browserLogSink()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5173,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: [
      'src/**/*.spec.ts',
      'src/**/*.spec.tsx',
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      'tests/**/*.spec.ts',
    ],
  },
});
