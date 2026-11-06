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
    const VOICE_HAPTICS = Object.freeze({
        'listening-start': [9],
        'speech-start': [12, 22, 8],
        'speech-end': [7],
        interrupt: [17, 28, 8]
    });
    let lastVoiceHaptic = 0;

    function hapticEvent(name) {
        const pattern = VOICE_HAPTICS[name];
        const navigator = window.navigator;
        if (!pattern || typeof navigator?.vibrate !== 'function') return false;
        if (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) return false;
        let preference = 'on';
        try {
            preference = JSON.parse(window.localStorage?.getItem('knowura_settings') || '{}').haptics || 'on';
        } catch (_) { /* unavailable storage keeps the default, optional cue */ }
        if (preference === 'off' || (navigator.userActivation && !navigator.userActivation.hasBeenActive)) return false;
        const now = window.performance?.now?.() ?? Date.now();
        if (now - lastVoiceHaptic < 70) return false;
        const pulse = preference === 'max'
            ? pattern.map((duration, index) => index % 2 === 0 ? Math.round(duration * 2.4) : duration)
            : pattern;
        try {
            const played = navigator.vibrate(pulse);
            if (played === false) return false;
            lastVoiceHaptic = now;
            return true;
        } catch (_) { return false; }
    }

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
        let speechLevel = 0;

        const media = window.matchMedia?.('(prefers-reduced-motion: reduce)') || null;
        const reducedMotion = () => !!media?.matches;
        const performanceLite = () => document.documentElement.classList.contains('lite');
        const fallbackMotionReduced = () => reducedMotion() || performanceLite();
        const frameViewer = () => {
            try { return frame?.contentWindow?.dotAvatarViewer || null; }
            catch (_) { return null; }
        };
        const sourceFor = (instance) => `${FRAME_PATH}&instance=${encodeURIComponent(instance)}`;

        function setLevel(value) {
            const level = Number(value);
            wrap.style.setProperty('--avatar-level', Number.isFinite(level) ? String(Math.max(0, Math.min(1, level))) : '0');
        }

    function setSpeechLevel(value) {
        const level = Number(value);
        speechLevel = activeState === 'speaking' && !reducedMotion() && Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0;
        const viewer = ready ? frameViewer() : null;
        try { viewer?.setSpeechLevel?.(speechLevel); }
        catch (error) { console.warn('Speech level could not be applied to Dot:', error); }
    }

    function attachSpeechAudio(audio, suppliedContext, onLevel) {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!audio || (!suppliedContext && !AudioContext)) return null;
        let context = suppliedContext || null;
        const ownsContext = !context;
        let source = null, analyser = null, raf = 0, active = true;
        let startListener = null, stopListener = null;
        const closeOwnedContext = () => {
            if (!ownsContext) return;
            try { Promise.resolve(context?.close?.()).catch(() => {}); }
            catch (_) { /* context may already be closed */ }
        };
        const reportLevel = (value) => {
            setSpeechLevel(value);
            try { onLevel?.(value); }
            catch (error) { console.warn('Speech level callback failed:', error); }
        };
        const removeListeners = () => {
            if (!startListener && !stopListener) return;
            try {
                if (startListener) {
                    audio.removeEventListener('play', startListener);
                    audio.removeEventListener('playing', startListener);
                }
                if (stopListener) {
                    audio.removeEventListener('ended', stopListener);
                    audio.removeEventListener('error', stopListener);
                }
            } catch (_) { /* partially installed or already removed */ }
        };
        try {
            if (!context) context = new AudioContext();
            // Creating a MediaElementAudioSourceNode diverts audio through Web Audio.
            // Do not capture the element unless its context is already running: an
            // asynchronous/blocked resume can otherwise silence direct TTS playback.
            if (context.state !== 'running') {
                closeOwnedContext();
                return null;
            }
            source = context.createMediaElementSource(audio);
            analyser = context.createAnalyser();
            analyser.fftSize = 512;
            analyser.smoothingTimeConstant = 0.18;
            source.connect(analyser);
                analyser.connect(context.destination);
                const samples = new Uint8Array(analyser.fftSize);
                const tick = () => {
                raf = 0;
                if (!active || audio.paused || audio.ended) {
                    reportLevel(0);
                    return;
                }
                analyser.getByteTimeDomainData(samples);
                let sum = 0;
                for (let i = 0; i < samples.length; i++) {
                        const sample = (samples[i] - 128) / 128;
                    sum += sample * sample;
                }
                const rms = Math.sqrt(sum / samples.length);
                reportLevel(rms);
                raf = window.requestAnimationFrame(tick);
            };
            const start = () => { if (active && !raf) tick(); };
            const stopLevel = () => { reportLevel(0); };
            startListener = start;
            stopListener = stopLevel;
            audio.addEventListener('play', start);
            audio.addEventListener('playing', start);
            audio.addEventListener('ended', stopLevel);
            audio.addEventListener('error', stopLevel);
            if (!audio.paused && !audio.ended) start();
                return () => {
                    if (!active) return;
                active = false;
                if (raf) window.cancelAnimationFrame(raf);
                removeListeners();
                reportLevel(0);
                try { source.disconnect(); analyser.disconnect(); } catch (_) { /* already disconnected */ }
                closeOwnedContext();
            };
        } catch (error) {
            active = false;
            if (raf) window.cancelAnimationFrame(raf);
            removeListeners();
            try { analyser?.disconnect(); } catch (_) { /* partial setup */ }
            try { source?.disconnect(); } catch (_) { /* partial setup */ }
            reportLevel(0);
            if (source && context?.destination) {
                try {
                    // Once captured, the element no longer has its native output
                    // route. If analysis fails, reconnect it directly so playback
                    // remains audible without the analyser.
                    source.connect(context.destination);
                    console.warn('Speech analyser unavailable; direct playback routing retained:', error);
                    return () => {
                        try { source.disconnect(); } catch (_) { /* already disconnected */ }
                        closeOwnedContext();
                    };
                } catch (fallbackError) {
                    console.warn('Direct playback routing fallback failed:', fallbackError);
                }
            }
            closeOwnedContext();
            setSpeechLevel(0);
            console.warn('Speech audio analysis unavailable:', error);
            return null;
        }
    }

    function syncFallbackMotion() {
        const source = fallback.getAttribute('src') || '';
            if (fallbackMotionReduced()) {
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
            const reduceMotion = reducedMotion();
            if (reduceMotion) setSpeechLevel(0);
            try { viewer.setReducedMotion(reduceMotion); }
            catch (error) { console.warn('3D avatar motion preference could not be applied:', error); }
            try { viewer.setPerformanceLite?.(performanceLite()); }
            catch (error) { console.warn('3D avatar performance mode could not be applied:', error); }
        }

        function applyState() {
            const viewer = ready ? frameViewer() : null;
            const expression = STATES[activeState];
            if (!viewer || !expression || typeof viewer.setExpression !== 'function' || appliedState === activeState) return;
            try {
                viewer.setExpression(expression.face, expression.mouth, activeState);
                viewer.setSpeechLevel?.(activeState === 'speaking' ? speechLevel : 0);
                appliedState = activeState;
            } catch (error) {
                console.warn('3D avatar expression could not be applied:', error);
            }
        }

        function setState(state) {
            if (!Object.prototype.hasOwnProperty.call(STATES, state)) return;
            activeState = state;
            wrap.dataset.avatarState = state;
            if (state !== 'speaking') setSpeechLevel(0);
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
            ready = false;
            appliedState = null;
            wrap.classList.remove('dot-avatar-ready', 'dot-avatar-failed');
            if (activeState === 'speaking') hapticEvent('interrupt');
            if (frame) {
                const viewer = frameViewer();
                try { viewer?.dispose?.(); }
                catch (error) { console.warn('3D avatar cleanup failed:', error); }
                frame.removeAttribute('src');
            }
            setLevel(0);
            setSpeechLevel(0);
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
            refreshState();
            applyState();
            applyMotionPreference();
            wrap.classList.remove('dot-avatar-failed');
            wrap.classList.add('dot-avatar-ready');
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
            setSpeechLevel,
            attachSpeechAudio,
            hapticEvent,
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
