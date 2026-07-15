# The committed sources

Build *inputs*, not build output: `scripts/build-tree-data.ts` writes them from the upstream
sources, and `scripts/build-tiles` renders them into the tiles and chunks the client actually
fetches. None of these files is ever served to a browser. Layouts are documented in
`scripts/README.md`.

| file | what | source |
| --- | --- | --- |
| `trees/nyc.bin` | 898,618 standing street trees | NYC ForMS "Forestry Tree Points" (`hn5i-inap`) |
| `streets/nyc.bin` | the walkable street network, with the tree density at every vertex | NYC CSCL street centerline (`inkn-q76z`) |
| `land/nyc.bin` | shoreline-clipped borough boundaries | NYC borough boundaries (`gthc-hcne`) |
| `woodland/nyc.bin` | `natural=wood` + `landuse=forest` polygons | **OpenStreetMap** |

All four are tracked in **Git LFS** (see `.gitattributes`).

> **`sl commit` does not run git-lfs clean filters.** It commits the raw multi-megabyte blob and
> says nothing. Commit these with `git commit`, then `git lfs push --object-id origin <oid>`.

## Licensing

The code in this repository is MIT. The data here is not all MIT, and the difference matters.

**`woodland/nyc.bin` is derived from OpenStreetMap and is therefore licensed under the
[ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/)**, © OpenStreetMap contributors. It is
an extract of OSM geometry — a *Derivative Database* in ODbL's terms — so its share-alike clause
applies to it: reuse it, and what you build from it stays open under the same terms.

The rendered map is a different matter. Tiles and street chunks are *Produced Works*, which ODbL
covers with attribution alone — which the app gives, in the Leaflet attribution control.

Everything else here comes from **NYC Open Data**, which carries no usage restrictions (Local Law
11 of 2012); attribution is a courtesy rather than an obligation, and the app gives it anyway.
