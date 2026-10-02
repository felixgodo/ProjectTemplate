import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // ./dev.sh start gibt Port und Backend-Adresse vor; die Vorgaben hier gelten für `npm run dev`.
    port: 5200,
    proxy: {
      // Im Betrieb liefert nginx Oberfläche und API unter derselben Herkunft aus. Der Proxy bildet
      // das für die Entwicklung nach, damit im Code keine absoluten Adressen stehen.
      '/api': {
        target: process.env.BACKEND_URL ?? 'http://localhost:8100',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
})
