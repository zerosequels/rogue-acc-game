import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  server: { port: 5173, open: false },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
  // rapier2d-compat inlines its wasm as base64, so no special wasm plugin is needed.
  optimizeDeps: { exclude: [] },
})
