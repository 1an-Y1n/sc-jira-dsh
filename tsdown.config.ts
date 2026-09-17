import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/client/index.ts'],
  outDir: 'client',
  format: ['esm'],
  clean: true,
  target: 'es2022',
  platform: 'browser',
  external: [
    'react',
    'react-dom',
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-ui-sidebar-right',
    '@deepseek-ai/dsh-client-ui-settings',
    '@deepseek-ai/dsh-client-ui-primitives',
  ],
})
