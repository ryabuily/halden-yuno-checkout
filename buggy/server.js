/**
 * Halden staging checkout — BUGGY version server.
 *
 * This server exists only to make Sofia's broken staging code runnable for the
 * diagnosis demo. It reproduces the staging architecture faithfully:
 *
 *   ⚠ BUG #1–#2 (the ones that made the security lead go pale):
 *   /config.js injects BOTH the public AND the PRIVATE secret key into the
 *   browser. In Halden's real checkout.jsx the keys were hardcoded in the
 *   bundle; here they are injected from .env at serve time so this repo stays
 *   clean of real credentials — but the browser ends up in exactly the same
 *   state: the secret key is visible to anyone who opens DevTools.
 *
 *   The frontend then talks to api-sandbox.y.uno DIRECTLY from the browser.
 *   The backend route below (/api/create-payment) exists but is never called —
 *   exactly as in the staging code ("Sofia added this just in case").
 *
 * No webhook endpoint exists — "(no other Yuno-related endpoints exist)".
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') })
const express = require('express')
const path = require('path')

const app = express()
app.use((req, res, next) => { res.setHeader('Permissions-Policy', 'unload=*'); next() })

const PUB_KEY = process.env.YUNO_PUBLIC_API_KEY?.trim()
const SEC_KEY = process.env.YUNO_PRIVATE_SECRET_KEY?.trim()
const ACCOUNT = process.env.YUNO_ACCOUNT_CODE?.trim()

// Same-origin pass-through to api-sandbox.y.uno. Needed to keep the staging
// architecture RUNNABLE: browsers refuse to send the private-secret-key header
// cross-origin (the API's CORS preflight doesn't allow it), so the "browser
// talks to Yuno directly" design would die at the preflight. This dumb proxy
// forwards the request verbatim — including the leaked secret header, which
// stays fully visible in DevTools → Network. The leak is unchanged; only the
// transport works now.
app.use('/yuno-api', express.raw({ type: '*/*' }), async (req, res) => {
  try {
    const headers = {}
    for (const name of ['content-type', 'public-api-key', 'private-secret-key', 'x-idempotency-key']) {
      if (req.headers[name]) headers[name] = req.headers[name]
    }
    const hasBody = req.body instanceof Buffer && req.body.length > 0
    const upstream = await fetch(`https://api-sandbox.y.uno${req.url}`, {
      method: req.method,
      headers,
      body: hasBody ? req.body : undefined,
    })
    const text = await upstream.text()
    res.status(upstream.status).type(upstream.headers.get('content-type') || 'application/json').send(text)
  } catch (err) {
    res.status(502).json({ error: err.message })
  }
})

app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

// ⚠ BUG #1 (enables #2): ships the PRIVATE key to the browser. This is the credential leak.
app.get('/config.js', (req, res) => {
  res.type('application/javascript').send(
    `// Halden staging config — DO NOT SHIP
window.YUNO_PUBLIC_KEY = ${JSON.stringify(PUB_KEY || '')}
window.YUNO_SECRET_KEY = ${JSON.stringify(SEC_KEY || '')}   // ⚠ private key in the browser
window.YUNO_ACCOUNT_CODE = ${JSON.stringify(ACCOUNT || '')}
`)
})

// Sofia added this "just in case" but the frontend doesn't call it.
// Even if it were called it has its own problems (cf. BUG #7/#8): it blindly
// trusts the amount coming from the client, and sends no X-Idempotency-Key.
app.post('/api/create-payment', async (req, res) => {
  try {
    const { token, session, amount } = req.body
    const response = await fetch('https://api-sandbox.y.uno/v1/payments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'public-api-key': PUB_KEY,
        'private-secret-key': SEC_KEY,
      },
      body: JSON.stringify({ amount, checkout: { session }, payment_method: { token } }),
    })
    const payment = await response.json()
    res.json(payment)
  } catch (err) {
    res.status(502).json({ error: err.message })
  }
})

// (no other Yuno-related endpoints exist — no webhooks, no order store)

function listenOnFreePort(port, attemptsLeft = 20) {
  const server = app.listen(port)
  server.on('listening', () => {
    if (!PUB_KEY || !SEC_KEY || !ACCOUNT) {
      console.warn('⚠  Missing credentials — fill in ../.env first (YUNO_PUBLIC_API_KEY, YUNO_PRIVATE_SECRET_KEY, YUNO_ACCOUNT_CODE).')
    }
    console.log(`Halden checkout (BUGGY staging build) · http://localhost:${port}`)
  })
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      server.close()
      server.removeAllListeners()
      listenOnFreePort(port + 1, attemptsLeft - 1)
    } else {
      console.error('Failed to start server:', err.message)
      process.exit(1)
    }
  })
}
listenOnFreePort(parseInt(process.env.BUGGY_PORT, 10) || 3071)
