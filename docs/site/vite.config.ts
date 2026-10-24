import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { fumadocsMdx } from 'fumadocs-mdx/vite';
import { nitro } from 'nitro/vite';

export default defineConfig({
  server: {
    port: 3000,
    strictPort: true,
  },
  plugins: [
    fumadocsMdx(),
    tailwindcss(),
    // Serve docs through Start so Accept: text/markdown reaches its middleware.
    tanstackStart(),
    react(),
    // please see https://tanstack.com/start/latest/docs/framework/react/guide/hosting#nitro for guides on hosting
    nitro({
      preset: 'bun',
      // Radix imports tslib through its Node export; bundle it for standalone output.
      noExternals: ['tslib'],
    }),
  ],
  resolve: {
    tsconfigPaths: true,
    alias: {
      '@/site.config': fileURLToPath(new URL('./site.config.ts', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      tslib: 'tslib/tslib.es6.js',
    },
  },
});
