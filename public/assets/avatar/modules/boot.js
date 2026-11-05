import * as THREE from './three.module.js';
import * as catalog from './catalog.js';
import * as sdf from './sdf.js';
import * as mesher from './mesher.js';
import * as materials from './materials.js';
import * as face from './face.js';
import * as accessories from './accessories.js';
import * as scene from './scene.js';
import * as viewerModule from './viewer.js';

const message = document.getElementById('da-msg');
const instance = new URLSearchParams(location.search).get('instance');
function announce(ok) {
    if (window.parent === window) return;
    window.parent.postMessage({ type: 'knowura-live-avatar-ready', ok: !!ok, instance }, window.location.origin);
}

try {
    const state = JSON.parse(document.getElementById('da-state').textContent);
    const mods = { catalog, sdf, mesher, materials, face, accessories, scene, viewer: viewerModule };
    const viewer = await viewerModule.start(THREE, mods, state);
    const canvas = viewer?.renderer?.domElement;
    if (canvas) {
        canvas.tabIndex = -1;
        canvas.setAttribute('aria-hidden', 'true');
        canvas.style.pointerEvents = 'none';
    }
    window.dotAvatarViewer = viewer;
    window.dispatchEvent(new CustomEvent('dot-avatar-ready', { detail: viewer }));
    announce(!!viewer);
} catch (error) {
    if (message) {
        message.textContent = "This file couldn't start the 3D viewer in this browser. Try a current version of Chrome, Edge, Firefox or Safari.";
        message.hidden = false;
    }
    console.error(error);
    announce(false);
}
