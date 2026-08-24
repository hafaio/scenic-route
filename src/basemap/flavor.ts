// The basemap's colours: one dictionary per theme.
//
// The light one is matched to CARTO Voyager, the raster style this app drew on until the switch to
// Protomaps. Every value in it was sampled from Voyager's own tiles rather than picked by eye:
// renders of the same six viewports were pixel-counted, and the dominant colours came out as the
// cream blocks (#f6efe4), the pale land behind them (#fbf8f3), arterials from #fefdd7 to #ffe9a5,
// water #d5e8eb and the navy place labels (#405c78).
//
// This is only the colour half of a style. What each feature is DRAWN as — widths, which zoom it
// appears at, how densely it is labelled — lives in ./rules.ts, because Protomaps keeps the two
// apart. That separation is why a second colour scheme costs a file like this one and nothing else.

import type { ThemeName } from "../theme/palette";

// Protomaps does not export its Flavor type, and the shape is a flat dictionary of colour strings
// with two nested groups, so it is spelled out here rather than borrowed.
export interface Flavor {
  [key: string]: string | Record<string, string>;
}

export const VOYAGER: Flavor = {
  background: "#fbf8f3",
  earth: "#f6efe4",

  park_a: "#e4eeda",
  park_b: "#cfe3bf",
  wood_a: "#e2ecd8",
  wood_b: "#c9dfb8",
  scrub_a: "#e8efdc",
  scrub_b: "#d7e6c8",
  zoo: "#e4eeda",

  hospital: "#f2e6df",
  industrial: "#eee7d8",
  school: "#f1e9da",
  military: "#ece7db",
  pedestrian: "#f2ece0",
  glacier: "#ffffff",
  sand: "#f7f1e0",
  beach: "#f9f1d9",
  aerodrome: "#efece5",
  runway: "#ffffff",
  pier: "#f1ebde",

  water: "#d5e8eb",
  buildings: "#e9dcc4",

  // Voyager draws a hairline warm casing under every road and fills minor streets pure white; only
  // the arterials carry the yellow, and the motorway a shade deeper than the avenue.
  other: "#faf6ee",
  minor_service: "#faf6ee",
  minor_a: "#ffffff",
  minor_b: "#ffffff",
  link: "#ffffff",
  major: "#fffdf4",
  highway: "#ffe9a5",
  minor_service_casing: "#ded0b7",
  minor_casing: "#ded0b7",
  link_casing: "#ded0b7",
  major_casing_early: "#eadfc4",
  major_casing_late: "#eadfc4",
  highway_casing_early: "#e9cf8e",
  highway_casing_late: "#e9cf8e",

  tunnel_other_casing: "#ece4d5",
  tunnel_minor_casing: "#ece4d5",
  tunnel_link_casing: "#ece4d5",
  tunnel_major_casing: "#eadfc4",
  tunnel_highway_casing: "#e9cf8e",
  tunnel_other: "#f7f2e8",
  tunnel_minor: "#f7f2e8",
  tunnel_link: "#f7f2e8",
  tunnel_major: "#fbf9ef",
  tunnel_highway: "#fbf0c4",

  bridges_other_casing: "#ded0b7",
  bridges_minor_casing: "#ded0b7",
  bridges_link_casing: "#ded0b7",
  bridges_major_casing: "#eadfc4",
  bridges_highway_casing: "#e9cf8e",
  bridges_other: "#faf6ee",
  bridges_minor: "#ffffff",
  bridges_link: "#ffffff",
  bridges_major: "#fffdf4",
  bridges_highway: "#ffe9a5",

  railway: "#d3c9b7",
  boundaries: "#bcae99",

  // Labels are the half of Voyager that reads as "Voyager": warm-grey street names, navy places.
  roads_label_minor: "#8d97a5",
  roads_label_minor_halo: "#ffffff",
  roads_label_major: "#7a8594",
  roads_label_major_halo: "#ffffff",
  ocean_label: "#7fa3bd",
  subplace_label: "#6f7f92",
  subplace_label_halo: "#f6efe4",
  city_label: "#405c78",
  city_label_halo: "#faf7f1",
  state_label: "#8b98a6",
  state_label_halo: "#faf7f1",
  country_label: "#75859a",
  address_label: "#94a0ad",
  address_label_halo: "#ffffff",

  pois: {
    blue: "#4a7fa8",
    green: "#5a8a63",
    lapis: "#4e6ba8",
    pink: "#c0729a",
    red: "#c4707f",
    slategray: "#7b7a92",
    tangerine: "#c08a4e",
    turquoise: "#4c9fa8",
  },
  landcover: {
    grassland: "rgba(228, 238, 218, 1)",
    barren: "rgba(246, 240, 226, 1)",
    urban_area: "rgba(246, 239, 228, 1)",
    farmland: "rgba(233, 240, 216, 1)",
    glacier: "rgba(255, 255, 255, 1)",
    scrub: "rgba(238, 241, 219, 1)",
    forest: "rgba(214, 231, 206, 1)",
  },
};

// The night map. Not the light one inverted — that is what the app used to do in CSS, and it put
// near-black streets on a brown ground, because inverting a style turns its brightest, most
// important lines into its darkest.
//
// The rule a dark map runs on is the opposite of a light one's: on paper the land is bright and the
// ink is dark, so the roads are cut out of the ground as white; at night the ground is dark and the
// roads are the lit thing on it. So the ground here is a deep blue-slate — not black, because the
// shade wash and the overlays still have to get darker than it — and everything the reader follows
// is a step lighter than the ground, in the same order of importance the light style uses: minor
// streets legible, arterials clearly brighter, motorways warm. Water goes DARKER than the land
// rather than lighter, which is what keeps a coastline readable when the land is dark too.
//
// The ground is also lighter than a night map usually goes, and deliberately: the shade overlay
// draws SHADOWS on it, and a shadow needs somewhere to fall. On a near-black ground the wash had
// nothing left to take away and the sunniest street looked the same as the shadiest.
export const MIDNIGHT: Flavor = {
  background: "#202730",
  earth: "#2a323d",

  park_a: "#24352c",
  park_b: "#2c4034",
  wood_a: "#25362d",
  wood_b: "#2d4235",
  scrub_a: "#2b342d",
  scrub_b: "#333d34",
  zoo: "#24352c",

  hospital: "#342d35",
  industrial: "#2e353d",
  school: "#30353d",
  military: "#2e333c",
  pedestrian: "#323944",
  glacier: "#4b5462",
  sand: "#37393c",
  beach: "#3a3b3a",
  aerodrome: "#2d333c",
  runway: "#4b5462",
  pier: "#2e353e",

  water: "#141b26",
  buildings: "#333c48",

  // The lit half of the map. Minor streets sit clearly above the ground, arterials clearly above
  // them, and the motorway carries the warmth Voyager gives it rather than going brighter still — a
  // city's worth of motorway at full brightness is all a reader would see.
  other: "#353e49",
  minor_service: "#353e49",
  minor_a: "#47515f",
  minor_b: "#47515f",
  link: "#47515f",
  major: "#5f6b7b",
  highway: "#7a6c4a",
  minor_service_casing: "#1e242c",
  minor_casing: "#1e242c",
  link_casing: "#1e242c",
  major_casing_early: "#1e242c",
  major_casing_late: "#1e242c",
  highway_casing_early: "#463d29",
  highway_casing_late: "#463d29",

  tunnel_other_casing: "#1e242c",
  tunnel_minor_casing: "#1e242c",
  tunnel_link_casing: "#1e242c",
  tunnel_major_casing: "#1e242c",
  tunnel_highway_casing: "#463d29",
  tunnel_other: "#2f3742",
  tunnel_minor: "#3b4450",
  tunnel_link: "#3b4450",
  tunnel_major: "#4d5665",
  tunnel_highway: "#60553b",

  bridges_other_casing: "#181d24",
  bridges_minor_casing: "#181d24",
  bridges_link_casing: "#181d24",
  bridges_major_casing: "#181d24",
  bridges_highway_casing: "#463d29",
  bridges_other: "#353e49",
  bridges_minor: "#47515f",
  bridges_link: "#47515f",
  bridges_major: "#5f6b7b",
  bridges_highway: "#7a6c4a",

  railway: "#414a56",
  boundaries: "#66717f",

  // Labels are read against the ground, so they take the halo the light style gives them and swap
  // which side is dark: light type, ground-coloured halo. Places stay the coolest and brightest
  // thing on the map, which is the one echo of Voyager's navy that survives the move to night.
  roads_label_minor: "#9aa5b3",
  roads_label_minor_halo: "#1f252d",
  roads_label_major: "#afbac7",
  roads_label_major_halo: "#1f252d",
  ocean_label: "#55738e",
  subplace_label: "#a3b0c0",
  subplace_label_halo: "#232a33",
  city_label: "#d7e3f0",
  city_label_halo: "#1f252d",
  state_label: "#86929f",
  state_label_halo: "#1f252d",
  country_label: "#98a5b4",
  address_label: "#818c99",
  address_label_halo: "#1f252d",

  pois: {
    blue: "#6fa6cf",
    green: "#80b289",
    lapis: "#7790cb",
    pink: "#db99bb",
    red: "#db97a4",
    slategray: "#a1a0b5",
    tangerine: "#ddad74",
    turquoise: "#72c6cf",
  },
  landcover: {
    grassland: "rgba(36, 53, 44, 1)",
    barren: "rgba(48, 50, 52, 1)",
    urban_area: "rgba(42, 50, 61, 1)",
    farmland: "rgba(40, 53, 42, 1)",
    glacier: "rgba(75, 84, 98, 1)",
    scrub: "rgba(43, 52, 45, 1)",
    forest: "rgba(34, 51, 41, 1)",
  },
};

export const FLAVORS: Record<ThemeName, Flavor> = {
  light: VOYAGER,
  dark: MIDNIGHT,
};
