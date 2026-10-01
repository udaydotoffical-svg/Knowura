// Lets browsers treat Knowura as an installable app. It deliberately caches nothing, so pages
// and API calls always go straight to the network and there's never a stale copy to get stuck on.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
