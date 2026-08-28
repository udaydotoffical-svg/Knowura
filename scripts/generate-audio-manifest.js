const fs = require('fs');
const path = require('path');

const audioDir = path.join(__dirname, '..', 'public', 'assets', 'audio');
const manifestPath = path.join(audioDir, 'manifest.json');

function toTitle(filename) {
    return filename
        .replace(/\.mp3$/i, '')
        .replace(/[-_]+/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase());
}

const files = fs.readdirSync(audioDir)
    .filter(f => f.toLowerCase().endsWith('.mp3'))
    .sort((a, b) => a.localeCompare(b));

const tracks = files.map(f => ({ file: f, title: toTitle(f) }));

fs.writeFileSync(manifestPath, JSON.stringify(tracks, null, 2) + '\n');
console.log(`Generated audio manifest with ${tracks.length} track(s): ${files.join(', ')}`);
