import { expect, test } from "bun:test";
import {
  ADDRESS_RESULT_TYPE,
  type GeocodeResult,
  INDEX_RESULT_TYPE,
  resolveSharedQuery,
} from "./geocode";

const CITY = "nyc";

function place(displayName: string): GeocodeResult {
  return {
    placeId: `place:${displayName}`,
    lat: 40.7,
    lng: -73.9,
    displayName,
    type: INDEX_RESULT_TYPE,
    exact: false,
  };
}

function door(displayName: string): GeocodeResult {
  return {
    placeId: `door:${displayName}`,
    lat: 40.72,
    lng: -73.98,
    displayName,
    type: ADDRESS_RESULT_TYPE,
    exact: true,
  };
}

// Stands in for the city's index: the queries it has answers for, and a record of what it was asked.
function index(answers: Record<string, GeocodeResult[]>) {
  const asked: string[] = [];
  const search = async (
    query: string,
    cityId: string,
  ): Promise<GeocodeResult[]> => {
    expect(cityId).toBe(CITY);
    asked.push(query);
    return answers[query] ?? [];
  };
  return { asked, search };
}

test("the door wins over the name it was shared beside", async () => {
  // What a maps app sends. Both halves match something — the name in the place index, the address in
  // the address file — and only the address is precise enough to route to without asking. Stopping
  // at the first half that answered would stop at the name and never look at the door.
  const { asked, search } = index({
    "Katz's Delicatessen": [place("Katz's Delicatessen, Manhattan")],
    "205 E Houston St": [door("205 E Houston St, Manhattan")],
  });
  const found = await resolveSharedQuery(
    "Katz's Delicatessen, 205 E Houston St",
    CITY,
    search,
  );
  expect(found?.query).toBe("205 E Houston St");
  expect(found?.exact?.displayName).toBe("205 E Houston St, Manhattan");
  expect(asked).toContain("Katz's Delicatessen");
});

test("the door wins from either side of the comma", async () => {
  const { search } = index({
    "205 E Houston St": [door("205 E Houston St, Manhattan")],
    "New York": [place("New York")],
  });
  const found = await resolveSharedQuery(
    "205 E Houston St, New York",
    CITY,
    search,
  );
  expect(found?.exact?.displayName).toBe("205 E Houston St, Manhattan");
});

test("a whole share that names a door is not taken apart at all", async () => {
  const { asked, search } = index({
    "205 E Houston St": [door("205 E Houston St, Manhattan")],
  });
  const found = await resolveSharedQuery("205 E Houston St", CITY, search);
  expect(found?.exact).not.toBeNull();
  expect(asked).toEqual(["205 E Houston St"]);
});

test("a share with no door at all keeps the first name that answered", async () => {
  // Nothing here is certain enough to route to, so what comes back is the words to put in the box
  // and the candidates to put under them — and the words are the ones that found the candidates.
  const { search } = index({
    "Joe's Pizza": [
      place("Joe's Pizza, Carmine St"),
      place("Joe's Pizza, Broadway"),
    ],
    Brooklyn: [place("Brooklyn")],
  });
  const found = await resolveSharedQuery("Joe's Pizza, Brooklyn", CITY, search);
  expect(found?.exact).toBeNull();
  expect(found?.query).toBe("Joe's Pizza");
  expect(found?.results).toHaveLength(2);
});

test("a share the city has never heard of resolves to nothing", async () => {
  const { search } = index({});
  expect(await resolveSharedQuery("Nowhere At All", CITY, search)).toBeNull();
});

test("a near-miss house number is offered rather than routed to", async () => {
  // The address file answers "205 E Houston St" with the nearest door it has, which is not the one
  // that was asked for. A guess set silently as the destination is worse than a list to pick from.
  const near: GeocodeResult = { ...door("209 E Houston St"), exact: false };
  const { search } = index({ "205 E Houston St": [near] });
  const found = await resolveSharedQuery("205 E Houston St", CITY, search);
  expect(found?.exact).toBeNull();
  expect(found?.results).toEqual([near]);
});

test("a lookup the reader has moved past stops asking", async () => {
  // Each search warms the index for its city, so one left running after the city changed would drag
  // the index back to the city nobody is looking at any more.
  let done = false;
  const { asked, search } = index({ Brooklyn: [place("Brooklyn")] });
  const found = await resolveSharedQuery(
    "Joe's Pizza, Brooklyn",
    CITY,
    async (query, cityId) => {
      const results = await search(query, cityId);
      done = true;
      return results;
    },
    () => done,
  );
  expect(found).toBeNull();
  expect(asked).toEqual(["Joe's Pizza, Brooklyn"]);
});
