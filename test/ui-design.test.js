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

test('learning additions use sanitized sources, typed feature payloads, and Weak Spots persistence', () => {
    assert.match(html, /function sourcePanelHTML\(sources\)/);
    assert.match(html, /sourcePanelHTML\(data\.sources\)/);
    assert.ok(html.includes("if (!['http:', 'https:'].includes(url.protocol)"));
    assert.ok(html.includes('rel="noopener noreferrer"'));
    assert.ok(html.includes("requestLearningFeature({ type: 'teachback', phase: 'prompt' }"));
    assert.ok(html.includes("requestLearningFeature({ type: 'teachback', phase: 'assess' }"));
    assert.ok(html.includes("requestLearningFeature({ type: 'visual' }"));
    assert.match(html, /result\.teachback\?\.type !== 'assessment'/);
    assert.match(html, /visual\?\.type === 'concept-map'/);
    assert.match(html, /function weakAddConcept\(concept, hint, context\)/);
    assert.match(html, /function saveChatArtifact\(bubble, field, payload\)/);
    assert.match(html, /function restoreChatArtifacts\(bubble, message\)/);
    assert.ok(html.includes("question: String(question || '').slice(0, 500)"));
    assert.ok(html.includes("response: String(response || '').slice(0, 1200)"));
    assert.ok(html.includes('result.question'));
    assert.ok(html.includes('result.response'));
    assert.match(html, /aria-expanded/);
    assert.match(html, /teachback-saved/);
    assert.match(html, /font-size: 16px; line-height: 1\.5/);
});

test('restored teach-back cards never claim Weak Spots were saved while Incognito is on', () => {
    const start = html.indexOf('function renderSavedTeachback(card, result)');
    const end = html.indexOf('function restoreChatArtifacts(bubble, message)', start);
    assert.notEqual(start, -1, 'saved teach-back renderer should exist');
    assert.ok(end > start, 'saved teach-back renderer should have a bounded source block');
    const renderer = html.slice(start, end);
    assert.ok(renderer.includes("saved.textContent = incognito ? 'Weak Spots aren’t saved while Incognito mode is on.' : 'Saved to Weak Spots for spaced review.';"));
});
