const { generateRegistrationOptions } = require('@simplewebauthn/server');
const { getPlatformStore } = require('./_store');
const { json, preflight, rateLimit, tooMany } = require('./_util');
const { checkRegistrationAllowed } = require('./_webauthnAuth');

function store() {
    return getPlatformStore("webauthn");
}

exports.handler = async (event) => {
    if (event.httpMethod === "OPTIONS") return preflight();
    try {
        const wait = rateLimit(event, "webauthn-register", 10, 60 * 1000);
        if (wait) return tooMany(wait);

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
        return json(500, { error: error.message });
    }
};
