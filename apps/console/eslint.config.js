// 最小配置：typed lint 下的 no-floating-promises 为 error（所有 Promise 必须显式处理）。
// react-hooks / react-refresh 只为让源码里已有的 eslint-disable 注释能解析，两条规则设为 warn，不计入失败。
// 需要更多规则时在此追加；不引入 recommended 预设，避免一次性带进大量无关改动。
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'public/**', 'src/routeTree.gen.ts'] },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { '@typescript-eslint': tseslint.plugin, 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      // ignoreVoid: false —— `void promise` 也算未处理，必须走 lib/settle 的 helper。
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: false }],
      // 只为让已有的 disable 注释被识别；tanstack-table.d.ts 的 no-unused-vars 注释同理。
      '@typescript-eslint/no-unused-vars': 'warn',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': 'warn',
    },
  }
)
