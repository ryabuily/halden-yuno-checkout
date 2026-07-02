// ─────────────────────────────────────────────────────────────────────────────
// UNMODIFIED staging code as received from Halden (Sofia Marchetti).
// ─────────────────────────────────────────────────────────────────────────────

// Sofia added this "just in case" but the frontend above doesn't call it yet
app.post('/api/create-payment', async (req, res) => {
  const { token, session, amount } = req.body
  const response = await fetch('https://api-sandbox.y.uno/v1/payments', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'private-secret-key': process.env.YUNO_SECRET_KEY,
    },
    body: JSON.stringify({ amount, checkout: { session }, payment_method: { token } }),
  })
  const payment = await response.json()
  res.json(payment)
})

// (no other Yuno-related endpoints exist)
