import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The renderer is a static bundle loaded from disk by the Electron window.
export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react()],
  build: { outDir: '../../dist/renderer', emptyOutDir: true, target: 'chrome130' },
})
