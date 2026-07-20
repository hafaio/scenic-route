# The committed sources

Build *inputs*, not build output: `scripts/build-tree-data.ts` writes them from the upstream
sources, and `scripts/build-tiles` renders them into the tiles and chunks the client actually
fetches. None of these files is ever served to a browser. Layouts are documented in
`scripts/README.md`.

| file | what | source |
| --- | --- | --- |
| `trees/nyc.bin` | 925,338 tree points (899,394 standing ForMS street trees + 25,944 OSM `natural=tree`), each with its crown and genus — the genus overlay | NYC ForMS "Forestry Tree Points" (`hn5i-inap`) + **OpenStreetMap** |
| `streets/nyc.bin` | the walkable street network, with the canopy cover at every vertex | NYC CSCL street centerline (`inkn-q76z`) |
| `land/nyc.bin` | shoreline-clipped borough boundaries | NYC borough boundaries (`gthc-hcne`) |
| `canopy/nyc.bin` | measured 2017 LiDAR tree-canopy polygons — the cover source | NYC OTI / NYC Parks |
| `paths/nyc.bin` | OSM pedestrian/park ways (footway, path, greenway, steps…) and park drives (roads closed to through motor traffic), with the canopy cover at every vertex | **OpenStreetMap** |
| `ferries/nyc.bin` | the time-independent ferry graph (stops, crossings, per-segment crossing+wait time and drawing geometry) — OSM- and canopy-independent | NYC DOT Staten Island Ferry GTFS + NYC Ferry (Hornblower) GTFS |
| `ferries/siferry-gtfs.zip`, `ferries/nycferry-gtfs.zip` | the two raw GTFS feeds, frozen so a later time-of-day pass can re-derive from the exact feeds a build read | NYC DOT + NYC Ferry (Hornblower) |
| `landmarks/nyc.bin` | ~1,530 designated landmark sites (points) — the "passes a landmark" routing discount | NYC LPC Individual Landmark Sites (`buis-pvji`) |
| `art/nyc.bin` | public-art points (murals, sculpture, installations) — the "passes public art" routing discount | NYC PDC Outdoor Public Art Inventory (`2pg3-gcaa`) + **OpenStreetMap** (`tourism=artwork`) |
| `highways/nyc.bin` | limited-access highways and above-ground rail as polylines — the highway/rail proximity *penalty* | **OpenStreetMap** |
| `buildings/nyc.bin` | 867,920 building footprints, each with its roof height and base (ground) elevation — the source for the future building-shade factor (not yet read by routing) | NYC Building Footprints (`5zhs-2jue`) |

All of these are tracked in **Git LFS** (see `.gitattributes`).

> **`sl commit` does not run git-lfs clean filters.** It commits the raw multi-megabyte blob and
> says nothing. Commit these with `git commit`, then `git lfs push --object-id origin <oid>`.

## Licensing

The code in this repository is MIT. The data here is not all MIT, and the difference matters.

**`paths/nyc.bin` is derived from OpenStreetMap and is therefore licensed under the
[ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/)**, © OpenStreetMap contributors. It is an
extract of OSM geometry — a *Derivative Database* in ODbL's terms — so its share-alike clause applies
to it: reuse it, and what you build from it stays open under the same terms. `trees/nyc.bin` also
folds in OSM `natural=tree` points alongside the NYC ForMS census, so the same ODbL terms reach it.
The same reaches **`art/nyc.bin`** (which folds in OSM `tourism=artwork`) and **`highways/nyc.bin`**
(highways and rail extracted wholesale from OSM).

`landmarks/nyc.bin` and `buildings/nyc.bin` are pure **NYC Open Data** (no OSM), so they carry no
share-alike obligation — see below.

The rendered map is a different matter. Tiles and street chunks are *Produced Works*, which ODbL
covers with attribution alone — which the app gives, in the Leaflet attribution control.

The **ferry** sources are not from OSM. The **Staten Island Ferry** feed is NYC DOT's, published on
NYC Open Data terms (Local Law 11 of 2012, no usage restriction). The **NYC Ferry** feed (operated
by Hornblower for NYCEDC, served through Connexionz) ships with **no explicit licence** in the feed —
it is a public GTFS feed published for consumption by transit apps; there is no share-alike clause,
and the app attributes "NYC Ferry" as a courtesy. `ferries/nyc.bin` mixes the two, so it inherits
neither OSM's ODbL nor any restriction.

Everything else here comes from **NYC Open Data**, which carries no usage restrictions (Local Law
11 of 2012); attribution is a courtesy rather than an obligation, and the app gives it anyway.
