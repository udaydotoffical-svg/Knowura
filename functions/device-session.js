// Called by the assistant panel with the install id. If the app has linked this install to an account, hands
// back a fresh session token + profile (so the panel is signed in as the same person) and the assistant prefs.

const { sign } = require('./_userToken');
const { json, guard, readJson, rateLimit, tooMany } = require('./_util');
const { store, idOk, keyOf, LINK_TTL_MS } = require('./_devices');

exports.handler = async (event) => {
    const early = guard(event);
    if (early) return early;
    try {
        const wait = rateLimit(event, 'device-session', 120, 15 * 60 * 1000);
        if (wait) return tooMany(wait);

        const { body, error } = readJson(event, 1024, { allowEmpty: false });
        if (error) return error;
        if (!idOk(body.installId)) return json(400, { error: 'Bad install id' });

        const rec = await store().get(keyOf(body.installId), { type: 'json' });
        const prefs = { assistantModel: rec?.prefs?.assistantModel || '' };
        const revokeBefore = Number(process.env.KNOWURA_TOKEN_REVOKE_BEFORE || 0);
        const live = rec?.sub && rec.linkedAt && Date.now() - rec.linkedAt < LINK_TTL_MS && !(revokeBefore && rec.linkedAt < revokeBefore);
        if (!live) return json(200, { linked: false, prefs });

        const secret = process.env.KNOWURA_USER_TOKEN_SECRET;
        if (!secret) return json(500, { error: 'Sign-in isn\'t configured on the server.' });
        return json(200, { linked: true, token: sign(rec.sub, secret), profile: { sub: rec.sub, ...(rec.profile || {}) }, prefs });
    } catch (e) {
        return json(500, { error: "Couldn't check this device." });
    }
};
