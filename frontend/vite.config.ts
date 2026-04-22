import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [solid(), tailwindcss()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
  // `@polymarket/clob-client` is a CJS package that bundles mixed
  // ES/CommonJS deps. Rollup's production build needs this flag or the
  // bundle silently breaks on imports that use `module.exports`.
  build: {
    commonjsOptions: {
      transformMixedEsModules: true,
    },
  },
  optimizeDeps: {
    include: ['@polymarket/clob-client'],
  },
})
