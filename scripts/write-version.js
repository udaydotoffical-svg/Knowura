// Writes public/version.json at build time so the app's About screen can show which version and
// build is running. `version` comes from package.json; the commit id is provided by Vercel/Netlify.
const fs = require('fs');
const path = require('path');

const pkg = require('../package.json');
const sha = (process.env.VERCEL_GIT_COMMIT_SHA || process.env.COMMIT_REF || process.env.GITHUB_SHA || '').slice(0, 7);
const out = { version: pkg.version, build: sha || 'dev', builtAt: new Date().toISOString() };

fs.writeFileSync(path.join(__dirname, '..', 'public', 'version.json'), JSON.stringify(out) + '\n');
console.log(`version.json: v${out.version} (${out.build})`);
