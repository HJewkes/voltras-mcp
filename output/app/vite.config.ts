import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Fixtures and tokens.css live outside the app root, two levels up on the design branch.
export default defineConfig({
  plugins: [react()],
  server: { fs: { allow: ['../..'] } },
})
