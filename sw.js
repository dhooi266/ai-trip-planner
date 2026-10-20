/* AI Trip Planner service worker: keeps the itinerary usable offline.
   - The page itself: network first (so updates show up), cached copy when offline.
   - Own images/icons: cache first.
   - Google Fonts, Wikimedia stop photos, cdnjs: stale-while-revalidate in a runtime cache.
   - Everything else (Google Maps, translation, ElevenLabs) goes straight to the network.
   Bump VERSION whenever the CORE list changes. */
const VERSION = "tripai-v4", RUNTIME = "tripai-runtime";
const CORE = ["./", "./index.html", "./manifest.webmanifest",
  "./img/icons/icon-180.png", "./img/icons/icon-192.png", "./img/icons/icon-512.png", "./img/icons/icon-32.png",
  "./img/hero-portrait.webp", "./img/hero-wide.webp"]
  .concat([1,2,3,4,5,6,7,8].map(n => "./img/day"+n+".webp"))
  .concat([1,2,3,4,5,6,7].map(n => "./img/stay"+n+".webp"));
const RUNTIME_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com", "upload.wikimedia.org", "thumb.wikimedia.org", "cdnjs.cloudflare.com"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith("tripai-") && k !== VERSION && k !== RUNTIME).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const req = e.request; if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    if (req.mode === "navigate" || url.pathname.endsWith("/") || url.pathname.endsWith("index.html")) {
      /* no-cache: always ask the server (it answers 304 when nothing changed), so an update is never hidden by the HTTP cache */
      e.respondWith(fetch(new Request(req.url, {cache:"no-cache", credentials:"same-origin"})).then(res => { if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put("./index.html", copy)); } return res; })
        .catch(() => caches.match("./index.html", {ignoreSearch:true}).then(r => r || caches.match("./"))));
      return;
    }
    e.respondWith(caches.match(req, {ignoreSearch:true}).then(hit => hit || fetch(req).then(res => {
      if (res.ok && url.pathname.includes("/img/")) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
      return res;
    })));
    return;
  }
  if (RUNTIME_HOSTS.includes(url.hostname)) {
    e.respondWith(caches.open(RUNTIME).then(c => c.match(req).then(hit => {
      const net = fetch(req).then(res => { if (res.ok || res.type === "opaque") c.put(req, res.clone()); return res; }).catch(() => hit);
      return hit || net;
    })));
  }
});

/* the page asks us to pre-download the stop photos so they work offline later */
self.addEventListener("message", e => {
  if (!e.data || e.data.type !== "warm" || !Array.isArray(e.data.urls)) return;
  e.waitUntil(caches.open(RUNTIME).then(async c => {
    for (const u of e.data.urls) {
      try { if (!(await c.match(u))) { const res = await fetch(u, {mode:"no-cors"}); await c.put(u, res); } } catch(err) {}
      await new Promise(r => setTimeout(r, 250));
    }
  }));
});
