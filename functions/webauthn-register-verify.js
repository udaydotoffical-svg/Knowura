const { verifyRegistrationResponse } = require('@simplewebauthn/server');
const { getPlatformStore } = require('./_store');
const { json, preflight, rateLimit, tooMany, parseBody } = require('./_util');
const { checkRegistrationAllowed } = require('./_webauthnAuth');

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

function store() {
    return getPlatformStore("webauthn");
}

exports.handler = async (event) => {
    if (event.httpMethod === "OPTIONS") return preflight();
    try {
        const wait = rateLimit(event, "webauthn-register", 10, 60 * 1000);
        if (wait) return tooMany(wait);

        const body = parseBody(event);
        if (!body) return json(400, { error: "Malformed JSON" });

        const existing = await store().get("owner-credential", { type: "json" });
        const denied = checkRegistrationAllowed(event, existing);
        if (denied) return json(denied.statusCode, { error: denied.error });

        const stored = await store().get("register-challenge", { type: "json" });
        if (!stored || Date.now() - (stored.at || 0) > CHALLENGE_TTL_MS) {
            return json(400, { error: "No challenge found (or it expired)" });
        }
        await store().setJSON("register-challenge", { challenge: null, at: 0 }); // one-shot

        const verification = await verifyRegistrationResponse({
            response: body,
            expectedChallenge: stored.challenge,
            expectedOrigin: process.env.ORIGIN,
            expectedRPID: process.env.RP_ID
        });

        if (verification.verified) {
            const { credential } = verification.registrationInfo;
            await store().setJSON("owner-credential", {
                id: credential.id,
                publicKey: Buffer.from(credential.publicKey).toString('base64'),
                counter: credential.counter
            });
        }
        return json(200, { verified: verification.verified });
    } catch (error) {
        return json(400, { verified: false, error: error.message });
    }
};
