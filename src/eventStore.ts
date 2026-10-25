export type EventType =
  | "SIGNAL"
  | "SAFETY"
  | "EMERGENCY"
  | "ACCIDENT"
  | "SCHEDULER";
export type EventSeverity = "info" | "warn" | "critical";

export interface TrafficEvent {
  id: number;
  simTime: string;
  wallTime: string;
  type: EventType;
  severity: EventSeverity;
  lane?: string;
  message: string;
}

export type EventInput = Omit<TrafficEvent, "id" | "simTime" | "wallTime">;

const MAX_EVENTS = 300;
let events: TrafficEvent[] = [];
let nextId = 1;
let simulationTime = 0;
const listeners = new Set<() => void>();

const formatSimTime = (seconds: number) => {
  const total = Math.floor(Math.max(0, seconds));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(
    total % 60
  ).padStart(2, "0")}`;
};

export const setEventSimTime = (seconds: number) => {
  simulationTime = seconds;
};

export const addEvent = (input: EventInput): TrafficEvent => {
  const entry: TrafficEvent = {
    ...input,
    id: nextId++,
    simTime: formatSimTime(simulationTime),
    wallTime: new Date().toLocaleTimeString("en-GB", {
      hour12: false,
    }),
  };
  events = [...events, entry].slice(-MAX_EVENTS);
  listeners.forEach((listener) => listener());
  return entry;
};

export const getEvents = () => events;

export const subscribeToEvents = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
