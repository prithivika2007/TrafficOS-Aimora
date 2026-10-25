import {
  AlertTriangle,
  Activity,
  Pause,
  Play,
  RotateCcw,
  SkipForward,
  Waypoints,
} from "lucide-react";
import {
  ROAD_DEFINITIONS,
  JUNCTION_NAMES,
  networkMetrics,
  roadDensity,
  ROAD_CAPACITY,
} from "../networkEngine";
import type { NetworkState } from "../networkEngine";
import { useTraffic } from "../TrafficContext";
import type { TelemetryPoint } from "../TrafficContext";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

type MetricKey =
  | "independentWait"
  | "coordinatedWait"
  | "independentThroughput"
  | "coordinatedThroughput"
  | "independentQueue"
  | "coordinatedQueue"
  | "independentSpillbacks"
  | "coordinatedSpillbacks"
  | "independentTravel"
  | "coordinatedTravel";

const CHARTS: { title: string; unit: string; independent: MetricKey; coordinated: MetricKey }[] = [
  { title: "Average waiting time", unit: "seconds", independent: "independentWait", coordinated: "coordinatedWait" },
  { title: "Network throughput", unit: "vehicles / min", independent: "independentThroughput", coordinated: "coordinatedThroughput" },
  { title: "Maximum queue length", unit: "vehicles", independent: "independentQueue", coordinated: "coordinatedQueue" },
  { title: "Spillback incidents", unit: "events", independent: "independentSpillbacks", coordinated: "coordinatedSpillbacks" },
  { title: "Vehicle travel time", unit: "seconds", independent: "independentTravel", coordinated: "coordinatedTravel" },
];

export default function TrafficNetworkLab(): React.JSX.Element {
  const {
    states,
    history,
    running,
    mode,
    setMode,
    algorithm,
    setAlgorithm,
    start,
    pause,
    step,
    reset,
  } = useTraffic();
  const selectedState = states[mode];
  const selectedMetrics = networkMetrics(selectedState);
  const comparison: TelemetryPoint = history[history.length - 1];
  const totalVehicles =
    Object.values(selectedState.roads).reduce((sum, lane) => sum + lane.length, 0) +
    Object.values(selectedState.demand).reduce((sum, queue) => sum + queue.length, 0);

  return (
    <div className="lab-page">
      <div className="page-heading">
        <div><p className="eyebrow">COORDINATION SANDBOX</p><h1>Multi-intersection network lab</h1>
          <p>Compare isolated signal control with downstream-aware green-wave coordination.</p></div>
        <span className="simulation-badge"><i /> DETERMINISTIC SCENARIO · SEED 2026</span>
      </div>
      <div className="lab-controls panel">
        <div className="control-group">
          <button className={`mode-button ${mode === "independent" ? "selected" : ""}`} onClick={() => setMode("independent")}>Independent</button>
          <button className={`mode-button ${mode === "coordinated" ? "selected" : ""}`} onClick={() => setMode("coordinated")}>Coordinated</button>
          <span className="control-separator" />
          <button className={`mode-button ${algorithm === "ROUND_ROBIN" ? "selected" : ""}`} onClick={() => setAlgorithm("ROUND_ROBIN")}>Round Robin</button>
          <button className={`mode-button ${algorithm === "PRIORITY_AGING" ? "selected" : ""}`} onClick={() => setAlgorithm("PRIORITY_AGING")}>Priority + Aging</button>
          <span className="control-note"><Waypoints size={14} /> same arrivals, routes, capacity & clock</span>
        </div>
        <div className="control-group">
          <button className="primary-button" onClick={running ? pause : start}>{running ? <Pause size={15} /> : <Play size={15} />}{running ? "Pause" : "Start"}</button>
          <button className="secondary-button" onClick={step} disabled={running}><SkipForward size={15} /> Step 0.5s</button>
          <button className="icon-button" onClick={reset} aria-label="Reset simulation"><RotateCcw size={16} /></button>
        </div>
      </div>
      <div className="metric-grid">
        <Metric label="Average waiting" value={`${selectedMetrics.averageWait.toFixed(1)}s`} change={comparison.coordinatedWait - comparison.independentWait} />
        <Metric label="Network throughput" value={`${selectedMetrics.throughput.toFixed(0)}`} suffix="veh / min" change={comparison.coordinatedThroughput - comparison.independentThroughput} />
        <Metric label="Max queue length" value={`${selectedMetrics.maxQueue}`} suffix="vehicles" change={comparison.coordinatedQueue - comparison.independentQueue} />
        <Metric label="Spillback events" value={`${selectedMetrics.spillbacks}`} suffix="incidents" change={comparison.coordinatedSpillbacks - comparison.independentSpillbacks} />
        <Metric label="Travel time" value={`${selectedMetrics.travelTime.toFixed(1)}s`} change={comparison.coordinatedTravel - comparison.independentTravel} />
      </div>
      <div className="lab-layout">
        <section className="panel network-panel">
          <div className="panel-heading"><div><p className="eyebrow">ANNA SALAI · CHENNAI</p><h2>Four-junction corridor</h2></div>
            <span className="live-clock"><Activity size={14} /> T+{(selectedState.tick * 0.5).toFixed(1)}s</span></div>
          <div className="network-diagram">
            <div className="network-road horizontal-road" />
            <div className="network-road vertical-road" />
            <div className="network-road diagonal-road" />
            {Object.entries(selectedState.roads).flatMap(([roadId, vehicles]) =>
              vehicles.map((vehicle, index) => <i key={`${roadId}-${vehicle.id}`} className={`vehicle-particle particle-${index % 4}`} />)
            )}
            <div className="junction-node node-a"><span>A</span><b>Junction A</b><small>{JUNCTION_NAMES.A}</small><small>PHASE {selectedState.phases.A + 1}</small><i className="junction-signal" /></div>
            <div className="junction-node node-b"><span>B</span><b>Junction B</b><small>{JUNCTION_NAMES.B}</small><small>PHASE {selectedState.phases.B + 1}</small><i className="junction-signal" /></div>
            <div className="junction-node node-c"><span>C</span><b>Junction C</b><small>{JUNCTION_NAMES.C}</small><small>PHASE {selectedState.phases.C + 1}</small><i className="junction-signal" /></div>
            <div className="junction-node node-d"><span>D</span><b>Junction D</b><small>{JUNCTION_NAMES.D}</small><small>PHASE {selectedState.phases.D + 1}</small><i className="junction-signal" /></div>
          </div>
          <div className="network-link-grid" aria-label="Directional road link status">
            {ROAD_DEFINITIONS.map((road) => <Road key={road.id} roadId={road.id} state={selectedState} />)}
          </div>
          <div className="network-summary"><span>{totalVehicles} vehicles in network</span><span>Capacity: {ROAD_CAPACITY} vehicles / road</span><span>{mode === "coordinated" ? "Downstream telemetry active" : "Local control only"}</span></div>
        </section>
        <section className="panel chart-panel">
          <div className="panel-heading"><div><p className="eyebrow">LIVE COMPARISON</p><h2>Performance over time</h2></div><span className="chart-window">{history.length} samples</span></div>
          <div className="comparison-charts">{CHARTS.map((item) => (
            <article className="comparison-chart" key={item.title}>
              <div><b>{item.title}</b><span>{item.unit}</span></div>
              <ResponsiveContainer width="100%" height={132}>
                <LineChart data={history} margin={{ top: 8, right: 8, left: -24, bottom: 0 }}>
                  <CartesianGrid stroke="#253044" strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="time" tickFormatter={(value) => `${value}s`} stroke="#667085" tick={{ fontSize: 8 }} minTickGap={28} />
                  <YAxis stroke="#667085" tick={{ fontSize: 8 }} width={35} />
                  <Tooltip contentStyle={{ background: "#111827", border: "1px solid #2b3648", borderRadius: 8, color: "#e5e7eb", fontSize: 10 }} />
                  <Legend wrapperStyle={{ fontSize: 9, color: "#a8b0c0" }} />
                  <Line type="monotone" dataKey={item.coordinated} name="Coordinated" stroke="#14b8a6" strokeWidth={1.8} dot={false} isAnimationActive={false} />
                  <Line type="monotone" dataKey={item.independent} name="Independent" stroke="#f59e0b" strokeWidth={1.8} dot={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </article>
          ))}</div>
          <p className="chart-caption">Each point represents a 0.5-second simulation tick. Metrics freeze while paused.</p>
        </section>
      </div>
      <div className="sim-disclaimer">SIMULATION MODEL — SYNTHETIC TRAFFIC DATA FOR ALGORITHMIC BENCHMARKING</div>
    </div>
  );
}

function Metric({ label, value, suffix, change }: { label: string; value: string; suffix?: string; change: number }): React.JSX.Element {
  return <div className="metric-card"><span>{label}</span><strong>{value}<small>{suffix}</small></strong><em className={change <= 0 ? "positive" : "negative"}>{change > 0 ? "+" : ""}{change.toFixed(1)} vs mode</em></div>;
}

function Road({ roadId, state }: { roadId: string; state: NetworkState }): React.JSX.Element {
  const road = ROAD_DEFINITIONS.find((item) => item.id === roadId);
  const link = state.links[roadId];
  const density = roadDensity(state, roadId);
  const status = link.spillback ? "blocked" : density >= 0.75 ? "moderate" : "clear";
  return (
    <div className={`road-link ${status}`} aria-label={`${road?.from} to ${road?.to}, ${link.vehicleCount} of ${link.capacity} vehicles${link.spillback ? ", spillback detected" : ""}`}>
      <span>{road?.from} → {road?.to}</span>
      <i>{link.vehicleCount}/{link.capacity}</i>
      {link.spillback && <b className="spillback-label"><AlertTriangle size={10} /> SPILLBACK DETECTED</b>}
    </div>
  );
}
