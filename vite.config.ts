import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  server: {
    // Bind IPv4 explicitly. Node 17+ defaults to the IPv6 loopback only, so
    // the server listens on [::1] while browsers resolve `localhost` to
    // 127.0.0.1 first and get connection refused. Use `npm run dev:lan` to
    // also expose on the local network (handy for testing on a phone).
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
    open: false,
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
  // rapier2d-compat inlines its wasm as base64, so no special wasm plugin is needed.
  optimizeDeps: { exclude: [] },
})
