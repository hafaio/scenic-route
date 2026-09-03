// What every fetch in scripts/ has in common: the identity it goes out under, the backoff it comes
// back on, and the JSON and byte reads built from the two.
//
// The user agent is required rather than polite: an Overpass mirror 429s an anonymous client on
// sight.
//
// How long a ladder a caller climbs stays with the caller: a layer read in hundreds of pages wants
// several attempts under it, while a single request whose failure is the build's failure either way
// is better off saying so at once.

import pRetry, { type RetryContext } from "p-retry";

export const USER_AGENT =
  "scenic-route/0.1 (+https://github.com/erikbrinkman/scenic-route)";

const RETRY_BASE_MS = 2_000;
const RETRY_CAP_MS = 30_000;

interface LadderOptions {
  // The first wait, for a source that wants more room than the default before being asked again.
  minTimeoutMs?: number;
  // Called on every failure, for a read long enough that a silent wait reads as a hang.
  onFailedAttempt?: (context: RetryContext) => void;
}

// The p-retry options a public source is asked again on, from a count of attempts in total: one
// means no retry at all. Randomized, because these builds read a service in parallel and a fixed
// backoff would put every worker back on it at the same instant.
export function retryLadder(
  attempts: number,
  { minTimeoutMs = RETRY_BASE_MS, onFailedAttempt }: LadderOptions = {},
): {
  retries: number;
  minTimeout: number;
  maxTimeout: number;
  randomize: boolean;
  onFailedAttempt?: (context: RetryContext) => void;
} {
  return {
    retries: attempts - 1,
    minTimeout: minTimeoutMs,
    maxTimeout: RETRY_CAP_MS,
    randomize: true,
    onFailedAttempt,
  };
}

export interface HttpRequest extends LadderOptions {
  // A form body, which makes the read a POST. What needs one is a batched `where` of a few hundred
  // clauses, which is longer than a URL may be.
  body?: URLSearchParams;
  // Left off for a request with no deadline of its own, which is most of them: a slow answer from a
  // service being read a page at a time is still an answer.
  timeoutMs?: number;
  // Attempts in total, so the default of 1 gives up on the first refusal.
  attempts?: number;
}

export interface JsonRequest<Value> extends HttpRequest {
  // Run on the parsed body INSIDE the retry, so a service that reports failure in a 200 — which is
  // how every ArcGIS layer here reports one — is asked again rather than believed.
  check?: (value: Value) => void;
}

// One attempt's request, up to the point where the two readers below part company over the body.
async function send(
  url: string,
  { body, timeoutMs }: HttpRequest,
): Promise<Response> {
  const headers: Record<string, string> = { "user-agent": USER_AGENT };
  if (body) {
    headers["content-type"] = "application/x-www-form-urlencoded";
  }
  const response = await fetch(url, {
    method: body ? "POST" : "GET",
    headers,
    body,
    signal: timeoutMs === undefined ? null : AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`${url}: ${response.status} ${response.statusText}`);
  }
  return response;
}

export async function fetchJson<Value>(
  url: string,
  request: JsonRequest<Value> = {},
): Promise<Value> {
  const { attempts = 1, check, minTimeoutMs, onFailedAttempt } = request;
  return await pRetry(
    async () => {
      const value = (await (await send(url, request)).json()) as Value;
      check?.(value);
      return value;
    },
    retryLadder(attempts, { minTimeoutMs, onFailedAttempt }),
  );
}

// The same request read as bytes rather than as JSON: a point-cloud node, a DEM tile, a listing.
export async function fetchBytes(
  url: string,
  request: Omit<HttpRequest, "body"> = {},
): Promise<Uint8Array> {
  const { attempts = 1, minTimeoutMs, onFailedAttempt } = request;
  return await pRetry(
    async () => new Uint8Array(await (await send(url, request)).arrayBuffer()),
    retryLadder(attempts, { minTimeoutMs, onFailedAttempt }),
  );
}
