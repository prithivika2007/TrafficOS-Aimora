import type { Direction } from "./simEngine";

export type SignalPhase = "GREEN" | "YELLOW" | "ALL_RED";

export const MIN_GREEN_SECONDS = 5;
export const MAX_GREEN_SECONDS = 30;
export const YELLOW_SECONDS = 3;
export const ALL_RED_SECONDS = 2;
export const STARVATION_LIMIT_SECONDS = 30;

// Step 2: violation response
export const VIOLATION_EXTENSION_SECONDS = 3; // extra all-red after a red-light violation
export const HOLD_EXTENSION_SECONDS = 2; // extra all-red while junction is not clear
export const MAX_ALL_RED_EXTENSION_SECONDS = 10; // cap so the junction can never deadlock

export interface SafetyState {
  phase: SignalPhase;
  remaining: number;
  pendingLane: Direction | null;
  greenElapsed: number;
  allRedExtension: number; // extra all-red seconds used in this clearance
  pendingViolationExtension: number;
  holdCapLogged: boolean;
}

export const createSafetyState = (): SafetyState => ({
  phase: "ALL_RED",
  remaining: ALL_RED_SECONDS,
  pendingLane: null,
  greenElapsed: 0,
  allRedExtension: 0,
  pendingViolationExtension: 0,
  holdCapLogged: false,
});

export function beginSafetySwitch(state: SafetyState, nextLane: Direction | null) {
  state.phase = "YELLOW";
  state.remaining = YELLOW_SECONDS;
  state.pendingLane = nextLane;
}

export function startAllRed(state: SafetyState, duration: number) {
  state.phase = "ALL_RED";
  state.remaining = duration + state.pendingViolationExtension;
  state.pendingViolationExtension = 0;
  return state.remaining;
}

export function advanceSafetyPhase(state: SafetyState, elapsed: number) {
  if (state.phase === "GREEN") return;
  state.remaining = Math.max(0, state.remaining - elapsed);
  if (state.phase === "YELLOW" && state.remaining === 0) {
    startAllRed(state, ALL_RED_SECONDS);
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
  state.allRedExtension = 0;
  state.pendingViolationExtension = 0;
  state.holdCapLogged = false;
}

/** A vehicle crossed the stop line on RED. Protect the cross traffic. */
export function registerViolation(state: SafetyState, lane: Direction, logs: string[]) {
  const extension = Math.min(
    VIOLATION_EXTENSION_SECONDS,
    Math.max(0, MAX_ALL_RED_EXTENSION_SECONDS - state.allRedExtension)
  );
  state.allRedExtension += extension;
  logs.push(`VIOLATION: ${lane} vehicle crossed stop line on RED`);
  if (extension > 0 && state.phase === "ALL_RED") {
    state.remaining += extension;
    logs.push(`SAFETY_HOLD: all-red extended +${extension}s (violation)`);
  } else if (extension > 0) {
    state.pendingViolationExtension += extension;
    logs.push(`SAFETY_HOLD: next green delayed +${extension}s for clearance`);
  } else {
    logs.push(`SAFETY_HOLD: extension cap (${MAX_ALL_RED_EXTENSION_SECONDS}s) reached`);
  }
  return extension;
}

/**
 * Called when all-red is about to end.
 * Returns true if the next green must be HELD (all-red was extended).
 */
export function applySafetyHold(
  state: SafetyState,
  junctionClear: boolean,
  logs: string[]
): boolean {
  if (junctionClear) {
    state.holdCapLogged = false;
    return false;
  }
  const extension = Math.min(
    HOLD_EXTENSION_SECONDS,
    Math.max(0, MAX_ALL_RED_EXTENSION_SECONDS - state.allRedExtension)
  );
  if (extension > 0) {
    state.remaining = extension;
    state.allRedExtension += extension;
    logs.push(`SAFETY_HOLD: junction not clear, all-red +${extension}s`);
    return true;
  }
  if (!state.holdCapLogged) {
    logs.push(`SAFETY_HOLD: extension cap (${MAX_ALL_RED_EXTENSION_SECONDS}s) reached; waiting for junction clearance`);
    state.holdCapLogged = true;
  }
  return true;
}