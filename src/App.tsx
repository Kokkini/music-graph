import { useCallback, useEffect, useState } from "react";
import { Wheel } from "./Wheel";
import { Builder } from "./Builder";
import {
  loadWheelData,
  GRAPHS,
  DEFAULT_GRAPH_ID,
  type Chord,
  type WheelData,
} from "./chords";
import {
  ensureAudio,
  getPatternBpm,
  setActiveChord,
  setInstrument,
  setMelody,
  setPattern,
  setTempo,
  stopActiveChord,
  INSTRUMENTS,
  PATTERNS,
  type Instrument,
  type Pattern,
} from "./audio";

const isBuilder = new URLSearchParams(window.location.search).has("builder");

export default function App() {
  if (isBuilder) return <Builder />;
  return <Player />;
}

// ---- Tonal bias for random walk -------------------------------------------
// The wheel is geometrically symmetric: every chord of a given type has the
// same outgoing-edge structure. An unweighted random walk never establishes
// a tonal center. We fix that at traversal time (not graph time) by picking
// a home key per session and biasing each edge choice toward chord roots
// close to the home on the circle of fifths.

const PITCH_CLASS: Record<string, number> = {
  C: 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, F: 5,
  "F#": 6, Gb: 6, G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11,
};
const COF_ORDER = [0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5];

function rootPitchClass(chord: Chord): number {
  // chord.notes[1] is the root at octave 4 (e.g. "C4", "F#4", "Bb4").
  const m = chord.notes[1]?.match(/^([A-G][#b]?)/);
  return m ? PITCH_CLASS[m[1]] ?? 0 : 0;
}

function cofDistance(a: number, b: number): number {
  const ia = COF_ORDER.indexOf(a);
  const ib = COF_ORDER.indexOf(b);
  if (ia < 0 || ib < 0) return 6;
  const d = Math.abs(ia - ib);
  return Math.min(d, 12 - d);
}

function edgeWeight(toChord: Chord, homeChord: Chord): number {
  const d = cofDistance(rootPitchClass(toChord), rootPitchClass(homeChord));
  // Linear falloff: home root (d=0) ≈ 4.6×, tritone away (d=6) = 1×.
  let w = 1 + (6 - d) * 0.6;
  // Extra pull toward the home chord itself — this is the "return" gravity.
  if (toChord.id === homeChord.id) w *= 1.8;
  return w;
}

function weightedPick<T>(items: T[], weight: (t: T) => number): T {
  const total = items.reduce((s, t) => s + weight(t), 0);
  let r = Math.random() * total;
  for (const t of items) {
    r -= weight(t);
    if (r <= 0) return t;
  }
  return items[items.length - 1];
}

function Player() {
  const [data, setData] = useState<WheelData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [audioReady, setAudioReady] = useState(false);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [bpm, setBpm] = useState(() => getPatternBpm("aria"));
  const [history, setHistory] = useState<string[]>([]);
  const [random, setRandom] = useState(false);
  const [minBeats, setMinBeats] = useState(4);
  const [maxBeats, setMaxBeats] = useState(8);
  const [instrument, setInstrumentState] = useState<Instrument>("piano");
  const [pattern, setPatternState] = useState<Pattern>("aria");
  const [melody, setMelodyState] = useState(true);
  // Home key for the random walk; reset whenever random mode toggles off.
  const [homeKey, setHomeKey] = useState<string | null>(null);
  const [graphId, setGraphId] = useState<string>(DEFAULT_GRAPH_ID);

  useEffect(() => {
    void setInstrument(instrument);
  }, [instrument]);

  useEffect(() => {
    setPattern(pattern);
    setBpm(getPatternBpm(pattern));
  }, [pattern]);

  useEffect(() => {
    setMelody(melody);
  }, [melody]);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    // Tear down active state so we don't try to play a chord that no
    // longer exists in the newly-loaded graph.
    stopActiveChord();
    setActiveId(null);
    setHomeKey(null);
    loadWheelData(graphId)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setLoadError(String(e)); });
    return () => { cancelled = true; };
  }, [graphId]);

  const initAudio = useCallback(async () => {
    await ensureAudio();
    setAudioReady(true);
  }, []);

  const handlePress = useCallback(
    async (chord: Chord) => {
      if (!audioReady) await initAudio();
      setActiveChord(chord.notes, chord.colors, chord.type, chord.rootPc);
      setActiveId(chord.id);
      setHistory((h) => (h[h.length - 1] === chord.id ? h : [...h.slice(-23), chord.id]));
    },
    [audioReady, initAudio],
  );

  const handleStop = useCallback(() => {
    stopActiveChord();
    setActiveId(null);
    setRandom(false);
  }, []);

  // When random mode turns off, drop the current home key so the next
  // session picks a fresh one.
  useEffect(() => {
    if (!random) setHomeKey(null);
  }, [random]);

  // Random walk: every N beats, pick an outgoing edge from the current node.
  // Edges to chords near the home key on the circle of fifths are preferred —
  // that's what gives the wandering a tonal center.
  useEffect(() => {
    if (!random || !data) return;
    // Lock in a home key the first time random mode runs.
    let home = homeKey;
    if (!home) {
      const majors = data.chords.filter((c) => c.type === "maj");
      home = majors[Math.floor(Math.random() * majors.length)].id;
      setHomeKey(home);
    }
    const homeChord = data.chordById[home];
    if (!activeId) {
      // Start on the home chord so the ear hears the key right away.
      if (homeChord) void handlePress(homeChord);
      return;
    }
    const lo = Math.max(1, Math.min(minBeats, maxBeats));
    const hi = Math.max(lo, maxBeats);
    const beats = lo + Math.floor(Math.random() * (hi - lo + 1));
    const ms = (60 / bpm) * 1000 * beats;
    const t = setTimeout(() => {
      const outs = data.edges.filter((e) => e.from === activeId);
      let nextId: string | null = null;
      if (outs.length > 0) {
        // Bias away from immediately revisiting the previous chord, when possible.
        const prev = history[history.length - 2];
        const fresh = outs.filter((e) => e.to !== prev);
        const pool = fresh.length > 0 ? fresh : outs;
        if (homeChord) {
          const picked = weightedPick(pool, (e) => {
            const toChord = data.chordById[e.to];
            return toChord ? edgeWeight(toChord, homeChord) : 0.1;
          });
          nextId = picked.to;
        } else {
          nextId = pool[Math.floor(Math.random() * pool.length)].to;
        }
      }
      const next = nextId ? data.chordById[nextId] : null;
      if (next) {
        void handlePress(next);
      } else if (homeChord) {
        // Sink: fall back to home rather than a random key — keeps the center.
        void handlePress(homeChord);
      }
    }, ms);
    return () => clearTimeout(t);
  }, [random, data, activeId, bpm, minBeats, maxBeats, handlePress, history, homeKey]);

  useEffect(() => {
    setTempo(bpm);
  }, [bpm]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        e.preventDefault();
        handleStop();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleStop]);

  if (loadError) {
    return (
      <div className="app">
        <div className="load-error">
          <h2>Failed to load wheel data</h2>
          <p>{loadError}</p>
          <p>Check that <code>public/wheel-data.json</code> exists and is valid.</p>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="app">
        <div className="load-error">
          <p className="muted">Loading wheel…</p>
        </div>
      </div>
    );
  }

  const focus = hoveredId
    ? data.chordById[hoveredId]
    : activeId
      ? data.chordById[activeId]
      : null;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <h1>Music Graph</h1>
          <p>Click a chord — it loops. Click another to glide into the next.</p>
        </div>
        <a className="ghost" href="?builder=1" style={{ textDecoration: "none" }}>
          Edit graph →
        </a>
      </header>

      <main className="stage">
        <aside className="settings">
          <div className="actions">
            <button
              className={`cta ${random ? "active" : ""}`}
              onClick={() => setRandom((v) => !v)}
              title="Auto-traverse the graph"
            >
              {random ? "■ Stop Random" : "▶ Random Walk"}
            </button>
            <button
              className="secondary"
              onClick={handleStop}
              disabled={!activeId}
              title="Stop (Space)"
            >
              ■ Stop
            </button>
            {!audioReady && (
              <button onClick={initAudio} className="ghost-action">
                Enable sound
              </button>
            )}
            {random && homeKey && data?.chordById[homeKey] && (
              <span
                className="home-tag"
                title="Home key — the random walk is biased to return here"
                style={{ color: data.chordById[homeKey].color }}
              >
                Home: {data.chordById[homeKey].label}
              </span>
            )}
          </div>

          <div className="settings-fields">
            <label className="field">
              <span className="field-head">Tempo<span className="val">{bpm} BPM</span></span>
              <input
                type="range"
                min={50}
                max={120}
                value={bpm}
                onChange={(e) => setBpm(Number(e.target.value))}
              />
            </label>

            <label className="field" title={GRAPHS.find((g) => g.id === graphId)?.description}>
              <span className="field-head">Graph</span>
              <select
                value={graphId}
                onChange={(e) => setGraphId(e.target.value)}
                className="instrument-select"
              >
                {GRAPHS.map((g) => (
                  <option key={g.id} value={g.id}>{g.label}</option>
                ))}
              </select>
            </label>

            <label className="field" title="Instrument">
              <span className="field-head">Voice</span>
              <select
                value={instrument}
                onChange={(e) => setInstrumentState(e.target.value as Instrument)}
                className="instrument-select"
              >
                {INSTRUMENTS.map((i) => (
                  <option key={i.id} value={i.id}>{i.label}</option>
                ))}
              </select>
            </label>

            <label className="field" title="Arpeggio pattern">
              <span className="field-head">Pattern</span>
              <select
                value={pattern}
                onChange={(e) => setPatternState(e.target.value as Pattern)}
                className="instrument-select"
              >
                {PATTERNS.map((p) => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
              </select>
            </label>

            <label className="field row" title="Play a melody line over the chords">
              <input
                type="checkbox"
                checked={melody}
                onChange={(e) => setMelodyState(e.target.checked)}
              />
              <span>Melody</span>
            </label>

            <label className="field" title="Minimum beats per chord">
              <span className="field-head">Min beats<span className="val">{minBeats}</span></span>
              <input
                type="range"
                min={1}
                max={16}
                value={minBeats}
                onChange={(e) => setMinBeats(Number(e.target.value))}
              />
            </label>

            <label className="field" title="Maximum beats per chord">
              <span className="field-head">Max beats<span className="val">{maxBeats}</span></span>
              <input
                type="range"
                min={1}
                max={16}
                value={maxBeats}
                onChange={(e) => setMaxBeats(Number(e.target.value))}
              />
            </label>
          </div>
        </aside>

        <div className="wheel-wrap">
          <Wheel
            data={data}
            onPress={handlePress}
            hoveredId={hoveredId}
            setHoveredId={setHoveredId}
            activeId={activeId}
          />
        </div>
        <aside className="side">
          <section>
            <h2>Now playing</h2>
            {focus ? (
              <div className="now">
                <div className="big" style={{ color: focus.color }}>
                  {focus.label}
                </div>
                <div className="meta">
                  {focus.type === "maj" && "major triad — stable"}
                  {focus.type === "aug" && "augmented — floating, mysterious"}
                  {focus.type === "dom7" && "dominant 7 — wants to resolve"}
                </div>
                <div className="notes">{focus.notes.slice(1).join(" · ")}</div>
              </div>
            ) : (
              <div className="hint">Hover or click a node.</div>
            )}
          </section>

          <section>
            <h2>Progression</h2>
            <div className="history">
              {history.length === 0 ? (
                <div className="hint">Play something.</div>
              ) : (
                history.map((id, i) => {
                  const c = data.chordById[id];
                  if (!c) return null;
                  return (
                    <span
                      key={i}
                      className="pill"
                      style={{ borderColor: c.color, color: c.color }}
                    >
                      {c.label}
                    </span>
                  );
                })
              )}
            </div>
            {history.length > 0 && (
              <button className="ghost" onClick={() => setHistory([])}>
                Clear
              </button>
            )}
          </section>

          <section className="legend">
            <h2>Legend</h2>
            <div className="legend-row">
              <span className="dot" style={{ background: "#ef4f7c" }} /> Major — home
            </div>
            <div className="legend-row">
              <span className="dot" style={{ background: "#7ee787" }} /> Augmented — color
            </div>
            <div className="legend-row">
              <span className="dot" style={{ background: "#f5b342" }} /> Dom 7 — tension
            </div>
            <p className="footnote">
              <strong>Solid</strong> = resolves or back-cycles. <strong>Dashed</strong> =
              same-root color/tension shift. <strong>Outer petal arcs</strong> = whole-step
              motion between augmented chords. Space to stop.
            </p>
          </section>
        </aside>
      </main>
    </div>
  );
}
