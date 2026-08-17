// The land-time half of the shed guard: scripts/graph-inputs.ts, which says what the routing
// graph's durable key space is a function of, and scripts/check-shed-inputs.ts, which compares that
// against what the committed artifact was placed on. What is left to test here is the comparison and
// its messages — both halves of the stamp are the tiler's, and each is measured where it is
// computed: `key_space_stamp` in crates/tiler/src/build.rs (the sources decision, the bytes it
// names, and that a checkout holding only LFS pointers stamps what one holding the blobs does), and
// the durable key hash in crates/tiler/src/graph.rs.
//
// Neither is exercised end to end here: a `bun test` file in a subdirectory gets nothing back from
// `spawnSync`'s captured stdout (a bun 1.3 quirk — the same call from the repo root, or from `bun
// run`, captures fine). The CI job runs `bun run check-shed-inputs` immediately after this suite,
// which is both reports end to end against the committed record.

import { expect, test } from "bun:test";
import { shedInputsMismatch } from "../../scripts/check-shed-inputs";

const PLACED = { stamp: "abc", files: 6, keySpace: "0123456789abcdef" };

test("an artifact placed against the committed inputs passes", () => {
  expect(shedInputsMismatch(PLACED, { ...PLACED })).toBeNull();
});

test("inputs that moved without a re-place say so, and say what to run", () => {
  const mismatch = shedInputsMismatch(PLACED, { ...PLACED, stamp: "def" });

  expect(mismatch).toContain("stamped abc");
  expect(mismatch).toContain("stamp def");
  expect(mismatch).toContain("bun run build-sheds");
  expect(mismatch).toContain("scripts/README.md");
});

// The half a file hash cannot see: every source byte-identical, and the tiler cutting them into
// different edges.
test("a tiler that assigns keys differently says so on its own", () => {
  const mismatch = shedInputsMismatch(PLACED, {
    ...PLACED,
    keySpace: "fedcba9876543210",
  });

  expect(mismatch).toContain("0123456789abcdef");
  expect(mismatch).toContain("fedcba9876543210");
  expect(mismatch).toContain("bun run build-sheds");
  expect(mismatch).toContain("scripts/README.md");
});

test("an artifact that records nothing is not trusted", () => {
  expect(shedInputsMismatch(null, PLACED)).toContain(
    "public/sheds/inputs.json is missing",
  );
});
