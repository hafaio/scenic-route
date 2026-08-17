// The middle of the git pipeline every shed script runs behind: it reads the commit index
// `git cat-file --batch-check` wrote and prints the blobs the walk needs, one id a line, for the
// `git cat-file --batch` that streams them back.
//
// `--from <day>` drops the commits before that day, which is how `bun run update-sheds` streams a
// month of history rather than nine years of it. The script at the far end of the pipe is given the
// same day, because it reads the same index to know which blob answers which commit.

import { distinctBlobs, loadSnapshotIndex } from "./shed-permits";

const [index, flag, from] = process.argv.slice(2);
if (
  index === undefined ||
  (flag !== undefined && (flag !== "--from" || from === undefined))
) {
  throw new Error(
    "usage: bun run scripts/shed-blobs.ts <commit index> [--from <day>]",
  );
}
const sources = await loadSnapshotIndex(index, from);
// An empty request is left empty rather than written as a blank line, which git answers by dying on
// a query that is not an object name.
process.stdout.write(
  distinctBlobs(sources)
    .map((blob) => `${blob}\n`)
    .join(""),
);
