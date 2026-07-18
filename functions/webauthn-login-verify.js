const { verifyAuthenticationResponse } = require('@simplewebauthn/server');
const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
    const store = getStore("webauthn");
    const body = JSON.parse(event.body);

    const stored = await store.get("current-challenge", { type: "json" });
    const cred = await store.get("owner-credential", { type: "json" });

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
        await store.setJSON("owner-credential", {
            ...cred,
            counter: verification.authenticationInfo.newCounter
        });
    }

    return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ verified: verification.verified })
    };
};
