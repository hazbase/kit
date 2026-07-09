import { defineConfig } from 'tsup';
export default defineConfig([
  {
    entry: ['src/index.ts', 'src/wallet.ts', 'src/x402.ts', 'src/extension.ts', 'src/browser.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
    outDir: 'dist',
    splitting: false,
    outExtension({ format }) {
      return {
        js: format === 'esm' ? '.mjs' : '.js',
      };
    },
  },
  {
    entry: {
      browser: 'src/browser.ts',
    },
    format: ['iife'],
    globalName: 'HazbaseKit',
    platform: 'browser',
    dts: false,
    clean: false,
    outDir: 'dist',
    splitting: false,
  },
]);
