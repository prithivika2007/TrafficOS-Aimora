import React, { useState, useEffect, useRef, useSyncExternalStore } from "react";
import type { MutableRefObject } from "react";
import {
  Algo,
  STOP_LINE,
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
  addEmergencyVehicle,
  addRogueVehicle,
  applyRoadPlan,
  checkSimulationWatchdog,
  clearRoadIncident,
  setSimulationDataStale,
  triggerRoadIncident,
} from "./simEngine";
import type { IncidentType } from "./simEngine";
import type { EChallan } from "./eChallan";
import {
  STARVATION_LIMIT_SECONDS,
  WATCHDOG_POLL_INTERVAL_MS,
} from "./safetyLayer";
import { addEvent, getEvents, setEventSimTime, subscribeToEvents } from "./eventStore";
import type { EventType } from "./eventStore";
import AmbulanceLabPanel from "./components/AmbulanceLabPanel";
import type { AmbulanceScenario } from "./components/AmbulanceLabPanel";

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
  NORTH: "#EC4899",
  EAST: "#3B82F6",
  SOUTH: "#8B5CF6",
  WEST: "#F59E0B",
};
const LANE_SHORT: Record<Direction, string> = { NORTH: "N", EAST: "E", SOUTH: "S", WEST: "W" };

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
type ScenarioMode = "NORMAL" | "HEATMAP" | "ACCIDENT";
type HeatLevel = "FREE" | "MODERATE" | "HEAVY";
type IncidentDuration = "30" | "60" | "120" | "UNTIL_CLEARED";
interface HeatLane {
  score: number;
  samples: number[];
}

const heatLevel = (score: number): HeatLevel =>
  score < 40 ? "FREE" : score < 70 ? "MODERATE" : "HEAVY";
const HEAT_COLORS: Record<HeatLevel, string> = {
  FREE: "#22c55e",
  MODERATE: "#f59e0b",
  HEAVY: "#ef4444",
};

const HeatSparkline: React.FC<{ values: number[]; color: string }> = ({
  values,
  color,
}) => {
  const points = values
    .map((value, index) => {
      const x = values.length > 1 ? (index / (values.length - 1)) * 100 : 100;
      const y = 28 - (Math.min(100, value) / 100) * 25;
      return `${x},${y}`;
    })
    .join(" ");
  return (
    <svg viewBox="0 0 100 30" role="img" aria-label="Congestion over the last 60 simulation seconds" className="h-7 w-24">
      <polyline points={points} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
};

interface RenderVehicle {
  id: string;
  lane: Direction;
  progress: number;
  sourceProgress: number;
  speed: number;
  width: number;
  length: number;
  color: string;
  kind: "sedan" | "suv" | "bus" | "ambulance";
}

interface SimulationCanvasState {
  snap: Snapshot;
  scenarioMode: ScenarioMode;
  heatmap: Record<Direction, HeatLane>;
}

const VEHICLE_GAP_PX = 14;
const VEHICLE_SHAPES = [
  { width: 14, length: 24, kind: "sedan" as const },
  { width: 16, length: 28, kind: "suv" as const },
  { width: 18, length: 40, kind: "bus" as const },
];

const TrafficSimulationCanvas: React.FC<SimulationCanvasState> = ({
  snap,
  scenarioMode,
  heatmap,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef({ snap, scenarioMode, heatmap });
  useEffect(() => {
    stateRef.current = { snap, scenarioMode, heatmap };
  }, [snap, scenarioMode, heatmap]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    const vehicles = new Map<string, RenderVehicle>();
    let frameId = 0;
    let previousFrame = 0;

    const render = (timestamp: number) => {
      const delta = previousFrame ? Math.min((timestamp - previousFrame) / 1000, 0.05) : 1 / 60;
      previousFrame = timestamp;
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

      const current = stateRef.current;
      const simulation = current.snap;
      const centerX = width / 2;
      const centerY = height / 2;
      const roadWidth = Math.min(112, Math.min(width, height) * 0.36);
      const halfRoad = roadWidth / 2;

      drawSimulationRoad(context, width, height, centerX, centerY, roadWidth);
      if (current.scenarioMode === "HEATMAP") {
        drawHeatOverlay(context, width, height, centerX, centerY, roadWidth, current.heatmap);
      }

      const activeVehicles = new Set<string>();
      const lanes = new Map<Direction, RenderVehicle[]>(DIRECTIONS.map((lane) => [lane, []]));
      simulation.cars.forEach((car) => {
        const id = `car-${car.id}`;
        activeVehicles.add(id);
        let vehicle = vehicles.get(id);
        if (!vehicle) {
          const shape = VEHICLE_SHAPES[Math.abs(car.id) % VEHICLE_SHAPES.length];
          vehicle = {
            id,
            lane: car.lane,
            progress: simulationProgressToDistance(car.lane, car.progress, width, height, halfRoad, shape.length),
            sourceProgress: car.progress,
            speed: 0,
            ...shape,
            color: LANE_COLOR[car.lane],
          };
          vehicles.set(id, vehicle);
        }
        vehicle.lane = car.lane;
        vehicle.sourceProgress = car.progress;
        if (car.emergency) vehicle.kind = "ambulance";
        (lanes.get(car.lane) ?? []).push(vehicle);
      });

      simulation.emergencyVehicles
        .filter((vehicle) => vehicle.status !== "CLEARED" && vehicle.position < 100)
        .forEach((ambulance, index) => {
          const id = `ambulance-${ambulance.id}`;
          activeVehicles.add(id);
          let vehicle = vehicles.get(id);
          if (!vehicle) {
            vehicle = {
              id,
              lane: ambulance.lane,
              progress: simulationProgressToDistance(ambulance.lane, ambulance.position, width, height, halfRoad, 40),
              sourceProgress: ambulance.position,
              speed: 0,
              width: 18,
              length: 40,
              color: "#f8fafc",
              kind: "ambulance",
            };
            vehicles.set(id, vehicle);
          }
          vehicle.lane = ambulance.lane;
          vehicle.sourceProgress = ambulance.position;
          vehicle.kind = "ambulance";
          vehicle.width = 18;
          vehicle.length = 40;
          (lanes.get(ambulance.lane) ?? []).push(vehicle);
        });

      vehicles.forEach((vehicle, id) => {
        if (!activeVehicles.has(id)) vehicles.delete(id);
      });

      DIRECTIONS.forEach((lane) => {
        const laneVehicles = lanes.get(lane) ?? [];
        laneVehicles.sort((first, second) => second.sourceProgress - first.sourceProgress);

        let leader: RenderVehicle | undefined;
        laneVehicles.forEach((vehicle) => {
          let target = simulationProgressToDistance(
            lane,
            vehicle.sourceProgress,
            width,
            height,
            halfRoad,
            vehicle.length
          );
          if (leader) {
            target = Math.min(target, leader.progress - (leader.length + vehicle.length) / 2 - VEHICLE_GAP_PX);
          }
          const difference = target - vehicle.progress;
          const targetSpeed = Math.sign(difference) * Math.min(96, Math.sqrt(Math.abs(difference) * 2 * 180));
          const speedChange = Math.max(-200 * delta, Math.min(200 * delta, targetSpeed - vehicle.speed));
          vehicle.speed += speedChange;
          let nextProgress = vehicle.progress + vehicle.speed * delta;
          if ((target - vehicle.progress) * (target - nextProgress) <= 0) {
            nextProgress = target;
            vehicle.speed = 0;
          }
          vehicle.progress = nextProgress;
          if (leader && vehicle.progress > leader.progress - (leader.length + vehicle.length) / 2 - VEHICLE_GAP_PX) {
            vehicle.progress = leader.progress - (leader.length + vehicle.length) / 2 - VEHICLE_GAP_PX;
            vehicle.speed = Math.min(0, vehicle.speed);
          }
          leader = vehicle;
        });
      });

      drawSimulationSignals(context, simulation, centerX, centerY, halfRoad);
      if (current.scenarioMode === "ACCIDENT" && simulation.incident) {
        drawRoadIncident(context, simulation.incident.lane, centerX, centerY, halfRoad);
      }
      vehicles.forEach((vehicle) => {
        const position = simulationVehiclePosition(vehicle, width, height);
        drawSimulationVehicle(context, position.x, position.y, vehicle, timestamp);
      });
      frameId = window.requestAnimationFrame(render);
    };

    frameId = window.requestAnimationFrame(render);
    return () => window.cancelAnimationFrame(frameId);
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 h-full w-full"
      role="img"
      aria-label="Live four-way traffic simulation with asphalt roads, lane markings, vehicles, signals, and emergency sirens"
    />
  );
};

function drawSimulationRoad(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  centerX: number,
  centerY: number,
  roadWidth: number
): void {
  const halfRoad = roadWidth / 2;
  context.fillStyle = "#1E293B";
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#0F172A";
  context.fillRect(centerX - halfRoad, 0, roadWidth, height);
  context.fillRect(0, centerY - halfRoad, width, roadWidth);

  context.save();
  context.globalAlpha = 0.12;
  context.fillStyle = "#94A3B8";
  for (let y = 7; y < height; y += 17) {
    for (let x = 5 + (y % 11); x < width; x += 23) {
      context.fillRect(x, y, 1.2, 1.2);
    }
  }
  context.restore();

  context.strokeStyle = "rgba(226,232,240,0.82)";
  context.lineWidth = 1.6;
  context.setLineDash([11, 10]);
  context.beginPath();
  context.moveTo(centerX, 0);
  context.lineTo(centerX, centerY - halfRoad - 30);
  context.moveTo(centerX, centerY + halfRoad + 30);
  context.lineTo(centerX, height);
  context.moveTo(0, centerY);
  context.lineTo(centerX - halfRoad - 30, centerY);
  context.moveTo(centerX + halfRoad + 30, centerY);
  context.lineTo(width, centerY);
  context.stroke();
  context.setLineDash([]);

  drawZebraCrossing(context, centerX - halfRoad - 27, centerY, roadWidth, true);
  drawZebraCrossing(context, centerX + halfRoad + 27, centerY, roadWidth, true);
  drawZebraCrossing(context, centerX, centerY - halfRoad - 27, roadWidth, false);
  drawZebraCrossing(context, centerX, centerY + halfRoad + 27, roadWidth, false);

  context.strokeStyle = "#F8FAFC";
  context.lineWidth = 3;
  context.beginPath();
  context.moveTo(centerX - halfRoad, centerY - halfRoad - 10);
  context.lineTo(centerX, centerY - halfRoad - 10);
  context.moveTo(centerX, centerY + halfRoad + 10);
  context.lineTo(centerX + halfRoad, centerY + halfRoad + 10);
  context.moveTo(centerX + halfRoad + 10, centerY - halfRoad);
  context.lineTo(centerX + halfRoad + 10, centerY);
  context.moveTo(centerX - halfRoad - 10, centerY);
  context.lineTo(centerX - halfRoad - 10, centerY + halfRoad);
  context.stroke();

  context.save();
  context.strokeStyle = "rgba(248,250,252,0.42)";
  context.lineWidth = 1.5;
  context.setLineDash([6, 7]);
  context.beginPath();
  context.moveTo(centerX - 17, centerY - 10);
  context.quadraticCurveTo(centerX - 17, centerY - 2, centerX - 8, centerY + 8);
  context.moveTo(centerX + 17, centerY + 10);
  context.quadraticCurveTo(centerX + 17, centerY + 2, centerX + 8, centerY - 8);
  context.moveTo(centerX - 10, centerY - 17);
  context.quadraticCurveTo(centerX - 2, centerY - 17, centerX + 8, centerY - 8);
  context.moveTo(centerX + 10, centerY + 17);
  context.quadraticCurveTo(centerX + 2, centerY + 17, centerX - 8, centerY + 8);
  context.stroke();
  context.restore();
}

function drawZebraCrossing(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  roadWidth: number,
  horizontal: boolean
): void {
  context.fillStyle = "rgba(248,250,252,0.92)";
  for (let stripe = -3; stripe <= 3; stripe++) {
    if (horizontal) context.fillRect(x - 3, y + stripe * 6, roadWidth + 6, 3);
    else context.fillRect(x + stripe * 6, y - 3, 3, roadWidth + 6);
  }
}

function drawHeatOverlay(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  centerX: number,
  centerY: number,
  roadWidth: number,
  heatmap: Record<Direction, HeatLane>
): void {
  const halfRoad = roadWidth / 2;
  DIRECTIONS.forEach((lane) => {
    const color = HEAT_COLORS[heatLevel(heatmap[lane].score)];
    context.save();
    context.globalAlpha = 0.28;
    const gradient = context.createLinearGradient(
      lane === "NORTH" || lane === "SOUTH" ? centerX : lane === "WEST" ? 0 : width,
      lane === "EAST" || lane === "WEST" ? centerY : lane === "NORTH" ? 0 : height,
      centerX,
      centerY
    );
    gradient.addColorStop(0, `${color}00`);
    gradient.addColorStop(1, color);
    context.fillStyle = gradient;
    if (lane === "NORTH") context.fillRect(centerX - halfRoad, 0, roadWidth, centerY - halfRoad);
    else if (lane === "SOUTH") context.fillRect(centerX - halfRoad, centerY + halfRoad, roadWidth, height);
    else if (lane === "WEST") context.fillRect(0, centerY - halfRoad, centerX - halfRoad, roadWidth);
    else context.fillRect(centerX + halfRoad, centerY - halfRoad, width, roadWidth);
    context.restore();
  });
}

function simulationProgressToDistance(
  lane: Direction,
  progress: number,
  width: number,
  height: number,
  halfRoad: number,
  vehicleLength: number
): number {
  const vertical = lane === "NORTH" || lane === "SOUTH";
  const axisLength = (vertical ? height : width) * 0.9;
  const entryDistance = (vertical ? height : width) * 0.05;
  const stopDistanceFromOrigin = lane === "NORTH"
    ? height / 2 - halfRoad - 10 - vehicleLength / 2 - entryDistance
    : lane === "SOUTH"
    ? height * 0.95 - (height / 2 + halfRoad + 10 + vehicleLength / 2)
    : lane === "EAST"
    ? width * 0.95 - (width / 2 + halfRoad + 10 + vehicleLength / 2)
    : width / 2 - halfRoad - 10 - vehicleLength / 2 - entryDistance;
  const stopDistance = Math.max(0, Math.min(axisLength, stopDistanceFromOrigin));
  const stopProgress = STOP_LINE[lane];
  const clampedProgress = Math.max(0, Math.min(100, progress));
  if (clampedProgress <= stopProgress) {
    return (clampedProgress / stopProgress) * stopDistance;
  }
  return stopDistance +
    ((clampedProgress - stopProgress) / (100 - stopProgress)) *
    (axisLength - stopDistance);
}

function drawSimulationSignals(
  context: CanvasRenderingContext2D,
  snap: Snapshot,
  centerX: number,
  centerY: number,
  halfRoad: number
): void {
  const colors: Record<Direction, string> = {
    NORTH: "#ef4444",
    EAST: "#ef4444",
    SOUTH: "#ef4444",
    WEST: "#ef4444",
  };
  DIRECTIONS.forEach((lane) => {
    if (snap.emergencyState !== "IDLE") {
      if (snap.emergencyState === "CLEARING_TO_EMERGENCY" && snap.signalPhase === "YELLOW" && snap.lastLane === lane) {
        colors[lane] = "#f59e0b";
      } else if (snap.emergencyState === "ACTIVE" && snap.active === lane) {
        colors[lane] = "#22c55e";
      }
    } else if (snap.signalPhase === "GREEN" && snap.active === lane) {
      colors[lane] = "#22c55e";
    } else if (snap.signalPhase === "YELLOW" && snap.lastLane === lane) {
      colors[lane] = "#f59e0b";
    }
  });

  const lights: Record<Direction, [number, number]> = {
    NORTH: [centerX - halfRoad - 15, centerY - halfRoad - 12],
    SOUTH: [centerX + halfRoad + 15, centerY + halfRoad + 12],
    EAST: [centerX + halfRoad + 12, centerY - halfRoad - 15],
    WEST: [centerX - halfRoad - 12, centerY + halfRoad + 15],
  };
  DIRECTIONS.forEach((lane) => {
    const [x, y] = lights[lane];
    context.fillStyle = "#020617";
    context.beginPath();
    context.roundRect(x - 6, y - 6, 12, 12, 4);
    context.fill();
    context.fillStyle = colors[lane];
    context.shadowColor = colors[lane];
    context.shadowBlur = 10;
    context.beginPath();
    context.arc(x, y, 3.3, 0, Math.PI * 2);
    context.fill();
    context.shadowBlur = 0;
  });
}

function simulationVehiclePosition(
  vehicle: RenderVehicle,
  width: number,
  height: number
): { x: number; y: number } {
  switch (vehicle.lane) {
    case "NORTH":
      return { x: width / 2 - 22, y: height * 0.05 + vehicle.progress };
    case "SOUTH":
      return { x: width / 2 + 22, y: height * 0.95 - vehicle.progress };
    case "EAST":
      return { x: width * 0.95 - vehicle.progress, y: height / 2 - 22 };
    case "WEST":
      return { x: width * 0.05 + vehicle.progress, y: height / 2 + 22 };
  }
}

function drawSimulationVehicle(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  vehicle: RenderVehicle,
  timestamp: number
): void {
  const rotation: Record<Direction, number> = { NORTH: Math.PI, EAST: -Math.PI / 2, SOUTH: 0, WEST: Math.PI / 2 };
  context.save();
  context.translate(x, y);
  context.rotate(rotation[vehicle.lane]);
  const halfWidth = vehicle.width / 2;
  const halfLength = vehicle.length / 2;

  if (vehicle.kind === "ambulance") {
    const pulse = 0.5 + (Math.sin(timestamp / 100) + 1) * 0.25;
    context.save();
    context.globalAlpha = pulse;
    context.strokeStyle = timestamp % 500 < 250 ? "#ef4444" : "#3b82f6";
    context.lineWidth = 2;
    context.shadowColor = context.strokeStyle;
    context.shadowBlur = 14;
    context.beginPath();
    context.ellipse(0, 0, halfWidth + 7, halfLength + 7, 0, 0, Math.PI * 2);
    context.stroke();
    context.restore();
  }

  context.shadowColor = vehicle.kind === "ambulance" ? "rgba(248,250,252,0.85)" : `${vehicle.color}99`;
  context.shadowBlur = vehicle.kind === "ambulance" ? 9 : 5;
  context.fillStyle = vehicle.kind === "ambulance" ? "#f8fafc" : vehicle.color;
  context.strokeStyle = vehicle.kind === "ambulance" ? "#fee2e2" : "#0f172a";
  context.lineWidth = 1.5;
  context.beginPath();
  context.roundRect(-halfWidth, -halfLength, vehicle.width, vehicle.length, 4);
  context.fill();
  context.stroke();
  context.shadowBlur = 0;

  context.fillStyle = vehicle.kind === "ambulance" ? "#bfdbfe" : "#0f172a";
  context.globalAlpha = vehicle.kind === "ambulance" ? 0.9 : 0.82;
  context.beginPath();
  context.roundRect(-halfWidth + 2.5, -halfLength + 4, vehicle.width - 5, Math.max(7, vehicle.length * 0.25), 2);
  context.fill();
  context.globalAlpha = 1;

  if (vehicle.kind === "ambulance") {
    context.fillStyle = "#dc2626";
    context.fillRect(-1.7, -4, 3.4, 11);
    context.fillRect(-5.5, -0.2, 11, 3.4);
    context.fillRect(-halfWidth + 1, halfLength - 8, vehicle.width - 2, 2.5);
    context.fillStyle = timestamp % 500 < 250 ? "#ef4444" : "#2563eb";
    context.shadowColor = context.fillStyle;
    context.shadowBlur = 8;
    context.fillRect(-5, -halfLength + 1, 4.5, 2.5);
    context.fillStyle = timestamp % 500 < 250 ? "#2563eb" : "#ef4444";
    context.fillRect(0.5, -halfLength + 1, 4.5, 2.5);
    context.shadowBlur = 0;
  } else {
    context.fillStyle = "#f8fafc";
    context.globalAlpha = 0.76;
    context.fillRect(-halfWidth + 2, halfLength - 7, vehicle.width - 4, 1.5);
    context.globalAlpha = 1;
  }

  context.restore();
}

function drawRoadIncident(
  context: CanvasRenderingContext2D,
  lane: Direction,
  centerX: number,
  centerY: number,
  halfRoad: number
): void {
  const marker: Record<Direction, [number, number]> = {
    NORTH: [centerX - 22, centerY - halfRoad - 14],
    SOUTH: [centerX + 22, centerY + halfRoad + 14],
    EAST: [centerX + halfRoad + 14, centerY - 22],
    WEST: [centerX - halfRoad - 14, centerY + 22],
  };
  const [x, y] = marker[lane];
  context.save();
  context.translate(x, y);
  context.rotate(-Math.PI / 4);
  context.fillStyle = "#f59e0b";
  context.strokeStyle = "#fff7ed";
  context.lineWidth = 2;
  context.shadowColor = "#ef4444";
  context.shadowBlur = 14;
  context.fillRect(-11, -11, 22, 22);
  context.strokeRect(-11, -11, 22, 22);
  context.shadowBlur = 0;
  context.fillStyle = "#7f1d1d";
  context.fillRect(-2, -8, 4, 16);
  context.fillRect(-8, -2, 16, 4);
  context.restore();
}

interface BenchmarkReading {
  algo: BenchmarkAlgo;
  avgWait: number;
  served: number;
  contextSwitches: number;
  throughput: number;
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
    STATIC: createSim(setup, "STATIC", emergencyLane, false),
  };
  if (activeAlgo !== "STATIC") {
    sims[activeAlgo] = createSim(
      setup,
      activeAlgo,
      activeAlgo === "PRIORITY_AGING" ? emergencyLane : null,
      false
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
  const [scenarioMode, setScenarioMode] = useState<ScenarioMode>("NORMAL");
  const [incidentLane, setIncidentLane] = useState<Direction>("NORTH");
  const [incidentType, setIncidentType] = useState<IncidentType>("ACCIDENT");
  const [incidentDuration, setIncidentDuration] = useState<IncidentDuration>("30");
  const [planIgnored, setPlanIgnored] = useState(false);
  const [eventFilter, setEventFilter] = useState<EventType | "ALL">("ALL");
  const [autoScrollEvents, setAutoScrollEvents] = useState(true);
  const [setup, setSetup] = useState<Setup>(() => presetSetup(initialAlgo));
  const [emergencyLane, setEmergencyLane] = useState<Direction | null>(null);
  const [dashboardTab, setDashboardTab] = useState<DashboardTab>("SAFETY");
  const [selectedChallan, setSelectedChallan] = useState<EChallan | null>(null);
  const [ambulanceScenario, setAmbulanceScenario] = useState<AmbulanceScenario>("IDLE");
  const repeatedArrivalLaneRef = useRef(0);

  const localSimRef = useRef<Sim>(createSim(setup, selectedAlgo, emergencyLane));
  const simRef = simulationRef ?? localSimRef;
  const benchmarkSimsRef = useRef<Partial<Record<BenchmarkAlgo, Sim>>>(
    createBenchmarkSims(setup, selectedAlgo, emergencyLane)
  );
  const [snap, setSnap] = useState<Snapshot>(() => snapshot(simRef.current));
  const [running, setRunning] = useState<boolean>(false);
  const [stopped, setStopped] = useState<boolean>(false);
  const [frozenBenchmark, setFrozenBenchmark] = useState<FrozenBenchmark | null>(null);
  const [reportActionError, setReportActionError] = useState<string | null>(null);
  const [reportActionNotice, setReportActionNotice] = useState<string | null>(null);
  const [heatmap, setHeatmap] = useState<Record<Direction, HeatLane>>({
    NORTH: { score: 0, samples: [] },
    EAST: { score: 0, samples: [] },
    SOUTH: { score: 0, samples: [] },
    WEST: { score: 0, samples: [] },
  });
  const events = useSyncExternalStore(subscribeToEvents, getEvents, getEvents);
  const eventScrollRef = useRef<HTMLDivElement>(null);
  const snapRef = useRef(snap);
  const lastHeatSampleRef = useRef(-1);
  snapRef.current = snap;
  const benchmarkFrozenRef = useRef(false);

  useEffect(() => {
    if (ambulanceScenario !== "REPEATED" || !running) return;
    const lanes: Direction[] = ["EAST", "WEST", "NORTH", "SOUTH"];
    const timer = window.setInterval(() => {
      if (benchmarkFrozenRef.current || simRef.current.finished) return;
      const lane = lanes[repeatedArrivalLaneRef.current % lanes.length];
      repeatedArrivalLaneRef.current += 1;
      if (addEmergencyVehicle(simRef.current, lane)) {
        setSnap(snapshot(simRef.current));
      }
    }, 5000);
    return () => window.clearInterval(timer);
  }, [ambulanceScenario, running, simRef]);

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
    if (!autoScrollEvents || !eventScrollRef.current) return;
    eventScrollRef.current.scrollTop = eventScrollRef.current.scrollHeight;
  }, [events, eventFilter, autoScrollEvents]);

  useEffect(() => {
    const sampleHeatmap = () => {
      const current = snapRef.current;
      const sampleSecond = Math.floor(current.clock);
      const clockReset = sampleSecond < lastHeatSampleRef.current;
      if (clockReset) lastHeatSampleRef.current = -1;
      const elapsedSeconds = sampleSecond - lastHeatSampleRef.current;
      if (elapsedSeconds <= 0) return;
      lastHeatSampleRef.current = sampleSecond;
      setHeatmap((previous) => {
        const next = { ...previous };
        DIRECTIONS.forEach((lane) => {
          const queue = current.queued[lane];
          const capacity = MAX_PER_LANE;
          const stopped = current.cars.filter(
            (car) => car.lane === lane && !car.released
          ).length;
          const queueRatio = Math.min(1, queue / capacity);
          const raw = Math.min(
            100,
            queueRatio * 60 +
              Math.min(
                1,
                current.avgWaitByLane[lane] / STARVATION_LIMIT_SECONDS
              ) * 30 +
              Math.min(1, stopped / capacity) * 10
          );
          const previousLane = clockReset
            ? { score: 0, samples: [] }
            : previous[lane];
          let score =
            previousLane.samples.length === 0 ? raw : previousLane.score;
          const samples = [...previousLane.samples];
          for (
            let second = 0;
            second < Math.min(elapsedSeconds, 60);
            second++
          ) {
            score =
              previousLane.samples.length === 0 && second === 0
                ? raw
                : score * 0.75 + raw * 0.25;
            samples.push(score);
          }
          next[lane] = {
            score,
            samples: samples.slice(-60),
          };
        });
        return next;
      });
    };
    sampleHeatmap();
    const timer = window.setInterval(sampleHeatmap, 250);
    return () => window.clearInterval(timer);
  }, []);

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
          throughput: elapsed > 0 ? (benchmarkSim.served / elapsed) * 60 : 0,
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
    setReportActionError(null);
    setReportActionNotice(null);
    setStopped(false);
  };

  const exportFrozenReport = (format: "json" | "csv") => {
    if (!frozenBenchmark) return;
    const report = {
      freezeTimeSeconds: frozenBenchmark.elapsed,
      activeAlgorithm: selectedAlgo,
      activeAlgorithmLabel: activeAlgoLabel,
      status: frozenBenchmark.status,
      staticTimers: frozenStaticBenchmark
        ? {
            averageWaitSeconds: frozenStaticBenchmark.avgWait,
            vehiclesServed: frozenStaticBenchmark.served,
            throughputVehiclesPerMinute: frozenStaticBenchmark.throughput,
            contextSwitches: frozenStaticBenchmark.contextSwitches,
          }
        : null,
      activeScheduler: frozenActiveBenchmark
        ? {
            averageWaitSeconds: frozenActiveBenchmark.avgWait,
            vehiclesServed: frozenActiveBenchmark.served,
            throughputVehiclesPerMinute: frozenActiveBenchmark.throughput,
            contextSwitches: frozenActiveBenchmark.contextSwitches,
          }
        : null,
      delaySavedPerCarSeconds: frozenDelaySavings,
      efficiencyGainPercent: frozenEfficiencyGain,
      conclusion: frozenConclusion,
    };
    const content =
      format === "json"
        ? JSON.stringify(report, null, 2)
        : [
            "freezeTimeSeconds,activeAlgorithm,staticAverageWaitSeconds,activeAverageWaitSeconds,delaySavedPerCarSeconds,efficiencyGainPercent,vehiclesServed,throughputVehiclesPerMinute,contextSwitches",
            [
              frozenBenchmark.elapsed.toFixed(2),
              `"${activeAlgoLabel}"`,
              frozenStaticBenchmark?.avgWait.toFixed(2) ?? "",
              frozenActiveBenchmark?.avgWait.toFixed(2) ?? "",
              frozenDelaySavings?.toFixed(2) ?? "",
              frozenEfficiencyGain?.toFixed(2) ?? "",
              frozenActiveBenchmark?.served ?? "",
              frozenActiveBenchmark?.throughput.toFixed(2) ?? "",
              frozenActiveBenchmark?.contextSwitches ?? "",
            ].join(","),
          ].join("\n");
    const blob = new Blob([content], {
      type: format === "json" ? "application/json" : "text/csv",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `trafficos-benchmark-${frozenBenchmark.elapsed.toFixed(1)}s.${format}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    setReportActionError(null);
    setReportActionNotice(`Report export started (${format.toUpperCase()}).`);
  };

  const copyFrozenSummary = async () => {
    if (!frozenConclusion) return;
    try {
      await navigator.clipboard.writeText(frozenConclusion);
      setReportActionError(null);
      setReportActionNotice("Summary copied to clipboard.");
    } catch (error) {
      setReportActionNotice(null);
      setReportActionError(
        `Could not copy report summary: ${
          error instanceof Error ? error.message : "clipboard access was denied"
        }`
      );
    }
  };

  const totalVehicles =
    DIRECTIONS.reduce((n, d) => n + setup[d].count, 0) +
    (selectedAlgo === "PRIORITY_AGING" && emergencyLane ? 1 : 0);

  const reset = () => {
    setRunning(false);
    setAmbulanceScenario("IDLE");
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

  const launchEmergencyScenario = (lanes: Direction[]) => {
    clearFrozenBenchmark();
    if (simRef.current.finished) {
      simRef.current = createSim(setup, selectedAlgo);
      benchmarkSimsRef.current = createBenchmarkSims(setup, selectedAlgo, null);
    }
    setStopped(false);
    lanes.forEach((lane) => addEmergencyVehicle(simRef.current, lane));
    setSnap(snapshot(simRef.current));
    setRunning(true);
  };

  const startSingleAmbulance = () => {
    setAmbulanceScenario("SINGLE");
    launchEmergencyScenario([emergencyLane ?? "SOUTH"]);
  };

  const startRepeatedArrivals = () => {
    repeatedArrivalLaneRef.current = 0;
    setAmbulanceScenario("REPEATED");
    launchEmergencyScenario([emergencyLane ?? "SOUTH"]);
  };

  const startConflictingRequests = () => {
    setAmbulanceScenario("CONFLICTING");
    launchEmergencyScenario(["NORTH", "EAST"]);
  };

  const resetAmbulanceLab = () => {
    setRunning(false);
    setAmbulanceScenario("IDLE");
    setEmergencyLane(null);
    clearFrozenBenchmark();
    const cleanSim = createSim(setup, selectedAlgo);
    simRef.current = cleanSim;
    benchmarkSimsRef.current = createBenchmarkSims(setup, selectedAlgo, null);
    setSnap(snapshot(cleanSim));
  };

  const injectAmbulance = () => startSingleAmbulance();

  const toggleSimulatedStaleData = () => {
    setSimulationDataStale(
      simRef.current,
      !simRef.current.watchdog.simulatedStale
    );
    setSnap(snapshot(simRef.current));
  };

  const setLane = (lane: Direction, patch: Partial<Setup[Direction]>) =>
    setSetup((prev) => ({ ...prev, [lane]: { ...prev[lane], ...patch } }));

  const handleAlgoChange = (algo: Algo) => {
    setEventSimTime(simRef.current.clock);
    addEvent({
      type: "SCHEDULER",
      severity: "info",
      message: `Algorithm changed ${selectedAlgo} -> ${algo}`,
    });
    const nextSetup = presetSetup(algo);
    setRunning(false);
    setAmbulanceScenario("IDLE");
    clearFrozenBenchmark();
    setSelectedAlgo(algo);
    setSetup(nextSetup);
    setEmergencyLane(null);
    setSelectedChallan(null);
    simRef.current = createSim(nextSetup, algo);
    setSnap(snapshot(simRef.current));
    benchmarkSimsRef.current = createBenchmarkSims(nextSetup, algo, null);
  };

  const handleQuantumChange = (quantum: number) => {
    if (quantum !== timeQuantum) {
      setEventSimTime(simRef.current.clock);
      addEvent({
        type: "SCHEDULER",
        severity: "info",
        message: `Time quantum changed ${timeQuantum}s -> ${quantum}s`,
      });
    }
    setTimeQuantum(quantum);
  };

  const triggerIncident = () => {
    triggerRoadIncident(
      simRef.current,
      incidentLane,
      incidentType,
      incidentDuration === "UNTIL_CLEARED" ? null : Number(incidentDuration)
    );
    setPlanIgnored(false);
    setSnap(snapshot(simRef.current));
  };

  const clearIncident = () => {
    clearRoadIncident(simRef.current);
    setPlanIgnored(true);
    setSnap(snapshot(simRef.current));
  };

  const recommendedPlan = (): Record<Direction, number> => {
    const blockedLane = snap.incident?.lane ?? incidentLane;
    const available = DIRECTIONS.filter((lane) => lane !== blockedLane);
    const sorted = [...available].sort(
      (a, b) => heatmap[b].score - heatmap[a].score
    );
    const plan: Record<Direction, number> = {
      NORTH: 0,
      EAST: 0,
      SOUTH: 0,
      WEST: 0,
    };
    available.forEach((lane) => {
      plan[lane] = timeQuantum;
    });
    const baseShare = Math.floor(timeQuantum / available.length);
    let remainder = timeQuantum % available.length;
    sorted.forEach((lane) => {
      plan[lane] += baseShare + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder--;
    });
    return plan;
  };

  const applyIncidentPlan = () => {
    applyRoadPlan(simRef.current, recommendedPlan());
    setSnap(snapshot(simRef.current));
  };

  const exportEventsCsv = () => {
    const escape = (value: string) => `"${value.replace(/"/g, '""')}"`;
    const rows = [
      ["id", "simTime", "wallTime", "type", "severity", "lane", "message"],
      ...events.map((event) => [
        String(event.id),
        event.simTime,
        event.wallTime,
        event.type,
        event.severity,
        event.lane ?? "",
        event.message,
      ]),
    ];
    const csv = rows.map((row) => row.map(escape).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "trafficos-events.csv";
    link.click();
    URL.revokeObjectURL(url);
  };

  const hasAmbulance = (lane: Direction) =>
    snap.cars.some((car) => car.lane === lane && car.emergency) ||
    snap.emergencyVehicles.some(
      (vehicle) =>
        vehicle.lane === lane &&
        vehicle.status !== "CLEARED" &&
        vehicle.status !== "RECOVERY"
    );

  const queuedByLane = DIRECTIONS.reduce<Record<Direction, number>>(
    (counts, lane) => {
      counts[lane] = snap.cars.filter((car) => car.lane === lane && !car.released).length;
      return counts;
    },
    { NORTH: 0, EAST: 0, SOUTH: 0, WEST: 0 }
  );

  const inTransitByLane = DIRECTIONS.reduce<Record<Direction, number>>(
    (counts, lane) => {
      counts[lane] =
        snap.cars.filter((car) => car.lane === lane && car.released).length +
        snap.emergencyVehicles.filter(
          (vehicle) =>
            vehicle.lane === lane &&
            vehicle.status !== "CLEARED" &&
            vehicle.status !== "RECOVERY"
        ).length;
      return counts;
    },
    { NORTH: 0, EAST: 0, SOUTH: 0, WEST: 0 }
  );

  const signalOf = (lane: Direction) => {
    if (snap.emergencyState !== "IDLE") {
      if (
        snap.emergencyState === "CLEARING_TO_EMERGENCY" &&
        snap.signalPhase === "YELLOW" &&
        snap.lastLane === lane
      ) {
        return "🟡 AMBER";
      }
      return snap.emergencyState === "ACTIVE" && snap.active === lane
        ? "🟢 GREEN"
        : "🔴 RED";
    }
    if (snap.signalPhase === "GREEN" && snap.active === lane) return "🟢 GREEN";
    if (snap.signalPhase === "YELLOW" && snap.lastLane === lane) return "🟡 YELLOW";
    return "🔴 RED";
  };

  const activeIdx = snap.active ? DIRECTIONS.indexOf(snap.active) : -1;
  const junctionCongestion = Math.round(
    DIRECTIONS.reduce((total, lane) => total + heatmap[lane].score, 0) /
      DIRECTIONS.length
  );
  const diversionLane =
    snap.incident === null
      ? null
      : DIRECTIONS.filter((lane) => lane !== snap.incident?.lane).sort(
          (a, b) => heatmap[a].score - heatmap[b].score
        )[0];
  const incidentElapsed = snap.incident
    ? Math.max(0, snap.clock - snap.incident.startedAt)
    : 0;
  const incidentRemaining =
    snap.incident?.expiresAt === null || snap.incident?.expiresAt === undefined
      ? null
      : Math.max(0, snap.incident.expiresAt - snap.clock);
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
      throughput:
        benchmarkSim && simRef.current.clock > 0
          ? (benchmarkSim.served / simRef.current.clock) * 60
          : 0,
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
    frozenActiveBenchmark?.throughput ?? 0;
  const frozenSwitchLabel =
    frozenActiveBenchmark?.contextSwitches === 1 ? "context switch" : "context switches";
  const benchmarkStatusLabel = frozenBenchmark
    ? `${frozenBenchmark.status === "PAUSED" ? "RUN PAUSED" : "FINAL ANALYSIS"} • ${frozenBenchmark.elapsed.toFixed(1)}s`
    : running
    ? `LIVE BENCHMARK • ${snap.clock.toFixed(1)}s`
    : "READY";
  const frozenConclusion =
    frozenBenchmark && selectedAlgo !== "STATIC" && frozenStaticBenchmark && frozenActiveBenchmark
      ? (() => {
          const efficiencyText =
            frozenDelaySavings === null
              ? "No vehicles completed in both runs, so an efficiency comparison is not measurable"
              : frozenDelaySavings > 0
              ? `Average wait decreased by ${frozenDelaySavings.toFixed(2)}s per car (${frozenEfficiencyGain?.toFixed(1)}%)`
              : frozenDelaySavings < 0
              ? `Average wait increased by ${Math.abs(frozenDelaySavings).toFixed(2)}s per car (${Math.abs(frozenEfficiencyGain ?? 0).toFixed(1)}%)`
              : "Average wait was unchanged (0.0% efficiency gain)";
          return `At ${frozenBenchmark.elapsed.toFixed(1)}s, Static Timers averaged ${frozenStaticBenchmark.avgWait.toFixed(2)}s of wait per car, while ${activeAlgoLabel} averaged ${frozenActiveBenchmark.avgWait.toFixed(2)}s. ${efficiencyText} in this run. The active run served ${frozenActiveBenchmark.served} vehicles at ${frozenThroughput.toFixed(1)} vehicles/min and recorded ${frozenActiveBenchmark.contextSwitches} ${frozenSwitchLabel}.`;
        })()
      : frozenBenchmark
      ? "Static Timers is the selected baseline. Select Round Robin or Priority + Dynamic Aging to generate a comparative efficiency report."
      : null;
  const efficiencyTone =
    efficiencyGain === null
      ? "border-slate-300 bg-slate-100 text-slate-600"
      : efficiencyGain >= 0
      ? "border-emerald-300 bg-emerald-500/10 text-emerald-700"
      : "border-rose-300 bg-rose-500/10 text-rose-700";
  const delayTone =
    efficiencyGain === null
      ? "border-slate-300 bg-slate-100 text-slate-600"
      : efficiencyGain >= 0
      ? "border-emerald-300 bg-emerald-500/10 text-emerald-700"
      : "border-rose-300 bg-rose-500/10 text-rose-700";

  const selectCls =
    "w-full bg-white border border-slate-300 rounded-xl px-3 py-2 text-xs font-semibold text-slate-900 focus:outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500 transition-all disabled:opacity-50";
  const visibleEvents =
    eventFilter === "ALL"
      ? events
      : events.filter((event) => event.type === eventFilter);
  const eventTypeClasses: Record<EventType, string> = {
    SIGNAL: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
    SAFETY: "border-rose-500/30 bg-rose-500/10 text-rose-300",
    EMERGENCY: "border-violet-500/30 bg-violet-500/10 text-violet-300",
    ACCIDENT: "border-amber-500/30 bg-amber-500/10 text-amber-200",
    SCHEDULER: "border-cyan-500/30 bg-cyan-500/10 text-cyan-300",
  };

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
                onChange={(e) => handleQuantumChange(Number(e.target.value))}
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
          <div className="relative isolate w-full h-[420px] bg-slate-950 rounded-2xl border border-slate-800 overflow-hidden shadow-inner">
            <TrafficSimulationCanvas snap={snap} scenarioMode={scenarioMode} heatmap={heatmap} />
            {scenarioMode === "HEATMAP" && (
              <div className="absolute bottom-2 right-2 z-[5] flex gap-2 rounded-lg border border-slate-700 bg-slate-950/90 px-2 py-1 text-[8px] font-bold text-slate-200">
                {(["FREE", "MODERATE", "HEAVY"] as HeatLevel[]).map((level) => (
                  <span key={level} className="flex items-center gap-1">
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: HEAT_COLORS[level] }} />
                    {level}
                  </span>
                ))}
              </div>
            )}

            {/* Signal Labels */}
            <div className="absolute top-3 left-4 z-10 rounded-lg border border-slate-700 bg-slate-950/95 px-2.5 py-1.5 text-[10px] font-bold tracking-wide text-white shadow-lg sm:text-[11px]">
              NORTH: {signalOf("NORTH")} · {queuedByLane.NORTH} QUEUED · {inTransitByLane.NORTH} MOVING {hasAmbulance("NORTH") && <span className="text-rose-300 animate-pulse font-extrabold">🚨</span>}
            </div>
            <div className="absolute bottom-3 left-4 z-10 rounded-lg border border-slate-700 bg-slate-950/95 px-2.5 py-1.5 text-[10px] font-bold tracking-wide text-white shadow-lg sm:text-[11px]">
              SOUTH: {signalOf("SOUTH")} · {queuedByLane.SOUTH} QUEUED · {inTransitByLane.SOUTH} MOVING {hasAmbulance("SOUTH") && <span className="text-rose-300 animate-pulse font-extrabold">🚨</span>}
            </div>
            <div className="absolute left-3 top-16 z-10 rounded-lg border border-slate-700 bg-slate-950/95 px-2 py-1.5 text-[9px] font-bold tracking-wide text-white shadow-lg sm:text-[10px]">
              WEST: {signalOf("WEST")} · {queuedByLane.WEST} QUEUED · {inTransitByLane.WEST} MOVING {hasAmbulance("WEST") && <span className="text-rose-300 animate-pulse font-extrabold">🚨</span>}
            </div>
            <div className="absolute right-3 top-16 z-10 rounded-lg border border-slate-700 bg-slate-950/95 px-2 py-1.5 text-[9px] font-bold tracking-wide text-white shadow-lg sm:text-[10px]">
              EAST: {signalOf("EAST")} · {queuedByLane.EAST} QUEUED · {inTransitByLane.EAST} MOVING {hasAmbulance("EAST") && <span className="text-rose-300 animate-pulse font-extrabold">🚨</span>}
            </div>

            {scenarioMode === "ACCIDENT" && snap.incident && (
              <>
                <div
                  role="status"
                  className="absolute left-1/2 top-2 z-20 -translate-x-1/2 animate-pulse rounded-lg border border-rose-400/60 bg-rose-950/95 px-3 py-2 text-center text-[10px] font-black text-rose-100 shadow-lg sm:text-xs"
                >
                  ACCIDENT: {snap.incident.lane} lane blocked
                  {incidentRemaining === null ? " · clears when manually cleared" : ` · clears in ${Math.ceil(incidentRemaining)}s`}
                </div>
              </>
            )}
          </div>

          <section className="mt-4 rounded-2xl border border-slate-800 bg-slate-950/60 p-3.5">
            <label htmlFor="scenario-mode" className="mb-2 block text-[10px] font-bold uppercase tracking-widest text-slate-400">
              SCENARIO MODE
            </label>
            <select
              id="scenario-mode"
              value={scenarioMode}
              onChange={(event) => setScenarioMode(event.target.value as ScenarioMode)}
              className={selectCls}
            >
              <option value="NORMAL">Normal Traffic</option>
              <option value="HEATMAP">Congestion Heatmap</option>
              <option value="ACCIDENT">Accident / Road Block</option>
            </select>
            {scenarioMode === "HEATMAP" && (
              <div className="mt-3 space-y-3 rounded-xl border border-slate-800 bg-slate-900/70 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-xs font-bold text-slate-200">Junction Congestion Index</h3>
                  <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2.5 py-1 text-xs font-black text-amber-200">
                    {junctionCongestion}%
                  </span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[680px] text-left text-[10px]">
                    <thead className="text-slate-500">
                      <tr>
                        {["Lane", "Queue", "Avg wait", "Max wait", "Passed", "Congestion %", "Level", "60s trend"].map((label) => (
                          <th key={label} className="px-2 py-1.5 font-bold">{label}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {DIRECTIONS.map((lane) => {
                        const score = heatmap[lane].score;
                        const level = heatLevel(score);
                        return (
                          <tr key={lane} className="border-t border-slate-800 text-slate-300">
                            <td className="px-2 py-2 font-bold">{lane}</td>
                            <td className="px-2 py-2">{snap.queued[lane]}</td>
                            <td className="px-2 py-2">{snap.avgWaitByLane[lane].toFixed(1)}s</td>
                            <td className="px-2 py-2">{snap.maxWaitByLane[lane].toFixed(1)}s</td>
                            <td className="px-2 py-2">{snap.passedByLane[lane]}</td>
                            <td className="px-2 py-2 font-bold">{Math.round(score)}%</td>
                            <td className="px-2 py-2">
                              <span className="rounded-full px-2 py-1 text-[8px] font-black" style={{ color: HEAT_COLORS[level], backgroundColor: `${HEAT_COLORS[level]}20` }}>
                                {level}
                              </span>
                            </td>
                            <td className="px-2 py-1">
                              <HeatSparkline values={heatmap[lane].samples} color={HEAT_COLORS[level]} />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            {scenarioMode === "ACCIDENT" && (
              <div className="mt-3 space-y-3 rounded-xl border border-slate-800 bg-slate-900/70 p-3">
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  <label className="text-[9px] font-bold uppercase tracking-wide text-slate-500">
                    Lane
                    <select
                      value={incidentLane}
                      onChange={(event) => setIncidentLane(event.target.value as Direction)}
                      disabled={Boolean(snap.incident)}
                      className={`${selectCls} mt-1`}
                    >
                      {DIRECTIONS.map((lane) => (
                        <option key={lane} value={lane}>{lane[0] + lane.slice(1).toLowerCase()}</option>
                      ))}
                    </select>
                  </label>
                  <label className="text-[9px] font-bold uppercase tracking-wide text-slate-500">
                    Type
                    <select
                      value={incidentType}
                      onChange={(event) => setIncidentType(event.target.value as IncidentType)}
                      disabled={Boolean(snap.incident)}
                      className={`${selectCls} mt-1`}
                    >
                      <option value="ACCIDENT">Accident</option>
                      <option value="ROAD_BLOCK">Road Block</option>
                      <option value="BROKEN_DOWN">Broken-down vehicle</option>
                    </select>
                  </label>
                  <label className="text-[9px] font-bold uppercase tracking-wide text-slate-500">
                    Duration
                    <select
                      value={incidentDuration}
                      onChange={(event) => setIncidentDuration(event.target.value as IncidentDuration)}
                      disabled={Boolean(snap.incident)}
                      className={`${selectCls} mt-1`}
                    >
                      <option value="30">30 seconds</option>
                      <option value="60">60 seconds</option>
                      <option value="120">120 seconds</option>
                      <option value="UNTIL_CLEARED">Until cleared</option>
                    </select>
                  </label>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={triggerIncident}
                    disabled={Boolean(snap.incident)}
                    className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-[10px] font-bold text-rose-200 disabled:opacity-40"
                  >
                    Trigger
                  </button>
                  <button
                    type="button"
                    onClick={clearIncident}
                    disabled={!snap.incident}
                    className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[10px] font-bold text-amber-200 disabled:opacity-40"
                  >
                    Clear
                  </button>
                  {snap.laneQuantumPlan && (
                    <span className="self-center text-[9px] font-bold text-emerald-300">Alternative plan active</span>
                  )}
                </div>

                {snap.incident && !planIgnored && (
                  <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="text-[11px] font-bold text-amber-200">Recommendation</h3>
                      <span className="text-[9px] text-slate-400">
                        {snap.incident.lane} affected · queue {snap.queued[snap.incident.lane]}
                      </span>
                    </div>
                    <p className="mt-1 text-[10px] text-slate-300">
                      Divert via <strong className="text-emerald-300">{diversionLane}</strong>
                      {diversionLane && ` (${Math.round(heatmap[diversionLane].score)}% congestion)`}
                    </p>
                    <div className="mt-2 overflow-x-auto">
                      <table className="w-full min-w-[360px] text-[9px]">
                        <thead className="text-slate-500">
                          <tr><th className="px-2 py-1 text-left">Lane</th><th className="px-2 py-1">Before</th><th className="px-2 py-1">After</th></tr>
                        </thead>
                        <tbody>
                          {DIRECTIONS.map((lane) => {
                            const plan = recommendedPlan();
                            return (
                              <tr key={lane} className="border-t border-slate-800 text-slate-300">
                                <td className="px-2 py-1.5">{lane}</td>
                                <td className="px-2 py-1.5 text-center">{timeQuantum}s</td>
                                <td className={`px-2 py-1.5 text-center font-bold ${plan[lane] === 0 ? "text-rose-300" : "text-emerald-300"}`}>
                                  {plan[lane] === 0 ? "Suspended" : `${plan[lane]}s`}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    <div className="mt-2 flex gap-2">
                      <button type="button" onClick={applyIncidentPlan} className="rounded-lg bg-amber-400 px-3 py-1.5 text-[9px] font-black text-slate-950">
                        Apply Plan
                      </button>
                      <button type="button" onClick={() => setPlanIgnored(true)} className="rounded-lg border border-slate-700 px-3 py-1.5 text-[9px] font-bold text-slate-300">
                        Ignore
                      </button>
                    </div>
                  </div>
                )}

                {snap.incident && (
                  <div className="grid grid-cols-3 gap-2">
                    {[
                      { label: "ELAPSED", value: `${incidentElapsed.toFixed(1)}s` },
                      { label: "VEHICLES STUCK", value: snap.queued[snap.incident.lane] },
                      {
                        label: "EXTRA AVG DELAY",
                          value: `${Math.max(0, snap.avgWaitByLane[snap.incident.lane] - snap.incident.baselineAvgWait).toFixed(1)}s`,
                      },
                    ].map((metric) => (
                      <div key={metric.label} className="rounded-lg border border-slate-800 bg-slate-950/70 p-2">
                        <span className="block text-[8px] font-bold text-slate-500">{metric.label}</span>
                        <span className="text-xs font-black text-slate-200">{metric.value}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </section>

          <section className="mt-3 rounded-2xl border border-slate-800 bg-slate-950/60 p-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-300">
                Live Event Log <span className="text-slate-500">({events.length}/300)</span>
              </h3>
              <button
                type="button"
                onClick={exportEventsCsv}
                className="rounded-lg border border-slate-700 px-2.5 py-1.5 text-[9px] font-bold text-cyan-300 hover:border-cyan-400/50"
              >
                Export CSV
              </button>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {(["ALL", "SIGNAL", "SAFETY", "EMERGENCY", "ACCIDENT", "SCHEDULER"] as const).map((type) => (
                <button
                  key={type}
                  type="button"
                  aria-pressed={eventFilter === type}
                  onClick={() => setEventFilter(type)}
                  className={`rounded-full border px-2 py-1 text-[8px] font-bold ${
                    eventFilter === type
                      ? "border-cyan-400/50 bg-cyan-400/10 text-cyan-200"
                      : "border-slate-800 text-slate-500 hover:text-slate-300"
                  }`}
                >
                  {type === "ALL" ? "All" : type[0] + type.slice(1).toLowerCase()}
                </button>
              ))}
            </div>
            <div
              ref={eventScrollRef}
              onScroll={(event) => {
                const element = event.currentTarget;
                const nearBottom =
                  element.scrollHeight - element.scrollTop - element.clientHeight < 24;
                setAutoScrollEvents(nearBottom);
              }}
              className="mt-2 max-h-48 space-y-1.5 overflow-y-auto rounded-xl border border-slate-800 bg-slate-950/70 p-2"
            >
              {visibleEvents.length === 0 ? (
                <p className="py-3 text-center text-[10px] text-slate-500">No matching events yet.</p>
              ) : (
                visibleEvents.map((event) => (
                  <div
                    key={event.id}
                    className={`grid grid-cols-[auto_auto_1fr] items-start gap-2 border-l-2 px-2 py-1.5 text-[9px] ${
                      event.severity === "critical"
                        ? "border-l-rose-500 bg-rose-500/5"
                        : event.severity === "warn"
                        ? "border-l-amber-400 bg-amber-400/5"
                        : "border-l-slate-700"
                    }`}
                  >
                    <span className="font-mono text-slate-500">{event.simTime} · {event.wallTime}</span>
                    <span className={`rounded border px-1.5 py-0.5 font-black ${eventTypeClasses[event.type]}`}>
                      {event.type}
                    </span>
                    <span className={event.severity === "critical" ? "font-semibold text-rose-200" : event.severity === "warn" ? "text-amber-200" : "text-slate-300"}>
                      {event.lane ? `${event.lane} · ` : ""}{event.message}
                    </span>
                  </div>
                ))
              )}
            </div>
            {!autoScrollEvents && (
              <button
                type="button"
                onClick={() => {
                  setAutoScrollEvents(true);
                  if (eventScrollRef.current) {
                    eventScrollRef.current.scrollTop = eventScrollRef.current.scrollHeight;
                  }
                }}
                className="mt-2 rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-1.5 text-[9px] font-bold text-cyan-200"
              >
                Jump to latest
              </button>
            )}
          </section>

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
              <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[10px] font-black tracking-wider transition-all duration-500 ${frozenBenchmark ? "animate-pulse border-amber-400 bg-amber-100 text-slate-900 shadow-[0_0_22px_rgba(245,158,11,0.35)]" : running ? "border-emerald-300 bg-emerald-100 text-emerald-900 uppercase" : "border-amber-300 bg-amber-100 text-amber-900 uppercase"}`}>
                <span className={`h-2 w-2 rounded-full shadow-[0_0_10px_rgba(245,158,11,0.6)] ${frozenBenchmark ? "bg-amber-500" : running ? "bg-emerald-500" : "bg-amber-500"}`} />
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
                <div className={`rounded-xl border px-3 py-2.5 shadow-[0_8px_24px_rgba(16,185,129,0.12)] ${delayTone}`}>
                  <span className="block text-[10px] font-bold uppercase tracking-wider">
                    Delay saved / car
                  </span>
                  <span className="mt-1 block font-sans text-xl font-black tabular-nums">
                    {delaySavings === null ? "—" : `${delaySavings.toFixed(2)}s`}
                  </span>
                </div>
                <div className={`rounded-xl border px-3 py-2.5 shadow-[0_8px_24px_rgba(16,185,129,0.12)] ${efficiencyTone}`}>
                  <span className="block text-[10px] font-bold uppercase tracking-wider">
                    Efficiency gain
                  </span>
                  <span className="mt-1 block font-sans text-xl font-black tabular-nums">
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
                  <div className="mt-4 flex flex-wrap gap-2 border-t border-slate-200 pt-3">
                    <button
                      type="button"
                      onClick={() => void copyFrozenSummary()}
                      className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-[11px] font-bold text-slate-800 transition-colors hover:border-amber-400 hover:bg-amber-50"
                    >
                      📋 Copy Summary Text
                    </button>
                    <button
                      type="button"
                      onClick={() => exportFrozenReport("json")}
                      className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-[11px] font-bold text-slate-800 transition-colors hover:border-amber-400 hover:bg-amber-50"
                    >
                      📥 Export Report (JSON)
                    </button>
                    <button
                      type="button"
                      onClick={() => exportFrozenReport("csv")}
                      className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-[11px] font-bold text-slate-800 transition-colors hover:border-amber-400 hover:bg-amber-50"
                    >
                      Export CSV
                    </button>
                    <button
                      type="button"
                      onClick={reset}
                      className="rounded-lg border border-amber-300 bg-amber-100 px-3 py-2 text-[11px] font-black text-amber-950 transition-colors hover:bg-amber-200"
                    >
                      🔄 Reset &amp; Replay
                    </button>
                  </div>
                  {reportActionError && (
                    <p role="alert" className="mt-2 text-xs font-bold text-rose-700">
                      {reportActionError}
                    </p>
                  )}
                  {reportActionNotice && (
                    <p aria-live="polite" className="mt-2 text-xs font-bold text-emerald-700">
                      {reportActionNotice}
                    </p>
                  )}
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
      <div className="mt-6">
        <AmbulanceLabPanel
          snapshot={snap}
          scenario={ambulanceScenario}
          onSingleAmbulance={startSingleAmbulance}
          onRepeatedArrivals={startRepeatedArrivals}
          onConflictingRequests={startConflictingRequests}
          onReset={resetAmbulanceLab}
        />
      </div>
    </div>
  );
};

export default TrafficOSSimulator;