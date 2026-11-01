import { describe, expect, it } from 'vitest'
import { serverCodeInChunks } from './core-ids-only'

describe('K-33 产物守卫：不带服务端代码', () => {
  it('只有 packages/core/src/ids.ts 和普通依赖时通过', () => {
    expect(serverCodeInChunks({
      'assets/sidebar.js': ['/r/packages/core/src/ids.ts', '/r/apps/console/src/lib/entity-id.ts'],
      'assets/vendor-misc.js': ['/r/node_modules/.pnpm/clsx@2.1.1/node_modules/clsx/dist/clsx.mjs'],
    })).toEqual([])
  })
  it('ulid（pnpm 布局或扁平布局）进了 chunk 就报出来', () => {
    expect(serverCodeInChunks({
      'assets/vendor-misc.js': ['/r/node_modules/.pnpm/ulid@2.4.0/node_modules/ulid/dist/index.esm.js', '/r/node_modules/ulid/dist/index.esm.js'],
    })).toHaveLength(2)
  })
  it('packages/ 下其他模块（core 根、config、store）进了 chunk 就报出来', () => {
    expect(serverCodeInChunks({
      'assets/x.js': ['/r/packages/core/src/index.ts', '/r/packages/core/src/config.ts', '/r/packages/store/src/index.ts', '/r/packages/core/src/id-generator.ts', '/r/packages/core/src/errors/codes.ts'],
    })).toHaveLength(5)
  })
  it('item 11：额外只放行 packages/core/src/sso-error-codes.ts（纯模块）', () => {
    expect(serverCodeInChunks({
      'assets/sign-in.js': ['/r/packages/core/src/sso-error-codes.ts', '/r/apps/console/src/features/auth/sign-in/sso-error.ts'],
      'assets/sidebar.js': ['C:\\r\\packages\\core\\src\\sso-error-codes.ts'],
    })).toEqual([])
  })
  it('放行是按完整文件名匹配：同目录其他文件、改名的近似文件照样报出来', () => {
    expect(serverCodeInChunks({
      'assets/x.js': [
        '/r/packages/core/src/outbound.ts',
        '/r/packages/core/src/sso-error-codes.ts.bak',
        '/r/packages/core/src/x-sso-error-codes.ts',
        '/r/packages/identity/src/sso-error-codes.ts',
      ],
    })).toHaveLength(4)
  })
})
