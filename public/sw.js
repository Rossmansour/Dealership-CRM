// sw.js -- Lets phones install DealerDomus to the home screen like an app.
// It doesn't keep copies of pages or data: everything always comes fresh
// from the server, so nobody ever sees an old customer record.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* straight to the network */ });
