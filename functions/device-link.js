// Called by the website (inside the Android app) to link this install to the signed-in account, to
// unlink it on sign-out, and to save the assistant preferences. Needs a valid user token to link.

const { verify } = require('./_userToken');
const { json, guard, readJson, cleanStr, isPlainObject, rateLimit, tooMany } = require('./_util');
const { store, idOk, keyOf, modelOk } = require('./_devices');

exports.handler = async (event) => {
    const early = guard(event);
    if (early) return early;
    try {
        const wait = rateLimit(event, 'device-link', 60, 15 * 60 * 1000);
        if (wait) return tooMany(wait);

        const { body, error } = readJson(event, 4 * 1024, { allowEmpty: false });
        if (error) return error;
        if (!idOk(body.installId)) return json(400, { error: 'Bad install id' });

        const key = keyOf(body.installId);
        // a failed read throws (-> 500) rather than looking like "no record", so a blip can't wipe a link
        const rec = { ...((await store().get(key, { type: 'json' })) || {}) };

        if (body.unlink === true) {
            rec.sub = null; rec.profile = null; rec.linkedAt = 0;
        } else if (body.token !== undefined) {
            const session = verify(cleanStr(body.token, 400, 1), process.env.KNOWURA_USER_TOKEN_SECRET);
            if (!session) return json(401, { error: 'Invalid or expired session' });
            const p = isPlainObject(body.profile) ? body.profile : {};
            rec.sub = session.sub;
            rec.linkedAt = Date.now();
            rec.profile = {
                given_name: cleanStr(p.given_name, 60) ?? undefined,
                email: cleanStr(p.email, 254) ?? undefined,
                picture: typeof p.picture === 'string' && /^https:\/\//.test(p.picture) && p.picture.length <= 500 ? p.picture : undefined
            };
        }
        if (isPlainObject(body.prefs)) {
            rec.prefs = { assistantModel: modelOk(body.prefs.assistantModel) ? body.prefs.assistantModel : '' };
        }
        rec.updatedAt = Date.now();
        await store().setJSON(key, rec);
        return json(200, { ok: true });
    } catch (e) {
        return json(500, { error: "Couldn't link this device." });
    }
};
