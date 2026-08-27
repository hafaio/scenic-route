import { expect, test } from "bun:test";
import {
  sharedDestinationText,
  sharedQueries,
  withoutShareParams,
} from "./share-target";

const shared = (params: Record<string, string>): string | null =>
  sharedDestinationText(new URLSearchParams(params));

test("the link a maps app sends alongside the name is cut out", () => {
  // Android has no url field of its own, so the link rides in the text — and this is the shape a
  // maps app sends: a place, then a shortened link. The name is the half the index can answer.
  expect(
    shared({
      text: "Katz's Delicatessen, 205 E Houston St https://goo.gl/maps/xyz",
    }),
  ).toBe("Katz's Delicatessen, 205 E Houston St");
  expect(shared({ text: "Joe's Pizza www.joespizza.com" })).toBe("Joe's Pizza");
  // Several links, and the punctuation that joined them to the name, all go.
  expect(
    shared({ text: "Prospect Park — https://a.example/x https://b.example/y" }),
  ).toBe("Prospect Park");
});

test("a share with nothing to search is nothing, not an empty search", () => {
  expect(shared({ text: "https://example.com/a-restaurant" })).toBeNull();
  expect(shared({ text: "   " })).toBeNull();
  expect(shared({})).toBeNull();
});

test("the title answers when the text is only a link", () => {
  // A shared web page puts its name in the title and its address in the text; the name is all there
  // is to go on, and it is worth a try even though it is often not a place at all.
  expect(
    shared({ title: "Katz's Delicatessen", text: "https://katzs.example" }),
  ).toBe("Katz's Delicatessen");
  // But the text leads when it has words of its own, since that is where an address lands.
  expect(shared({ title: "Maps", text: "205 E Houston St" })).toBe(
    "205 E Houston St",
  );
});

test("a name and an address joined by a comma are tried apart as well as whole", () => {
  // The whole string matches nothing — it is a name and a door at once — so the parts have to be
  // reachable, in the order they were written.
  expect(sharedQueries("Katz's Delicatessen, 205 E Houston St")).toEqual([
    "Katz's Delicatessen, 205 E Houston St",
    "Katz's Delicatessen",
    "205 E Houston St",
  ]);
  // Written order, so the longer half does not jump the queue: an address sent first stays first.
  expect(sharedQueries("205 E Houston St, New York")).toEqual([
    "205 E Houston St, New York",
    "205 E Houston St",
    "New York",
  ]);
  // A name that simply contains a comma still gets its chance at being itself first.
  expect(sharedQueries("Joe's, Pizza")[0]).toBe("Joe's, Pizza");
  // Nothing to split is one query, not a list with an empty tail.
  expect(sharedQueries("205 E Houston St")).toEqual(["205 E Houston St"]);
  expect(sharedQueries("  ")).toEqual([]);
});

test("a shortened link with no scheme is a link too", () => {
  // What Google Maps' share sheet actually sends: no scheme, no `www.`, just a host and a path.
  expect(
    shared({
      text: "Katz's Delicatessen, 205 E Houston St maps.app.goo.gl/AbC123",
    }),
  ).toBe("Katz's Delicatessen, 205 E Houston St");
  expect(shared({ text: "goo.gl/maps/xyz" })).toBeNull();
  // A place name with a dot in it is not a link: the path is what tells them apart.
  expect(shared({ text: "St. Mark's Church" })).toBe("St. Mark's Church");
  expect(shared({ text: "Joe's Pizza Co." })).toBe("Joe's Pizza Co.");
});

test("a link cut out of the middle does not leave its punctuation behind", () => {
  expect(
    shared({ text: "Café naïve — https://x.example/y — 5 min walk" }),
  ).toBe("Café naïve — 5 min walk");
  expect(shared({ text: "Prospect Park, https://a.example/x, Brooklyn" })).toBe(
    "Prospect Park, Brooklyn",
  );
});

test("acting on a share takes its own keys out of the URL and leaves the rest", () => {
  expect(withoutShareParams("?title=Katz's&text=205+E+Houston+St&url=x")).toBe(
    "",
  );
  expect(withoutShareParams("?text=Joe%27s&debug=1")).toBe("?debug=1");
  expect(withoutShareParams("")).toBe("");
});

test("a dash is not a joiner, however much it looks like one", () => {
  // Splitting here would hand the index "5 min", which it answers with 5 Minetta Street — a house
  // number and a streetish word are all the address file needs to call a match exact, and the share
  // would route to a door nobody named.
  expect(sharedQueries("Joe's Pizza — 5 min walk")).toEqual([
    "Joe's Pizza — 5 min walk",
  ]);
});
