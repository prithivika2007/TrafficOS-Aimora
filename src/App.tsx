import React, { useState, useEffect, useRef, useCallback, useSyncExternalStore } from "react";
import TrafficOSSimulator from "./TrafficOSSimulator";
import { AnimatePresence, motion } from "framer-motion";
import clsx from "clsx";
import { twMerge } from "tailwind-merge";
import {
  Activity,
  AlertTriangle,
  Ambulance,
  BarChart3,
  BookOpen,
  ChevronDown,
  Clock3,
  Gauge,
  Globe2,
  Layers3,
  Map,
  Menu,
  Radio,
  Settings2,
  ShieldCheck,
  Signal,
  Siren,
  Waypoints,
  Zap,
} from "lucide-react";
import LiveTrafficConsole from "./components/LiveTrafficConsole";
import { TrafficProvider, useTraffic } from "./TrafficContext";
import { JUNCTIONS, ROAD_CAPACITY, ROAD_DEFINITIONS, networkMetrics } from "./networkEngine";
import type { JunctionId, NetworkState } from "./networkEngine";

const TrafficAnalytics = React.lazy(() => import("./components/TrafficAnalytics"));
const TrafficIncidents = React.lazy(() => import("./components/TrafficIncidents"));
const TrafficNetworkLab = React.lazy(() => import("./components/TrafficNetworkLab"));
const TrafficNetworkMap = React.lazy(() => import("./components/TrafficNetworkMap"));

type PageId = "overview" | "map" | "scheduler" | "emergency" | "network" | "incidents" | "analytics" | "learn" | "console";

const NAVIGATION: { id: PageId; label: string; icon: typeof Globe2; group: string }[] = [
  { id: "overview", label: "Overview", icon: Globe2, group: "WORKSPACE" },
  { id: "map", label: "Traffic Network Map", icon: Map, group: "WORKSPACE" },
  { id: "scheduler", label: "Scheduler Lab", icon: Settings2, group: "LABS" },
  { id: "emergency", label: "Emergency Lab", icon: Siren, group: "LABS" },
  { id: "network", label: "Traffic Network Lab", icon: Waypoints, group: "LABS" },
  { id: "incidents", label: "Incidents & Safety", icon: AlertTriangle, group: "INSIGHTS" },
  { id: "analytics", label: "Analytics", icon: BarChart3, group: "INSIGHTS" },
  { id: "learn", label: "Learn & Case Studies", icon: BookOpen, group: "INSIGHTS" },
];

const PAGE_TITLES: Record<PageId, string> = {
  overview: "Network overview",
  map: "Traffic network map",
  scheduler: "Scheduler lab",
  emergency: "Emergency response lab",
  network: "Multi-intersection coordination",
  incidents: "Incidents & safety",
  analytics: "Traffic analytics",
  learn: "Learn & case studies",
  console: "Live traffic console",
};

const cx = (...values: Parameters<typeof clsx>): string => twMerge(clsx(...values));

export default function App(): React.JSX.Element {
  return <TrafficProvider><DashboardShell /></TrafficProvider>;
}

function DashboardShell(): React.JSX.Element {
  const [activePage, setActivePage] = useState<PageId>("overview");
  const [time, setTime] = useState(() => new Date().toLocaleTimeString());
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const {
    states,
    mode,
    running,
    safetyTelemetry,
    start,
    pause,
    step,
    reset,
    singleIntersection: simulationRef,
    simulationRevision,
    notifySimulationUpdate,
  } = useTraffic();

  useEffect(() => {
    const timer = window.setInterval(() => {
      setTime(new Date().toLocaleTimeString());
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);
  const currentQueueCount = Object.values(states[mode].roads).reduce((sum, vehicles) => sum + vehicles.length, 0)
    + JUNCTIONS.reduce((sum, junction) => sum + states[mode].demand[junction].length, 0);

  useEffect(() => {
    if (activePage !== "emergency") return;
    const timer = window.setTimeout(() => {
      document.getElementById("ambulance-lab-title")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 150);
    return () => window.clearTimeout(timer);
  }, [activePage]);

  const navigate = (page: PageId) => {
    setActivePage(page);
    setMobileNavOpen(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const renderNavigation = (group: string) => (
    <div className="sidebar-group" key={group}>
      <span className="sidebar-group-label">{group}</span>
      {NAVIGATION.filter((item) => item.group === group).map(({ id, label, icon: Icon }) => (
        <button key={id} className={cx("sidebar-link", activePage === id && "active")} onClick={() => navigate(id)}>
          <Icon size={17} strokeWidth={1.8} /><span>{label}</span>
          {id === "network" && <span className="new-tag">NEW</span>}
        </button>
      ))}
    </div>
  );

  return (
    <div className="app-frame">
      <aside className={`sidebar ${mobileNavOpen ? "sidebar-open" : ""}`}>
        <div className="brand-lockup">
          <div className="brand-mark"><Activity size={20} strokeWidth={2.5} /></div>
          <div><strong>TrafficOS</strong><span>INTELLIGENCE PLATFORM</span></div>
          <button className="mobile-close" onClick={() => setMobileNavOpen(false)} aria-label="Close navigation">×</button>
        </div>
        <div className="network-selector"><span className="network-icon"><Layers3 size={16} /></span><span><b>Central District</b><small>4 intersections · active</small></span><ChevronDown size={14} /></div>
        <nav className="sidebar-nav">
          {["WORKSPACE", "LABS", "INSIGHTS"].map(renderNavigation)}
          <div className="sidebar-group">
            <span className="sidebar-group-label">CONNECTED SYSTEMS</span>
            <button className={`sidebar-link ${activePage === "console" ? "active" : ""}`} onClick={() => navigate("console")}><Radio size={17} /><span>Live traffic console</span><i className="connection-indicator" /></button>
          </div>
        </nav>
        <div className="sidebar-bottom">
          <div className="system-health"><span className="health-icon"><ShieldCheck size={16} /></span><div><b>All systems operational</b><small>Last sync · just now</small></div><i /></div>
          <div className="profile"><div className="profile-avatar">TO</div><div><b>Traffic Operator</b><small>Network administrator</small></div><ChevronDown size={15} /></div>
        </div>
      </aside>
      {mobileNavOpen && <button className="nav-scrim" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)} />}
      <div className="app-main">
        <header className="topbar">
          <div className="topbar-left"><button className="mobile-menu" onClick={() => setMobileNavOpen(true)} aria-label="Open navigation"><Menu size={20} /></button><span className="breadcrumbs">Network / <b>{PAGE_TITLES[activePage]}</b></span></div>
          <div className="topbar-right">
            <div className="global-controls">
              <button className="global-control-primary" onClick={running ? pause : start} aria-label={running ? "Pause simulation" : "Start simulation"}>{running ? "Ⅱ" : "▶"}<span>{running ? "Pause" : "Start"}</span></button>
              <button onClick={step} disabled={running} aria-label="Step simulation">Step</button>
              <button onClick={reset} aria-label="Reset simulation"><span>↻</span></button>
            </div>
            <span className={`guardian-header-badge ${safetyTelemetry.status === "CONFLICT" ? "conflict" : ""}`}>
              <ShieldCheck size={13} /> SAFETY GUARDIAN · {safetyTelemetry.status === "ACTIVE" ? "ACTIVE / NO CONFLICTS" : "CONFLICT"}
            </span>
            <span className={`sync-status ${running ? "is-running" : ""}`}><i /> {running ? "Kernel running" : "Kernel paused"}</span><span className="topbar-divider" /><span className="clock"><Clock3 size={14} />{time}</span><span className="topbar-divider" /><span className="cpu-status"><Gauge size={14} />{currentQueueCount} queued</span>
          </div>
        </header>
        <main className="main-content">
          <AnimatePresence mode="wait">
          <motion.div key={activePage} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.18 }}>
          <React.Suspense fallback={<div className="panel route-loading">Loading simulation view…</div>}>
          {activePage === "overview" && <Overview navigate={navigate} />}
          {activePage === "map" && <TrafficNetworkMap onOpenLab={() => navigate("network")} />}
          {(activePage === "scheduler" || activePage === "emergency") && (
            <div className="legacy-lab-wrap">
              <div className="page-heading"><div><p className="eyebrow">{activePage === "emergency" ? "EMERGENCY RESPONSE · ISR PREEMPTION" : "SINGLE INTERSECTION · ALGORITHM EVALUATION"}</p><h1>{PAGE_TITLES[activePage]}</h1><p>{activePage === "emergency" ? "Test ambulance detection, safe signal preemption, and scheduler recovery." : "Evaluate Round Robin, static timers, and priority aging at a single junction."}</p></div></div>
              {activePage === "scheduler" ? <SchedulerVisual /> : <EmergencyRouteVisual />}
              <TrafficOSSimulator simulationRef={simulationRef} simulationRevision={simulationRevision} />
              <div className="sim-disclaimer">SIMULATION MODEL — SYNTHETIC TRAFFIC DATA FOR ALGORITHMIC BENCHMARKING</div>
            </div>
          )}
          {activePage === "network" && <TrafficNetworkLab />}
          {activePage === "incidents" && <TrafficIncidents />}
          {activePage === "analytics" && <TrafficAnalytics />}
          {activePage === "learn" && <LearnPage navigate={navigate} />}
          {activePage === "console" && <div className="legacy-console panel"><div className="page-heading"><div><p className="eyebrow">CONNECTED SYSTEMS</p><h1>Live traffic console</h1><p>Camera feed, synthetic detection, and vehicle queue controls.</p></div></div><LiveTrafficConsole simulationRef={simulationRef} onSimulationUpdate={notifySimulationUpdate} /></div>}
          </React.Suspense>
          </motion.div>
          </AnimatePresence>
        </main>
      </div>
    </div>
  );
}

function Overview({ navigate }: { navigate: (page: PageId) => void }): React.JSX.Element {
  const { states, mode, history, events } = useTraffic();
  const metrics = networkMetrics(states[mode]);
  const activeIncidents = Object.values(states[mode].blockedRoads).filter(Boolean).length;
  const queued = Object.values(states[mode].roads).reduce((sum, vehicles) => sum + vehicles.length, 0)
    + JUNCTIONS.reduce((sum, junction) => sum + states[mode].demand[junction].length, 0);
  const latest = history[history.length - 1];
  const contextSwitchCount = history.reduce((sum, point) => sum + point.contextSwitches, 0);
  return (
    <div className="overview-page">
      <div className="welcome-heading"><div><p className="eyebrow">SUNDAY, OCTOBER 25 · NETWORK STATUS</p><h1>Good morning, operator <span>✦</span></h1><p>Here’s what’s happening across your traffic network right now.</p></div><button className="secondary-button" onClick={() => navigate("map")}><Map size={15} /> Open full map</button></div>
      <div className="overview-metrics">
        <OverviewMetric icon={<Gauge size={17} />} label="Network throughput" value={Math.round(metrics.throughput).toLocaleString()} unit="veh / min" trend={`${queued} vehicles in system`} color="teal" />
        <OverviewMetric icon={<Clock3 size={17} />} label="Average wait" value={metrics.averageWait.toFixed(1)} unit="sec" trend={`${states[mode].served} vehicles served`} color="blue" />
        <OverviewMetric icon={<Signal size={17} />} label="Context switches" value={String(contextSwitchCount)} unit="total" trend={`Tick ${states[mode].tick}`} color="green" />
        <OverviewMetric icon={<AlertTriangle size={17} />} label="Spillback events" value={String(metrics.spillbacks)} unit="events" trend={`${mode} controller`} color="amber" />
      </div>
      <EventTicker />
      <div className="overview-grid">
        <TrafficNetworkMap compact onOpenLab={() => navigate("network")} />
        <aside className="overview-rail">
          <div className="panel rail-panel">
            <div className="panel-heading"><div><p className="eyebrow">NETWORK HEALTH</p><h2>Intersection status</h2></div><button className="icon-button" aria-label="Open map" onClick={() => navigate("map")}><ArrowIcon /></button></div>
            {([
              ["A", "Market & 5th"],
              ["B", "Market & 8th"],
              ["C", "Mission & 5th"],
              ["D", "Mission & 8th"],
            ] as const).map(([junction, name]) => {
              const status = junctionStatus(states[mode], junction);
              return <div className="intersection-row" key={junction}><span className={`intersection-letter status-${status.color}`}>{junction}</span><div className="intersection-info"><b>{name}</b><small>Junction {junction}</small></div><span className={`status-label status-text-${status.color}`}><i />{status.label}</span></div>;
            })}
            <button className="panel-link" onClick={() => navigate("map")}>View all intersections <ArrowRightIcon /></button>
          </div>
          <div className="panel incident-preview">
            <div className="panel-heading"><div><p className="eyebrow">SAFETY & INCIDENTS</p><h2>Recent activity</h2></div><span className="incident-count">{activeIncidents} active</span></div>
            {(events.length ? events.slice(0, 2) : [{ id: "idle", message: "Awaiting simulation events", tick: 0, kind: "arrival" as const, junction: "A" as const }]).map((event) => <div className="incident-item" key={event.id}><span className={`incident-icon ${event.kind === "spillback" ? "red" : "amber"}`}><AlertTriangle size={15} /></span><div><b>{event.message}</b><small>Junction {event.junction} · tick {event.tick}</small></div><span className={`severity ${event.kind === "spillback" ? "high" : "moderate"}`}>{event.kind.toUpperCase()}</span></div>)}
            <button className="panel-link" onClick={() => navigate("incidents")}>Open incident log <ArrowRightIcon /></button>
          </div>
        </aside>
      </div>
      <div className="overview-bottom">
        <button className="quick-action panel" onClick={() => navigate("network")}><span className="quick-icon teal"><Waypoints size={18} /></span><span><b>Coordinate your network</b><small>Compare independent vs. coordinated signals</small></span><ArrowRightIcon /></button>
        <button className="quick-action panel" onClick={() => navigate("emergency")}><span className="quick-icon rose"><Siren size={18} /></span><span><b>Run an emergency scenario</b><small>Test ISR preemption and ambulance routing</small></span><ArrowRightIcon /></button>
      </div>
      <div className="sim-disclaimer">SIMULATION MODEL — SYNTHETIC TRAFFIC DATA FOR ALGORITHMIC BENCHMARKING</div>
    </div>
  );
}

function OverviewMetric({ icon, label, value, unit, trend, color }: { icon: React.ReactNode; label: string; value: string; unit: string; trend: string; color: string }): React.JSX.Element {
  return <div className="overview-metric panel"><span className={`metric-icon ${color}`}>{icon}</span><span className="overview-metric-label">{label}</span><strong>{value}<small>{unit}</small></strong><span className="metric-trend">{trend}</span></div>;
}

function junctionStatus(state: NetworkState, junction: JunctionId): { color: string; label: string } {
  const incoming = ROAD_DEFINITIONS.filter((road) => road.to === junction);
  const queued = state.demand[junction].length
    + incoming.reduce((sum, road) => sum + state.roads[road.id].length, 0);
  const capacity = incoming.length * ROAD_CAPACITY;
  if (incoming.some((road) => state.blockedRoads[road.id]) || queued / capacity >= 0.75) {
    return { color: "red", label: "Severe congestion" };
  }
  if (queued / capacity >= 0.4) return { color: "amber", label: "Moderate" };
  return { color: "green", label: "Free flow" };
}

function EventTicker(): React.JSX.Element {
  const { events, running, states, mode } = useTraffic();
  return <div className="event-ticker">
    <span className="ticker-label"><Activity size={13} /> EVENT STREAM</span>
    <div className="ticker-content">
      {events.slice(0, 3).map((event) => <span className="ticker-event" key={event.id}><i className={event.kind} />T+{(event.tick * 0.5).toFixed(1)}s · {event.message}</span>)}
      {!events.length && <span className="ticker-event"><i className="phase" />{running ? "Kernel active · awaiting next traffic event" : `Kernel paused · ${states[mode].tick} ticks recorded`}</span>}
    </div>
    <span className="ticker-state">{running ? "STREAMING" : "FROZEN"}</span>
  </div>;
}

function SchedulerVisual(): React.JSX.Element {
  const { states, mode, running } = useTraffic();
  const state = states[mode];
  return <section className="panel scheduler-visual">
    <div className="panel-heading"><div><p className="eyebrow">SINGLE JUNCTION · LIVE SIGNAL STATE</p><h2>Intersection control surface</h2></div><span className={`simulation-badge ${running ? "pulse-badge" : ""}`}>{mode.toUpperCase()} · T+{(state.tick * 0.5).toFixed(1)}s</span></div>
    <div className="scheduler-canvas">
      <svg viewBox="0 0 720 290" role="img" aria-label="Top-down four-way traffic intersection diagram">
        <defs><filter id="roadGlow"><feGaussianBlur stdDeviation="4" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter></defs>
        <rect width="720" height="290" fill="#0b1420" />
        <path d="M0 88 H720 M0 202 H720 M303 0 V290 M417 0 V290" stroke="#253344" strokeWidth="1" />
        <rect x="0" y="112" width="720" height="66" fill="#172330" /><rect x="327" y="0" width="66" height="290" fill="#172330" />
        <path d="M0 145 H720 M360 0 V290" stroke="#5c7184" strokeWidth="2" strokeDasharray="12 9" />
        <path d={state.phases.A % 2 ? "M290 145 H165" : "M360 190 V265"} stroke="#06b6d4" strokeWidth="4" filter="url(#roadGlow)" className={running ? "svg-signal-flow" : ""} />
        <path d={state.phases.A % 2 ? "M430 145 H555" : "M360 100 V25"} stroke="#374657" strokeWidth="3" />
        {[0, 1, 2, 3].map((item) => <g key={item} transform={`translate(${220 + item * 22} 131)`}><rect width="13" height="27" rx="4" fill={item < state.demand.A.length ? "#14b8a6" : "#233243"} /><circle cx="6.5" cy="5" r="2" fill="#b8fff5" /></g>)}
        <g transform="translate(272 91)"><rect width="31" height="61" rx="8" fill="#09111b" stroke="#36485a" /><circle cx="15.5" cy="15" r="7" fill={state.phases.A % 2 ? "#1e293b" : "#22c55e"} /><circle cx="15.5" cy="46" r="7" fill={state.phases.A % 2 ? "#ef4444" : "#1e293b"} /></g>
        <g transform="translate(417 139)"><rect width="31" height="61" rx="8" fill="#09111b" stroke="#36485a" /><circle cx="15.5" cy="15" r="7" fill={state.phases.A % 2 ? "#22c55e" : "#1e293b"} /><circle cx="15.5" cy="46" r="7" fill={state.phases.A % 2 ? "#1e293b" : "#ef4444"} /></g>
        <text x="24" y="28" fill="#9ba9b9" fontSize="11">NORTH · {state.demand.A.length} waiting</text>
        <text x="570" y="270" fill="#9ba9b9" fontSize="11">SOUTH · {state.demand.C.length} waiting</text>
        <text x="16" y="275" fill="#738197" fontSize="9">ROUND ROBIN ↔ PRIORITY + AGING</text>
      </svg>
      <div className="scheduler-overlay"><span className="signal-dot" />{state.phases.A % 2 ? "EAST / WEST GREEN" : "NORTH / SOUTH GREEN"}<small>{JUNCTIONS.reduce((sum, node) => sum + state.demand[node].length, 0)} queued vehicles · shared simulation</small></div>
    </div>
  </section>;
}

function EmergencyRouteVisual(): React.JSX.Element {
  const { states, mode, running } = useTraffic();
  const state = states[mode];
  const phaseIndex = running ? Math.floor((state.tick % 48) / 12) : 0;
  const stages = ["NORMAL", "CLEARANCE", "PASSAGE", "RECOVERY"];
  const junction = JUNCTIONS[Math.floor((state.tick / 12) % JUNCTIONS.length)];
  return <section className="panel emergency-route-panel">
    <div className="panel-heading"><div><p className="eyebrow">ISR PRIORITY ROUTE · AMB-911</p><h2>Emergency corridor telemetry</h2></div><span className={`severity high ${running ? "emergency-blink" : ""}`}>{stages[phaseIndex]}</span></div>
    <div className={`emergency-route ${running ? "route-active" : ""}`}><div className="route-path" />
      {JUNCTIONS.map((node, index) => <div className={`route-node ${node === junction ? "current" : ""}`} key={node} style={{ left: `${10 + index * 27}%` }}><span>{node === junction ? <Ambulance size={17} /> : node}</span><small>JUNCTION {node}</small></div>)}
    </div>
    <div className="isr-stages">{stages.map((stage, index) => <div key={stage} className={index === phaseIndex ? "active" : index < phaseIndex ? "complete" : ""}><span>{index + 1}</span><b>{stage}</b></div>)}</div>
    <div className="starvation-monitor"><b><Zap size={14} /> Starved-lane aging monitor</b>{JUNCTIONS.map((node) => <span key={node}>J{node}<i><em style={{ width: `${Math.min(100, state.demand[node].length * 16)}%` }} /></i>{state.demand[node].length}</span>)}</div>
    <p className="emergency-caption">AMB-911 route stages follow the shared simulation clock; use the established emergency lab controls below to exercise ISR requests.</p>
  </section>;
}

function LearnPage({ navigate }: { navigate: (page: PageId) => void }): React.JSX.Element {
  const { states, mode, history, running } = useTraffic();
  const state = states[mode];
  const queuedVehicles = Object.values(state.roads).reduce((sum, vehicles) => sum + vehicles.length, 0)
    + JUNCTIONS.reduce((sum, junction) => sum + state.demand[junction].length, 0);
  const latest = history[history.length - 1];
  return <div className="content-page"><div className="page-heading"><div><p className="eyebrow">TRAFFIC SYSTEMS · FIELD GUIDE</p><h1>Learn & case studies</h1><p>Explore how operating-system scheduling concepts map to adaptive traffic control.</p></div></div>
    <div className="learn-grid">
      <article className="panel learn-card"><span className="learn-number">01</span><span className="learn-icon"><Settings2 size={20} /></span><h2>Round Robin scheduling</h2><p>Each approach gets a fair green-light time slice. Like CPU time-sharing, a fixed quantum prevents one lane from monopolizing the intersection.</p><div className="analogy"><b>OS analogy</b><span>Time quantum → green phase duration</span></div></article>
      <article className="panel learn-card"><span className="learn-number">02</span><span className="learn-icon amber"><Activity size={20} /></span><h2>Priority + aging</h2><p>Emergency vehicles receive priority, while waiting traffic gradually gains weight to reduce starvation and keep service equitable.</p><div className="analogy"><b>OS analogy</b><span>Process priority → lane priority score</span></div></article>
      <article className="panel learn-card"><span className="learn-number">03</span><span className="learn-icon rose"><Waypoints size={20} /></span><h2>Network coordination</h2><p>Neighboring signals share downstream capacity and queue telemetry. Green waves move traffic onward without pushing it into blocked links.</p><div className="analogy"><b>OS analogy</b><span>Backpressure → resource-aware scheduling</span></div></article>
      <article className="panel learn-card"><span className="learn-number">04</span><span className="learn-icon amber"><Siren size={20} /></span><h2>Mutexes & interrupts</h2><p>A junction grants one approach exclusive green access at a time. Emergency vehicles request an interrupt, triggering safe clearance, protected passage, then recovery.</p><div className="analogy"><b>OS analogy</b><span>Intersection mutex → exclusive green · ISR → emergency preemption</span></div></article>
    </div>
    <div className="learn-telemetry panel"><span className={`telemetry-pulse ${running ? "running" : ""}`} /><div><p className="eyebrow">SHARED KERNEL STATE</p><b>{running ? "Simulation running" : "Simulation paused"} · {mode.toUpperCase()} control</b></div><span><b>T+{(state.tick * .5).toFixed(1)}s</b><small>clock</small></span><span><b>{queuedVehicles}</b><small>queued vehicles</small></span><span><b>{latest.contextSwitches}</b><small>switches / tick</small></span></div>
    <div className="case-study panel"><div className="case-mark">CASE STUDY · SYNTHETIC</div><h2>When a green light isn’t enough</h2><p>A local controller may clear its queue into a downstream road that has no remaining capacity. Coordinated control uses downstream occupancy to hold vehicles upstream, protecting junction throughput and limiting gridlock.</p><button className="text-link" onClick={() => navigate("network")}>Explore the network lab <ArrowRightIcon /></button></div>
    <div className="sim-disclaimer">SIMULATION MODEL — SYNTHETIC TRAFFIC DATA FOR ALGORITHMIC BENCHMARKING</div>
  </div>;
}

function ArrowRightIcon(): React.JSX.Element {
  return <span aria-hidden="true">→</span>;
}

function ArrowIcon(): React.JSX.Element {
  return <span aria-hidden="true">↗</span>;
}
