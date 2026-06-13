import { useEffect, useMemo, useRef, useState } from "react";
import {
  WHEEL_SIZE,
  type EdgeKind,
  type WheelDataJson,
  type WheelEdgeJson,
  type WheelNodeJson,
} from "./chords";

const EDGE_KINDS: EdgeKind[] = ["resolve", "color", "tension", "chain", "petal", "custom"];

const EDGE_COLORS: Record<EdgeKind, string> = {
  resolve: "#ef4f7c",
  color: "#7ee787",
  tension: "#f5b342",
  chain: "#f5b342",
  petal: "#cfcfdb",
  custom: "#9aa0ff",
};

const NODE_COLORS = {
  maj: "#ef4f7c",
  aug: "#7ee787",
  dom7: "#f5b342",
} as const;

function nodeRadius(type: WheelNodeJson["type"]): number {
  return type === "maj" ? 26 : 22;
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

type DragState = {
  id: string;
  startX: number;
  startY: number;
  nodeStartX: number;
  nodeStartY: number;
  moved: boolean;
};

export function Builder() {
  const [nodes, setNodes] = useState<WheelNodeJson[]>([]);
  const [edges, setEdges] = useState<WheelEdgeJson[]>([]);
  const [kind, setKind] = useState<EdgeKind>("resolve");
  const [bidir, setBidir] = useState(true);
  const [deleteMode, setDeleteMode] = useState(false);
  const [pendingFrom, setPendingFrom] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [exportText, setExportText] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<DragState | null>(null);

  useEffect(() => {
    fetch("/wheel-data.json", { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as WheelDataJson;
      })
      .then((d) => {
        setNodes(d.nodes);
        setEdges(d.edges);
      })
      .catch((e) => setLoadError(String(e)));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Escape") {
        setPendingFrom(null);
        setDeleteMode(false);
        setExportText(null);
      } else if (e.key === "d" || e.key === "D") {
        if (document.activeElement && (document.activeElement as HTMLElement).tagName === "INPUT") return;
        setDeleteMode((v) => !v);
      } else if (e.key === "b" || e.key === "B") {
        if (document.activeElement && (document.activeElement as HTMLElement).tagName === "INPUT") return;
        setBidir((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function clientToSvg(clientX: number, clientY: number): { x: number; y: number } {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const m = svg.getScreenCTM();
    if (!m) return { x: 0, y: 0 };
    const r = pt.matrixTransform(m.inverse());
    return { x: r.x, y: r.y };
  }

  function onNodePointerDown(ev: React.PointerEvent<SVGGElement>, n: WheelNodeJson) {
    ev.stopPropagation();
    ev.preventDefault();
    (ev.currentTarget as Element).setPointerCapture?.(ev.pointerId);
    const p = clientToSvg(ev.clientX, ev.clientY);
    dragRef.current = {
      id: n.id,
      startX: p.x,
      startY: p.y,
      nodeStartX: n.x,
      nodeStartY: n.y,
      moved: false,
    };
  }

  function onNodePointerMove(ev: React.PointerEvent<SVGGElement>) {
    const d = dragRef.current;
    if (!d) return;
    const p = clientToSvg(ev.clientX, ev.clientY);
    const dx = p.x - d.startX;
    const dy = p.y - d.startY;
    if (!d.moved && Math.hypot(dx, dy) < 3) return;
    d.moved = true;
    const nx = Math.round((d.nodeStartX + dx) * 10) / 10;
    const ny = Math.round((d.nodeStartY + dy) * 10) / 10;
    setNodes((ns) => ns.map((n) => (n.id === d.id ? { ...n, x: nx, y: ny } : n)));
  }

  function onNodePointerUp(ev: React.PointerEvent<SVGGElement>) {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    (ev.currentTarget as Element).releasePointerCapture?.(ev.pointerId);
    if (d.moved) return;
    handleNodeClick(d.id);
  }

  function handleNodeClick(id: string) {
    if (deleteMode) return;
    if (pendingFrom == null) {
      setPendingFrom(id);
      return;
    }
    if (pendingFrom === id) {
      setPendingFrom(null);
      return;
    }
    setEdges((es) => [...es, { from: pendingFrom, to: id, kind, bidirectional: bidir }]);
    setPendingFrom(null);
  }

  function deleteEdgeAt(idx: number) {
    if (!deleteMode) return;
    setEdges((es) => es.filter((_, i) => i !== idx));
  }

  const json = useMemo<WheelDataJson>(() => ({ nodes, edges }), [nodes, edges]);

  function buildExport(): string {
    return JSON.stringify(json, null, 2);
  }

  async function exportToClipboard() {
    const text = buildExport();
    setExportText(text);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // clipboard may be unavailable — textarea remains as fallback
    }
  }

  function exportToFile() {
    const text = buildExport();
    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "wheel-data.json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function clearEdges() {
    if (!confirm("Delete all edges?")) return;
    setEdges([]);
    setPendingFrom(null);
  }

  function resetPositions() {
    if (!confirm("Reset all node positions to defaults?")) return;
    fetch("/wheel-data.json", { cache: "no-store" })
      .then((r) => r.json() as Promise<WheelDataJson>)
      .then((d) => setNodes(d.nodes));
  }

  const nodeById = useMemo(() => {
    const m: Record<string, WheelNodeJson> = {};
    for (const n of nodes) m[n.id] = n;
    return m;
  }, [nodes]);

  function onBackgroundPointerDown() {
    setPendingFrom(null);
  }

  return (
    <div className="builder">
      <header className="topbar">
        <div className="brand">
          <h1>Wheel Builder</h1>
          <p>Click two nodes to draw an edge. Drag a node to move it. Press D to toggle delete mode.</p>
        </div>
        <div className="controls">
          <a href="?" className="ghost" style={{ textDecoration: "none" }}>← Back to player</a>
        </div>
      </header>

      <div className="builder-toolbar">
        <div className="kind-row">
          <span className="tool-label">Edge kind</span>
          {EDGE_KINDS.map((k) => (
            <button
              key={k}
              onClick={() => setKind(k)}
              className={`kind-btn${kind === k ? " active" : ""}`}
              style={{
                borderColor: EDGE_COLORS[k],
                color: kind === k ? "#0a0a0a" : EDGE_COLORS[k],
                background: kind === k ? EDGE_COLORS[k] : "transparent",
              }}
            >
              {k}
            </button>
          ))}
        </div>
        <div className="toggle-row">
          <label className="toggle">
            <input type="checkbox" checked={bidir} onChange={(e) => setBidir(e.target.checked)} />
            Bidirectional (B)
          </label>
          <label className="toggle">
            <input type="checkbox" checked={deleteMode} onChange={(e) => setDeleteMode(e.target.checked)} />
            Delete mode (D)
          </label>
          <span className="sep" />
          <button onClick={exportToClipboard}>Copy JSON</button>
          <button onClick={exportToFile}>Download JSON</button>
          <button className="ghost" onClick={clearEdges}>Clear edges</button>
          <button className="ghost" onClick={resetPositions}>Reset positions</button>
        </div>
      </div>

      <div className="builder-status">
        {loadError && <span className="warn">Failed to load wheel-data.json: {loadError}</span>}
        {!loadError && (
          <span className="muted">
            {nodes.length} nodes · {edges.length} edges
            {pendingFrom && (
              <>
                {" · "}
                <strong style={{ color: "#fff" }}>From: {pendingFrom}</strong> — click target
              </>
            )}
            {deleteMode && <> · <strong style={{ color: "#ef4f7c" }}>DELETE MODE</strong></>}
          </span>
        )}
      </div>

      <div className="builder-stage">
        <div className="builder-canvas">
          <svg
            ref={svgRef}
            viewBox={`0 0 ${WHEEL_SIZE} ${WHEEL_SIZE}`}
            width="100%"
            height="100%"
            style={{ display: "block", touchAction: "none", cursor: deleteMode ? "crosshair" : "default" }}
            onPointerDown={onBackgroundPointerDown}
          >
            <defs>
              {EDGE_KINDS.map((k) => (
                <marker
                  key={k}
                  id={`b-arrow-${k}`}
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerUnits="userSpaceOnUse"
                  markerWidth={11}
                  markerHeight={11}
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" fill={EDGE_COLORS[k]} />
                </marker>
              ))}
            </defs>

            <circle cx={WHEEL_SIZE / 2} cy={WHEEL_SIZE / 2} r={320} fill="none" stroke="#222" strokeWidth={1} />
            <circle cx={WHEEL_SIZE / 2} cy={WHEEL_SIZE / 2} r={240} fill="none" stroke="#1c1c1c" strokeWidth={1} />
            <circle cx={WHEEL_SIZE / 2} cy={WHEEL_SIZE / 2} r={175} fill="none" stroke="#1c1c1c" strokeWidth={1} />

            <g>
              {edges.map((e, i) => {
                const a = nodeById[e.from];
                const b = nodeById[e.to];
                if (!a || !b) return null;
                const color = EDGE_COLORS[e.kind];
                const markerEnd = `url(#b-arrow-${e.kind})`;
                const markerStart = e.bidirectional ? `url(#b-arrow-${e.kind})` : undefined;
                const dash = e.kind === "color" || e.kind === "tension" ? "4 4" : undefined;

                if (e.kind === "petal") {
                  const cx = WHEEL_SIZE / 2;
                  const cy = WHEEL_SIZE / 2;
                  const mx = (a.x + b.x) / 2;
                  const my = (a.y + b.y) / 2;
                  const k = 2.6;
                  const qx = cx + (mx - cx) * k;
                  const qy = cy + (my - cy) * k;
                  const aEnd = pullTowards(a.x, a.y, qx, qy, nodeRadius(a.type) + 4);
                  const bEnd = pullTowards(b.x, b.y, qx, qy, nodeRadius(b.type) + 4);
                  const d = `M ${aEnd.x} ${aEnd.y} Q ${qx} ${qy} ${bEnd.x} ${bEnd.y}`;
                  return (
                    <g key={i}>
                      <path
                        d={d}
                        fill="none"
                        stroke={color}
                        strokeWidth={2.2}
                        strokeOpacity={0.85}
                        markerEnd={markerEnd}
                        markerStart={markerStart}
                      />
                      <path
                        d={d}
                        fill="none"
                        stroke="transparent"
                        strokeWidth={14}
                        pointerEvents="stroke"
                        style={{ cursor: deleteMode ? "crosshair" : "default" }}
                        onPointerDown={(ev) => {
                          ev.stopPropagation();
                          deleteEdgeAt(i);
                        }}
                      />
                    </g>
                  );
                }

                const aEnd = pullTowards(a.x, a.y, b.x, b.y, nodeRadius(a.type) + 4);
                const bEnd = pullTowards(b.x, b.y, a.x, a.y, nodeRadius(b.type) + 4);
                return (
                  <g key={i}>
                    <line
                      x1={aEnd.x}
                      y1={aEnd.y}
                      x2={bEnd.x}
                      y2={bEnd.y}
                      stroke={color}
                      strokeWidth={2.2}
                      strokeOpacity={0.85}
                      strokeDasharray={dash}
                      markerEnd={markerEnd}
                      markerStart={markerStart}
                    />
                    <line
                      x1={aEnd.x}
                      y1={aEnd.y}
                      x2={bEnd.x}
                      y2={bEnd.y}
                      stroke="transparent"
                      strokeWidth={14}
                      pointerEvents="stroke"
                      style={{ cursor: deleteMode ? "crosshair" : "default" }}
                      onPointerDown={(ev) => {
                        ev.stopPropagation();
                        deleteEdgeAt(i);
                      }}
                    />
                  </g>
                );
              })}
            </g>

            <g>
              {nodes.map((n) => {
                const r = nodeRadius(n.type);
                const color = NODE_COLORS[n.type];
                const isPending = pendingFrom === n.id;
                const isHover = hoverId === n.id;
                return (
                  <g
                    key={n.id}
                    onPointerDown={(ev) => onNodePointerDown(ev, n)}
                    onPointerMove={onNodePointerMove}
                    onPointerUp={onNodePointerUp}
                    onPointerEnter={() => setHoverId(n.id)}
                    onPointerLeave={() => setHoverId((id) => (id === n.id ? null : id))}
                    style={{ cursor: deleteMode ? "crosshair" : "grab", touchAction: "none" }}
                  >
                    {(isPending || isHover) && (
                      <circle
                        cx={n.x}
                        cy={n.y}
                        r={r + (isPending ? 10 : 6)}
                        fill="none"
                        stroke={color}
                        strokeWidth={2}
                        strokeOpacity={isPending ? 0.9 : 0.5}
                      />
                    )}
                    <circle
                      cx={n.x}
                      cy={n.y}
                      r={r}
                      fill="#0a0a0a"
                      stroke={color}
                      strokeWidth={2}
                    />
                    <text
                      x={n.x}
                      y={n.y}
                      textAnchor="middle"
                      dominantBaseline="central"
                      fill={color}
                      fontSize={n.type === "maj" ? 17 : 14}
                      fontWeight={600}
                      fontFamily="ui-sans-serif, system-ui, sans-serif"
                      style={{ pointerEvents: "none", userSelect: "none" }}
                    >
                      {n.label}
                    </text>
                  </g>
                );
              })}
            </g>
          </svg>
        </div>

        <aside className="builder-side">
          <section>
            <h2>How to save</h2>
            <ol className="howto">
              <li>Build the graph here.</li>
              <li>Click <strong>Download JSON</strong>.</li>
              <li>Replace <code>public/wheel-data.json</code> with the downloaded file.</li>
              <li>Reload the player.</li>
            </ol>
          </section>
          <section>
            <h2>Edges</h2>
            <div className="edge-list">
              {edges.length === 0 && <span className="hint">No edges yet.</span>}
              {edges.map((e, i) => (
                <div key={i} className="edge-row" style={{ borderLeftColor: EDGE_COLORS[e.kind] }}>
                  <span className="edge-arrow">
                    {e.from} {e.bidirectional ? "↔" : "→"} {e.to}
                  </span>
                  <span className="edge-kind" style={{ color: EDGE_COLORS[e.kind] }}>{e.kind}</span>
                  <button className="ghost edge-del" onClick={() => deleteEdgeAt(i)}>×</button>
                </div>
              ))}
            </div>
          </section>
        </aside>
      </div>

      {exportText != null && (
        <div className="export-overlay" onClick={() => setExportText(null)}>
          <div className="export-panel" onClick={(e) => e.stopPropagation()}>
            <div className="export-head">
              <strong>wheel-data.json</strong>
              <span className="muted">Copied to clipboard. Save this over <code>public/wheel-data.json</code>.</span>
              <button onClick={() => setExportText(null)} className="ghost">Close</button>
            </div>
            <textarea readOnly value={exportText} />
          </div>
        </div>
      )}
    </div>
  );
}
