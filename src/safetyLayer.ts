import type { Direction } from "./simEngine";

export type SignalPhase = "GREEN" | "YELLOW" | "ALL_RED";

export const MIN_GREEN_SECONDS = 5;
export const MAX_GREEN_SECONDS = 30;
export const YELLOW_SECONDS = 3;
export const ALL_RED_SECONDS = 2;
export const STARVATION_LIMIT_SECONDS = 30;

export interface SafetyState {
  phase: SignalPhase;
  remaining: number;
  pendingLane: Direction | null;
  greenElapsed: number;
}

export const createSafetyState = (): SafetyState => ({
  phase: "ALL_RED",
  remaining: ALL_RED_SECONDS,
  pendingLane: null,
  greenElapsed: 0,
});

export function beginSafetySwitch(state: SafetyState, nextLane: Direction | null) {
  state.phase = "YELLOW";
  state.remaining = YELLOW_SECONDS;
  state.pendingLane = nextLane;
}

export function advanceSafetyPhase(state: SafetyState, elapsed: number) {
  if (state.phase === "GREEN") return;
  state.remaining = Math.max(0, state.remaining - elapsed);
  if (state.phase === "YELLOW" && state.remaining === 0) {
    state.phase = "ALL_RED";
    state.remaining = ALL_RED_SECONDS;
  }
}

export function approveGreenSwitch(
  state: SafetyState,
  currentGreen: Direction | null,
  nextLane: Direction,
  logs: string[]
): boolean {
  const currentAxis =
    currentGreen === "NORTH" || currentGreen === "SOUTH" ? "N/S" : "E/W";
  const nextAxis = nextLane === "NORTH" || nextLane === "SOUTH" ? "N/S" : "E/W";
  if (currentGreen !== null || state.phase !== "ALL_RED") {
    const conflict = currentGreen !== null && currentAxis !== nextAxis;
    logs.push(
      `SAFETY_FAULT: blocked ${nextLane} GREEN; ${
        conflict ? `${currentAxis} conflicts with ${nextAxis}` : `${currentGreen ?? state.phase} holds the junction mutex`
      }`
    );
    return false;
  }
  return true;
}

export function activateGreen(state: SafetyState) {
  state.phase = "GREEN";
  state.remaining = MAX_GREEN_SECONDS;
  state.pendingLane = null;
  state.greenElapsed = 0;
}
