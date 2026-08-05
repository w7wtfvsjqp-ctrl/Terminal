// Service Worker do PyWebIDE
// Estratégia:
//  - Navegação (o próprio index.html): cache-first com atualização em segundo
//    plano, MAS também injeta os cabeçalhos Cross-Origin-Opener-Policy e
//    Cross-Origin-Embedder-Policy (modo "require-corp") na resposta. Isso é
//    o que permite à página virar "cross-origin isolated" e liberar
//    SharedArrayBuffer + Atomics.wait no worker.js — necessário pro input()
//    inline no terminal funcionar sem popup. Hospedagens estáticas (GitHub
//    Pages) não deixam configurar cabeçalhos HTTP de verdade, então é isso
//    ou nada. Usamos "require-corp" (não "credentialless") porque é o modo
//    que o Safari/iOS suporta de forma confiável e que o jsDelivr já atende
//    nativamente (manda Cross-Origin-Resource-Policy: cross-origin).
//  - worker.js (o script do Worker do Pyodide): PRECISA receber os MESMOS
//    cabeçalhos COOP/COEP na resposta. A spec exige que, quando o documento
//    principal usa COEP: require-corp, qualquer worker script carregado por
//    ele também precisa vir com COEP: require-corp — senão o worker nasce
//    SEM isolamento (self.crossOriginIsolated === false dentro dele), mesmo
//    que a janela principal esteja isolada. Era essa a causa do input()
//    cair no fallback de "isolamento indisponível" mesmo com o SW ativo.
//  - App shell (demais arquivos do próprio repositório): cache-first, com
//    atualização em segundo plano.
//  - Recursos de CDN (Monaco, Pyodide e seus pacotes .whl): cache-first
//    "para sempre", pois são arquivos versionados e imutáveis — uma vez
//    baixados, funcionam 100% offline.

const APP_CACHE = "pywebide-app-v3";
const CDN_CACHE = "pywebide-cdn-v1";

const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./worker.js",
  "./icon-192.png",
  "./icon-512.png"
];

function withIsolationHeaders(response) {
  if (!response || response.status === 0) return response; // opaco: não mexe
  const headers = new Headers(response.headers);
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// Requisições que PRECISAM sair com os cabeçalhos de isolamento:
// - a navegação (documento principal)
// - o script do worker (worker.js), que é buscado com destination
//   "worker" pelo new Worker("worker.js")
function needsIsolationHeaders(request) {
  return (
    request.mode === "navigate" ||
    request.destination === "worker" ||
    request.destination === "sharedworker"
  );
}

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

  // Navegação (documento principal) e worker.js: cache-first, mas SEMPRE
  // injetando os cabeçalhos de isolamento de origem cruzada na resposta
  // final — os dois precisam deles para o worker nascer isolado.
  if (needsIsolationHeaders(event.request)) {
    event.respondWith(
      caches.open(APP_CACHE).then(async (cache) => {
        const cached = await cache.match(event.request);
        try {
          const response = await fetch(event.request);
          if (response && response.status === 200) {
            cache.put(event.request, response.clone());
          }
          return withIsolationHeaders(response);
        } catch (err) {
          if (cached) return withIsolationHeaders(cached);
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
