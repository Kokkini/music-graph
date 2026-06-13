import * as Tone from "tone";

import type { ChordType } from "./chords";

export type Instrument =
  | "piano"
  | "soft"
  | "ep"
  | "strings"
  | "bell"
  | "organ"
  | "pluck"
  | "kalimba"
  | "guitar";

export const INSTRUMENTS: { id: Instrument; label: string }[] = [
  { id: "piano", label: "Piano" },
  { id: "soft", label: "Soft pad" },
  { id: "ep", label: "Electric piano" },
  { id: "strings", label: "Strings" },
  { id: "bell", label: "Bell" },
  { id: "organ", label: "Organ" },
  { id: "pluck", label: "Pluck" },
  { id: "kalimba", label: "Kalimba" },
  { id: "guitar", label: "Guitar" },
];

type ChordSynth = Tone.PolySynth | Tone.Sampler;
let synth: ChordSynth | null = null;
let reverb: Tone.Reverb | null = null;
let loop: Tone.Loop | null = null;
let started = false;
let stepIndex = 0;
let currentInstrument: Instrument = "piano";

type ActiveChord = { notes: string[]; colors: string[]; type: ChordType; rootPc: number };
let active: ActiveChord | null = null;

// chord.notes layout from chords.ts:
//   maj/aug: [bass3, root4, third4, fifth4]   indices 0..3
//   dom7:    [bass3, root4, third4, fifth4, seventh4]   indices 0..4
//
// Patterns now have two parallel tracks — `lh` (left hand) and `rh` (right
// hand) — so each "hand" can carry its own rhythm. RH uses chord.notes as-is
// (upper register); LH plays the same indices but transposed down an octave
// (except index 0 which is already bass3). This keeps the hands in distinct
// registers and makes single-instrument patches sound piano-ish.
//
// A Step is the set of indices to strike on this 8th-note tick; null = rest.
// Patterns are 2 bars long (16 steps, 12 for waltz) so consecutive bars vary.
type Step = number[] | null;
type PatternBars = { lh: Step[]; rh: Step[] };

function lowerOctave(note: string): string {
  const m = note.match(/^([A-G][#b]?)(-?\d+)$/);
  if (!m) return note;
  return m[1] + String(parseInt(m[2], 10) - 1);
}

function lhNote(notes: string[], i: number): string | undefined {
  const n = notes[i];
  if (!n) return undefined;
  return i === 0 ? n : lowerOctave(n);
}

// ---- Melody layer ---------------------------------------------------------
// A real (if simple) tune over the harmony, built from a small library of
// hand-written motifs written in *scale degrees* — each is a shape, not fixed
// pitches. When a chord is active we pick a motif, spell it in a scale derived
// from that chord (major / mixolydian / whole-tone), and play it an octave
// above the accompaniment. Because the fragments are human-written they carry
// intentional contour, rhythm and rests — what makes a line sing, not noodle.
type MelodyEvent = { deg: number; dur: number }; // deg 0 = rest; dur in 8th notes

// Each motif sums to 8 eighth notes (one 4/4 bar). Degree 1 = chord root,
// 3/5 = chord tones (fall on the strong starts), 2/4/6/7 = passing/neighbor
// tones, 8 = octave. Long notes + rests give each fragment its shape.
const MOTIFS: MelodyEvent[][] = [
  [{ deg: 5, dur: 2 }, { deg: 4, dur: 1 }, { deg: 3, dur: 1 }, { deg: 2, dur: 2 }, { deg: 1, dur: 2 }],
  [{ deg: 1, dur: 1 }, { deg: 3, dur: 1 }, { deg: 5, dur: 2 }, { deg: 3, dur: 1 }, { deg: 2, dur: 1 }, { deg: 1, dur: 2 }],
  [{ deg: 3, dur: 2 }, { deg: 5, dur: 2 }, { deg: 0, dur: 1 }, { deg: 5, dur: 1 }, { deg: 3, dur: 1 }, { deg: 1, dur: 1 }],
  [{ deg: 5, dur: 3 }, { deg: 6, dur: 1 }, { deg: 5, dur: 2 }, { deg: 3, dur: 2 }],
  [{ deg: 1, dur: 2 }, { deg: 2, dur: 1 }, { deg: 3, dur: 2 }, { deg: 5, dur: 3 }],
  [{ deg: 8, dur: 2 }, { deg: 7, dur: 1 }, { deg: 5, dur: 2 }, { deg: 3, dur: 1 }, { deg: 5, dur: 2 }],
  [{ deg: 0, dur: 2 }, { deg: 3, dur: 1 }, { deg: 5, dur: 1 }, { deg: 8, dur: 2 }, { deg: 5, dur: 2 }],
  [{ deg: 5, dur: 1 }, { deg: 5, dur: 1 }, { deg: 6, dur: 1 }, { deg: 5, dur: 1 }, { deg: 3, dur: 2 }, { deg: 1, dur: 2 }],
  [{ deg: 1, dur: 2 }, { deg: 5, dur: 2 }, { deg: 8, dur: 2 }, { deg: 5, dur: 2 }],
  [{ deg: 3, dur: 2 }, { deg: 2, dur: 1 }, { deg: 1, dur: 1 }, { deg: 2, dur: 2 }, { deg: 3, dur: 2 }],
];

const MELODY_OCTAVE = 5;
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const SCALE_MAJOR = [0, 2, 4, 5, 7, 9, 11];
const SCALE_MIXO = [0, 2, 4, 5, 7, 9, 10]; // dom7: flat 7
const SCALE_WHOLE = [0, 2, 4, 6, 8, 10]; // aug: whole-tone, matches its unease

function scaleFor(type: ChordType): number[] {
  return type === "dom7" ? SCALE_MIXO : type === "aug" ? SCALE_WHOLE : SCALE_MAJOR;
}

// Spell a scale degree (1-based, may exceed the octave) as a concrete note
// name above `rootPc`, starting at MELODY_OCTAVE.
function degToNote(rootPc: number, scale: number[], deg: number): string {
  const idx = deg - 1;
  const len = scale.length;
  const oct = Math.floor(idx / len);
  const within = ((idx % len) + len) % len;
  const total = rootPc + scale[within] + 12 * oct;
  const pc = ((total % 12) + 12) % 12;
  const octave = MELODY_OCTAVE + Math.floor(total / 12);
  return NOTE_NAMES[pc] + octave;
}

let melodyEnabled = true;
let melodyNote: (string | null)[] = []; // onset note per step of the current bar
let melodyDur: number[] = []; // duration (in steps) of the onset at that step
let lastMotif = -1;

// Lay the chosen motif onto a fresh per-bar grid. Called at each bar start so a
// held chord gets a new (non-repeating) phrase every bar and chord changes are
// picked up at the next bar boundary.
function renderMelodyBar(barLen: number): void {
  melodyNote = new Array(barLen).fill(null);
  melodyDur = new Array(barLen).fill(0);
  if (!active) return;
  let mi = Math.floor(Math.random() * MOTIFS.length);
  if (MOTIFS.length > 1 && mi === lastMotif) mi = (mi + 1) % MOTIFS.length;
  lastMotif = mi;
  const scale = scaleFor(active.type);
  // Lay back on ~35% of bars: start the phrase a step late so the melody
  // doesn't articulate beat 1 every single bar — a big part of the metronomic
  // feel comes from the soprano hitting the downbeat in lockstep with the bass.
  let cursor = Math.random() < 0.35 ? 1 : 0;
  for (const ev of MOTIFS[mi]) {
    if (cursor >= barLen) break;
    if (ev.deg > 0) {
      melodyNote[cursor] = degToNote(active.rootPc, scale, ev.deg);
      melodyDur[cursor] = Math.min(ev.dur, barLen - cursor);
    }
    cursor += ev.dur;
  }
}

export type Pattern =
  | "drift"
  | "float"
  | "lull"
  | "ripple"
  | "einaudi"
  | "nuvole"
  | "ballad"
  | "wave"
  | "rise"
  | "alberti"
  | "block"
  | "bounce"
  | "waltz"
  | "prelude"
  | "brook"
  | "cascade"
  | "aria"
  | "comp";

// `bpm` is the sweet-spot tempo for the pattern — slow ambient patterns
// breathe at 55–66, Einaudi-style flows sit around 72, drivers push 90+.
export const PATTERNS: { id: Pattern; label: string; bpm: number }[] = [
  { id: "drift", label: "Drift (ambient)", bpm: 56 },
  { id: "float", label: "Float (pad)", bpm: 60 },
  { id: "lull", label: "Lull (sparse arp)", bpm: 64 },
  { id: "ripple", label: "Ripple (gentle)", bpm: 68 },
  { id: "einaudi", label: "Einaudi (rolling)", bpm: 72 },
  { id: "nuvole", label: "Nuvole (wide pedal)", bpm: 74 },
  { id: "ballad", label: "Ballad", bpm: 76 },
  { id: "wave", label: "Wave", bpm: 80 },
  { id: "rise", label: "Rise", bpm: 84 },
  { id: "alberti", label: "Alberti", bpm: 92 },
  { id: "block", label: "Block stab", bpm: 96 },
  { id: "bounce", label: "Bounce", bpm: 100 },
  { id: "waltz", label: "Waltz (3/4)", bpm: 96 },
  { id: "prelude", label: "Prelude (fast LH)", bpm: 66 },
  { id: "brook", label: "Brook (rippling LH)", bpm: 62 },
  { id: "cascade", label: "Cascade (falling LH)", bpm: 70 },
  { id: "aria", label: "Aria (flowing RH)", bpm: 70 },
  { id: "comp", label: "Comp (syncopated RH)", bpm: 84 },
];

export function getPatternBpm(p: Pattern): number {
  return PATTERNS.find((x) => x.id === p)?.bpm ?? 78;
}

const PATTERN_DATA: Record<Pattern, { triad: PatternBars; dom7: PatternBars }> = {
  // Ambient hum. LH holds bass each bar. RH whispers a fifth, blooms mid bar B.
  drift: {
    triad: {
      lh: [
        [0], null, null, null, null, null, null, null,
        [0], null, null, null, null, null, null, null,
      ],
      rh: [
        [3], null, null, null, null, null, null, null,
        [3], null, null, null, [1, 3], null, null, null,
      ],
    },
    dom7: {
      lh: [
        [0], null, null, null, null, null, null, null,
        [0], null, null, null, null, null, null, null,
      ],
      rh: [
        [3], null, null, null, null, null, null, null,
        [3], null, null, null, [1, 4], null, null, null,
      ],
    },
  },
  // Soft chord stab. LH bass downbeat per bar. RH chord on 1; bar B re-blooms.
  float: {
    triad: {
      lh: [
        [0], null, null, null, null, null, null, null,
        [0], null, null, null, null, null, null, null,
      ],
      rh: [
        [1, 2, 3], null, null, null, null, null, null, null,
        [1, 2, 3], null, null, null, [1, 2, 3], null, null, null,
      ],
    },
    dom7: {
      lh: [
        [0], null, null, null, null, null, null, null,
        [0], null, null, null, null, null, null, null,
      ],
      rh: [
        [1, 2, 3, 4], null, null, null, null, null, null, null,
        [1, 2, 3, 4], null, null, null, [1, 2, 3, 4], null, null, null,
      ],
    },
  },
  // Sparse arp. LH bass each bar. RH walks chord tones with lots of air.
  lull: {
    triad: {
      lh: [
        [0], null, null, null, null, null, null, null,
        [0], null, null, null, null, null, null, null,
      ],
      rh: [
        null, null, [1], null, [2], null, [3], null,
        null, null, [2], null, [3], null, [1], null,
      ],
    },
    dom7: {
      lh: [
        [0], null, null, null, null, null, null, null,
        [0], null, null, null, null, null, null, null,
      ],
      rh: [
        null, null, [1], null, [3], null, [4], null,
        null, null, [3], null, [4], null, [2], null,
      ],
    },
  },
  // Gentle descending sparkle. LH bass on 1 and 5. RH ripples.
  ripple: {
    triad: {
      lh: [
        [0], null, null, null, [0], null, null, null,
        [0], null, null, null, [0], null, null, null,
      ],
      rh: [
        [3], null, [2], null, [1], null, [3], null,
        [2], null, [3], null, [1, 3], null, [2], null,
      ],
    },
    dom7: {
      lh: [
        [0], null, null, null, [0], null, null, null,
        [0], null, null, null, [0], null, null, null,
      ],
      rh: [
        [4], null, [3], null, [2], null, [4], null,
        [3], null, [4], null, [2, 4], null, [3], null,
      ],
    },
  },
  // Einaudi: rolling LH arpeggio in the low register; RH holds top tones above.
  // This is the classic "left hand carries the motion" piano feel.
  einaudi: {
    triad: {
      lh: [
        [0], [2], [3], [2], [0], [2], [3], [2],
        [0], [3], [2], [3], [0], [2], [3], [2],
      ],
      rh: [
        [1, 2, 3], null, null, null, [3], null, null, null,
        [1, 2, 3], null, null, null, [2], null, null, null,
      ],
    },
    dom7: {
      lh: [
        [0], [2], [4], [2], [0], [3], [4], [3],
        [0], [4], [3], [2], [0], [3], [4], [3],
      ],
      rh: [
        [1, 2, 3, 4], null, null, null, [4], null, null, null,
        [1, 2, 3, 4], null, null, null, [3], null, null, null,
      ],
    },
  },
  // Nuvole: LH sustains an open bass+fifth pedal; RH rolls chord tones above.
  nuvole: {
    triad: {
      lh: [
        [0, 3], null, null, null, [0, 3], null, null, null,
        [0, 3], null, null, null, [0, 3], null, null, null,
      ],
      rh: [
        [1], [2], [1], [3], [1], [2], [1], [3],
        [1], [2], [3], [2], [1], [3], [2], [3],
      ],
    },
    dom7: {
      lh: [
        [0, 3], null, null, null, [0, 3], null, null, null,
        [0, 3], null, null, null, [0, 3], null, null, null,
      ],
      rh: [
        [1], [2], [1], [4], [1], [2], [1], [4],
        [1], [2], [3], [4], [1], [3], [4], [2],
      ],
    },
  },
  // Ballad: LH half-note pulse on 1 and 5; RH carries a singing melody line.
  ballad: {
    triad: {
      lh: [
        [0], null, null, null, [0], null, null, null,
        [0], null, null, null, [0], null, null, null,
      ],
      rh: [
        [2], null, null, [3], null, [1, 3], null, [2],
        [2], null, [3], null, [1, 2, 3], null, [3], [2],
      ],
    },
    dom7: {
      lh: [
        [0], null, null, null, [0], null, null, null,
        [0], null, null, null, [0], null, null, null,
      ],
      rh: [
        [2], null, null, [4], null, [1, 3], null, [2],
        [2], null, [4], null, [1, 2, 3], null, [4], [3],
      ],
    },
  },
  // Wave: LH bass on 1 and 5; RH opens with chord then flows.
  wave: {
    triad: {
      lh: [
        [0], null, null, null, [0], null, null, null,
        [0], null, null, null, [0], null, null, null,
      ],
      rh: [
        [1, 2, 3], [3], [2], [1, 3], [1, 2, 3], [3], [2], [1],
        [1, 2, 3], [3], [2], [1], [2], [3], [1, 3], [2],
      ],
    },
    dom7: {
      lh: [
        [0], null, null, null, [0], null, null, null,
        [0], null, null, null, [0], null, null, null,
      ],
      rh: [
        [1, 2, 3, 4], [4], [3], [2, 4], [1, 2, 3, 4], [4], [3], [2],
        [1, 2, 3, 4], [4], [3], [2], [3], [4], [2, 4], [3],
      ],
    },
  },
  // Rise: LH bass per bar; RH climbs to a chord at the peak, then descends.
  rise: {
    triad: {
      lh: [
        [0], null, null, null, [0], null, null, null,
        [0], null, null, null, [0], null, null, null,
      ],
      rh: [
        [1], [2], [3], null, [1, 2, 3], [3], [2], [1, 3],
        [3], [2], [1], null, [1, 2, 3], [1], [2], [3],
      ],
    },
    dom7: {
      lh: [
        [0], null, null, null, [0], null, null, null,
        [0], null, null, null, [0], null, null, null,
      ],
      rh: [
        [1], [2], [3], null, [1, 2, 3, 4], [4], [3], [2, 4],
        [4], [3], [2], null, [1, 2, 3, 4], [1], [3], [4],
      ],
    },
  },
  // Alberti: classic LH broken-chord (bass-fifth-third-fifth); RH holds top.
  alberti: {
    triad: {
      lh: [
        [0], [3], [2], [3], [0], [3], [2], [3],
        [0], [3], [2], [3], [0], [3], [2], [3],
      ],
      rh: [
        [1, 2, 3], null, null, null, null, null, null, null,
        [1, 2, 3], null, null, null, [2, 3], null, null, null,
      ],
    },
    dom7: {
      lh: [
        [0], [3], [2], [3], [0], [3], [4], [3],
        [0], [3], [2], [3], [0], [3], [4], [3],
      ],
      rh: [
        [1, 2, 3, 4], null, null, null, null, null, null, null,
        [1, 2, 3, 4], null, null, null, [2, 3, 4], null, null, null,
      ],
    },
  },
  // Block: LH pulses the bass; RH hammers chord stabs with a breath in bar B.
  block: {
    triad: {
      lh: [
        [0], null, [0], null, [0], null, [0], null,
        [0], null, [0], null, [0], null, [0], null,
      ],
      rh: [
        [1, 2, 3], null, [1, 2, 3], null, [1, 2, 3], null, [1, 2, 3], null,
        [1, 2, 3], null, [1, 2, 3], null, [1, 2, 3], null, null, [1, 2, 3],
      ],
    },
    dom7: {
      lh: [
        [0], null, [0], null, [0], null, [0], null,
        [0], null, [0], null, [0], null, [0], null,
      ],
      rh: [
        [1, 2, 3, 4], null, [1, 2, 3, 4], null, [1, 2, 3, 4], null, [1, 2, 3, 4], null,
        [1, 2, 3, 4], null, [1, 2, 3, 4], null, [1, 2, 3, 4], null, null, [1, 2, 3, 4],
      ],
    },
  },
  // Bounce: LH bass on every beat; RH chord upstrokes on offbeats (reggae feel).
  bounce: {
    triad: {
      lh: [
        [0], null, [0], null, [0], null, [0], null,
        [0], null, [0], null, [0], null, [0], null,
      ],
      rh: [
        null, [1, 2, 3], null, [1, 2, 3], null, [1, 2, 3], null, [1, 2, 3],
        null, [1, 2, 3], null, [1, 3], null, [1, 2, 3], null, [1, 2, 3],
      ],
    },
    dom7: {
      lh: [
        [0], null, [0], null, [0], null, [0], null,
        [0], null, [0], null, [0], null, [0], null,
      ],
      rh: [
        null, [1, 2, 3, 4], null, [1, 2, 3, 4], null, [1, 2, 3, 4], null, [1, 2, 3, 4],
        null, [1, 2, 3, 4], null, [1, 3], null, [2, 4], null, [1, 2, 3, 4],
      ],
    },
  },
  // Prelude (Bach-style): LH runs continuous 16th notes — twice the speed of
  // every other pattern. RH is sparse so the rolling LH stays in focus.
  // LH array is 32 slots (16 per bar); the loop reads 2 LH steps per 8th-note
  // tick. RH stays at 16 slots like every other pattern.
  prelude: {
    triad: {
      lh: [
        // Bar A — classic bass-fifth-third-fifth, 4 cells per beat.
        [0], [3], [2], [3], [0], [3], [2], [3], [0], [3], [2], [3], [0], [3], [2], [3],
        // Bar B — last beat varies so the cycle breathes.
        [0], [3], [2], [3], [0], [3], [2], [3], [0], [3], [2], [3], [0], [2], [3], [2],
      ],
      rh: [
        [1, 2, 3], null, null, null, null, null, null, null,
        null, null, null, null, [2], null, null, null,
      ],
    },
    dom7: {
      lh: [
        // Insert the 7th in the inner voice for that Bach-prelude tension.
        [0], [3], [4], [3], [0], [3], [4], [3], [0], [3], [4], [3], [0], [3], [4], [3],
        [0], [3], [4], [3], [0], [3], [4], [3], [0], [3], [4], [3], [0], [4], [3], [2],
      ],
      rh: [
        [1, 2, 3, 4], null, null, null, null, null, null, null,
        null, null, null, null, [3], null, null, null,
      ],
    },
  },
  // Brook: gentle 16th-note tremolo. LH oscillates fifth↔third over bass
  // anchors — water trickling over stones. RH lays down a soft pedaled chord
  // on each bar's downbeat (held a full bar by the loop's `lhSubdivide`-aware
  // duration) plus a mid-bar B re-bloom so the two downbeats don't sound like
  // isolated stabs above the running LH.
  brook: {
    triad: {
      lh: [
        [0], [3], [2], [3], [2], [3], [2], [3], [2], [3], [2], [3], [2], [3], [2], [3],
        [0], [3], [2], [3], [2], [3], [2], [3], [2], [3], [2], [3], [2], [3], [3], [2],
      ],
      rh: [
        [1, 2, 3], null, null, null, null, null, null, null,
        [1, 2, 3], null, null, null, [1, 2, 3], null, null, null,
      ],
    },
    dom7: {
      lh: [
        [0], [3], [4], [3], [2], [3], [4], [3], [2], [3], [4], [3], [2], [3], [4], [3],
        [0], [3], [4], [3], [2], [3], [4], [3], [2], [3], [4], [3], [2], [4], [3], [2],
      ],
      rh: [
        [1, 2, 3, 4], null, null, null, null, null, null, null,
        [1, 2, 3, 4], null, null, null, [1, 2, 3, 4], null, null, null,
      ],
    },
  },
  // Cascade: descending 16th-note shower (fifth → third → bass → third), like
  // rain off a roof. RH leaves room so the downward motion stays in focus.
  cascade: {
    triad: {
      lh: [
        [3], [2], [0], [2], [3], [2], [0], [2], [3], [2], [0], [2], [3], [2], [0], [2],
        [3], [2], [0], [2], [3], [2], [0], [2], [3], [2], [0], [2], [3], [0], [2], [3],
      ],
      rh: [
        [1, 2, 3], null, null, null, null, null, null, null,
        null, null, null, null, [3], null, null, null,
      ],
    },
    dom7: {
      lh: [
        [4], [3], [0], [2], [4], [3], [0], [2], [4], [3], [0], [2], [4], [3], [0], [2],
        [4], [3], [0], [2], [4], [3], [0], [2], [4], [3], [0], [2], [4], [0], [2], [3],
      ],
      rh: [
        [1, 2, 3, 4], null, null, null, null, null, null, null,
        null, null, null, null, [4], null, null, null,
      ],
    },
  },
  // Aria: a single flowing right-hand line — a pure broken-chord arpeggio, no
  // block stab interrupting it. The LH holds an open bass+fifth pedal (re-bloomed
  // mid-bar) so the harmony sits underneath while the RH undulates up and down
  // through the chord tones. Off-beat notes ornament heavily (see the loop) so
  // the line keeps reaching to the 9th / 13th and feels like it's singing rather
  // than circling three notes. This is the Einaudi/Nuvole idiom, widened.
  aria: {
    triad: {
      lh: [
        [0, 3], null, null, null, [0, 3], null, null, null,
        [0, 3], null, null, null, [0, 3], null, null, null,
      ],
      rh: [
        [1], [2], [3], [2], [1], [2], [3], [2],
        [3], [2], [1], [2], [3], [2], [1], [2],
      ],
    },
    dom7: {
      lh: [
        [0, 3], null, null, null, [0, 3], null, null, null,
        [0, 3], null, null, null, [0, 3], null, null, null,
      ],
      rh: [
        [1], [2], [3], [4], [3], [2], [1], [2],
        [4], [3], [2], [1], [2], [3], [4], [3],
      ],
    },
  },
  // Comp: rhythmic comping — the right hand plays the *chord* in a syncopated
  // groove (downbeat, the "and" of 2, beat 3, with an anticipation pushing into
  // the next bar) instead of single-note filigree. LH is a simple bass pulse.
  // This is the pop/gospel idiom: harmony with rhythmic life, struck together
  // (no roll) so the syncopation reads cleanly.
  comp: {
    triad: {
      lh: [
        [0], null, null, null, [0], null, null, null,
        [0], null, null, null, [0], null, null, null,
      ],
      rh: [
        [1, 2, 3], null, null, [1, 2, 3], null, [1, 2, 3], null, null,
        [1, 2, 3], null, null, [1, 2, 3], null, [1, 2, 3], null, [1, 2, 3],
      ],
    },
    dom7: {
      lh: [
        [0], null, null, null, [0], null, null, null,
        [0], null, null, null, [0], null, null, null,
      ],
      rh: [
        [1, 2, 3, 4], null, null, [1, 2, 3, 4], null, [1, 2, 3, 4], null, null,
        [1, 2, 3, 4], null, null, [1, 2, 3, 4], null, [1, 2, 3, 4], null, [1, 2, 3, 4],
      ],
    },
  },
  // Waltz (3/4, 6 eighths × 2 bars = 12 steps).
  // LH bass on beat 1; RH chord on beats 2 and 3 — classic oom-pah-pah.
  waltz: {
    triad: {
      lh: [
        [0], null, null, null, null, null,
        [0], null, null, null, null, null,
      ],
      rh: [
        null, [1, 2, 3], [1, 2, 3], null, [1, 2, 3], [1, 2, 3],
        null, [1, 2, 3], [1, 3], null, [1, 2, 3], [2, 3],
      ],
    },
    dom7: {
      lh: [
        [0], null, null, null, null, null,
        [0], null, null, null, null, null,
      ],
      rh: [
        null, [1, 2, 3, 4], [1, 2, 3, 4], null, [1, 2, 3, 4], [1, 2, 3, 4],
        null, [1, 2, 3, 4], [1, 3, 4], null, [1, 2, 3, 4], [2, 3, 4],
      ],
    },
  },
};

let currentPattern: Pattern = "aria";

function buildSynth(instr: Instrument): ChordSynth {
  switch (instr) {
    case "piano":
      // Salamander Grand Piano samples hosted by Tone.js.
      return new Tone.Sampler({
        urls: {
          A1: "A1.mp3",
          C2: "C2.mp3",
          "D#2": "Ds2.mp3",
          "F#2": "Fs2.mp3",
          A2: "A2.mp3",
          C3: "C3.mp3",
          "D#3": "Ds3.mp3",
          "F#3": "Fs3.mp3",
          A3: "A3.mp3",
          C4: "C4.mp3",
          "D#4": "Ds4.mp3",
          "F#4": "Fs4.mp3",
          A4: "A4.mp3",
          C5: "C5.mp3",
          "D#5": "Ds5.mp3",
          "F#5": "Fs5.mp3",
          A5: "A5.mp3",
        },
        release: 1,
        baseUrl: "https://tonejs.github.io/audio/salamander/",
        volume: -8,
      });
    case "ep":
      return new Tone.PolySynth(Tone.FMSynth, {
        harmonicity: 3,
        modulationIndex: 10,
        oscillator: { type: "sine" },
        envelope: { attack: 0.002, decay: 0.8, sustain: 0, release: 1.2 },
        modulation: { type: "sine" },
        modulationEnvelope: { attack: 0.002, decay: 0.5, sustain: 0, release: 0.5 },
        volume: -14,
      });
    case "strings":
      return new Tone.PolySynth(Tone.Synth, {
        oscillator: { type: "sawtooth" },
        envelope: { attack: 0.35, decay: 0.2, sustain: 0.7, release: 1.4 },
        volume: -19,
      });
    case "bell":
      return new Tone.PolySynth(Tone.FMSynth, {
        harmonicity: 8,
        modulationIndex: 12,
        oscillator: { type: "sine" },
        envelope: { attack: 0.001, decay: 1.5, sustain: 0, release: 1.5 },
        modulation: { type: "sine" },
        modulationEnvelope: { attack: 0.001, decay: 0.5, sustain: 0, release: 0.5 },
        volume: -14,
      });
    case "organ":
      return new Tone.PolySynth(Tone.Synth, {
        oscillator: { type: "square" },
        envelope: { attack: 0.005, decay: 0, sustain: 1, release: 0.2 },
        volume: -20,
      });
    case "pluck":
      return new Tone.PolySynth(Tone.Synth, {
        oscillator: { type: "triangle" },
        envelope: { attack: 0.001, decay: 0.25, sustain: 0, release: 0.4 },
        volume: -12,
      });
    case "kalimba":
      // Bright metallic tine with quick decay — FM with high harmonicity gives
      // that thumb-piano ping. Short release keeps notes from smearing together.
      return new Tone.PolySynth(Tone.FMSynth, {
        harmonicity: 6,
        modulationIndex: 18,
        oscillator: { type: "sine" },
        envelope: { attack: 0.001, decay: 0.6, sustain: 0, release: 0.5 },
        modulation: { type: "triangle" },
        modulationEnvelope: { attack: 0.001, decay: 0.25, sustain: 0, release: 0.3 },
        volume: -13,
      });
    case "guitar":
      // Nylon-guitar-ish: sawtooth carrier through FM modulation gives the
      // body resonance; sharp attack and long release mimic a plucked string.
      // Low harmonicity (~1.5) keeps it warm, not metallic.
      return new Tone.PolySynth(Tone.FMSynth, {
        harmonicity: 1.5,
        modulationIndex: 4,
        oscillator: { type: "sawtooth" },
        envelope: { attack: 0.003, decay: 1.2, sustain: 0, release: 1.8 },
        modulation: { type: "sine" },
        modulationEnvelope: { attack: 0.001, decay: 0.4, sustain: 0, release: 0.5 },
        volume: -13,
      });
    case "soft":
    default:
      return new Tone.PolySynth(Tone.Synth, {
        oscillator: { type: "triangle" },
        envelope: { attack: 0.006, decay: 0.5, sustain: 0, release: 1.0 },
        volume: -13,
      });
  }
}

export async function ensureAudio(): Promise<void> {
  if (started) return;
  await Tone.start();

  reverb = new Tone.Reverb({ decay: 3.4, wet: 0.34 }).toDestination();
  await reverb.generate();

  synth = buildSynth(currentInstrument).connect(reverb);

  Tone.getTransport().bpm.value = 78;

  loop = new Tone.Loop((time) => {
    if (!active || !synth) return;
    const data = PATTERN_DATA[currentPattern];
    const variant = active.type === "dom7" ? data.dom7 : data.triad;
    // RH defines the base 8th-note grid. LH may run at 2× resolution (16th
    // notes) — Bach-prelude / Einaudi style — in which case its array is
    // exactly twice as long and we fire it twice per callback.
    const rhLen = variant.rh.length;
    const lhSubdivide = Math.max(1, Math.round(variant.lh.length / rhLen));
    const pos = stepIndex % rhLen;
    const rhStep = variant.rh[pos] ?? null;
    // Track absolute bar position so a 4-bar phrase envelope (soft → swell →
    // taper) can ride on top of the 2-bar pattern. Without this, repeating
    // the same chord forever sits at one dynamic level and feels lifeless.
    const barLen = rhLen / 2;
    const phraseBar = Math.floor(stepIndex / barLen) % 4;
    const phraseEnv = [-0.10, 0.0, 0.08, -0.05][phraseBar];
    stepIndex++;
    // Downbeat accent + mid-bar lift give the loop a pulse. Softened and varied
    // so every bar isn't stamped with the same hit — that sameness is what
    // reads as metronomic. Only the first bar of a 4-bar phrase gets the full
    // weight; interior downbeats are lighter, and a little per-bar jitter keeps
    // even those from being identical twins.
    // barLen = 8 for 4/4 patterns, 6 for waltz (no mid-bar accent there).
    const beat = pos % barLen;
    const accent =
      beat === 0
        ? (phraseBar === 0 ? 0.12 : 0.06) + (Math.random() - 0.5) * 0.04
        : barLen >= 8 && beat === barLen / 2
          ? 0.05
          : 0;
    // Sine arch within the bar — naturally crescendos toward the middle and
    // tapers at the end, so even with the same pattern, each beat sits at a
    // different dynamic. Floor lowered to 0.15 so ghost notes can breathe.
    const bar01 = barLen > 0 ? beat / barLen : 0;
    const arch = Math.sin(bar01 * Math.PI) * 0.06;
    const clamp = (v: number) => Math.max(0.15, Math.min(1.0, v));

    // Refresh the melody phrase at each bar start — picks up chord changes and
    // hands a held chord a fresh motif every bar.
    if (melodyEnabled && beat === 0) renderMelodyBar(barLen);

    // LH and RH each get their own time/velocity jitter — that independence
    // is what makes one synth feel like two hands instead of one machine.
    // For subdivide>1 the LH is fired multiple times across the 8th-note slot.
    const sixteenth = Tone.Time("16n").toSeconds();
    const eighth = Tone.Time("8n").toSeconds();
    for (let s = 0; s < lhSubdivide; s++) {
      const lhPos = (pos * lhSubdivide + s) % variant.lh.length;
      const lhStep = variant.lh[lhPos];
      if (!lhStep) continue;
      // Wider jitter (±0.13) so successive 16ths aren't twins. Ghost notes
      // (15% on inner LH tones, never on the bass anchor) drop volume to a
      // whisper — like a pianist's thumb brushing the inner voice.
      const velJitter = (Math.random() - 0.5) * 0.26;
      const isInner = lhStep.every((i) => i !== 0);
      const ghost = isInner && Math.random() < 0.15 ? -0.20 : 0;
      // LH usually lands a hair before RH on a real piano; bias the jitter
      // slightly negative to recreate that "left leads" micro-timing.
      const playTime = time + s * sixteenth + (Math.random() - 0.5) * 0.024 - 0.008;
      const lhVel = clamp(0.50 + accent * 0.6 + phraseEnv * 0.5 + arch + ghost + velJitter);
      for (const i of lhStep) {
        const note = lhNote(active.notes, i);
        if (!note) continue;
        // Tame the bass pulse: the root re-striking on every downbeat is the
        // main metronomic thud once the melody is on. On slow (non-rolling)
        // patterns, let the bass ride through instead of re-articulating ~35%
        // of the time — it's still ringing from its whole-note sustain + reverb.
        // Always re-anchor on the first downbeat of a 4-bar phrase so the
        // harmony doesn't drift.
        if (
          i === 0 &&
          lhSubdivide === 1 &&
          !(phraseBar === 0 && beat === 0) &&
          Math.random() < 0.35
        ) {
          continue;
        }
        // Bass on the downbeat holds a full whole note — like depressing the
        // sustain pedal — so the root rings underneath the chord. Inner LH
        // tones ring a quarter note. At 16th resolution everything shortens
        // to 8n so the rolling figure doesn't smear into mush.
        const dur =
          i === 0
            ? lhSubdivide >= 2 ? "8n" : "1n"
            : lhSubdivide >= 2 ? "8n" : "4n";
        // The bass sits a touch softer than the inner voices — it anchors
        // without thudding — with its own small velocity wobble so repeated
        // roots aren't identical twins.
        const vel = i === 0 ? clamp(lhVel - 0.1 + (Math.random() - 0.5) * 0.06) : lhVel;
        synth.triggerAttackRelease(note, dur, playTime, vel);
      }
    }
    // When the melody voice is on it owns the soprano line, so mute the
    // pattern's single-note RH filigree (it would compete). RH *chords* stay —
    // they're harmonic body, not a competing melody.
    if (rhStep && !(melodyEnabled && rhStep.length === 1)) {
      // RH velocity scales down with stack size so dense chord stabs don't clip.
      // When LH is running 16ths, drop the chord-stab velocity further: a
      // running LH wants the RH to act like a sustain pedal, not a stab, so
      // the attack shouldn't punch through the ripple underneath.
      const baseVel =
        rhStep.length >= 3
          ? lhSubdivide >= 2 ? 0.42 : 0.55
          : rhStep.length === 2 ? 0.7 : 0.85;
      // Wider jitter (±0.14) + ghost-note dice on off-beat single notes.
      // Ghosts only land on solo melody hits — never on chord stabs, never on
      // the downbeat — so the harmonic skeleton stays solid while the
      // filigree between accents breathes.
      const velJitter = (Math.random() - 0.5) * 0.28;
      const ghost = rhStep.length === 1 && beat !== 0 && Math.random() < 0.18 ? -0.22 : 0;
      const playTime = time + (Math.random() - 0.5) * 0.024;
      const rhVel = clamp(baseVel + accent + phraseEnv + arch + ghost + velJitter);
      // Big chord voicings (3+ notes) ring for a half note — pedal-held feel
      // on piano, sustained-pad on synths. When LH is running 16ths, hold
      // the chord a full bar so it actually bridges the long gaps between
      // RH events; the rippling LH fills the space underneath the sustain.
      // Single/double-note arp events stay snappy at 8n so the rhythm reads.
      const rhDur =
        rhStep.length >= 3
          ? lhSubdivide >= 2 ? "1n" : "2n"
          : "8n";
      // Single-note off-beat events get a small chance to be replaced by a
      // color tone (9th or 6th/13th) — Einaudi-style filigree. Skipped on
      // downbeats and on dense chord stabs so the harmony stays intact.
      // Aria's RH is a flowing arpeggio that should reach above the triad, so
      // it ornaments far more often than other patterns (0.30 vs 0.12) — that
      // frequent jump to the 9th / 13th is what makes the line "sing".
      const ornamentChance = currentPattern === "aria" ? 0.3 : 0.12;
      const canOrnament =
        rhStep.length === 1 && beat !== 0 && active.colors.length > 0 && Math.random() < ornamentChance;
      // Rolled chord (broken chord): on Brook, stagger the chord-stab voices
      // bottom→top by a hair so the chord "blooms" like a pianist rolling it,
      // rather than landing all at once. ~25 ms/voice reads as a gentle sweep,
      // not a deliberate arpeggio. `rhStep` is already low→high. Comp is left
      // un-rolled on purpose — its chords want to land together for the groove.
      const roll = currentPattern === "brook" && rhStep.length >= 3 ? 0.025 : 0;
      for (const [vi, i] of rhStep.entries()) {
        let note: string | undefined = active.notes[i];
        if (canOrnament && i >= 2) {
          note = active.colors[Math.floor(Math.random() * active.colors.length)];
        }
        if (!note) continue;
        synth.triggerAttackRelease(note, rhDur, playTime + vi * roll, rhVel);
      }
    }

    // Melody voice — the soprano line, an octave above the accompaniment. Each
    // onset rings for its motif-given duration (run of steps until the next
    // note), so the phrase has real note lengths and rests, not flat 8ths.
    if (melodyEnabled && melodyNote.length > 0) {
      const mNote = melodyNote[beat];
      if (mNote) {
        const durSteps = melodyDur[beat] || 1;
        const mVel = clamp(0.78 + accent * 0.5 + phraseEnv + (Math.random() - 0.5) * 0.12);
        const mTime = time + (Math.random() - 0.5) * 0.012;
        synth.triggerAttackRelease(mNote, durSteps * eighth, mTime, mVel);
      }
    }
  }, "8n");
  loop.start(0);
  Tone.getTransport().start();
  started = true;
}

export function setActiveChord(
  notes: string[],
  colors: string[],
  type: ChordType,
  rootPc: number,
): void {
  if (!active) stepIndex = 0; // start the very first chord on the downbeat
  active = { notes, colors, type, rootPc };
}

export function setMelody(on: boolean): void {
  melodyEnabled = on;
  if (!on) {
    melodyNote = [];
    melodyDur = [];
  }
}

export function getMelody(): boolean {
  return melodyEnabled;
}

export function stopActiveChord(): void {
  active = null;
  // Gently release any ringing voices.
  synth?.releaseAll();
}

export function setTempo(bpm: number): void {
  Tone.getTransport().bpm.rampTo(bpm, 0.1);
}

export function setPattern(p: Pattern): void {
  if (currentPattern === p) return;
  currentPattern = p;
  stepIndex = 0; // restart the new pattern on the next downbeat
}

export async function setInstrument(instr: Instrument): Promise<void> {
  if (currentInstrument === instr) return;
  currentInstrument = instr;
  if (!started || !reverb) return;
  const built = buildSynth(instr).connect(reverb);
  // Samplers must finish loading before we hand them notes.
  if (built instanceof Tone.Sampler) {
    await Tone.loaded();
  }
  // If the user switched again while we were loading, drop this one.
  if (currentInstrument !== instr) {
    built.dispose();
    return;
  }
  const old = synth;
  synth = built;
  if (old) {
    old.releaseAll();
    setTimeout(() => old.dispose(), 2500);
  }
}

export function getInstrument(): Instrument {
  return currentInstrument;
}
