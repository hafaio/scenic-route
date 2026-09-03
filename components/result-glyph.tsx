"use client";

import { MdOutlineHome, MdOutlinePlace, MdSignpost } from "react-icons/md";
import { PiTrainSimpleFill } from "react-icons/pi";
import {
  ADDRESS_RESULT_TYPE,
  INDEX_RESULT_TYPE,
  STREET_RESULT_TYPE,
  SUBWAY_RESULT_TYPE,
} from "../src/geocode";
import { SUBWAY_COLOR } from "../src/overlays/colors";
import { useMapTheme } from "./use-map-theme";

// The glyph beside a result row, shared by the route fields and the search panel so a place reads
// the same whichever box found it.

const GLYPH = "h-4 w-4 shrink-0 text-slate-400 dark:text-slate-500";

export default function ResultGlyph({ type }: { type: string }) {
  const theme = useMapTheme();
  if (type === ADDRESS_RESULT_TYPE) {
    // A house number out of the city's own address file, which is a door rather than the whole
    // street the signpost below stands for.
    return <MdOutlineHome className={GLYPH} aria-hidden="true" />;
  } else if (type === SUBWAY_RESULT_TYPE) {
    // The layer menu's own subway colour, in the theme the map is drawing in, so a station in the
    // list and a station on the map are the same blue.
    return (
      <PiTrainSimpleFill
        className="h-4 w-4 shrink-0"
        style={{ color: SUBWAY_COLOR[theme] }}
        aria-hidden="true"
      />
    );
  } else if (type === STREET_RESULT_TYPE) {
    // A street is one point on the whole of it, which is a coarser answer than the rest of the list
    // gives. Its own glyph is what says so at a glance.
    return <MdSignpost className={GLYPH} aria-hidden="true" />;
  } else if (type === INDEX_RESULT_TYPE) {
    // A named place off the city's own index. One pin for all of them: the row carries a category,
    // but a glyph per category is 1,639 of them, and what the pin has to say here is that this is a
    // place rather than a door or a street.
    return <MdOutlinePlace className={GLYPH} aria-hidden="true" />;
  } else {
    return null;
  }
}
