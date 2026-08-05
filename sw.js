// Service Worker do PyWebIDE
// Estratégia:
//  - App shell (arquivos do próprio repositório): cache-first, com atualização em segundo plano.
//  - Recursos de CDN (Monaco, Pyodide e seus pacotes .whl): cache-first "para sempre",
//    pois são arquivos versionados e imutáveis — uma vez baixados, funcionam 100% offline.

const APP_CACHE = "pywebide-app-v1";
const CDN_CACHE = "pywebide-cdn-v1";

const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(APP_CACHE).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== APP_CACHE && k !== CDN_CACHE)
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

function isCdnRequest(url) {
  return (
    url.hostname.includes("jsdelivr.net") ||
    url.hostname.includes("cdn.jsdelivr.net") ||
    url.hostname.includes("unpkg.com") ||
    url.hostname.includes("pyodide")
  );
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Recursos de CDN (Monaco / Pyodide / pacotes): cache-first permanente
  if (isCdnRequest(url)) {
    event.respondWith(
      caches.open(CDN_CACHE).then(async (cache) => {
        const cached = await cache.match(event.request);
        if (cached) return cached;
        try {
          const response = await fetch(event.request);
          if (response && response.status === 200) {
            cache.put(event.request, response.clone());
          }
          return response;
        } catch (err) {
          if (cached) return cached;
          throw err;
        }
      })
    );
    return;
  }

  // App shell: cache-first, atualizando em segundo plano quando há rede
  if (event.request.method === "GET" && url.origin === self.location.origin) {
    event.respondWith(
      caches.open(APP_CACHE).then(async (cache) => {
        const cached = await cache.match(event.request);
        const networkFetch = fetch(event.request)
          .then((response) => {
            if (response && response.status === 200) {
              cache.put(event.request, response.clone());
            }
            return response;
          })
          .catch(() => null);
        return cached || (await networkFetch) || cached;
      })
    );
  }
});
