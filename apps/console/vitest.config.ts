import { defineConfig } from 'vitest/config'
import { fileURLToPath, URL } from 'node:url'

// 控制台单测：只测纯逻辑（权限 helper、路由守卫），node 环境，不需要 DOM。
// 用法：pnpm --filter @forge/console test
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
})
