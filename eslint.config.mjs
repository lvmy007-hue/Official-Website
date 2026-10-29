// 静态检查配置（P1-09，12 章 12.6）：纳入 build 前的质量门槛（`pnpm lint`，ci.mjs 的 lint 步骤）。
// 范围：新 ERP 前端（src/erp）、后端与共享包源码、脚本。官网源码与旧过渡页面不在范围内（官网零改动；旧页面 P5-12 删除）。
import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['**/dist/**', '**/dist-ssr/**', '**/node_modules/**', '**/coverage/**', 'database/**', 'infrastructure/**', 'src/home/**', 'src/ui/**', 'public/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/erp/**/*.{ts,tsx}', 'src/api.ts'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    files: ['apps/**/*.ts', 'packages/**/*.ts', 'scripts/**/*.{mjs,cjs}'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // 命令行脚本的输出就是它的界面；旧的 CommonJS 脚本允许 require
    files: ['scripts/**/*.cjs'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    rules: {
      // 未使用的变量与导入一律报错；以下划线开头的参数视为有意忽略
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      // 少量必要的类型绕过（框架类型不完整处）必须写明理由，不得无说明地使用
      '@typescript-eslint/ban-ts-comment': ['error', { 'ts-expect-error': 'allow-with-description', 'ts-ignore': true, minimumDescriptionLength: 6 }],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'no-restricted-syntax': [
        'error',
        { selector: "CallExpression[callee.object.name='Message'][callee.property.name='success']", message: '不得无条件弹出成功提示；成功提示必须出现在服务端真实返回之后。' },
      ],
    },
  },
  {
    // 测试与脚本：放宽 any 与控制台输出
    files: ['**/*.test.{ts,tsx}', '**/testing/**', 'scripts/**', 'apps/*/src/scripts/**', 'apps/*/src/maintenance/*-cli.ts', 'src/erp/test/**'],
    rules: { '@typescript-eslint/no-explicit-any': 'off', 'no-console': 'off' },
  },
)
