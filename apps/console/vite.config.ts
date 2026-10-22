import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import { fileURLToPath, URL } from 'node:url'

const api = process.env.FORGE_API_URL ?? 'http://127.0.0.1:3100'

// 基于 shadcn-admin（MIT，见 LICENSE）。产物放 dist/，挂在 /next/，旧控制台仍在 /。
export default defineConfig({
  base: '/next/',
  // 旧控制台在 public/，不能被当成 Vite 的静态目录复制进 dist。
  publicDir: false,
  plugins: [tanstackRouter({ target: 'react', autoCodeSplitting: true }), react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    port: 5175,
    proxy: Object.fromEntries(['/admin', '/auth', '/open', '/integration', '/healthz', '/readyz'].map((path) => [path, { target: api, changeOrigin: false }])),
  },
  build: { outDir: 'dist', emptyOutDir: true },
})
