const { verifyAuthenticationResponse } = require('@simplewebauthn/server');
const { getPlatformStore } = require('./_lib/_store');
const { sign } = require('./_lib/_ownerToken');
const { json, guard, readJson } = require('./_lib/_util');
const { authAttempt } = require('./_lib/_limits');
const { cleanCredentialResponse } = require('./_lib/_webauthnInput');

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

function store() {
    return getPlatformStore("webauthn");
}

exports.handler = async (event) => {
    const early = guard(event);
    if (early) return early;
    try {
        const limited = await authAttempt(event, 'webauthn-login-verify');
        if (limited) return limited;

        const { body, error } = readJson(event, 16 * 1024, { allowEmpty: false });
        if (error) return error;
        const credential = cleanCredentialResponse(body);
        if (!credential) return json(400, { verified: false, error: "Malformed credential" });

        const stored = await store().get("login-challenge", { type: "json" });
        const cred = await store().get("owner-credential", { type: "json" });
        if (!stored?.challenge || !cred || Date.now() - (stored.at || 0) > CHALLENGE_TTL_MS) {
            return json(400, { verified: false, error: "Missing challenge or credential" });
        }
        await store().setJSON("login-challenge", { challenge: null, at: 0 }); // one-shot: no replays

        const verification = await verifyAuthenticationResponse({
            response: credential,
            expectedChallenge: stored.challenge,
            expectedOrigin: process.env.ORIGIN,
            expectedRPID: process.env.RP_ID,
            credential: {
                id: cred.id,
                publicKey: Buffer.from(cred.publicKey, 'base64'),
                counter: cred.counter
            }
        });

        if (verification.verified) {
            if (!process.env.OWNER_TOKEN_SECRET) {
                return json(500, { verified: false, error: "Server isn't fully configured." });
            }
            await store().setJSON("owner-credential", { ...cred, counter: verification.authenticationInfo.newCounter });
        }

        return json(200, {
            verified: verification.verified,
            token: verification.verified ? sign(process.env.OWNER_TOKEN_SECRET) : undefined
        });
    } catch (error) {
        return json(401, { verified: false, error: "Verification failed." });
    }
};
