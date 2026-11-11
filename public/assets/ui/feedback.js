/* Shared, compact like/dislike reasons and anonymous active-session presence. */
(function () {
    'use strict';
    const REASONS = {
        like: [
            ['clear', 'Clear'], ['accurate', 'Accurate'], ['example', 'Helpful example'],
            ['relevant', 'Relevant'], ['other', 'Other']
        ],
        dislike: [
            ['incorrect', 'Incorrect'], ['unclear', 'Unclear'], ['too_short', 'Too short'],
            ['too_long', 'Too long'], ['off_topic', 'Off topic'], ['other', 'Other']
        ]
    };
    function uuid() {
        if (window.crypto?.randomUUID) return window.crypto.randomUUID();
        const bytes = new Uint8Array(16);
        window.crypto.getRandomValues(bytes);
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
    function node(tag, className, text) {
        const el = document.createElement(tag);
        if (className) el.className = className;
        if (text !== undefined) el.textContent = text;
        return el;
    }
    function createPanel({ onSuccess } = {}) {
        const panel = node('section', 'reply-feedback-panel');
        panel.hidden = true;
        panel.setAttribute('aria-label', 'Answer feedback');
        const title = node('div', 'reply-feedback-title');
        const options = node('div', 'reply-feedback-options');
        options.setAttribute('role', 'group');
        options.setAttribute('aria-label', 'Choose a reason');
        const other = node('textarea', 'reply-feedback-other');
        other.maxLength = 240;
        other.rows = 2;
        other.placeholder = 'Optional note · please avoid personal details';
        other.setAttribute('aria-label', 'Optional feedback note; do not include personal details');
        other.hidden = true;
        const controls = node('div', 'reply-feedback-controls');
        const status = node('span', 'reply-feedback-status');
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        const send = node('button', 'reply-feedback-send', 'Send');
        send.type = 'button';
        send.disabled = true;
        const close = node('button', 'reply-feedback-close', 'Cancel');
        close.type = 'button';
        controls.append(status, close, send);
        panel.append(title, options, other, controls);

        const voteId = uuid();
        let sentiment = null, reason = null, submitted = false;
        function choose(code, button) {
            reason = code;
            options.querySelectorAll('button').forEach((item) => {
                item.setAttribute('aria-pressed', String(item === button));
            });
            other.hidden = code !== 'other';
            send.disabled = false;
            if (code === 'other') other.focus({ preventScroll: true });
        }
        function open(nextSentiment) {
            if (submitted || !REASONS[nextSentiment]) return;
            sentiment = nextSentiment;
            reason = null;
            title.textContent = nextSentiment === 'like' ? 'What made this answer helpful?' : 'What could be better?';
            options.replaceChildren();
            REASONS[nextSentiment].forEach(([code, label]) => {
                const button = node('button', 'reply-feedback-reason', label);
                button.type = 'button';
                button.setAttribute('aria-pressed', 'false');
                button.addEventListener('click', () => choose(code, button));
                options.appendChild(button);
            });
            other.value = '';
            other.hidden = true;
            send.disabled = true;
            status.textContent = '';
            panel.hidden = false;
        }
        close.addEventListener('click', () => { panel.hidden = true; });
        panel.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') panel.hidden = true;
        });
        send.addEventListener('click', async () => {
            if (submitted || !sentiment || !reason) return;
            send.disabled = true;
            close.disabled = true;
            status.textContent = 'Sending…';
            const payload = { action: 'vote', voteId, sentiment, reason };
            if (reason === 'other' && other.value.trim()) payload.text = other.value.trim().slice(0, 240);
            try {
                const response = await fetch('/.netlify/functions/feedback', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const result = await response.json().catch(() => ({}));
                if (!response.ok || !result.accepted) throw new Error(result.error || 'Feedback could not be sent.');
                submitted = true;
                status.textContent = 'Thanks for the feedback.';
                options.querySelectorAll('button').forEach((button) => { button.disabled = true; });
                other.disabled = true;
                close.hidden = true;
                send.hidden = true;
                try { onSuccess?.(sentiment); } catch (e) { /* the vote is already saved */ }
            } catch (error) {
                status.textContent = error?.message || 'Could not send feedback. Try again.';
                send.disabled = false;
                close.disabled = false;
            }
        });
        return { element: panel, open };
    }

    function startPresence() {
        let sessionReady = false;
        let sessionRequest = null;
        let lastActivity = Date.now();
        let lastSend = 0;
        let inFlight = false;
        const touch = () => { lastActivity = Date.now(); };
        async function ensureSession() {
            if (sessionReady) return true;
            if (sessionRequest) return sessionRequest;
            sessionRequest = (async () => {
                const response = await fetch('/.netlify/functions/feedback', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'session' }),
                    credentials: 'same-origin'
                });
                const result = await response.json().catch(() => ({}));
                sessionReady = !!response.ok && result.ok === true;
                return sessionReady;
            })().finally(() => { sessionRequest = null; });
            return sessionRequest;
        }
        ['pointerdown', 'keydown', 'touchstart', 'input'].forEach((eventName) => {
            document.addEventListener(eventName, touch, { passive: true });
        });
        async function ping(action) {
            if (inFlight) return;
            inFlight = true;
            try {
                if (!await ensureSession()) return;
                const response = await fetch('/.netlify/functions/feedback', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action }),
                    credentials: 'same-origin',
                    keepalive: action === 'leave'
                });
                if (response.ok) lastSend = Date.now();
                else if (response.status === 401) sessionReady = false;
            } catch (e) { /* stale sessions expire automatically */ }
            finally { inFlight = false; }
        }
        function update() {
            if (document.visibilityState !== 'visible') { ping('leave'); return; }
            if (Date.now() - lastActivity > 5 * 60 * 1000) return;
            if (Date.now() - lastSend >= 45 * 1000) ping('presence');
        }
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') { touch(); update(); }
            else ping('leave');
        });
        window.addEventListener('pagehide', () => ping('leave'));
        update();
        window.setInterval(update, 30 * 1000);
    }

    window.KnowuraFeedback = Object.freeze({ createPanel, startPresence });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startPresence, { once: true });
    else startPresence();
})();
