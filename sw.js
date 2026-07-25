// Evidentum Pro service worker
// Strategy: NETWORK-FIRST, and the Cache API holds ONLY the same-origin offline
// app shell — online users always get the latest build; the cache is just an
// offline fallback. Cross-origin requests (scholarly-database + AI-provider APIs,
// CORS proxies, the pdf.js CDN) are never intercepted, so search terms, query URLs
// and credential-bearing URLs (e.g. NCBI ?api_key=…) never reach the Cache API.
// The SW only manages the Cache API — it never touches IndexedDB or localStorage,
// so an update can't clear projects, appraisals or credentials.
// v6 (P6): writes restricted to a strict app-shell allowlist via swCacheableShell()
// — same-origin, GET, NO query string (so an OAuth callback ?code=…&state=… or any
// other query-bearing/sensitive same-origin URL is never persisted), 200 basic only.
// v7 (MV3): the allowlist is now EXACT shell paths resolved from the registration
// scope (not suffix regexes), so a deeper same-origin path like <scope>private/ is
// no longer cacheable. Each bump evicts the older cache on activation.
const CACHE = 'evidentum-v8';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png'
];

// The exact app-shell filenames (relative to the SW's registration scope) that may
// ever enter the Cache API — the deploy root, index.html, the manifest, the icons,
// and the vendored pdf.js (so offline appraisal keeps working).
const SHELL_FILES = ['', 'index.html', 'manifest.webmanifest',
  'icon-192.png', 'icon-512.png', 'icon-512-maskable.png',
  'pdf.min.js', 'pdf.worker.min.js'];

// Pure decision: may this fetched response be written to the Cache API? The cache
// is STRICTLY the offline app shell — same-origin, a successful 200 basic (not
// opaque/cors/redirect) response, no query string, and an EXACT shell path resolved
// from the SW's own registration scope. Anything else is served from the network and
// never stored: any query-bearing URL (how OAuth callbacks' code/state and other
// sensitive same-origin URLs would otherwise leak in), and — post-MV3 — any deeper
// same-origin path such as <scope>private/ or <scope>private/index.html that the
// earlier suffix regexes (/\/$/, /index\.html$/) would have accepted.
// `scope` is a full URL (self.registration.scope). Exported implicitly for tests.
function swCacheableShell(reqUrl, res, scope) {
  if (!res || res.status !== 200 || res.ok !== true) return false;   // 2xx only
  if (res.type && res.type !== 'basic') return false;                // no opaque/cors/redirect
  let u, base;
  try { u = new URL(reqUrl); base = new URL(scope); } catch (e) { return false; }
  if (u.origin !== base.origin) return false;                        // same-origin only
  if (u.search) return false;                                        // NEVER cache query-bearing URLs
  const dir = base.pathname.replace(/[^/]*$/, '');                   // scope directory (ends in '/')
  for (let i = 0; i < SHELL_FILES.length; i++) {
    if (u.pathname === dir + SHELL_FILES[i]) return true;            // exact match only
  }
  return false;
}

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  // CROSS-ORIGIN → do not intercept: the browser handles it over the network and
  // nothing is written to the Cache API. This excludes every API, proxy, CDN and
  // credential-bearing request (search URLs, NCBI ?api_key=…, AI calls, PDFs).
  let sameOrigin = false;
  try { sameOrigin = new URL(req.url).origin === self.location.origin; } catch (err) { sameOrigin = false; }
  if (!sameOrigin) return;

  // Same-origin: network-first (freshest build wins online). A response is written
  // to the cache ONLY when swCacheableShell() approves it (app-shell allowlist, no
  // query string, 200 basic). Navigations fall back to the cached shell offline —
  // including query-bearing ones, whose URLs are still never stored.
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (swCacheableShell(req.url, res, self.registration.scope)) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});   // ignore quota failures
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then((r) =>
          r || ((req.mode === 'navigate' || req.destination === 'document') ? caches.match('./index.html') : undefined)
        )
      )
  );
});
