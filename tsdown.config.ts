import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { 'client': 'src/client/index.ts' },
  outDir: 'client',
  format: ['cjs'],
  clean: true,
  target: 'es2022',
  platform: 'browser',
  external: [
    'react',
    'react-dom',
    'react/jsx-runtime',
    'react/jsx-dev-runtime',
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-ui-sidebar-right',
    '@deepseek-ai/dsh-client-ui-settings',
    '@deepseek-ai/dsh-client-ui-primitives',
  ],
})
