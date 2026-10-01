// One Vercel function for three small endpoints (device-link, device-session, models), because Vercel's
// free plan allows at most 12 functions. vercel.json rewrites /.netlify/functions/<name> to
// /api/misc?op=<name>; the logic still lives in functions/<name>.js, shared with Netlify.
const { toVercelHandler } = require('../functions/_vercelAdapter');

const HANDLERS = {
    'device-link': toVercelHandler(require('../functions/device-link').handler),
    'device-session': toVercelHandler(require('../functions/device-session').handler),
    'models': toVercelHandler(require('../functions/models').handler)
};

module.exports = (req, res) => {
    const op = String((req.query && req.query.op) || '');
    const handler = Object.prototype.hasOwnProperty.call(HANDLERS, op) ? HANDLERS[op] : null;
    if (!handler) { res.status(404).json({ error: 'Not found' }); return; }
    return handler(req, res);
};
