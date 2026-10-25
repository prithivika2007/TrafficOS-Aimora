export type JunctionId = "A" | "B" | "C" | "D";

export interface NetworkRoad {
  id: string;
  from: JunctionId;
  to: JunctionId;
  capacity: number;
}

export interface NetworkVehicle {
  id: number;
  route: string[];
  roadIndex: number;
  bornAt: number;
}

export interface NetworkLinkState {
  roadId: string;
  from: JunctionId;
  to: JunctionId;
  capacity: number;
  vehicleCount: number;
  directionalQueueLength: number;
  queueLength: number;
  spillback: boolean;
}

export interface SignalSafetyInspection {
  clear: boolean;
  conflicts: string[];
  logs: string[];
}

export type NetworkAlgorithm = "ROUND_ROBIN" | "PRIORITY_AGING";

export interface NetworkState {
  tick: number;
  roads: Record<string, NetworkVehicle[]>;
  links: Record<string, NetworkLinkState>;
  demand: Record<JunctionId, NetworkVehicle[]>;
  phases: Record<JunctionId, number>;
  phaseTicks: Record<JunctionId, number>;
  laneWaitTicks: Record<string, number>;
  blockedRoads: Record<string, boolean>;
  roadBlocks: Record<string, boolean>;
  spillbackEvents: { tick: number; roadId: string }[];
  served: number;
  waitSeconds: number;
  travelSeconds: number;
  maxQueue: number;
  spillbacks: number;
}

export const JUNCTIONS: JunctionId[] = ["A", "B", "C", "D"];
export const SCENARIO_SEED = 2026;
export const MAX_CAPACITY = 12;
export const ROAD_CAPACITY = MAX_CAPACITY;
export const JUNCTION_NAMES: Record<JunctionId, string> = {
  A: "Market & 8th",
  B: "Mission & 5th",
  C: "Mission & 8th",
  D: "Market & 5th",
};
const COORDINATION_CAPACITY_THRESHOLD = 0.75;
export const ROAD_DEFINITIONS: NetworkRoad[] = [
  { id: "AB", from: "A", to: "B", capacity: ROAD_CAPACITY },
  { id: "BA", from: "B", to: "A", capacity: ROAD_CAPACITY },
  { id: "AC", from: "A", to: "C", capacity: ROAD_CAPACITY },
  { id: "CA", from: "C", to: "A", capacity: ROAD_CAPACITY },
  { id: "BD", from: "B", to: "D", capacity: ROAD_CAPACITY },
  { id: "DB", from: "D", to: "B", capacity: ROAD_CAPACITY },
  { id: "CD", from: "C", to: "D", capacity: ROAD_CAPACITY },
  { id: "DC", from: "D", to: "C", capacity: ROAD_CAPACITY },
];

const ROUTES: Record<JunctionId, string[][]> = {
  A: [["AB", "BD"], ["AC", "CD"]],
  B: [["BA", "AC"], ["BD", "DC"]],
  C: [["CA", "AB"], ["CD", "DB"]],
  D: [["DB", "BA"], ["DC", "CA"]],
};

export type NetworkMode = "independent" | "coordinated";

export const createNetworkState = (): NetworkState => ({
  tick: 0,
  roads: Object.fromEntries(ROAD_DEFINITIONS.map((road) => [road.id, []])),
  links: Object.fromEntries(
    ROAD_DEFINITIONS.map((road) => [
      road.id,
      {
        roadId: road.id,
        from: road.from,
        to: road.to,
        capacity: road.capacity,
        vehicleCount: 0,
        directionalQueueLength: 0,
        queueLength: 0,
        spillback: false,
      },
    ])
  ),
  demand: { A: [], B: [], C: [], D: [] },
  phases: { A: 0, B: 1, C: 0, D: 1 },
  phaseTicks: { A: 0, B: 0, C: 0, D: 0 },
  laneWaitTicks: Object.fromEntries(ROAD_DEFINITIONS.map((road) => [road.id, 0])),
  blockedRoads: Object.fromEntries(ROAD_DEFINITIONS.map((road) => [road.id, false])),
  roadBlocks: Object.fromEntries(ROAD_DEFINITIONS.map((road) => [road.id, false])),
  spillbackEvents: [],
  served: 0,
  waitSeconds: 0,
  travelSeconds: 0,
  maxQueue: 0,
  spillbacks: 0,
});

const arrivalAt = (tick: number, junctionIndex: number): boolean => {
  const value = (tick * 17 + junctionIndex * 29 + SCENARIO_SEED) % 23;
  return value < 7;
};

export const stepNetwork = (
  state: NetworkState,
  mode: NetworkMode,
  algorithm: NetworkAlgorithm = "ROUND_ROBIN"
): NetworkState => {
  const next: NetworkState = {
    ...state,
    tick: state.tick + 1,
    roads: Object.fromEntries(
      Object.entries(state.roads).map(([id, vehicles]) => [
        id,
        vehicles.map((vehicle) => ({ ...vehicle, route: [...vehicle.route] })),
      ])
    ),
    links: Object.fromEntries(
      Object.entries(state.links).map(([id, link]) => [id, { ...link }])
    ),
    demand: Object.fromEntries(
      JUNCTIONS.map((junction) => [
        junction,
        state.demand[junction].map((vehicle) => ({ ...vehicle, route: [...vehicle.route] })),
      ])
    ) as Record<JunctionId, NetworkVehicle[]>,
    phases: { ...state.phases },
    phaseTicks: { ...state.phaseTicks },
    laneWaitTicks: { ...state.laneWaitTicks },
    blockedRoads: { ...state.blockedRoads },
    roadBlocks: { ...state.roadBlocks },
    spillbackEvents: [...state.spillbackEvents],
  };
  const seconds = next.tick * 0.5;
  const reroute = (
    vehicle: NetworkVehicle,
    from: JunctionId,
    destination: JunctionId,
    currentRoadId?: string
  ): boolean => {
    const detour = findOpenPath(from, destination, next.roadBlocks);
    if (!detour) return false;
    vehicle.route = currentRoadId ? [currentRoadId, ...detour] : detour;
    vehicle.roadIndex = 0;
    return true;
  };

  Object.entries(next.roads).forEach(([roadId, vehicles]) => {
    const road = ROAD_DEFINITIONS.find((item) => item.id === roadId);
    if (!road) return;
    vehicles.forEach((vehicle) => {
      const destination = ROAD_DEFINITIONS.find(
        (item) => item.id === vehicle.route[vehicle.route.length - 1]
      )?.to;
      const downstreamId = vehicle.route[vehicle.roadIndex + 1];
      if (destination && downstreamId && next.roadBlocks[downstreamId]) {
        reroute(vehicle, road.to, destination, roadId);
      }
    });
  });

  const eligibleHeads = Object.fromEntries(
    ROAD_DEFINITIONS.map((road) => [road.id, state.roads[road.id][0]?.id])
  ) as Record<string, number | undefined>;
  const spillbackObserved = Object.fromEntries(
    ROAD_DEFINITIONS.map((road) => [road.id, false])
  ) as Record<string, boolean>;

  JUNCTIONS.forEach((junction, junctionIndex) => {
    if (!arrivalAt(next.tick, junctionIndex)) return;
    const options = ROUTES[junction];
    const route = options[(next.tick + junctionIndex + SCENARIO_SEED) % options.length];
    const destination = ROAD_DEFINITIONS.find((road) => road.id === route[route.length - 1])?.to;
    const path = destination ? findOpenPath(junction, destination, next.roadBlocks) : null;
    if (!path) {
      next.demand[junction].push({
        id: next.tick * 4 + junctionIndex,
        route: [...route],
        roadIndex: 0,
        bornAt: seconds,
      });
      return;
    }
    next.demand[junction].push({
      id: next.tick * 4 + junctionIndex,
      route: path,
      roadIndex: 0,
      bornAt: seconds,
    });
  });

  JUNCTIONS.forEach((junction) => {
    while (next.demand[junction].length > 0) {
      const vehicle = next.demand[junction][0];
      if (vehicle.route.some((roadId) => next.roadBlocks[roadId])) {
        const destination = ROAD_DEFINITIONS.find(
          (road) => road.id === vehicle.route[vehicle.route.length - 1]
        )?.to;
        if (!destination || !reroute(vehicle, junction, destination)) break;
      }
      const targetRoad = vehicle.route[0];
      if (next.roads[targetRoad].length >= ROAD_CAPACITY) {
        spillbackObserved[targetRoad] = true;
        break;
      }
      const released = next.demand[junction].shift();
      if (!released) break;
      next.roads[targetRoad].push(released);
    }
  });

  const selectedMovements: { road: NetworkRoad; vehicle: NetworkVehicle }[] = [];

  JUNCTIONS.forEach((junction) => {
    const incoming = ROAD_DEFINITIONS.filter((road) => road.to === junction);
    const phase = next.phases[junction];
    const hasVehicle = (road: NetworkRoad): boolean =>
      Boolean(next.roads[road.id][0] && next.roads[road.id][0].id === eligibleHeads[road.id]);
    const canAdvance = (road: NetworkRoad): boolean => {
      const vehicle = next.roads[road.id][0];
      if (!vehicle || vehicle.id !== eligibleHeads[road.id]) return false;
      const downstreamId = vehicle.route[vehicle.roadIndex + 1];
      if (!downstreamId) return true;
      if (next.roadBlocks[downstreamId]) return false;
      const downstreamCapacity = roadCapacity(downstreamId);
      const downstreamCount = next.roads[downstreamId].length;
      if (downstreamCount >= downstreamCapacity) return false;
      return mode === "independent" ||
        downstreamCount / downstreamCapacity < COORDINATION_CAPACITY_THRESHOLD;
    };
    const localCandidates = incoming.filter(
      (road) => hasVehicle(road) && canAdvance(road)
    );
    const coordinatedCandidates = incoming.filter((road) => hasVehicle(road) && canAdvance(road));
    const candidates = mode === "coordinated" ? coordinatedCandidates : localCandidates;

    if (algorithm === "PRIORITY_AGING") {
      if (candidates.length > 0) {
        const selected = candidates.reduce((best, road) => {
          const score =
            next.roads[road.id].length * 10 + next.laneWaitTicks[road.id];
          const bestScore =
            next.roads[best.id].length * 10 + next.laneWaitTicks[best.id];
          return score > bestScore ? road : best;
        });
        const selectedIndex = incoming.indexOf(selected);
        if (selectedIndex !== next.phases[junction]) next.phaseTicks[junction] = 0;
        next.phases[junction] = selectedIndex;
      }
    } else if (mode === "independent") {
      next.phaseTicks[junction] += 1;
      if (next.phaseTicks[junction] >= 6) {
        next.phases[junction] = (phase + 1) % incoming.length;
        next.phaseTicks[junction] = 0;
      }
    } else {
      const activeRoad = incoming[phase % incoming.length];
      const activeIsViable = candidates.some((road) => road.id === activeRoad.id);
      const alternatives = candidates.filter((road) => road.id !== activeRoad.id);
      next.phaseTicks[junction] += 1;
      if (!activeIsViable && alternatives.length > 0) {
        next.phases[junction] = incoming.indexOf(
          alternatives.reduce((largest, road) =>
            next.roads[road.id].length > next.roads[largest.id].length ? road : largest
          )
        );
        next.phaseTicks[junction] = 0;
      } else if (next.phaseTicks[junction] >= 12 && alternatives.length > 0) {
        next.phases[junction] = incoming.indexOf(
          alternatives.reduce((largest, road) =>
            next.roads[road.id].length > next.roads[largest.id].length ? road : largest
          )
        );
        next.phaseTicks[junction] = 0;
      }
    }

    const greenRoad = incoming[next.phases[junction] % incoming.length];
    const vehicle = next.roads[greenRoad.id][0];
    if (!vehicle || vehicle.id !== eligibleHeads[greenRoad.id]) return;
    selectedMovements.push({ road: greenRoad, vehicle });
  });

  ROAD_DEFINITIONS.forEach((road) => {
    const vehicle = next.roads[road.id][0];
    const downstreamId = vehicle?.route[vehicle.roadIndex + 1];
    if (
    vehicle &&
    vehicle.id === eligibleHeads[road.id] &&
    downstreamId &&
    next.roads[downstreamId].length >= roadCapacity(downstreamId)
    ) {
    spillbackObserved[road.id] = true;
    }
  });

  selectedMovements.forEach(({ road, vehicle }) => {
    const downstreamId = vehicle.route[vehicle.roadIndex + 1];
    if (!downstreamId) {
      next.roads[road.id].shift();
      next.served += 1;
      next.travelSeconds += seconds - vehicle.bornAt;
      return;
    }
    const downstreamCapacity = roadCapacity(downstreamId);
    const downstreamCount = next.roads[downstreamId].length;
    if (downstreamCount >= downstreamCapacity) {
      spillbackObserved[road.id] = true;
      return;
    }
    if (next.roadBlocks[downstreamId]) return;
    if (
      mode === "coordinated" &&
      downstreamCount / downstreamCapacity >= COORDINATION_CAPACITY_THRESHOLD
    ) return;
    next.roads[road.id].shift();
    vehicle.roadIndex += 1;
    next.roads[downstreamId].push(vehicle);
  });

  ROAD_DEFINITIONS.forEach((road) => {
    const head = next.roads[road.id][0];
    const downstreamId = head?.route[head.roadIndex + 1];
    const blocked = spillbackObserved[road.id] || Boolean(
      head &&
      downstreamId &&
      next.roads[downstreamId].length >= roadCapacity(downstreamId)
    );
    if (blocked && !state.blockedRoads[road.id]) {
      next.spillbacks += 1;
      next.spillbackEvents.push({ tick: next.tick, roadId: road.id });
    }
    next.blockedRoads[road.id] = blocked;
    next.links[road.id] = {
      roadId: road.id,
      from: road.from,
      to: road.to,
      capacity: road.capacity,
      vehicleCount: next.roads[road.id].length,
      directionalQueueLength:
        next.roads[road.id].length +
        next.demand[road.from].filter((vehicle) => vehicle.route[0] === road.id).length,
      queueLength:
        next.roads[road.id].length +
        next.demand[road.from].filter((vehicle) => vehicle.route[0] === road.id).length,
      spillback: blocked,
    };
    if (next.roads[road.id].length > 0) {
      next.laneWaitTicks[road.id] += 1;
    } else {
      next.laneWaitTicks[road.id] = 0;
    }
  });

  Object.values(next.roads).forEach((vehicles) => {
    next.waitSeconds += vehicles.length * 0.5;
  });
  JUNCTIONS.forEach((junction) => {
    next.waitSeconds += next.demand[junction].length * 0.5;
    const incomingCount = ROAD_DEFINITIONS.filter((road) => road.to === junction)
      .reduce((sum, road) => sum + next.roads[road.id].length, 0);
    next.maxQueue = Math.max(
      next.maxQueue,
      next.demand[junction].length + incomingCount
    );
  });
  return next;
};

function roadCapacity(roadId: string): number {
  return ROAD_DEFINITIONS.find((road) => road.id === roadId)?.capacity ?? ROAD_CAPACITY;
}

export const networkMetrics = (state: NetworkState) => ({
  averageWait: state.served ? state.waitSeconds / state.served : 0,
  throughput: state.tick ? (state.served / (state.tick * 0.5)) * 60 : 0,
  maxQueue: state.maxQueue,
  spillbacks: state.spillbacks,
  travelTime: state.served ? state.travelSeconds / state.served : 0,
});

export const roadDensity = (state: NetworkState, roadId: string): number =>
  (state.links[roadId]?.vehicleCount ?? state.roads[roadId]?.length ?? 0) /
  (state.links[roadId]?.capacity ?? roadCapacity(roadId));

function findOpenPath(
  start: JunctionId,
  destination: JunctionId,
  roadBlocks: Record<string, boolean>
): string[] | null {
  if (start === destination) return [];
  const paths: { junction: JunctionId; roads: string[] }[] = [{ junction: start, roads: [] }];
  const visited = new Set<JunctionId>([start]);
  while (paths.length > 0) {
    const current = paths.shift();
    if (!current) break;
    const outgoing = ROAD_DEFINITIONS.filter(
      (road) => road.from === current.junction && !roadBlocks[road.id]
    );
    for (const road of outgoing) {
      const roads = [...current.roads, road.id];
      if (road.to === destination) return roads;
      if (visited.has(road.to)) continue;
      visited.add(road.to);
      paths.push({ junction: road.to, roads });
    }
  }
  return null;
}

export function inspectSignalSafety(state: NetworkState): SignalSafetyInspection {
  const conflicts: string[] = [];
  const logs = JUNCTIONS.map((junction) => {
    const approaches = ROAD_DEFINITIONS.filter((road) => road.to === junction);
    const phase = state.phases[junction];
    if (!Number.isInteger(phase) || phase < 0 || phase >= approaches.length) {
      conflicts.push(`Junction ${junction} has an invalid signal phase (${phase}).`);
      return `Junction ${junction}: invalid phase ${phase}; inspection failed.`;
    }
    const active = approaches.filter((_, index) => index === phase);
    if (active.length > 1) {
      conflicts.push(`Junction ${junction} has conflicting green approaches.`);
    }
    return `Junction ${junction}: ${active.length} green approach active; 0 conflicting greens.`;
  });
  return { clear: conflicts.length === 0, conflicts, logs };
}
