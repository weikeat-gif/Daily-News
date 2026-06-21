import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
// @ts-expect-error The shared search helper is plain ESM used by Vite and Netlify.
import { searchNews } from './scripts/news_search.mjs'

function queryValue(requestUrl: string | undefined, key: string) {
  const queryString = requestUrl?.split('?')[1] || ''
  for (const pair of queryString.split('&')) {
    const [rawKey, rawValue = ''] = pair.split('=')
    if (decodeURIComponent(rawKey || '') === key) {
      return decodeURIComponent(rawValue.replace(/\+/g, ' '))
    }
  }
  return ''
}

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'daily-news-search-api',
      configureServer(server) {
        server.middlewares.use('/api/news-search', async (request, response) => {
          try {
            const payload = await searchNews(queryValue((request as { url?: string }).url, 'q'))
            response.setHeader('content-type', 'application/json; charset=utf-8')
            response.setHeader('cache-control', 'no-store')
            response.end(JSON.stringify(payload))
          } catch (error) {
            response.statusCode = 502
            response.setHeader('content-type', 'application/json; charset=utf-8')
            response.end(
              JSON.stringify({
                error: error instanceof Error ? error.message : 'News search failed',
              }),
            )
          }
        })
      },
    },
  ],
})
