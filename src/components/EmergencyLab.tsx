import React, { useEffect, useRef, useState } from "react";
import {
  DIRECTIONS,
  addEmergencyVehicle,
  createSim,
  presetSetup,
  snapshot,
  step,
} from "../simEngine";
import type { Direction, Sim } from "../simEngine";

type EmergencySnapshot = ReturnType<typeof snapshot>;
type Scenario = "IDLE" | "SINGLE" | "REPEATED" | "CONFLICTING";

const LANE_COLORS: Record<Direction, string> = {
  NORTH: "#fb7185",
  EAST: "#60a5fa",
  SOUTH: "#c084fc",
  WEST: "#fbbf24",
};
const REPEATED_LANES: Direction[] = ["EAST", "WEST", "NORTH", "SOUTH"];
const makeSimulation = () => {
  const setup = presetSetup("RR");
  DIRECTIONS.forEach((lane) => {
    setup[lane].count = 1;
  });
  return createSim(setup, "RR", null, false);
};

function drawHospital(context: CanvasRenderingContext2D, width: number, height: number, timestamp: number) {
  const x = width * 0.69;
  const y = height * 0.64;
  const buildingWidth = width * 0.25;
  const buildingHeight = height * 0.32;
  const pulse = 0.55 + (Math.sin(timestamp / 260) + 1) * 0.2;

  context.save();
  context.shadowColor = "#22d3ee";
  context.shadowBlur = 18;
  context.fillStyle = "#0f2636";
  context.strokeStyle = "#22d3ee";
  context.lineWidth = 2;
  context.beginPath();
  context.roundRect(x, y + 14, buildingWidth, buildingHeight - 14, 8);
  context.fill();
  context.stroke();
  context.shadowBlur = 0;

  context.fillStyle = "#123047";
  context.beginPath();
  context.moveTo(x - 6, y + 17);
  context.lineTo(x + buildingWidth / 2, y);
  context.lineTo(x + buildingWidth + 6, y + 17);
  context.closePath();
  context.fill();
  context.strokeStyle = "#38bdf8";
  context.stroke();

  context.fillStyle = "#bae6fd";
  context.font = "bold 10px sans-serif";
  context.textAlign = "center";
  context.fillText("JUNCTION A · GEMINI FLYOVER", x + buildingWidth / 2, y + 34);
  context.fillStyle = "#e2e8f0";
  context.font = "900 12px sans-serif";
  context.fillText("CITY HOSPITAL", x + buildingWidth / 2, y + 52);

  const crossX = x + buildingWidth / 2;
  const crossY = y + buildingHeight * 0.52;
  context.globalAlpha = pulse;
  context.shadowColor = "#fb7185";
  context.shadowBlur = 18;
  context.fillStyle = "#fb7185";
  context.fillRect(crossX - 4, crossY - 13, 8, 26);
  context.fillRect(crossX - 13, crossY - 4, 26, 8);
  context.globalAlpha = 1;
  context.shadowBlur = 0;

  const bayY = y + buildingHeight - 44;
  context.fillStyle = "#07111d";
  context.strokeStyle = "#38bdf8";
  context.lineWidth = 1.5;
  context.beginPath();
  context.roundRect(x + buildingWidth * 0.19, bayY, buildingWidth * 0.62, 38, 4);
  context.fill();
  context.stroke();
  context.fillStyle = "#a5f3fc";
  context.font = "bold 8px sans-serif";
  context.fillText("AMBULANCE BAY", x + buildingWidth / 2, bayY + 11);
  context.restore();
}

function drawAmbulance(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  angle: number,
  timestamp: number,
  parked = false,
  alpha = 1
) {
  const pulseColor = Math.floor(timestamp / 160) % 2 ? "#38bdf8" : "#fb7185";
  context.save();
  context.globalAlpha = alpha;
  context.translate(x, y);
  context.rotate(angle);
  context.shadowColor = pulseColor;
  context.shadowBlur = parked ? 7 : 14;
  context.fillStyle = "#f8fafc";
  context.strokeStyle = "#fb7185";
  context.lineWidth = 1.5;
  context.beginPath();
  context.roundRect(-8, -17, 16, 34, 4);
  context.fill();
  context.stroke();
  context.shadowBlur = 0;
  context.fillStyle = "#38bdf8";
  context.fillRect(-6, -7, 12, 9);
  context.fillStyle = "#dc2626";
  context.fillRect(-6, 5, 12, 7);
  context.fillStyle = "#fff";
  context.fillRect(-1.5, 5.5, 3, 6);
  context.fillRect(-3, 7, 6, 2);
  context.fillStyle = pulseColor;
  context.fillRect(-6, -19, 5, 3);
  context.fillRect(1, -19, 5, 3);
  context.fillStyle = "#020617";
  context.beginPath();
  context.roundRect(-7, -27, 14, 6, 3);
  context.fill();
  context.fillStyle = pulseColor;
  context.shadowColor = pulseColor;
  context.shadowBlur = 7;
  context.beginPath();
  context.arc(0, -24, 2, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

type TrafficVehicleKind = "car" | "motorcycle" | "truck";
interface TrafficVisual {
  x: number;
  y: number;
  kind: TrafficVehicleKind;
}

function drawTrafficVehicle(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  angle: number,
  kind: TrafficVehicleKind,
  color: string
) {
  const length = kind === "truck" ? 30 : kind === "motorcycle" ? 16 : 23;
  const width = kind === "truck" ? 13 : kind === "motorcycle" ? 8 : 12;
  context.save();
  context.translate(x, y);
  context.rotate(angle);
  context.fillStyle = color;
  context.shadowColor = `${color}aa`;
  context.shadowBlur = 5;
  context.beginPath();
  context.roundRect(-width / 2, -length / 2, width, length, kind === "truck" ? 2 : 4);
  context.fill();
  context.shadowBlur = 0;
  if (kind === "motorcycle") {
    context.fillStyle = "#e2e8f0";
    context.beginPath();
    context.arc(0, -length * 0.17, 2.3, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = "#0f172a";
    context.beginPath();
    context.arc(0, length * 0.31, 2, 0, Math.PI * 2);
    context.fill();
  } else {
    context.fillStyle = "#0f172a";
    context.fillRect(-width / 2 + 2, -length * 0.2, width - 4, kind === "truck" ? 8 : 6);
    context.fillStyle = "#f8fafc";
    context.fillRect(-width / 2 + 1, -length / 2 + 2, 2, 2);
    context.fillRect(width / 2 - 3, -length / 2 + 2, 2, 2);
    context.fillStyle = "#ef4444";
    context.fillRect(-width / 2 + 1, length / 2 - 4, 2, 2);
    context.fillRect(width / 2 - 3, length / 2 - 4, 2, 2);
  }
  context.restore();
}

function roadPosition(
  lane: Direction,
  progress: number,
  width: number,
  height: number,
  roadWidth: number
): { x: number; y: number; angle: number } {
  const centerX = width / 2;
  const centerY = height / 2;
  const fraction = progress / 100;
  const sideOffset = roadWidth * 0.18;
  switch (lane) {
    case "NORTH":
      return { x: centerX - sideOffset, y: height * fraction, angle: Math.PI };
    case "SOUTH":
      return { x: centerX + sideOffset, y: height * (1 - fraction), angle: 0 };
    case "EAST":
      return { x: width * (1 - fraction), y: centerY - sideOffset, angle: -Math.PI / 2 };
    case "WEST":
      return { x: width * fraction, y: centerY + sideOffset, angle: Math.PI / 2 };
  }
}

function ambulanceRoutePosition(
  lane: Direction,
  progress: number,
  width: number,
  height: number,
  roadWidth: number,
  bayX: number,
  bayY: number
): { x: number; y: number; angle: number } {
  const centerX = width / 2;
  const centerY = height / 2;
  const offset = roadWidth * 0.18;
  const start = roadPosition(lane, 0, width, height, roadWidth);
  const stopPoints: Record<Direction, { x: number; y: number }> = {
    NORTH: { x: centerX - offset, y: centerY - roadWidth / 2 - 10 },
    EAST: { x: centerX + roadWidth / 2 + 10, y: centerY - offset },
    SOUTH: { x: centerX + offset, y: centerY + roadWidth / 2 + 10 },
    WEST: { x: centerX - roadWidth / 2 - 10, y: centerY + offset },
  };
  const junctionPoints: Record<Direction, { x: number; y: number }> = {
    NORTH: { x: centerX - offset, y: centerY },
    EAST: { x: centerX, y: centerY - offset },
    SOUTH: { x: centerX + offset, y: centerY },
    WEST: { x: centerX, y: centerY + offset },
  };

  if (progress <= 35) {
    const t = progress / 35;
    return {
      x: start.x + (stopPoints[lane].x - start.x) * t,
      y: start.y + (stopPoints[lane].y - start.y) * t,
      angle: start.angle,
    };
  }

  if (progress <= 55) {
    const t = (progress - 35) / 20;
    return {
      x: stopPoints[lane].x + (junctionPoints[lane].x - stopPoints[lane].x) * t,
      y: stopPoints[lane].y + (junctionPoints[lane].y - stopPoints[lane].y) * t,
      angle: start.angle,
    };
  }

  const t = Math.min(1, Math.max(0, (progress - 55) / 45));
  const eased = 1 - (1 - t) ** 1.3;
  const origin = junctionPoints[lane];
  const heading: Record<Direction, { x: number; y: number }> = {
    NORTH: { x: 0, y: 1 },
    EAST: { x: -1, y: 0 },
    SOUTH: { x: 0, y: -1 },
    WEST: { x: 1, y: 0 },
  };
  const tangent = heading[lane];
  const c1 = { x: origin.x + tangent.x * roadWidth * 0.9, y: origin.y + tangent.y * roadWidth * 0.9 };
  const c2 = { x: bayX, y: bayY - roadWidth * 0.8 };
  const inverse = 1 - eased;
  const x =
    inverse ** 3 * origin.x +
    3 * inverse ** 2 * eased * c1.x +
    3 * inverse * eased ** 2 * c2.x +
    eased ** 3 * bayX;
  const y =
    inverse ** 3 * origin.y +
    3 * inverse ** 2 * eased * c1.y +
    3 * inverse * eased ** 2 * c2.y +
    eased ** 3 * bayY;
  const dx =
    3 * inverse ** 2 * (c1.x - origin.x) +
    6 * inverse * eased * (c2.x - c1.x) +
    3 * eased ** 2 * (bayX - c2.x);
  const dy =
    3 * inverse ** 2 * (c1.y - origin.y) +
    6 * inverse * eased * (c2.y - c1.y) +
    3 * eased ** 2 * (bayY - c2.y);
  return { x, y, angle: Math.atan2(dx, -dy) };
}

function ambulanceBayX(id: string, width: number): number {
  const idNumber = Number(id.match(/\d+$/)?.[0] ?? 0);
  return width * 0.815 + ((idNumber % 3) - 1) * width * 0.03;
}

function EmergencyCanvas({ simulation }: { simulation: EmergencySnapshot }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const simulationRef = useRef(simulation);
  simulationRef.current = simulation;

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const visualPositions = new Map<string, { x: number; y: number }>();
    const trafficVisuals = new Map<string, TrafficVisual>();
    const arrivalAnimations = new Map<string, { startedAt: number }>();
    const completedArrivals = new Set<string>();
    let frameId = 0;
    let lastFrameAt = 0;

    const draw = (timestamp: number) => {
      const deltaSeconds = lastFrameAt
        ? Math.min((timestamp - lastFrameAt) / 1000, 0.05)
        : 1 / 60;
      lastFrameAt = timestamp;
      const bounds = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const width = Math.max(1, bounds.width);
      const height = Math.max(1, bounds.height);
      const pixelWidth = Math.round(width * dpr);
      const pixelHeight = Math.round(height * dpr);
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);

      context.fillStyle = "#07111d";
      context.fillRect(0, 0, width, height);
      context.strokeStyle = "rgba(56,189,248,0.07)";
      context.lineWidth = 1;
      for (let x = 0; x < width; x += 26) {
        context.beginPath(); context.moveTo(x, 0); context.lineTo(x, height); context.stroke();
      }
      for (let y = 0; y < height; y += 26) {
        context.beginPath(); context.moveTo(0, y); context.lineTo(width, y); context.stroke();
      }

      const centerX = width * 0.5;
      const centerY = height * 0.5;
      const roadWidth = Math.min(110, height * 0.34);
      context.fillStyle = "#1e293b";
      context.fillRect(centerX - roadWidth / 2, 0, roadWidth, height);
      context.fillRect(0, centerY - roadWidth / 2, width, roadWidth);
      context.strokeStyle = "rgba(226,232,240,0.42)";
      context.setLineDash([12, 12]);
      context.lineWidth = 2;
      context.beginPath();
      context.moveTo(centerX, 0); context.lineTo(centerX, height);
      context.moveTo(0, centerY); context.lineTo(width, centerY);
      context.stroke();
      context.setLineDash([]);

      const current = simulationRef.current;
      const signalColor = (lane: Direction) => {
        if (current.emergencyState === "ACTIVE" && current.active === lane) return "#22c55e";
        if (
          current.emergencyState === "CLEARING_TO_EMERGENCY" &&
          current.signalPhase === "YELLOW" &&
          current.lastLane === lane
        ) return "#f59e0b";
        if (current.emergencyState === "IDLE" && current.signalPhase === "GREEN" && current.active === lane) return "#22c55e";
        return "#ef4444";
      };
      const signalLocations: Record<Direction, [number, number]> = {
        NORTH: [centerX - roadWidth * 0.68, centerY - roadWidth * 0.68],
        EAST: [centerX + roadWidth * 0.68, centerY - roadWidth * 0.68],
        SOUTH: [centerX + roadWidth * 0.68, centerY + roadWidth * 0.68],
        WEST: [centerX - roadWidth * 0.68, centerY + roadWidth * 0.68],
      };
      DIRECTIONS.forEach((lane) => {
        const [x, y] = signalLocations[lane];
        context.fillStyle = "#020617";
        context.beginPath(); context.roundRect(x - 10, y - 10, 20, 20, 6); context.fill();
        context.fillStyle = signalColor(lane);
        context.shadowColor = context.fillStyle;
        context.shadowBlur = 12;
        context.beginPath(); context.arc(x, y, 5, 0, Math.PI * 2); context.fill();
        context.shadowBlur = 0;
      });

      const activeTrafficIds = new Set<string>();
      for (const car of current.cars) {
        const id = `traffic-${car.id}`;
        activeTrafficIds.add(id);
        const target = roadPosition(car.lane, car.progress, width, height, roadWidth);
        let visual = trafficVisuals.get(id);
        if (!visual) {
          const kind: TrafficVehicleKind = car.id % 4 === 0
            ? "motorcycle"
            : car.id % 3 === 0
              ? "truck"
              : "car";
          visual = { x: target.x, y: target.y, kind };
          trafficVisuals.set(id, visual);
        }
        const follow = 1 - Math.exp(-deltaSeconds * 10);
        visual.x += (target.x - visual.x) * follow;
        visual.y += (target.y - visual.y) * follow;
        drawTrafficVehicle(context, visual.x, visual.y, target.angle, visual.kind, LANE_COLORS[car.lane]);
      }
      trafficVisuals.forEach((_, id) => {
        if (!activeTrafficIds.has(id)) trafficVisuals.delete(id);
      });

      drawHospital(context, width, height, timestamp);
      const bayCenterX = width * 0.815;
      const bayY = height * 0.64 + height * 0.32 - 25;
      context.save();
      context.strokeStyle = "rgba(34,211,238,0.65)";
      context.setLineDash([4, 5]);
      context.beginPath();
      context.moveTo(centerX + roadWidth / 2, centerY + roadWidth / 2);
      context.quadraticCurveTo(width * 0.68, height * 0.72, bayCenterX, bayY);
      context.stroke();
      context.restore();

      const activeVehicles = current.emergencyVehicles.filter(
        (vehicle) => vehicle.status !== "CLEARED" && vehicle.status !== "RECOVERY"
      );
      const activeIds = new Set(activeVehicles.map((vehicle) => vehicle.id));
      const vehiclesPerLane: Record<Direction, number> = { NORTH: 0, EAST: 0, SOUTH: 0, WEST: 0 };
      for (const vehicle of activeVehicles) {
        const queueIndex = vehiclesPerLane[vehicle.lane]++;
        const target = ambulanceRoutePosition(
          vehicle.lane,
          vehicle.position - queueIndex * 12,
          width,
          height,
          roadWidth,
          ambulanceBayX(vehicle.id, width),
          bayY
        );
        const position = visualPositions.get(vehicle.id) ?? target;
        const follow = 1 - Math.exp(-deltaSeconds * 9);
        position.x += (target.x - position.x) * follow;
        position.y += (target.y - position.y) * follow;
        visualPositions.set(vehicle.id, position);
        drawAmbulance(context, position.x, position.y, target.angle, timestamp);
      }

      current.emergencyVehicles
        .filter((vehicle) => vehicle.status === "CLEARED" || vehicle.status === "RECOVERY")
        .forEach((vehicle) => {
          if (completedArrivals.has(vehicle.id)) return;
          let arrival = arrivalAnimations.get(vehicle.id);
          if (!arrival) {
            arrival = { startedAt: timestamp };
            arrivalAnimations.set(vehicle.id, arrival);
          }
          const elapsed = timestamp - arrival.startedAt;
          const fade = Math.max(0, 1 - Math.max(0, elapsed - 1800) / 1200);
          const bayX = ambulanceBayX(vehicle.id, width);
          if (fade > 0) drawAmbulance(context, bayX, bayY, Math.PI, timestamp, true, fade);
          if (elapsed > 3000) {
            arrivalAnimations.delete(vehicle.id);
            completedArrivals.add(vehicle.id);
          }
        });

      visualPositions.forEach((_, id) => {
        if (!activeIds.has(id)) visualPositions.delete(id);
      });

      context.fillStyle = "#e2e8f0";
      context.font = "bold 10px monospace";
      context.fillText(`SIGNAL PREEMPTION · ${current.emergencyState.replace(/_/g, " ")}`, 12, 20);
      context.fillStyle = "#94a3b8";
      context.font = "9px monospace";
      context.fillText("AMBULANCE CORRIDOR → CITY HOSPITAL", 12, 35);
      frameId = requestAnimationFrame(draw);
    };

    frameId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frameId);
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="h-full w-full"
      role="img"
      aria-label="Animated emergency corridor, signal preemption, ambulance and hospital destination"
    />
  );
}

export default function EmergencyLab() {
  const simulationRef = useRef<Sim>(makeSimulation());
  const [simulation, setSimulation] = useState<EmergencySnapshot>(() => snapshot(simulationRef.current));
  const [running, setRunning] = useState(false);
  const [scenario, setScenario] = useState<Scenario>("IDLE");
  const [arrivalCount, setArrivalCount] = useState(0);

  useEffect(() => {
    if (!running) return;
    let previous = performance.now();
    let frameId = 0;
    let lastSnapshotAt = 0;
    const advance = (now: number) => {
      const delta = Math.min((now - previous) / 1000, 0.05);
      previous = now;
      step(simulationRef.current, delta, "RR", 3, true);
      if (now - lastSnapshotAt >= 50) {
        setSimulation(snapshot(simulationRef.current));
        lastSnapshotAt = now;
      }
      frameId = requestAnimationFrame(advance);
    };
    frameId = requestAnimationFrame(advance);
    return () => cancelAnimationFrame(frameId);
  }, [running]);

  useEffect(() => {
    if (!running || scenario !== "REPEATED") return;
    const timer = window.setInterval(() => {
      const activeCount = simulationRef.current.emergencyVehicles.filter(
        (vehicle) => vehicle.status !== "CLEARED" && vehicle.status !== "RECOVERY"
      ).length;
      if (activeCount >= 3) return;
      const lane = REPEATED_LANES[arrivalCount % REPEATED_LANES.length];
      if (addEmergencyVehicle(simulationRef.current, lane)) {
        setArrivalCount((count) => count + 1);
        setSimulation(snapshot(simulationRef.current));
      }
    }, 4500);
    return () => window.clearInterval(timer);
  }, [running, scenario, arrivalCount]);

  const resetLab = () => {
    setRunning(false);
    setScenario("IDLE");
    setArrivalCount(0);
    simulationRef.current = makeSimulation();
    setSimulation(snapshot(simulationRef.current));
  };

  const launchScenario = (nextScenario: Exclude<Scenario, "IDLE">, lanes: Direction[]) => {
    simulationRef.current = makeSimulation();
    simulationRef.current.started = true;
    lanes.forEach((lane) => addEmergencyVehicle(simulationRef.current, lane));
    setScenario(nextScenario);
    setArrivalCount(lanes.length);
    setSimulation(snapshot(simulationRef.current));
    setRunning(true);
  };

  const activeRequests = simulation.emergencyVehicles.filter(
    (vehicle) => vehicle.status !== "CLEARED" && vehicle.status !== "RECOVERY"
  );
  const currentSignal = simulation.emergencyState === "ACTIVE"
    ? `${simulation.active ?? "—"} GREEN · PREEMPTED`
    : simulation.emergencyState.replace(/_/g, " ");

  return (
    <div className="mx-auto max-w-7xl space-y-5 font-mono text-slate-100">
      <section className="overflow-hidden rounded-2xl border border-cyan-500/30 bg-slate-900 shadow-[0_0_28px_rgba(6,182,212,0.08)]">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-4 py-3">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-cyan-300">Live emergency corridor · Junction A</p>
            <h2 className="mt-1 text-sm font-black text-white">Ambulance routing &amp; hospital arrival</h2>
          </div>
          <span className={`rounded-full border px-3 py-1 text-[10px] font-black ${
            simulation.emergencyState === "ACTIVE"
              ? "border-emerald-400/50 bg-emerald-400/10 text-emerald-200 animate-pulse"
              : "border-slate-700 bg-slate-950 text-slate-300"
          }`}>SIGNAL: {currentSignal}</span>
        </div>
        <div className="relative h-[360px] sm:h-[440px]">
          <EmergencyCanvas key={scenario} simulation={simulation} />
          <div className="absolute bottom-3 right-3 rounded-lg border border-cyan-400/30 bg-slate-950/90 px-3 py-2 text-right">
            <span className="block text-[9px] font-bold uppercase tracking-wider text-cyan-300">Destination</span>
            <span className="text-xs font-black text-white">City Hospital · Ambulance Bay</span>
          </div>
        </div>
      </section>

      <div className="grid gap-5 lg:grid-cols-[1.2fr_0.8fr]">
        <section className="space-y-4 rounded-2xl border border-slate-700/60 bg-slate-900 p-4">
          <div>
            <h3 className="text-sm font-black uppercase tracking-wider text-rose-300">Emergency arrival controls</h3>
            <p className="mt-1 text-[11px] text-slate-400">Requests trigger safe signal clearance, protected ambulance passage, then normal scheduler recovery.</p>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <button type="button" onClick={() => launchScenario("SINGLE", ["SOUTH"])} className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-3 text-xs font-black text-amber-100 hover:border-amber-300">🚑 Single Ambulance</button>
            <button type="button" onClick={() => launchScenario("REPEATED", ["SOUTH"])} className="rounded-xl border border-cyan-400/30 bg-cyan-400/10 px-3 py-3 text-xs font-black text-cyan-100 hover:border-cyan-300">🔄 Repeated Arrivals</button>
            <button type="button" onClick={() => launchScenario("CONFLICTING", ["NORTH", "EAST"])} className="rounded-xl border border-rose-400/30 bg-rose-400/10 px-3 py-3 text-xs font-black text-rose-100 hover:border-rose-300">⚠️ Conflicting Requests</button>
            <button type="button" onClick={resetLab} className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-3 text-xs font-black text-slate-200 hover:border-slate-500">↺ Reset Lab</button>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            <Metric label="SCENARIO" value={scenario} />
            <Metric label="ARRIVALS" value={String(arrivalCount)} />
            <Metric label="ACTIVE REQUESTS" value={String(activeRequests.length)} />
            <Metric label="BACKGROUND TRAFFIC" value={String(simulation.cars.length)} />
            <Metric label="SIM TIME" value={`${simulation.clock.toFixed(1)}s`} />
          </div>
          <div className="flex flex-wrap gap-2">
            {simulation.emergencyVehicles.slice(-5).map((vehicle) => (
              <span key={vehicle.id} className="rounded-lg border border-rose-400/20 bg-rose-400/5 px-2.5 py-1.5 text-[10px] font-bold text-slate-200">
                <span className="text-rose-300">🚑 {vehicle.id}</span> · {vehicle.lane} · {vehicle.status.replace(/_/g, " ")}
              </span>
            ))}
          </div>
        </section>

        <section className="space-y-3 rounded-2xl border border-slate-700/60 bg-slate-900 p-4">
          <h3 className="text-sm font-black uppercase tracking-wider text-cyan-300">Signal preemption &amp; recovery</h3>
          <div className="grid grid-cols-2 gap-2">
            {DIRECTIONS.map((lane) => {
              const signal = simulation.emergencyState === "ACTIVE" && simulation.active === lane
                ? "GREEN · PRIORITY"
                : simulation.emergencyState === "CLEARING_TO_EMERGENCY" && simulation.lastLane === lane
                  ? "AMBER · CLEARING"
                  : "RED";
              return (
                <div key={lane} className="rounded-xl border border-slate-800 bg-slate-950/70 p-3">
                  <span className="block text-[10px] font-black" style={{ color: LANE_COLORS[lane] }}>{lane}</span>
                  <span className={`mt-1 block text-[10px] font-bold ${signal.startsWith("GREEN") ? "text-emerald-300" : signal.startsWith("AMBER") ? "text-amber-300" : "text-rose-300"}`}>{signal}</span>
                </div>
              );
            })}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Metric label="AMBULANCE DELAY" value={`${simulation.ambulanceDelay.toFixed(1)}s`} />
            <Metric label="RECOVERY TIME" value={`${simulation.recoveryTime.toFixed(1)}s`} />
          </div>
          <p className="text-[10px] leading-relaxed text-slate-500">This emergency simulation is isolated from the Scheduler Lab and runs its own RR-based signal kernel.</p>
        </section>
      </div>
    </div>
  );
}

const Metric: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-2">
    <span className="block text-[9px] font-bold text-slate-500">{label}</span>
    <span className="text-[11px] font-black text-white">{value}</span>
  </div>
);
