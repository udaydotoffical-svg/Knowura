const { generateRegistrationOptions } = require('@simplewebauthn/server');
const { getStore } = require('@netlify/blobs');

exports.handler = async () => {
  const store = getStore("webauthn");

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

  await store.setJSON("current-challenge", { challenge: options.challenge });

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options)
  };
};
