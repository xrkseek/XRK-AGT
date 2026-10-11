export default [
  // ESLint v9 Flat Config
  // 说明：项目原先使用 `.eslintrc.cjs` + `.eslintignore`（已在 ESLint v9 过时）。
  // 这里把关键配置迁移到 Flat Config，重点用于发现：空引用、未使用变量/函数、无效语法等问题。
  {
    ignores: [
      // Dependencies
      'node_modules/',
      '.pnpm-store/',
      '**/.venv/**',
      '**/site-packages/**',

      // Build outputs
      'dist/',
      // 嵌套构建产物。上面那条 'dist/' 只匹配顶层目录，匹配不到
      // core/system-Core/www/*/dist/ 这类 Core 内嵌的前端 vite 产物——minified 代码
      // 里的 no-var / prefer-const 是压缩产物的固有形态，不是可修的源码问题。
      // 实测这一项就占了全仓 9257 条里的 9249 条。
      '**/dist/**',
      '**/.vite/**',
      'build/',
      'out/',
      '.next/',
      '.nuxt/',

      // Logs
      'logs/',
      '*.log',

      // Generated files
      '*.lock',
      'pnpm-lock.yaml',
      'package-lock.json',

      // Runtime data
      'data/server_bots/',
      'data/importsJson/',

      // Cache
      '.cache/',
      '.parcel-cache/',
      '.eslintcache',

      // Coverage
      'coverage/',
      '.nyc_output/',

      // TypeScript
      '**/*.d.ts',

      // Config files
      '**/*.config.js',
      '**/*.config.cjs',
      '**/*.config.mjs',

      // Core modules (exclude framework cores)
      'core/*',
      '!core/system-Core/',

      // Sub servers / third-party bundles
      'subserver/**',

      // Vendored libs
      'src/renderers/puppeteer/lib/**'
    ]
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        AgentRuntime: 'readonly',
        logger: 'readonly',
        PluginBase: 'readonly',
        msgSegment: 'readonly',
        Renderer: 'readonly',
        redis: 'readonly',
        sqlite: 'readonly'
      }
    },
    rules: {
      // 目标：定位“空引用 / 未使用函数(变量) / 明显无效代码”，避免被纯格式规则淹没
      'no-unreachable': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-extra-semi': 'error',
      'no-constant-condition': 'warn',

      // 未使用变量：作为 error 处理，配合代码规范强制 0 warning
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_'
        }
      ],
      'no-console': 'off',
      'no-debugger': 'error',
      'no-alert': 'error',

      // 明确冗余倾向
      'prefer-const': 'error',
      'no-var': 'error'
    }
  }
]
