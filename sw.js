// Pairfolio SW — 앱 셸만 캐시. Supabase/환율 API 응답은 절대 캐시하지 않음.
const CACHE = "pairfolio-v2.0";
const SHELL = ["./", "./index.html", "./style.css", "./app.js", "./config.js", "./manifest.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
// 네트워크 우선, 실패(오프라인) 시 캐시 — 새 버전이 재실행 한 번에 반영됨
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;           // API·CDN·폰트는 네트워크 직행
  if (e.request.method !== "GET") return;
  e.respondWith(
    // no-cache: GitHub Pages의 10분 HTTP 캐시를 건너뛰고 매번 서버에 재확인(304면 공짜)
    fetch(e.request, { cache: "no-cache" }).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request))
  );
});
