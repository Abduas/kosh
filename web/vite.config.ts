import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// In development, run `make api` (API on :3100) and `npm run dev` here, then
// open http://localhost:5173. Vite forwards /api to the Go server.
// To try it on your phone over Wi-Fi: `npm run dev -- --host`.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: { '/api': `http://127.0.0.1:${process.env.API_PORT ?? 3100}` },
  },
  build: {
    chunkSizeWarningLimit: 900,
  },
})
