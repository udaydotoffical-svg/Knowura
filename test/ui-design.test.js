const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const study = fs.readFileSync(path.join(__dirname, '..', 'functions', '_lib', '_study.js'), 'utf8');

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
    assert.match(html, /function sourcePanelHTML\(sources, searchInfo = \{\}\)/);
    assert.match(html, /sourcePanelHTML\(data\.sources, searchInfo\)/);
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

test('learning panels are compact, dismissible, mobile-readable, and the visual is an AI-led concept path', () => {
    assert.match(html, /function featureHeader\(card, eyebrow, titleText\)/);
    assert.match(html, /aria-label', 'Close learning tool'/);
    assert.match(html, /border-left: 2px solid var\(--cyan\);[^}]*box-shadow: none/);
    assert.match(html, /@media \(max-width: 680px\)[\s\S]*?\.visual-flow \{ display: flex; flex-direction: column/);
    assert.match(html, /@media \(max-width: 680px\)[\s\S]*?\.visual-step button \{ min-height: 44px/);
    assert.match(html, /\.visual-step button \{[^}]*min-height: 56px;[^}]*border-radius: 0/);
    assert.match(html, /\.visual-step button:active \{[^}]*transform: none; box-shadow: none/);
    assert.match(html, /\.visual-step button:active \.visual-step-num \{[^}]*box-shadow: 1px 1px 0/);
    assert.match(html, /\.feature-close \{[^}]*width: 44px; height: 44px;[^}]*border-radius: 0/);
    assert.match(html, /\.feature-close::before \{[^}]*inset: 11px;[^}]*border-radius: 7px/);
    assert.match(html, /\.feature-close:active::before \{[^}]*box-shadow: 1px 1px 0/);
    assert.match(html, /\.visual-step button\[aria-pressed="true"\] \.visual-step-num/);
    assert.match(html, /AI arranged the idea into a simple story/);
    assert.match(html, /plain-language labels and clear cause-and-effect order/);
    assert.doesNotMatch(html, /visual-range/);
    assert.match(study, /student-friendly visual story/);
    assert.match(study, /Avoid unexplained jargon and abstract labels/);
});

test('reply action hit areas stay at least 44px on narrow phones', () => {
    const narrow = /@media \(max-width: 420px\) \{([\s\S]*?)\n\s{8}\}/.exec(html);
    assert.ok(narrow, 'the narrow-phone media query should exist');
    assert.doesNotMatch(narrow[1], /\.reply-tools button\s*\{[^}]*\b(?:width|height):\s*(?:[0-3]\d|4[0-3])px/);
    assert.match(html, /\.reply-tools button \{[^}]*width: 44px; height: 44px/);
    assert.match(html, /\.reply-tools button \{[^}]*border-radius: 0/);
    assert.match(html, /\.reply-tools button::before \{[^}]*border-radius: 7px/);
    assert.match(html, /\.reply-tools button:active:not\(:disabled\)[^{}]*\{[^}]*transform: none; box-shadow: none/);
    assert.match(html, /\.reply-tools button:active:not\(:disabled\)::before[^{}]*\{[^}]*translate\(1px, 1px\)/);
});

test('search evidence is transparent and learning actions are compact but easy to tap', () => {
    assert.match(html, /not independently verified/);
    assert.match(html, /AI cross-check/);
    assert.match(html, /No usable web sources/);
    assert.match(html, /Live search unavailable/);
    assert.match(html, /searchInfo\?\.verified === true/);
    assert.match(html, /message\.search \|\| \{\}/);
    assert.match(html, /teach\.type = 'button'; teach\.textContent = 'Quick check'/);
    assert.match(html, /visual\.type = 'button'; visual\.textContent = 'Visualize'/);
    assert.match(html, /\.reply-enhancements button \{[^}]*min-height: 44px/);
    assert.match(html, /\.reply-enhancements button::before \{[^}]*inset: 11px 0;[^}]*box-shadow: none/);
    assert.match(html, /\.followups button \{[^}]*min-height: 44px/);
    assert.match(html, /\.followups button::before \{[^}]*inset: 11px 0/);
    assert.match(html, /\.reply-tools button \{[^}]*width: 44px; height: 44px/);
    assert.match(html, /\.reply-tools button::before \{[^}]*inset: 11px;[^}]*box-shadow: none/);
    assert.match(html, /\.teachback-submit\.btn-ui \{[^}]*min-height: 44px/);
});
