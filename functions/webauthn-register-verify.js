const { verifyRegistrationResponse } = require('@simplewebauthn/server');
const { getPlatformStore } = require('./_store');
const { json, guard, readJson } = require('./_util');
const { authAttempt } = require('./_limits');
const { checkRegistrationAllowed } = require('./_webauthnAuth');
const { cleanCredentialResponse } = require('./_webauthnInput');

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

function store() {
    return getPlatformStore("webauthn");
}

exports.handler = async (event) => {
    const early = guard(event);
    if (early) return early;
    try {
        const limited = await authAttempt(event, 'webauthn-register-verify');
        if (limited) return limited;

        const { body, error } = readJson(event, 16 * 1024, { allowEmpty: false });
        if (error) return error;
        const credential = cleanCredentialResponse(body);
        if (!credential) return json(400, { verified: false, error: "Malformed credential" });

        const existing = await store().get("owner-credential", { type: "json" });
        const denied = checkRegistrationAllowed(event, existing);
        if (denied) return json(denied.statusCode, { error: denied.error });

        const stored = await store().get("register-challenge", { type: "json" });
        if (!stored?.challenge || Date.now() - (stored.at || 0) > CHALLENGE_TTL_MS) {
            return json(400, { error: "No challenge found (or it expired)" });
        }
        await store().setJSON("register-challenge", { challenge: null, at: 0 }); // one-shot

        const verification = await verifyRegistrationResponse({
            response: credential,
            expectedChallenge: stored.challenge,
            expectedOrigin: process.env.ORIGIN,
            expectedRPID: process.env.RP_ID
        });

        if (verification.verified) {
            const { credential: cred } = verification.registrationInfo;
            await store().setJSON("owner-credential", {
                id: cred.id,
                publicKey: Buffer.from(cred.publicKey).toString('base64'),
                counter: cred.counter
            });
        }
        return json(200, { verified: verification.verified });
    } catch (error) {
        return json(400, { verified: false, error: "Registration failed." });
    }
};
