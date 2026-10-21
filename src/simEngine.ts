/**
 * TrafficOS simulation engine (pure TypeScript, no React).
 *
 * Mapping:  lane = process,  vehicle = unit of CPU work,  green light = CPU,
 *           junction = critical section, mutex = exclusive green access,
 *           context switch = signal transition between lane processes.
 */

import {
  activateGreen,
  advanceSafetyPhase,
  applySafetyHold,
  approveGreenSwitch,
  ALL_RED_SECONDS,
  beginSafetySwitch,
  checkWatchdog as checkWatchdogState,
  createSafetyState,
  createWatchdogState,
  MAX_GREEN_SECONDS,
  MIN_GREEN_SECONDS,
  registerViolation,
  recordWatchdogUpdate,
  setSimulatedStale as setSimulatedStaleState,
  STARVATION_LIMIT_SECONDS,
  startAllRed,
} from "./safetyLayer";
import type {
  SafetyState,
  SignalPhase,
  WatchdogState,
} from "./safetyLayer";
import { createEChallan } from "./eChallan";
import type { EChallan, ViolationType } from "./eChallan";

export type Direction = "NORTH" | "EAST" | "SOUTH" | "WEST";
export type Algo = "STATIC" | "RR" | "PRIORITY_AGING";
export type EmergencyState =
  | "IDLE"
  | "CLEARING_TO_EMERGENCY"
  | "ACTIVE"
  | "CLEARING_TO_NORMAL";

export const DIRECTIONS: Direction[] = ["NORTH", "EAST", "SOUTH", "WEST"];

// Canvas geometry: progress is a % of the canvas (0 = spawn edge, 100 = far edge).
export const STOP_LINE: Record<Direction, number> = { NORTH: 35, SOUTH: 35, EAST: 40, WEST: 40 };
export const SLOT_GAP: Record<Direction, number> = { NORTH: 5.5, SOUTH: 5.5, EAST: 5, WEST: 5 };

export const CAR_SPEED = 35; // % of canvas per second
export const HEADWAY = 1; // seconds between vehicles released on green (service time per vehicle)
export const CLEARANCE = 1; // seconds of all-red between lanes (context-switch cost)
export const AGING_STEP = 2; // a waiting lane gains one priority level every N seconds
export const MAX_PER_LANE = 7;

export interface Car {
  id: number;
  lane: Direction;
  progress: number;
  released: boolean;
  arrival: number;
  releasedAt: number | null;
  emergency: boolean;
  rogue?: boolean; // red-light violator
}

export type EmergencyVehicleStatus =
  | "APPROACHING"
  | "SAFE_CLEARANCE"
  | "PASSING"
  | "RECOVERY"
  | "CLEARED";

export interface EmergencyVehicle {
  id: string;
  lane: Direction;
  position: number;
  status: EmergencyVehicleStatus;
  arrivedAt: number;
  grantedAt: number | null;
  clearedAt: number | null;
}

export interface Segment {
  lane: Direction;
  start: number;
  end: number | null; // null = still green
  emergency: boolean;
}
export interface ViolationLogEntry {
  id: string;
  intersectionId: string;
  lane: Direction;
  timestamp: number; // sim seconds
  vehicleId: string;
  registrationNumber: string;
  type: ViolationType;
  description: string;
  additionalHoldSeconds: number;
  violationCount: number;
}

export interface LaneSetup {
  count: number; // vehicles queued at start (burst length)
  priority: number; // 1 = highest priority
}
export type Setup = Record<Direction, LaneSetup>;

export interface Sim {
  clock: number;
  cars: Car[];
  nextId: number;
  active: Direction | null;
  sliceElapsed: number;
  releaseTimer: number;
  clearance: number;
  lastLane: Direction | null;
  rrPtr: number;
  waitSince: Record<Direction, number>;
  starvation: Record<Direction, number>;
  priority: Record<Direction, number>;
  safety: SafetyState;
  watchdog: WatchdogState;
  segments: Segment[];
  violations: number;
  violationLog: ViolationLogEntry[];
  challans: EChallan[];
  contextSwitches: number;
  served: number;
  waitSum: number;
  tatSum: number;
  emergencyVehicles: EmergencyVehicle[];
  emergencyId: string | null;
  emergencyLane: Direction | null;
  emergencyState: EmergencyState;
  emergencyGreenElapsed: number;
  emergencyVehiclesReleased: number;
  emergencyAmbulancePassed: boolean;
  nextEmergencyId: number;
  ambulanceDelaySum: number;
  ambulanceDelayCount: number;
  recoveryTime: number;
  recoveryStartedAt: number | null;
  ordinaryServed: number;
  cameraVehicleIds: Map<string, number>;
  logs: string[];
  started: boolean;
  finished: boolean;
}

export const presetSetup = (algo: Algo): Setup => {
  const priorities: Record<Direction, number> =
    algo === "PRIORITY_AGING"
      ? { NORTH: 4, EAST: 1, SOUTH: 3, WEST: 2 }
      : { NORTH: 2, EAST: 2, SOUTH: 2, WEST: 2 };

  const counts: Record<Direction, number> = {
    NORTH: 4,
    EAST: 4,
    SOUTH: 4,
    WEST: 4,
  };

  if (algo === "RR") {
    counts.NORTH = 5;
    counts.EAST = 3;
    counts.SOUTH = 6;
    counts.WEST = 4;
  } else {
    counts.NORTH = 4;
    counts.EAST = 6;
    counts.SOUTH = 3;
    counts.WEST = 5;
  }

  return {
    NORTH: { count: counts.NORTH, priority: priorities.NORTH },
    EAST: { count: counts.EAST, priority: priorities.EAST },
    SOUTH: { count: counts.SOUTH, priority: priorities.SOUTH },
    WEST: { count: counts.WEST, priority: priorities.WEST },
  };
};

export const defaultSetup = (): Setup => presetSetup("RR");

const slotPos = (lane: Direction, k: number) => STOP_LINE[lane] - k * SLOT_GAP[lane];

/** Unreleased (waiting) vehicles of a lane, front of the queue first. */
export const queueOf = (sim: Sim, lane: Direction): Car[] =>
  sim.cars
    .filter((c) => c.lane === lane && !c.released)
    .sort((a, b) => Number(b.emergency) - Number(a.emergency) || a.id - b.id);

const queueLen = (sim: Sim, lane: Direction) => queueOf(sim, lane).length;

export function createSim(
  setup: Setup,
  algo: Algo = "RR",
  emergencyLane: Direction | null = null
): Sim {
  const sim: Sim = {
    clock: 0,
    cars: [],
    nextId: 1,
    active: null,
    sliceElapsed: 0,
    releaseTimer: 0,
    clearance: 0,
    lastLane: null,
    rrPtr: -1,
    waitSince: { NORTH: 0, EAST: 0, SOUTH: 0, WEST: 0 },
    starvation: { NORTH: 0, EAST: 0, SOUTH: 0, WEST: 0 },
    priority: {
      NORTH: setup.NORTH.priority,
      EAST: setup.EAST.priority,
      SOUTH: setup.SOUTH.priority,
      WEST: setup.WEST.priority,
    },
    safety: createSafetyState(),
    watchdog: createWatchdogState(),
    segments: [],
    violations: 0,
    violationLog: [],
    challans: [],
    contextSwitches: 0,
    served: 0,
    waitSum: 0,
    tatSum: 0,
    emergencyId: null,
    emergencyLane: null,
    emergencyState: "IDLE",
    emergencyGreenElapsed: 0,
    emergencyVehiclesReleased: 0,
    emergencyAmbulancePassed: false,
    emergencyVehicles: [],
    nextEmergencyId: 911,
    ambulanceDelaySum: 0,
    ambulanceDelayCount: 0,
    recoveryTime: 0,
    recoveryStartedAt: null,
    ordinaryServed: 0,
    cameraVehicleIds: new Map(),
    logs: [],
    started: false,
    finished: false,
  };
  // Initial vehicles are already queued at the stop line (arrival time 0).
  for (const lane of DIRECTIONS) {
    const n = Math.max(0, Math.min(MAX_PER_LANE, setup[lane].count));
    for (let k = 0; k < n; k++) {
      sim.cars.push({
        id: sim.nextId++,
        lane,
        progress: slotPos(lane, k),
        released: false,
        arrival: 0,
        releasedAt: null,
        emergency: false,
      });
    }
  };
  if (emergencyLane) addEmergencyVehicle(sim, emergencyLane);
  return sim;
}

/** Enqueue one more vehicle on a lane while the simulation is live. */
export function addVehicle(sim: Sim, lane: Direction, emergency = false): boolean {
  if (emergency) return addEmergencyVehicle(sim, lane);
  const k = queueLen(sim, lane);
  if (k >= MAX_PER_LANE) return false;
  if (k === 0) sim.waitSince[lane] = sim.clock; // lane just became "ready"
  const car: Car = {
    id: sim.nextId++,
    lane,
    progress: 0, // drives in from the edge to the back of the queue
    released: false,
    arrival: sim.clock,
    releasedAt: null,
    emergency: false,
  };
  sim.cars.push(car);
  sim.finished = false;
  return true;
}

export function addEmergencyVehicle(
  sim: Sim,
  lane: Direction,
  id = `AMB-${sim.nextEmergencyId++}`
): boolean {
  if (sim.watchdog.failSafeActive) return false;
  if (sim.emergencyVehicles.some((vehicle) => vehicle.id === id)) return false;
  sim.emergencyVehicles.push({
    id,
    lane,
    position: 0,
    status: "APPROACHING",
    arrivedAt: sim.clock,
    grantedAt: null,
    clearedAt: null,
  });
  sim.finished = false;
  if (sim.started && sim.emergencyState === "IDLE") {
    beginEmergencyClearance(sim, sim.emergencyVehicles[sim.emergencyVehicles.length - 1]);
  }
  return true;
}
// ---------- Step 2: violations ----------
const JUNCTION_EXIT = 62; // progress % where the junction box ends, tweak to match your canvas

/** True when no released vehicle is still inside the junction box. */
const junctionClear = (sim: Sim): boolean =>
  !sim.cars.some((c) => c.released && c.progress < JUNCTION_EXIT);

function advanceReleasedVehicles(sim: Sim, elapsed: number) {
  const remaining: Car[] = [];
  for (const car of sim.cars) {
    if (!car.released) {
      remaining.push(car);
      continue;
    }
    car.progress += CAR_SPEED * elapsed;
    if (car.progress >= 100) {
      if (!car.rogue) {
        sim.served++;
        if (!car.emergency) sim.ordinaryServed++;
        sim.waitSum += (car.releasedAt ?? sim.clock) - car.arrival;
        sim.tatSum += sim.clock - car.arrival;
      }
    } else {
      remaining.push(car);
    }
  }
  sim.cars = remaining;
}

/** A lane is RED unless it holds the green (normal or emergency). */
export const isLaneRed = (sim: Sim, lane: Direction): boolean =>
  !(sim.active === lane && (sim.safety.phase === "GREEN" || sim.emergencyState === "ACTIVE"));

function recordTrafficViolation(sim: Sim, lane: Direction, vehicleId: number) {
  const violationId = `VIO-${String(vehicleId).padStart(6, "0")}`;
  if (
    sim.violationLog.some((entry) => entry.id === violationId) ||
    sim.challans.some((challan) => challan.violationId === violationId)
  ) {
    return false;
  }
  const emergencyClearance =
    sim.emergencyState === "CLEARING_TO_EMERGENCY" ||
    sim.emergencyState === "CLEARING_TO_NORMAL";
  if (emergencyClearance) {
    sim.safety.phase = "ALL_RED";
    sim.safety.remaining = sim.clearance;
  } else if (sim.emergencyState === "ACTIVE") {
    sim.safety.phase = "GREEN";
  }
  const additionalHoldSeconds = registerViolation(sim.safety, lane, sim.logs);
  sim.violations++;
  if (emergencyClearance) {
    sim.clearance += additionalHoldSeconds;
    sim.safety.remaining = sim.clearance;
  }
  const violation: ViolationLogEntry = {
    id: violationId,
    intersectionId: "TRAFFICOS-JUNCTION",
    lane,
    timestamp: Math.round(sim.clock * 10) / 10,
    vehicleId: `VEH-${String(vehicleId).padStart(6, "0")}`,
    registrationNumber: `SIMULATED-PLATE-${String(vehicleId).padStart(6, "0")}`,
    type: "RED_LIGHT",
    description: `${lane} vehicle crossed the stop line while its signal was red.`,
    additionalHoldSeconds,
    violationCount: sim.violations,
  };
  sim.violationLog.push(violation);
  sim.challans.push(
    createEChallan(
      {
        violationId: violation.id,
        simulationTimestamp: violation.timestamp,
        lane: violation.lane,
        intersectionId: violation.intersectionId,
        vehicleId: violation.vehicleId,
        registrationNumber: violation.registrationNumber,
        violationType: violation.type,
        description: violation.description,
      },
      sim.challans.length + 1
    )
  );
  sim.logs.push(
    `KERNEL VIOLATION ${violation.id}: ${violation.type} ${lane}, vehicle ${violation.vehicleId}, all-red +${additionalHoldSeconds}s`
  );
  sim.finished = false;
  return true;
}

export type CameraViolationResult =
  | "RECORDED"
  | "SIGNAL_GREEN"
  | "SIGNAL_UNAVAILABLE"
  | "DUPLICATE";

/** Camera crossings use the same red-signal check and logging/challan path. */
export function recordCameraViolation(
  sim: Sim,
  lane: Direction,
  trackingId: string
): CameraViolationResult {
  if (!sim.started || sim.finished) return "SIGNAL_UNAVAILABLE";
  if (!isLaneRed(sim, lane)) return "SIGNAL_GREEN";
  const vehicleId =
    sim.cameraVehicleIds.get(trackingId) ??
    (() => {
      const id = sim.nextId++;
      sim.cameraVehicleIds.set(trackingId, id);
      return id;
    })();
  return recordTrafficViolation(sim, lane, vehicleId)
    ? "RECORDED"
    : "DUPLICATE";
}

/** Every modeled stop-line crossing uses the same red-signal detection path. */
function crossStopLine(sim: Sim, car: Car) {
  if (car.released) return;
  car.released = true;
  car.releasedAt = sim.clock;
  if (isLaneRed(sim, car.lane)) {
    car.rogue = true;
    recordTrafficViolation(sim, car.lane, car.id);
  }
}

function detectStopLineCrossings(sim: Sim) {
  for (const car of sim.cars) {
    if (!car.released && car.progress > STOP_LINE[car.lane] + 1e-6) {
      // The approach queues stop at the line; only a measured overshoot is a crossing.
      crossStopLine(sim, car);
    }
  }
}

/** Inject a vehicle that crosses the stop line on RED for the manual demo control. */
export function addRogueVehicle(sim: Sim, lane: Direction): boolean {
  if (sim.watchdog.failSafeActive || !isLaneRed(sim, lane)) return false;
  const car: Car = {
    id: sim.nextId++,
    lane,
    progress: STOP_LINE[lane],
    released: false,
    arrival: sim.clock,
    releasedAt: null,
    emergency: false,
  };
  sim.cars.push(car);
  crossStopLine(sim, car);
  sim.finished = false;
  return true;
}

export const effectivePriority = (sim: Sim, lane: Direction, aging: boolean): number => {
  const base = sim.priority[lane];
  if (!aging) return base;
  const waited = sim.clock - sim.waitSince[lane];
  return Math.max(0, base - Math.floor(waited / AGING_STEP));
};

/** The scheduler: choose the next lane to get the green light (or null if nothing is waiting). */
export function pickLane(sim: Sim, algo: Algo, aging: boolean): Direction | null {
  const cands = DIRECTIONS.filter((d) => queueLen(sim, d) > 0);
  if (cands.length === 0) return null;

  if (algo !== "STATIC") {
    const starved = cands
      .filter((lane) => sim.starvation[lane] >= STARVATION_LIMIT_SECONDS)
      .sort((a, b) => sim.starvation[b] - sim.starvation[a]);
    if (starved.length > 0) return starved[0];
  }

  switch (algo) {
    case "STATIC": {
      const lastIndex = sim.lastLane ? DIRECTIONS.indexOf(sim.lastLane) : -1;
      return DIRECTIONS[(lastIndex + 1) % DIRECTIONS.length];
    }
    case "RR": {
      for (let i = 1; i <= DIRECTIONS.length; i++) {
        const idx = (sim.rrPtr + i + DIRECTIONS.length) % DIRECTIONS.length;
        if (cands.includes(DIRECTIONS[idx])) return DIRECTIONS[idx];
      }
      return cands[0];
    }
    case "PRIORITY_AGING": {
      return cands.reduce((best, d) => {
        const pd = effectivePriority(sim, d, aging);
        const pb = effectivePriority(sim, best, aging);
        if (pd < pb) return d;
        if (pd === pb && sim.waitSince[d] < sim.waitSince[best]) return d; // longer wait wins ties
        return best;
      });
    }
  }
}

function startSlice(sim: Sim, lane: Direction) {
  if (sim.lastLane && sim.lastLane !== lane) sim.contextSwitches++;
  sim.lastLane = lane;
  sim.active = lane;
  sim.sliceElapsed = 0;
  sim.releaseTimer = HEADWAY; // first vehicle is released immediately
  sim.rrPtr = DIRECTIONS.indexOf(lane);

  const last = sim.segments[sim.segments.length - 1];
  const emergency = sim.emergencyState === "ACTIVE" && sim.emergencyLane === lane;
  if (
    last &&
    last.lane === lane &&
    last.emergency === emergency &&
    last.end === sim.clock
  ) last.end = null;
  else sim.segments.push({ lane, start: sim.clock, end: null, emergency });
}

function endSlice(sim: Sim) {
  const lane = sim.active;
  if (!lane) return;
  const seg = sim.segments[sim.segments.length - 1];
  if (seg && seg.end === null) seg.end = sim.clock;
  sim.waitSince[lane] = sim.clock; // lane goes to the back of the line (aging restarts)
  sim.active = null;
}

function enterFailSafe(sim: Sim) {
  if (sim.active !== null) endSlice(sim);
  if (sim.emergencyState !== "IDLE") {
    sim.emergencyState = "IDLE";
    sim.emergencyId = null;
    sim.emergencyLane = null;
    sim.emergencyGreenElapsed = 0;
    sim.emergencyVehiclesReleased = 0;
    sim.emergencyAmbulancePassed = false;
    sim.emergencyVehicles.forEach((vehicle) => {
      if (vehicle.status === "SAFE_CLEARANCE" || vehicle.status === "PASSING") {
        vehicle.status = "APPROACHING";
      }
    });
  }
  const minimumClearance =
    sim.safety.phase === "ALL_RED" ? Math.max(ALL_RED_SECONDS, sim.safety.remaining) : ALL_RED_SECONDS;
  startAllRed(sim.safety, minimumClearance);
  sim.safety.pendingLane = null;
  sim.logs.push(`FAIL-SAFE ACTIVE: ${sim.watchdog.reason ?? "stale simulation data"}`);
}

export function checkSimulationWatchdog(sim: Sim, now = Date.now()) {
  if (checkWatchdogState(sim.watchdog, now)) {
    enterFailSafe(sim);
    return true;
  }
  return false;
}

export function setSimulationDataStale(
  sim: Sim,
  stale: boolean,
  now = Date.now()
) {
  setSimulatedStaleState(sim.watchdog, stale, now);
}

const ISR_AMBER_SECONDS = 1.5;

function beginEmergencyClearance(sim: Sim, ambulance: EmergencyVehicle) {
  sim.logs.push(`EMERGENCY: ${ambulance.id} detected in ${ambulance.lane} lane`);
  if (sim.active !== null) {
    sim.logs.push(`EMERGENCY: preempting ${sim.active} green -> RED`);
    endSlice(sim);
  }
  sim.emergencyState = "CLEARING_TO_EMERGENCY";
  sim.emergencyId = ambulance.id;
  sim.emergencyLane = ambulance.lane;
  sim.emergencyGreenElapsed = 0;
  sim.emergencyVehiclesReleased = 0;
  sim.emergencyAmbulancePassed = false;
  ambulance.status = "SAFE_CLEARANCE";
  sim.safety.phase = "YELLOW";
  sim.safety.remaining = ISR_AMBER_SECONDS;
  sim.safety.pendingLane = ambulance.lane;
  sim.clearance = sim.safety.remaining;
  sim.logs.push("ISR SAFE CLEARANCE: 1.5s amber, then all-red lock");
}

function tick(sim: Sim, h: number, algo: Algo, quantum: number, aging: boolean) {
  if (sim.finished) return;
  sim.started = true;
  sim.clock += h;
  detectStopLineCrossings(sim);

  if (sim.watchdog.failSafeActive) {
    if (sim.safety.phase !== "ALL_RED") {
      startAllRed(sim.safety, ALL_RED_SECONDS);
      sim.safety.pendingLane = null;
    }
    sim.safety.remaining = Math.max(0, sim.safety.remaining - h);
    advanceReleasedVehicles(sim, h);
    // Recovery requires both the all-red interval and a clear modeled junction.
    if (
      sim.watchdog.recovering &&
      sim.safety.remaining === 0 &&
      junctionClear(sim)
    ) {
      sim.watchdog.failSafeActive = false;
      sim.watchdog.recovering = false;
      sim.watchdog.reason = null;
      sim.logs.push("FAIL-SAFE RECOVERED: valid updates resumed and junction is clear");
    }
    return;
  }

  if (sim.emergencyState === "IDLE" && !sim.watchdog.failSafeActive) {
    const ambulance = sim.emergencyVehicles.find(
      (vehicle) => vehicle.status === "APPROACHING"
    );
    if (ambulance) beginEmergencyClearance(sim, ambulance);
  }

  if (sim.emergencyState === "CLEARING_TO_EMERGENCY") {
    advanceReleasedVehicles(sim, h);
    const ambulance = sim.emergencyVehicles.find((vehicle) => vehicle.id === sim.emergencyId);
    if (ambulance) {
      ambulance.position = Math.min(STOP_LINE[ambulance.lane], ambulance.position + CAR_SPEED * h);
    }
    if (sim.safety.phase === "YELLOW") {
      advanceSafetyPhase(sim.safety, h);
    } else if (sim.safety.phase === "ALL_RED") {
      sim.safety.remaining = Math.max(0, sim.safety.remaining - h);
    }
    sim.clearance = sim.safety.remaining;
    if (
      sim.safety.phase !== "ALL_RED" ||
      sim.safety.remaining > 0 ||
      applySafetyHold(sim.safety, junctionClear(sim), sim.logs)
    ) {
      sim.clearance = sim.safety.remaining;
      return;
    }
    {
      if (!ambulance) {
        sim.emergencyState = "IDLE";
        sim.emergencyId = null;
        return;
      }
      sim.emergencyState = "ACTIVE";
      ambulance.status = "PASSING";
      ambulance.grantedAt = sim.clock;
      sim.ambulanceDelaySum += sim.clock - ambulance.arrivedAt;
      sim.ambulanceDelayCount++;
      sim.safety.phase = "GREEN";
      sim.safety.remaining = MAX_GREEN_SECONDS;
      startSlice(sim, ambulance.lane);
      sim.logs.push(`${ambulance.lane} GREEN (${ambulance.id} emergency passage)`);
    }
    return;
  }

  if (sim.emergencyState === "CLEARING_TO_NORMAL") {
    sim.clearance = Math.max(0, sim.clearance - h);
    sim.safety.remaining = sim.clearance;
    advanceReleasedVehicles(sim, h);
    if (
      sim.clearance === 0 &&
      applySafetyHold(sim.safety, junctionClear(sim), sim.logs)
    ) {
      sim.clearance = sim.safety.remaining;
      return;
    }
    if (sim.clearance === 0) {
      sim.emergencyState = "IDLE";
      sim.emergencyId = null;
      sim.logs.push("EMERGENCY cleared, resuming priority scheduling");
      sim.emergencyLane = null;
      if (sim.recoveryStartedAt !== null) {
        sim.recoveryTime = sim.clock - sim.recoveryStartedAt;
        sim.recoveryStartedAt = null;
      }
      sim.emergencyVehicles.forEach((vehicle) => {
        if (vehicle.status === "RECOVERY") vehicle.status = "CLEARED";
      });
      sim.clearance = startAllRed(sim.safety, 2);
    }
    if (sim.emergencyState !== "IDLE") return;
  }

  if (sim.emergencyState === "IDLE" && !sim.watchdog.failSafeActive) {
    const queuedAmbulance = sim.emergencyVehicles.find(
      (vehicle) => vehicle.status === "APPROACHING"
    );
    if (queuedAmbulance) {
      beginEmergencyClearance(sim, queuedAmbulance);
      return;
    }
  }

  if (sim.emergencyState === "IDLE") {
    // Emergency preemption can interrupt a normal green; resume through all-red.
    if (sim.active === null && sim.safety.phase === "GREEN") {
      sim.safety.phase = "ALL_RED";
      sim.safety.remaining = 2;
      sim.safety.pendingLane = null;
    }

    for (const lane of DIRECTIONS) {
      if (queueLen(sim, lane) > 0 && sim.active !== lane) {
        sim.starvation[lane] += h;
      }
    }

    if (sim.safety.phase !== "GREEN") {
      advanceSafetyPhase(sim.safety, h);
      if (
        sim.safety.phase === "ALL_RED" &&
        sim.safety.remaining === 0 &&
        !applySafetyHold(sim.safety, junctionClear(sim), sim.logs)
      ) {
        const lane =
          sim.safety.pendingLane && queueLen(sim, sim.safety.pendingLane) > 0
            ? sim.safety.pendingLane
            : pickLane(sim, algo, aging);
        if (lane && approveGreenSwitch(sim.safety, sim.active, lane, sim.logs)) {
          startSlice(sim, lane);
          sim.starvation[lane] = 0;
          activateGreen(sim.safety);
          sim.logs.push(`${lane} GREEN`);
        } else if (lane) {
          sim.safety.pendingLane = null;
          sim.safety.remaining = 2;
        }
      }
    }
  }

  // Normal green access is granted only by the safety controller; emergency behavior stays unchanged.
  if (
    (sim.emergencyState === "ACTIVE" || sim.safety.phase === "GREEN") &&
    sim.active
  ) {
    const lane = sim.active;
    sim.sliceElapsed += h;
    sim.releaseTimer += h;
    if (sim.emergencyState === "IDLE") {
      sim.safety.greenElapsed += h;
      sim.safety.remaining = Math.max(0, MAX_GREEN_SECONDS - sim.safety.greenElapsed);
    }

    if (sim.emergencyState === "ACTIVE") {
      sim.emergencyGreenElapsed += h;
      if (!sim.emergencyAmbulancePassed) {
        const ambulance = sim.emergencyVehicles.find(
          (vehicle) => vehicle.id === sim.emergencyId
        );
        if (ambulance) {
          ambulance.position = Math.min(100, ambulance.position + CAR_SPEED * h);
          if (ambulance.position >= 100) {
            ambulance.status = "CLEARED";
            ambulance.clearedAt = sim.clock;
            sim.emergencyAmbulancePassed = true;
            sim.logs.push(`${ambulance.id} cleared the intersection`);
          }
        }
      } else {
        while (
          sim.releaseTimer >= HEADWAY - 1e-9 &&
          queueOf(sim, lane).some((car) => !car.emergency) &&
          sim.emergencyVehiclesReleased < 6
        ) {
          const head = queueOf(sim, lane).find((car) => !car.emergency);
          if (!head) break;
          crossStopLine(sim, head);
          sim.releaseTimer -= HEADWAY;
          sim.emergencyVehiclesReleased++;
        }
      }
    } else {
      const expired = sim.sliceElapsed >= quantum - 1e-9;
      if (!expired || sim.safety.greenElapsed < MIN_GREEN_SECONDS) {
        while (sim.releaseTimer >= HEADWAY - 1e-9 && queueLen(sim, lane) > 0) {
          const head = queueOf(sim, lane)[0];
          crossStopLine(sim, head);
          sim.releaseTimer -= HEADWAY;
        }
      }
      // A lane is only "done" once its last vehicle has had its full service time (HEADWAY) on green.
      const empty = queueLen(sim, lane) === 0 && sim.releaseTimer >= HEADWAY - 1e-9;
      const maxGreenReached = sim.safety.greenElapsed >= MAX_GREEN_SECONDS - 1e-9;
      if (
        maxGreenReached ||
        ((expired || empty) && sim.safety.greenElapsed >= MIN_GREEN_SECONDS)
      ) {
        const next = pickLane(sim, algo, aging);
        if (next === lane && !empty && !maxGreenReached) {
          sim.sliceElapsed = 0;
        } else {
          endSlice(sim);
          beginSafetySwitch(sim.safety, next);
        }
      }
    }
  }

  // 3) Move the vehicles.
  for (const lane of DIRECTIONS) {
    if (sim.emergencyState !== "IDLE" && lane !== sim.active) continue;
    queueOf(sim, lane).forEach((c, k) => {
      const target = slotPos(lane, k);
      if (c.progress < target) c.progress = Math.min(target, c.progress + CAR_SPEED * h);
    });
  }
  const remaining: Car[] = [];
  for (const c of sim.cars) {
    if (c.released) {
      if (sim.emergencyState !== "IDLE" && c.lane !== sim.active && !c.rogue) {
        remaining.push(c);
        continue;
      }
      c.progress += CAR_SPEED * h;
      if (c.progress >= 100) {
        if (!c.rogue) {
          // violators don't count in normal stats
          sim.served++;
          if (!c.emergency) sim.ordinaryServed++;
          sim.waitSum += (c.releasedAt ?? sim.clock) - c.arrival;
          sim.tatSum += sim.clock - c.arrival;
        }
        continue; // left the canvas
      }
    }
    remaining.push(c);
  }
  sim.cars = remaining;

  if (
    sim.emergencyState === "ACTIVE" &&
    sim.emergencyLane !== null &&
    ((sim.emergencyAmbulancePassed &&
      !queueOf(sim, sim.emergencyLane).some((car) => !car.emergency)) ||
      sim.emergencyVehiclesReleased >= 6 ||
      sim.emergencyGreenElapsed >= 8)
  ) {
    endSlice(sim);
    const ambulance = sim.emergencyVehicles.find((vehicle) => vehicle.id === sim.emergencyId);
    if (ambulance?.status === "CLEARED") ambulance.status = "RECOVERY";
    sim.recoveryStartedAt = sim.clock;
    sim.emergencyId = null;
    sim.emergencyState = "CLEARING_TO_NORMAL";
    sim.clearance = startAllRed(sim.safety, 1.5);
    sim.logs.push("ALL-RED clearance");
  }

  // 4) Done?
  if (
    sim.cars.length === 0 &&
    sim.active === null &&
    sim.emergencyState === "IDLE" &&
    sim.safety.phase === "ALL_RED" &&
    sim.safety.remaining === 0
  ) {
    sim.finished = true;
  }
}

/** Advance the simulation by `dt` seconds (internally split into small steps). */
export function step(sim: Sim, dt: number, algo: Algo, quantum: number, aging: boolean) {
  const H = 0.05;
  let left = dt;
  recordWatchdogUpdate(sim.watchdog);
  while (left > 1e-9 && !sim.finished) {
    const h = Math.min(H, left);
    tick(sim, h, algo, quantum, aging);
    left -= h;
  }
}

/** Plain-data copy for React state. */
export function snapshot(sim: Sim) {
  const violationLog = sim.violationLog.map((entry) => ({ ...entry }));
  const pendingAmbulances = sim.emergencyVehicles.filter(
    (vehicle) =>
      vehicle.grantedAt === null &&
      vehicle.status !== "CLEARED" &&
      vehicle.status !== "RECOVERY"
  );
  const ambulanceDelayCount = sim.ambulanceDelayCount + pendingAmbulances.length;
  const ambulanceDelaySum =
    sim.ambulanceDelaySum +
    pendingAmbulances.reduce((total, vehicle) => total + sim.clock - vehicle.arrivedAt, 0);
  return {
    clock: sim.clock,
    cars: sim.cars.map((c) => ({ ...c })),
    active: sim.active,
    clearing:
      sim.emergencyState === "CLEARING_TO_EMERGENCY" ||
      sim.emergencyState === "CLEARING_TO_NORMAL" ||
      sim.safety.phase === "YELLOW" ||
      sim.safety.phase === "ALL_RED",
    signalPhase: (
      sim.emergencyState === "CLEARING_TO_NORMAL"
        ? "ALL_RED"
        : sim.emergencyState === "ACTIVE"
        ? "GREEN"
        : sim.safety.phase
    ) as SignalPhase,
    phaseRemaining:
      sim.emergencyState === "CLEARING_TO_EMERGENCY" ||
      sim.emergencyState === "CLEARING_TO_NORMAL"
        ? sim.clearance
        : sim.emergencyState === "ACTIVE"
        ? Math.max(0, 8 - sim.emergencyGreenElapsed)
        : sim.safety.remaining,
    lastLane: sim.lastLane,
    emergencyState: sim.emergencyState,
    emergencyVehicles: sim.emergencyVehicles.map((vehicle) => ({ ...vehicle })),
    ambulanceDelay:
      ambulanceDelayCount > 0 ? ambulanceDelaySum / ambulanceDelayCount : 0,
    recoveryTime:
      sim.recoveryStartedAt === null
        ? sim.recoveryTime
        : sim.clock - sim.recoveryStartedAt,
    ordinaryServed: sim.ordinaryServed,
    segments: sim.segments.map((s) => ({ ...s })),
    logs: [...sim.logs],
    contextSwitches: sim.contextSwitches,
    served: sim.served,
    avgWait: sim.served ? sim.waitSum / sim.served : 0,
    avgTat: sim.served ? sim.tatSum / sim.served : 0,
    throughput: sim.clock > 0 ? (sim.served / sim.clock) * 60 : 0,
    queued: {
      NORTH: queueLen(sim, "NORTH"),
      EAST: queueLen(sim, "EAST"),
      SOUTH: queueLen(sim, "SOUTH"),
      WEST: queueLen(sim, "WEST"),
    } as Record<Direction, number>,
    laneWait: DIRECTIONS.reduce((waits, lane) => {
      waits[lane] =
        queueLen(sim, lane) > 0 ? Math.max(0, sim.clock - sim.waitSince[lane]) : 0;
      return waits;
    }, {} as Record<Direction, number>),
    agingMultiplier: DIRECTIONS.reduce((multipliers, lane) => {
      const wait = queueLen(sim, lane) > 0 ? Math.max(0, sim.clock - sim.waitSince[lane]) : 0;
      multipliers[lane] = 1 + Math.floor(wait / AGING_STEP) * 0.25;
      return multipliers;
    }, {} as Record<Direction, number>),
    starvation: { ...sim.starvation },
    violations: sim.violations,
    challans: sim.challans.map((challan) => ({ ...challan })),
    violationLog,
    allRedExtension: sim.safety.allRedExtension,
    junctionClear: junctionClear(sim),
    safetyHoldActive:
      sim.safety.phase === "ALL_RED" && sim.safety.allRedExtension > 0,
    safetyHoldPending: sim.safety.pendingViolationExtension > 0,
    watchdog: { ...sim.watchdog },
    maxLaneWait: Math.max(
      0,
      ...DIRECTIONS.filter((d) => queueLen(sim, d) > 0 && sim.active !== d).map(
        (d) => sim.clock - sim.waitSince[d]
      )
    ),
    started: sim.started,
    finished: sim.finished,
  };
}
export type Snapshot = ReturnType<typeof snapshot>;