/**
 * Halden embedded checkout — CORRECTED reference backend.
 *
 * Fixes vs the staging build (see README for the full bug↔fix map):
 *  - The PRIVATE key never leaves this process. The browser receives only the
 *    public key via POST /api/session.
 *  - All Yuno API calls happen here, server-side. Amounts come from the
 *    server-side catalog — the client can never set its own price.
 *  - Every create-payment carries a DETERMINISTIC X-Idempotency-Key derived
 *    from (order, attempt): a double-click, a flaky-network retry or a replay
 *    returns the ORIGINAL payment instead of creating a second one. A
 *    server-side per-order guard short-circuits duplicates before they even
 *    reach Yuno.
 *  - POST /api/webhooks/yuno is the source of truth for final payment status
 *    (HMAC-verified when YUNO_WEBHOOK_SECRET is set). A background reconciler
 *    (GET /v1/payments/{id}) covers local runs where Yuno can't reach
 *    localhost — same server-side truth, different transport.
 *  - The order store survives restarts (fixed/data/orders.json) so "shopper
 *    closed the tab" still ends in a correct final order status.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') })
const express = require('express')
const path = require('path')
const crypto = require('crypto')
const fs = require('fs')

const app = express()
app.use((req, res, next) => { res.setHeader('Permissions-Policy', 'unload=*'); next() })

// Sandbox-only, deny by default: this demo must never be able to hit production.
const ENV = process.env.YUNO_ENVIRONMENT || 'sandbox'
if (ENV !== 'sandbox') {
  console.error(`Refusing to start: YUNO_ENVIRONMENT=${ENV} — this demo is sandbox-only.`)
  process.exit(1)
}
const API_BASE = 'https://api-sandbox.y.uno'
const ACCOUNT = process.env.YUNO_ACCOUNT_CODE?.trim()
const PUB_KEY = process.env.YUNO_PUBLIC_API_KEY?.trim()
const SEC_KEY = process.env.YUNO_PRIVATE_SECRET_KEY?.trim()
const WEBHOOK_SECRET = process.env.YUNO_WEBHOOK_SECRET?.trim()
// Static shared headers from the Dashboard webhook form (x-api-key / x-secret).
// Optional second auth layer on top of the HMAC signature.
const WEBHOOK_X_API_KEY = process.env.X_API_KEY?.trim()
const WEBHOOK_X_SECRET = process.env.X_SECRET_KEY?.trim()

function safeEqual(a, b) {
  const A = Buffer.from(String(a))
  const B = Buffer.from(String(b))
  return A.length === B.length && crypto.timingSafeEqual(A, B)
}

// ── Server-side market catalog: the client picks a country, never a price ────
// `methods` is the merchant's per-market DISPLAY curation (what Halden wants to
// offer where — the challenge's "CARD and the others enabled for the market").
// It only filters/orders what the account actually has enabled: the live list
// still comes from GET /checkout/sessions/{id}/payment-methods, so a method
// disabled in the Dashboard can never appear, curated or not.
const MARKETS = {
  GB: { currency: 'GBP', label: 'United Kingdom', symbol: '£',
    methods: ['CARD', 'APPLE_PAY', 'GOOGLE_PAY', 'KLARNA', 'CLEARPAY'] },
  NL: { currency: 'EUR', label: 'Netherlands', symbol: '€',
    methods: ['CARD', 'IDEAL', 'APPLE_PAY', 'GOOGLE_PAY', 'KLARNA'] },
  AE: { currency: 'AED', label: 'UAE', symbol: 'AED ',
    methods: ['CARD', 'APPLE_PAY', 'GOOGLE_PAY'] },
}
const PRODUCT = {
  name: 'Merino Overshirt',
  variant: 'Slate · Size M',
  // Yuno amount.value is a decimal amount per the API reference
  // (docs.y.uno/reference/payments/create-payment: "multiple of 0.0001", e.g. 100.50).
  prices: { GBP: 149.0, EUR: 175.0, AED: 690.0 },
}

// ── Order store: in-memory map persisted to disk ─────────────────────────────
const DATA_DIR = path.join(__dirname, 'data')
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json')
const orders = new Map()

function loadOrders() {
  try {
    const raw = JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8'))
    // payInFlight is process-lifetime state: a crash mid-payment must not leave
    // the order permanently locked after restart (idempotency covers the retry).
    for (const o of raw) { o.payInFlight = false; orders.set(o.id, o) }
    console.log(`[store] loaded ${orders.size} order(s) from disk`)
  } catch { /* first run */ }
}
function persistOrders() {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const tmp = ORDERS_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify([...orders.values()], null, 2))
  fs.renameSync(tmp, ORDERS_FILE)
}

const FINAL_FAIL = new Set(['DECLINED', 'REJECTED', 'ERROR', 'EXPIRED', 'CANCELED', 'CANCELLED', 'FRAUD_DECLINED'])
const FINAL_ORDER = new Set(['PAID', 'REFUNDED', 'FAILED'])

function applyPaymentToOrder(order, payment, source) {
  // Monotonicity: an out-of-order or replayed webhook carrying a non-final
  // status must never downgrade a final order. Only a genuinely NEW payment
  // attempt (fresh payment id from create-payment) may reset a FAILED order.
  const isFinalPayment = payment.status === 'SUCCEEDED' || payment.status === 'REFUNDED'
    || FINAL_FAIL.has(payment.status)
  const isNewAttempt = source === 'create-payment' && payment.id && payment.id !== order.paymentId
  if (FINAL_ORDER.has(order.status) && !isFinalPayment && !isNewAttempt) {
    console.log(`[order] ${order.id}: ignoring non-final ${payment.status} via ${source} — order already ${order.status}`)
    return
  }

  const prev = order.status
  order.paymentId = payment.id || order.paymentId
  order.paymentStatus = payment.status || order.paymentStatus
  order.paymentSubStatus = payment.sub_status || order.paymentSubStatus
  const vt = payment.payment_method && payment.payment_method.vaulted_token
  if (vt) order.vaultedToken = vt

  if (payment.status === 'SUCCEEDED') order.status = 'PAID'
  else if (payment.status === 'REFUNDED') order.status = 'REFUNDED'
  else if (FINAL_FAIL.has(payment.status)) order.status = 'FAILED'
  else if (payment.status) order.status = 'PENDING'   // CREATED / PENDING / READY_TO_PAY / …

  order.updatedAt = new Date().toISOString()
  order.history.push({
    at: order.updatedAt, source,
    payment_status: payment.status, sub_status: payment.sub_status || null,
    order_status: `${prev} → ${order.status}`,
  })
  persistOrders()
  if (prev !== order.status) {
    console.log(`[order] ${order.id}: ${prev} → ${order.status} (${payment.status}/${payment.sub_status || '-'} via ${source})`)
  }
}

// ── Yuno API client (the only place the secret key is used) ──────────────────
function pickErr(d, status) {
  return (d && (d.message || d.error_description || d.error || d.title
    || d.messages?.[0] || d.errors?.[0]?.message)) || `API ${status}`
}
async function yuno(method, endpoint, body, idemKey) {
  const headers = {
    'Content-Type': 'application/json',
    'public-api-key': PUB_KEY,
    'private-secret-key': SEC_KEY,
  }
  if (idemKey) headers['X-Idempotency-Key'] = idemKey
  const res = await fetch(`${API_BASE}${endpoint}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const e = new Error(pickErr(data, res.status))
    e.body = data; e.status = res.status
    throw e
  }
  return data
}

// Deterministic UUID from (orderId, attempt, token): replays of the SAME request
// (double-click replay, transport retry) reuse the SAME key, so Yuno returns the
// original payment instead of a duplicate (keys are stored for 24h —
// docs.y.uno/reference/authentication). A NEW tokenization (fresh OTT after a
// failed attempt) gets a fresh key, so genuine retries are never blocked.
function idempotencyKeyFor(orderId, attempt, oneTimeToken) {
  const tokenHash = crypto.createHash('sha256').update(String(oneTimeToken)).digest('hex').slice(0, 16)
  const h = crypto.createHash('sha256').update(`halden:${orderId}:attempt:${attempt}:${tokenHash}`).digest()
  h[6] = (h[6] & 0x0f) | 0x40   // version 4 bits
  h[8] = (h[8] & 0x3f) | 0x80   // variant bits
  const hex = h.subarray(0, 16).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

// ── Webhook endpoint — registered BEFORE express.json() so we keep the raw
//    body for HMAC verification (signature = base64(HMAC-SHA256(raw_body, secret)),
//    sent in the x-hmac-signature header — docs.y.uno/docs/webhooks/verify-webhook-signatures-hmac).
app.post('/api/webhooks/yuno', express.raw({ type: '*/*' }), (req, res) => {
  const raw = req.body instanceof Buffer ? req.body : Buffer.from(JSON.stringify(req.body || {}))

  // Layer 1 (optional): static shared headers, as configured in the Dashboard
  // webhook form. Enforced only when set in .env.
  if (WEBHOOK_X_API_KEY && !safeEqual(req.get('x-api-key') || '', WEBHOOK_X_API_KEY)) {
    console.warn(`[webhook] REJECTED — x-api-key mismatch (header ${req.get('x-api-key') ? 'present' : 'missing'})`)
    return res.status(401).send('invalid x-api-key')
  }
  // The Dashboard field is labelled "x-secret"; accept x-secret-key too.
  const xSecret = req.get('x-secret') || req.get('x-secret-key') || ''
  if (WEBHOOK_X_SECRET && !safeEqual(xSecret, WEBHOOK_X_SECRET)) {
    console.warn(`[webhook] REJECTED — x-secret mismatch (header ${xSecret ? 'present' : 'missing'})`)
    return res.status(401).send('invalid x-secret')
  }

  // Layer 2 (primary): HMAC signature over the raw body.
  if (WEBHOOK_SECRET) {
    const signature = req.get('x-hmac-signature') || ''
    const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('base64')
    if (!safeEqual(signature, expected)) {
      console.warn('[webhook] REJECTED — bad or missing x-hmac-signature')
      return res.status(401).send('invalid signature')
    }
  } else if (process.env.ALLOW_UNSIGNED_WEBHOOKS === 'true') {
    console.warn('[webhook] accepted WITHOUT signature check (ALLOW_UNSIGNED_WEBHOOKS=true) — local testing only')
  } else {
    // Fail closed: an internet-reachable (ngrok) endpoint must never accept
    // unsigned order-state changes. The reconciler covers localhost runs.
    console.warn('[webhook] REJECTED — no YUNO_WEBHOOK_SECRET configured (set it, or ALLOW_UNSIGNED_WEBHOOKS=true for local tests)')
    return res.status(401).send('signature verification not configured')
  }

  let payload
  try { payload = JSON.parse(raw.toString('utf8')) } catch { return res.status(400).send('bad json') }

  // Webhook V2 nests the payment under data.payment; V1 uses a top-level payment.
  const p = (payload.data && payload.data.payment) || payload.payment || payload.data || {}
  const merchantOrderId = p.merchant_order_id || p.order_id
  const order = (merchantOrderId && orders.get(merchantOrderId))
    || [...orders.values()].find(o => o.paymentId && o.paymentId === p.id)

  if (order && p.status) {
    applyPaymentToOrder(order, p, `webhook:${payload.type_event || 'v1'}`)
  } else {
    console.log(`[webhook] ${payload.type_event || 'event'} for unknown order (merchant_order_id=${merchantOrderId || '-'}, payment=${p.id || '-'})`)
  }
  res.status(200).send('ok')   // Yuno expects 200 OK; it retries up to 7 times otherwise
})

app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

// ── Routes ────────────────────────────────────────────────────────────────────
app.get('/api/config', (req, res) => {
  res.json({
    environment: ENV,
    product: { name: PRODUCT.name, variant: PRODUCT.variant },
    markets: Object.entries(MARKETS).map(([code, m]) => ({
      code, label: m.label, currency: m.currency, symbol: m.symbol, price: PRODUCT.prices[m.currency],
    })),
  })
})

// 1) Create customer + checkout session + local order. Only the PUBLIC key is returned.
app.post('/api/session', async (req, res) => {
  try {
    const country = (req.body.country || 'GB').toUpperCase()
    const market = MARKETS[country]
    if (!market) return res.status(400).json({ error: `unsupported country ${country}` })
    const amountValue = PRODUCT.prices[market.currency]   // server-side price — never from the client

    const customer = await yuno('POST', '/v1/customers', {
      merchant_customer_id: `halden-${Date.now()}`,
      first_name: 'Demo',
      last_name: 'Shopper',
      email: `demo-${Date.now()}@halden.example`,
      country,
    })

    const orderId = `halden-${country}-${Date.now()}`
    // callback_url: where redirect methods (iDEAL, Klarna, some 3DS) land the
    // shopper afterwards. The orders view doubles as a "return" page. The
    // sandbox WAF rejects plain-http/localhost URLs (403), so it is sent only
    // when the checkout is reached over HTTPS (e.g. through ngrok) or when
    // YUNO_CALLBACK_BASE is set explicitly in .env.
    const origin = process.env.YUNO_CALLBACK_BASE?.trim()
      || `${req.protocol}://${req.get('host')}`
    const sessionBody = {
      account_id: ACCOUNT,
      merchant_order_id: orderId,
      payment_description: `Halden — ${PRODUCT.name}`,
      country,
      amount: { currency: market.currency, value: amountValue },
      customer_id: customer.id,
    }
    if (origin.startsWith('https://')) sessionBody.callback_url = `${origin}/orders.html`
    const session = await yuno('POST', '/v1/checkout/sessions', sessionBody)

    const now = new Date().toISOString()
    const order = {
      id: orderId, createdAt: now, updatedAt: now,
      country, currency: market.currency, amount: amountValue,
      product: PRODUCT.name,
      customerId: customer.id,
      checkoutSession: session.checkout_session,
      status: 'AWAITING_PAYMENT',
      paymentId: null, paymentStatus: null, paymentSubStatus: null,
      vaultedToken: null,
      attempt: 1, payInFlight: false,
      history: [{ at: now, source: 'checkout-session', order_status: '∅ → AWAITING_PAYMENT' }],
    }
    orders.set(orderId, order)
    persistOrders()

    res.json({
      publicApiKey: PUB_KEY,                    // ← the ONLY key the browser ever sees
      checkoutSession: session.checkout_session,
      orderId,
      customerId: customer.id,
      country, currency: market.currency, symbol: market.symbol,
      amount: amountValue,
      displayMethods: market.methods,           // merchant's per-market curation
      product: { name: PRODUCT.name, variant: PRODUCT.variant },
    })
  } catch (err) {
    console.error('[/api/session]', err.message, err.body || '')
    res.status(502).json({ error: err.message, detail: err.body })
  }
})

// 2) Payment methods enabled for this session (drives the method list in the UI)
app.get('/api/payment-methods', async (req, res) => {
  try {
    const { session } = req.query
    if (!session) return res.status(400).json({ error: 'session query param required' })
    res.json(await yuno('GET', `/v1/checkout/sessions/${session}/payment-methods`))
  } catch (err) {
    console.error('[/api/payment-methods]', err.message)
    res.status(502).json({ error: err.message })
  }
})

// 3) Create the payment from the One-Time Token. Guaranteed single-charge:
//    layer 1 — per-order guard here (duplicates never reach Yuno),
//    layer 2 — deterministic X-Idempotency-Key (transport retries return the original),
//    layer 3 — the UI disables the Pay button while a payment is in flight.
app.post('/api/pay', async (req, res) => {
  const { orderId, oneTimeToken, paymentMethodType, saveCard } = req.body
  const order = orders.get(orderId)
  if (!order) return res.status(404).json({ error: `unknown order ${orderId}` })

  if (order.status === 'PAID') {
    return res.json({
      deduped: true, reason: 'order already paid — no second charge',
      payment: { id: order.paymentId, status: order.paymentStatus, sub_status: order.paymentSubStatus },
      orderId,
    })
  }
  if (order.payInFlight || (order.paymentId && order.status === 'PENDING')) {
    return res.json({
      deduped: true, reason: 'a payment for this order is already in flight — returning it',
      payment: { id: order.paymentId, status: order.paymentStatus, sub_status: order.paymentSubStatus },
      orderId,
    })
  }
  if (order.status === 'FAILED') order.attempt += 1   // a genuine retry gets a fresh idempotency key

  order.payInFlight = true
  persistOrders()
  try {
    const paymentMethod = { type: paymentMethodType || 'CARD', token: oneTimeToken }
    // vault the card for returning customers / MIT — cards only
    if (saveCard && paymentMethod.type === 'CARD') paymentMethod.vault_on_success = true

    const payment = await yuno('POST', '/v1/payments', {
      account_id: ACCOUNT,
      merchant_order_id: order.id,
      description: `Halden — ${order.product}`,
      country: order.country,
      amount: { currency: order.currency, value: order.amount },   // server-side amount
      customer_payer: { id: order.customerId },
      checkout: { session: order.checkoutSession },
      payment_method: paymentMethod,
      workflow: 'SDK_CHECKOUT',
    }, idempotencyKeyFor(order.id, order.attempt, oneTimeToken))

    applyPaymentToOrder(order, payment, 'create-payment')
    res.json({ ...payment, orderId })
  } catch (err) {
    console.error('[/api/pay]', err.message, err.body || '')
    res.status(502).json({ error: err.message, detail: err.body, orderId })
  } finally {
    order.payInFlight = false
    persistOrders()
  }
})

// 4) Orders — the server-side truth the UI and the demo evidence read from.
//    Internal references (customer id, session, vaulted token) stay server-side.
const publicOrder = ({ customerId, checkoutSession, vaultedToken, payInFlight, ...o }) =>
  ({ ...o, cardSaved: Boolean(vaultedToken) })

app.get('/api/orders', (req, res) => {
  res.json([...orders.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(publicOrder))
})
app.get('/api/orders/:id', (req, res) => {
  const order = orders.get(req.params.id)
  if (!order) return res.status(404).json({ error: 'not found' })
  res.json(publicOrder(order))
})

// 5) Manual reconcile — same truth as the webhook, pulled instead of pushed.
app.post('/api/orders/:id/reconcile', async (req, res) => {
  const order = orders.get(req.params.id)
  if (!order) return res.status(404).json({ error: 'not found' })
  if (!order.paymentId) return res.status(400).json({ error: 'order has no payment yet' })
  try {
    const payment = await yuno('GET', `/v1/payments/${order.paymentId}`)
    applyPaymentToOrder(order, payment, 'reconcile:manual')
    res.json(order)
  } catch (err) {
    console.error('[/api/reconcile]', err.message)
    res.status(502).json({ error: err.message })
  }
})

// Background reconciler: webhooks are the primary channel, but Yuno can't reach
// http://localhost — so any order stuck in PENDING gets re-checked against
// GET /v1/payments/{id} every 30s. In production you keep this as a safety net
// behind the webhook, not instead of it.
let reconciling = false
setInterval(async () => {
  if (reconciling || !SEC_KEY) return
  reconciling = true
  try {
    const stuck = [...orders.values()].filter(o =>
      o.status === 'PENDING' && o.paymentId && Date.now() - Date.parse(o.updatedAt) > 30_000)
    for (const order of stuck) {
      try {
        const payment = await yuno('GET', `/v1/payments/${order.paymentId}`)
        applyPaymentToOrder(order, payment, 'reconcile:auto')
      } catch (err) {
        console.warn(`[reconcile] ${order.id}: ${err.message}`)
      }
    }
  } finally {
    reconciling = false
  }
}, 30_000)

function listenOnFreePort(port, attemptsLeft = 20) {
  const server = app.listen(port)
  server.on('listening', () => {
    if (!PUB_KEY || !SEC_KEY || !ACCOUNT) {
      console.warn('⚠  Missing credentials — fill in ../.env first (YUNO_PUBLIC_API_KEY, YUNO_PRIVATE_SECRET_KEY, YUNO_ACCOUNT_CODE).')
    }
    console.log(`Halden checkout (FIXED reference build) · ${ENV} · http://localhost:${port}`)
    console.log(`  orders view:      http://localhost:${port}/orders.html`)
    console.log(`  webhook endpoint: POST /api/webhooks/yuno  (expose with: ngrok http ${port})`)
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
loadOrders()
listenOnFreePort(parseInt(process.env.FIXED_PORT, 10) || 3072)
