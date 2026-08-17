// Prints the first day of the DOB's history `bun run update-sheds` has to read, and nothing else.
// package.json needs that day twice before any of the walk runs — once to say how deep to clone the
// feed, once to say which blobs to stream — and the only place it can come from is the artifact's own
// header, which says the day it was built through.

import { shedWindow } from "./update-sheds";

console.log(await shedWindow());
