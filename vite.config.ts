import { defineConfig } from 'vite';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

export default defineConfig({
  optimizeDeps: { exclude: ['maplibre-gl'] },
  plugins: [{
    name: 'keep-map-packs-out-of-embedded-web-assets',
    closeBundle() { rmSync(resolve('dist/maps'), { recursive: true, force: true }); },
  }],
});
