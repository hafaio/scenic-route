// The document's base URL, handed to the worker at startup. Every data path the renderers fetch is
// relative so it picks up the basePath the Pages deploy injects; inside a worker a relative URL
// would instead resolve against the worker script under /_next/static/chunks/, so each one is
// resolved against the document explicitly.

let documentBase = "";

export function setBaseUrl(base: string): void {
  documentBase = base;
}

export function resolveUrl(path: string): string {
  return new URL(path, documentBase).href;
}
