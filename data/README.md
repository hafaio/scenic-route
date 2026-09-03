# The committed sources

Build *inputs*, not build output: `scripts/tree-data-fetch.ts` writes them from the upstream
sources, and `scripts/build-tiles` renders them into the tiles and chunks the client actually
fetches. None of these files is ever served to a browser. Layouts are documented in
`scripts/README.md`.

| file | what | source |
| --- | --- | --- |
| `trees/nyc.bin` | 925,338 tree points (899,394 standing ForMS street trees + 25,944 OSM `natural=tree`), each with its crown and genus — the genus overlay | NYC ForMS "Forestry Tree Points" (`hn5i-inap`) + **OpenStreetMap** |
| `streets/nyc.bin` | the walkable street network, with the canopy cover at every vertex and, per side, whether OSM maps a sidewalk there and whether the planimetric layer paves it | NYC CSCL street centerline (`inkn-q76z`) + NYC planimetric SIDEWALK polygons (`52n9-sdep`) + **OpenStreetMap** |
| `land/nyc.bin` | shoreline-clipped borough boundaries | NYC borough boundaries (`gthc-hcne`) |
| `canopy/nyc.bin` | measured 2017 LiDAR tree-canopy polygons — the cover source | NYC OTI / NYC Parks |
| `paths/nyc.bin` | OSM pedestrian/park ways (footway, path, greenway, steps…) and park drives (roads closed to through motor traffic), with the canopy cover at every vertex | **OpenStreetMap** |
| `sidewalks/nyc.bin` | the OSM ways describing a street's own pavement — `footway=sidewalk`, `footway=crossing`, `footway=traffic_island` — the set the paths extract excludes | **OpenStreetMap** |
| `ferries/nyc.bin` | the time-independent ferry graph (stops, crossings, per-segment crossing+wait time and drawing geometry) — OSM- and canopy-independent | NYC DOT Staten Island Ferry GTFS + NYC Ferry (Hornblower) GTFS |
| `ferries/siferry-gtfs.zip`, `ferries/nycferry-gtfs.zip` | the two raw GTFS feeds, frozen so a later time-of-day pass can re-derive from the exact feeds a build read | NYC DOT + NYC Ferry (Hornblower) |
| `subway/nyc.bin` | the 29 subway route lines (28 subway routes + the Staten Island Railway) with the colour, bullet-text colour and both names the MTA publishes for each, and the 496 stations with the routes calling at each — drawn only, read by no routing input | MTA subway GTFS (`rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip`) |
| `subway/sf.bin` | San Francisco's 14 rail lines — Muni's six Metro lines, the F historic streetcar and the three cable cars, plus the four BART lines that run through the city — as 42 polylines clipped to the city's land, with each agency's own colours and names, and the 268 stations with the routes calling at each; the same `SBWY` layout as `subway/nyc.bin`, drawn only, read by no routing input | SFMTA Muni GTFS (`muni-gtfs.apps.sfmta.com`) + BART GTFS (`bart.gov/dev/schedules`) |
| `landmarks/nyc.bin` | ~1,530 designated landmark sites (points) — the "passes a landmark" routing discount | NYC LPC Individual Landmark Sites (`buis-pvji`) |
| `art/nyc.bin` | public-art points (murals, sculpture, installations) — the "passes public art" routing discount | NYC PDC Outdoor Public Art Inventory (`2pg3-gcaa`) + **OpenStreetMap** (`tourism=artwork`) |
| `highways/nyc.bin` | limited-access highways and above-ground rail as polylines — the highway/rail proximity *penalty* | **OpenStreetMap** |
| `buildings/nyc.bin` | 867,920 building footprints, each with its roof height and base (ground) elevation — the source for the future building-shade factor (not yet read by routing) | NYC Building Footprints (`5zhs-2jue`) |
| `landuse/nyc.bin` | 788,591 tax lots, each tagged with its land-use class (1-3 residential, 4 mixed, 5 commercial) — the commercial-vs-residential signal for the "commercial area" overlay | NYC PLUTO (`64uk-42ks`) |
| `dining/nyc.bin` | outdoor-dining points (licensed sidewalk/roadway cafés + OSM `outdoor_seating`) — a "cute" signal for the commercial overlay | NYC Dining Out (`fpeh-f7ci`) + **OpenStreetMap** |
| `openstreets/nyc.bin` | non-school Open Streets corridors, sampled every ~10 m along each — a "cute" signal for the commercial overlay | NYC DOT Open Streets (`uiay-nctu`) |

All of these are tracked in **Git LFS** (see `.gitattributes`).

The sidewalk-shed artifact is **not** here and nothing under `data/` feeds it: it is derived output,
committed at `public/sheds/`, written by `bun run build-sheds` and rewritten daily by the job
(`scripts/README.md` documents it). It is committed *outside* this directory on purpose. **Nothing
shed-related is in LFS and none of it may ever be** — LFS keeps every rewrite whole, so a megabyte a
day costs ~400 MB of quota a year, and the client fetches these off `main` through
`raw.githubusercontent.com`, which serves an LFS file's *pointer text* rather than its bytes — and
every directory in here has a `.gitattributes` line, so one more would be an invitation to add the
matching line without thinking.

> **`sl commit` does not run git-lfs clean filters.** It commits the raw multi-megabyte blob and
> says nothing. Commit these with `git commit`, then `git lfs push --object-id origin <oid>`.

## Licensing

The code in this repository is MIT. The data here is not all MIT, and the difference matters.

**`paths/nyc.bin` is derived from OpenStreetMap and is therefore licensed under the
[ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/)**, © OpenStreetMap contributors. It is an
extract of OSM geometry — a *Derivative Database* in ODbL's terms — so its share-alike clause applies
to it: reuse it, and what you build from it stays open under the same terms. `trees/nyc.bin` also
folds in OSM `natural=tree` points alongside the NYC ForMS census, so the same ODbL terms reach it.
The same reaches **`sidewalks/nyc.bin`** (OSM sidewalk, crossing and traffic-island ways extracted
wholesale), **`art/nyc.bin`** (which folds in OSM `tourism=artwork`), **`highways/nyc.bin`**
(highways and rail extracted wholesale from OSM), and **`dining/nyc.bin`** (which folds in OSM
`outdoor_seating`). It reaches **`streets/nyc.bin`** too, for four bits a record: CSCL's own
geometry carries no OSM, but the per-side "OSM maps a sidewalk here" bits are derived from the
sidewalk extract, and this repository's line has been to let share-alike follow the derivation
rather than argue de-minimis. In `streets/sf.bin` the other two bits reach OSM as well, since the
East Bay's "a survey says there is pavement here" bits come from OSM's `sidewalk=*` road tags rather
than from a municipal survey — the same line, drawn the same way.

`landmarks/nyc.bin`, `buildings/nyc.bin`, `landuse/nyc.bin`, and `openstreets/nyc.bin` are pure
**NYC Open Data** (no OSM), so they carry no share-alike obligation — see below.

`subway/sf.bin` carries no OSM either, and its two feeds are licensed rather than merely published.
**BART**'s GTFS is public with no restriction. **SFMTA**'s comes with a licence agreement in the zip
that permits redistribution and derived works, forbids using Muni's or the City's trademarks, logos
and maps, and requires every derivative to bear this notice:

> Reproduced with permission granted by the City and County of San Francisco. The information has
> been provided by means of a nonexclusive, limited, and revocable license granted by the City and
> County of San Francisco.
>
> The City and County of San Francisco does not guarantee the accuracy, adequacy, completeness or
> usefulness of any information. The City and County of San Francisco provides this information "as
> is," without warranty of any kind, express or implied, including but not limited to warranties of
> merchantability or fitness for a particular purpose, and assumes no responsibility for anyone's use
> of the information.

What the file carries is the feed's own route colours, names, shapes and stop positions — data, not
Muni's map or wordmark — so the trademark clause bites on how the overlay is *drawn* and named, not
on the ingest.

The rendered map is a different matter. Tiles and street chunks are *Produced Works*, which ODbL
covers with attribution alone — which the app gives, in the Leaflet attribution control.

The **ferry** sources are not from OSM. The **Staten Island Ferry** feed is NYC DOT's, published on
NYC Open Data terms (Local Law 11 of 2012, no usage restriction). The **NYC Ferry** feed (operated
by Hornblower for NYCEDC, served through Connexionz) ships with **no explicit licence** in the feed —
it is a public GTFS feed published for consumption by transit apps; there is no share-alike clause,
and the app attributes "NYC Ferry" as a courtesy. `ferries/nyc.bin` mixes the two, so it inherits
neither OSM's ODbL nor any restriction.

`trees/berkeley-trees.json.gz` is not an artifact but a **frozen source**: a copy of Berkeley's
`Trees_Test` ArcGIS layer, 46,732 rows of longitude, latitude, species and trunk diameter, taken
because the layer is an unmaintained staging table nobody should build on. `scripts/README.md`
explains it; `bun run scripts/east-bay-trees.ts --snapshot` rewrites it. It is deliberately **not**
in LFS — it is under a megabyte and written once.

`canopy/sf.bin` holds two surveys: San Francisco's own 2013 Urban Forest Plan canopy analysis, from
DataSF, and the East Bay's, traced from the **Alameda and Contra Costa 1-metre lidar canopy height
model** (East Bay Regional Parks / CAL FIRE / USGS / Tukman Geospatial). The latter is **public
domain** — Pacific Veg Map, which publishes it, states that "all of the map data accessible via this
site is in the public domain and is freely accessible to all" — so it carries no share-alike
obligation and the credit in the About dialog is a courtesy.

Everything else here comes from **NYC Open Data**, which carries no usage restrictions (Local Law
11 of 2012); attribution is a courtesy rather than an obligation, and the app gives it anyway.
