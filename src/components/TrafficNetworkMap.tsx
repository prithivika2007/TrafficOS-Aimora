import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet.heat";
import { CircleMarker, MapContainer, Marker, Polyline, TileLayer, Tooltip, useMap } from "react-leaflet";
import { Activity, ArrowUpRight, Clock3, Layers3, MapPin, X } from "lucide-react";
import {
  JUNCTIONS,
  JUNCTION_NAMES,
  ROAD_DEFINITIONS,
  ROAD_CAPACITY,
  networkMetrics,
  roadDensity,
} from "../networkEngine";
import type { JunctionId, NetworkState } from "../networkEngine";
import { useTraffic } from "../TrafficContext";

const LOCATIONS: Record<JunctionId, [number, number]> = {
  A: [13.0524, 80.2510],
  B: [13.0420, 80.2450],
  C: [13.0301, 80.2414],
  D: [13.0240, 80.2240],
};

const COLORS = {
  normal: "#DC2626",
  congested: "#EF4444",
  detour: "#991B1B",
  amber: "#ffe600",
  green: "#00f3ff",
  red: "#ff0055",
};
export type MapScenario = { id: number; kind: "emergency" | "coordination" };
const EMERGENCY_PATH: [number, number][] = [
  [13.0524, 80.2510],
  LOCATIONS.A,
  LOCATIONS.B,
  LOCATIONS.C,
  LOCATIONS.D,
  [13.0240, 80.2240],
];
const COORDINATION_PATHS: [number, number][][] = [
  [LOCATIONS.A, LOCATIONS.B, LOCATIONS.D],
  [LOCATIONS.A, LOCATIONS.C, LOCATIONS.D],
  [LOCATIONS.D, LOCATIONS.C, LOCATIONS.A],
];
type HeatLayerWithFrame = L.HeatLayer & { _frame?: number | null };

const colorForDensity = (density: number): string =>
  density > 0.75 ? COLORS.red : density > 0.4 ? COLORS.amber : COLORS.green;

const incomingDensity = (state: NetworkState, junction: JunctionId): number => {
  const incoming = ROAD_DEFINITIONS.filter((road) => road.to === junction);
  const vehicles = incoming.reduce((sum, road) => sum + state.roads[road.id].length, 0);
  return vehicles / (incoming.length * ROAD_CAPACITY);
};

interface TrafficNetworkMapProps {
  onOpenLab: () => void;
  compact?: boolean;
  scenario?: MapScenario | null;
}

export default function TrafficNetworkMap({
  onOpenLab,
  compact = false,
  scenario = null,
}: TrafficNetworkMapProps): React.JSX.Element {
  const [selected, setSelected] = useState<JunctionId | null>(null);
  const { states, mode, events, running, triggerJunctionPreemption } = useTraffic();
  const network = states[mode];
  const metrics = networkMetrics(network);
  const recentSignalEvent = events.find((event) => event.kind === "phase" && event.junction === selected);
  const handleScenarioApproach = useCallback((junction: JunctionId) => {
    triggerJunctionPreemption(junction, scenario?.kind === "coordination");
  }, [scenario?.kind, triggerJunctionPreemption]);

  return (
    <section className={`map-shell ${compact ? "map-shell-compact" : ""}`}>
      <div className="map-toolbar">
        <div>
          <p className="eyebrow">NETWORK MONITOR · LIVE SIMULATION</p>
          <h2>Chennai Smart Grid traffic network</h2>
        </div>
        <div className="map-tools">
          <span className={`map-live ${running ? "" : "map-paused"}`}><i /> {running ? "LIVE SIMULATION" : "KERNEL PAUSED"}</span>
          <button className="icon-button" aria-label="Map layers"><Layers3 size={17} /></button>
        </div>
      </div>
      <div className="corridor-location-badge">
        <strong>📍 CORRIDOR: Anna Salai (Mount Road), Chennai | JUNCTIONS: Gemini Flyover · Teynampet · Nandanam · Saidapet</strong>
        <span>4 Adaptive Nodes Active · JICA Intelligent Transport System (ITS) Integration</span>
      </div>
      <div className="map-view">
        <MapContainer center={[13.0420, 80.2450]} zoom={14} scrollWheelZoom className="leaflet-map">
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <TrafficHeatLayer state={network} />
          {ROAD_DEFINITIONS.filter((road) => road.from < road.to).map((road) => {
            const reverseId = `${road.to}${road.from}`;
            const density = Math.max(roadDensity(network, road.id), roadDensity(network, reverseId));
            const spillback = network.links[road.id].spillback || network.links[reverseId].spillback;
            const roadBlocked = network.roadBlocks[road.id] || network.roadBlocks[reverseId];
            return (
              <Polyline
                key={road.id}
                positions={[LOCATIONS[road.from], LOCATIONS[road.to]]}
                pathOptions={{
                  color: roadBlocked ? COLORS.detour : spillback || density > 0.75 ? COLORS.congested : COLORS.normal,
                  weight: 6,
                  opacity: 0.9,
                  className: `neon-road road-flow ${roadBlocked ? "road-detour" : spillback || density > 0.75 ? "road-severe" : ""}`,
                }}
              >
                <Tooltip sticky>{`${JUNCTION_NAMES[road.from]} ↔ ${JUNCTION_NAMES[road.to]} · ${Math.round(density * 100)}% capacity${roadBlocked ? " · ROADBLOCK — DETOUR ACTIVE" : spillback ? " · SPILLBACK DETECTED" : ""}`}</Tooltip>
              </Polyline>
            );
          })}
          {JUNCTIONS.map((junction) => (
            <CircleMarker
              key={junction}
              center={LOCATIONS[junction]}
              radius={selected === junction ? 12 : 9}
              pathOptions={{
                color: network.signalSafety[junction].mode === "ALL_RED"
                  ? COLORS.red
                  : colorForDensity(incomingDensity(network, junction)),
                fillColor: network.signalSafety[junction].mode === "ALL_RED"
                  ? COLORS.red
                  : colorForDensity(incomingDensity(network, junction)),
                fillOpacity: 0.95,
                weight: 4,
                className: `neon-node ${network.signalSafety[junction].mode === "ALL_RED" || incomingDensity(network, junction) > 0.75 ? "node-severe" : incomingDensity(network, junction) > 0.4 ? "node-moderate" : "node-clear"}`,
              }}
              eventHandlers={{ click: () => setSelected(junction) }}
            >
              <Tooltip direction="top" offset={[0, -9]}>{`${JUNCTION_NAMES[junction]} · Junction ${junction}${network.signalSafety[junction].mode === "ALL_RED" ? ` · ALL-RED FAIL-SAFE (${(network.signalSafety[junction].clearanceTicks * 0.5).toFixed(1)}s)` : ""}`}</Tooltip>
            </CircleMarker>
          ))}
          {scenario && (
            <AnimatedTrafficScenario
              scenario={scenario}
              onApproachJunction={handleScenarioApproach}
            />
          )}
        </MapContainer>
        {scenario && (
          <div className={`map-scenario-status ${scenario.kind}`}>
            {scenario.kind === "emergency" ? "🚨 ISR PREEMPTION · GREEN WAVE ACTIVE" : "🟢 COORDINATED GREEN WAVE · ACTIVE"}
          </div>
        )}
        <div className="map-legend">
          <span><i className="legend-green" /> Free flow</span>
          <span><i className="legend-amber" /> Moderate</span>
          <span><i className="legend-red" /> Congested</span>
        </div>
        {selected && (
          <aside className="junction-panel">
            <button className="junction-close" onClick={() => setSelected(null)} aria-label="Close details">
              <X size={16} />
            </button>
            <p className="eyebrow">SIGNAL NODE · JUNCTION {selected}</p>
            <h3>{JUNCTION_NAMES[selected]}</h3>
            <div className="junction-phase"><span className="signal-dot" />{network.signalSafety[selected].mode === "ALL_RED" ? ` ALL-RED FAIL-SAFE · ${(network.signalSafety[selected].clearanceTicks * 0.5).toFixed(1)}s` : ` SIGNAL PHASE ${network.phases[selected] + 1} ACTIVE`}</div>
            <div className="junction-stats">
              <div><span>Incoming queues</span><strong>{incomingQueue(network, selected)} vehicles</strong></div>
              <div><span>Road capacity</span><strong>{ROAD_CAPACITY} vehicles / link</strong></div>
              <div><span>Recent signal event</span><strong>{recentSignalEvent ? `${recentSignalEvent.message} · T+${(recentSignalEvent.tick * .5).toFixed(1)}s` : "No phase transition yet"}</strong></div>
            </div>
            <button className="text-link" onClick={onOpenLab}>Open network lab <ArrowUpRight size={14} /></button>
          </aside>
        )}
        {!compact && (
          <div className="map-float-metric">
            <div className="float-icon"><Activity size={16} /></div>
            <div><span>NETWORK THROUGHPUT</span><strong>{Math.round(metrics.throughput)} <small>veh / min</small></strong></div>
            <div className="float-divider" />
            <div><span>AVG. DELAY</span><strong>{metrics.averageWait.toFixed(1)} <small>sec</small></strong></div>
          </div>
        )}
      </div>
      <div className="map-footer">
        <div><MapPin size={14} /> 4 intersections <span>·</span> 8 connected road links</div>
        <div><Clock3 size={14} /> Tick {network.tick}</div>
      </div>
      <div className="sim-disclaimer">SIMULATION MODEL — SYNTHETIC TRAFFIC DATA FOR ALGORITHMIC BENCHMARKING</div>
    </section>
  );
}

function AnimatedTrafficScenario({
  scenario,
  onApproachJunction,
}: {
  scenario: MapScenario;
  onApproachJunction: (junction: JunctionId) => void;
}): React.JSX.Element {
  const [progress, setProgress] = useState(0);
  const progressRef = useRef(0);
  const preempted = useRef(new Set<JunctionId>());
  const path = scenario.kind === "emergency" ? EMERGENCY_PATH : COORDINATION_PATHS[0];
  const pathLengths = useMemo(() => getPathLengths(path), [path]);
  const ambulanceIcon = useMemo(() => L.divIcon({
    className: "ambulance-map-icon",
    html: '<span aria-label="Emergency vehicle">🚨</span>',
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  }), []);
  const currentPosition = pointAlongPath(path, pathLengths, progress);
  const traveledPath = pathToProgress(path, pathLengths, progress);

  const reportApproaches = useCallback((currentProgress: number) => {
    const junctions: { id: JunctionId; threshold: number }[] = scenario.kind === "emergency"
      ? [
          { id: "A", threshold: pathLengths[1] / pathLengths[pathLengths.length - 1] },
          { id: "B", threshold: pathLengths[2] / pathLengths[pathLengths.length - 1] },
          { id: "C", threshold: pathLengths[3] / pathLengths[pathLengths.length - 1] },
          { id: "D", threshold: pathLengths[4] / pathLengths[pathLengths.length - 1] },
        ]
      : [
          { id: "A", threshold: 0.04 },
          { id: "B", threshold: 0.3 },
          { id: "C", threshold: 0.62 },
          { id: "D", threshold: 0.9 },
        ];
    junctions.forEach(({ id, threshold }) => {
      if (currentProgress >= threshold - 0.04 && !preempted.current.has(id)) {
        preempted.current.add(id);
        onApproachJunction(id);
      }
    });
  }, [onApproachJunction, pathLengths, scenario.kind]);

  useEffect(() => {
    progressRef.current = 0;
    preempted.current.clear();
    setProgress(0);
    const durationMs = scenario.kind === "emergency" ? 18000 : 12000;
    let frame = 0;
    let startedAt: number | null = null;
    const animate = (now: number) => {
      if (startedAt === null) startedAt = now;
      const nextProgress = Math.min(1, (now - startedAt) / durationMs);
      progressRef.current = nextProgress;
      setProgress(nextProgress);
      reportApproaches(nextProgress);
      if (nextProgress < 1) frame = window.requestAnimationFrame(animate);
    };
    frame = window.requestAnimationFrame(animate);
    return () => window.cancelAnimationFrame(frame);
  }, [reportApproaches, scenario.id, scenario.kind]);

  if (scenario.kind === "emergency") {
    return (
      <>
        <Polyline positions={path} pathOptions={{ color: "#22c55e", weight: 10, opacity: 0.24, className: "emergency-corridor-glow" }} />
        {traveledPath.length > 1 && <Polyline positions={traveledPath} pathOptions={{ color: "#4ade80", weight: 6, opacity: 1, className: "emergency-corridor-active" }} />}
        <Marker position={currentPosition} icon={ambulanceIcon} zIndexOffset={1000}>
          <Tooltip permanent direction="top" offset={[0, -13]}>ISR GREEN WAVE</Tooltip>
        </Marker>
      </>
    );
  }

  return (
    <>
      {COORDINATION_PATHS.map((vehiclePath, index) => {
        const lengths = getPathLengths(vehiclePath);
        const position = pointAlongPath(vehiclePath, lengths, (progress + index / 3) % 1);
        return (
          <CircleMarker
            key={`coordination-vehicle-${index}`}
            center={position}
            radius={index === 0 ? 6 : 5}
            pathOptions={{ color: "#ffffff", weight: 2, fillColor: "#22c55e", fillOpacity: 1, className: "coordinated-vehicle-dot" }}
          >
            <Tooltip>Green-wave synchronized vehicle</Tooltip>
          </CircleMarker>
        );
      })}
      <Polyline positions={COORDINATION_PATHS[0]} pathOptions={{ color: "#22c55e", weight: 4, opacity: 0.45, dashArray: "10 12", className: "coordination-green-wave" }} />
    </>
  );
}

function getPathLengths(path: [number, number][]): number[] {
  return path.reduce<number[]>((lengths, point, index) => {
    if (index === 0) return [0];
    const previous = path[index - 1];
    return [...lengths, lengths[index - 1] + Math.hypot(point[0] - previous[0], point[1] - previous[1])];
  }, []);
}

function pointAlongPath(path: [number, number][], lengths: number[], progress: number): [number, number] {
  const totalLength = lengths[lengths.length - 1] || 1;
  const distance = Math.max(0, Math.min(1, progress)) * totalLength;
  const segment = lengths.findIndex((length, index) => index > 0 && length >= distance);
  if (segment < 0) return path[path.length - 1];
  const segmentLength = lengths[segment] - lengths[segment - 1] || 1;
  const ratio = (distance - lengths[segment - 1]) / segmentLength;
  return [
    path[segment - 1][0] + (path[segment][0] - path[segment - 1][0]) * ratio,
    path[segment - 1][1] + (path[segment][1] - path[segment - 1][1]) * ratio,
  ];
}

function pathToProgress(path: [number, number][], lengths: number[], progress: number): [number, number][] {
  const distance = progress * (lengths[lengths.length - 1] || 1);
  const lastComplete = lengths.findIndex((length, index) => index > 0 && length >= distance);
  if (lastComplete < 0) return path;
  return [...path.slice(0, lastComplete), pointAlongPath(path, lengths, progress)];
}

function incomingQueue(state: NetworkState, junction: JunctionId): number {
  return ROAD_DEFINITIONS.filter((road) => road.to === junction)
    .reduce((sum, road) => sum + state.roads[road.id].length, 0);
}

function TrafficHeatLayer({ state }: { state: NetworkState }): null {
  const map = useMap();
  const heatLayer = useRef<L.HeatLayer | null>(null);
  useEffect(() => {
    const layer = L.heatLayer([], {
      radius: 34,
      blur: 25,
      maxZoom: 16,
      max: 1,
      gradient: { 0.2: COLORS.green, 0.55: COLORS.amber, 0.9: COLORS.red },
    }).addTo(map);
    heatLayer.current = layer;
    return () => {
      const pendingFrame = (layer as HeatLayerWithFrame)._frame;
      if (pendingFrame != null) L.Util.cancelAnimFrame(pendingFrame);
      map.removeLayer(layer);
      heatLayer.current = null;
    };
  }, [map]);
  useEffect(() => {
    const points: L.HeatLatLngTuple[] = JUNCTIONS.map((junction) => {
      const incomingRoadCount = ROAD_DEFINITIONS.filter((road) => road.to === junction).length;
      const intensity = Math.min(1, incomingQueue(state, junction) / (incomingRoadCount * ROAD_CAPACITY));
      return [LOCATIONS[junction][0], LOCATIONS[junction][1], intensity];
    });
    heatLayer.current?.setLatLngs(points);
  }, [state]);
  return null;
}
