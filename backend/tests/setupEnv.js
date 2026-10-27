// Runs BEFORE the test framework and before any module is required, so env
// vars here are visible to modules that read them at import time
// (middleware/auth.js exits the process if JWT_SECRET is missing).
process.env.NODE_ENV = 'production'; // avoids pino-pretty worker threads
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-1234';
process.env.LOG_LEVEL = 'silent';
process.env.DISABLE_CACHE = '1';
process.env.NOWPAYMENTS_IPN_SECRET = 'test-ipn-secret-test-ipn-secret-1234';
process.env.BACKEND_URL = 'https://plankton.click';
process.env.OLLAMA_URL = 'http://127.0.0.1:1'; // never reachable from tests
// RESEND_API_KEY intentionally unset → isEmailConfigured() === false
