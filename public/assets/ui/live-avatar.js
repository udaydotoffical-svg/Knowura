(() => {
    'use strict';

    const FRAME_PATH = '/assets/avatar/dot-avatar-live.html?embed=1';
    const STILL_FALLBACK = '/assets/avatar/dot-avatar-fallback.png';
    const STATES = Object.freeze({
        idle: { face: 'happy', mouth: 'smile' },
        listening: { face: 'surprised', mouth: 'o' },
        thinking: { face: 'sleepy', mouth: 'none' },
        speaking: { face: 'happy', mouth: 'grin' },
        ultra: { face: 'starry', mouth: 'o' },
        starting: { face: 'dot', mouth: 'none' },
        muted: { face: 'cool', mouth: 'none' },
        'mic-permission': { face: 'surprised', mouth: 'none' },
        'mic-unavailable': { face: 'teary', mouth: 'none' },
        'text-fallback': { face: 'wink', mouth: 'smile' }
    });

    function init() {
        const panel = document.getElementById('livePanel') || document.getElementById('voiceView');
        const wrap = document.getElementById('orbWrap');
        const fallback = document.getElementById('liveOrb');
        const status = document.getElementById('liveStatus');
        if (!panel || !wrap || !fallback || !status) return;

        let frame = null;
        let ready = false;
        let activeState = 'idle';
        let appliedState = null;
        let loadTimer = 0;
        let generation = 0;
        let activeInstance = null;
        let requestedGifSrc = fallback.getAttribute('src') || '';

        const media = window.matchMedia?.('(prefers-reduced-motion: reduce)') || null;
        const reducedMotion = () => !!media?.matches || document.documentElement.classList.contains('lite');
        const frameViewer = () => {
            try { return frame?.contentWindow?.dotAvatarViewer || null; }
            catch (_) { return null; }
        };
        const sourceFor = (instance) => `${FRAME_PATH}&instance=${encodeURIComponent(instance)}`;

        function setLevel(value) {
            const level = Number(value);
            wrap.style.setProperty('--avatar-level', Number.isFinite(level) ? String(Math.max(0, Math.min(1, level))) : '0');
        }

        function syncFallbackMotion() {
            const source = fallback.getAttribute('src') || '';
            if (reducedMotion()) {
                if (source && source !== STILL_FALLBACK) requestedGifSrc = source;
                if (panel.classList.contains('open') && requestedGifSrc && source !== STILL_FALLBACK) {
                    fallback.setAttribute('src', STILL_FALLBACK);
                }
            } else if (source === STILL_FALLBACK && requestedGifSrc) {
                fallback.setAttribute('src', requestedGifSrc);
            } else if (source && source !== STILL_FALLBACK) {
                requestedGifSrc = source;
            }
        }

        function applyMotionPreference() {
            syncFallbackMotion();
            const viewer = ready ? frameViewer() : null;
            if (!viewer || typeof viewer.setReducedMotion !== 'function') return;
            try { viewer.setReducedMotion(reducedMotion()); }
            catch (error) { console.warn('3D avatar motion preference could not be applied:', error); }
        }

        function applyState() {
            const viewer = ready ? frameViewer() : null;
            const expression = STATES[activeState];
            if (!viewer || !expression || typeof viewer.setExpression !== 'function' || appliedState === activeState) return;
            try {
                viewer.setExpression(expression.face, expression.mouth, activeState);
                appliedState = activeState;
            } catch (error) {
                console.warn('3D avatar expression could not be applied:', error);
            }
        }

        function setState(state) {
            if (!Object.prototype.hasOwnProperty.call(STATES, state)) return;
            activeState = state;
            wrap.dataset.avatarState = state;
            if (state !== 'listening') setLevel(0);
            applyState();
        }

        function inferState() {
            const message = (status.textContent || '').trim().toLowerCase();
            const src = (() => {
                try { return new URL(fallback.currentSrc || fallback.src, location.href).pathname.toLowerCase(); }
                catch (_) { return ''; }
            })();
            const ultraOn = wrap.classList.contains('ultra');

            if (/mic(?:rophone)? (?:permission|needed|blocked|access|denied|required)|waiting for you to allow|\bpermission\b/.test(message)) return 'mic-permission';
            if (/mic(?:rophone)? (?:unavailable|didn't start|did not start|busy)|couldn't start the microphone|no microphone|device not found|unavailable/.test(message)) return 'mic-unavailable';
            if (/text fallback|text mode|showing text|continue by typing/.test(message)) return 'text-fallback';
            if (/\bmuted\b/.test(message)) return 'muted';
            if (/starting|connecting/.test(message)) return 'starting';
            if (src.includes('starting-ai')) return 'starting';
            if (src.includes('ultra-thinking-mode')) return 'ultra';
            if (/call ended|\bready\b/.test(message)) return 'idle';
            if (/speaking/.test(message)) return 'speaking';
            if (/ultra/.test(message)) return 'ultra';
            if (/thinking|generating voice/.test(message)) return ultraOn ? 'ultra' : 'thinking';
            if (/listening/.test(message)) return ultraOn ? 'ultra' : 'listening';
            if (src.includes('normal-thinking')) return ultraOn ? 'ultra' : 'thinking';
            if (ultraOn) return 'ultra';
            if (src.includes('attentif')) return 'listening';
            if (wrap.classList.contains('listening')) return 'listening';
            return 'idle';
        }

        function refreshState() {
            setState(inferState());
        }

        function createFrame() {
            if (frame) return frame;
            frame = document.createElement('iframe');
            frame.id = 'liveAvatarFrame';
            frame.className = 'live-avatar-frame';
            frame.title = 'Three-dimensional Dot voice avatar';
            frame.tabIndex = -1;
            frame.loading = 'eager';
            frame.referrerPolicy = 'same-origin';
            frame.setAttribute('aria-hidden', 'true');
            wrap.insertBefore(frame, fallback);
            return frame;
        }

        function loadAvatar() {
            if (!panel.classList.contains('open')) return;
            syncFallbackMotion();
            const target = createFrame();
            refreshState();
            if (activeInstance && target.getAttribute('src') === sourceFor(activeInstance) && (ready || loadTimer)) return;

            const instance = String(++generation);
            activeInstance = instance;
            ready = false;
            appliedState = null;
            wrap.classList.remove('dot-avatar-ready', 'dot-avatar-failed');
            target.src = sourceFor(instance);
            window.clearTimeout(loadTimer);
            loadTimer = window.setTimeout(() => {
                if (activeInstance !== instance || ready || !panel.classList.contains('open')) return;
                activeInstance = null;
                generation++;
                loadTimer = 0;
                wrap.classList.add('dot-avatar-failed');
                target.removeAttribute('src');
            }, 20000);
        }

        function unloadAvatar() {
            window.clearTimeout(loadTimer);
            loadTimer = 0;
            generation++;
            activeInstance = null;
            if (frame) {
                const viewer = frameViewer();
                try { viewer?.dispose?.(); }
                catch (error) { console.warn('3D avatar cleanup failed:', error); }
                frame.removeAttribute('src');
            }
            ready = false;
            appliedState = null;
            setLevel(0);
            wrap.classList.remove('dot-avatar-ready', 'dot-avatar-failed');
        }

        window.addEventListener('message', (event) => {
            if (!frame || event.source !== frame.contentWindow || event.origin !== location.origin) return;
            if (!panel.classList.contains('open') || !activeInstance || event.data?.instance !== activeInstance) return;
            if (event.data?.type !== 'knowura-live-avatar-ready') return;
            window.clearTimeout(loadTimer);
            loadTimer = 0;
            if (!event.data.ok || !frameViewer()) {
                activeInstance = null;
                generation++;
                ready = false;
                wrap.classList.remove('dot-avatar-ready');
                wrap.classList.add('dot-avatar-failed');
                frame.removeAttribute('src');
                return;
            }
            ready = true;
            appliedState = null;
            wrap.classList.remove('dot-avatar-failed');
            wrap.classList.add('dot-avatar-ready');
            refreshState();
            applyState();
            applyMotionPreference();
        });

        const stateObserver = new MutationObserver(refreshState);
        stateObserver.observe(status, { childList: true, characterData: true, subtree: true });
        stateObserver.observe(wrap, { attributes: true, attributeFilter: ['class'] });
        const fallbackObserver = new MutationObserver(() => {
            syncFallbackMotion();
            refreshState();
        });
        fallbackObserver.observe(fallback, { attributes: true, attributeFilter: ['src'] });
        const panelObserver = new MutationObserver(() => {
            if (panel.classList.contains('open')) loadAvatar();
            else unloadAvatar();
        });
        panelObserver.observe(panel, { attributes: true, attributeFilter: ['class'] });
        const motionObserver = new MutationObserver(applyMotionPreference);
        motionObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
        if (media?.addEventListener) media.addEventListener('change', applyMotionPreference);
        else media?.addListener?.(applyMotionPreference);

        window.KnowuraLiveAvatar = Object.freeze({
            setState,
            setLevel,
            getState: () => activeState,
            getLevel: () => Number(wrap.style.getPropertyValue('--avatar-level') || 0),
            isReady: () => ready,
            states: Object.freeze(Object.keys(STATES))
        });
        if (panel.classList.contains('open')) loadAvatar();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
})();
