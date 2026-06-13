# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Use `pnpm` (never `npm` / `npx`).

- `pnpm dev` — Vite dev server on `http://localhost:5173`. Binds `0.0.0.0` so it's also reachable on LAN / Tailscale.
- `pnpm build` — `tsc -b && vite build` (production bundle into `dist/`).
- `pnpm preview` — serve the built bundle.
- `pnpm tsc --noEmit` — type-check only. Strict mode is on (`noUnusedLocals`, `noUnusedParameters`), so unused vars/imports break the build.

There is no test runner and no linter configured. "Done" means typecheck-clean.

## Environment

This repo lives under `/mnt/e` (a Windows mount inside WSL2). Two consequences:

- Vite's file watcher must poll — `vite.config.ts` already sets `server.watch.usePolling: true`. Don't remove it; HMR will silently stop working on edits.
- The dev server inside WSL is reachable from outside via Tailscale only because `%UserProfile%\.wslconfig` on the Windows host has `networkingMode=mirrored`. If a teammate can hit `localhost:5173` but not the Tailscale IP, that line is the fix.

## Application architecture

Two modes share the same React tree, gated by URL (`src/App.tsx:25`):

- **Player** (default) — `src/App.tsx` renders the wheel and audio controls.
- **Builder** (`?builder=1`) — `src/Builder.tsx`, a graph editor that exports JSON for `public/wheel-data.json` or a graph in `public/graphs/`.

### Data flow

```
public/graphs/*.json   ──┐
public/wheel-data.json ──┴── chords.ts (loadWheelData) ── App.tsx Player ── audio.ts
                                   │                                │
                              SVG geometry +                  Tone.js synth + Loop
                              chord note arrays               on a 2-bar 8th-note grid
```

- **Graph JSON** is the source of truth. Each file is `{ nodes, edges }` with hard-coded SVG coordinates in an 800×800 viewBox (`WHEEL_SIZE` in `src/chords.ts`).
- **`src/chords.ts`** turns a graph JSON into `Chord` objects with: pitch-class-correct note arrays (`[bass3, root4, third4, fifth4, (seventh4)]`), color-tone arrays for ornaments (9th + 6th/13th), and visual color. The `GRAPHS` array lists every selectable graph; `DEFAULT_GRAPH_ID` controls what loads first. Adding a graph: drop a JSON in `public/graphs/`, add a `GraphInfo` entry.
- **`src/audio.ts`** owns the singleton audio engine. It exposes `setActiveChord`, `setPattern`, `setInstrument`, `setTempo`, etc. A `Tone.Loop` runs every 8th note and reads from `PATTERN_DATA[currentPattern]` for which chord indices to strike.

### Audio engine — the parts that matter when changing things

- **Two-hand simulation.** Each pattern has parallel `lh` and `rh` step arrays. LH notes get `lowerOctave()` (except the bass at index 0, already in octave 3) so a single synth produces piano-ish bass + treble.
- **Fast-LH patterns** (Prelude, Brook, Cascade) keep `rh.length = 16` but use a 32-slot `lh` array. The loop auto-detects this via `lhSubdivide = round(lh.length / rh.length)` and fires LH twice per 8th-note tick at 16th-note offsets.
- **Pattern type** is a string-literal union (`src/audio.ts` near top). Adding a pattern requires three edits in lockstep: (1) extend the `Pattern` union, (2) add a `PATTERNS` entry with a `bpm` (changing the pattern auto-snaps tempo via `getPatternBpm`), (3) add the corresponding `PATTERN_DATA` entry with both `triad` and `dom7` variants.
- **Dynamics** that make the loop sound alive (do not silently flatten any of these — repeated chords sound robotic without them):
  - Per-step velocity jitter (±0.13 LH, ±0.14 RH).
  - Sine arch within each bar (`Math.sin(bar01 * π) * 0.06`).
  - 4-bar phrase envelope `[-0.10, 0.0, 0.08, -0.05]`.
  - Ghost-note dice (15% on inner LH tones; 18% on off-beat RH single notes).
  - Ornament substitution: off-beat single RH notes have a 12% chance of being replaced by a `colors[]` tone.
- **Instruments.** `INSTRUMENTS` array in `src/audio.ts` lists what the UI offers. Piano is the only sampled voice (Tone.js Salamander); everything else is a `PolySynth`. Adding a voice = a new case in `buildSynth()` + an `INSTRUMENTS` entry.

### Random walk (Player)

`src/App.tsx` implements a biased random walker that auto-traverses the graph. The bias is at *traversal time*, not graph time: at random-mode start it locks in a `homeKey` major, then `edgeWeight` weights each outgoing edge by circle-of-fifths distance to that home so wandering still has a tonal center. The wheel itself stays symmetric.

### Builder mode

`src/Builder.tsx` is a separate React component that loads `/wheel-data.json`, lets you drag nodes / draw edges, and exports a downloaded JSON. Saving = manually replacing the file in `public/`. There is no server.

## Conventions worth knowing

- Don't reintroduce "Brian" or "Callipari" in identifiers, labels, or comments — the project's branding is generic "Chord Wheel" now.
- `chord.notes[0]` is always the bass in octave 3; `chord.notes[1]` is the root in octave 4. Other code (e.g. `rootPitchClass` in `App.tsx`) depends on this layout.
- Augmented chords feel "uneasy" — graphs labeled relaxing (Lullaby, Folk Cadence, Plagal Drift) deliberately exclude them.
