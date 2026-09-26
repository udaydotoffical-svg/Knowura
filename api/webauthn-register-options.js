// Vercel entry point — same logic as functions/webauthn-register-options.js, just adapted to
// Vercel's (req, res) shape. See functions/_vercelAdapter.js.
const { toVercelHandler } = require('../functions/_vercelAdapter');
module.exports = toVercelHandler(require('../functions/webauthn-register-options').handler);
