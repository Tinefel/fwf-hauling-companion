import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { POST as receiptPost } from './api/receipt.js'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  if (!process.env.GEMINI_API_KEY && env.GEMINI_API_KEY) process.env.GEMINI_API_KEY = env.GEMINI_API_KEY

  return {
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'receipt-api-development-adapter',
      configureServer(server) {
        if (server.httpServer) {
          const httpServer = server.httpServer as typeof server.httpServer & { requestTimeout: number; headersTimeout: number; timeout: number }
          httpServer.requestTimeout = 0
          httpServer.headersTimeout = 0
          httpServer.timeout = 0
        }
        server.middlewares.use('/api/receipt', async (req, res, next) => {
          if (req.method !== 'POST') return next()
          const chunks: Buffer[] = []
          for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
          const request = new Request('http://localhost/api/receipt', {
            method: 'POST',
            headers: { 'content-type': String(req.headers['content-type'] ?? '') },
            body: Buffer.concat(chunks),
          })
          const response = await receiptPost(request)
          res.statusCode = response.status
          response.headers.forEach((value: string, key: string) => res.setHeader(key, value))
          res.end(Buffer.from(await response.arrayBuffer()))
        })
      },
    },
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'FWF Hauling Companion',
        short_name: 'FWF',
        description: 'Hauling quote and dispatch companion for Ford Wren Freight.',
        theme_color: '#5b321e',
        background_color: '#fffdf8',
        display: 'standalone',
        start_url: '/',
        icons: [
          {
            src: '/icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
        navigateFallback: 'index.html',
      },
    }),
  ],
  }
})
