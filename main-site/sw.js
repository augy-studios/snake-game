// Service worker for Snake Game.
//
// BUMP VERSION ON EVERY CHANGE TO THIS SITE. Not only when this file
// changes: any edit under main-site/ is a new build, and the browser only
// sees an update when this file differs byte for byte.
//
// What happens to each request:
//
//   navigation              the shell this worker owns, network if absent;
//                           /join and /r/<id> are the game page too
//   /api/                   not intercepted: runs, the leaderboard and
//                           replay links need the network
//   same origin assets      cache first
//   other cross origin      not intercepted (analytics, ads, PeerJS)
//   anything but GET        not intercepted
//
// Rules that are easy to break here:
//
// 1. skipWaiting and clients.claim happen only when a person presses Reload
//    on the update bar, which posts 'skip-waiting'. Neither appears in
//    install or activate. scripts/check-sw.mjs fails if that stops being true.
//
// 2. Navigations are answered from this worker's own shell, not the network.
//    The shell's modules are cache first, so a network page would pair a new
//    index.html with the previous build's JavaScript. New versions arrive
//    through the update bar, all at once.
//
// 3. Precache entries are fetched one at a time with cache: 'reload'. addAll
//    fails the whole install on one bad path, and without 'reload' a bumped
//    worker can fill its new cache from the HTTP cache's old files.
//
// 4. Nothing under /api/ is ever cached. A cached leaderboard is a wrong
//    answer, not a stale one, and a cached run would be somebody else's.
//
// 5. PeerJS, for party games, comes from cdnjs and is never cached:
//    pairing needs the network anyway (STUN-p2p-spec.md).

const VERSION = "uwusnek-v13";

const SHELL = `uwusnek-shell-${VERSION}`;

// Everything else is deleted on activate, including the template's old
// "snek-v1" cache.
const KEEP = new Set([SHELL]);

// Addresses the browser asks for. "/index.html" is absent because cleanUrls
// redirects it to "/", and a redirected response cannot answer a
// navigation. 404.html is absent: offline, an unknown path gets the game.
// XSG-main.png and the screenshots are absent because only crawlers and
// install prompts fetch them.
const PRECACHE = [
  "/",

  "/css/theme.css",
  "/css/style.css",

  "/js/app.js",
  "/js/api.js",
  "/js/bot.js",
  "/js/game.js",
  "/js/icons.js",
  "/js/ladders-game.js",
  "/js/ladders-render.js",
  "/js/ladders-rules.js",
  "/js/leaderboard.js",
  "/js/p2p.js",
  "/js/party.js",
  "/js/qr.js",
  "/js/render.js",
  "/js/replay.js",
  "/js/replay-format.js",
  "/js/rules.js",
  "/js/seed.js",
  "/js/settings.js",
  "/js/slither-autoplay.js",
  "/js/slither-game.js",
  "/js/slither-render.js",
  "/js/slither-replay.js",
  "/js/slither-rules.js",
  "/js/slither-skins.js",
  "/js/theme.js",
  "/js/ui.js",
  "/js/update-bar.js",
  "/js/wordfilter.js",

  "/fonts/jua-latin.woff2",
  // Slither's computer snakes are named from it.
  "/wordlist.json",

  "/manifest.json",
  "/favicon.ico",
  "/XSG-192.png",
  "/XSG-512.png",
];

// Paths that are the game page under another name: a party's join link and
// a shared replay's short link. Offline, the page opens and says what needs
// a connection.
const isGamePage = (path) => path === "/join" || /^\/r\/[A-Za-z0-9]{8}$/.test(path);

self.addEventListener("install", (event) => {
  event.waitUntil(fillShell());
  // No skipWaiting. The new worker waits until somebody accepts the update.
});

async function fillShell() {
  const cache = await caches.open(SHELL);
  const failed = [];

  await Promise.all(
    PRECACHE.map(async (path) => {
      try {
        const response = await fetch(new Request(path, { cache: "reload" }));
        if (!response.ok) throw new Error(`${response.status}`);
        if (response.redirected) throw new Error("redirected");
        await cache.put(path, response);
      } catch (cause) {
        failed.push(`${path} (${cause?.message ?? cause})`);
      }
    })
  );

  if (failed.length) {
    console.warn(
      `[uwusnek] ${failed.length} of ${PRECACHE.length} precache entries failed. ` +
        `Offline is degraded, not off:\n  ${failed.join("\n  ")}`
    );
  }
}

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => !KEEP.has(key)).map((key) => caches.delete(key)));
    })()
  );
  // No clients.claim, for the same reason there is no skipWaiting above.
});

self.addEventListener("message", (event) => {
  const data = event.data;
  const type = typeof data === "string" ? data : data?.type;

  if (type === "version") {
    event.source?.postMessage({ type: "version", version: VERSION });
    return;
  }

  // The only way either of these is ever called. js/update-bar.js posts it
  // when the reader presses Reload, and reloads on controllerchange.
  if (type === "skip-waiting") {
    event.waitUntil(self.skipWaiting().then(() => self.clients.claim()));
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  if (request.headers.has("range")) return;

  const url = new URL(request.url);

  // Analytics, ads and PeerJS go straight to the network, and simply fail offline.
  if (url.origin !== self.location.origin) return;

  // Runs, the leaderboard and replay links: network only.
  if (url.pathname.startsWith("/api/")) return;

  event.respondWith(request.mode === "navigate" ? navigation(request, url) : staticAsset(request, url));
});

async function navigation(request, url) {
  const shell = await caches.open(SHELL);

  const own = await shell.match(isGamePage(url.pathname) ? "/" : url.pathname);
  if (own) return own;

  try {
    return await fetch(request);
  } catch {
    // Offline and not a page this worker holds: the game is the only page.
    return (await shell.match("/")) ?? Response.error();
  }
}

async function staticAsset(request, url) {
  const shell = await caches.open(SHELL);

  const cached = await shell.match(url.pathname);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (isCacheable(response)) await shell.put(url.pathname, response.clone());
    return response;
  } catch {
    return new Response("Offline", { status: 503 });
  }
}

// Whether a same origin response may be stored. Every shell write after
// install goes through here.
function isCacheable(response) {
  if (!response || response.status !== 200) return false;
  if (response.type !== "basic" && response.type !== "default") return false;
  if (response.redirected) return false;

  const control = (response.headers.get("Cache-Control") ?? "").toLowerCase();
  if (control.includes("no-store") || control.includes("private")) return false;

  return true;
}
