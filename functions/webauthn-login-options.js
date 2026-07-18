const { generateAuthenticationOptions } = require('@simplewebauthn/server');
const { getStore } = require('@netlify/blobs');

exports.handler = async () => {
  const store = getStore("webauthn");
  const cred = await store.get("owner-credential", { type: "json" });

  if (!cred) {
    return { statusCode: 404, body: JSON.stringify({ error: "No credential registered" }) };
  }

  const options = await generateAuthenticationOptions({
    rpID: process.env.RP_ID,
    allowCredentials: [{ id: cred.id }],
    userVerification: "preferred"
  });

  await store.setJSON("current-challenge", { challenge: options.challenge });

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options)
  };
};
