const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('text-entry controls meet the design system 16px minimum', () => {
    const start = html.indexOf('/* Design-system floor: editable text controls never drop below 16px. */');
    const end = html.indexOf('</style>', start);
    assert.notEqual(start, -1, 'input-size floor rule should be present in the source stylesheet');
    assert.notEqual(end, -1, 'input-size floor rule should remain inside the stylesheet');
    const rule = html.slice(start, end);
    for (const type of ['text', 'password', 'search', 'email', 'url', 'number', 'tel']) {
        assert.ok(rule.includes(`input[type="${type}"]`), `${type} inputs should be covered`);
    }
    assert.match(rule, /select\.assistant-select/);
    assert.match(rule, /font-size:\s*16px/);
});

test('prompt picker chips use the design system black outline and hard shadow', () => {
    const picker = html.match(/\.pb-pick\s*\{([^}]+)\}/);
    assert.ok(picker, 'prompt picker rule should exist');
    assert.match(picker[1], /border:\s*2px solid var\(--ink\)/);
    assert.match(picker[1], /box-shadow:\s*2px 2px 0 var\(--ink\)/);
});
