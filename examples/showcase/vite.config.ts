import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

// tambour is aliased straight to the library SOURCE (no npm link), and
// react/rxjs/immer/@legendapp/state resolve from the repo root node_modules —
// both together guarantee singletons. (Dual Legend instances fail silently;
// the RN apps pin these in metro.config.js for the same reason.)
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      'tambour/react': path.resolve(here, '../../src/react.ts'),
      tambour: path.resolve(here, '../../src/index.ts'),
    },
    dedupe: ['react', 'react-dom', '@legendapp/state', 'rxjs', 'immer'],
  },
  server: {
    fs: { allow: [path.resolve(here, '../..')] },
  },
})
