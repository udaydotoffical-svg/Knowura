const { generateAuthenticationOptions } = require('@simplewebauthn/server');
const { getPlatformStore } = require('./_store');
const { json, guard, readJson } = require('./_util');
const { authAttempt } = require('./_limits');

function store() {
    return getPlatformStore("webauthn");
}

exports.handler = async (event) => {
    const early = guard(event, ["GET", "POST"]);
    if (early) return early;
    try {
        const { error: badBody } = readJson(event, 1024); // these routes take no body — refuse anything large or malformed
        if (badBody) return badBody;
        const limited = await authAttempt(event, 'webauthn-login-options');
        if (limited) return limited;

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
        return json(500, { error: "Couldn't start sign-in." });
    }
};
