import type { DocKind } from "./search-format";

// The messages between the search box and the worker that owns the city's name index. Everything the
// worker reads arrives here: it has no DOM, no map and no access to the app's stores, so the two
// files it holds are named as absolute URLs the page resolved against its own base.

export interface InitMessage {
  type: "init";
  city: string;
  searchUrl: string;
  // The address file, which is where a hit's label comes from: the index carries a street ORDINAL
  // and a place index, and only ADDR knows what those are called.
  addressUrl: string;
}

export interface QueryMessage {
  type: "query";
  id: number;
  text: string;
  // Where results are measured from: what the map is centred on.
  centre: { lat: number; lng: number };
  limit: number;
  // Which kinds of document may be answered with, since streets and stations still ride their own
  // paths into the search box and would otherwise be listed twice.
  kinds?: readonly DocKind[];
}

export type ToSearchWorker = InitMessage | QueryMessage;

// One answer, ready to be shown: the name and the line under it are both built in here, so nothing
// on the main thread has to hold the address file to label a result with its street and borough.
export interface IndexHit {
  kind: DocKind;
  name: string;
  label: string; // "205 E Houston St, Manhattan", or "" where the index knows of no address
  lat: number;
  lng: number;
  score: number;
  category: string | null; // the Overture slug, for the glyph
}

export interface ReadyMessage {
  type: "ready";
  city: string;
}

export interface ErrorMessage {
  type: "error";
  city: string;
  message: string;
}

export interface ResultsMessage {
  type: "results";
  id: number;
  hits: IndexHit[];
}

export type FromSearchWorker = ReadyMessage | ErrorMessage | ResultsMessage;
