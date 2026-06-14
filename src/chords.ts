// Chord wheel data.
// Nodes and edges live in /public/wheel-data.json. The user is the source
// of truth for the graph (built via the Builder mode). This file only
// turns the JSON into Chord objects with playable note arrays and colors.

export type ChordType = "maj" | "aug" | "dom7";

export type EdgeKind = "resolve" | "color" | "tension" | "chain" | "petal" | "custom";

export type Chord = {
  id: string;
  rootName: string;
  rootPc: number;
  type: ChordType;
  notes: string[]; // canonical chord: [bass3, root4, third4, fifth4, (seventh4)]
  // Color tones the engine can occasionally substitute for filigree: the
  // 9th, plus the 6th (major) or 13th (dom7). Always tasteful over the
  // parent chord, so they never sound out of place.
  colors: string[];
  x: number;
  y: number;
  color: string;
  label: string;
};

export type Edge = {
  from: string;
  to: string;
  kind: EdgeKind;
};

// Raw shape stored on disk. Edges have a "bidirectional" flag — when true,
// the loader emits both directions.
export type WheelNodeJson = {
  id: string;
  label: string;
  type: ChordType;
  x: number;
  y: number;
};

export type WheelEdgeJson = {
  from: string;
  to: string;
  kind: EdgeKind;
  bidirectional?: boolean;
};

export type WheelDataJson = {
  nodes: WheelNodeJson[];
  edges: WheelEdgeJson[];
};

export const WHEEL_SIZE = 800;

const ROOTS: { name: string; pc: number }[] = [
  { name: "C", pc: 0 },
  { name: "G", pc: 7 },
  { name: "D", pc: 2 },
  { name: "A", pc: 9 },
  { name: "E", pc: 4 },
  { name: "B", pc: 11 },
  { name: "Gb", pc: 6 },
  { name: "Db", pc: 1 },
  { name: "Ab", pc: 8 },
  { name: "Eb", pc: 3 },
  { name: "Bb", pc: 10 },
  { name: "F", pc: 5 },
];
const ROOT_BY_NAME: Record<string, number> = Object.fromEntries(
  ROOTS.map((r) => [r.name, r.pc]),
);

const PC_TO_NAME_SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const PC_TO_NAME_FLAT = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];

function spell(pc: number, preferFlat: boolean): string {
  const p = ((pc % 12) + 12) % 12;
  return preferFlat ? PC_TO_NAME_FLAT[p] : PC_TO_NAME_SHARP[p];
}

function buildNotes(rootPc: number, type: ChordType, preferFlat: boolean): {
  notes: string[];
  colors: string[];
} {
  const intervals = type === "maj" ? [0, 4, 7] : type === "aug" ? [0, 4, 8] : [0, 4, 7, 10];
  const bass = `${spell(rootPc, preferFlat)}3`;
  const mid = intervals.map((i) => {
    const pc = (rootPc + i) % 12;
    const oct = rootPc + i >= 12 ? 5 : 4;
    return `${spell(pc, preferFlat)}${oct}`;
  });
  // Tasteful color tones (9th + 6th/13th) used as occasional ornaments.
  // Both are diatonic over maj/dom7 and sound airy over aug. The 9th sits
  // an octave above the second; the 6th sits between fifth and root.
  const colorOf = (semis: number): string => {
    const pc = (rootPc + semis) % 12;
    const oct = 4 + Math.floor((rootPc + semis) / 12);
    return `${spell(pc, preferFlat)}${oct}`;
  };
  const colors = [colorOf(14), colorOf(9)]; // ninth (M9), sixth/13th (M6)
  return { notes: [bass, ...mid], colors };
}

// id is e.g. "C", "C+", "C7" — strip the suffix to get the root name.
function parseRoot(id: string): { rootName: string; rootPc: number } {
  const rootName = id.replace(/[+7]$/, "");
  const rootPc = ROOT_BY_NAME[rootName];
  if (rootPc === undefined) {
    throw new Error(`Unknown chord root: ${id}`);
  }
  return { rootName, rootPc };
}

const COLOR_MAJ = "#ef4f7c";
const COLOR_AUG = "#7ee787";
const COLOR_DOM = "#f5b342";

export function nodeToChord(n: WheelNodeJson): Chord {
  const { rootName, rootPc } = parseRoot(n.id);
  const preferFlat = rootName.includes("b") || rootName === "F";
  const color = n.type === "maj" ? COLOR_MAJ : n.type === "aug" ? COLOR_AUG : COLOR_DOM;
  const { notes, colors } = buildNotes(rootPc, n.type, preferFlat);
  return {
    id: n.id,
    rootName,
    rootPc,
    type: n.type,
    notes,
    colors,
    x: n.x,
    y: n.y,
    color,
    label: n.label,
  };
}

export type WheelData = {
  chords: Chord[];
  chordById: Record<string, Chord>;
  edges: Edge[];
  raw: WheelDataJson;
};

export function buildWheelData(json: WheelDataJson): WheelData {
  const chords = json.nodes.map(nodeToChord);
  const chordById: Record<string, Chord> = Object.fromEntries(
    chords.map((c) => [c.id, c]),
  );
  const edges: Edge[] = [];
  for (const e of json.edges) {
    edges.push({ from: e.from, to: e.to, kind: e.kind });
    if (e.bidirectional) {
      edges.push({ from: e.to, to: e.from, kind: e.kind });
    }
  }
  return { chords, chordById, edges, raw: json };
}

// Available chord graphs. Each is a curated subset of the wheel with its
// own personality — relaxing diatonic, plagal cycle, augmented mist, etc.
export type GraphInfo = {
  id: string;
  label: string;
  description: string;
  file: string;
};

export const GRAPHS: GraphInfo[] = [
  {
    id: "lullaby",
    label: "Lullaby in C",
    description: "Pure majors — C, F, G, B♭. Plagal motion, no augs, deeply relaxing.",
    file: "graphs/lullaby.json",
  },
  {
    id: "folk",
    label: "Folk Cadence",
    description: "Majors plus dom7 cadences. Warm V7 → I resolutions, no augs.",
    file: "graphs/folk-cadence.json",
  },
  {
    id: "cradle",
    label: "Cradle in C",
    description: "Diatonic C–F–G with soft aug color shimmers. Anchored, lullaby-like.",
    file: "graphs/cradle.json",
  },
  {
    id: "plagal",
    label: "Plagal Drift",
    description: "Descending fourths around the wheel. Wave-like, always returns home.",
    file: "graphs/plagal-drift.json",
  },
  {
    id: "mist",
    label: "Whole-Tone Mist",
    description: "Augmented pairs drift between two major anchors. Dreamy, ungrounded.",
    file: "graphs/whole-tone-mist.json",
  },
  {
    id: "full",
    label: "Full Wheel",
    description: "All 36 chords with the complete connection map.",
    file: "wheel-data.json",
  },
];

export const DEFAULT_GRAPH_ID = "folk";

export async function loadWheelData(graphId: string = DEFAULT_GRAPH_ID): Promise<WheelData> {
  const info = GRAPHS.find((g) => g.id === graphId) ?? GRAPHS[0];
  const res = await fetch(`${import.meta.env.BASE_URL}${info.file}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load ${info.file}: ${res.status}`);
  const json = (await res.json()) as WheelDataJson;
  return buildWheelData(json);
}
