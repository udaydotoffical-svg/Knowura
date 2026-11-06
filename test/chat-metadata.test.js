const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const source = name => {
    const match = html.match(new RegExp(`(?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?\\n    \\}`));
    assert.ok(match, `actual app function ${name} exists`);
    return match[0];
};

// Only the editor's DOM boundary is stubbed. The actual async generator, edit
// handlers, hero synchronization, whole-record merge and 409 retry run below.
function harness({ fetchImpl, now = 1000, updatedAt = 100 } = {}) {
    const chat = {
        id: 'c_metadata', title: 'Original title', titleReady: true,
        subject: '', subjectReady: false, createdAt: 1, updatedAt,
        messages: [{ type: 'user', text: 'Question' }, { type: 'ai', text: 'Answer' }]
    };
    const chatStore = { chats: [chat], activeChatId: chat.id };
    const saves = [];
    const inputs = new Map();
    const buttons = new Map();
    const labels = new Map();
    const fieldIds = ['chatTopicHeroTitleText', 'chatTopicHeroSubject'];
    let sidebarInput;
    const document = { activeElement: null };
    const makeLabel = id => ({
        textContent: id === 'chatTopicHeroTitleText' ? chat.title : (chat.subject || 'Add subject'),
        classList: { toggle(name, enabled) { this[name] = !!enabled; } },
        closest: () => buttons.get(id)
    });
    const makeButton = id => ({
        isConnected: true,
        attributes: {},
        setAttribute(name, value) { this.attributes[name] = String(value); },
        focus() { document.activeElement = this; },
        replaceWith(input) {
            this.isConnected = false;
            input.isConnected = true;
            inputs.set(id, input);
        }
    });
    const hero = {
        removed: false,
        get rendered() {
            return JSON.stringify({
                title: labels.get('chatTopicHeroTitleText')?.textContent,
                subject: labels.get('chatTopicHeroSubject')?.textContent
            });
        },
        classList: { toggle(name, enabled) { this[name] = !!enabled; } },
        querySelector: () => [...inputs.values()].find(input => input.isConnected) || null,
        remove() { this.removed = true; }
    };
    const box = { querySelector: () => hero };
    Object.assign(document, {
        getElementById: id => id === 'chat-box' ? box : inputs.get(id)?.isConnected ? inputs.get(id) : labels.get(id),
        querySelector: () => ({ replaceWith(input) { sidebarInput = input; input.isConnected = true; } }),
        createElement() {
            const handlers = {};
            const input = {
                value: '', id: '', isConnected: false, attributes: {},
                setAttribute(name, value) { this.attributes[name] = String(value); },
                getAttribute(name) { return this.attributes[name] ?? null; },
                addEventListener(name, callback) { (handlers[name] ||= []).push(callback); },
                dispatch(name, event = {}) { for (const callback of handlers[name] || []) callback(event); },
                press(key) {
                    const event = { key, defaultPrevented: false, propagationStopped: false,
                        preventDefault() { this.defaultPrevented = true; },
                        stopPropagation() { this.propagationStopped = true; } };
                    this.dispatch('keydown', event);
                    this.lastKeyEvent = event;
                },
                focus() { document.activeElement = this; },
                select() { this.selectionStart = 0; this.selectionEnd = this.value.length; },
                blur(nextTarget = null) { document.activeElement = nextTarget; this.dispatch('blur', { relatedTarget: nextTarget }); },
                replaceWith(button) {
                    this.isConnected = false;
                    if (button) {
                        button.isConnected = true;
                        buttons.set(this.id, button);
                        labels.set(this.id, makeLabel(this.id));
                    }
                }
            };
            return input;
        }
    });
    for (const id of fieldIds) {
        buttons.set(id, makeButton(id));
        labels.set(id, makeLabel(id));
    }
    const functions = [
        'parseGeneratedChatMetadata', 'generateChatTitle', 'chatTopicHeroTitle',
        'chatTopicHeroSubject', 'chatTopicHeroIsLong', 'chatTopicHeroReady',
        'syncChatTopicHeroTitle', 'editChatTopicField', 'renameChat', 'mergeChats', 'persistCloudStore'
    ].map(source).join('\n');
    const api = new Function('document', 'chatStore', 'fetch', 'Date', 'saveChatStore', 'renderChatList', `
        const incognito = false, ownerToken = '', userToken = 'test-token', userSub = 'test-user';
        const userProfile = { sub: userSub };
        let cloudBaseUpdatedAt = 10, cloudLoadFailed = false, cloudMemory = { summary: '', facts: [] };
        function isCloudUser() { return true; }
        function getActiveChat() { return chatStore.chats.find(c => c.id === chatStore.activeChatId); }
        function renderChatTopicHero(chat) { return JSON.stringify({ title: chat.title, subject: chat.subject }); }
        ${functions}
        return { generateChatTitle, editChatTopicField, renameChat, persistCloudStore };
    `)(document, chatStore, fetchImpl, { now: () => now },
        () => saves.push(JSON.parse(JSON.stringify(chatStore.chats[0]))), () => {});
    return { ...api, chat, chatStore, saves, hero, document,
        input: field => inputs.get(field === 'title' ? 'chatTopicHeroTitleText' : 'chatTopicHeroSubject'),
        button: field => buttons.get(field === 'title' ? 'chatTopicHeroTitleText' : 'chatTopicHeroSubject'),
        sidebarInput: () => sidebarInput };
}

for (const field of ['title', 'subject']) {
    test(`AI metadata arriving before ${field} blur preserves the live editor and unsaved draft`, async () => {
        let release;
        const h = harness({ fetchImpl: () => new Promise(resolve => {
            release = () => resolve({ json: async () => ({ choices: [{ message: {
                content: '{"title":"Generated summary","subject":"Generated topic"}'
            } }] }) });
        }) });
        const pending = h.generateChatTitle(h.chat.id, 'Question', 'Answer');
        h.editChatTopicField(field);
        const input = h.input(field);
        input.value = `Unsaved ${field} draft`;
        input.selectionStart = 2;
        input.selectionEnd = 7;
        release();
        await pending;
        assert.equal(h.chat.subject, 'Generated topic', 'AI really updated metadata before blur');
        assert.equal(input.isConnected, true, 'hero synchronization must not replace the editor');
        assert.equal(h.input(field), input, 'preserve the same input node');
        assert.equal(h.document.activeElement, input, 'focus stays with the draft');
        assert.equal(input.value, `Unsaved ${field} draft`);
        assert.deepEqual([input.selectionStart, input.selectionEnd], [2, 7], 'selection survives synchronization');
        input.blur();
        assert.equal(h.chat[field], `Unsaved ${field} draft`, 'blur saves the surviving draft');
        assert.equal(h.saves.at(-1)[field], `Unsaved ${field} draft`);
        assert.equal(input.isConnected, false, 'the editor closes normally after blur');
        assert.equal(JSON.parse(h.hero.rendered)[field], `Unsaved ${field} draft`, 'deferred hero refresh runs after editor closes');
    });
}

test('rendered title and subject edit controls include their visible values in accessible names', () => {
    const renderSource = source('renderChatTopicHero');
    const render = new Function('chatTopicHeroReady', 'chatTopicHeroTitle', 'chatTopicHeroSubject', 'chatTopicHeroIsLong', 'escapeHtml',
        `${renderSource}; return renderChatTopicHero;`)(() => true, chat => chat.title, chat => chat.subject,
        () => false, value => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
    const markup = render({ title: 'Study of black holes', subject: 'Space & Physics' });
    assert.match(markup, /aria-label="Edit conversation title: Study of black holes"/);
    assert.match(markup, /aria-label="Edit conversation subject: Space &amp; Physics"/);
    assert.doesNotMatch(markup, /aria-label="Edit conversation title"(?:\s|>)/,
        'a generic aria-label must not mask the visible title');
    assert.doesNotMatch(markup, /aria-label="Edit conversation subject"(?:\s|>)/,
        'a generic aria-label must not mask the visible subject');
});

test('hero edit controls and live inputs expose the current title and subject accessibly', () => {
    for (const field of ['title', 'subject']) {
        const h = harness();
        h.editChatTopicField(field);
        const input = h.input(field);
        const label = field === 'title' ? 'Conversation title' : 'Conversation subject';
        const initialValue = field === 'title' ? 'Original title' : 'Add subject';
        assert.equal(input.getAttribute('aria-label'), `${label}: ${initialValue}`,
            `${field} input name identifies its current value`);
        input.value = `Current ${field} value`;
        input.dispatch('input');
        assert.equal(input.getAttribute('aria-label'), `${label}: Current ${field} value`,
            `${field} input name tracks the visible edit value`);
        input.press('Escape');
    }
});

for (const field of ['title', 'subject']) {
    for (const key of ['Enter', 'Escape']) {
        test(`pressing ${key} in the ${field} editor restores focus to its edit control`, () => {
            const h = harness();
            const original = h.chat[field];
            const value = `Keyboard ${field} draft`;
            h.editChatTopicField(field);
            const input = h.input(field);
            input.value = value;
            input.dispatch('input');
            input.press(key);
            assert.equal(input.lastKeyEvent.defaultPrevented, true);
            assert.equal(input.lastKeyEvent.propagationStopped, true);
            assert.equal(h.document.activeElement, h.button(field), 'focus returns to the re-rendered field control');
            assert.equal(h.chat[field], key === 'Enter' ? value : original,
                key === 'Enter' ? 'Enter commits the draft' : 'Escape cancels the draft');
            assert.equal(input.isConnected, false, 'the inline editor closes after either key');
            assert.equal(h.saves.length, key === 'Enter' ? 1 : 0,
                key === 'Enter' ? 'committed values are persisted' : 'cancelled values are not saved');
        });
    }
}

for (const [field, destination] of [['subject', 'title'], ['title', 'subject']]) {
    test(`ordinary Tab navigation from the ${field} editor preserves focus on the ${destination} control`, () => {
        const h = harness();
        h.editChatTopicField(field);
        const input = h.input(field);
        input.value = `Tab ${field} draft`;
        const nextControl = h.button(destination);
        input.blur(nextControl);
        assert.equal(h.chat[field], `Tab ${field} draft`, 'ordinary blur commits the current draft');
        assert.equal(h.document.activeElement, nextControl, 'the browser-selected next/previous control remains focused');
        assert.notEqual(h.document.activeElement, h.button(field), 'ordinary Tab never pulls focus back to the editor control');
    });
}

test('clicking outside an inline editor commits it without restoring focus to an editor control', () => {
    const h = harness();
    h.editChatTopicField('subject');
    const input = h.input('subject');
    input.value = 'Clicked away';
    const outsideControl = { name: 'user-input' };
    input.blur(outsideControl);
    assert.equal(h.chat.subject, 'Clicked away', 'outside blur commits the subject');
    assert.equal(h.document.activeElement, outsideControl, 'focus stays at the outside click target');
});

for (const edit of ['hero title', 'hero subject', 'sidebar title', 'AI metadata']) {
    test(`${edit} advances updatedAt before save and survives a same-chat 409 cloud conflict`, async () => {
        const requests = [];
        let remote;
        const h = harness({ fetchImpl: async (url, options) => {
            if (url.endsWith('/ask-ai')) return { json: async () => ({ choices: [{ message: {
                content: '{"title":"Generated summary","subject":"Generated topic"}'
            } }] }) };
            requests.push(JSON.parse(options.body));
            return requests.length === 1
                ? { status: 409, ok: false, json: async () => ({ doc: remote }) }
                : { status: 200, ok: true, json: async () => ({ updatedAt: 2000 }) };
        } });
        remote = { updatedAt: 700, chats: [{ ...JSON.parse(JSON.stringify(h.chat)), updatedAt: 200 }] };
        if (edit === 'AI metadata') {
            h.chat.titleReady = false;
            await h.generateChatTitle(h.chat.id, 'Question', 'Answer');
        } else if (edit === 'sidebar title') {
            h.renameChat(h.chat.id);
            h.sidebarInput().value = 'User title';
            h.sidebarInput().blur();
        } else {
            const field = edit.split(' ')[1];
            h.editChatTopicField(field);
            h.input(field).value = `User ${field}`;
            h.input(field).blur();
        }
        const expected = JSON.parse(JSON.stringify(h.chat));
        assert.equal(h.saves.length, 1);
        assert.equal(h.saves[0].updatedAt, 1000, 'the chat timestamp must advance before persistence is scheduled');
        await h.persistCloudStore();
        assert.equal(requests.length, 2, 'exercise actual conflict merge and retry');
        assert.equal(requests[1].baseUpdatedAt, 700);
        for (const request of requests) assert.deepEqual(request.doc.chats[0], expected,
            'both title and subject, readiness flags and updatedAt survive on the initial write and merged retry');
        assert.deepEqual(h.chatStore.chats[0], expected, 'stale same-chat remote metadata cannot replace the local record');
    });
}

for (const edit of ['title', 'subject', 'sidebar', 'AI']) {
    test(`${edit} metadata update strictly bumps same-tick or future chat timestamps`, async () => {
        const h = harness({ now: 4000, updatedAt: 5000, fetchImpl: async () => ({ json: async () => ({ choices: [{ message: {
            content: '{"title":"Generated summary","subject":"Generated topic"}'
        } }] }) }) });
        if (edit === 'AI') {
            h.chat.titleReady = false;
            await h.generateChatTitle(h.chat.id, 'Question', 'Answer');
        } else if (edit === 'sidebar') {
            h.renameChat(h.chat.id);
            h.sidebarInput().value = 'User title';
            h.sidebarInput().blur();
        } else {
            h.editChatTopicField(edit);
            h.input(edit).value = `User ${edit}`;
            h.input(edit).blur();
        }
        assert.equal(h.saves[0].updatedAt, 5001, 'a metadata edit never keeps or decreases its previous version');
    });
}

test('metadata parser rejects identical title and subject after normalization and truncation', () => {
    const parse = new Function(`${source('parseGeneratedChatMetadata')}; return parseGeneratedChatMetadata;`)();
    for (const [title, subject] of [
        ['Ocean currents', 'Ocean currents'],
        ['Ocean currents.', '  OCEAN   CURRENTS! '],
        ['T'.repeat(48) + ' title suffix', 'T'.repeat(48) + ' subject suffix']
    ]) assert.equal(parse(JSON.stringify({ title, subject })), null, 'duplicate labels are not accepted as distinct metadata');
    assert.deepEqual(parse('{"title":"How currents shape climate","subject":"Ocean currents"}'), {
        title: 'How currents shape climate', subject: 'Ocean currents'
    });
});
