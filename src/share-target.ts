// What arrives when the installed app is picked out of Android's share sheet, turned into the one
// thing this app can act on: words to hand to the city's own index. The link that came with them is
// dropped, because an index that never touches the network cannot follow one.

// The query parameters a share arrives in. Named in the manifest's `share_target` (app/manifest.ts)
// and read back out of `location.search` here, so the two cannot drift apart. GET, because a static
// export has no server to post to — Chrome appends these to the action URL and the page reads them.
export const SHARE_PARAMS = {
  title: "title",
  text: "text",
  url: "url",
} as const;

// Anything that reads as a link, running to the next space: a scheme with its slashes, a bare `www.`
// host, or — the shape a maps app's share actually carries — a host with a path and no scheme at
// all, `maps.app.goo.gl/AbC123`. The path is what keeps that last form off a place name: "St. Mark's
// Church" has the dots and none of the slash.
const LINK =
  /(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\/\S*/gi;
// A link cut out of the middle of a share leaves the punctuation from both of its sides against each
// other — "Prospect Park — — 5 min". The first of them stands for the pair.
const DOUBLED = /([,;:·—–|-])(?:\s*[,;:·—–|-])+\s*/g;
// What a link leaves behind at either end once it is cut out: the dash or comma that joined it to
// the name in front of it.
const TRIM = /^[\s,;:·—–|-]+|[\s,;:·—–|-]+$/g;

function withoutLinks(text: string): string {
  return text
    .replace(LINK, " ")
    .replace(/\s+/g, " ")
    .replace(DOUBLED, "$1 ")
    .replace(TRIM, "");
}

// Every reading of a share the index could answer. "Katz's Delicatessen, 205 E Houston St" is what a
// maps app sends, and the whole of it matches nothing: the index wants a name or a door, and that
// string is both, joined by a comma. So the whole comes first — a two-word name with a comma in it
// deserves its chance — and then each comma-separated part, left to right as it was written.
//
// Written order, not longest first: which part is longer says nothing about which is worth routing
// to, and every one of them is searched anyway (`resolveSharedQuery` in src/geocode.ts), so the
// order only decides which name match is offered when no part names a door.
//
// A comma and nothing else. The dashes a share strings its trailing notes on look like joiners too,
// but splitting on them hands the index fragments nobody named a place with — and "Joe's Pizza — 5
// min" then routes to 5 Minetta Street, because a house number and a streetish word are all the
// address file needs to call a match exact.
export function sharedQueries(text: string): string[] {
  const whole = text.trim();
  const parts = whole
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "" && part !== whole);
  return [whole, ...parts].filter((part) => part !== "");
}

// The words to search for out of a share, or null when it carried nothing but a link.
//
// Android's share sheet has no url field of its own, so shared links arrive inside `text` and
// occasionally inside `title` — and Google Maps shares a place name and a shortened link together,
// which is the case that makes stripping worth doing: the name in front of the link is exactly what
// the local index resolves. `title` is the fallback rather than the first choice, since the text is
// where the address lands when there is one.
export function sharedDestinationText(params: URLSearchParams): string | null {
  const text = withoutLinks(params.get(SHARE_PARAMS.text) ?? "");
  const title = withoutLinks(params.get(SHARE_PARAMS.title) ?? "");
  return text || title || null;
}

// `search` with the share's own keys taken out and any others left alone, so acting on a share also
// retires it: a reload of the address bar it left behind must not hand the same words over again.
export function withoutShareParams(search: string): string {
  const params = new URLSearchParams(search);
  for (const key of Object.values(SHARE_PARAMS)) {
    params.delete(key);
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}
