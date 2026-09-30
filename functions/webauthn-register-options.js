const { generateRegistrationOptions } = require('@simplewebauthn/server');
const { getPlatformStore } = require('./_store');
const { json, guard, readJson } = require('./_util');
const { authAttempt } = require('./_limits');
const { checkRegistrationAllowed } = require('./_webauthnAuth');

function store() {
    return getPlatformStore("webauthn");
}

exports.handler = async (event) => {
    const early = guard(event, ["GET", "POST"]);
    if (early) return early;
    try {
        const { error: badBody } = readJson(event, 1024); // these routes take no body — refuse anything large or malformed
        if (badBody) return badBody;
        const limited = await authAttempt(event, 'webauthn-register-options');
        if (limited) return limited;

        const existing = await store().get("owner-credential", { type: "json" });
        const denied = checkRegistrationAllowed(event, existing);
        if (denied) return json(denied.statusCode, { error: denied.error });

        const options = await generateRegistrationOptions({
            rpName: "Knowura",
            rpID: process.env.RP_ID,
            userID: new TextEncoder().encode("uday-owner"),
            userName: "uday",
            attestationType: "none",
            authenticatorSelection: {
                authenticatorAttachment: "cross-platform",
                userVerification: "preferred",
                residentKey: "preferred"
            }
        });

        // Separate key from the login challenge so the two flows can't clobber each other.
        await store().setJSON("register-challenge", { challenge: options.challenge, at: Date.now() });
        return json(200, options);
    } catch (error) {
        return json(500, { error: "Couldn't start registration." });
    }
};
