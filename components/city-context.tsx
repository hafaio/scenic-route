"use client";

import { createContext, useContext } from "react";
import { type City, DEFAULT_CITY } from "../src/cities";

// The overlay layers mount from the registry's `render()`, which takes no arguments, so the active
// city reaches them here rather than as a prop.
const CityContext = createContext<City>(DEFAULT_CITY);

export const CityProvider = CityContext.Provider;

export function useCity(): City {
  return useContext(CityContext);
}
