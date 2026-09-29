const { verifyAuthenticationResponse } = require('@simplewebauthn/server');
const { getPlatformStore } = require('./_store');
const { sign } = require('./_ownerToken');
const { json, preflight, rateLimit, tooMany, parseBody } = require('./_util');

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

function store() {
    return getPlatformStore("webauthn");
}

exports.handler = async (event) => {
    if (event.httpMethod === "OPTIONS") return preflight();
    try {
        const wait = rateLimit(event, "webauthn-login", 20, 60 * 1000);
        if (wait) return tooMany(wait);

        const body = parseBody(event);
        if (!body) return json(400, { verified: false, error: "Malformed JSON" });

        const stored = await store().get("login-challenge", { type: "json" });
        const cred = await store().get("owner-credential", { type: "json" });
        if (!stored?.challenge || !cred || Date.now() - (stored.at || 0) > CHALLENGE_TTL_MS) {
            return json(400, { verified: false, error: "Missing challenge or credential" });
        }
        await store().setJSON("login-challenge", { challenge: null, at: 0 }); // one-shot: no replays

        const verification = await verifyAuthenticationResponse({
            response: body,
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
                return json(500, { verified: false, error: "Server is missing OWNER_TOKEN_SECRET — key verified but can't issue a session token." });
            }
            await store().setJSON("owner-credential", { ...cred, counter: verification.authenticationInfo.newCounter });
        }

        return json(200, {
            verified: verification.verified,
            token: verification.verified ? sign(process.env.OWNER_TOKEN_SECRET) : undefined
        });
    } catch (error) {
        return json(401, { verified: false, error: error.message });
    }
};
