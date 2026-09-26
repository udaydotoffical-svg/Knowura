// Wraps a Netlify Function handler — async (event, context) => ({statusCode,
// headers, body}) — into Vercel's Node.js (req, res) shape, so every function
// in this folder can be reused verbatim on both platforms with zero
// duplicated logic. Not itself a route (no exports.handler) — see api/*.js.
//
// Storage (@netlify/blobs, used by the webauthn-*/chat-* functions) needs no
// equivalent swap here: those already run in "manual mode" (getStore with an
// explicit siteID + token), which just makes authenticated HTTPS calls to
// Netlify's Blobs API — it works the same from a Vercel function as it does
// from a Netlify one, and both deployments end up sharing the same data.

function toVercelHandler(netlifyHandler) {
    return async (req, res) => {
        const event = {
            httpMethod: req.method,
            headers: req.headers,
            // Netlify functions always JSON.parse(event.body) themselves —
            // Vercel's Node runtime pre-parses JSON bodies into req.body, so
            // re-stringify to hand back the raw-string shape they expect.
            body: req.body === undefined || req.body === null
                ? ""
                : (typeof req.body === "string" ? req.body : JSON.stringify(req.body))
        };

        const result = await netlifyHandler(event, {});

        if (result.headers) {
            for (const [key, value] of Object.entries(result.headers)) {
                res.setHeader(key, value);
            }
        }
        res.status(result.statusCode || 200).send(result.body ?? "");
    };
}

module.exports = { toVercelHandler };
