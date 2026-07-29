// The 1 m LiDAR canopy height model every canopy polygon's height is measured from: a 47008 x
// 47697 uint16 GeoTIFF of decimetres over NAD83(2011) UTM 18N, thresholded to crown cores (its
// lowest reading is 2.1 m and 95% of its cells are nodata). It is downloaded once through the disk
// cache and handed to `tiler heights`, which samples it per polygon; nothing here reads a pixel.
// See scripts/README.md.

import { createHash } from "node:crypto";
import { cachedFile } from "./cache";

// One file of figshare doi 10.6084/m9.figshare.20522895 — NY_CHM_10Int260m.tif, the CHM behind Ma
// et al. 2023, "Individual structure mapping over six million trees for New York City" (Scientific
// Data 10, 102). `ndownloader` is figshare's own direct-download endpoint for a file id.
const DOWNLOAD_URL = "https://ndownloader.figshare.com/files/36733827";
const EXPECTED_BYTES = 243_383_277;
const EXPECTED_MD5 = "84e375d1ecfd090c8f5425a38fc6e957"; // figshare's own checksum for the file
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 5_000;
const PROGRESS_BYTES = 32 * 1024 * 1024;
const USER_AGENT =
  "scenic-route/0.1 (+https://github.com/erikbrinkman/scenic-route)";

export const CHM_ATTRIBUTION = "Canopy heights © Ma et al. 2023 (CC BY 4.0)";
export const CHM_SOURCE_URL = "https://doi.org/10.6084/m9.figshare.20522895";

// A quarter-gigabyte over one connection, so the read is streamed with progress rather than
// awaited in silence. The size and checksum are verified before the bytes are cached: an entry
// never expires, so a truncated download would otherwise stay truncated for good.
async function download(): Promise<Uint8Array> {
  const response = await fetch(DOWNLOAD_URL, {
    headers: { "user-agent": USER_AGENT },
  });
  if (!response.ok || response.body === null) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  const chunks: Uint8Array[] = [];
  let read = 0;
  let reported = 0;
  for await (const chunk of response.body) {
    chunks.push(chunk);
    read += chunk.length;
    if (read - reported >= PROGRESS_BYTES) {
      reported = read;
      console.error(`  chm: ${(read / 1024 / 1024).toFixed(0)} MiB read`);
    }
  }
  const bytes = new Uint8Array(Buffer.concat(chunks));
  const digest = createHash("md5").update(bytes).digest("hex");
  if (bytes.length !== EXPECTED_BYTES || digest !== EXPECTED_MD5) {
    throw new Error(
      `the CHM downloaded as ${bytes.length} bytes (md5 ${digest}), not ${EXPECTED_BYTES} (md5 ${EXPECTED_MD5})`,
    );
  }
  return bytes;
}

// The path of the cached raster, downloaded on the first run and served from .cache/ after.
export async function fetchChmRaster(): Promise<string> {
  return await cachedFile("figshare-nyc-chm", DOWNLOAD_URL, async () => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await download();
      } catch (error) {
        lastError = error;
        console.error(`  attempt ${attempt}/${MAX_ATTEMPTS} failed: ${error}`);
        if (attempt < MAX_ATTEMPTS) {
          await new Promise((resolve) =>
            setTimeout(resolve, RETRY_DELAY_MS * attempt),
          );
        }
      }
    }
    throw new Error(`the CHM download failed: ${lastError}`);
  });
}
