// Verifies a Google Identity Services credential (ID token) server-side before
// trusting any of its claims: checks the token with Google's tokeninfo endpoint
// (signature + expiry), that `aud` is this app's own OAuth client ID, the issuer and a
// verified email, then issues a signed session token keyed to the verified `sub`.
// Failed sign-ins are limited to 5 per 15 minutes per IP (successful ones aren't
// counted, so a shared school network doesn't lock everyone out).

const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const { sign } = require('./_userToken');
const { isOwnerLogin, rememberOwner, issueOwnerToken } = require('./_owner');
const { json, guard, readJson, cleanStr, rateLimit, tooMany } = require('./_util');
const { authBlocked, authFailure } = require('./_limits');

const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

exports.handler = async (event) => {
    const early = guard(event);
    if (early) return early;
    try {
        const wait = rateLimit(event, "google-signin", 60, 15 * 60 * 1000);
        if (wait) return tooMany(wait);
        const blocked = await authBlocked(event, 'google-signin-fail');
        if (blocked) return blocked;

        const { body, error } = readJson(event, 8 * 1024);
        if (error) return error;

        const clientId = process.env.GOOGLE_CLIENT_ID;
        const secret = process.env.KNOWURA_USER_TOKEN_SECRET;
        if (!clientId || !secret) {
            return json(500, { verified: false, error: "Google sign-in isn't configured on the server." });
        }

        const credential = cleanStr(body.credential, 4096, 20);
        if (credential === null || !JWT_SHAPE.test(credential)) {
            await authFailure(event, 'google-signin-fail');
            return json(400, { verified: false, error: "Missing or malformed credential" });
        }

        const reject = async (msg) => { await authFailure(event, 'google-signin-fail'); return json(401, { verified: false, error: msg }); };

        const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`);
        if (!res.ok) return reject("Google rejected the credential");
        const info = await res.json();

        if (info.aud !== clientId) return reject("Credential was issued for a different app");
        if (!info.sub) return reject("Credential missing subject");
        if (info.iss && !["accounts.google.com", "https://accounts.google.com"].includes(info.iss)) return reject("Credential has an unexpected issuer");
        if (info.email && String(info.email_verified) !== "true") return reject("Google account email isn't verified");
        // tokeninfo already rejects expired tokens, but double-check defensively.
        if (info.exp && Date.now() >= Number(info.exp) * 1000) return reject("Credential expired");

        const profile = {
            sub: String(info.sub).slice(0, 64),
            email: typeof info.email === "string" ? info.email.slice(0, 254) : undefined,
            given_name: String(info.given_name || info.name || "Learner").replace(/[\u0000-\u001F<>]/g, "").slice(0, 60) || "Learner",
            picture: typeof info.picture === "string" && /^https:\/\//.test(info.picture) ? info.picture.slice(0, 500) : undefined
        };

        // The owner's own Google account signs straight into owner mode (Google has verified the email).
        let ownerToken;
        if (isOwnerLogin(info)) {
            await rememberOwner(profile.sub, info.email);
            ownerToken = issueOwnerToken() || undefined;
        }

        return json(200, { verified: true, token: sign(profile.sub, secret), profile, ownerToken });
    } catch (error) {
        return json(500, { verified: false, error: "Sign-in failed. Please try again." });
    }
};
