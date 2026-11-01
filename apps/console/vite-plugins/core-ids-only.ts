import type { Plugin } from 'vite'

/** Shared ID/SSO constants are pure; server generators and all other package modules stay outside client chunks. */
const ALLOWED_CORE_MODULE = /[\\/]packages[\\/]core[\\/]src[\\/](?:ids|sso-error-codes)\.ts$/
const ALLOWED_SDK_MODULE = /[\\/]packages[\\/]sdk[\\/]src[\\/](?:job|message)-client\.ts$/
const SERVER_MODULE = /[\\/]packages[\\/]/
const ULID_MODULE = /[\\/]node_modules[\\/](?:\.pnpm[\\/][^\\/]+[\\/]node_modules[\\/])?ulid[\\/]/

export function serverCodeInChunks(chunks: Record<string, readonly string[]>): string[] {
  const bad: string[] = []
  for (const [file, ids] of Object.entries(chunks)) {
    for (const id of ids) {
      const clean = id.split('?')[0].replace(/^\0/, '')
      if (ULID_MODULE.test(clean) || (SERVER_MODULE.test(clean) && !ALLOWED_CORE_MODULE.test(clean) && !ALLOWED_SDK_MODULE.test(clean))) bad.push(`${file}: ${clean}`)
    }
  }
  return bad
}

export function coreIdsOnly(): Plugin {
  return {
    name: 'forge:core-ids-only',
    enforce: 'pre',
    generateBundle(_options, bundle) {
      const chunks: Record<string, string[]> = {}
      for (const [file, out] of Object.entries(bundle)) if (out.type === 'chunk') chunks[file] = Object.keys(out.modules)
      const bad = serverCodeInChunks(chunks)
      if (bad.length) this.error(`[forge:core-ids-only] 产物里混进了服务端代码（只允许 packages/core/src/ids.ts、sso-error-codes.ts 的常量）：\n${bad.join('\n')}`)
    },
  }
}
