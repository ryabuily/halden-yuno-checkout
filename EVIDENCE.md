# Evidence — the three required behaviours

> Screenshots live in [`evidence/`](evidence/). Log lines below are from `fixed/server.js`
> stdout; payment ids are sandbox objects verifiable in the Yuno dashboard.

## 1. Card payment approved end-to-end

- Screenshot: `evidence/1-card-approved-orders-view.png` — `/orders.html` with the order
  in **PAID**, the payment id, and the update source.
- Server log:

```
<!-- paste the real lines, e.g.:
[order] halden-GB-<ts>: AWAITING_PAYMENT → PAID (SUCCEEDED/APPROVED via create-payment)
-->
```

## 2. Async payment — pending first, paid only when it truly settles (tab closed)

Flow recorded: pay with the 3DS challenge test card (or iDEAL on the NL tab) → complete
the bank step → **close the checkout tab immediately** → the order settles server-side.

- Screenshot: `evidence/2a-order-pending.png` — order in **PENDING** after the tab closed.
- Screenshot: `evidence/2b-order-paid-via-webhook.png` — same order in **PAID**, source
  `webhook:payment.purchase` (or `reconcile:auto`).
- Server log:

```
<!-- paste the real lines, e.g.:
[order] halden-NL-<ts>: AWAITING_PAYMENT → PENDING (PENDING/WAITING_ADDITIONAL_STEP via create-payment)
[order] halden-NL-<ts>: PENDING → PAID (SUCCEEDED/APPROVED via webhook:payment.purchase)
-->
```

## 3. Repeated / double-clicked payment → one charge, not two

**Broken build (control):** double-clicking Pay creates two payments for one order.

- Screenshot: `evidence/3a-buggy-two-payments.png` — Yuno Dashboard → Transactions, two
  payment ids for the same staging order.

**Fixed build:** the *QA · double-charge test* panel re-sends the exact same
create-payment request twice **in parallel**; both responses carry the same payment id.

- Screenshot: `evidence/3b-fixed-replay-deduped.png` — both responses, same payment id,
  `deduped: true` with the guard's reason.
- Response bodies:

```
<!-- paste the two JSON responses from the QA panel -->
```

## Webhook authenticity (supporting)

The webhook endpoint fails closed. Live checks (curl against the running server):

```
1) no auth headers                          → 401
2) correct x-api-key/x-secret, no HMAC      → 401
3) headers + valid x-hmac-signature         → 200 ok
4) tampered body with stale signature       → 401
```
