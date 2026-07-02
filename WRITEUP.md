# Write-up — Halden checkout fix (1 page)

## What was broken

- **The credential leak (the real "went pale"):** the private secret key was hardcoded in
  the frontend and sent from the browser on every request. Anyone could copy it from
  DevTools and create payments. It must be rotated. The *harmless* look-alike: the public
  key in the browser — that one is by design; it initializes the SDK.
- **All Yuno API calls ran client-side**, with the amount taken from the cart object — a
  shopper could pay any price for any order.
- **`startPayment()` was called during page init, before `startCheckout()`** — a race, and
  the cause of "cards work maybe half the time" + the "SDK not ready" console error. The
  pay trigger belongs on the Pay click (`submitOneTimeTokenForm()` for a Lite form with a
  custom button).
- **Only `CARD` was ever mounted and `countryCode` was hardcoded `'GB'`** — Apple Pay,
  Google Pay, iDEAL (NL-only) and Klarna could never appear.
- **`continuePayment()` was never called and no `actionForm` was configured** — after the
  bank's 3DS/SCA step the SDK had no way to resume, so orders hung on "processing".
- **Only the synchronous happy path was handled** (`status === 'SUCCEEDED'`); there was no
  webhook endpoint and no order state at all, so async methods (3DS, iDEAL, Klarna) could
  never settle correctly.
- **No `X-Idempotency-Key` and the Pay button was never disabled** — QA's double-click
  created two real charges.

## Key decisions

1. **Keep SDK Lite — it was the right choice.** An embedded, one-page, multi-market
   checkout with per-method control is exactly SDK Lite's niche. Every observed failure
   was integration wiring, not SDK selection; switching SDKs five days before launch
   would add risk, not remove it.
2. **The order status is always correct because the browser is never the source of
   truth.** The backend owns an order state machine (`AWAITING_PAYMENT → PENDING →
   PAID/FAILED`) updated by **HMAC-verified webhooks**, with a reconciler polling
   `GET /v1/payments/{id}` as a safety net (and as the local-dev path). The UI only
   renders server state — so a shopper closing the tab mid-3DS changes nothing.
3. **Single charge by construction, at three layers:** a per-order in-flight guard on the
   backend (duplicates never even reach Yuno) → a **deterministic** `X-Idempotency-Key`
   derived from (order, attempt, token), so any transport retry returns the original
   payment → a disabled Pay button as the UX layer. The double-click test in the demo
   sends the same request twice in parallel and gets the same payment id back twice.

## Go-live call

**Conditional GO for Monday.** The blockers — secret key server-side (and rotating the
leaked staging key), `continuePayment` + webhook-driven order status, idempotency on
create-payment — are all fixed and demonstrated in this repo against the live sandbox.
**Apple Pay** requires Apple domain verification (external dependency): launch Monday
without it and fast-follow. For finance: double charges *were* possible (QA proved it);
after the fix a duplicate request provably returns the same single payment. Card saving
ships now via `vault_on_success`, which is also the on-ramp to Q2 subscriptions
(vaulted token + `stored_credentials` MIT).
