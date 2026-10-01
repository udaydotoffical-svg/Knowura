// Links an Android install to a Knowura account so the assistant panel (a separate web view with its own
// storage) can use the sign-in and the assistant model you chose in the app. The install id is a random
// secret made by the Android app and known only to it and to the site when the app opens it. The server
// stores only a hash of it. Not a route (no exports.handler).

const crypto = require('crypto');
const { getPlatformStore } = require('./_store');

const LINK_TTL_MS = 60 * 24 * 60 * 60 * 1000; // a link lasts 60 days and is refreshed each time the app opens signed in

let storeOverride = null;
const store = () => storeOverride || getPlatformStore('devices');
const setStoreForTests = (s) => { storeOverride = s; };

const idOk = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{22,64}$/.test(v);
const keyOf = (id) => crypto.createHash('sha256').update(`install|${id}`).digest('hex').slice(0, 40);
const modelOk = (v) => typeof v === 'string' && /^[\w.\-\/:]{1,120}$/.test(v);

module.exports = { LINK_TTL_MS, store, setStoreForTests, idOk, keyOf, modelOk };
