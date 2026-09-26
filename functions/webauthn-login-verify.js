const { verifyAuthenticationResponse } = require('@simplewebauthn/server');
const { getPlatformStore } = require('./_store');
const { sign } = require('./_ownerToken');

function store() {
    return getPlatformStore("webauthn");
}

exports.handler = async (event) => {
    const body = JSON.parse(event.body);

    const stored = await store().get("current-challenge", { type: "json" });
    const cred = await store().get("owner-credential", { type: "json" });

    if (!stored || !cred) {
        return { statusCode: 400, body: JSON.stringify({ error: "Missing challenge or credential" }) };
    }

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
        await store().setJSON("owner-credential", {
            ...cred,
            counter: verification.authenticationInfo.newCounter
        });
    }

    if (verification.verified && !process.env.OWNER_TOKEN_SECRET) {
        return {
            statusCode: 500,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ verified: false, error: "Server is missing OWNER_TOKEN_SECRET — key verified but can't issue a session token." })
        };
    }

    return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            verified: verification.verified,
            token: verification.verified ? sign(process.env.OWNER_TOKEN_SECRET) : undefined
        })
    };
};
