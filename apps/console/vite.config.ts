import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import { fileURLToPath, URL } from 'node:url'
import { sonnerNoInsertCss } from './vite-plugins/sonner-no-insert-css.ts'
import { styleSingletonAdopted } from './vite-plugins/style-singleton-adopted.ts'
import { radixViewportStyleStatic } from './vite-plugins/radix-viewport-style-static.ts'
import { noInlineArtifacts } from './vite-plugins/no-inline-artifacts.ts'
import { chunkBudget, vendorChunk } from './vite-plugins/chunk-budget.ts'
import { productionBuildGuard } from './vite-plugins/production-build-guard.ts'
import { coreIdsOnly } from './vite-plugins/core-ids-only.ts'

const api = process.env.FORGE_API_URL ?? 'http://127.0.0.1:3100'

// 基于 shadcn-admin（MIT，见 LICENSE）。产物放 dist/，挂在 /next/，旧控制台仍在 /。
export default defineConfig({
  base: '/next/',
  // 旧控制台在 public/，不能被当成 Vite 的静态目录复制进 dist。
  publicDir: false,
  // FE-CSP-01：sonner 不在运行时插 <style>，样式由 src/styles/index.css 静态引入
  // FE-CSP-03：Radix 弹层的滚动锁样式改走 adoptedStyleSheets
  // FE-CSP-04：Radix ScrollArea / Select Viewport 的 <style> 去掉，规则静态写在 src/styles/radix-viewport.css（锁版本）
  // 产物断言：dist 里出现内联脚本 / 注入式内联样式就让构建失败（vite-plugins/no-inline-artifacts.ts）
  plugins: [
    productionBuildGuard(),
    coreIdsOnly(),
    sonnerNoInsertCss(),
    styleSingletonAdopted(),
    radixViewportStyleStatic(),
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    react(),
    tailwindcss(),
    noInlineArtifacts(),
    chunkBudget(),
  ],
  // K-33：id 规则直接引用 packages/core/src/ids.ts（console 不依赖 @forge/core 包，不改 package.json / lockfile）。
  // item 11：SSO 错误码白名单直接引用纯模块 packages/core/src/sso-error-codes.ts。
  // 只给 @forge/core/ids、@forge/core/sso-error-codes 这两个单文件入口，不暴露 @forge/core 根（那会拉进服务端配置和 node:crypto）；
  // ids.ts 里 ulid 只被 ulidWithPrefix 用到，产物里不能出现（构建后核对 chunk 清单）。
  resolve: {
    alias: {
      '@forge/core/ids': fileURLToPath(new URL('../../packages/core/src/ids.ts', import.meta.url)),
      '@forge/core/sso-error-codes': fileURLToPath(new URL('../../packages/core/src/sso-error-codes.ts', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5175,
    proxy: Object.fromEntries(['/admin', '/auth', '/open', '/integration', '/healthz', '/readyz'].map((path) => [path, { target: api, changeOrigin: false }])),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // OPS-019：第三方依赖拆成 vendor-react / vendor-radix / vendor-tanstack / vendor-zod / vendor-motion / vendor-misc，
    // 业务代码仍按路由 autoCodeSplitting；chunkBudget() 守住入口 ≤200 kB、单块 ≤250 kB。
    rollupOptions: { output: { manualChunks: vendorChunk } },
  },
})
