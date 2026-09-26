// Platform-aware key/value storage. Netlify and Vercel deployments are fully
// independent (separate data, not shared) — each platform uses its own
// native storage, picked automatically at runtime via process.env.VERCEL
// (set automatically by Vercel, never by Netlify). Every caller gets the
// same tiny interface either way: store.get(key, {type:'json'}) /
// store.setJSON(key, value).
//
// Vercel side uses a *private* Blob store (access: 'private') — reads
// require the store's own token, not just a guessable URL, so it's the
// same "only this server can read it" guarantee Netlify Blobs' manual mode
// (siteID + token) already gives.

const IS_VERCEL = !!process.env.VERCEL;

function netlifyStore(name) {
    const { getStore } = require('@netlify/blobs');
    return getStore({
        name,
        siteID: process.env.NETLIFY_SITE_ID,
        token: process.env.NETLIFY_BLOBS_TOKEN
    });
}

function vercelStore(name) {
    const { put, get } = require('@vercel/blob');
    const pathFor = (key) => `${name}/${encodeURIComponent(key)}.json`;

    return {
        async get(key, opts) {
            try {
                const result = await get(pathFor(key), { access: 'private' });
                if (!result || result.statusCode !== 200) return null;
                const chunks = [];
                for await (const chunk of result.stream) chunks.push(chunk);
                const text = Buffer.concat(chunks).toString('utf8');
                return opts?.type === 'json' ? JSON.parse(text) : text;
            } catch (e) {
                return null; // no such blob — same "missing" contract as @netlify/blobs' get()
            }
        },
        async setJSON(key, value) {
            await put(pathFor(key), JSON.stringify(value), {
                access: 'private',
                contentType: 'application/json',
                addRandomSuffix: false,
                allowOverwrite: true
            });
        }
    };
}

function getPlatformStore(name) {
    return IS_VERCEL ? vercelStore(name) : netlifyStore(name);
}

module.exports = { getPlatformStore };
