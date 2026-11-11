import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { createRequire } from 'node:module';

const BUFFER = createRequire(import.meta.url).resolve('buffer/');

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "media-src 'self' blob:",
  "frame-src 'self' blob:",
  "connect-src 'self' wss://*.web.telegram.org",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

// CSP only in production builds (the dev server needs inline HMR + ws://localhost).
const cspPlugin = {
  name: 't-drive-csp',
  apply: 'build',
  transformIndexHtml: (html) =>
    html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
};

export default defineConfig({
  base: './',
  plugins: [
    nodePolyfills({
      include: ['buffer', 'process', 'util', 'os', 'path', 'events', 'stream', 'crypto', 'net', 'constants'],
      globals: { Buffer: false, process: true, global: true },
      // Exactly ONE Buffer class: GramJS checks `instanceof Buffer`. The plugin's
      // own shim ships separate ESM and CJS builds (two classes), so we point every
      // `require('buffer')` at the npm package and set globalThis.Buffer from it
      // in src/polyfills.js.
      overrides: { buffer: BUFFER },
    }),
    cspPlugin,
  ],
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
    // HARNESS=1 also builds the fake-Telegram UI harness to test the prod bundle.
    rollupOptions: process.env.HARNESS ? { input: ['index.html', 'test/harness.html'] } : undefined,
  },
  test: {
    environment: 'node',
  },
});
