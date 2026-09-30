// Scans every git-tracked text file for things that look like real credentials, and fails
// if any are found. Run with `npm run check:secrets` (it also runs inside `npm test`).
// The Google OAuth client ID is public by design and is allow-listed.
const { execFileSync } = require('child_process');
const fs = require('fs');

const PATTERNS = [
    ['Groq key', /\bgsk_[A-Za-z0-9]{20,}\b/],
    ['Tavily key', /\btvly-[A-Za-z0-9_-]{10,}\b/],
    ['OpenAI/Anthropic-style key', /\bsk-[A-Za-z0-9_-]{20,}\b/],
    ['Google API key', /\bAIza[0-9A-Za-z_-]{30,}\b/],
    ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
    ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
    ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
    ['Private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    ['JWT', /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/],
    ['Secret-looking assignment', /\b(api[_-]?key|secret|password|passwd|token)\b["']?\s*[:=]\s*["'][A-Za-z0-9+/_\-]{16,}["']/i]
];
const SKIP = /(^|\/)(package-lock\.json|assets\/vendor\/|assets\/(images|audio|video|brand)\/|.*\.(png|jpe?g|gif|ico|mp3|mp4|svg|woff2?))/i;

function scan() {
    const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(f => f && !SKIP.test(f));
    const found = [];
    for (const f of files) {
        let text;
        try { text = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }
        text.split('\n').forEach((line, i) => {
            if (line.length > 2000) return; // minified blobs
            for (const [name, re] of PATTERNS) if (re.test(line)) found.push(`${f}:${i + 1} looks like a ${name}`);
        });
    }
    return found;
}

if (require.main === module) {
    const found = scan();
    if (found.length) { console.error('Possible secrets committed:\n' + found.join('\n')); process.exit(1); }
    console.log('check:secrets — no credentials found in tracked files.');
}
module.exports = { scan };
