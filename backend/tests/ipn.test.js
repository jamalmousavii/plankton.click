const crypto = require('crypto');
const nowpayments = require('../src/services/nowpayments');

const SECRET = process.env.NOWPAYMENTS_IPN_SECRET;

// Mirrors the server-side canonicalisation: keys sorted, then JSON.stringify.
function sign(payload) {
  const sorted = Object.keys(payload)
    .sort()
    .reduce((acc, key) => {
      acc[key] = payload[key];
      return acc;
    }, {});
  return crypto.createHmac('sha512', SECRET).update(JSON.stringify(sorted)).digest('hex');
}

const payload = {
  payment_id: 12345,
  payment_status: 'finished',
  price_amount: 25,
  price_currency: 'usd',
  pay_amount: 0.001,
  order_id: 'plankton-7-1700000000',
};

describe('NowPayments IPN verification (fail closed)', () => {
  it('accepts a correctly signed payload', () => {
    expect(nowpayments.verifyIPN(payload, sign(payload))).toBe(true);
  });

  it('rejects a payload signed with the wrong secret', () => {
    const forged = crypto.createHmac('sha512', 'attacker-secret').update(JSON.stringify(payload)).digest('hex');
    expect(nowpayments.verifyIPN(payload, forged)).toBe(false);
  });

  it('rejects a tampered amount even with a real signature', () => {
    const signature = sign(payload);
    expect(nowpayments.verifyIPN({ ...payload, price_amount: 1000000 }, signature)).toBe(false);
  });

  it('rejects a missing signature', () => {
    expect(nowpayments.verifyIPN(payload, undefined)).toBe(false);
    expect(nowpayments.verifyIPN(payload, '')).toBe(false);
  });

  it('rejects a signature of a different length without throwing', () => {
    expect(nowpayments.verifyIPN(payload, 'deadbeef')).toBe(false);
  });
});

describe('rawBody verification (B2, v3.31.0)', () => {
  const raw = Buffer.from(JSON.stringify(payload));

  it('accepts a signature computed over the exact raw bytes', () => {
    const sig = crypto.createHmac('sha512', SECRET).update(raw).digest('hex');
    expect(nowpayments.verifyIPN(payload, sig, raw)).toBe(true);
  });

  it('still accepts the sorted-JSON canonical form when raw bytes differ', () => {
    // Sender signed the canonical body; ours arrived pretty-printed.
    const spaced = Buffer.from(JSON.stringify(payload, null, 2));
    expect(nowpayments.verifyIPN(payload, sign(payload), spaced)).toBe(true);
  });

  it('rejects tampered raw bytes against a valid signature', () => {
    const sig = crypto.createHmac('sha512', SECRET).update(raw).digest('hex');
    const tampered = Buffer.from(JSON.stringify({ ...payload, price_amount: 999999 }));
    expect(nowpayments.verifyIPN({ ...payload, price_amount: 999999 }, sig, tampered)).toBe(false);
  });

  it('accepts a string rawBody as well as a Buffer', () => {
    const sig = crypto.createHmac('sha512', SECRET).update(raw).digest('hex');
    expect(nowpayments.verifyIPN(payload, sig, raw.toString())).toBe(true);
  });
});
