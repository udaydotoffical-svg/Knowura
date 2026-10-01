// Turns owner mode on for the owner's own Google account, with no password. The request must carry a valid signed-in
// session token, and the server only hands back an owner token if that verified account is the owner's. Owner mode is
// never switched on by signing in: this is the explicit "turn it on" step.

const { verify } = require('./_userToken');
const { isOwnerSub, issueOwnerToken } = require('./_owner');
const { json, guard, readJson, cleanStr, rateLimit, tooMany } = require('./_util');

exports.handler = async (event) => {
    const early = guard(event);
    if (early) return early;
    try {
        const wait = rateLimit(event, 'owner-enable', 20, 15 * 60 * 1000);
        if (wait) return tooMany(wait);

        const { body, error } = readJson(event, 2 * 1024);
        if (error) return error;
        const token = cleanStr(body.token, 400, 1);
        const session = token && verify(token, process.env.KNOWURA_USER_TOKEN_SECRET);
        if (!session) return json(401, { error: 'Sign in with your owner Google account first.' });
        if (!(await isOwnerSub(session.sub))) return json(403, { error: 'This account can\'t turn on owner mode.' });

        const ownerToken = issueOwnerToken();
        if (!ownerToken) return json(500, { error: 'Owner mode isn\'t configured on the server.' });
        return json(200, { ownerToken });
    } catch (e) {
        return json(500, { error: 'Couldn\'t turn on owner mode.' });
    }
};
