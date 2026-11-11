import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// Frontend build. In dev, /api is proxied to the local Worker (wrangler dev on :8787).
// In production the Worker serves this build's dist/ directly (see worker/index.js).
export default defineConfig({
  root: path.resolve(import.meta.dirname, '.'),
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2020',
    cssCodeSplit: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return null
          if (id.includes('recharts')) return 'vendor-recharts'
          if (id.includes('react')) return 'vendor-react'
          return 'vendor'
        },
      },
    },
  },
})
