/**
 * Halden staging checkout — the BROKEN wiring, faithful to the code Sofia shared.
 * Every planted defect is marked with a "BUG #n" comment; the README maps each
 * one to the symptom Sofia observed and to the fix in ../fixed.
 *
 * Adaptations made ONLY so this runs at all (each noted inline):
 *  - keys come from /config.js instead of being hardcoded in the bundle
 *    (same leak — the secret still reaches the browser);
 *  - the customer is created client-side too (the staging snippet assumed
 *    cart.customerId existed; the API needs a real customer UUID);
 *  - Yuno.initialize() gets the PUBLIC key (the original passed the SECRET key
 *    to loadScript(), which fails hard; the leak itself is preserved below);
 *  - the early startPayment() is wrapped in try/catch so the page survives to
 *    demonstrate the other symptoms — the original had no try/catch, which is
 *    why on bad timing the whole init died (the "~50% of card attempts").
 */

const YUNO_PUBLIC_KEY = window.YUNO_PUBLIC_KEY
const YUNO_SECRET_KEY = window.YUNO_SECRET_KEY   // ⚠ BUG #1: the PRIVATE key lives in the browser

// BUG #2 (family of #1): the browser talks to the Yuno API directly, sending the
// secret key in request headers. Anyone can read it in DevTools → Network.
// (Runnability adaptation: routed via the same-origin /yuno-api pass-through,
// because browsers refuse the private-secret-key header cross-origin at the
// CORS preflight — the leak in DevTools is identical either way.)
const API = '/yuno-api/v1'
const apiHeaders = {
  'Content-Type': 'application/json',
  'public-api-key': YUNO_PUBLIC_KEY,
  'private-secret-key': YUNO_SECRET_KEY,   // ⚠ visible to every shopper
}

let checkoutSession
let yuno
// Kept as a page-level global so onPayClick can see it. In the original .jsx the
// `cart` in onPayClick was OUT OF SCOPE — a ReferenceError waiting to happen.
const cart = { currency: 'GBP', total: 149.0, country: 'GB' }

async function initCheckout() {
  // Adaptation: create the customer client-side (needs a real UUID for the session).
  // In a correct integration this is a backend call — doing it here just adds
  // one more secret-key request to the Network tab.
  const customerRes = await fetch(`${API}/customers`, {
    method: 'POST',
    headers: apiHeaders,
    body: JSON.stringify({
      merchant_customer_id: `halden-web-${Date.now()}`,
      first_name: 'Staging',
      last_name: 'Shopper',
      email: `staging-${Date.now()}@halden.example`,
      country: cart.country,
    }),
  })
  const customer = await customerRes.json()

  const res = await fetch(`${API}/checkout/sessions`, {
    method: 'POST',
    headers: apiHeaders,   // ⚠ BUG #2: session created from the browser, secret key attached
    body: JSON.stringify({
      account_id: window.YUNO_ACCOUNT_CODE,
      merchant_order_id: `halden-staging-${Date.now()}`,
      payment_description: 'Halden order',
      country: cart.country,
      amount: { currency: cart.currency, value: cart.total },
      customer_id: customer.id,
    }),
  })
  const data = await res.json()
  checkoutSession = data.checkout_session

  yuno = await Yuno.initialize(YUNO_PUBLIC_KEY)

  // ⚠ BUG #3: payment triggering belongs on the Pay click, AFTER the form is
  // mounted (for a Lite form with a custom button that's submitOneTimeTokenForm()).
  // Calling startPayment() here — before startCheckout() — is the race behind
  // "cards work maybe half the time" and the "SDK not ready" console error.
  // (The 3s race keeps the page alive even if the SDK hangs instead of rejecting.)
  try {
    await Promise.race([
      yuno.startPayment(),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error('startPayment() called before startCheckout() — nothing to start')), 3000)),
    ])
    console.error('[Halden staging] SDK not ready: startPayment() ran before startCheckout() — in staging this race killed init on bad timing')
  } catch (e) {
    console.error('[Halden staging] SDK not ready:', e && e.message ? e.message : e)
  }

  await yuno.startCheckout({
    checkoutSession,
    elementSelector: '#checkout-root',
    countryCode: 'GB',        // ⚠ BUG #4: hardcoded GB for every shopper — iDEAL (NL-only)
    language: 'en',           //   can never appear, EU/Gulf carts get the wrong market
    showLoading: false,
    showPayButton: false,
    // ⚠ BUG #5: no renderMode/actionForm is configured — even if a 3DS challenge
    // were triggered, there is nowhere for the SDK to render it.
    yunoCreatePayment: onPayClick,   // the OTT lands in the broken handler below
    yunoPaymentResult(status) {
      console.log('[Halden staging] yunoPaymentResult:', status)
    },
  })

  // ⚠ BUG #6: only cards are ever mounted. Apple Pay / Google Pay need
  // mountExternalButtons, iDEAL/Klarna need their own mountCheckoutLite calls —
  // none of that happens, so those options simply never show up.
  await yuno.mountCheckoutLite({ paymentMethodType: 'CARD' })
}

// Called when the customer clicks "Pay" (the SDK returns the one-time token here)
async function onPayClick(oneTimeToken) {
  setStatus('processing', 'Processing…')
  // ⚠ BUG #7: payment created FROM THE BROWSER with the secret key, and
  // ⚠ BUG #8: no X-Idempotency-Key header — a double-click or a retry on a flaky
  // connection creates a SECOND payment (this is the duplicate charge QA found).
  const res = await fetch(`${API}/payments`, {
    method: 'POST',
    headers: apiHeaders,
    body: JSON.stringify({
      account_id: window.YUNO_ACCOUNT_CODE,
      merchant_order_id: `halden-staging-pay-${Date.now()}`,
      description: 'Halden order',
      country: cart.country,
      amount: { currency: cart.currency, value: cart.total },   // ⚠ client-controlled amount
      checkout: { session: checkoutSession },
      payment_method: { type: 'CARD', token: oneTimeToken },
      workflow: 'SDK_CHECKOUT',
    }),
  })
  const payment = await res.json()
  console.log('[Halden staging] payment response:', payment.id, payment.status, payment.sub_status)

  // ⚠ BUG #9: yuno.continuePayment() is never called. When the payment needs an
  // extra step (3DS/SCA, iDEAL or Klarna redirect) the SDK never gets to run it,
  // so the order hangs on "processing" forever.
  // ⚠ BUG #10: only the synchronous happy path is handled. PENDING — the normal
  // first state of any 3DS/redirect payment — falls into the spinner below and
  // nothing ever resolves it (no webhook endpoint exists server-side either).
  if (payment.status === 'SUCCEEDED') showSuccess()
  else if (payment.status === 'PENDING') showProcessingForever()
  else showError(payment)
}

// ⚠ BUG #11: the Pay button is never disabled while a payment is in flight.
// Click it twice and the SDK happily tokenizes twice → two payments → two charges.
document.getElementById('pay-btn').addEventListener('click', () => {
  // submitOneTimeTokenForm() is the documented trigger for a Lite-mounted form
  // with a custom pay button — the one thing this click handler gets right.
  yuno.submitOneTimeTokenForm()
})

function setStatus(kind, html) {
  const el = document.getElementById('status')
  el.className = `status ${kind}`
  el.innerHTML = html
}
function showSuccess() {
  setStatus('ok', '✓ Payment approved — thank you!')
}
function showProcessingForever() {
  setStatus('processing', '<span class="spin"></span>Processing your payment…')
}
function showError(payment) {
  setStatus('err', `Something went wrong (${(payment && payment.status) || 'unknown'}). Please try again.`)
}

initCheckout().catch((e) => {
  console.error('[Halden staging] init failed:', e)
  setStatus('err', 'Checkout failed to load — see console.')
})
