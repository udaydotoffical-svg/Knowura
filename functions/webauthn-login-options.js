const { generateAuthenticationOptions } = require('@simplewebauthn/server');
const { getPlatformStore } = require('./_store');
const { json, preflight, rateLimit, tooMany } = require('./_util');

function store() {
    return getPlatformStore("webauthn");
}

exports.handler = async (event) => {
    if (event.httpMethod === "OPTIONS") return preflight();
    try {
        const wait = rateLimit(event, "webauthn-login", 20, 60 * 1000);
        if (wait) return tooMany(wait);

        const cred = await store().get("owner-credential", { type: "json" });
        if (!cred) return json(404, { error: "No credential registered" });

        const options = await generateAuthenticationOptions({
            rpID: process.env.RP_ID,
            allowCredentials: [{ id: cred.id }],
            userVerification: "preferred"
        });

        await store().setJSON("login-challenge", { challenge: options.challenge, at: Date.now() });
        return json(200, options);
    } catch (error) {
        return json(500, { error: error.message });
    }
};
