import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet.heat";
import { CircleMarker, MapContainer, Polyline, TileLayer, Tooltip, useMap } from "react-leaflet";
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
  A: [37.779, -122.421],
  B: [37.784, -122.409],
  C: [37.769, -122.411],
  D: [37.778, -122.397],
};

const COLORS = { teal: "#00f3ff", green: "#00f3ff", amber: "#ffe600", red: "#ff0055" };
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
}

export default function TrafficNetworkMap({
  onOpenLab,
  compact = false,
}: TrafficNetworkMapProps): React.JSX.Element {
  const [selected, setSelected] = useState<JunctionId | null>(null);
  const { states, mode, events, running } = useTraffic();
  const network = states[mode];
  const metrics = networkMetrics(network);
  const recentSignalEvent = events.find((event) => event.kind === "phase" && event.junction === selected);

  return (
    <section className={`map-shell ${compact ? "map-shell-compact" : ""}`}>
      <div className="map-toolbar">
        <div>
          <p className="eyebrow">NETWORK MONITOR · LIVE SIMULATION</p>
          <h2>Central District traffic network</h2>
        </div>
        <div className="map-tools">
          <span className={`map-live ${running ? "" : "map-paused"}`}><i /> {running ? "LIVE SIMULATION" : "KERNEL PAUSED"}</span>
          <button className="icon-button" aria-label="Map layers"><Layers3 size={17} /></button>
        </div>
      </div>
      <div className="map-view">
        <MapContainer center={[37.777, -122.409]} zoom={14} scrollWheelZoom className="leaflet-map">
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
                  color: roadBlocked || spillback ? COLORS.red : COLORS.teal,
                  weight: density > 0 ? 6 + Math.min(3, density * 3) : 6,
                  opacity: 1,
                  className: `neon-road road-flow ${roadBlocked || spillback ? "road-severe" : density > 0.75 ? "road-severe" : density > 0.4 ? "road-moderate" : ""}`,
                }}
              >
                <Tooltip sticky>{`${road.from} ↔ ${road.to} · ${Math.round(density * 100)}% capacity${roadBlocked ? " · ROADBLOCK — DETOUR ACTIVE" : spillback ? " · SPILLBACK DETECTED" : ""}`}</Tooltip>
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
              <Tooltip direction="top" offset={[0, -9]}>{`Junction ${junction} · ${JUNCTION_NAMES[junction]}${network.signalSafety[junction].mode === "ALL_RED" ? ` · ALL-RED FAIL-SAFE (${(network.signalSafety[junction].clearanceTicks * 0.5).toFixed(1)}s)` : ""}`}</Tooltip>
            </CircleMarker>
          ))}
        </MapContainer>
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
