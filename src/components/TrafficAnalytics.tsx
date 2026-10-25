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
import { Activity, PauseCircle, Sparkles } from "lucide-react";
import { useTraffic } from "../TrafficContext";

const CHARTS = [
  { title: "Average wait time", unit: "seconds", independent: "independentWait", coordinated: "coordinatedWait" },
  { title: "Network throughput", unit: "vehicles / min", independent: "independentThroughput", coordinated: "coordinatedThroughput" },
  { title: "Maximum queue length", unit: "vehicles", independent: "independentQueue", coordinated: "coordinatedQueue" },
] as const;

export default function TrafficAnalytics(): React.JSX.Element {
  const { history, running } = useTraffic();
  const latest = history[history.length - 1];
  const waitDelta = latest.independentWait - latest.coordinatedWait;
  const throughputDelta = latest.coordinatedThroughput - latest.independentThroughput;
  const summary =
    latest.time === 0
      ? "Start the shared kernel to generate a live comparison from the seeded traffic scenario."
      : waitDelta >= 0
        ? `At ${latest.time.toFixed(1)}s, coordinated control is reducing average wait by ${waitDelta.toFixed(1)}s. Throughput is ${throughputDelta >= 0 ? "up" : "down"} ${Math.abs(throughputDelta).toFixed(1)} vehicles/min versus independent control.`
        : `At ${latest.time.toFixed(1)}s, independent control currently has ${Math.abs(waitDelta).toFixed(1)}s lower average wait. The comparison will continue as the same seeded scenario advances.`;

  return (
    <div className="analytics-page">
      <div className="page-heading"><div><p className="eyebrow">PERFORMANCE INSIGHTS · SHARED KERNEL TELEMETRY</p><h1>Analytics suite</h1><p>Metrics are computed from vehicle arrivals, movement, service, and queue events in the live simulator.</p></div><span className={`analytics-state ${running ? "live" : ""}`}>{running ? <Activity size={14} /> : <PauseCircle size={14} />}{running ? "LIVE TELEMETRY" : "FROZEN · KERNEL PAUSED"}</span></div>
      <div className="analytics-kpis">
        <div className="metric-card"><span>Context switches</span><strong>{latest.contextSwitches}</strong><em>last 0.5s tick</em></div>
        <div className="metric-card"><span>Spillback count</span><strong>{latest.coordinatedSpillbacks}</strong><em>coordinated route</em></div>
        <div className="metric-card"><span>Simulation clock</span><strong>{latest.time.toFixed(1)}s</strong><em>{history.length} recorded samples</em></div>
      </div>
      <div className="analytics-charts">{CHARTS.map((chart) => (
        <section className="panel analytics-chart" key={chart.title}>
          <div className="panel-heading"><div><p className="eyebrow">{chart.unit.toUpperCase()}</p><h2>{chart.title}</h2></div><span className="chart-window">Independent vs coordinated</span></div>
          <div className="analytics-chart-canvas"><ResponsiveContainer width="100%" height="100%">
            <LineChart data={history} margin={{ top: 12, right: 16, bottom: 2, left: -18 }}>
              <CartesianGrid stroke="#253044" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="time" tickFormatter={(time) => `${time}s`} stroke="#667085" tick={{ fontSize: 9 }} />
              <YAxis stroke="#667085" tick={{ fontSize: 9 }} />
              <Tooltip contentStyle={{ background: "#0d1520", border: "1px solid #2b3648", borderRadius: 8, color: "#e5e7eb", fontSize: 10 }} />
              <Legend wrapperStyle={{ fontSize: 10, color: "#a8b0c0" }} />
              <Line type="monotone" dataKey={chart.coordinated} name="Coordinated" stroke="#06b6d4" strokeWidth={2.3} dot={false} isAnimationActive={false} />
              <Line type="monotone" dataKey={chart.independent} name="Independent" stroke="#f59e0b" strokeWidth={2} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer></div>
        </section>
      ))}</div>
      <section className="panel analytics-summary"><span className="summary-icon"><Sparkles size={18} /></span><div><p className="eyebrow">LIVE PERFORMANCE INSIGHT · RULE-BASED</p><p>{summary}</p></div></section>
      <div className="sim-disclaimer">SIMULATION MODEL — SYNTHETIC TRAFFIC DATA FOR ALGORITHMIC BENCHMARKING</div>
    </div>
  );
}
