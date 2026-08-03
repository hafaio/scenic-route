// A slice of the real shed history, taken from the prototype that preceded this encoder and no
// longer exists in the tree. `SHEDS` and `COVERAGE` come from that prototype's CSV rows and a naive
// day scan, not from any encoder's byte layout, so a mistake shared by encoder and reader still
// fails — that is what the reader's oracle rests on.
//
// The three base64 blobs are NOT the prototype's. SHED names a span by the graph's
// durable key rather than by an edge id, a layout the prototype never wrote, so they are this
// encoder's own bytes: a regression pin rather than a foreign witness. The records above them are
// still foreign, and they are the half that says what the format has to mean.

export interface FixtureShed {
  first: number;
  close: number | null;
  confidence: number;
  spans: { edge: number; t0: number; t1: number }[];
}

// Coverage per edge on a day, as [edge, fraction] pairs ascending by edge.
export interface FixtureCoverage {
  day: number;
  edges: [number, number][];
}

export const OPEN_BASE64 =
  "U0hFRAIALwAEAAAACQAAALMOykiJWWKjAAAAAEAMAACpgpKNBFIF/AED/AEUtgEAOgPx6TAqAP8UAyEA/0YDHAD/OUCSAojpMCkARCIDJAA1FYgCkgO96DASAB0sAwkA/x8DBADXALYulgHJ6DAqHFc3";

export const CLOSED_BASE64 =
  "U0hFRAIAIAAiAAAAQwAAALMOykiJWWKjAAABAEAMAAAAAHoDrOkwAQD/AAM0AP82AysA/ykAALcBqekwChKQUAAAjgHz6DAseJw+BwfGAczoMCEvdSoAB9AB2OgwAVKqAAEIyQHb6DA0XP8oBQ3+BKXoMBoAFxYDEQD/SAMMAP87AwMu/wAADbUEjukwG1n/RwMSAP86AwkA/y0DBA7/AAEO/gT26DAj4/8xAxoA/yQDEQD/FwMMzf9JN0VgAtvoMDQA1SgDKwBIG1ugAe0BgOowAWWkAOIB7ALQAdjoMAFSqgCFAYcE0QGj6TAcboArAuwC/gGa6TAzP1wTsgGbA2YB7ukwM8r/IXHrAloTtekwIk//HAMZAP9OAxQA/0EDCwD/NAMCAP8AAzEA/xoDLAD/TAMjAP8/AxoA/zIDEQD/JQMMAP8YAwMA/wADMgD/PQMpAP8wAyQA/yMDGwD/FgMS2/9IAwkA/zsDBAD/ABP3BWsCt+gwJACQRgMbAP85sAGbAf4B8OgwMZGdS3SkBGYBxugwMwC6RACcA9EB6ugwCzRCJtYB5gJyAdXoMAp2/0JF2QGSAfrpMBNZbiz2AegBgQHt6DACQNMAPpEBwwKd6TAqr/9FAyEA9TjVAukCogHP6DAcqv0dswG1B9IBhekwMrTaL3XsA/4C5OgwGQDKQAMUBP8zCe0CvQG06DApY/QUmgHtAuQB0ugwE7TcT68B7QF5AeHoMCKIu00LiAN+Af3pMAqTxh+JArIB/gGC6TADDMgAIOwCqwGm6TATDv8eHB/+AbHoMDKdwiE=";

export const INDEX_BASE64 =
  "AAAgAAAAAAAEAEsAAAAHAD8AugAAAEUAmwDKAAAAoABxAdYAAACCAekB4wAAAAcCCALwAAAACQKhAvwAAAC7AhoDCQEAACwDOQNvAQAAPwPSA4ABAADvA0wEjQEAAGMEIAWlAQAAOQV8BbIBAAB+BW4GvgEAAHQGrAbLAQAAsgb6B9wBAAAHCLII6QEAALoIKwn2AQAALwnECRMCAADSCXkKIAIAAIEKjQs5AgAAlQupC0YCAAC1C8gLUgIAANEL";

export const GRAPH_HASH = "a362598948ca0eb3";

// The day the slice runs through, which the header carries so the daily job knows where to pick the
// feed up. The newest day any record touches.
export const LAST_DAY = 3136;

// Every edge id the fixture's spans stand on, ascending.
export const FIXTURE_EDGES: number[] = [];

// The job number `open.bin` names the record at `order` by. The slice came from the prototype's CSV
// rows, which carried no job numbers, so these are synthetic — ascending with the record, as the
// format requires, and covering both shapes the feed has issued so the codec is exercised either way.
export function fixtureJob(order: number): string {
  if (order < 2) {
    return String(104_416_464 + order);
  } else {
    return `M${String(1_300_000 + order).padStart(8, "0")}-${"ISZ"[order % 3]}1`;
  }
}

// The durable key the fixture's synthetic graph gives an edge. It runs DESCENDING in the edge id and
// spreads over all four sides and several ordinals, so a reader or encoder that quietly went on
// treating the key as a position fails rather than passing by luck.
export function fixtureDurable(edge: number): {
  sourceId: number;
  side: number;
  ordinal: number;
} {
  const rank = FIXTURE_EDGES.indexOf(edge);
  return {
    sourceId: 800_000 - 3 * rank,
    side: 1 + (rank % 4),
    ordinal: rank % 7,
  };
}

// The depth byte the fixture gives a span, in decimetres. The prototype's rows carry none — measuring
// the pavement postdates them — so this is synthetic, as the job numbers are: it walks the range the
// placement can produce and returns 0, "not measured", for one span in seven, so a codec that dropped
// the byte or slipped a span's worth of alignment fails rather than passing by luck.
export function fixtureDepth(edge: number): number {
  const rank = FIXTURE_EDGES.indexOf(edge);
  return rank % 7 === 0 ? 0 : 18 + ((rank * 13) % 63);
}

export const SHEDS: FixtureShed[] = [
  {
    first: 0,
    close: 7,
    confidence: 198,
    spans: [{ edge: 388579, t0: 47, t1: 117 }],
  },
  {
    first: 0,
    close: 7,
    confidence: 208,
    spans: [{ edge: 358014, t0: 82, t1: 170 }],
  },
  {
    first: 0,
    close: 8,
    confidence: 201,
    spans: [{ edge: 338934, t0: 92, t1: 255 }],
  },
  {
    first: 0,
    close: 13,
    confidence: 254,
    spans: [
      { edge: 429530, t0: 46, t1: 255 },
      { edge: 429531, t0: 0, t1: 255 },
      { edge: 429532, t0: 0, t1: 255 },
      { edge: 429533, t0: 0, t1: 23 },
    ],
  },
  {
    first: 0,
    close: 13,
    confidence: 181,
    spans: [
      { edge: 250072, t0: 14, t1: 255 },
      { edge: 250211, t0: 0, t1: 255 },
      { edge: 250511, t0: 0, t1: 255 },
      { edge: 250896, t0: 89, t1: 255 },
    ],
  },
  {
    first: 0,
    close: 14,
    confidence: 254,
    spans: [
      { edge: 297298, t0: 205, t1: 255 },
      { edge: 297554, t0: 0, t1: 255 },
      { edge: 297645, t0: 0, t1: 255 },
      { edge: 297733, t0: 227, t1: 255 },
    ],
  },
  {
    first: 0,
    close: 69,
    confidence: 96,
    spans: [
      { edge: 338657, t0: 0, t1: 72 },
      { edge: 338934, t0: 0, t1: 213 },
    ],
  },
  {
    first: 0,
    close: 160,
    confidence: 237,
    spans: [{ edge: 66574, t0: 101, t1: 164 }],
  },
  {
    first: 0,
    close: 519,
    confidence: 209,
    spans: [{ edge: 227338, t0: 110, t1: 128 }],
  },
  {
    first: 0,
    close: null,
    confidence: 58,
    spans: [
      { edge: 139148, t0: 0, t1: 255 },
      { edge: 139404, t0: 0, t1: 255 },
      { edge: 139743, t0: 0, t1: 255 },
    ],
  },
  {
    first: 0,
    close: 0,
    confidence: 122,
    spans: [
      { edge: 173005, t0: 0, t1: 255 },
      { edge: 173345, t0: 0, t1: 255 },
      { edge: 173738, t0: 0, t1: 255 },
    ],
  },
  {
    first: 0,
    close: 0,
    confidence: 183,
    spans: [{ edge: 205320, t0: 18, t1: 144 }],
  },
  {
    first: 0,
    close: 0,
    confidence: 142,
    spans: [{ edge: 309965, t0: 120, t1: 156 }],
  },
  {
    first: 22,
    close: 386,
    confidence: 208,
    spans: [{ edge: 358014, t0: 82, t1: 170 }],
  },
  {
    first: 32,
    close: null,
    confidence: 146,
    spans: [
      { edge: 272234, t0: 0, t1: 53 },
      { edge: 272235, t0: 0, t1: 68 },
    ],
  },
  {
    first: 72,
    close: 831,
    confidence: 107,
    spans: [
      { edge: 410793, t0: 0, t1: 255 },
      { edge: 410794, t0: 0, t1: 144 },
    ],
  },
  {
    first: 157,
    close: 521,
    confidence: 254,
    spans: [{ edge: 240999, t0: 63, t1: 92 }],
  },
  {
    first: 164,
    close: null,
    confidence: 146,
    spans: [
      { edge: 407431, t0: 0, t1: 215 },
      { edge: 407432, t0: 0, t1: 255 },
      { edge: 407901, t0: 0, t1: 29 },
    ],
  },
  {
    first: 288,
    close: 699,
    confidence: 102,
    spans: [{ edge: 144886, t0: 202, t1: 255 }],
  },
  {
    first: 449,
    close: 812,
    confidence: 90,
    spans: [
      { edge: 169224, t0: 0, t1: 255 },
      { edge: 169225, t0: 0, t1: 255 },
      { edge: 169235, t0: 219, t1: 255 },
      { edge: 169247, t0: 0, t1: 255 },
      { edge: 169257, t0: 0, t1: 255 },
      { edge: 169329, t0: 0, t1: 255 },
      { edge: 169516, t0: 0, t1: 255 },
      { edge: 169586, t0: 0, t1: 255 },
      { edge: 169669, t0: 0, t1: 255 },
      { edge: 169748, t0: 0, t1: 255 },
      { edge: 169944, t0: 0, t1: 255 },
      { edge: 170043, t0: 0, t1: 255 },
      { edge: 170111, t0: 0, t1: 255 },
      { edge: 170200, t0: 0, t1: 255 },
      { edge: 170285, t0: 0, t1: 255 },
      { edge: 170508, t0: 0, t1: 255 },
      { edge: 170612, t0: 0, t1: 255 },
      { edge: 170697, t0: 0, t1: 255 },
      { edge: 170782, t0: 79, t1: 255 },
    ],
  },
  {
    first: 575,
    close: 1123,
    confidence: 102,
    spans: [{ edge: 393153, t0: 0, t1: 186 }],
  },
  {
    first: 711,
    close: 1123,
    confidence: 209,
    spans: [{ edge: 315257, t0: 52, t1: 66 }],
  },
  {
    first: 852,
    close: 1007,
    confidence: 254,
    spans: [{ edge: 313614, t0: 145, t1: 157 }],
  },
  {
    first: 979,
    close: 1337,
    confidence: 114,
    spans: [{ edge: 366587, t0: 118, t1: 255 }],
  },
  {
    first: 1189,
    close: 1406,
    confidence: 146,
    spans: [{ edge: 130000, t0: 89, t1: 110 }],
  },
  {
    first: 1285,
    close: 2234,
    confidence: 210,
    spans: [{ edge: 281185, t0: 180, t1: 218 }],
  },
  {
    first: 1420,
    close: 1652,
    confidence: 129,
    spans: [{ edge: 314271, t0: 64, t1: 211 }],
  },
  {
    first: 1569,
    close: 1714,
    confidence: 195,
    spans: [
      { edge: 227926, t0: 0, t1: 245 },
      { edge: 228598, t0: 175, t1: 255 },
    ],
  },
  {
    first: 1694,
    close: 2055,
    confidence: 162,
    spans: [{ edge: 386289, t0: 170, t1: 253 }],
  },
  {
    first: 1859,
    close: 2351,
    confidence: 254,
    spans: [
      { edge: 322625, t0: 4, t1: 255 },
      { edge: 323221, t0: 0, t1: 202 },
    ],
  },
  {
    first: 1995,
    close: 2360,
    confidence: 189,
    spans: [{ edge: 427651, t0: 99, t1: 244 }],
  },
  {
    first: 2149,
    close: 2514,
    confidence: 228,
    spans: [{ edge: 386276, t0: 180, t1: 220 }],
  },
  {
    first: 2308,
    close: 2700,
    confidence: 126,
    spans: [{ edge: 108945, t0: 147, t1: 198 }],
  },
  {
    first: 2452,
    close: 2689,
    confidence: 121,
    spans: [{ edge: 329360, t0: 136, t1: 187 }],
  },
  {
    first: 2633,
    close: 2997,
    confidence: 171,
    spans: [{ edge: 210288, t0: 14, t1: 255 }],
  },
  {
    first: 2787,
    close: 2965,
    confidence: 254,
    spans: [{ edge: 291736, t0: 12, t1: 200 }],
  },
  {
    first: 2994,
    close: 3025,
    confidence: 254,
    spans: [{ edge: 428082, t0: 157, t1: 194 }],
  },
  {
    first: 3135,
    close: null,
    confidence: 150,
    spans: [{ edge: 388862, t0: 28, t1: 87 }],
  },
];

FIXTURE_EDGES.push(
  ...[
    ...new Set(SHEDS.flatMap((shed) => shed.spans.map((span) => span.edge))),
  ].sort((left, right) => left - right),
);

export const COVERAGE: FixtureCoverage[] = [
  {
    day: 0,
    edges: [
      [66574, 0.24705882352941178],
      [139148, 1.0],
      [139404, 1.0],
      [139743, 1.0],
      [173005, 1.0],
      [173345, 1.0],
      [173738, 1.0],
      [205320, 0.49411764705882355],
      [227338, 0.07058823529411765],
      [250072, 0.9450980392156862],
      [250211, 1.0],
      [250511, 1.0],
      [250896, 0.6509803921568628],
      [297298, 0.19607843137254902],
      [297554, 1.0],
      [297645, 1.0],
      [297733, 0.10980392156862745],
      [309965, 0.1411764705882353],
      [338657, 0.2823529411764706],
      [338934, 1.0],
      [358014, 0.34509803921568627],
      [388579, 0.27450980392156865],
      [429530, 0.8196078431372549],
      [429531, 1.0],
      [429532, 1.0],
      [429533, 0.09019607843137255],
    ],
  },
  {
    day: 52,
    edges: [
      [66574, 0.24705882352941178],
      [139148, 1.0],
      [139404, 1.0],
      [139743, 1.0],
      [227338, 0.07058823529411765],
      [272234, 0.20784313725490197],
      [272235, 0.26666666666666666],
      [338657, 0.2823529411764706],
      [338934, 0.8352941176470589],
      [358014, 0.34509803921568627],
    ],
  },
  {
    day: 157,
    edges: [
      [66574, 0.24705882352941178],
      [139148, 1.0],
      [139404, 1.0],
      [139743, 1.0],
      [227338, 0.07058823529411765],
      [240999, 0.11372549019607843],
      [272234, 0.20784313725490197],
      [272235, 0.26666666666666666],
      [358014, 0.34509803921568627],
      [410793, 1.0],
      [410794, 0.5647058823529412],
    ],
  },
  {
    day: 288,
    edges: [
      [139148, 1.0],
      [139404, 1.0],
      [139743, 1.0],
      [144886, 0.20784313725490197],
      [227338, 0.07058823529411765],
      [240999, 0.11372549019607843],
      [272234, 0.20784313725490197],
      [272235, 0.26666666666666666],
      [358014, 0.34509803921568627],
      [407431, 0.8431372549019608],
      [407432, 1.0],
      [407901, 0.11372549019607843],
      [410793, 1.0],
      [410794, 0.5647058823529412],
    ],
  },
  {
    day: 575,
    edges: [
      [139148, 1.0],
      [139404, 1.0],
      [139743, 1.0],
      [144886, 0.20784313725490197],
      [169224, 1.0],
      [169225, 1.0],
      [169235, 0.1411764705882353],
      [169247, 1.0],
      [169257, 1.0],
      [169329, 1.0],
      [169516, 1.0],
      [169586, 1.0],
      [169669, 1.0],
      [169748, 1.0],
      [169944, 1.0],
      [170043, 1.0],
      [170111, 1.0],
      [170200, 1.0],
      [170285, 1.0],
      [170508, 1.0],
      [170612, 1.0],
      [170697, 1.0],
      [170782, 0.6901960784313725],
      [272234, 0.20784313725490197],
      [272235, 0.26666666666666666],
      [393153, 0.7294117647058823],
      [407431, 0.8431372549019608],
      [407432, 1.0],
      [407901, 0.11372549019607843],
      [410793, 1.0],
      [410794, 0.5647058823529412],
    ],
  },
  {
    day: 852,
    edges: [
      [139148, 1.0],
      [139404, 1.0],
      [139743, 1.0],
      [272234, 0.20784313725490197],
      [272235, 0.26666666666666666],
      [313614, 0.047058823529411764],
      [315257, 0.054901960784313725],
      [393153, 0.7294117647058823],
      [407431, 0.8431372549019608],
      [407432, 1.0],
      [407901, 0.11372549019607843],
    ],
  },
  {
    day: 1189,
    edges: [
      [130000, 0.08235294117647059],
      [139148, 1.0],
      [139404, 1.0],
      [139743, 1.0],
      [272234, 0.20784313725490197],
      [272235, 0.26666666666666666],
      [366587, 0.5372549019607843],
      [407431, 0.8431372549019608],
      [407432, 1.0],
      [407901, 0.11372549019607843],
    ],
  },
  {
    day: 1420,
    edges: [
      [139148, 1.0],
      [139404, 1.0],
      [139743, 1.0],
      [272234, 0.20784313725490197],
      [272235, 0.26666666666666666],
      [281185, 0.14901960784313725],
      [314271, 0.5764705882352941],
      [407431, 0.8431372549019608],
      [407432, 1.0],
      [407901, 0.11372549019607843],
    ],
  },
  {
    day: 1694,
    edges: [
      [139148, 1.0],
      [139404, 1.0],
      [139743, 1.0],
      [227926, 0.9607843137254902],
      [228598, 0.3137254901960784],
      [272234, 0.20784313725490197],
      [272235, 0.26666666666666666],
      [281185, 0.14901960784313725],
      [386289, 0.3254901960784314],
      [407431, 0.8431372549019608],
      [407432, 1.0],
      [407901, 0.11372549019607843],
    ],
  },
  {
    day: 1995,
    edges: [
      [139148, 1.0],
      [139404, 1.0],
      [139743, 1.0],
      [272234, 0.20784313725490197],
      [272235, 0.26666666666666666],
      [281185, 0.14901960784313725],
      [322625, 0.984313725490196],
      [323221, 0.792156862745098],
      [386289, 0.3254901960784314],
      [407431, 0.8431372549019608],
      [407432, 1.0],
      [407901, 0.11372549019607843],
      [427651, 0.5686274509803921],
    ],
  },
  {
    day: 2308,
    edges: [
      [108945, 0.2],
      [139148, 1.0],
      [139404, 1.0],
      [139743, 1.0],
      [272234, 0.20784313725490197],
      [272235, 0.26666666666666666],
      [322625, 0.984313725490196],
      [323221, 0.792156862745098],
      [386276, 0.1568627450980392],
      [407431, 0.8431372549019608],
      [407432, 1.0],
      [407901, 0.11372549019607843],
      [427651, 0.5686274509803921],
    ],
  },
  {
    day: 2633,
    edges: [
      [108945, 0.2],
      [139148, 1.0],
      [139404, 1.0],
      [139743, 1.0],
      [210288, 0.9450980392156862],
      [272234, 0.20784313725490197],
      [272235, 0.26666666666666666],
      [329360, 0.2],
      [407431, 0.8431372549019608],
      [407432, 1.0],
      [407901, 0.11372549019607843],
    ],
  },
  {
    day: 2994,
    edges: [
      [139148, 1.0],
      [139404, 1.0],
      [139743, 1.0],
      [210288, 0.9450980392156862],
      [272234, 0.20784313725490197],
      [272235, 0.26666666666666666],
      [407431, 0.8431372549019608],
      [407432, 1.0],
      [407901, 0.11372549019607843],
      [428082, 0.1450980392156863],
    ],
  },
];
