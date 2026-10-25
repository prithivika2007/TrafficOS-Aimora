import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  JUNCTIONS,
  ROAD_DEFINITIONS,
  JUNCTION_NAMES,
  AMBER_CLEARANCE_SECONDS,
  createNetworkState,
  completeExpiredSafetyFailSafes,
  inspectSignalSafety,
  networkMetrics,
  stepNetwork,
  triggerSafetyFailSafe,
} from "./networkEngine";
import type { JunctionId, NetworkAlgorithm, NetworkMode, NetworkState } from "./networkEngine";
import { createSim, defaultSetup } from "./simEngine";
import type { Sim } from "./simEngine";
import type { MutableRefObject } from "react";
import { addEvent as addStoredEvent, clearEvents, setEventSimTime } from "./eventStore";

export interface TelemetryPoint {
  time: number;
  independentWait: number;
  coordinatedWait: number;
  independentThroughput: number;
  coordinatedThroughput: number;
  independentQueue: number;
  coordinatedQueue: number;
  independentSpillbacks: number;
  coordinatedSpillbacks: number;
  independentTravel: number;
  coordinatedTravel: number;
  contextSwitches: number;
}

export interface TrafficEvent {
  id: string;
  tick: number;
  kind: "arrival" | "served" | "phase" | "spillback" | "roadblock" | "safety" | "preemption";
  message: string;
  junction: JunctionId;
}

export interface SafetyTelemetry {
  status: "ACTIVE" | "CONFLICT";
  mutexStatus: string;
  clearanceSeconds: number;
  violationAuditCount: number;
  inspectionCount: number;
  inspectedAt: number;
  logs: string[];
}

interface TrafficContextValue {
  states: Record<NetworkMode, NetworkState>;
  history: TelemetryPoint[];
  events: TrafficEvent[];
  running: boolean;
  mode: NetworkMode;
  setMode: (mode: NetworkMode) => void;
  algorithm: NetworkAlgorithm;
  setAlgorithm: (algorithm: NetworkAlgorithm) => void;
  start: () => void;
  pause: () => void;
  step: () => void;
  reset: () => void;
  setRoadBlock: (roadId: string, blocked: boolean) => void;
  triggerJunctionPreemption: (junction: JunctionId, coordinated: boolean) => void;
  safetyTelemetry: SafetyTelemetry;
  testConflictIntercept: () => void;
  singleIntersection: MutableRefObject<Sim>;
  simulationRevision: number;
  notifySimulationUpdate: () => void;
}

const TrafficContext = createContext<TrafficContextValue | null>(null);
const createPair = () => ({
  independent: createNetworkState(),
  coordinated: createNetworkState(),
});

const initialPoint = (): TelemetryPoint => ({
  time: 0,
  independentWait: 0,
  coordinatedWait: 0,
  independentThroughput: 0,
  coordinatedThroughput: 0,
  independentQueue: 0,
  coordinatedQueue: 0,
  independentSpillbacks: 0,
  coordinatedSpillbacks: 0,
  independentTravel: 0,
  coordinatedTravel: 0,
  contextSwitches: 0,
});

const initialSafetyTelemetry = (): SafetyTelemetry => ({
  status: "ACTIVE",
  mutexStatus: "LOCKED · ONE APPROACH",
  clearanceSeconds: 0,
  violationAuditCount: 0,
  inspectionCount: 0,
  inspectedAt: Date.now(),
  logs: [],
});

function eventsFor(previous: NetworkState, next: NetworkState): TrafficEvent[] {
  const output: TrafficEvent[] = [];
  JUNCTIONS.forEach((junction) => {
    const vehicleId = next.tick * 4 + JUNCTIONS.indexOf(junction);
    const found = Object.values(next.roads).some((vehicles) =>
      vehicles.some((vehicle) => vehicle.id === vehicleId)
    ) || next.demand[junction].some((vehicle) => vehicle.id === vehicleId);
    if (found) {
      output.push({
        id: `arrival-${next.tick}-${junction}`,
        tick: next.tick,
        kind: "arrival",
        message: `Vehicle arrival queued at ${JUNCTION_NAMES[junction]} (Junction ${junction})`,
        junction,
      });
    }
    if (previous.phases[junction] !== next.phases[junction]) {
      output.push({
        id: `phase-${next.tick}-${junction}`,
        tick: next.tick,
        kind: "phase",
        message: `Signal phase changed at ${JUNCTION_NAMES[junction]} (Junction ${junction})`,
        junction,
      });
    }
  });
  if (next.served > previous.served) {
    output.push({
      id: `served-${next.tick}`,
      tick: next.tick,
      kind: "served",
      message: `${next.served - previous.served} vehicle(s) exited the network`,
      junction: "D",
    });
  }
  next.spillbackEvents.slice(previous.spillbackEvents.length).forEach((incident) => {
    const road = ROAD_DEFINITIONS.find((item) => item.id === incident.roadId);
    if (road) output.push({
      id: `spillback-${incident.tick}-${incident.roadId}`,
      tick: incident.tick,
      kind: "spillback",
      message: `Downstream capacity reached on ${JUNCTION_NAMES[road.from]} → ${JUNCTION_NAMES[road.to]}`,
      junction: road.to,
    });
  });
  return output;
}

export function TrafficProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [states, setStates] = useState(createPair);
  const statesRef = useRef(states);
  const [history, setHistory] = useState<TelemetryPoint[]>([initialPoint()]);
  const [events, setEvents] = useState<TrafficEvent[]>([]);
  const [safetyTelemetry, setSafetyTelemetry] = useState(initialSafetyTelemetry);
  const [running, setRunning] = useState(false);
  const [mode, setMode] = useState<NetworkMode>("coordinated");
  const [algorithm, setAlgorithm] = useState<NetworkAlgorithm>("ROUND_ROBIN");
  const eventCounter = useRef(0);
  const singleIntersection = useRef<Sim>(createSim(defaultSetup(), "RR"));
  const [simulationRevision, setSimulationRevision] = useState(0);
  const notifySimulationUpdate = useCallback(
    () => setSimulationRevision((revision) => revision + 1),
    []
  );

  const step = useCallback(() => {
    const previous = statesRef.current;
    const independent = stepNetwork(previous.independent, "independent", algorithm);
    const coordinated = stepNetwork(previous.coordinated, "coordinated", algorithm);
    const next = { independent, coordinated };
    statesRef.current = next;
    setStates(next);
    setEventSimTime(coordinated.tick * 0.5);
    const independentMetrics = networkMetrics(independent);
    const coordinatedMetrics = networkMetrics(coordinated);
    const contextSwitches = JUNCTIONS.reduce(
      (sum, junction) =>
        sum + Number(previous.coordinated.phases[junction] !== coordinated.phases[junction]),
      0
    );
    setHistory((current) => [
      ...current.slice(-239),
      {
        time: independent.tick * 0.5,
        independentWait: independentMetrics.averageWait,
        coordinatedWait: coordinatedMetrics.averageWait,
        independentThroughput: independentMetrics.throughput,
        coordinatedThroughput: coordinatedMetrics.throughput,
        independentQueue: independentMetrics.maxQueue,
        coordinatedQueue: coordinatedMetrics.maxQueue,
        independentSpillbacks: independentMetrics.spillbacks,
        coordinatedSpillbacks: coordinatedMetrics.spillbacks,
        independentTravel: independentMetrics.travelTime,
        coordinatedTravel: coordinatedMetrics.travelTime,
        contextSwitches,
      },
    ]);
    const addedEvents = [
      ...eventsFor(previous.coordinated, coordinated),
      ...eventsFor(previous.independent, independent).filter((event) => event.kind === "spillback"),
    ].map((event) => ({ ...event, id: `${event.id}-${eventCounter.current++}` }));
    if (addedEvents.length) {
      addedEvents.forEach((event) => {
        if (event.kind === "phase") {
          addStoredEvent({
            type: "SIGNAL",
            severity: "info",
            message: `${JUNCTION_NAMES[event.junction]}: Phase switch`,
          });
        } else if (event.kind === "spillback") {
          addStoredEvent({
            type: "ACCIDENT",
            severity: "warn",
            lane: event.message,
            message: event.message,
          });
        }
      });
      setEvents((current) => [...addedEvents, ...current].slice(0, 30));
    }
  }, [algorithm]);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(step, 500);
    return () => window.clearInterval(timer);
  }, [running, step]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const previous = statesRef.current;
      const independent = completeExpiredSafetyFailSafes(previous.independent);
      const coordinated = completeExpiredSafetyFailSafes(previous.coordinated);
      const next = independent === previous.independent && coordinated === previous.coordinated
        ? previous
        : { independent, coordinated };
      if (next !== previous) {
        statesRef.current = next;
        setStates(next);
      }
      const activeState = next[mode];
      const inspection = inspectSignalSafety(activeState);
      const clearanceSeconds = Math.max(
        ...JUNCTIONS.map((junction) => {
          const safety = activeState.signalSafety[junction];
          return safety.failSafeUntil === null
            ? safety.clearanceTicks * 0.5
            : Math.max(0, (safety.failSafeUntil - Date.now()) / 1000);
        })
      );
      const allRedJunctions = JUNCTIONS.filter(
        (junction) => activeState.signalSafety[junction].mode === "ALL_RED"
      ).length;
      setSafetyTelemetry((current) => ({
        status: inspection.clear ? "ACTIVE" : "CONFLICT",
        mutexStatus: allRedJunctions
          ? `FAIL-SAFE · ${allRedJunctions} ALL-RED`
          : "LOCKED · ONE APPROACH",
        clearanceSeconds,
        violationAuditCount: JUNCTIONS.reduce(
          (count, junction) => count + activeState.signalSafety[junction].violationAuditCount,
          0
        ),
        inspectionCount: current.inspectionCount + 1,
        inspectedAt: Date.now(),
        logs: inspection.clear
          ? inspection.logs
          : [...inspection.conflicts, ...inspection.logs],
      }));
    }, 100);
    return () => window.clearInterval(timer);
  }, [mode]);

  const start = useCallback(() => setRunning(true), []);
  const pause = useCallback(() => setRunning(false), []);
  const reset = useCallback(() => {
    setRunning(false);
    const initial = createPair();
    statesRef.current = initial;
    setStates(initial);
    setHistory([initialPoint()]);
    setEvents([]);
    clearEvents();
    setEventSimTime(0);
    setSafetyTelemetry(initialSafetyTelemetry());
    eventCounter.current = 0;
    singleIntersection.current = createSim(defaultSetup(), "RR");
    setSimulationRevision((revision) => revision + 1);
  }, []);
  const testConflictIntercept = useCallback(() => {
    const junction: JunctionId = "A";
    const previous = statesRef.current;
    const next = {
      independent: triggerSafetyFailSafe(previous.independent, junction),
      coordinated: triggerSafetyFailSafe(previous.coordinated, junction),
    };
    statesRef.current = next;
    setStates(next);
    const violationAuditCount = JUNCTIONS.reduce(
      (count, node) => count + next[mode].signalSafety[node].violationAuditCount,
      0
    );
    setSafetyTelemetry((current) => ({
      ...current,
      status: "CONFLICT",
      mutexStatus: "FAIL-SAFE · 1 ALL-RED",
      clearanceSeconds: AMBER_CLEARANCE_SECONDS,
      violationAuditCount,
      inspectedAt: Date.now(),
      logs: [`${JUNCTION_NAMES[junction]}: illegal conflicting-green request intercepted; all-red fail-safe engaged.`],
    }));
    setEventSimTime(previous[mode].tick * 0.5);
    addStoredEvent({
      type: "SAFETY",
      severity: "critical",
      message: `⚠️ Safety Guardian intercepted illegal signal conflict at ${JUNCTION_NAMES[junction]} (Junction ${junction})`,
    });
    const event: TrafficEvent = {
      id: `safety-test-${eventCounter.current++}`,
      tick: previous[mode].tick,
      kind: "safety",
      message: `SAFETY VIOLATION DETECTED — FAILSAFE ENGAGED · ${JUNCTION_NAMES[junction]} (Junction ${junction})`,
      junction,
    };
    setEvents((current) => [event, ...current].slice(0, 30));
  }, [mode]);

  const setRoadBlock = useCallback((roadId: string, blocked: boolean) => {
    const road = ROAD_DEFINITIONS.find((item) => item.id === roadId);
    if (!road) throw new Error(`Unknown road link: ${roadId}`);
    const previous = statesRef.current;
    if (
      previous.independent.roadBlocks[roadId] === blocked &&
      previous.coordinated.roadBlocks[roadId] === blocked
    ) return;
    const update = (state: NetworkState): NetworkState => ({
      ...state,
      roadBlocks: { ...state.roadBlocks, [roadId]: blocked },
      links: {
        ...state.links,
        [roadId]: { ...state.links[roadId], blocked },
      },
    });
    const next = {
      independent: update(previous.independent),
      coordinated: update(previous.coordinated),
    };
    statesRef.current = next;
    setStates(next);
    const message = blocked
      ? `🚧 Roadblock injected: Lane ${JUNCTION_NAMES[road.from]} → ${JUNCTION_NAMES[road.to]} closed. Rerouting active traffic.`
      : `✅ Roadblock cleared: Lane ${JUNCTION_NAMES[road.from]} → ${JUNCTION_NAMES[road.to]} reopened.`;
    setEventSimTime(previous[mode].tick * 0.5);
    addStoredEvent({
      type: blocked ? "ACCIDENT" : "SIGNAL",
      severity: blocked ? "warn" : "info",
      lane: `${JUNCTION_NAMES[road.from]} → ${JUNCTION_NAMES[road.to]}`,
      message,
    });
    const event: TrafficEvent = {
      id: `roadblock-${roadId}-${blocked ? "active" : "cleared"}-${eventCounter.current++}`,
      tick: previous[mode].tick,
      kind: "roadblock",
      message,
      junction: road.to,
    };
    setEvents((current) => [event, ...current].slice(0, 30));
  }, [mode]);

  const triggerJunctionPreemption = useCallback((junction: JunctionId, coordinated: boolean) => {
    const approachByJunction: Record<JunctionId, string> = {
      A: "BA",
      B: "AB",
      C: "AC",
      D: "CD",
    };
    const targetApproach = approachByJunction[junction];
    const previous = statesRef.current;
    const update = (state: NetworkState): NetworkState => {
      if (state.signalSafety[junction].mode === "ALL_RED") return state;
      const incoming = ROAD_DEFINITIONS.filter((road) => road.to === junction);
      const phase = Math.max(0, incoming.findIndex((road) => road.id === targetApproach));
      return {
        ...state,
        phases: { ...state.phases, [junction]: phase },
        phaseTicks: { ...state.phaseTicks, [junction]: 0 },
      };
    };
    const independent = update(previous.independent);
    const coordinatedState = update(previous.coordinated);
    const next = independent === previous.independent && coordinatedState === previous.coordinated
      ? previous
      : { independent, coordinated: coordinatedState };
    if (next !== previous) {
      statesRef.current = next;
      setStates(next);
    }
    const message = coordinated
      ? `Green-wave synchronized at ${JUNCTION_NAMES[junction]} (Junction ${junction})`
      : `ISR preemption lock granted at ${JUNCTION_NAMES[junction]} (Junction ${junction})`;
    setEventSimTime(previous[mode].tick * 0.5);
    addStoredEvent({
      type: "EMERGENCY",
      severity: coordinated ? "info" : "critical",
      message,
    });
    const event: TrafficEvent = {
      id: `preemption-${junction}-${eventCounter.current++}`,
      tick: previous[mode].tick,
      kind: "preemption",
      message,
      junction,
    };
    setEvents((current) => [event, ...current].slice(0, 30));
  }, [mode]);

  const value = useMemo<TrafficContextValue>(
    () => ({
      states,
      history,
      events,
      running,
      mode,
      setMode,
      algorithm,
      setAlgorithm,
      start,
      pause,
      step,
      reset,
      setRoadBlock,
      triggerJunctionPreemption,
      safetyTelemetry,
      testConflictIntercept,
      singleIntersection,
      simulationRevision,
      notifySimulationUpdate,
    }),
    [states, history, events, running, mode, algorithm, start, pause, step, reset, setRoadBlock, triggerJunctionPreemption, safetyTelemetry, testConflictIntercept, simulationRevision, notifySimulationUpdate]
  );
  return <TrafficContext.Provider value={value}>{children}</TrafficContext.Provider>;
}

export function useTraffic(): TrafficContextValue {
  const value = useContext(TrafficContext);
  if (!value) throw new Error("useTraffic must be used within TrafficProvider");
  return value;
}
