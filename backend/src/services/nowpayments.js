const crypto = require('crypto');
const axios = require('axios');
const { logger } = require('../logger');

const API_URL = process.env.NOWPAYMENTS_API_URL || 'https://api.nowpayments.io/v1';
const API_KEY = process.env.NOWPAYMENTS_API_KEY;
const IPN_SECRET = process.env.NOWPAYMENTS_IPN_SECRET;

// Supported coins configuration
const SUPPORTED_COINS = {
  BTC:  { name: 'Bitcoin',   chain: 'bitcoin',   minAmount: 0.0001,  fee: 0.00005 },
  ETH:  { name: 'Ethereum',  chain: 'ethereum',  minAmount: 0.001,   fee: 0.0005 },
  BNB:  { name: 'BNB',       chain: 'bsc',       minAmount: 0.01,    fee: 0.001 },
  USDT: { name: 'Tether',    chain: 'tron',      minAmount: 1,       fee: 1 },
  TRX:  { name: 'Tron',      chain: 'tron',      minAmount: 10,      fee: 1 },
  DOGE: { name: 'Dogecoin',  chain: 'dogecoin',  minAmount: 10,      fee: 1 },
  XRP:  { name: 'Ripple',    chain: 'ripple',    minAmount: 1,       fee: 0.1 },
};

class NowPaymentsService {
  constructor() {
    if (!API_KEY) {
      logger.warn('NowPayments API key not configured');
    }
    if (!IPN_SECRET) {
      logger.warn('NOWPAYMENTS_IPN_SECRET not configured — IPN webhooks will be REJECTED (fail closed)');
    }
  }

  // Get auth headers
  getHeaders() {
    return {
      'x-api-key': API_KEY,
      'Content-Type': 'application/json',
    };
  }

  // Create payment invoice (coin optional — customer picks on NowPayments page)
  async createInvoice({ userId, coin, amount, orderId, description }) {
    const finalOrderId = orderId || `plankton-${userId}-${Date.now()}`;
    const body = {
      price_amount: amount,
      price_currency: 'usd',
      order_id: finalOrderId,
      order_description: description || `Plankton Network deposit - $${amount} USD`,
      ipn_callback_url: `${process.env.BACKEND_URL || 'https://plankton.click'}/api/payments/deposit/webhook`,
    };
    // Optional: pre-select coin; omit so customer chooses on hosted checkout
    if (coin && SUPPORTED_COINS[coin]) {
      body.pay_currency = coin.toLowerCase();
    }

    try {
      const response = await axios.post(`${API_URL}/invoice`, body, { headers: this.getHeaders() });

      return {
        success: true,
        invoiceId: response.data.id,
        orderId: finalOrderId,
        invoiceUrl: response.data.invoice_url,
        payAddress: response.data.pay_address,
        payAmount: response.data.pay_amount,
        payCurrency: response.data.pay_currency,
      };
    } catch (err) {
      logger.error({ err: err.response?.data || err.message }, 'NowPayments createInvoice failed');
      return { success: false, error: err.response?.data?.message || err.message };
    }
  }

  // Verify IPN callback signature.
  // Fails closed when the secret is missing and compares in constant time.
  verifyIPN(payload, signature, rawBody) {
    if (!IPN_SECRET) {
      logger.error('IPN rejected: NOWPAYMENTS_IPN_SECRET is not configured');
      return false;
    }
    if (!signature || typeof signature !== 'string') return false;

    const hmacMatches = (data) => {
      const hmac = crypto.createHmac('sha512', IPN_SECRET);
      hmac.update(data);
      const expected = Buffer.from(hmac.digest('hex'), 'utf8');
      const actual = Buffer.from(signature, 'utf8');
      if (expected.length !== actual.length) return false;
      return crypto.timingSafeEqual(expected, actual);
    };

    // B2 (primary): the exact bytes the sender signed — immune to any
    // difference between their serialisation and ours.
    if (rawBody) {
      const raw = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody));
      if (hmacMatches(raw)) return true;
    }

    // Fallback: canonical sorted JSON (the NowPayments v1 scheme) — keeps
    // bodies whose raw bytes differ only in key order/whitespace working.
    const sortedPayload = Object.keys(payload)
      .sort()
      .reduce((acc, key) => {
        acc[key] = payload[key];
        return acc;
      }, {});

    return hmacMatches(JSON.stringify(sortedPayload));
  }

  // Process IPN callback — always credit USD (price_amount)
  async processIPN(payload) {
    const { order_id, invoice_id, payment_status, price_amount, pay_amount, pay_currency, invoice_price_amount, tx_hash } = payload;

    // Extract userId from order_id (format: plankton-{userId}-{timestamp})
    const parts = (order_id || '').split('-');
    const userId = parseInt(parts[1]);

    // Prefer USD invoice amount (price_amount); fallback to pay_amount only if USD
    const usdAmount = parseFloat(price_amount || invoice_price_amount || 0);

    if (payment_status === 'finished') {
      return {
        success: true,
        userId,
        coin: 'USD',
        amount: usdAmount > 0 ? usdAmount : parseFloat(pay_amount || 0),
        cryptoAmount: parseFloat(pay_amount || 0),
        cryptoCoin: (pay_currency || '').toUpperCase(),
        txHash: tx_hash,
        orderId: order_id || null,
        invoiceId: invoice_id ? String(invoice_id) : null,
        processorId: order_id,
        status: 'completed',
      };
    }

    return {
      success: false,
      userId,
      coin: 'USD',
      orderId: order_id || null,
      invoiceId: invoice_id ? String(invoice_id) : null,
      status: payment_status,
    };
  }

  // Create payout (withdrawal) — coin optional; defaults handled by caller
  async createPayout({ address, amount, coin }) {
    try {
      const response = await axios.post(`${API_URL}/payout`, {
        withdrawals: [{
          address,
          amount,
          currency: (coin || 'USDT').toLowerCase(),
          // network hint for multi-network coins (USDT has many chains)
          ...(coin === 'USDT' ? { network: 'tron' } : {}),
        }],
      }, { headers: this.getHeaders() });

      return {
        success: true,
        payoutId: response.data.id,
        txHash: response.data.tx_hash,
        status: response.data.status,
      };
    } catch (err) {
      logger.error({ err: err.response?.data || err.message }, 'NowPayments payout failed');
      return { success: false, error: err.response?.data?.message || err.message };
    }
  }

  // Get payment status
  async getPaymentStatus(invoiceId) {
    try {
      const response = await axios.get(`${API_URL}/invoice/${invoiceId}`, {
        headers: this.getHeaders(),
      });
      return { success: true, status: response.data };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  // Get supported coins
  getSupportedCoins() {
    return SUPPORTED_COINS;
  }

  // Get min amount for a coin (USD deposits use NowPayments minimums)
  getMinAmount(coin) {
    return SUPPORTED_COINS[coin]?.minAmount || 0;
  }

  // Minimum USD deposit
  getMinUsdDeposit() {
    return 1;
  }

  // Withdraw fee (sender pays): fixed + % — surface to user
  getWithdrawFee(amount) {
    // $0.50 + 0.5% (matches NowPayments standard), min $1
    const fee = Math.max(1, 0.5 + amount * 0.005);
    return Math.round(fee * 100) / 100;
  }

  // Calculate fee (legacy per-coin)
  calculateFee(amount, coin) {
    if (coin === 'USD' || coin === 'USDT') return this.getWithdrawFee(amount);
    const coinConfig = SUPPORTED_COINS[coin];
    if (!coinConfig) return 0;
    return coinConfig.fee;
  }
}

module.exports = new NowPaymentsService();
