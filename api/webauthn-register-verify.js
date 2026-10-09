// Vercel entry point — same logic as functions/webauthn-register-verify.js, just adapted to
// Vercel's (req, res) shape. See functions/_lib/_vercelAdapter.js.
const { toVercelHandler } = require('../functions/_lib/_vercelAdapter');
module.exports = toVercelHandler(require('../functions/webauthn-register-verify').handler);
