// The basemap's colours, matched to CARTO Voyager — the raster style this app drew on until the
// switch to Protomaps. Every value here was sampled from Voyager's own tiles rather than picked by
// eye: renders of the same six viewports were pixel-counted, and the dominant colours came out as the
// cream blocks (#f6efe4), the pale land behind them (#fbf8f3), arterials from #fefdd7 to #ffe9a5,
// water #d5e8eb and the navy place labels (#405c78).
//
// This is only the colour half of a style. What each feature is DRAWN as — widths, which zoom it
// appears at, how densely it is labelled — lives in ./rules.ts, because Protomaps keeps the two
// apart. That separation is why a second colour scheme costs a file like this one and nothing else.

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
