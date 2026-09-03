// The RFC 4180 reader the ingests share. Hand-written for the reason `scripts/gtfs.ts` unzips by
// hand: these are build scripts reading a handful of published tables, and a dependency for either
// job would be larger than the job.
//
// `scripts/addresses.ts` keeps its own generator instead, and deliberately: the address exports it
// walks are tens of megabytes, so it yields a record at a time and projects to named columns as it
// goes, where this collects the whole table into rows.

export type CsvRow = Record<string, string>;

// Handles RFC 4180 quoting (a "" inside a quoted field is one literal quote) and both CRLF and LF
// line breaks; a leading UTF-8 BOM on the first cell is stripped so the first header name is not
// read as "﻿route_id". The first record is the header, and every later one is keyed by it.
export function parseCsv(text: string): CsvRow[] {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;
  for (let index = 0; index < clean.length; index++) {
    const char = clean[index];
    if (quoted) {
      if (char === '"') {
        if (clean[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      record.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && clean[index + 1] === "\n") {
        index += 1;
      }
      record.push(field);
      field = "";
      if (record.length > 1 || record[0] !== "") {
        rows.push(record);
      }
      record = [];
    } else {
      field += char;
    }
  }
  if (field !== "" || record.length > 0) {
    record.push(field);
    if (record.length > 1 || record[0] !== "") {
      rows.push(record);
    }
  }
  if (rows.length === 0) {
    return [];
  }
  const header = rows[0];
  return rows.slice(1).map((cells) => {
    const row: CsvRow = {};
    for (let column = 0; column < header.length; column++) {
      row[header[column]] = cells[column] ?? "";
    }
    return row;
  });
}
