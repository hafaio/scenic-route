"use client";

import { useEffect } from "react";
import { FiExternalLink, FiMapPin, FiX } from "react-icons/fi";
import { SiGithub } from "react-icons/si";
import { cityInSentence } from "../src/cities";
import { useCity } from "./city-context";

interface AboutDialogProps {
  onClose: () => void;
}

// One row in the data-provenance list: what a layer is, and where it comes from. `licence` is the
// text of a licence this app has to hand over rather than merely name, shipped under public/licenses
// and linked from the row so it is reachable rather than merely present.
interface DataSource {
  label: string;
  detail: string;
  licence?: string;
}

function Source({ label, detail, licence }: DataSource) {
  return (
    <li className="flex flex-col">
      <span className="font-medium text-slate-700 dark:text-slate-200">
        {label}
      </span>
      {licence === undefined ? (
        <span className="text-slate-500 dark:text-slate-400">{detail}</span>
      ) : (
        // Relative, so it resolves under whatever base path the deploy injects.
        <a
          href={licence}
          target="_blank"
          rel="noreferrer"
          className="text-slate-500 underline decoration-slate-300 underline-offset-2 hover:text-slate-700 dark:text-slate-400 dark:decoration-slate-600 dark:hover:text-slate-200"
        >
          {detail}
        </a>
      )}
    </li>
  );
}

// The credits are per region, because the sources are: no two cities publish their canopy, their
// landmarks or their industrial land the same way, and a single list would credit New York for a map
// of the Bay Area. Only the active region's are shown, which is also what keeps a licence that names
// one city's terms — SFMTA's below — attached to the map it actually governs.
const CITY_SOURCES: Record<string, readonly DataSource[]> = {
  nyc: [
    {
      label: "Tree canopy",
      detail: "2017 LiDAR tree canopy · NYC OTI / NYC Parks",
    },
    // CC BY 4.0 makes crediting this a condition of the licence, not a courtesy, and this dialog is
    // the app's only credits surface — the map draws no attribution control of its own.
    {
      label: "Tree heights",
      detail:
        "Ma et al. 2023, Individual structure mapping over six million trees for New York City (CC BY 4.0)",
    },
    {
      label: "Street trees",
      detail: "NYC Parks Forestry (ForMS) · NYC Open Data",
    },
    {
      label: "Streets",
      detail: "NYC Street Centerline (CSCL) · NYC Open Data",
    },
    {
      label: "Ferries",
      detail: "Staten Island Ferry (NYC DOT) & NYC Ferry GTFS",
    },
    { label: "Transit lines", detail: "MTA subway GTFS" },
    {
      label: "Landmarks",
      detail: "LPC Individual Landmark Sites · NYC Open Data",
    },
    {
      label: "Public art",
      detail: "PDC Outdoor Public Art · NYC Open Data, and OpenStreetMap",
    },
    {
      label: "Historic districts",
      detail: "LPC Historic Districts · NYC Landmarks Preservation Commission",
    },
    {
      label: "Industrial land",
      detail: "MapPLUTO · NYC Department of City Planning",
    },
    {
      label: "Building shade",
      detail: "NYC Building Footprints · NYC Open Data",
    },
    {
      label: "Scaffolding",
      detail:
        "Active Shed Permits · NYC DOB, and Digital Tax Map & condo billing lots · NYC Open Data",
    },
    {
      label: "Commercial streets",
      detail:
        "PLUTO, Dining Out & Open Streets · NYC Open Data, and OpenStreetMap",
    },
  ],
  sf: [
    {
      label: "Tree canopy",
      detail:
        "2013 Urban Forest Plan canopy analysis · SF Planning, and the 1 m LiDAR canopy height model for Alameda & Contra Costa · East Bay Regional Parks, CAL FIRE, USGS and Tukman Geospatial",
    },
    {
      label: "Street trees",
      detail:
        "SF Public Works street trees · DataSF, the Oakland Public Tree Inventory, and Berkeley's Arborwell street-tree survey",
    },
    { label: "Streets", detail: "SF Basemap Street Centerlines · DataSF" },
    // The boats are the only way a pedestrian crosses the bay, so the feed is routing input here
    // rather than scenery. Its ODC-BY is written down only on the operator's developer page, which
    // makes naming WETA the whole of what the licence asks for.
    {
      label: "Ferries",
      detail: "San Francisco Bay Ferry GTFS · WETA (ODC-BY)",
    },
    // SFMTA's feed licence requires this wording verbatim on anything derived from it, so the detail
    // line carries it rather than paraphrasing.
    {
      label: "Transit lines",
      detail:
        "BART GTFS; Muni GTFS — reproduced with permission granted by the City and County of San Francisco, under a nonexclusive, limited and revocable license",
    },
    // The East Bay's landmarks are not a local register like San Francisco's: neither Oakland's nor
    // Berkeley's is published as data, so they come from the state's inventory and are federal and
    // state designations. The line says whose list it is, because the two are different claims.
    {
      label: "Landmarks",
      detail:
        "Article 10 landmark sites · SF Planning, and the Built Environment Resource Directory · California Office of Historic Preservation",
    },
    {
      label: "Public art",
      detail:
        "Civic Art Collection, the 1% Art Program inventory and StreetSmArts murals · DataSF, and OpenStreetMap",
    },
    {
      label: "Historic districts",
      detail:
        "Historic Districts · SF Planning, and the Cultural Heritage Survey's areas of primary importance and preservation zoning · City of Oakland",
    },
    {
      label: "Businesses",
      detail:
        "Legacy Business Registry · SF Office of Small Business, filtered to those trading 50+ years",
    },
    {
      label: "Industrial land",
      detail:
        "Land use and PDR zoning · SF Planning via DataSF, assessor parcel use codes · Alameda County GIS, and Existing Land Use 2020 · San Francisco Estuary Institute via MTC",
    },
    // Only San Francisco's own footprints arrive with a height on them. The East Bay's are
    // Overture's, and their heights were measured here off the county's raw point cloud, so both the
    // footprints' licence and the flight that supplied the heights are named.
    {
      label: "Building shade",
      detail:
        "Building footprints with LiDAR heights · DataSF, and Overture Maps Foundation footprints (ODbL) with heights measured from the USGS 3DEP 2021 Alameda County LiDAR (public domain)",
    },
    {
      label: "Elevation",
      detail: "USGS 3DEP / NASA WERK 1 m surface models (CC0)",
    },
  ],
};

// Read by every city's map, so they sit under the city's own rather than being repeated in each.
const SHARED_SOURCES: readonly DataSource[] = [
  // None of the Overture places theme is OpenStreetMap — it is Meta, Microsoft, Foursquare and
  // AllThePlaces — and CDLA-Permissive-2.0 asks that its text travel with the data rather than be
  // cited, so it does.
  //
  // The search index it goes into is NOT Overture alone, and both entries below say so. Alongside
  // the places it carries the names and points of the alleys, footbridges and park paths ADDR has no
  // addresses on, and those come out of the routing graph, which is an OSM extract. That makes
  // public/search a derivative database under ODbL, credited here as one. The permissive licence is
  // untroubled by the company — it carries no share-alike of its own — but OSM is owed the credit
  // either way, and a file that quietly contains it while claiming not to is the worse outcome.
  {
    label: "Places",
    detail: "Overture Maps Foundation (CDLA-Permissive-2.0)",
    licence: "licenses/CDLA-Permissive-2.0.txt",
  },
  {
    label: "Alley & park path names",
    detail: "OpenStreetMap contributors (ODbL)",
  },
  {
    label: "Place listings from Foursquare",
    detail: "© Foursquare Labs, Inc. (Apache-2.0) — NOTICE",
    licence: "licenses/foursquare-places-NOTICE.txt",
  },
  {
    label: "Paths & street trees",
    detail: "OpenStreetMap contributors (ODbL)",
  },
  { label: "Highways & rail", detail: "OpenStreetMap contributors (ODbL)" },
  {
    label: "Basemap",
    detail: "Protomaps vector tiles · OpenStreetMap contributors, ODbL",
  },
  {
    label: "Map rendering",
    detail: "Leaflet (BSD-2-Clause) and protomaps-leaflet",
  },
];

export const REPO_URL = "https://github.com/hafaio/scenic-route";

export default function AboutDialog({ onClose }: AboutDialogProps) {
  const active = useCity();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[1100] flex items-end justify-center md:items-center">
      <button
        type="button"
        aria-label="Close about"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-slate-950/40 backdrop-blur-sm"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-title"
        className="relative max-h-[90dvh] w-full overflow-y-auto rounded-t-3xl bg-white p-6 shadow-2xl ring-1 ring-black/5 dark:bg-slate-800 dark:ring-white/10 md:max-w-md md:rounded-3xl md:p-7"
      >
        <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-slate-200 dark:bg-slate-700 md:hidden" />
        <div className="flex items-start gap-3">
          <span className="scenic-logo-pin grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-brand-400 to-brand-600 text-white shadow-lg">
            <FiMapPin className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h2
              id="about-title"
              className="text-lg font-semibold tracking-tight"
            >
              Scenic Route
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Nicer ways to walk the city
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="-m-1 grid h-8 w-8 shrink-0 place-items-center rounded-full text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700"
            aria-label="Close"
          >
            <FiX />
          </button>
        </div>

        <div className="mt-5 space-y-3 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
          <p>
            Scenic Route finds nicer ways to walk across{" "}
            {cityInSentence(active)}. Use Directions to plan a path — weighting
            it toward tree cover, sun or shade, shelter from the rain,
            landmarks, public art, historic districts, nice commercial streets
            and ferries, and away from highways, industrial areas and
            scaffolding — or switch between the map overlays to explore what's
            around you. Which of those a region offers depends on what its
            cities publish; the sliders say so when one is missing.
          </p>
          <p>
            To use it, tap the layers button to toggle overlays like tree canopy
            or building shade, and drag the clock to see how shade shifts
            through the day. Open Directions to set a start and destination,
            then open the sliders to bias the route toward what you care about —
            the summary shows how much of each the route picks up. Drag either
            endpoint on the map to nudge the route, and drop it to lock the new
            point in.
          </p>
        </div>

        <div className="mt-6 border-t border-slate-200/60 pt-4 dark:border-slate-700/60">
          <p className="text-[11px] uppercase tracking-wide text-slate-400 dark:text-slate-500">
            {active.name} data
          </p>
          <ul className="mt-2 space-y-2 text-xs">
            {[...(CITY_SOURCES[active.id] ?? []), ...SHARED_SOURCES].map(
              ({ label, detail }) => (
                <Source key={label} label={label} detail={detail} />
              ),
            )}
          </ul>
        </div>

        <div className="mt-5 border-t border-slate-200/60 pt-4 dark:border-slate-700/60">
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-brand-600 hover:underline dark:text-brand-400"
          >
            <SiGithub className="h-3.5 w-3.5" aria-hidden="true" />
            Source code
            <FiExternalLink className="h-3 w-3" aria-hidden="true" />
          </a>
        </div>
      </div>
    </div>
  );
}
