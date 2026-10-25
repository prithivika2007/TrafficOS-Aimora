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
import SplashScreen from "./components/SplashScreen";
import { TrafficProvider, useTraffic } from "./TrafficContext";
import { JUNCTIONS, JUNCTION_NAMES, ROAD_CAPACITY, ROAD_DEFINITIONS, networkMetrics } from "./networkEngine";
import type { JunctionId, NetworkState } from "./networkEngine";
import type { MapScenario } from "./components/TrafficNetworkMap";

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
  const [initialized, setInitialized] = useState(false);
  return (
    <AnimatePresence mode="wait">
      {initialized ? (
        <motion.div
          key="dashboard"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, ease: "easeOut" }}
        >
          <TrafficProvider><DashboardShell /></TrafficProvider>
        </motion.div>
      ) : (
        <SplashScreen key="splash" onInitialize={() => setInitialized(true)} />
      )}
    </AnimatePresence>
  );
}

function DashboardShell(): React.JSX.Element {
  const [activePage, setActivePage] = useState<PageId>("overview");
  const [time, setTime] = useState(() => new Date().toLocaleTimeString());
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [mapScenario, setMapScenario] = useState<MapScenario | null>(null);
  const scenarioCounter = useRef(0);
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

  const navigate = useCallback((page: PageId) => {
    setActivePage(page);
    setMobileNavOpen(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);
  const startMapScenario = useCallback((kind: MapScenario["kind"]) => {
    setMapScenario({ id: ++scenarioCounter.current, kind });
    start();
    navigate("map");
  }, [navigate, start]);
  const currentNavItem = NAVIGATION.find((item) => item.id === activePage);
  const breadcrumbGroup = currentNavItem?.group === "WORKSPACE"
    ? "Workspace"
    : currentNavItem?.group === "LABS"
      ? "Labs"
      : currentNavItem?.group === "INSIGHTS"
        ? "Insights"
        : "Connected Systems";

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
        <div className="network-selector"><span className="network-icon"><Layers3 size={16} /></span><span><b>Chennai Smart Grid</b><small>4 Intersections Active</small></span></div>
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
        {/* Enlarged Top Bar */}
        <header className="topbar" style={{ minHeight: "72px", padding: "0 24px" }}>
          <div className="topbar-left">
            <button className="mobile-menu" onClick={() => setMobileNavOpen(true)} aria-label="Open navigation"><Menu size={22} /></button>
            <span className="breadcrumbs" style={{ fontSize: "14px" }}>{breadcrumbGroup} / <b style={{ color: "#38bdf8" }}>{activePage === "overview" ? "Overview" : PAGE_TITLES[activePage]}</b></span>
          </div>
          <div className="topbar-right" style={{ gap: "16px" }}>
            <div className="global-controls">
              <button style={{ padding: "8px 16px", fontSize: "13px", fontWeight: 700 }} className="global-control-primary" onClick={running ? pause : start} aria-label={running ? "Pause simulation" : "Start simulation"}>{running ? "Ⅱ" : "▶"}<span>{running ? "Pause" : "Start"}</span></button>
              <button style={{ padding: "8px 12px", fontSize: "13px", fontWeight: 700 }} onClick={step} disabled={running} aria-label="Step simulation">Step</button>
              <button style={{ padding: "8px 10px", fontSize: "13px" }} onClick={reset} aria-label="Reset simulation"><span>↻</span></button>
            </div>
            <span style={{ fontSize: "12px", padding: "6px 12px", fontWeight: 700 }} className={`guardian-header-badge ${safetyTelemetry.status === "CONFLICT" ? "conflict" : ""}`}>
              <ShieldCheck size={15} /> SAFETY GUARDIAN · {safetyTelemetry.status === "ACTIVE" ? "ACTIVE / NO CONFLICTS" : "SAFETY VIOLATION DETECTED — FAILSAFE ENGAGED"}
            </span>
            <span style={{ fontSize: "13px", fontWeight: 600 }} className={`sync-status ${running ? "is-running" : ""}`}><i /> {running ? "Kernel running" : "Kernel paused"}</span>
            <span className="topbar-divider" />
            <span className="clock" style={{ fontSize: "14px", fontWeight: 700 }}><Clock3 size={16} />{time}</span>
            <span className="topbar-divider" />
            <span className="cpu-status" style={{ fontSize: "13px", fontWeight: 700 }}><Gauge size={16} />{currentQueueCount} queued</span>
          </div>
        </header>
        <main className={activePage === "scheduler" ? "main-content scheduler-page" : "main-content"}>
          <AnimatePresence mode="wait">
          <motion.div key={activePage} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.18 }}>
          {activePage !== "overview" && activePage !== "scheduler" && <div className="page-back-row"><button className="back-overview-button" onClick={() => navigate("overview")}>← Back to Overview</button></div>}
          <React.Suspense fallback={<div className="panel route-loading">Loading simulation view…</div>}>
          {activePage === "overview" && <Overview navigate={navigate} startMapScenario={startMapScenario} />}
          {activePage === "map" && <TrafficNetworkMap onOpenLab={() => navigate("network")} scenario={mapScenario} />}
          {(activePage === "scheduler" || activePage === "emergency") && (
  <div className={`legacy-lab-wrap ${activePage === "scheduler" ? "scheduler-lab-wrap" : ""}`}>
    <div className="page-heading">
      <div>
        <p className="eyebrow">{activePage === "emergency" ? "EMERGENCY RESPONSE · ISR PREEMPTION" : "SINGLE INTERSECTION · ALGORITHM EVALUATION"}</p>
        <h1>{PAGE_TITLES[activePage]}</h1>
        <p className={activePage === "scheduler" ? "text-sm font-medium text-slate-300" : ""}>
          {activePage === "emergency"
            ? "Test ambulance detection, safe signal preemption, and scheduler recovery."
            : "Evaluate Round Robin, static timers, and priority aging at a single junction."}
        </p>
      </div>
    </div>
    {activePage === "emergency" && <EmergencyRouteVisual />}
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

function Overview({ navigate, startMapScenario }: {
  navigate: (page: PageId) => void;
  startMapScenario: (kind: MapScenario["kind"]) => void;
}): React.JSX.Element {
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
            {JUNCTIONS.map((junction) => {
              const name = JUNCTION_NAMES[junction];
              const status = junctionStatus(states[mode], junction);
              return <div className="intersection-row" key={junction}><span className={`intersection-letter status-${status.color}`}>{junction}</span><div className="intersection-info"><b>{name}</b><small>Junction {junction}</small></div><span className={`status-label status-text-${status.color}`}><i />{status.label}</span></div>;
            })}
            <button className="panel-link" onClick={() => navigate("map")}>View all intersections <ArrowRightIcon /></button>
          </div>
          <div className="panel incident-preview">
            <div className="panel-heading"><div><p className="eyebrow">SAFETY & INCIDENTS</p><h2>Recent activity</h2></div><span className="incident-count">{activeIncidents} active</span></div>
            {(events.length ? events.slice(0, 2) : [{ id: "idle", message: "Awaiting simulation events", tick: 0, kind: "arrival" as const, junction: "A" as const }]).map((event) => <div className="incident-item" key={event.id}><span className={`incident-icon ${event.kind === "spillback" ? "red" : "amber"}`}><AlertTriangle size={15} /></span><div><b>{event.message}</b><small>{JUNCTION_NAMES[event.junction]} · tick {event.tick}</small></div><span className={`severity ${event.kind === "spillback" ? "high" : "moderate"}`}>{event.kind.toUpperCase()}</span></div>)}
            <button className="panel-link" onClick={() => navigate("incidents")}>Open incident log <ArrowRightIcon /></button>
          </div>
        </aside>
      </div>
      <div className="overview-bottom">
        <button className="quick-action panel" onClick={() => startMapScenario("coordination")}><span className="quick-icon teal"><Waypoints size={18} /></span><span><b>Coordinate your network</b><small>Launch a live green-wave vehicle simulation</small></span><ArrowRightIcon /></button>
        <button className="quick-action panel" onClick={() => startMapScenario("emergency")}><span className="quick-icon rose"><Siren size={18} /></span><span><b>Run an emergency scenario</b><small>Launch an ISR ambulance green wave on Anna Salai</small></span><ArrowRightIcon /></button>
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

interface CanvasVehicle {
  progress: number;
  speed: number;
  width: number;
  length: number;
  color: string;
  kind: "sedan" | "suv" | "truck" | "ambulance";
  flashing: number;
}

const APPROACH_COLORS = ["#EC4899", "#3B82F6", "#8B5CF6", "#F59E0B"];
const VEHICLE_TYPES = [
  { width: 14, length: 24, kind: "sedan" as const },
  { width: 16, length: 28, kind: "suv" as const },
  { width: 18, length: 40, kind: "truck" as const },
];
const MIN_VEHICLE_GAP = 14;

function SchedulerTrafficCanvas({
  phase,
  phaseTicks,
  allRed,
  approachCounts,
  emergencySpawnId,
}: {
  phase: number;
  phaseTicks: number;
  allRed: boolean;
  approachCounts: number[];
  emergencySpawnId: string | null;
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const vehiclesRef = useRef<CanvasVehicle[][]>([]);
  const handledEmergency = useRef<string | null>(null);
  const liveRef = useRef({ phase, phaseTicks, allRed, approachCounts });
  useEffect(() => {
    liveRef.current = { phase, phaseTicks, allRed, approachCounts };
  }, [phase, phaseTicks, allRed, approachCounts]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const vehicles = APPROACH_COLORS.map((_, lane) =>
      Array.from({ length: 5 }, (_, index) => {
        const type = VEHICLE_TYPES[(index + lane) % VEHICLE_TYPES.length];
        return {
          ...type,
          color: APPROACH_COLORS[lane],
          progress: 0,
          speed: 0,
          flashing: Math.random() * Math.PI * 2,
        } satisfies CanvasVehicle;
      })
    );
    vehiclesRef.current = vehicles;
    let animationFrame = 0;
    let lastFrame = 0;
    let initialized = false;

    const draw = (timestamp: number) => {
      const deltaSeconds = lastFrame ? Math.min((timestamp - lastFrame) / 1000, 0.05) : 1 / 60;
      lastFrame = timestamp;
      const bounds = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const width = Math.max(1, bounds.width);
      const height = Math.max(1, bounds.height);
      if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
      }
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);
      drawSchedulerRoad(context, width, height);

      const live = liveRef.current;
      const centerX = width / 2;
      const centerY = height / 2;
      const roadWidth = Math.min(112, Math.min(width, height) * 0.36);
      const centerDistance = Math.min(width, height) * 0.5;
      if (!initialized) {
        vehicles.forEach((laneVehicles) => {
          const front = laneVehicles[0];
          let progress = Math.max(42, centerDistance - roadWidth / 2 - 10 - front.length / 2);
          laneVehicles.forEach((vehicle, index) => {
            if (index > 0) {
              const ahead = laneVehicles[index - 1];
              progress -= (ahead.length + vehicle.length) / 2 + MIN_VEHICLE_GAP;
            }
            vehicle.progress = progress;
          });
        });
        initialized = true;
      }
      const stopLineDistance = centerDistance - roadWidth / 2 - 10;
      const greenPhase = live.phase % 4;
      const amber = live.phaseTicks % 6 >= 4;
      const directions = [
        { name: "NORTH", x: centerX - 22, y: 0, angle: Math.PI, color: APPROACH_COLORS[0] },
        { name: "EAST", x: width, y: centerY - 22, angle: -Math.PI / 2, color: APPROACH_COLORS[1] },
        { name: "SOUTH", x: centerX + 22, y: height, angle: 0, color: APPROACH_COLORS[2] },
        { name: "WEST", x: 0, y: centerY + 22, angle: Math.PI / 2, color: APPROACH_COLORS[3] },
      ];
      directions.forEach((direction, lane) => {
        const isGreen = !live.allRed && greenPhase === lane && !amber;
        const light = live.allRed ? "#ef4444" : greenPhase === lane ? (amber ? "#f59e0b" : "#22c55e") : "#ef4444";
        drawSignal(context, direction.x, direction.y, direction.angle, light);
        drawApproachStripe(context, direction, centerX, centerY, width, height, roadWidth);

        const laneVehicles = vehicles[lane];
        laneVehicles.sort((a, b) => b.progress - a.progress);
        laneVehicles.forEach((vehicle, index) => {
          const ahead = laneVehicles[index - 1];
          const vehicleProgressLimit = ahead
            ? ahead.progress - (ahead.length + vehicle.length) / 2 - MIN_VEHICLE_GAP
            : isGreen ? Math.max(width, height) + vehicle.length : stopLineDistance - vehicle.length / 2;
          const distanceToLimit = Math.max(0, vehicleProgressLimit - vehicle.progress);
          const targetSpeed = Math.min(72, Math.sqrt(distanceToLimit * 2 * 100));
          const acceleration = targetSpeed > vehicle.speed ? 115 : 210;
          vehicle.speed += Math.sign(targetSpeed - vehicle.speed) * acceleration * deltaSeconds;
          vehicle.speed = Math.max(0, Math.min(targetSpeed, vehicle.speed));
          vehicle.progress = Math.min(vehicle.progress + vehicle.speed * deltaSeconds, vehicleProgressLimit);
          if (vehicle.progress >= Math.max(width, height) + vehicle.length) {
            const tail = laneVehicles[laneVehicles.length - 1];
            vehicle.progress = tail.progress - (tail.length + vehicle.length) / 2 - MIN_VEHICLE_GAP;
            vehicle.speed = 0;
          }
          const position = vehiclePosition(direction.name, vehicle.progress, centerX, centerY, width, height);
          drawVehicle(context, position.x, position.y, direction.angle, vehicle, timestamp);
        });
        drawDirectionLabel(context, direction.name, direction.color, live.approachCounts[lane] ?? 0, width, height, lane);
      });
      animationFrame = window.requestAnimationFrame(draw);
    };
    animationFrame = window.requestAnimationFrame(draw);
    return () => window.cancelAnimationFrame(animationFrame);
  }, []);

  useEffect(() => {
    if (!emergencySpawnId) {
      handledEmergency.current = null;
      return;
    }
    if (handledEmergency.current === emergencySpawnId) return;
    const laneVehicles = vehiclesRef.current[3];
    if (!laneVehicles) return;
    handledEmergency.current = emergencySpawnId;
    const ambulance: CanvasVehicle = {
      progress: Math.min(...laneVehicles.map((vehicle) =>
        vehicle.progress - (vehicle.length + 40) / 2 - MIN_VEHICLE_GAP
      )),
      speed: 0,
      width: 18,
      length: 40,
      color: "#f8fafc",
      kind: "ambulance",
      flashing: Math.random() * Math.PI * 2,
    };
    laneVehicles.push(ambulance);
  }, [emergencySpawnId]);

  return <canvas ref={canvasRef} className="scheduler-traffic-canvas" role="img" aria-label="Continuously animated four-way traffic intersection with directional vehicle queues" />;
}

function drawSchedulerRoad(context: CanvasRenderingContext2D, width: number, height: number): void {
  const cx = width / 2;
  const cy = height / 2;
  const roadWidth = Math.min(112, Math.min(width, height) * 0.36);
  const halfRoad = roadWidth / 2;
  context.fillStyle = "#1E293B";
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#ffffff08";
  for (let index = 0; index < 180; index += 1) {
    const x = (index * 83 + 19) % Math.max(1, width);
    const y = (index * 47 + 31) % Math.max(1, height);
    context.fillRect(x, y, index % 3 === 0 ? 2 : 1, 1);
  }
  context.fillStyle = "#0F172A";
  context.fillRect(0, cy - roadWidth / 2, width, roadWidth);
  context.fillRect(cx - roadWidth / 2, 0, roadWidth, height);
  context.fillStyle = "#111c2b";
  context.fillRect(cx - halfRoad, cy - halfRoad, roadWidth, roadWidth);
  context.strokeStyle = "#ffffff";
  context.lineWidth = 2;
  context.setLineDash([14, 12]);
  context.globalAlpha = 0.78;
  context.beginPath();
  context.moveTo(0, cy);
  context.lineTo(cx - halfRoad, cy);
  context.moveTo(cx + halfRoad, cy);
  context.lineTo(width, cy);
  context.moveTo(cx, 0);
  context.lineTo(cx, cy - halfRoad);
  context.moveTo(cx, cy + halfRoad);
  context.lineTo(cx, height);
  context.stroke();
  context.setLineDash([]);
  context.globalAlpha = 1;

  context.strokeStyle = "#64748b";
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(0, cy - halfRoad);
  context.lineTo(width, cy - halfRoad);
  context.moveTo(0, cy + halfRoad);
  context.lineTo(width, cy + halfRoad);
  context.moveTo(cx - halfRoad, 0);
  context.lineTo(cx - halfRoad, height);
  context.moveTo(cx + halfRoad, 0);
  context.lineTo(cx + halfRoad, height);
  context.stroke();

  drawCrosswalk(context, cx - halfRoad - 27, cy, roadWidth, "vertical");
  drawCrosswalk(context, cx + halfRoad + 27, cy, roadWidth, "vertical");
  drawCrosswalk(context, cx, cy - halfRoad - 27, roadWidth, "horizontal");
  drawCrosswalk(context, cx, cy + halfRoad + 27, roadWidth, "horizontal");
  drawStopLine(context, cx - halfRoad - 7, cy + 24, "vertical", 18);
  drawStopLine(context, cx + halfRoad + 7, cy - 24, "vertical", 18);
  drawStopLine(context, cx - 24, cy - halfRoad - 7, "horizontal", 18);
  drawStopLine(context, cx + 24, cy + halfRoad + 7, "horizontal", 18);
  drawTurningGuides(context, cx, cy, halfRoad);
}

function drawCrosswalk(
  context: CanvasRenderingContext2D,
  centerX: number,
  centerY: number,
  roadWidth: number,
  orientation: "horizontal" | "vertical"
): void {
  const count = 7;
  const stripeWidth = 5;
  const stripeGap = 5;
  const stripeLength = roadWidth * 0.64;
  context.fillStyle = "#f8fafc";
  context.globalAlpha = 0.88;
  for (let index = 0; index < count; index += 1) {
    if (orientation === "vertical") {
      const y = centerY - ((count * stripeWidth + (count - 1) * stripeGap) / 2) + index * (stripeWidth + stripeGap);
      context.fillRect(centerX - stripeLength / 2, y, stripeLength, stripeWidth);
    } else {
      const x = centerX - ((count * stripeWidth + (count - 1) * stripeGap) / 2) + index * (stripeWidth + stripeGap);
      context.fillRect(x, centerY - stripeLength / 2, stripeWidth, stripeLength);
    }
  }
  context.globalAlpha = 1;
}

function drawStopLine(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  orientation: "horizontal" | "vertical",
  halfLength: number
): void {
  context.strokeStyle = "#f8fafc";
  context.lineWidth = 4;
  context.beginPath();
  if (orientation === "vertical") {
    context.moveTo(x, y - halfLength);
    context.lineTo(x, y + halfLength);
  } else {
    context.moveTo(x - halfLength, y);
    context.lineTo(x + halfLength, y);
  }
  context.stroke();
}

function drawTurningGuides(
  context: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  halfRoad: number
): void {
  context.save();
  context.strokeStyle = "#cbd5e166";
  context.lineWidth = 2;
  context.setLineDash([7, 7]);
  const offset = halfRoad * 0.62;
  context.beginPath();
  context.moveTo(cx - offset, cy - halfRoad);
  context.bezierCurveTo(cx - offset, cy - offset, cx - halfRoad, cy - offset, cx - halfRoad, cy - offset);
  context.moveTo(cx + offset, cy - halfRoad);
  context.bezierCurveTo(cx + offset, cy - offset, cx + halfRoad, cy - offset, cx + halfRoad, cy - offset);
  context.moveTo(cx - offset, cy + halfRoad);
  context.bezierCurveTo(cx - offset, cy + offset, cx - halfRoad, cy + offset, cx - halfRoad, cy + offset);
  context.moveTo(cx + offset, cy + halfRoad);
  context.bezierCurveTo(cx + offset, cy + offset, cx + halfRoad, cy + offset, cx + halfRoad, cy + offset);
  context.stroke();
  context.restore();
}

function drawApproachStripe(
  context: CanvasRenderingContext2D,
  direction: { name: string; color: string },
  cx: number,
  cy: number,
  width: number,
  height: number,
  roadWidth: number
): void {
  context.strokeStyle = direction.color;
  context.globalAlpha = 0.45;
  context.lineWidth = 2;
  context.setLineDash([8, 9]);
  context.beginPath();
  if (direction.name === "WEST") {
    context.moveTo(0, cy + 24);
    context.lineTo(cx - roadWidth / 2 - 31, cy + 24);
  } else if (direction.name === "EAST") {
    context.moveTo(width, cy - 24);
    context.lineTo(cx + roadWidth / 2 + 31, cy - 24);
  } else if (direction.name === "NORTH") {
    context.moveTo(cx - 24, 0);
    context.lineTo(cx - 24, cy - roadWidth / 2 - 31);
  } else {
    context.moveTo(cx + 24, height);
    context.lineTo(cx + 24, cy + roadWidth / 2 + 31);
  }
  context.stroke();
  context.setLineDash([]);
  context.globalAlpha = 1;
}

function vehiclePosition(
  direction: string,
  progress: number,
  cx: number,
  cy: number,
  width: number,
  height: number
): { x: number; y: number } {
  if (direction === "WEST") return { x: progress, y: cy + 24 };
  if (direction === "EAST") return { x: width - progress, y: cy - 24 };
  if (direction === "NORTH") return { x: cx - 24, y: progress };
  return { x: cx + 24, y: height - progress };
}

function drawSignal(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  angle: number,
  color: string
): void {
  context.save();
  context.shadowColor = "#000000";
  context.shadowBlur = 5;
  context.shadowOffsetY = 2;
  context.translate(x, y);
  context.rotate(angle);
  context.fillStyle = "#050a11";
  context.strokeStyle = "#64748b";
  context.lineWidth = 1.5;
  context.beginPath();
  context.roundRect(-10, -25, 20, 32, 5);
  context.fill();
  context.stroke();
  context.fillStyle = color;
  context.shadowColor = color;
  context.shadowBlur = 11;
  context.beginPath();
  context.arc(0, -9, 5, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

function drawVehicle(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  angle: number,
  vehicle: CanvasVehicle,
  timestamp: number
): void {
  context.save();
  context.translate(x, y);
  context.rotate(angle);
  const halfW = vehicle.width / 2;
  const halfL = vehicle.length / 2;
  context.shadowColor = "#020617";
  context.shadowBlur = 5;
  context.fillStyle = vehicle.color;
  context.beginPath();
  context.roundRect(-halfW, -halfL, vehicle.width, vehicle.length, vehicle.kind === "truck" ? 2 : 5);
  context.fill();
  context.shadowBlur = 0;
  if (vehicle.kind === "ambulance") {
    drawAmbulance(context, halfW, halfL, timestamp, vehicle.flashing);
  } else {
    drawStandardVehicle(context, vehicle, halfW, halfL);
  }
  context.restore();
}

function drawStandardVehicle(
  context: CanvasRenderingContext2D,
  vehicle: CanvasVehicle,
  halfW: number,
  halfL: number
): void {
  const cabHeight = vehicle.kind === "truck" ? 12 : vehicle.kind === "suv" ? 11 : 9;
  context.fillStyle = vehicle.kind === "truck" ? "#cbd5e1" : "#e2e8f0";
  context.beginPath();
  context.roundRect(-halfW + 2, -halfL + cabHeight, vehicle.width - 4, vehicle.length - cabHeight * 2, 3);
  context.fill();
  context.fillStyle = "#0f172a";
  context.beginPath();
  context.roundRect(-halfW + 3, -halfL + 4, vehicle.width - 6, cabHeight, 3);
  context.fill();
  if (vehicle.kind === "truck") {
    context.fillStyle = "#475569";
    context.fillRect(-halfW + 2, halfL - 11, vehicle.width - 4, 7);
    context.strokeStyle = "#94a3b8";
    context.lineWidth = 1;
    context.strokeRect(-halfW + 3, halfL - 10, vehicle.width - 6, 5);
  } else {
    context.fillStyle = vehicle.kind === "suv" ? "#bfdbfe" : "#dbeafe";
    context.beginPath();
    context.roundRect(-halfW + 3, halfL - 10, vehicle.width - 6, 6, 2);
    context.fill();
  }
  context.fillStyle = vehicle.color;
  context.fillRect(-halfW + 1, -halfL + cabHeight + 2, 2, vehicle.length - cabHeight * 2 - 4);
  context.fillRect(halfW - 3, -halfL + cabHeight + 2, 2, vehicle.length - cabHeight * 2 - 4);
  context.fillStyle = "#fef3c7";
  context.fillRect(-halfW + 1, -halfL + 1, 4, 2);
  context.fillRect(halfW - 5, -halfL + 1, 4, 2);
  context.fillStyle = "#ef4444";
  context.fillRect(-halfW + 1, halfL - 3, 4, 2);
  context.fillRect(halfW - 5, halfL - 3, 4, 2);
}

function drawAmbulance(
  context: CanvasRenderingContext2D,
  halfW: number,
  halfL: number,
  timestamp: number,
  phase: number
): void {
  const pulse = (Math.sin(timestamp / 95 + phase) + 1) / 2;
  context.save();
  context.globalAlpha = 0.18 + pulse * 0.18;
  context.strokeStyle = pulse > 0.5 ? "#ef4444" : "#3b82f6";
  context.lineWidth = 2 + pulse * 2;
  context.shadowColor = context.strokeStyle;
  context.shadowBlur = 13;
  context.beginPath();
  context.arc(0, 0, halfL + 7 + pulse * 5, 0, Math.PI * 2);
  context.stroke();
  context.restore();

  context.fillStyle = "#ffffff";
  context.beginPath();
  context.roundRect(-halfW + 2, -halfL + 9, halfW * 2 - 4, halfL * 2 - 15, 4);
  context.fill();
  context.fillStyle = "#b91c1c";
  context.fillRect(-halfW + 2, 2, halfW * 2 - 4, 5);
  context.fillRect(-2, -halfL + 16, 4, 14);
  context.fillRect(-7, -halfL + 21, 14, 4);

  context.fillStyle = "#bfdbfe";
  context.beginPath();
  context.roundRect(-halfW + 4, -halfL + 10, halfW * 2 - 8, 8, 2);
  context.fill();
  context.fillStyle = "#f8fafc";
  context.fillRect(-halfW + 4, halfL - 6, halfW * 2 - 8, 3);
  context.fillStyle = "#fef3c7";
  context.fillRect(-halfW + 1, -halfL + 2, 5, 3);
  context.fillRect(halfW - 6, -halfL + 2, 5, 3);
  context.fillStyle = "#ef4444";
  context.fillRect(-halfW + 1, halfL - 4, 5, 3);
  context.fillRect(halfW - 6, halfL - 4, 5, 3);

  const flashRed = Math.floor(timestamp / 125 + phase) % 2 === 0;
  context.fillStyle = flashRed ? "#ef4444" : "#3b82f6";
  context.shadowColor = context.fillStyle;
  context.shadowBlur = 12;
  context.fillRect(-5, -halfL + 2, 5, 4);
  context.fillStyle = flashRed ? "#3b82f6" : "#ef4444";
  context.shadowColor = context.fillStyle;
  context.fillRect(0, -halfL + 2, 5, 4);
}

function drawDirectionLabel(
  context: CanvasRenderingContext2D,
  direction: string,
  color: string,
  count: number,
  width: number,
  height: number,
  index: number
): void {
  const labels = [
    { x: width / 2 + 18, y: 18 },
    { x: width - 125, y: height / 2 - 42 },
    { x: width / 2 + 18, y: height - 16 },
    { x: 12, y: height / 2 - 42 },
  ];
  context.font = "600 11px Inter, sans-serif";
  context.fillStyle = color;
  context.fillText(`${direction} · ${count} waiting`, labels[index].x, labels[index].y);
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
      <article className="panel learn-card"><span className="learn-icon rose"><Waypoints size={20} /></span><h2>Network coordination</h2><p>Neighboring signals share downstream capacity and queue telemetry. Green waves move traffic onward without pushing it into blocked links.</p><div className="analogy"><b>OS analogy</b><span>Backpressure → resource-aware scheduling</span></div></article>
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