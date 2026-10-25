import { Fragment, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { CircleMarker, MapContainer, Polyline, TileLayer, Tooltip, useMap } from "react-leaflet";
import { AlertTriangle, Clock3, MapPin, ShieldCheck, X } from "lucide-react";
import { inspectSignalSafety, JUNCTIONS, JUNCTION_NAMES, ROAD_DEFINITIONS, ROAD_CAPACITY } from "../networkEngine";
import type { JunctionId } from "../networkEngine";
import { useTraffic } from "../TrafficContext";
import { getEvents, subscribeToEvents } from "../eventStore";

const COORDINATES: Record<JunctionId, [number, number]> = {
  A: [13.0524, 80.2510],
  B: [13.0420, 80.2450],
  C: [13.0301, 80.2414],
  D: [13.0240, 80.2240],
};

const densityColor = (density: number): string =>
  density > 0.75 ? "#EF4444" : density > 0.4 ? "#ffe600" : "#00f3ff";

export default function TrafficIncidents(): React.JSX.Element {
  const { events, states, mode, setRoadBlock, safetyTelemetry, testConflictIntercept } = useTraffic();
  const storedEvents = useSyncExternalStore(subscribeToEvents, getEvents, getEvents);
  const state = states[mode];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const spillbacks = ROAD_DEFINITIONS.filter((road) => state.blockedRoads[road.id]);
  const roadBlocks = ROAD_DEFINITIONS.filter((road) => state.roadBlocks[road.id]);
  const safety = inspectSignalSafety(state);
  const records = useMemo(() => storedEvents.slice().reverse(), [storedEvents]);
  const incidents = events.filter((event) =>
    event.kind === "spillback" || event.kind === "phase" || event.kind === "roadblock" ||
    event.kind === "safety" || event.kind === "preemption"
  );
  const mapIncidents = incidents.length
    ? incidents
    : spillbacks.map((road) => ({
        id: `blocked-${road.id}`,
        tick: state.tick,
        kind: "spillback" as const,
        message: `Queue spillback on link ${JUNCTION_NAMES[road.from]} → ${JUNCTION_NAMES[road.to]}`,
        junction: road.to,
      }));
  const selected = mapIncidents.find((event) => event.id === selectedId) ?? mapIncidents[0];

  return (
    <div className="content-page">
      <div className="page-heading"><div><p className="eyebrow">ROAD SAFETY MONITOR · SHARED SIMULATION EVENTS</p><h1>Incidents & safety</h1><p>Explore signal safety, road closures, detours, and spillback events from the active simulation.</p></div><span className="simulation-badge"><i /> {roadBlocks.length} ROADBLOCKS · {spillbacks.length} SPILLBACKS</span></div>
      <section className={`panel safety-guardian ${safety.clear ? "safety-clear" : "safety-conflict"}`}>
        <div className="safety-heading">
          <div className="safety-status"><ShieldCheck size={18} /><strong>🛡️ Safety Guardian Console</strong></div>
          <span className="guardian-clearance-badge">STATUS: {safetyTelemetry.status === "CONFLICT" ? "SAFETY VIOLATION DETECTED — FAILSAFE ENGAGED" : "ACTIVE / NO CONFLICTS"}</span>
        </div>
        <div className="safety-meters">
          <div><span>Signal Phase Locks</span><strong>{safetyTelemetry.mutexStatus}</strong></div>
          <div><span>All-Red Clearance Timer</span><strong>{safetyTelemetry.clearanceSeconds.toFixed(1)}s</strong></div>
          <div><span>Red-Light Violation Audit</span><strong>{safetyTelemetry.violationAuditCount}</strong></div>
          <div><span>Inspection cadence</span><strong>100ms · #{safetyTelemetry.inspectionCount}</strong></div>
        </div>
        <div className="safety-log" aria-live="polite">
          {(safety.clear ? safetyTelemetry.logs : safety.conflicts).map((log) => <p key={log}>{log}</p>)}
        </div>
        <button className="safety-test-button" onClick={testConflictIntercept}>
          <ShieldCheck size={14} /> Test Conflict Intercept
        </button>
      </section>
      <section className="panel roadblock-controls">
        <div className="panel-heading"><div><p className="eyebrow">DEMO SCENARIO</p><h2>Accident & lane closure injection</h2></div><span className="chart-window">Detours shared across both modes</span></div>
        <div className="roadblock-button-grid">
          {ROAD_DEFINITIONS.map((road) => {
            const active = state.roadBlocks[road.id];
            return (
              <button
                className={`roadblock-button ${active ? "active" : ""}`}
                key={road.id}
                onClick={() => setRoadBlock(road.id, !active)}
                aria-pressed={active}
              >
                <AlertTriangle size={14} />
                {active ? `Clear ${JUNCTION_NAMES[road.from]} → ${JUNCTION_NAMES[road.to]} roadblock` : `Inject accident on ${JUNCTION_NAMES[road.from]} → ${JUNCTION_NAMES[road.to]} lane`}
              </button>
            );
          })}
        </div>
        <p className="roadblock-note">Incoming vehicles are rerouted over open links; vehicles already on a closed lane may clear it safely.</p>
      </section>
      <div className="incident-map-layout">
        <section className="map-shell incident-map-shell">
          <div className="map-toolbar"><div><p className="eyebrow">ALERT & CLOSURE MAP</p><h2>Flow impact · Chennai Smart Grid</h2></div><span className="chart-window">T+{(state.tick * 0.5).toFixed(1)}s</span></div>
          <div className="corridor-location-badge">
            <strong>📍 CORRIDOR: Anna Salai (Mount Road), Chennai | JUNCTIONS: Gemini Flyover · Teynampet · Nandanam · Saidapet</strong>
            <span>4 Adaptive Nodes Active · JICA Intelligent Transport System (ITS) Integration</span>
          </div>
          <div className="incident-map-view">
            <MapContainer center={[13.0420, 80.2450]} zoom={14} scrollWheelZoom className="leaflet-map">
              <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
              <FocusIncident junction={selected?.junction} />
              {ROAD_DEFINITIONS.filter((road) => road.from < road.to).map((road) => (
                <Polyline key={road.id} positions={[COORDINATES[road.from], COORDINATES[road.to]]} pathOptions={{
                  color: state.roadBlocks[road.id] || state.roadBlocks[`${road.to}${road.from}`]
                      ? "#991B1B"
                      : state.blockedRoads[road.id] || state.blockedRoads[`${road.to}${road.from}`] ? "#EF4444" : "#DC2626",
                    weight: 6,
                    opacity: 0.9,
                  dashArray: state.roadBlocks[road.id] || state.roadBlocks[`${road.to}${road.from}`] ||
                    state.blockedRoads[road.id] || state.blockedRoads[`${road.to}${road.from}`] ? "8 7" : undefined,
                    className: `neon-road road-flow ${state.roadBlocks[road.id] || state.roadBlocks[`${road.to}${road.from}`] ? "road-detour" : state.blockedRoads[road.id] || state.blockedRoads[`${road.to}${road.from}`] ? "road-severe" : ""}`,
                }} />
              ))}
              {JUNCTIONS.map((junction) => {
                const incoming = ROAD_DEFINITIONS.filter((road) => road.to === junction);
                const density = incoming.reduce((sum, road) => sum + state.roads[road.id].length, 0)
                  / (incoming.length * ROAD_CAPACITY);
                const failSafe = state.signalSafety[junction].mode === "ALL_RED";
                const color = failSafe ? "#ff0055" : densityColor(density);
                return (
                  <CircleMarker
                    key={`junction-${junction}`}
                    center={COORDINATES[junction]}
                    radius={10}
                    pathOptions={{
                      color,
                      fillColor: color,
                      fillOpacity: 0.95,
                      weight: 4,
                      className: `neon-node ${failSafe || density > 0.75 ? "node-severe" : density > 0.4 ? "node-moderate" : "node-clear"}`,
                    }}
                  >
                    <Tooltip>{JUNCTION_NAMES[junction]} · Junction {junction}{failSafe ? " · ALL-RED FAIL-SAFE" : ""}</Tooltip>
                  </CircleMarker>
                );
              })}
              {mapIncidents.map((event) => (
                <CircleMarker key={event.id} center={COORDINATES[event.junction]} radius={selected?.id === event.id ? 12 : 8}
                    pathOptions={{
                      color: "#ffffff",
                      fillColor: event.kind === "spillback" || event.kind === "safety"
                        ? "#ff0055"
                        : event.kind === "preemption" ? "#22c55e" : "#ffe600",
                      fillOpacity: 0.95,
                      weight: 3,
                      className: `neon-node ${event.kind === "spillback" || event.kind === "safety" ? "node-severe" : event.kind === "preemption" ? "node-clear" : "node-moderate"}`,
                    }}
                  eventHandlers={{ click: () => setSelectedId(event.id) }}>
                  <Tooltip>{JUNCTION_NAMES[event.junction]} · {event.kind}</Tooltip>
                </CircleMarker>
              ))}
              {roadBlocks.map((road) => {
                const from = COORDINATES[road.from];
                const to = COORDINATES[road.to];
                const midpoint: [number, number] = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
                return (
                  <Fragment key={`closure-layer-${road.id}`}>
                    <Polyline key={`closure-${road.id}`} positions={[from, to]} pathOptions={{ color: "#991B1B", weight: 7, opacity: 0.9, dashArray: "8 7", className: "neon-road road-detour road-warning" }} />
                    <CircleMarker key={`hazard-${road.id}`} center={midpoint} radius={9} pathOptions={{ color: "#ff0055", fillColor: "#ffe600", fillOpacity: 1, weight: 4, className: "neon-node node-severe road-warning" }}>
                      <Tooltip>🚧 CLOSED · Lane {JUNCTION_NAMES[road.from]} → {JUNCTION_NAMES[road.to]}</Tooltip>
                    </CircleMarker>
                  </Fragment>
                );
              })}
              {spillbacks.map((road) => <Polyline key={`spillback-${road.id}`} positions={[COORDINATES[road.from], COORDINATES[road.to]]} pathOptions={{ color: "#EF4444", weight: 7, opacity: 0.9, className: "neon-road road-severe road-warning" }} />)}
            </MapContainer>
            <div className="closure-key"><span><i className="closure-red" /> Roadblock / spillback</span><span><i className="closure-amber" /> Detour / phase event</span></div>
          </div>
          <div className="sim-disclaimer">SIMULATION MODEL — SYNTHETIC TRAFFIC DATA FOR ALGORITHMIC BENCHMARKING</div>
        </section>
        <section className="panel incident-log">
          <div className="panel-heading"><div><p className="eyebrow">TIMESTAMPED EVENT LOG</p><h2>{records.length} event{records.length === 1 ? "" : "s"}</h2></div><Clock3 size={16} /></div>
          <div className="incident-log-list">
            {records.length === 0 ? <p className="empty-events">No incidents yet. Start the kernel to generate events.</p> : records.map((event) => (
              <article className="incident-log-entry" key={event.id}>
                <span className={`incident-icon ${event.severity === "critical" || event.severity === "warn" ? "red" : "amber"}`}><AlertTriangle size={15} /></span>
                <span className="incident-log-copy"><b>{event.message}</b><small>[T+{event.simulationSeconds.toFixed(1)}s] · {event.wallTime}</small><small>{event.type}{event.lane ? ` · ${event.lane}` : ""} · {event.simTime}</small></span>
                <MapPin size={14} />
              </article>
            ))}
          </div>
          {selected && <div className="incident-impact"><button aria-label="Close incident details" onClick={() => setSelectedId(null)}><X size={13} /></button><b>Flow impact</b><p>{JUNCTION_NAMES[selected.junction]} (Junction {selected.junction}) event at simulation second {(selected.tick * 0.5).toFixed(1)}. The map is focused on the affected node and surrounding links.</p></div>}
        </section>
      </div>
    </div>
  );
}

function FocusIncident({ junction }: { junction?: JunctionId }): null {
  const map = useMap();
  useEffect(() => {
    if (junction) map.flyTo(COORDINATES[junction], 15, { duration: 0.5 });
  }, [junction, map]);
  return null;
}
