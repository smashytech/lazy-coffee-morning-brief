import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const proxyPlugin = {
  name: 'morning-brief-proxy',
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {

      // ── RSS feed proxy ──────────────────────────────────────────────
      if (req.url.startsWith('/proxy?')) {
        const params  = new URLSearchParams(req.url.slice('/proxy?'.length))
        const feedUrl = params.get('url')
        if (!feedUrl) { res.writeHead(400); res.end('Missing ?url='); return }

        console.log(`[proxy/feed] fetching: ${feedUrl}`)
        try {
          const upstream = await fetch(feedUrl, {
            redirect: 'follow',
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
              'Accept-Language': 'en-US,en;q=0.9',
              'Cache-Control': 'no-cache',
            }
          })
          const body = await upstream.text()
          console.log(`[proxy/feed] ${upstream.status}, ${body.length} bytes — preview: ${body.slice(0, 150)}`)
          res.writeHead(upstream.status, {
            'Content-Type': upstream.headers.get('content-type') || 'application/xml',
            'Access-Control-Allow-Origin': '*',
          })
          res.end(body)
        } catch (err) {
          console.error(`[proxy/feed] FAILED:`, err.message)
          res.writeHead(502); res.end(`Feed fetch failed: ${err.message}`)
        }
        return
      }

      // ── Local LLM proxy (Ollama / Open-WebUI) ──────────────────────
      // Accepts: POST /localllm?url=http://192.168.x.x:11434
      // Forwards the request body to that server's /v1/chat/completions
      if (req.url.startsWith('/localllm')) {
        const qmark   = req.url.indexOf('?')
        const params  = new URLSearchParams(qmark >= 0 ? req.url.slice(qmark + 1) : '')
        const baseUrl = params.get('url')
        if (!baseUrl) { res.writeHead(400); res.end('Missing ?url='); return }

        const apiUrl = baseUrl.replace(/\/$/, '') + '/v1/chat/completions'
        console.log(`[proxy/localllm] forwarding to: ${apiUrl}`)
<<<<<<< HEAD
=======

        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        const body = Buffer.concat(chunks)

        try {
          const upstream = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
          })
          const respBody = await upstream.text()
          console.log(`[proxy/localllm] ${upstream.status}, ${respBody.length} bytes`)
          res.writeHead(upstream.status, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          })
          res.end(respBody)
        } catch (err) {
          console.error(`[proxy/localllm] FAILED:`, err.message)
          res.writeHead(502); res.end(`Local LLM fetch failed: ${err.message}`)
        }
        return
      }

      // ── Anthropic API proxy ─────────────────────────────────────────
      if (req.url.startsWith('/anthropic/')) {
        const apiKey = process.env.ANTHROPIC_API_KEY
        const apiUrl = 'https://api.anthropic.com' + req.url.replace('/anthropic', '')
        if (!apiKey) console.error('[proxy/anthropic] WARNING: ANTHROPIC_API_KEY not set!')
        else console.log('[proxy/anthropic] key:', apiKey.slice(0, 8) + '...')
>>>>>>> 5179f143d46faa654aa496c40b4ef9023b86c246

        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        const body = Buffer.concat(chunks)

        try {
          const upstream = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
          })
          const respBody = await upstream.text()
          console.log(`[proxy/localllm] ${upstream.status}, ${respBody.length} bytes`)
          res.writeHead(upstream.status, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          })
          res.end(respBody)
        } catch (err) {
          console.error(`[proxy/localllm] FAILED:`, err.message)
          res.writeHead(502); res.end(`Local LLM fetch failed: ${err.message}`)
        }
        return
      }

      // ── Anthropic API proxy ─────────────────────────────────────────
      if (req.url.startsWith('/anthropic/')) {
        const apiKey = process.env.ANTHROPIC_API_KEY
        if (!apiKey) {
          console.error('[proxy/anthropic] ANTHROPIC_API_KEY not set — refusing request')
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            error: { message: 'ANTHROPIC_API_KEY is not set on the server. Add it to .env and restart the dev server.' }
          }))
          return
        }
        const apiUrl = 'https://api.anthropic.com' + req.url.replace('/anthropic', '')
        console.log('[proxy/anthropic] key:', apiKey.slice(0, 8) + '...')

        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        const body = Buffer.concat(chunks)

        try {
          const isGet = req.method === 'GET' || req.method === 'HEAD'
          const upstream = await fetch(apiUrl, {
            method: req.method,
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01',
            },
            ...(isGet ? {} : { body }),
          })
          const respBody = await upstream.text()
          console.log(`[proxy/anthropic] ${upstream.status}, ${respBody.length} bytes`)
          res.writeHead(upstream.status, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          })
          res.end(respBody)
        } catch (err) {
          console.error(`[proxy/anthropic] FAILED:`, err.message)
          res.writeHead(502); res.end(`API fetch failed: ${err.message}`)
        }
        return
      }

      next()
    })
  }
}

export default defineConfig({
  plugins: [react(), proxyPlugin],
})
