// Vercel entry point — same logic as functions/owner-password-verify.js, just adapted to
// Vercel's (req, res) shape. See functions/_vercelAdapter.js.
const { toVercelHandler } = require('../functions/_vercelAdapter');
module.exports = toVercelHandler(require('../functions/owner-password-verify').handler);
