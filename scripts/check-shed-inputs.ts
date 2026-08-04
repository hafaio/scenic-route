// `bun run check-shed-inputs`: the land-time half of the shed guard, and the one that runs on every
// push and pull request.
//
// `check-sheds` compares the committed artifact against a graph, which means it can only run where a
// graph exists — the deploy, after a twenty-minute tile build. By then the change that broke the
// pairing has been on `main` for however long it took someone to dispatch a deploy. This runs
// instead on what the graph's DURABLE KEY SPACE is a function of (scripts/graph-inputs.ts), which
// every checkout has: no LFS objects, no data blobs, and for the code half a fixture the tiler runs
// over in a tenth of a second.
//
// It answers one question: were the sheds placed after the last change to anything that can move a
// key? Not to anything that can move the graph — the two are very different sets, and the wider one
// costs a re-place of every shed in the city for an edit to a colour ramp. A yes is still not proof
// the key space held (an input can change and cut the same edges), but the header is a hash gate, so
// an artifact that cannot say it is current is one nobody can trust, and a re-place is two minutes.
// `check-sheds` remains the stronger, later check: it compares against the graph CI actually built
// rather than against what it was built from.

import { join } from "node:path";
import {
  currentShedInputs,
  readShedInputs,
  type ShedInputs,
} from "./graph-inputs";

const RECORD = join("public", "sheds", "inputs.json");
const FIX =
  " A graph-input change and its re-place are one change: `bun run build-sheds`, then commit" +
  ` public/sheds. scripts/README.md has the whole refresh procedure.`;
const BLANKS =
  " every shed resolves to nothing on the map — silently, since the client blanks rather than" +
  " misplaces.";

// The complaint, or null when the artifact is current. Split out from the file reading because it is
// the whole of what this checks and the messages are the point. The two halves are reported apart:
// which one moved says whether to go and look at a data blob or at the pipeline.
export function shedInputsMismatch(
  recorded: ShedInputs | null,
  current: ShedInputs,
): string | null {
  if (recorded === null) {
    return (
      `${RECORD} is missing, so nothing says which inputs the committed shed artifact was placed` +
      " against, and a deploy would be the first thing to find out whether it resolves onto the" +
      ` graph it ships.${FIX}`
    );
  } else if (recorded.stamp !== current.stamp) {
    return (
      `the shed artifact was placed against key-space inputs stamped ${recorded.stamp} and the` +
      ` committed ones stamp ${current.stamp}: a street, path or sidewalk source moved, the deploy` +
      ` builds its graph from that source, and if it cut one edge differently${BLANKS}${FIX}`
    );
  } else if (recorded.keySpace !== current.keySpace) {
    return (
      `the shed artifact was placed by a tiler whose key probe landed on ${recorded.keySpace} and` +
      ` this one lands on ${current.keySpace}: the key assignment itself changed, so the graph the` +
      ` deploy builds keys its edges differently and${BLANKS}${FIX}`
    );
  } else {
    return null;
  }
}

export async function checkShedInputs(): Promise<void> {
  const [recorded, current] = await Promise.all([
    readShedInputs(),
    currentShedInputs(),
  ]);
  const mismatch = shedInputsMismatch(recorded, current);
  if (mismatch !== null) {
    throw new Error(mismatch);
  }
  console.error(
    `sheds: placed against ${current.files} committed key-space inputs stamped ${current.stamp},` +
      ` by a tiler whose key probe lands on ${current.keySpace}`,
  );
}

if (import.meta.main) {
  await checkShedInputs();
}
