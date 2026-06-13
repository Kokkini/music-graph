import { useMemo } from "react";
import { WHEEL_SIZE, type Chord, type Edge, type EdgeKind, type WheelData } from "./chords";

type Props = {
  data: WheelData;
  onPress: (chord: Chord) => void;
  hoveredId: string | null;
  setHoveredId: (id: string | null) => void;
  activeId: string | null;
};

const COLORS: Record<EdgeKind | "inactive" | "petal", string> = {
  resolve: "#ef4f7c",
  tension: "#f5b342",
  color: "#7ee787",
  petal: "#cfcfdb",
  chain: "#f5b342",
  custom: "#9aa0ff",
  inactive: "#6a6a7a",
};

function nodeRadius(c: Chord): number {
  return c.type === "maj" ? 26 : 22;
}

function pullTowards(
  endX: number,
  endY: number,
  fromX: number,
  fromY: number,
  pullback: number,
): { x: number; y: number } {
  const dx = endX - fromX;
  const dy = endY - fromY;
  const len = Math.hypot(dx, dy) || 1;
  return {
    x: endX - (dx / len) * pullback,
    y: endY - (dy / len) * pullback,
  };
}

type EdgeGroup = {
  a: Chord;
  b: Chord;
  kind: Edge["kind"];
  edges: Edge[];
};

function buildGroups(edges: Edge[], chordById: Record<string, Chord>): EdgeGroup[] {
  const map = new Map<string, EdgeGroup>();
  for (const e of edges) {
    const [lo, hi] = [e.from, e.to].sort();
    const key = `${lo}|${hi}|${e.kind}`;
    const a = chordById[lo];
    const b = chordById[hi];
    if (!a || !b) continue;
    const existing = map.get(key);
    if (existing) existing.edges.push(e);
    else map.set(key, { a, b, kind: e.kind, edges: [e] });
  }
  return Array.from(map.values());
}

const MARKER_KINDS: (EdgeKind | "inactive")[] = [
  "resolve",
  "tension",
  "color",
  "petal",
  "chain",
  "custom",
  "inactive",
];

export function Wheel({ data, onPress, hoveredId, setHoveredId, activeId }: Props) {
  const focusId = hoveredId ?? activeId;
  const groups = useMemo(() => buildGroups(data.edges, data.chordById), [data]);

  const reachable = useMemo(() => {
    if (!focusId) return new Set<string>();
    return new Set(data.edges.filter((e) => e.from === focusId).map((e) => e.to));
  }, [focusId, data.edges]);

  return (
    <svg
      viewBox={`0 0 ${WHEEL_SIZE} ${WHEEL_SIZE}`}
      width="100%"
      height="100%"
      style={{ display: "block", touchAction: "pan-y" }}
    >
      <defs>
        {MARKER_KINDS.map((k) => (
          <marker
            key={k}
            id={`arrow-${k}`}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerUnits="userSpaceOnUse"
            markerWidth={k === "inactive" ? 9 : 11}
            markerHeight={k === "inactive" ? 9 : 11}
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill={COLORS[k]} opacity={k === "inactive" ? 0.75 : 1} />
          </marker>
        ))}
      </defs>

      <circle cx={WHEEL_SIZE / 2} cy={WHEEL_SIZE / 2} r={320} fill="none" stroke="#222" strokeWidth={1} />
      <circle cx={WHEEL_SIZE / 2} cy={WHEEL_SIZE / 2} r={240} fill="none" stroke="#1c1c1c" strokeWidth={1} />
      <circle cx={WHEEL_SIZE / 2} cy={WHEEL_SIZE / 2} r={175} fill="none" stroke="#1c1c1c" strokeWidth={1} />

      <g>
        {groups.map((g, i) => {
          const { a, b, kind, edges } = g;
          const bidir = edges.length > 1;
          const active = !!focusId && edges.some((e) => e.from === focusId);

          const stroke = active ? COLORS[kind] : COLORS.inactive;
          const opacity = active ? 0.95 : 0.7;
          const width = active ? 2.4 : 1.2;
          const dash = kind === "color" || kind === "tension" ? "4 4" : undefined;
          const markerColor = active ? kind : "inactive";
          // For one-way edges, the marker goes on the "to" end. If the
          // single edge runs a→b we put it at b's end; if b→a, at a's end.
          const oneWay = !bidir;
          const oneWayFromA = oneWay && edges[0].from === a.id;
          const oneWayFromB = oneWay && edges[0].from === b.id;
          const markerOnB = bidir || oneWayFromA;
          const markerOnA = bidir || oneWayFromB;
          const markerEnd = markerOnB ? `url(#arrow-${markerColor})` : undefined;
          const markerStart = markerOnA ? `url(#arrow-${markerColor})` : undefined;

          if (kind === "petal") {
            const cx = WHEEL_SIZE / 2;
            const cy = WHEEL_SIZE / 2;
            const mx = (a.x + b.x) / 2;
            const my = (a.y + b.y) / 2;
            const dx = mx - cx;
            const dy = my - cy;
            const k = 2.6;
            const qx = cx + dx * k;
            const qy = cy + dy * k;
            const aEnd = pullTowards(a.x, a.y, qx, qy, nodeRadius(a) + 4);
            const bEnd = pullTowards(b.x, b.y, qx, qy, nodeRadius(b) + 4);
            return (
              <path
                key={i}
                d={`M ${aEnd.x} ${aEnd.y} Q ${qx} ${qy} ${bEnd.x} ${bEnd.y}`}
                fill="none"
                stroke={stroke}
                strokeWidth={width}
                strokeOpacity={active ? 0.9 : 0.6}
                markerEnd={markerEnd}
                markerStart={markerStart}
              />
            );
          }

          const aEnd = pullTowards(a.x, a.y, b.x, b.y, nodeRadius(a) + 4);
          const bEnd = pullTowards(b.x, b.y, a.x, a.y, nodeRadius(b) + 4);
          return (
            <line
              key={i}
              x1={aEnd.x}
              y1={aEnd.y}
              x2={bEnd.x}
              y2={bEnd.y}
              stroke={stroke}
              strokeWidth={width}
              strokeOpacity={opacity}
              strokeDasharray={dash}
              markerEnd={markerEnd}
              markerStart={markerStart}
            />
          );
        })}
      </g>

      <g>
        {data.chords.map((c) => {
          const isActive = activeId === c.id;
          const isHovered = hoveredId === c.id;
          const isFocus = focusId === c.id;
          const isReachable = reachable.has(c.id);

          const r = nodeRadius(c);
          const ringR = r + (isFocus ? 8 : isReachable ? 5 : 0);
          const dim = focusId && !isFocus && !isReachable ? 0.45 : 1;

          return (
            <g
              key={c.id}
              onPointerDown={(ev) => {
                ev.preventDefault();
                onPress(c);
              }}
              onPointerEnter={() => setHoveredId(c.id)}
              onPointerLeave={() => {
                if (hoveredId === c.id) setHoveredId(null);
              }}
              style={{ cursor: "pointer", opacity: dim, transition: "opacity 0.2s" }}
            >
              {isActive && (
                <circle
                  cx={c.x}
                  cy={c.y}
                  r={r + 14}
                  fill="none"
                  stroke={c.color}
                  strokeWidth={2}
                  strokeOpacity={0.35}
                >
                  <animate
                    attributeName="r"
                    values={`${r + 10};${r + 18};${r + 10}`}
                    dur="1.6s"
                    repeatCount="indefinite"
                  />
                  <animate
                    attributeName="stroke-opacity"
                    values="0.5;0.15;0.5"
                    dur="1.6s"
                    repeatCount="indefinite"
                  />
                </circle>
              )}
              {(isFocus || isReachable) && !isActive && (
                <circle
                  cx={c.x}
                  cy={c.y}
                  r={ringR}
                  fill="none"
                  stroke={c.color}
                  strokeWidth={2}
                  strokeOpacity={isHovered ? 0.9 : 0.5}
                />
              )}
              <circle
                cx={c.x}
                cy={c.y}
                r={r}
                fill={isActive ? c.color : "#0a0a0a"}
                stroke={c.color}
                strokeWidth={2}
              />
              <text
                x={c.x}
                y={c.y}
                textAnchor="middle"
                dominantBaseline="central"
                fill={isActive ? "#0a0a0a" : c.color}
                fontSize={c.type === "maj" ? 17 : 14}
                fontWeight={600}
                fontFamily="ui-sans-serif, system-ui, sans-serif"
                style={{ pointerEvents: "none", userSelect: "none" }}
              >
                {c.label}
              </text>
            </g>
          );
        })}
      </g>
    </svg>
  );
}
