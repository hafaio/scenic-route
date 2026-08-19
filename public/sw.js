// A service worker that does nothing: every request goes to the network exactly as it would without
// one. It exists because Chromium has historically only offered to install a site that registers one
// with a fetch handler, and an empty handler satisfies that without taking on any caching — the
// offline story is a separate piece of work, and a cache here would only risk serving a stale app
// shell against the hashed chunks a static export names.
self.addEventListener("fetch", () => {});
