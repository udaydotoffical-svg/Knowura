const { verifyRegistrationResponse } = require('@simplewebauthn/server');
const { getStore } = require('@netlify/blobs');

function store() {
    return getStore({
        name: "webauthn",
        siteID: process.env.NETLIFY_SITE_ID,
        token: process.env.NETLIFY_BLOBS_TOKEN
    });
}

exports.handler = async (event) => {
    const body = JSON.parse(event.body);

    const stored = await store().get("current-challenge", { type: "json" });
    if (!stored) {
        return { statusCode: 400, body: JSON.stringify({ error: "No challenge found" }) };
    }

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

    return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ verified: verification.verified })
    };
};
