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
  approveGreenSwitch,
  beginSafetySwitch,
  createSafetyState,
  MAX_GREEN_SECONDS,
  MIN_GREEN_SECONDS,
  STARVATION_LIMIT_SECONDS,
} from "./safetyLayer";
import type {
  SafetyState,
  SignalPhase,
} from "./safetyLayer";

export type Direction = "NORTH" | "EAST" | "SOUTH" | "WEST";
export type Algo = "RR" | "PRIORITY_AGING";
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
}

export interface Segment {
  lane: Direction;
  start: number;
  end: number | null; // null = still green
  emergency: boolean;
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
  segments: Segment[];
  contextSwitches: number;
  served: number;
  waitSum: number;
  tatSum: number;
  emergencyId: number | null;
  emergencyLane: Direction | null;
  emergencyState: EmergencyState;
  emergencyGreenElapsed: number;
  emergencyVehiclesReleased: number;
  emergencyAmbulancePassed: boolean;
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
    segments: [],
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
  }
  if (emergencyLane) {
    const car: Car = {
      id: sim.nextId++,
      lane: emergencyLane,
      progress: slotPos(emergencyLane, 0),
      released: false,
      arrival: 0,
      releasedAt: null,
      emergency: true,
    };
    sim.cars.push(car);
  }
  return sim;
}

/** Enqueue one more vehicle on a lane while the simulation is live. */
export function addVehicle(sim: Sim, lane: Direction, emergency = false): boolean {
  const k = queueLen(sim, lane);
  if (!emergency && k >= MAX_PER_LANE) return false;
  if (k === 0) sim.waitSince[lane] = sim.clock; // lane just became "ready"
  const car: Car = {
    id: sim.nextId++,
    lane,
    progress: 0, // drives in from the edge to the back of the queue
    released: false,
    arrival: sim.clock,
    releasedAt: null,
    emergency,
  };
  sim.cars.push(car);
  if (emergency && sim.started && sim.emergencyState === "IDLE") {
    beginEmergencyClearance(sim, car);
  }
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

  const starved = cands
    .filter((lane) => sim.starvation[lane] >= STARVATION_LIMIT_SECONDS)
    .sort((a, b) => sim.starvation[b] - sim.starvation[a]);
  if (starved.length > 0) return starved[0];

  switch (algo) {
    case "RR": {
      for (let i = 1; i <= DIRECTIONS.length; i++) {
        const idx = (sim.rrPtr + i + DIRECTIONS.length) % DIRECTIONS.length;
        if (cands.includes(DIRECTIONS[idx])) return DIRECTIONS[idx];
      }
      return cands[0];
    }
    case "PRIORITY_AGING": {
      const emergency = cands.find((lane) =>
        queueOf(sim, lane).some((car) => car.emergency)
      );
      if (emergency) return emergency;
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
  const emergency =
    (sim.emergencyState === "ACTIVE" && sim.emergencyLane === lane) ||
    queueOf(sim, lane).some((car) => car.emergency);
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

function beginEmergencyClearance(sim: Sim, ambulance: Car) {
  sim.logs.push(`EMERGENCY: ambulance detected in ${ambulance.lane} lane`);
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
  sim.clearance = 1.5;
  sim.logs.push("ALL-RED clearance");
}

function tick(sim: Sim, h: number, algo: Algo, quantum: number, aging: boolean) {
  if (sim.finished) return;
  sim.started = true;
  sim.clock += h;

  if (algo === "PRIORITY_AGING" && sim.emergencyState === "IDLE") {
    const ambulance = sim.cars.find((car) => car.emergency && !car.released);
    if (ambulance) beginEmergencyClearance(sim, ambulance);
  }

  if (sim.emergencyState === "CLEARING_TO_EMERGENCY") {
    sim.clearance = Math.max(0, sim.clearance - h);
    if (sim.clearance === 0) {
      const ambulance = sim.cars.find((car) => car.id === sim.emergencyId);
      if (!ambulance) {
        sim.emergencyState = "IDLE";
        sim.emergencyId = null;
        return;
      }
      sim.emergencyState = "ACTIVE";
      startSlice(sim, ambulance.lane);
      sim.logs.push(`${ambulance.lane} GREEN (emergency)`);
    }
    return;
  }

  if (sim.emergencyState === "CLEARING_TO_NORMAL") {
    sim.clearance = Math.max(0, sim.clearance - h);
    if (sim.clearance === 0) {
      sim.emergencyState = "IDLE";
      sim.emergencyId = null;
      sim.logs.push("EMERGENCY cleared, resuming priority scheduling");
      sim.emergencyLane = null;
      sim.safety.phase = "ALL_RED";
      sim.safety.remaining = 2;
      sim.safety.pendingLane = null;
    }
    if (sim.emergencyState !== "IDLE") return;
  }

  if (algo === "PRIORITY_AGING" && sim.emergencyState === "IDLE") {
    const queuedAmbulance = sim.cars.find((car) => car.emergency && !car.released);
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
      if (sim.safety.phase === "ALL_RED" && sim.safety.remaining === 0) {
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
        const ambulance = sim.cars.find((car) => car.id === sim.emergencyId);
        if (ambulance?.released) sim.releaseTimer = 0;
        if (ambulance && !ambulance.released && sim.releaseTimer >= HEADWAY - 1e-9) {
          ambulance.released = true;
          ambulance.releasedAt = sim.clock;
          sim.releaseTimer -= HEADWAY;
        }
      } else {
        while (
          sim.releaseTimer >= HEADWAY - 1e-9 &&
          queueOf(sim, lane).some((car) => !car.emergency) &&
          sim.emergencyVehiclesReleased < 6
        ) {
          const head = queueOf(sim, lane).find((car) => !car.emergency);
          if (!head) break;
          head.released = true;
          head.releasedAt = sim.clock;
          sim.releaseTimer -= HEADWAY;
          sim.emergencyVehiclesReleased++;
        }
      }
    } else {
      const preemptive = algo === "RR" || algo === "PRIORITY_AGING";
      const expired = preemptive && sim.sliceElapsed >= quantum - 1e-9;
      if (!expired || sim.safety.greenElapsed < MIN_GREEN_SECONDS) {
        while (sim.releaseTimer >= HEADWAY - 1e-9 && queueLen(sim, lane) > 0) {
          const head = queueOf(sim, lane)[0];
          head.released = true;
          head.releasedAt = sim.clock;
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
      if (sim.emergencyState !== "IDLE" && c.lane !== sim.active) {
        remaining.push(c);
        continue;
      }
      c.progress += CAR_SPEED * h;
      if (c.progress >= 100) {
        sim.served++;
        sim.waitSum += (c.releasedAt ?? sim.clock) - c.arrival;
        sim.tatSum += sim.clock - c.arrival;
        continue; // left the canvas
      }
    }
    remaining.push(c);
  }
  sim.cars = remaining;

  if (
    sim.emergencyState === "ACTIVE" &&
    sim.emergencyId !== null &&
    !sim.cars.some((car) => car.id === sim.emergencyId) &&
    !sim.emergencyAmbulancePassed
  ) {
    sim.emergencyAmbulancePassed = true;
    sim.emergencyId = null;
    if (sim.emergencyLane) {
      sim.logs.push(
        `Ambulance cleared, ${sim.emergencyLane} still GREEN, releasing remaining vehicles`
      );
    }
  }

  if (
    sim.emergencyState === "ACTIVE" &&
    sim.emergencyLane !== null &&
    ((sim.emergencyAmbulancePassed &&
      !queueOf(sim, sim.emergencyLane).some((car) => !car.emergency)) ||
      sim.emergencyVehiclesReleased >= 6 ||
      sim.emergencyGreenElapsed >= 8)
  ) {
    endSlice(sim);
    sim.emergencyId = null;
    sim.emergencyState = "CLEARING_TO_NORMAL";
    sim.clearance = 1.5;
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
  while (left > 1e-9 && !sim.finished) {
    const h = Math.min(H, left);
    tick(sim, h, algo, quantum, aging);
    left -= h;
  }
}

/** Plain-data copy for React state. */
export function snapshot(sim: Sim) {
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
      sim.emergencyState === "CLEARING_TO_EMERGENCY" ||
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
    starvation: { ...sim.starvation },
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