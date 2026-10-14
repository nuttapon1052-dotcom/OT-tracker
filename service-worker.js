var CACHE_NAME = "ot-tracker-cache-v25";
var APP_SHELL = [
  "./",
  "./index.html",
  "./css/style.css",
  "./js/app.js",
  "./js/i18n.js",
  "./js/i18n-catalog.js",
  "./css/i18n.css",
  "./js/static-holidays.js",
  "./js/holiday-names-th.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-512-maskable.png",
  "./icons/apple-touch-icon.png"
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(APP_SHELL);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (key) { return key !== CACHE_NAME; })
            .map(function (key) { return caches.delete(key); })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

// Network-first for everything in the app shell (HTML/CSS/JS), so a fresh
// deploy is always picked up on the next load when online. Cache is only a
// fallback for offline use - it is kept up to date on every successful
// fetch instead of being trusted as the source of truth. This matters a lot
// more than raw speed for a small app like this: silently serving a stale
// app.js forever (the old cache-first behavior) is a much worse bug than a
// network round-trip on each load.
self.addEventListener("fetch", function (event) {
  var req = event.request;
  if (req.method !== "GET") return;

  event.respondWith(
    fetch(req).then(function (res) {
      if (res && res.status === 200 && res.type === "basic") {
        var copy = res.clone();
        caches.open(CACHE_NAME).then(function (cache) { cache.put(req, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(req).then(function (cached) {
        return cached || (req.mode === "navigate" ? caches.match("./index.html") : undefined);
      });
    })
  );
});

// Web Push - stage 1 (infrastructure only, no server sends a push yet).
// Payload shape isn't final, so fall back to sane defaults instead of
// throwing once a real push does arrive.
self.addEventListener("push", function (event) {
  var data = {};
  if (event.data) {
    try { data = event.data.json(); } catch (e) { data = { body: event.data.text() }; }
  }

  var title = data.title || "OT Fast";
  var options = {
    body: data.body || "",
    icon: "./icons/icon-192.png",
    badge: "./icons/icon-192.png",
    data: data.url ? { url: data.url } : {},
    // ยุบ push ที่ซ้ำ (เช่น device เดียวกันมี subscription endpoint ค้างมากกว่า 1
    // อัน) ให้เหลือ notification เดียวแทนที่จะโชว์ซ้อนกัน 2 อัน
    tag: data.tag || title
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();

  var url = (event.notification.data && event.notification.data.url) || "./";

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (clientList) {
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if ("focus" in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
