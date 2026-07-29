import L from "leaflet";

// Leaflet keeps a zoom's parent tiles on screen while its children load, and drops them again from
// the next `_pruneTiles`. But the pass that finishes a tile's 200ms fade-in, `_updateOpacity`, only
// prunes when it sees a current tile that was *already* opaque (its `willPrune`). When a whole
// screenful crosses the fade line in the same pass — which is exactly what a worker returning every
// tile of a zoom in one burst produces — nothing is "already" opaque, so that pass neither prunes
// nor asks for another frame, and the run ends there. The 250ms prune `_tileReady` queues is no
// backstop: it can land in the last few milliseconds before that final fade frame, find the tiles
// still mid-fade and re-retain the same parents. The retained parents then sit in the DOM under
// their own children for as long as the zoom lasts, drawing every overlay twice — the parent scaled
// up over its children, which reads as doubled, slightly offset POI labels.
//
// Pruning after every opacity pass closes it. It is idempotent and cannot uncover the map: parents
// are re-retained for as long as any current tile is still fading, so a tile only goes when its
// children already cover it.
// Only once the fade has SETTLED, though, not on every frame of it. `_pruneTiles` costs a keyed
// lookup per retained relative — up five levels for a parent, and failing that two levels of
// children, which is twenty per tile — and zooming out is exactly when the parent lookup misses and
// the child walk runs. Per frame, across every grid layer, that was ~130k string-keyed lookups a
// zoom. Settling is also precisely when the bug bites, since the pass that strands the parents is
// the one where the last tile goes opaque.
// The internals this reaches for; none of them are in Leaflet's typings.
interface Prunable {
  _noPrune?: boolean; // set while a zoom animation or a pinch is in flight
  // absent until onAdd; see _updateOpacity below
  _tiles?: Record<
    string,
    { current: boolean; loaded?: number; active?: boolean }
  >;
  _updateOpacity(): void;
  _pruneTiles(): void; // a no-op on a layer that is off the map
}

type PrunableGridLayer = L.GridLayer & Prunable;

let installed = false;

// Patches `L.GridLayer` itself rather than this app's subclass: the basemap and the route grid
// double the same way, and both are Leaflet's own classes.
export default function installTilePrune(): void {
  if (installed) {
    return;
  }
  installed = true;
  const prototype = L.GridLayer.prototype as PrunableGridLayer;
  const updateOpacity = prototype._updateOpacity;
  prototype._updateOpacity = function (this: PrunableGridLayer): void {
    updateOpacity.call(this);
    // `_noPrune` is Leaflet's own guard against pruning mid-zoom-animation; the prune it skips is
    // covered by the one `_setView` runs when the animation ends.
    //
    // `_tiles` is missing on the way in: a layer created below full opacity runs this from
    // `_initContainer`, which is BEFORE `onAdd` makes the tile store. The original tolerates that
    // silently because `for..in` over undefined iterates nothing, and throwing here instead strands
    // the layer half-initialised — its map events are already bound, so it fails on every zoom
    // thereafter, forever.
    if (this._noPrune || !this._tiles) {
      return;
    }
    // The original marks a tile active as its fade reaches 1, so a loaded current tile that is not
    // active yet is still fading and another frame is coming.
    for (const tile of Object.values(this._tiles)) {
      if (tile.current && tile.loaded && !tile.active) {
        return;
      }
    }
    this._pruneTiles();
  };
}
