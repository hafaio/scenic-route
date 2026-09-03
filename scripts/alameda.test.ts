import { expect, test } from "bun:test";
import { apnSortKey, featureName, prettyLandmarkName } from "./alameda";

// The three readers that turn a state inventory row into something the county's own layers can be
// asked about. All three join on an EXACT string — an APN against `APN_SORT`, a street against
// `FEANME`, a name against nothing at all — so a spelling this gets wrong is a landmark that is
// silently never placed rather than a build that fails.

test("an APN is re-laid into the county's own key however the state spells it", () => {
  // The three spellings the inventory actually files, all of which the parcel roll writes one way.
  expect(apnSortKey("8 649 5")).toBe("008 064900500");
  expect(apnSortKey("070-0196-022")).toBe("070 019602200");
  expect(apnSortKey("071-0228-001-02")).toBe("071 022800102");
});

test("the padded key orders the books and pages numerically", () => {
  const keys = ["070-0196-022", "8 649 5", "071-0228-001-02"].map(apnSortKey);
  expect([...keys].sort()).toEqual([
    "008 064900500",
    "070 019602200",
    "071 022800102",
  ]);
});

test("a number that is not an APN is dropped rather than guessed at", () => {
  expect(apnSortKey("8 649")).toBeNull(); // no parcel group
  expect(apnSortKey("1234-0196-022")).toBeNull(); // a book too wide to be one
  expect(apnSortKey("")).toBeNull();
});

test("a street sheds the type token the address points keep in a column of their own", () => {
  expect(featureName("Shattuck Ave")).toBe("SHATTUCK");
  expect(featureName("Telegraph Ave.")).toBe("TELEGRAPH");
  expect(featureName("7th St")).toBe("7TH");
  // Not a type token, and the street is Broadway Terrace whatever the abbreviations list says.
  expect(featureName("Broadway Terrace")).toBe("BROADWAY TERRACE");
  // The article is part of the name: Berkeley files The Uplands under both words.
  expect(featureName("The Uplands")).toBe("THE UPLANDS");
});

test("the one street the two sources spell differently is reconciled", () => {
  expect(featureName("M L King Jr Wy")).toBe("MARTIN LUTHER KING JR");
  expect(featureName("Martin Luther King Jr Way")).toBe(
    "MARTIN LUTHER KING JR",
  );
});

test("a shouted landmark name is recased a letter run at a time", () => {
  expect(prettyLandmarkName("PARAMOUNT THEATRE")).toBe("Paramount Theatre");
  expect(prettyLandmarkName("U.S. POST OFFICE")).toBe("U.S. Post Office");
  expect(prettyLandmarkName("ST JOSEPH'S CHURCH")).toBe("St Joseph's Church");
  expect(prettyLandmarkName("  HOTEL   OAKLAND ")).toBe("Hotel Oakland");
});

test("a name somebody already capitalized is left alone, aliases and all", () => {
  expect(prettyLandmarkName("Thorsen, William R., House|Sigma Phi Place")).toBe(
    "Thorsen, William R., House",
  );
});

test("the export's editorial marks are not part of the name", () => {
  expect(prettyLandmarkName("FIRST CHURCH OF CHRIST, SCIENTIST~")).toBe(
    "First Church Of Christ, Scientist",
  );
  expect(prettyLandmarkName("OAKLAND CITY HALL<")).toBe("Oakland City Hall");
});
