/**
 * Halden embedded checkout — CORRECTED SDK Lite wiring.
 *
 * The flow (each step fixes a staging bug — see README for the map):
 *   1. POST /api/session            → backend creates customer + checkout session;
 *                                     the browser receives ONLY the public key.
 *   2. Yuno.initialize(publicKey)   → once per page.
 *   3. yuno.startCheckout({...})    → ONCE per session, with a top-level
 *                                     elementSelector + renderMode incl. actionForm
 *                                     (where 3DS challenges render).
 *   4. GET /api/payment-methods     → method list comes from the session, so the UI
 *                                     shows exactly what the account has enabled
 *                                     (cards, wallets, iDEAL, Klarna, …).
 *   5. mountCheckoutLite({type})    → per selected method; wallets go through
 *                                     mountExternalButtons.
 *   6. Pay → submitOneTimeTokenForm() → yunoCreatePayment(ott) → POST /api/pay.
 *   7. ALWAYS yuno.continuePayment() after a 2xx — the SDK decides whether a
 *      3DS/redirect step is needed and renders it in #yuno-action-form.
 *   8. The ORDER status shown to the shopper comes from polling OUR server
 *      (webhook/reconciler truth), not from the browser callback alone.
 */

/* eslint-disable no-console */

const $ = (id) => document.getElementById(id)

// Benign SDK console noise (validated non-bugs) — keep the demo console clean.
const NOISE = /(postrobot_method before ack|multiple calls to tags\.js|removeChild|__chromium_devtools_metrics_reporter)/
const origError = console.error.bind(console)
console.error = (...args) => { if (!NOISE.test(args.join(' '))) origError(...args) }
window.addEventListener('error', (e) => { if (NOISE.test(e.message || '')) e.preventDefault() }, true)

const WALLETS = new Set(['APPLE_PAY', 'GOOGLE_PAY'])

let yuno
let session            // response of POST /api/session
let selectedMethod = null
let lastPayBody = null // for the QA double-charge replay
let orderPoll = null
let payInFlight = false   // a /api/pay request is running
let tokenizing = false    // the SDK is generating an OTT
let orderFinal = false    // order reached PAID — no further pay attempts from this page

const country = new URLSearchParams(location.search).get('country')?.toUpperCase() || 'GB'

async function boot() {
  const config = await fetch('/api/config').then((r) => r.json())
  renderMarkets(config.markets)

  const res = await fetch('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ country }),
  })
  session = await res.json()
  if (!res.ok) {
    setStatus('err', `Could not start checkout: ${session.error || res.status}`)
    return
  }

  renderOrder()

  // 2. Public key only — the secret key never reaches this file.
  yuno = await Yuno.initialize(session.publicApiKey)

  // 3. ONE startCheckout per session. Top-level elementSelector is required;
  //    actionForm is where the SDK renders 3DS / OTP / redirect steps.
  await yuno.startCheckout({
    checkoutSession: session.checkoutSession,
    elementSelector: '#yuno-payment-form',
    countryCode: session.country,
    language: 'en',
    showLoading: false,
    showPaymentStatus: false,   // Halden renders its own status from server truth
    showPayButton: false,       // Halden uses its own CTA
    renderMode: {
      type: 'element',
      elementSelector: { apmForm: '#yuno-payment-form', actionForm: '#yuno-action-form' },
    },
    // Validated-stable card config (no custom styles). Card saving is driven
    // server-side via vault_on_success — see the "save card" checkbox below.
    card: { type: 'extends', cardSaveEnable: false },

    async yunoCreatePayment(oneTimeToken, tokenWithInformation) {
      await createPaymentOnServer(oneTimeToken, tokenWithInformation)
    },

    yunoPaymentResult(status) {
      // status is a STRING. It reflects the browser-side outcome; the order
      // only flips to PAID when OUR server confirms (webhook / reconcile).
      console.log('[halden] yunoPaymentResult:', status)
      if (status === 'SUCCEEDED' || status === 'APPROVED') {
        setStatus('pending', '<span class="spin"></span>Approved in browser — waiting for server confirmation…')
      } else if (['REJECTED', 'DECLINED', 'ERROR', 'CANCELLED', 'CANCELED', 'FAIL', 'REJECT'].includes(status)) {
        setStatus('err', `Payment ${status.toLowerCase()} — you can try again.`)
        setPayEnabled(true)
      } else {
        setStatus('pending', `<span class="spin"></span>Payment ${status.toLowerCase()}…`)
      }
      pollOrderUntilFinal()
    },

    onLoading({ isLoading, type }) {
      if (type !== 'ONE_TIME_TOKEN') return
      tokenizing = isLoading
      if (isLoading) setPayEnabled(false)
      // Tokenization ended without a payment starting (e.g. card validation
      // failed) → give the shopper the button back. While /api/pay is running,
      // payInFlight keeps it disabled.
      else if (!payInFlight && !orderFinal) setPayEnabled(true)
    },
  })

  // 4. Method list: the session says what the ACCOUNT has enabled (never
  //    hardcoded); the market's displayMethods say what HALDEN offers in this
  //    country, in this order. The intersection is what the shopper sees —
  //    falling back to the full account list if the curation matches nothing.
  const pmRes = await fetch(`/api/payment-methods?session=${encodeURIComponent(session.checkoutSession)}`)
  const methods = await pmRes.json().catch(() => ({}))
  if (!pmRes.ok) {
    setStatus('err', `Could not load payment methods: ${methods.error || pmRes.status}`)
    $('method-list').innerHTML = '<em style="color:var(--muted);font-size:13px">Payment methods could not be loaded — reload the page to retry.</em>'
    return
  }
  const accountEnabled = Array.isArray(methods) ? methods : []
  const curated = (session.displayMethods || [])
    .map((type) => accountEnabled.find((m) => m.type === type))
    .filter(Boolean)
  const enabled = curated.length ? curated : accountEnabled
  renderMethods(enabled)

  // 5. Wallets render their own buttons via mountExternalButtons. They require
  //    HTTPS — on plain http they are shown as disabled rows instead, and a
  //    hidden warm-up mount primes the SDK bridge (first mounts after
  //    startCheckout can fail cold; a real wallet mount primes it for free).
  const https = location.protocol === 'https:'
  const wallets = enabled.filter((m) => WALLETS.has(m.type)).map((m) => m.type)
  if (https && wallets.length) {
    try {
      await yuno.mountExternalButtons(wallets.map((type) => ({
        paymentMethodType: type,
        elementSelector: `#wallet-${type}`,
      })))
    } catch (e) {
      // A wallet failing to mount (unsupported browser, unverified Apple Pay
      // domain) must never take the rest of the checkout down with it.
      console.warn('[halden] wallet buttons failed to mount — continuing without them:', e?.message || e)
      for (const type of wallets) {
        const slot = document.getElementById(`wallet-${type}`)
        if (slot) slot.innerHTML = `<div class="method disabled"><span>${type.replace('_', ' ')}</span><span class="tag">unavailable in this browser</span></div>`
      }
    }
  } else {
    try {
      await yuno.mountExternalButtons([{ paymentMethodType: 'APPLE_PAY', elementSelector: '#yuno-warmup' }])
    } catch { /* warm-up is best-effort */ }
  }

  const first = enabled.find((m) => !WALLETS.has(m.type))
  if (first) await selectMethod(first.type)
  else if (!enabled.length) $('method-list').innerHTML = '<em style="color:var(--muted);font-size:13px">No payment methods enabled for this session — check the Dashboard (Connections → Routing → Checkout).</em>'
}

function renderMarkets(markets) {
  $('markets').innerHTML = markets.map((m) =>
    `<a href="?country=${m.code}" class="${m.code === country ? 'active' : ''}">${m.label} · ${m.currency}</a>`).join('')
}

function money() {
  return `${session.symbol}${session.amount.toFixed(2)}`
}

function renderOrder() {
  $('product-name').textContent = session.product.name
  $('product-variant').textContent = session.product.variant
  $('subtotal').textContent = money()
  $('total').textContent = money()
  $('order-id').textContent = session.orderId
  $('pay-btn').textContent = `Pay ${money()}`
}

function renderMethods(enabled) {
  const list = $('method-list')
  list.innerHTML = ''
  const https = location.protocol === 'https:'
  for (const m of enabled) {
    const row = document.createElement('div')
    const isWallet = WALLETS.has(m.type)
    row.className = 'method'
    row.dataset.type = m.type
    row.innerHTML = `<span>${m.name || m.type}</span>`
    if (isWallet) {
      if (https) {
        const slot = document.createElement('div')
        slot.className = 'wallet-slot'
        slot.id = `wallet-${m.type}`
        list.appendChild(slot)
        continue                       // the wallet button replaces the row
      }
      row.classList.add('disabled')
      row.innerHTML += '<span class="tag">HTTPS only — enable via ngrok</span>'
      list.appendChild(row)
      continue
    }
    row.addEventListener('click', () => selectMethod(m.type))
    list.appendChild(row)
  }
}

// Method switch = mountCheckoutLite ONLY (never re-initialize / re-startCheckout),
// with the validated self-heal retry for cold-bridge failures.
async function selectMethod(type) {
  if (orderFinal) return   // order is paid — no re-arming the form
  selectedMethod = type
  document.querySelectorAll('.method').forEach((el) =>
    el.classList.toggle('active', el.dataset.type === type))
  $('save-row').style.display = type === 'CARD' ? 'flex' : 'none'
  setPayEnabled(false)
  const ok = await mountWithRetry(type)
  setPayEnabled(ok)
  if (!ok) setStatus('err', `Could not load the ${type} form — please pick another method.`)
}

async function mountWithRetry(type) {
  for (let i = 0; i < 6; i++) {
    try { await yuno.mountCheckoutLite({ paymentMethodType: type }) } catch (e) { console.warn('[halden] mount error:', e?.message) }
    if (await mountRendered(2000)) return true
    $('yuno-payment-form').innerHTML = ''
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

async function mountRendered(ms) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    const el = $('yuno-payment-form')
    const html = el?.innerHTML || ''
    if (/(algo deu errado|something went wrong)/i.test(html)) return false
    if (el?.querySelector('iframe') || html.length > 500) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

// 6-7. OTT → OUR backend → ALWAYS continuePayment (the SDK decides whether a
// 3DS/redirect step is needed and renders it in #yuno-action-form).
async function createPaymentOnServer(oneTimeToken, tokenWithInformation) {
  const paymentMethodType = tokenWithInformation?.payment_method_type
    || tokenWithInformation?.paymentMethodType || selectedMethod || 'CARD'
  lastPayBody = {
    orderId: session.orderId,
    oneTimeToken,
    paymentMethodType,
    saveCard: paymentMethodType === 'CARD' && $('save-card').checked,
  }
  $('qa-replay').disabled = true   // only armed once a real payment exists (below)

  payInFlight = true
  setPayEnabled(false)
  setStatus('pending', '<span class="spin"></span>Creating payment…')
  try {
    const res = await fetch('/api/pay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(lastPayBody),
    })
    const payment = await res.json()
    if (!res.ok) {
      setStatus('err', `Payment failed: ${payment.error || res.status}`)
      setPayEnabled(true)
      return
    }
    console.log('[halden] payment:', payment.id, payment.status, payment.sub_status)
    if (payment.id) $('qa-replay').disabled = false   // dedup proof is now meaningful

    // NOT awaited, ALWAYS called after a 2xx (never gated on sdk_action_required).
    yuno.continuePayment({ showPaymentStatus: false })
    pollOrderUntilFinal()
  } finally {
    payInFlight = false
  }
}

// 8. Server truth: poll our order until it reaches a final state. Even if the
// shopper closes this tab, the webhook/reconciler still lands the final status —
// reopen /orders.html and the order is correct.
function pollOrderUntilFinal() {
  if (orderPoll) return
  orderPoll = setInterval(async () => {
    const order = await fetch(`/api/orders/${session.orderId}`).then((r) => r.json()).catch(() => null)
    if (!order) return
    if (order.status === 'PAID') {
      stopPoll()
      orderFinal = true
      const via = order.history[order.history.length - 1]?.source || 'server'
      setStatus('ok', `✓ Payment confirmed — order PAID (payment ${order.paymentId}, via ${via})${order.cardSaved ? '<br>💳 Card saved for next time (vaulted token issued).' : ''}`)
      setPayEnabled(false)
    } else if (order.status === 'FAILED') {
      stopPoll()
      setStatus('err', `Payment ${order.paymentStatus} — you can try again.`)
      setPayEnabled(true)
    } else if (order.status === 'PENDING') {
      setStatus('pending', '<span class="spin"></span>Payment pending — waiting for the bank / webhook…')
    }
  }, 2500)
}
function stopPoll() { clearInterval(orderPoll); orderPoll = null }

// QA: prove single-charge. Fires the SAME create-payment request twice in
// parallel — server guard + idempotency key return the same payment both times.
$('qa-replay').addEventListener('click', async () => {
  if (!lastPayBody) return
  const out = $('qa-out')
  out.hidden = false
  out.textContent = 'Sending the same request twice, in parallel…'
  const send = () => fetch('/api/pay', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(lastPayBody),
  }).then((r) => r.json())
  const [a, b] = await Promise.all([send(), send()])
  const pid = (x) => x.deduped ? `deduped → ${x.payment?.id} (${x.reason})` : `${x.id} (${x.status})`
  out.textContent = `response #1: ${pid(a)}\nresponse #2: ${pid(b)}\n\n`
    + `full bodies:\n${JSON.stringify({ first: a, second: b }, null, 2)}`
})

$('pay-btn').addEventListener('click', () => {
  if (orderFinal) return
  setPayEnabled(false)
  yuno.submitOneTimeTokenForm()   // → SDK tokenizes → yunoCreatePayment(ott)
  // Watchdog: if inline validation fails, no tokenization or payment ever
  // starts and no callback fires — give the button back so the shopper can fix
  // the form and retry (a page reload must never be the recovery path).
  setTimeout(() => {
    if (!payInFlight && !tokenizing && !orderFinal) setPayEnabled(true)
  }, 4000)
})

function setPayEnabled(on) { $('pay-btn').disabled = !on }
function setStatus(kind, html) {
  const el = $('status')
  el.className = `status ${kind}`
  el.innerHTML = html
}

boot().catch((e) => {
  console.error('[halden] boot failed:', e)
  setStatus('err', `Checkout failed to load: ${e.message || e}`)
})
