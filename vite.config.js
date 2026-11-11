import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

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
      globals: { Buffer: true, process: true, global: true },
    }),
    cspPlugin,
  ],
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
  },
  test: {
    environment: 'node',
  },
});
