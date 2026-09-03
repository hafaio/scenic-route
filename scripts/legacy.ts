// `bun run scripts/legacy.ts [city]`: fetches a city's register of long-standing businesses and
// writes them as data/legacy/<id>.bin (magic LGCY) — the points the legacy-business overlay draws.
// Layout: scripts/README.md.
//
// These are not the landmarks (designated BUILDINGS, scripts/landmarks.ts) and not the historic
// districts (designated AREAS, scripts/historic.ts). They are living establishments: doors you can
// still walk through and buy something from, which is a third thing and reads as one on the map.
//
// WHAT THIS IS NOT, and why it took a survey to get here. The obvious source — how long a business
// has held a licence — does not exist in any usable form, and that is measured rather than assumed:
//
//   - NYC's DCWP licences cover regulated trades (home-improvement contractors, tobacco dealers,
//     sightseeing guides), not diners or hardware stores, and nothing predates 1994 except 102
//     sentinel rows dated 1900 — the file begins where the agency's digitisation does.
//   - The State Liquor Authority's `originalissuedate` has a statewide MINIMUM of 2017 and is 96%
//     dated 2023 or later: licensing moved systems and "original issue" reset with it. The older
//     list that carried deep dates is retired and answers 403. A NY liquor licence does not survive
//     a sale anyway, so even those dates measured the owner, not the business.
//   - OpenStreetMap's `start_date` is on 212 of 46,396 NYC shop and food POIs, and 43 in SF.
//
// So the layer is built from CURATED REGISTERS instead, which is a different claim and a better one:
// a body researched the business, checked the date and voted it on. What the map says is "on the
// register", which is exactly what it knows.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pRetry from "p-retry";
import { cached } from "./cache";
import { encodePoints, type NamedPoint } from "./geometry";
import { USER_AGENT } from "./http";
import { type LandContext, loadLandContext } from "./land";
import type { SourceFile } from "./manifest";

const DATA_DIR = join(import.meta.dirname, "..", "data");
const LEGACY_DIR = join(DATA_DIR, "legacy");
const LEGACY_MAGIC = "LGCY";
const LEGACY_FORMAT = 1;

// How long a business has to have been trading to be drawn. New York's register admits only
// businesses of fifty years or more, so meeting San Francisco's in the middle — its own bar is
// twenty to thirty — is what makes one dot mean the same thing in both cities.
const MIN_AGE_YEARS = 50;

const REQUEST_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 2_000;

// San Francisco's Legacy Business Registry, as the Office of Small Business publishes it behind its
// own dashboard. Not on DataSF's Socrata catalogue — searching for it there finds nothing — so this
// reads the ArcGIS layer directly, the same way scripts/historic.ts reads the LPC's.
const SF_SERVICE =
  "https://services.arcgis.com/Zs2aNLFN00jrS4gG/arcgis/rest/services/legacy_biz/FeatureServer/0/query";
// New York State's Historic Business Preservation Registry. STATE, not city: New York City has no
// register of its own, only a Council bill pending since 2018, and if it ever passes its businesses
// land in this same layer. Entry is by nomination from a state legislator, so a business missing
// from it has not been nominated — which is not the same as not being old, and is the one thing
// this layer must not be read as saying.
const NY_SERVICE =
  "https://services.arcgis.com/1xFZPtKn1wKC6POA/arcgis/rest/services/Historic_Businesses_(view)/FeatureServer/0/query";

interface Feature {
  attributes: Record<string, unknown>;
  geometry?: { x?: number; y?: number };
}

interface Page {
  features?: Feature[];
  exceededTransferLimit?: boolean;
  error?: { code: number; message: string };
}

function pageUrl(service: string, fields: string[], offset: number): string {
  const url = new URL(service);
  url.searchParams.set("where", "1=1");
  url.searchParams.set("outFields", fields.join(","));
  url.searchParams.set("returnGeometry", "true");
  url.searchParams.set("outSR", "4326");
  // Without an order an ArcGIS layer may repeat or skip rows between pages.
  url.searchParams.set("orderByFields", "OBJECTID");
  url.searchParams.set("f", "json");
  url.searchParams.set("resultOffset", String(offset));
  url.searchParams.set("resultRecordCount", "1000");
  return url.toString();
}

async function fetchPage(url: string): Promise<Page> {
  return await pRetry(
    async () => {
      const response = await fetch(url, {
        headers: { "user-agent": USER_AGENT },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }
      const body = (await response.json()) as Page;
      // A 200 carrying an `error` body is how ArcGIS reports a failure.
      if (body.error) {
        throw new Error(`ArcGIS ${body.error.code}: ${body.error.message}`);
      } else if (!Array.isArray(body.features)) {
        throw new Error("no features in the response");
      }
      return body;
    },
    { retries: MAX_ATTEMPTS - 1, minTimeout: RETRY_BASE_MS },
  );
}

async function fetchAll(
  name: string,
  service: string,
  fields: string[],
): Promise<Feature[]> {
  const features: Feature[] = [];
  for (let offset = 0; ; offset += 1000) {
    const url = pageUrl(service, fields, offset);
    const page = await cached(name, url, () => fetchPage(url));
    features.push(...(page.features ?? []));
    if (!page.exceededTransferLimit || (page.features ?? []).length === 0) {
      return features;
    }
  }
}

// A four-digit year out of whatever the register wrote down, which is what decides whether a business
// is old enough to draw. San Francisco's field is free text and holds "1869", "Circa 1924" and
// "1940s" alike, so the year is read out of the string rather than parsed from it. Only San
// Francisco needs this: New York's register admits nothing under fifty years in the first place.
function yearIn(value: unknown, thisYear: number): number | null {
  const found = String(value ?? "").match(/\b(1[6-9]\d\d|20[0-2]\d)\b/);
  if (!found) {
    return null;
  }
  const year = Number.parseInt(found[1], 10);
  return year <= thisYear ? year : null;
}

// The label the overlay draws: the name and nothing else. The year decides whether a business is on
// the map at all — fifty years is the whole entry condition — but it does not go in the label. A
// screenful of dates reads as a database; the names read as a neighbourhood.

async function sfLegacy(
  land: LandContext,
  thisYear: number,
): Promise<NamedPoint[]> {
  const features = await fetchAll("arcgis-sf-legacy-business", SF_SERVICE, [
    "OBJECTID",
    "Business_Name",
    "Location_Business_Name",
    "Established_Date",
    "Status",
  ]);
  const points: NamedPoint[] = [];
  for (const { attributes, geometry } of features) {
    // The register lists a row per LOCATION, so a business with four shops is four dots, which is
    // right for a map: each of them is a door you can walk to.
    const name = String(
      attributes.Location_Business_Name || attributes.Business_Name || "",
    );
    const year = yearIn(attributes.Established_Date, thisYear);
    const lat = geometry?.y;
    const lng = geometry?.x;
    if (
      name.trim() === "" ||
      year === null ||
      thisYear - year < MIN_AGE_YEARS ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lng)
    ) {
      continue;
    }
    const point = { lat: lat as number, lng: lng as number, name: name.trim() };
    if (land.onLand(point)) {
      points.push(point);
    }
  }
  return points;
}

// Takes the year and ignores it: New York's register admits nothing under fifty years, so there is
// nothing left here to filter by. The signature matches San Francisco's so both are one source type.
async function nycLegacy(land: LandContext): Promise<NamedPoint[]> {
  const features = await fetchAll("arcgis-ny-historic-business", NY_SERVICE, [
    "OBJECTID",
    "Business_Name",
    "Year_Est_",
    "Municipality",
  ]);
  const points: NamedPoint[] = [];
  for (const { attributes, geometry } of features) {
    const name = String(attributes.Business_Name ?? "");
    const lat = geometry?.y;
    const lng = geometry?.x;
    if (name.trim() === "" || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      continue;
    }
    // The register is statewide and every entry on it already meets the fifty years, so the city's
    // own land mask is what cuts it down — the same test every other POI source is cut by, rather
    // than a bounding box that would take in Nassau. The year is not read at all here: it is the
    // register's entry condition, already met, and one row carries a zip code in that column.
    const point = { lat: lat as number, lng: lng as number, name: name.trim() };
    if (land.onLand(point)) {
      points.push(point);
    }
  }
  return points;
}

export type LegacySource = (
  land: LandContext,
  thisYear: number,
) => Promise<NamedPoint[]>;

export const NYC_LEGACY: LegacySource = nycLegacy;
export const SF_LEGACY: LegacySource = sfLegacy;

export async function ingestLegacy(
  cityId: string,
  source: LegacySource | null,
  land: LandContext,
  thisYear = new Date().getUTCFullYear(),
): Promise<SourceFile> {
  const started = performance.now();
  await mkdir(LEGACY_DIR, { recursive: true });
  const points = source ? await source(land, thisYear) : [];
  const bytes = encodePoints(LEGACY_MAGIC, LEGACY_FORMAT, points);
  const file = `${cityId}.bin`;
  await writeFile(join(LEGACY_DIR, file), bytes);

  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  const kib = (bytes.length / 1024).toFixed(1);
  console.error(
    `legacy: ${points.length} businesses of ${MIN_AGE_YEARS}+ years, ${kib} KiB in ${seconds}s`,
  );
  return {
    file,
    format: LEGACY_FORMAT,
    count: points.length,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

if (import.meta.main) {
  const cityId = process.argv[2] ?? "nyc";
  await ingestLegacy(
    cityId,
    cityId === "sf" ? SF_LEGACY : NYC_LEGACY,
    await loadLandContext(cityId),
  );
}
