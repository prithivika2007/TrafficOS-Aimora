import React, { useState, useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import {
  Algo,
  Direction,
  DIRECTIONS,
  MAX_PER_LANE,
  AGING_STEP,
  Setup,
  Sim,
  Snapshot,
  addVehicle,
  createSim,
  presetSetup,
  snapshot,
  step,
  addRogueVehicle,
  checkSimulationWatchdog,
  setSimulationDataStale,
} from "./simEngine";
import type { EChallan } from "./eChallan";
import { WATCHDOG_POLL_INTERVAL_MS } from "./safetyLayer";

interface TrafficOSSimulatorProps {
  simulationRef: MutableRefObject<Sim>;
  simulationRevision: number;
  initialAlgoConfig?: {
    algo?: string;
    quantum?: number;
  } | null;
}

const LANE_DOT: Record<Direction, string> = {
  NORTH: "bg-rose-500 shadow-lg shadow-rose-500/50",
  EAST: "bg-blue-500 shadow-lg shadow-blue-500/50",
  SOUTH: "bg-purple-500 shadow-lg shadow-purple-500/50",
  WEST: "bg-amber-500 shadow-lg shadow-amber-500/50",
};
const LANE_COLOR: Record<Direction, string> = {
  NORTH: "#f43f5e",
  EAST: "#3b82f6",
  SOUTH: "#a855f7",
  WEST: "#f59e0b",
};
const LANE_SHORT: Record<Direction, string> = { NORTH: "N", EAST: "E", SOUTH: "S", WEST: "W" };
const CAR_ROTATION: Record<Direction, number> = {
  NORTH: 180,
  EAST: -90,
  SOUTH: 0,
  WEST: 90,
};

const ALGO_LABEL: Record<Algo, string> = {
  STATIC: "Static Timers (Usual Traffic)",
  RR: "Round Robin (RR)",
  PRIORITY_AGING: "Priority + Aging",
};

const ALGO_HINT: Record<Algo, string> = {
  STATIC: "Fixed-duration greens rotate in lane order, including empty lanes while traffic remains.",
  RR: "Every lane gets one time quantum of green in circular order, then preemptively rotates.",
  PRIORITY_AGING: `Prioritizes critical lanes. Waiting queues gain priority weight every ${AGING_STEP}s to eliminate starvation.`,
};

const isAlgo = (a?: string): a is Algo =>
  a === "STATIC" || a === "RR" || a === "PRIORITY_AGING";

type Phase = "IDLE" | "RUNNING" | "PAUSED" | "STOPPED" | "COMPLETED";
type DashboardTab = "SAFETY" | "E_CHALLANS";
type BenchmarkAlgo = "STATIC" | "RR" | "PRIORITY_AGING";

interface BenchmarkReading {
  algo: BenchmarkAlgo;
  avgWait: number;
  served: number;
  contextSwitches: number;
}

interface FrozenBenchmark {
  status: "PAUSED" | "FINAL ANALYSIS";
  elapsed: number;
  readings: BenchmarkReading[];
}

const createBenchmarkSims = (
  setup: Setup,
  activeAlgo: BenchmarkAlgo,
  emergencyLane: Direction | null
): Partial<Record<BenchmarkAlgo, Sim>> => {
  const sims: Partial<Record<BenchmarkAlgo, Sim>> = {
    STATIC: createSim(setup, "STATIC", emergencyLane),
  };
  if (activeAlgo !== "STATIC") {
    sims[activeAlgo] = createSim(
      setup,
      activeAlgo,
      activeAlgo === "PRIORITY_AGING" ? emergencyLane : null
    );
  }
  return sims;
};

export const TrafficOSSimulator: React.FC<TrafficOSSimulatorProps> = ({
  simulationRef,
  simulationRevision,
  initialAlgoConfig,
}) => {
  const initialAlgo: Algo = isAlgo(initialAlgoConfig?.algo)
    ? initialAlgoConfig.algo
    : "RR";

  const [selectedAlgo, setSelectedAlgo] = useState<Algo>(initialAlgo);
  const [timeQuantum, setTimeQuantum] = useState<number>(initialAlgoConfig?.quantum || 3);
  const [aging, setAging] = useState<boolean>(true);
  const [speed, setSpeed] = useState<number>(1);
  const [setup, setSetup] = useState<Setup>(() => presetSetup(initialAlgo));
  const [emergencyLane, setEmergencyLane] = useState<Direction | null>(null);
  const [dashboardTab, setDashboardTab] = useState<DashboardTab>("SAFETY");
  const [selectedChallan, setSelectedChallan] = useState<EChallan | null>(null);

  const localSimRef = useRef<Sim>(createSim(setup, selectedAlgo, emergencyLane));
  const simRef = simulationRef ?? localSimRef;
  const benchmarkSimsRef = useRef<Partial<Record<BenchmarkAlgo, Sim>>>(
    createBenchmarkSims(setup, selectedAlgo, emergencyLane)
  );
  const [snap, setSnap] = useState<Snapshot>(() => snapshot(simRef.current));
  const [running, setRunning] = useState<boolean>(false);
  const [stopped, setStopped] = useState<boolean>(false);
  const [frozenBenchmark, setFrozenBenchmark] = useState<FrozenBenchmark | null>(null);
  const benchmarkFrozenRef = useRef(false);

  const advanceBenchmarks = (dt: number, quantum: number, activeAlgo: BenchmarkAlgo) => {
    const benchmarkAlgos = new Set<BenchmarkAlgo>(["STATIC", activeAlgo]);
    benchmarkAlgos.forEach((algo) => {
      const benchmarkSim = benchmarkSimsRef.current[algo];
      if (benchmarkSim) step(benchmarkSim, dt, algo, quantum, true);
    });
  };

  const cfgRef = useRef({ algo: selectedAlgo, quantum: timeQuantum, aging, speed });
  cfgRef.current = { algo: selectedAlgo, quantum: timeQuantum, aging, speed };

  useEffect(() => {
    if (isAlgo(initialAlgoConfig?.algo)) {
      const nextAlgo = initialAlgoConfig.algo;
      if (nextAlgo !== selectedAlgo) {
        setSelectedAlgo(nextAlgo);
        setSetup(presetSetup(nextAlgo));
        setEmergencyLane(null);
      }
    }
    if (initialAlgoConfig?.quantum) setTimeQuantum(initialAlgoConfig.quantum);
  }, [initialAlgoConfig]);

  useEffect(() => {
    if (simRef.current.started) return;
    simRef.current = createSim(
      setup,
      selectedAlgo,
      selectedAlgo === "PRIORITY_AGING" ? emergencyLane : null
    );
    benchmarkSimsRef.current = createBenchmarkSims(setup, selectedAlgo, emergencyLane);
    setSnap(snapshot(simRef.current));
  }, [setup, selectedAlgo, emergencyLane]);

  useEffect(() => {
    if (!benchmarkFrozenRef.current) setSnap(snapshot(simRef.current));
  }, [simulationRevision, simRef]);

  useEffect(() => {
    if (!running) return;
    let last = performance.now();
    let frameId = 0;

    const loop = (now: number) => {
      if (benchmarkFrozenRef.current) return;
      const c = cfgRef.current;
      const dt = Math.min((now - last) / 1000, 0.1) * c.speed;
      last = now;
      step(simRef.current, dt, c.algo, c.quantum, c.aging);
      advanceBenchmarks(dt, c.quantum, c.algo);
      setSnap(snapshot(simRef.current));
      const benchmarksComplete = [...new Set<BenchmarkAlgo>(["STATIC", c.algo])].every(
        (algo) => benchmarkSimsRef.current[algo]?.finished ?? true
      );
      if (simRef.current.finished && benchmarksComplete) {
        freezeBenchmark("FINAL ANALYSIS");
        setRunning(false);
      } else {
        frameId = requestAnimationFrame(loop);
      }
    };

    frameId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frameId);
  }, [running]);

  useEffect(() => {
    if (!running) return;
    const watchdogTimer = window.setInterval(() => {
      if (benchmarkFrozenRef.current) return;
      if (checkSimulationWatchdog(simRef.current)) {
        setSnap(snapshot(simRef.current));
      }
    }, WATCHDOG_POLL_INTERVAL_MS);
    return () => window.clearInterval(watchdogTimer);
  }, [running]);

  const phase: Phase = running
    ? "RUNNING"
    : snap.finished
    ? "COMPLETED"
    : stopped
    ? "STOPPED"
    : snap.started
    ? "PAUSED"
    : "IDLE";

  const captureBenchmark = (status: FrozenBenchmark["status"]): FrozenBenchmark => {
    const elapsed = simRef.current.clock;
    const readings = (["STATIC", selectedAlgo] as BenchmarkAlgo[])
      .filter((algo, index, algos) => algos.indexOf(algo) === index)
      .flatMap((algo) => {
        const benchmarkSim = benchmarkSimsRef.current[algo];
        if (!benchmarkSim) return [];
        return [{
          algo,
          avgWait: benchmarkSim.served
            ? benchmarkSim.waitSum / benchmarkSim.served
            : 0,
          served: benchmarkSim.served,
          contextSwitches: benchmarkSim.contextSwitches,
        }];
      });
    return { status, elapsed, readings };
  };

  const freezeBenchmark = (status: FrozenBenchmark["status"]) => {
    benchmarkFrozenRef.current = true;
    setSnap(snapshot(simRef.current));
    setFrozenBenchmark(captureBenchmark(status));
  };

  const clearFrozenBenchmark = () => {
    benchmarkFrozenRef.current = false;
    setFrozenBenchmark(null);
    setStopped(false);
  };

  const totalVehicles =
    DIRECTIONS.reduce((n, d) => n + setup[d].count, 0) +
    (selectedAlgo === "PRIORITY_AGING" && emergencyLane ? 1 : 0);

  const reset = () => {
    setRunning(false);
    clearFrozenBenchmark();
    setSelectedChallan(null);
    const nextSetup = presetSetup(selectedAlgo);
    setEmergencyLane(null);
    setSetup(nextSetup);
    simRef.current = createSim(nextSetup, selectedAlgo);
    benchmarkSimsRef.current = createBenchmarkSims(nextSetup, selectedAlgo, null);
    setSnap(snapshot(simRef.current));
  };

  const startPause = () => {
    if (phase === "RUNNING") {
      freezeBenchmark("PAUSED");
      setRunning(false);
    } else if (phase === "COMPLETED" || phase === "STOPPED") {
      clearFrozenBenchmark();
      setSelectedChallan(null);
      simRef.current = createSim(
        setup,
        selectedAlgo,
        selectedAlgo === "PRIORITY_AGING" ? emergencyLane : null
      );
      benchmarkSimsRef.current = createBenchmarkSims(setup, selectedAlgo, emergencyLane);
      setSnap(snapshot(simRef.current));
      setRunning(true);
    } else if (totalVehicles > 0 || simRef.current.cars.length > 0) {
      clearFrozenBenchmark();
      setRunning(true);
    }
  };

  const stopKernel = () => {
    if (phase !== "RUNNING") return;
    freezeBenchmark("FINAL ANALYSIS");
    setStopped(true);
    setRunning(false);
  };

  const stepTick = () => {
    if (phase === "COMPLETED" || phase === "STOPPED") return;
    clearFrozenBenchmark();
    const c = cfgRef.current;
    step(simRef.current, 1, c.algo, c.quantum, c.aging);
    advanceBenchmarks(1, c.quantum, c.algo);
    setSnap(snapshot(simRef.current));
  };

  const injectVehicle = (lane: Direction) => {
    if (!running || benchmarkFrozenRef.current) return;
    if (addVehicle(simRef.current, lane)) {
      new Set<BenchmarkAlgo>(["STATIC", selectedAlgo]).forEach((algo) => {
        const benchmarkSim = benchmarkSimsRef.current[algo];
        if (benchmarkSim) addVehicle(benchmarkSim, lane);
      });
      setSnap(snapshot(simRef.current));
    }
  };

  const handleRogue = (lane: Direction) => {
    if (!running || benchmarkFrozenRef.current) return;
    if (!addRogueVehicle(simRef.current, lane)) return;
    setSnap(snapshot(simRef.current));
  };

  const injectAmbulance = () => {
    if (!running || benchmarkFrozenRef.current) return;
    const lane = emergencyLane ?? "SOUTH";
    if (addVehicle(simRef.current, lane, true)) {
      benchmarkSimsRef.current.STATIC && addVehicle(benchmarkSimsRef.current.STATIC, lane, true);
      benchmarkSimsRef.current.PRIORITY_AGING &&
        addVehicle(benchmarkSimsRef.current.PRIORITY_AGING, lane, true);
      setSnap(snapshot(simRef.current));
    }
  };

  const toggleSimulatedStaleData = () => {
    setSimulationDataStale(
      simRef.current,
      !simRef.current.watchdog.simulatedStale
    );
    setSnap(snapshot(simRef.current));
  };

  const setLane = (lane: Direction, patch: Partial<Setup[Direction]>) =>
    setSetup((prev) => ({ ...prev, [lane]: { ...prev[lane], ...patch } }));

  const getVehicleStyle = (lane: Direction, progress: number) => {
    switch (lane) {
      case "NORTH":
        return { top: `${progress}%`, left: "48%" };
      case "SOUTH":
        return { bottom: `${progress}%`, left: "52%" };
      case "EAST":
        return { right: `${progress}%`, top: "48%" };
      case "WEST":
        return { left: `${progress}%`, top: "52%" };
    }
  };

  const handleAlgoChange = (algo: Algo) => {
    const nextSetup = presetSetup(algo);
    setRunning(false);
    clearFrozenBenchmark();
    setSelectedAlgo(algo);
    setSetup(nextSetup);
    setEmergencyLane(null);
    setSelectedChallan(null);
    simRef.current = createSim(nextSetup, algo);
    setSnap(snapshot(simRef.current));
    benchmarkSimsRef.current = createBenchmarkSims(nextSetup, algo, null);
  };

  const hasAmbulance = (lane: Direction) =>
    snap.cars.some((car) => car.emergency && car.lane === lane);

  const signalOf = (lane: Direction) => {
    if (snap.emergencyState !== "IDLE") {
      return snap.emergencyState === "ACTIVE" && snap.active === lane
        ? "🟢 GREEN"
        : "🔴 RED";
    }
    if (snap.signalPhase === "GREEN" && snap.active === lane) return "🟢 GREEN";
    if (snap.signalPhase === "YELLOW" && snap.lastLane === lane) return "🟡 YELLOW";
    return "🔴 RED";
  };

  const activeIdx = snap.active ? DIRECTIONS.indexOf(snap.active) : -1;
  const locked = snap.started;
  const pendingFineTotal = snap.challans
    .filter((challan) => challan.paymentStatus === "Pending")
    .reduce((total, challan) => total + challan.fineAmount, 0);

  const segs = snap.segments
    .map((s) => ({ ...s, end: s.end ?? snap.clock }))
    .filter((s) => s.end - s.start > 0.01)
    .slice(-14);
  const benchmarkAlgos: BenchmarkAlgo[] =
    selectedAlgo === "STATIC" ? ["STATIC"] : ["STATIC", selectedAlgo];
  const liveBenchmarkSnapshots = benchmarkAlgos.map((algo) => {
    const benchmarkSim = benchmarkSimsRef.current[algo];
    return {
      algo,
      avgWait: benchmarkSim?.served
        ? benchmarkSim.waitSum / benchmarkSim.served
        : 0,
      served: benchmarkSim?.served ?? 0,
        contextSwitches: benchmarkSim?.contextSwitches ?? 0,
    };
  });
  const benchmarkSnapshots = frozenBenchmark?.readings ?? liveBenchmarkSnapshots;
  const staticBenchmark = benchmarkSnapshots.find(({ algo }) => algo === "STATIC");
  const activeBenchmark = benchmarkSnapshots.find(({ algo }) => algo === selectedAlgo);
  const benchmarkMaxWait = Math.max(
    0,
    ...benchmarkSnapshots.map((benchmark) => benchmark.avgWait)
  );
  const hasComparisonSample =
    selectedAlgo !== "STATIC" &&
    (staticBenchmark?.served ?? 0) > 0 &&
    (activeBenchmark?.served ?? 0) > 0;
  const delaySavings =
    hasComparisonSample && staticBenchmark && activeBenchmark
      ? staticBenchmark.avgWait - activeBenchmark.avgWait
      : null;
  const efficiencyGain =
    delaySavings !== null && staticBenchmark && staticBenchmark.avgWait > 0
      ? (delaySavings / staticBenchmark.avgWait) * 100
      : null;
  const activeAlgoLabel =
    selectedAlgo === "RR"
      ? "Round Robin (Cyclic Quantum)"
      : selectedAlgo === "PRIORITY_AGING"
      ? "Priority + Dynamic Aging"
      : "Static Timers (Usual Traffic)";
  const frozenStaticBenchmark = frozenBenchmark?.readings.find(
    ({ algo }) => algo === "STATIC"
  );
  const frozenActiveBenchmark = frozenBenchmark?.readings.find(
    ({ algo }) => algo === selectedAlgo
  );
  const frozenDelaySavings =
    selectedAlgo !== "STATIC" &&
    frozenStaticBenchmark?.served &&
    frozenActiveBenchmark?.served
      ? frozenStaticBenchmark.avgWait - frozenActiveBenchmark.avgWait
      : null;
  const frozenEfficiencyGain =
    frozenDelaySavings !== null &&
    frozenStaticBenchmark &&
    frozenStaticBenchmark.avgWait > 0
      ? (frozenDelaySavings / frozenStaticBenchmark.avgWait) * 100
      : null;
  const frozenThroughput =
    frozenBenchmark && frozenActiveBenchmark && frozenBenchmark.elapsed > 0
      ? (frozenActiveBenchmark.served / frozenBenchmark.elapsed) * 60
      : 0;
  const frozenSwitchLabel =
    frozenActiveBenchmark?.contextSwitches === 1 ? "context switch" : "context switches";
  const benchmarkStatusLabel = frozenBenchmark
    ? `${frozenBenchmark.status === "PAUSED" ? "RUN PAUSED" : "FINAL ANALYSIS"} • ${frozenBenchmark.elapsed.toFixed(1)}s`
    : running
    ? `LIVE BENCHMARK • ${snap.clock.toFixed(1)}s`
    : "READY";
  const frozenConclusion =
    frozenBenchmark && selectedAlgo !== "STATIC"
      ? frozenDelaySavings === null ||
        !frozenStaticBenchmark ||
        !frozenActiveBenchmark
        ? `Final analysis captured at ${frozenBenchmark.elapsed.toFixed(1)}s. Not enough served vehicles in both runs to calculate a reliable comparison.`
        : frozenDelaySavings > 0
        ? `At ${frozenBenchmark.elapsed.toFixed(1)}s, Static Timers averaged ${frozenStaticBenchmark.avgWait.toFixed(2)}s of wait per car, while ${activeAlgoLabel} averaged ${frozenActiveBenchmark.avgWait.toFixed(2)}s. Average wait fell by ${frozenDelaySavings.toFixed(2)}s per car (${frozenEfficiencyGain?.toFixed(1)}%). The active run served ${frozenActiveBenchmark.served} vehicles at ${frozenThroughput.toFixed(1)} vehicles/min and recorded ${frozenActiveBenchmark.contextSwitches} ${frozenSwitchLabel}.`
        : frozenDelaySavings < 0
        ? `At ${frozenBenchmark.elapsed.toFixed(1)}s, Static Timers averaged ${frozenStaticBenchmark.avgWait.toFixed(2)}s of wait per car, while ${activeAlgoLabel} averaged ${frozenActiveBenchmark.avgWait.toFixed(2)}s. Average wait increased by ${Math.abs(frozenDelaySavings).toFixed(2)}s per car (${Math.abs(frozenEfficiencyGain ?? 0).toFixed(1)}%) in this run. The active run served ${frozenActiveBenchmark.served} vehicles at ${frozenThroughput.toFixed(1)} vehicles/min and recorded ${frozenActiveBenchmark.contextSwitches} ${frozenSwitchLabel}.`
        : `At ${frozenBenchmark.elapsed.toFixed(1)}s, Static Timers and ${activeAlgoLabel} matched at ${frozenStaticBenchmark.avgWait.toFixed(2)}s average wait per car. The active run served ${frozenActiveBenchmark.served} vehicles at ${frozenThroughput.toFixed(1)} vehicles/min and recorded ${frozenActiveBenchmark.contextSwitches} ${frozenSwitchLabel}.`
      : frozenBenchmark
      ? "Static Timers is the selected baseline. Select Round Robin or Priority + Dynamic Aging to generate a comparative efficiency report."
      : null;

  const selectCls =
    "w-full bg-white border border-slate-300 rounded-xl px-3 py-2 text-xs font-semibold text-slate-900 focus:outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500 transition-all disabled:opacity-50";

  return (
    <div className="font-executive space-y-6 text-slate-100 max-w-7xl mx-auto p-2">
      {/* Top Header Control Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4 p-4 rounded-2xl bg-slate-900/90 backdrop-blur-xl border border-slate-800 shadow-2xl">
        <div className="flex items-center gap-3 flex-wrap">
          <button
            onClick={startPause}
            disabled={phase === "IDLE" && totalVehicles === 0}
            className={`px-5 py-2.5 rounded-xl font-bold text-xs tracking-wider transition-all shadow-lg disabled:opacity-40 flex items-center gap-2 ${
              phase === "RUNNING"
                ? "bg-amber-500 hover:bg-amber-400 text-slate-950 shadow-amber-500/20"
                : "bg-gradient-to-r from-emerald-500 to-teal-400 hover:from-emerald-400 hover:to-teal-300 text-slate-950 shadow-emerald-500/20"
            }`}
          >
            {phase === "RUNNING" && <span className="w-2 h-2 rounded-full bg-slate-950 animate-ping" />}
            {phase === "RUNNING"
              ? "PAUSE KERNEL"
              : phase === "PAUSED"
              ? "RESUME KERNEL"
              : phase === "COMPLETED" || phase === "STOPPED"
              ? "RESTART KERNEL"
              : "START KERNEL"}
          </button>

          <button
            type="button"
            onClick={stopKernel}
            disabled={phase !== "RUNNING"}
            className="px-4 py-2.5 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 text-xs font-bold text-rose-300 border border-rose-500/30 transition-all disabled:opacity-40"
          >
            STOP KERNEL
          </button>

          <button
            onClick={stepTick}
            disabled={phase === "RUNNING" || phase === "COMPLETED" || phase === "STOPPED" || totalVehicles === 0}
            className="px-4 py-2.5 rounded-xl bg-slate-800/80 hover:bg-slate-750 text-xs font-bold text-cyan-300 border border-cyan-500/30 transition-all disabled:opacity-40"
          >
            STEP TICK
          </button>

          <button
            onClick={reset}
            className="px-4 py-2.5 rounded-xl bg-slate-800/80 hover:bg-slate-750 text-xs font-semibold text-slate-300 border border-slate-700 transition-all hover:border-slate-500"
          >
            RESET
          </button>
        </div>

        <div className="flex items-center gap-6 bg-slate-950/60 px-4 py-2 rounded-xl border border-slate-800/80">
          <div className="text-xs">
            <span className="text-slate-500 mr-2">CLOCK:</span>
            <span className="text-cyan-400 font-bold">{snap.clock.toFixed(1)}s</span>
          </div>
          <div className="text-xs">
            <span className="text-slate-500 mr-2">SIGNAL:</span>
            <span
              className={`font-bold ${
                snap.signalPhase === "GREEN"
                  ? "text-emerald-400"
                  : snap.signalPhase === "YELLOW"
                  ? "text-amber-300"
                  : "text-rose-400"
              }`}
            >
              {snap.signalPhase} · {snap.phaseRemaining.toFixed(1)}s
            </span>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className="text-slate-500">STATE:</span>
            <span
              className={`px-2.5 py-0.5 rounded-lg text-[11px] font-bold tracking-wide ${
                phase === "RUNNING"
                  ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30"
                  : frozenBenchmark
                  ? "bg-amber-400/10 text-amber-200 border border-amber-400/30"
                  : phase === "COMPLETED"
                  ? "bg-cyan-500/10 text-cyan-400 border border-cyan-500/30"
                  : "bg-slate-800 text-slate-400 border border-slate-700"
              }`}
            >
              {frozenBenchmark ? "FROZEN" : phase}
            </span>
          </div>
        </div>
      </div>
      <section
        aria-live="polite"
        className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/70 p-3"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex gap-2">
            {([
              ["SAFETY", "Safety Monitor"],
              ["E_CHALLANS", "E-Challans"],
            ] as const).map(([tab, label]) => (
              <button
                key={tab}
                type="button"
                onClick={() => setDashboardTab(tab)}
                aria-pressed={dashboardTab === tab}
                className={`rounded-lg border px-3 py-2 text-[11px] font-bold transition-colors ${
                  dashboardTab === tab
                    ? "border-cyan-400/50 bg-cyan-400/10 text-cyan-300"
                    : "border-slate-700 text-slate-400 hover:border-slate-500"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <span className="text-[9px] font-semibold uppercase tracking-wide text-slate-500">
            Simulated prototype data · in-memory only · no official issuance or real payment
          </span>
        </div>
        {snap.watchdog.failSafeActive && (
          <div
            role="alert"
            className="rounded-lg border border-rose-500/50 bg-rose-500/10 p-3"
          >
            <div className="text-xs font-black tracking-wide text-rose-200">
              FAIL-SAFE ACTIVE · NORMAL AND AMBULANCE GREEN DISPATCH BLOCKED
            </div>
            <p className="mt-1 text-[10px] text-slate-300">
              {snap.watchdog.reason}{" "}
              {snap.watchdog.recovering
                ? snap.junctionClear
                  ? "Valid updates resumed; verifying all-red timing and junction clearance."
                  : "Valid updates resumed; waiting for the junction to clear before recovery."
                : "Waiting for valid simulation updates. This is a software simulation, not a CCTV or hardware fault detector."}
            </p>
          </div>
        )}
        {snap.started && running && (
          <button
            type="button"
            onClick={toggleSimulatedStaleData}
            aria-pressed={snap.watchdog.simulatedStale}
            className={`rounded-lg border px-3 py-2 text-[10px] font-bold ${
              snap.watchdog.simulatedStale
                ? "border-amber-400/40 bg-amber-400/10 text-amber-200"
                : "border-slate-700 text-slate-400 hover:border-slate-500"
            }`}
          >
            {snap.watchdog.simulatedStale
              ? "RESTORE SIMULATED DATA UPDATES"
              : "DEMO: SIMULATE STALE DATA"}
          </button>
        )}

        {dashboardTab === "SAFETY" ? (
          <div className="space-y-2 rounded-xl border border-rose-500/30 bg-slate-900/70 p-3">
            <div className="flex items-center justify-between gap-3 text-xs">
              <h2 className="font-bold text-rose-300">KERNEL SAFETY MONITOR</h2>
              <span className="font-bold text-rose-200">VIOLATIONS: {snap.violations}</span>
            </div>
            {snap.violationLog.length > 0 && (
              <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-2.5">
                <div className="text-[11px] font-bold text-rose-200">
                  SAFETY ALERT · {snap.violationLog[snap.violationLog.length - 1].type} ·{" "}
                  {snap.violationLog[snap.violationLog.length - 1].lane}
                </div>
                <p className="mt-1 text-[10px] text-slate-300">
                  {snap.violationLog[snap.violationLog.length - 1].description}
                </p>
              </div>
            )}
            {snap.safetyHoldActive && snap.signalPhase === "ALL_RED" && (
              <div className="rounded-lg border border-amber-400/30 bg-amber-400/10 px-2.5 py-2 text-[11px] font-bold text-amber-200">
                SAFETY HOLD · ALL RED ·{" "}
                {snap.phaseRemaining > 0
                  ? `${snap.phaseRemaining.toFixed(1)}s until next green`
                  : snap.junctionClear
                  ? "CLEARANCE COMPLETE"
                  : "WAITING FOR JUNCTION CLEARANCE"}
              </div>
            )}
            {snap.safetyHoldPending && (
              <div className="text-[10px] font-semibold text-amber-200">
                CLEARANCE PENDING · next green waits for all-red safety hold
              </div>
            )}
            <div className="space-y-1">
              {snap.violationLog
                .slice(-5)
                .reverse()
                .map((entry) => (
                  <div
                    key={entry.id}
                    className="grid grid-cols-[auto_1fr] gap-x-2 text-[10px] text-slate-300"
                  >
                    <span className="font-bold text-rose-300">{entry.id}</span>
                    <span>
                      t={entry.timestamp.toFixed(1)}s · {entry.lane} · {entry.vehicleId} ·{" "}
                      {entry.type} · +{entry.additionalHoldSeconds}s hold · #{entry.violationCount}
                    </span>
                  </div>
                ))}
            </div>
          </div>
        ) : (
          <div className="space-y-3 rounded-xl border border-cyan-500/20 bg-slate-950/50 p-3">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {[
                { label: "TOTAL CHALLANS", value: snap.challans.length },
                {
                  label: "PENDING FINES",
                  value: `₹${pendingFineTotal.toLocaleString("en-IN")}`,
                },
                {
                  label: "PENDING COUNT",
                  value: snap.challans.filter((item) => item.paymentStatus === "Pending").length,
                },
              ].map((metric) => (
                <div
                  key={metric.label}
                  className="rounded-lg border border-slate-800 bg-slate-900/80 p-2.5"
                >
                  <span className="block text-[9px] font-semibold text-slate-500">
                    {metric.label}
                  </span>
                  <span className="text-sm font-black text-cyan-300">{metric.value}</span>
                </div>
              ))}
            </div>
            <h2 className="text-[11px] font-bold uppercase tracking-wider text-slate-300">
              Recent E-Challans
            </h2>
            {snap.challans.length === 0 ? (
              <p className="text-xs text-slate-500">No simulated challans have been generated.</p>
            ) : (
              <div className="space-y-2">
                {snap.challans
                  .slice(-5)
                  .reverse()
                  .map((challan) => (
                    <article
                      key={challan.challanNumber}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-900/70 p-2.5"
                    >
                      <div className="min-w-0 space-y-0.5 text-[10px] text-slate-300">
                        <div className="font-bold text-cyan-300">{challan.challanNumber}</div>
                        <div>
                          {challan.vehicleId} · Simulated plate: {challan.registrationNumber}
                        </div>
                        <div>
                          {challan.violationType} · {challan.lane} · t=
                          {challan.simulationTimestamp.toFixed(1)}s
                        </div>
                        <div>
                          ₹{challan.fineAmount.toLocaleString("en-IN")} ·{" "}
                          <span className="text-amber-300">{challan.paymentStatus}</span>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setSelectedChallan(challan)}
                        className="shrink-0 rounded-lg border border-cyan-500/30 px-2.5 py-1.5 text-[10px] font-bold text-cyan-300 transition-colors hover:bg-cyan-500/10"
                      >
                        View Details
                      </button>
                    </article>
                  ))}
              </div>
            )}
          </div>
        )}
      </section>

      {selectedChallan && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4"
          role="presentation"
          onClick={() => setSelectedChallan(null)}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="challan-detail-title"
            className="w-full max-w-lg space-y-4 rounded-2xl border border-cyan-500/30 bg-slate-900 p-5 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 id="challan-detail-title" className="text-sm font-bold text-cyan-300">
                  E-Challan Details
                </h2>
                <p className="mt-1 text-xs font-bold text-slate-100">
                  {selectedChallan.challanNumber}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedChallan(null)}
                className="rounded-lg border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800"
              >
                Close
              </button>
            </div>
            <dl className="grid grid-cols-[minmax(8rem,auto)_1fr] gap-x-4 gap-y-2 text-xs">
              {[
                ["Violation ID", selectedChallan.violationId],
                ["Violation", selectedChallan.violationType],
                ["Description", selectedChallan.description],
                ["Lane", selectedChallan.lane],
                ["Intersection", selectedChallan.intersectionId],
                ["Simulation time", `${selectedChallan.simulationTimestamp.toFixed(1)}s`],
                ["Vehicle ID", selectedChallan.vehicleId],
                ["Simulated plate", selectedChallan.registrationNumber],
                ["Fine amount", `₹${selectedChallan.fineAmount.toLocaleString("en-IN")}`],
                ["Payment status", selectedChallan.paymentStatus],
              ].map(([label, value]) => (
                <React.Fragment key={label}>
                  <dt className="text-slate-500">{label}</dt>
                  <dd className="break-words text-slate-200">{value}</dd>
                </React.Fragment>
              ))}
            </dl>
            <p className="border-t border-slate-800 pt-3 text-[10px] text-slate-500">
              Simulated prototype record only. Not an official government challan; no real
              payment is collected. Records are held in memory and reset with the simulation.
            </p>
          </section>
        </div>
      )}

      {/* Main Dashboard Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Control Panel */}
        <div className="lg:col-span-4 p-5 rounded-2xl bg-slate-900/90 backdrop-blur-xl border border-slate-800 space-y-5 shadow-xl">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-bold text-cyan-400 uppercase tracking-widest flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
              Scheduler Parameters
            </h3>
          </div>

          <div>
            <label className="block text-[11px] text-slate-400 mb-1.5 font-medium">Active Algorithm</label>
            <select
              value={selectedAlgo}
              onChange={(e) => handleAlgoChange(e.target.value as Algo)}
              className={selectCls}
            >
              {(Object.keys(ALGO_LABEL) as Algo[]).map((a) => (
                <option key={a} value={a}>
                  {ALGO_LABEL[a]}
                </option>
              ))}
            </select>
            <p className="mt-2 text-[10px] leading-relaxed text-slate-400 bg-slate-950/40 p-2.5 rounded-xl border border-slate-800/60">
              {ALGO_HINT[selectedAlgo]}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3 text-xs">
            <div>
              <label className="block text-[10px] text-slate-400 mb-1.5 font-medium">TIME QUANTUM</label>
              <select
                value={timeQuantum}
                onChange={(e) => setTimeQuantum(Number(e.target.value))}
                className={selectCls}
              >
                {[1, 2, 3, 5].map((q) => (
                  <option key={q} value={q}>
                    {q}s
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[10px] text-slate-400 mb-1.5 font-medium">SIM SPEED</label>
              <select
                value={speed}
                onChange={(e) => setSpeed(Number(e.target.value))}
                className={selectCls}
              >
                {[1, 2, 4].map((s) => (
                  <option key={s} value={s}>
                    {s}x
                  </option>
                ))}
              </select>
            </div>
          </div>

          {selectedAlgo === "PRIORITY_AGING" && (
            <button
              onClick={() => setAging((a) => !a)}
              className={`w-full px-3 py-2.5 rounded-xl text-xs font-bold border transition-all flex items-center justify-center gap-2 ${
                aging
                  ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/20"
                  : "bg-slate-800 text-slate-400 border-slate-700"
              }`}
            >
              <span className={`w-2 h-2 rounded-full ${aging ? "bg-emerald-400 animate-ping" : "bg-slate-500"}`} />
              DYNAMIC AGING: {aging ? "ACTIVE" : "OFF"}
            </button>
          )}

          {/* Lane Workload Config */}
          <div className="space-y-2.5 pt-2 border-t border-slate-800/80">
            <label className="block text-[10px] text-slate-400 uppercase font-semibold tracking-wider">
              Lane Workload {locked && "(Locked — Reset to edit)"}
            </label>
            <div className="grid grid-cols-[1.2fr_1fr_1fr] gap-2 text-[10px] text-slate-500 px-1 font-semibold">
              <span>LANE</span>
              <span>VEHICLES</span>
              <span className={selectedAlgo === "PRIORITY_AGING" ? "" : "opacity-30"}>PRIORITY</span>
            </div>
            <div className="space-y-1.5">
              {DIRECTIONS.map((d) => (
                <div key={d} className="grid grid-cols-[1.2fr_1fr_1fr] gap-2 items-center bg-slate-950/40 p-1.5 rounded-xl border border-slate-800/50">
                  <span className="flex items-center gap-2 text-xs font-semibold text-slate-300">
                    <span className={`w-2.5 h-2.5 rounded-full ${LANE_DOT[d]}`} />
                    {d}
                  </span>
                  <select
                    value={setup[d].count}
                    disabled={locked}
                    onChange={(e) => setLane(d, { count: Number(e.target.value) })}
                    className={selectCls}
                  >
                    {Array.from({ length: MAX_PER_LANE + 1 }, (_, n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                  <select
                    value={setup[d].priority}
                    disabled={locked}
                    onChange={(e) => setLane(d, { priority: Number(e.target.value) })}
                    className={selectCls}
                  >
                    {[1, 2, 3, 4, 5].map((p) => (
                      <option key={p} value={p}>
                        P{p}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          </div>

          {selectedAlgo === "PRIORITY_AGING" && (
            <div className="pt-2 border-t border-slate-800/80">
              <label className="block text-xs text-slate-300 mb-1.5 font-medium">
                Emergency Vehicle Lane
              </label>
              <select
                value={emergencyLane ?? "NONE"}
                onChange={(e) =>
                  setEmergencyLane(e.target.value === "NONE" ? null : (e.target.value as Direction))
                }
                className={selectCls}
              >
                <option value="NONE">None</option>
                {DIRECTIONS.map((d) => (
                  <option key={d} value={d}>
                    {d[0] + d.slice(1).toLowerCase()}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Live Injection Actions */}
          <div className="pt-2 border-t border-slate-800/80">
            <label className="block text-[10px] text-slate-400 mb-2 uppercase font-semibold tracking-wider">
              Live Injection Controls
            </label>
            <div className={`grid ${selectedAlgo === "PRIORITY_AGING" ? "grid-cols-5" : "grid-cols-4"} gap-2`}>
              {DIRECTIONS.map((d) => (
  <button
    key={d}
    onClick={() => injectVehicle(d)}
    disabled={phase !== "RUNNING" || snap.queued[d] >= MAX_PER_LANE}
    className="px-2 py-2 rounded-xl bg-slate-950/80 hover:bg-slate-800 border border-slate-700/80 text-xs font-bold text-cyan-400 transition-all disabled:opacity-30 shadow-sm"
    title={`Add vehicle to ${d}`}
  >
    + {LANE_SHORT[d]}
  </button>
))}

{/* Rogue (red-light violator) buttons */}
{DIRECTIONS.map((d) => (
  <button
    key={`rogue-${d}`}
    onClick={() => handleRogue(d)}
    disabled={phase !== "RUNNING"}
    className="px-2 py-2 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/40 text-[11px] font-bold text-rose-300 transition-all disabled:opacity-30"
    title={`Vehicle runs the red light on ${d}`}
  >
    ⚠ {LANE_SHORT[d]}
  </button>
))}
              {selectedAlgo === "PRIORITY_AGING" && (
                <button
                  onClick={injectAmbulance}
                  disabled={!running}
                  className="px-2 py-2 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/40 text-[11px] font-bold text-rose-300 transition-all disabled:opacity-30 col-span-5 flex items-center justify-center gap-1.5"
                >
                  <span>🚑</span> TRIGGER EMERGENCY AMBULANCE PREEMPTION
                </button>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 text-xs pt-2 border-t border-slate-800/80">
            <div className="p-3 rounded-xl bg-slate-950/50 border border-slate-800">
              <span className="text-slate-500 block text-[10px] font-semibold">GREEN SIGNAL</span>
              <span className="text-emerald-400 font-bold tracking-wide">
                {snap.active ?? (snap.clearing ? "SWITCHING" : "—")}
              </span>
            </div>
            <div className="p-3 rounded-xl bg-slate-950/50 border border-slate-800">
              <span className="text-slate-500 block text-[10px] font-semibold">CONTEXT SWITCHES</span>
              <span className="text-purple-400 font-bold tracking-wide">{snap.contextSwitches}</span>
            </div>
          </div>
        </div>

        {/* Right Canvas and Analytics Panel */}
        <div className="lg:col-span-8 p-5 rounded-2xl bg-slate-900/90 backdrop-blur-xl border border-slate-800 flex flex-col justify-between shadow-xl">
          {/* Intersection Canvas */}
          <div className="relative w-full h-80 bg-slate-950 rounded-2xl border border-slate-800 overflow-hidden flex items-center justify-center shadow-inner">
            {/* Roads */}
            <div className="absolute w-24 h-full bg-slate-900/90 border-x border-dashed border-slate-700/50 flex justify-center">
              <div className="absolute w-0.5 h-full bg-amber-400/20" />
            </div>
            <div className="absolute h-24 w-full bg-slate-900/90 border-y border-dashed border-slate-700/50 flex items-center">
              <div className="absolute w-full h-0.5 bg-amber-400/20" />
            </div>

            {/* Signal Labels */}
            <div className="absolute top-3 left-4 text-[11px] font-bold tracking-wide text-slate-300 bg-slate-900/80 px-2.5 py-1 rounded-lg border border-slate-800">
              NORTH: {signalOf("NORTH")} {hasAmbulance("NORTH") && <span className="text-rose-400 animate-pulse font-extrabold">🚨 EMERGENCY</span>}
            </div>
            <div className="absolute bottom-3 left-4 text-[11px] font-bold tracking-wide text-slate-300 bg-slate-900/80 px-2.5 py-1 rounded-lg border border-slate-800">
              SOUTH: {signalOf("SOUTH")} {hasAmbulance("SOUTH") && <span className="text-rose-400 animate-pulse font-extrabold">🚨 EMERGENCY</span>}
            </div>
            <div className="absolute left-3 top-16 text-[11px] font-bold tracking-wide text-slate-300 bg-slate-900/80 px-2.5 py-1 rounded-lg border border-slate-800">
              WEST: {signalOf("WEST")} {hasAmbulance("WEST") && <span className="text-rose-400 animate-pulse font-extrabold">🚨 EMERGENCY</span>}
            </div>
            <div className="absolute right-3 top-16 text-[11px] font-bold tracking-wide text-slate-300 bg-slate-900/80 px-2.5 py-1 rounded-lg border border-slate-800">
              EAST: {signalOf("EAST")} {hasAmbulance("EAST") && <span className="text-rose-400 animate-pulse font-extrabold">🚨 EMERGENCY</span>}
            </div>

            {/* Moving Vehicles */}
            {snap.cars.map((v) => (
              <div
                key={v.id}
                className="absolute w-4 h-6 transition-all duration-75"
                style={{
                  ...getVehicleStyle(v.lane, v.progress),
                  transform: "translate(-50%, -50%)",
                }}
              >
                {v.emergency ? (
                  <div
                    aria-label="Ambulance"
                    className="relative flex h-full w-full items-center justify-center text-lg drop-shadow-lg"
                    style={{ transform: `rotate(${CAR_ROTATION[v.lane]}deg)` }}
                  >
                    🚑
                    <span className="absolute left-1/2 top-0 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-rose-500 animate-ping" />
                    <span className="absolute left-1/2 top-0 h-1.5 w-1.5 translate-x-1 rounded-full bg-blue-500 animate-ping" />
                  </div>
                ) : (
                  <svg
                    viewBox="0 0 20 30"
                    aria-hidden="true"
                    className="w-full h-full drop-shadow-md"
                    style={{ transform: `rotate(${CAR_ROTATION[v.lane]}deg)` }}
                  >
                    <path
                      d="M6 1.5h8l3 5v17l-3 5H6l-3-5v-17l3-5Z"
                      fill={LANE_COLOR[v.lane]}
                      stroke="#0f172a"
                      strokeWidth="1.2"
                    />
                    <path d="M5 8h10v7H5z" fill="#f8fafc" opacity="0.9" />
                    <path d="M5 18h10v3H5z" fill="#0f172a" opacity="0.8" />
                    <path d="M7 3.5h6" stroke="#fff" strokeWidth="1.2" strokeLinecap="round" />
                  </svg>
                )}
              </div>
            ))}
          </div>

          {/* Circular Queue Traversal Grid */}
          <div className="mt-4 p-3.5 rounded-2xl bg-slate-950/60 border border-slate-800">
            <span className="text-[10px] text-slate-400 font-bold block mb-2.5 uppercase tracking-widest flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-purple-400" />
              Circular Queue Traversal Array: (i + 1) MOD 4
            </span>
            <div className="grid grid-cols-4 gap-2.5 text-center text-xs">
              {DIRECTIONS.map((dir, idx) => {
                const isActive = idx === activeIdx;
                return (
                  <div
                    key={dir}
                    className={`p-2.5 rounded-xl border transition-all ${
                      isActive
                        ? "bg-cyan-500/10 border-cyan-500/60 text-cyan-300 font-bold shadow-lg shadow-cyan-500/10"
                        : "bg-slate-900 border-slate-800 text-slate-400"
                    }`}
                  >
                    <div className="text-[9px] opacity-70">INDEX [{idx}]</div>
                    <div className="font-semibold">{dir}</div>
                    <div className="text-[10px] mt-0.5 text-slate-300">
                      {snap.queued[dir]} waiting
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Gantt Timeline */}
          <div className="mt-4 p-3.5 rounded-2xl bg-slate-950/60 border border-slate-800">
            <span className="text-[10px] text-slate-400 font-bold block mb-2.5 uppercase tracking-widest flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
              Scheduler Gantt Timeline (Green Slices)
            </span>
            {segs.length === 0 ? (
              <div className="text-xs text-slate-500 italic py-2">Press START KERNEL to generate scheduling execution trace...</div>
            ) : (
              <div className="flex gap-1 h-9 items-center bg-slate-900 p-1.5 rounded-xl border border-slate-800">
                {segs.map((s, i) => (
                  <div
                    key={i}
                    title={`${s.lane}: ${s.start.toFixed(1)}s → ${s.end.toFixed(1)}s`}
                    style={{ flexGrow: Math.max(s.end - s.start, 0.8), flexBasis: 0 }}
                    className={`${s.emergency ? "bg-rose-500 text-white ring-2 ring-white/80 animate-pulse font-black" : `${LANE_DOT[s.lane]} text-slate-950`} rounded-lg flex items-center justify-center text-[10px] font-bold min-w-[22px] shadow-sm`}
                  >
                    {LANE_SHORT[s.lane]}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Real-time Performance Metrics */}
          <div className="mt-4 grid grid-cols-2 sm:grid-cols-5 gap-2.5 text-center text-xs">
            {[
              { label: "AVG WAIT", value: `${snap.avgWait.toFixed(1)}s`, cls: "text-cyan-400" },
              { label: "AVG TURNAROUND", value: `${snap.avgTat.toFixed(1)}s`, cls: "text-emerald-400" },
              { label: "THROUGHPUT", value: `${snap.throughput.toFixed(1)}/min`, cls: "text-sky-400" },
              { label: "SERVED", value: `${snap.served}`, cls: "text-purple-400" },
              { label: "LONGEST WAIT", value: `${snap.maxLaneWait.toFixed(1)}s`, cls: "text-rose-400" },
            ].map((m) => (
              <div key={m.label} className="p-3 rounded-2xl bg-slate-950/80 border border-slate-700 shadow-sm">
                <span className="text-slate-300 block text-[10px] font-bold mb-1">{m.label}</span>
                <span className={`${m.cls} font-black text-base tracking-tight`}>{m.value}</span>
              </div>
            ))}
          </div>

          {/* Comparative efficiency benchmark */}
          <section
            aria-labelledby="efficiency-benchmark-title"
            aria-live="polite"
            className="mt-4 overflow-hidden rounded-2xl border border-slate-300 bg-gradient-to-br from-white via-slate-50 to-slate-100 p-4 text-slate-900 shadow-[0_12px_40px_rgba(0,0,0,0.18)] sm:p-6"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-amber-700">
                  {frozenBenchmark ? "AIML Department Expo · Final report" : "AIML Department Expo · Live analysis"}
                </p>
                <h2
                  id="efficiency-benchmark-title"
                  className="mt-1 text-lg font-black tracking-tight text-slate-950 sm:text-xl"
                >
                  Comparative Efficiency Benchmark
                </h2>
                <p className="mt-1 text-xs font-semibold leading-relaxed text-slate-600">
                  Average vehicle wait · only the selected scheduler is replayed against the static baseline
                </p>
              </div>
              <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[10px] font-black uppercase tracking-wider ${frozenBenchmark ? "border-slate-400 bg-slate-200 text-slate-900" : running ? "border-emerald-300 bg-emerald-100 text-emerald-900" : "border-amber-300 bg-amber-100 text-amber-900"}`}>
                <span className="h-2 w-2 rounded-full bg-amber-500 shadow-[0_0_10px_rgba(245,158,11,0.6)]" />
                {benchmarkStatusLabel}
              </span>
            </div>

            <div className="mt-5 space-y-4">
              {benchmarkSnapshots.map(({ algo, avgWait, served, contextSwitches }) => {
                const width =
                  benchmarkMaxWait > 0
                    ? (avgWait / benchmarkMaxWait) * 100
                    : 0;
                const label =
                  algo === "STATIC"
                    ? "Static Timers (Usual Traffic)"
                    : algo === "RR"
                    ? "Round Robin (Cyclic Quantum)"
                    : "Priority + Dynamic Aging";
                const barColor =
                  algo === "STATIC"
                    ? "from-slate-400 to-slate-500"
                    : algo === "RR"
                    ? "from-emerald-400 to-emerald-600"
                    : "from-emerald-400 to-emerald-600";

                return (
                  <div key={algo} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-xs font-bold text-slate-800 sm:text-sm">
                        {label}
                      </span>
                      {algo === selectedAlgo && algo !== "STATIC" && (
                        <span className="shrink-0 rounded-full border border-amber-300 bg-amber-100 px-2 py-0.5 text-[9px] font-black uppercase tracking-wider text-amber-900">
                          Active
                        </span>
                      )}
                    </div>
                    <span className="text-right font-sans text-xs font-bold tabular-nums text-slate-900 sm:text-sm">
                      {avgWait.toFixed(2)}s
                      <span className="ml-1 block text-[10px] font-semibold text-slate-600">
                        n={served} · {contextSwitches} switches
                      </span>
                    </span>
                    <div
                      role="progressbar"
                      aria-label={`${label} average wait`}
                      aria-valuemin={0}
                      aria-valuemax={benchmarkMaxWait || 0}
                      aria-valuenow={avgWait}
                      className="col-span-2 h-3 overflow-hidden rounded-full border border-slate-300 bg-white"
                    >
                      <div
                        className={`h-full rounded-full bg-gradient-to-r ${barColor} ${frozenBenchmark ? "" : "transition-[width] duration-300"}`}
                        style={{ width: `${width}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="mt-5 grid gap-3 border-t border-slate-300 pt-4 sm:grid-cols-[1fr_auto] sm:items-center">
              <div>
                <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-slate-700">
                  {selectedAlgo === "STATIC"
                    ? "STATIC TIMERS BASELINE"
                    : `${activeAlgoLabel.toUpperCase()} VS STATIC TIMERS`}
                </p>
                <p className="mt-1 text-xs font-semibold leading-relaxed text-slate-600">
                  Efficiency gain = (static avg wait − {activeAlgoLabel.toLowerCase()} avg wait) ÷ static avg wait × 100
                </p>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:min-w-[260px]">
                <div className={`rounded-xl border px-3 py-2.5 shadow-[0_8px_24px_rgba(16,185,129,0.12)] ${delaySavings === null || delaySavings >= 0 ? "border-emerald-300 bg-emerald-50" : "border-rose-300 bg-rose-50 shadow-[0_8px_24px_rgba(244,63,94,0.12)]"}`}>
                  <span className={`block text-[10px] font-bold uppercase tracking-wider ${delaySavings === null || delaySavings >= 0 ? "text-emerald-900" : "text-rose-900"}`}>
                    Delay saved / car
                  </span>
                  <span className={`mt-1 block font-sans text-xl font-black tabular-nums ${delaySavings === null || delaySavings >= 0 ? "text-emerald-800" : "text-rose-800"}`}>
                    {delaySavings === null ? "—" : `${delaySavings.toFixed(2)}s`}
                  </span>
                </div>
                <div className={`rounded-xl border px-3 py-2.5 shadow-[0_8px_24px_rgba(16,185,129,0.12)] ${efficiencyGain === null || efficiencyGain >= 0 ? "border-emerald-300 bg-emerald-50" : "border-rose-300 bg-rose-50 shadow-[0_8px_24px_rgba(244,63,94,0.12)]"}`}>
                  <span className={`block text-[10px] font-bold uppercase tracking-wider ${efficiencyGain === null || efficiencyGain >= 0 ? "text-emerald-900" : "text-rose-900"}`}>
                    Efficiency gain
                  </span>
                  <span className={`mt-1 block font-sans text-xl font-black tabular-nums ${efficiencyGain === null || efficiencyGain >= 0 ? "text-emerald-800" : "text-rose-800"}`}>
                    {efficiencyGain === null ? "—" : `${efficiencyGain.toFixed(1)}%`}
                  </span>
                </div>
              </div>
              {frozenBenchmark && frozenConclusion && (
                <div className="mt-4 rounded-xl border border-slate-300 bg-white p-4 shadow-[0_6px_20px_rgba(15,23,42,0.08)]">
                  <div className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-500">
                    Frozen performance conclusion
                  </div>
                  <p className="mt-2 text-sm font-semibold leading-relaxed text-slate-800">
                    {frozenConclusion}
                  </p>
                </div>
              )}
            </div>
            {delaySavings === null && (
              <p className="mt-2 text-right text-[11px] font-semibold text-slate-600">
                {selectedAlgo === "STATIC"
                  ? "Static is the selected baseline. Choose Round Robin or Priority + Dynamic Aging to compare efficiency."
                  : "Awaiting served vehicles in the static baseline and selected scheduler."}
              </p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
};

export default TrafficOSSimulator;