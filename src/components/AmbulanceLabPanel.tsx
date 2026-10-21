import React from "react";
import { DIRECTIONS } from "../simEngine";
import type { Direction, Snapshot } from "../simEngine";
import { STARVATION_LIMIT_SECONDS } from "../safetyLayer";

export type AmbulanceScenario = "IDLE" | "SINGLE" | "REPEATED" | "CONFLICTING";

interface AmbulanceLabPanelProps {
  snapshot: Snapshot;
  scenario: AmbulanceScenario;
  onSingleAmbulance: () => void;
  onRepeatedArrivals: () => void;
  onConflictingRequests: () => void;
  onReset: () => void;
}

const INTERRUPTION_LABELS: Record<Snapshot["emergencyState"], string> = {
  IDLE: "IDLE",
  CLEARING_TO_EMERGENCY: "VERIFIED",
  ACTIVE: "ACTIVE PREEMPTION",
  CLEARING_TO_NORMAL: "ACTIVE PREEMPTION",
};

const SIGNAL_LABELS: Record<Snapshot["emergencyState"], string> = {
  IDLE: "NORMAL SCHEDULING",
  CLEARING_TO_EMERGENCY: "SAFE CLEARANCE (AMBER)",
  ACTIVE: "EMERGENCY PASSAGE",
  CLEARING_TO_NORMAL: "RECOVERY & AGING",
};

const METRICS = [
  { key: "ambulanceDelay", label: "AMBULANCE DELAY", unit: "s", color: "text-amber-300" },
  { key: "maxLaneWait", label: "MAX LANE WAIT", unit: "s", color: "text-rose-300" },
  { key: "recoveryTime", label: "RECOVERY TIME", unit: "s", color: "text-cyan-300" },
  { key: "ordinaryServed", label: "ORDINARY SERVED", unit: "", color: "text-emerald-300" },
] as const;

export const AmbulanceLabPanel: React.FC<AmbulanceLabPanelProps> = ({
  snapshot,
  scenario,
  onSingleAmbulance,
  onRepeatedArrivals,
  onConflictingRequests,
  onReset,
}) => {
  const interruptionStatus =
    snapshot.emergencyState === "IDLE" &&
    snapshot.emergencyVehicles.some((vehicle) => vehicle.status === "APPROACHING")
      ? "VERIFIED"
      : INTERRUPTION_LABELS[snapshot.emergencyState];

  const metrics: Record<(typeof METRICS)[number]["key"], number> = {
    ambulanceDelay: snapshot.ambulanceDelay,
    maxLaneWait: snapshot.maxLaneWait,
    recoveryTime: snapshot.recoveryTime,
    ordinaryServed: snapshot.ordinaryServed,
  };

  const scenarioButtonClass = (active: boolean) =>
    `flex min-h-12 items-center justify-center rounded-xl border px-3 py-2 text-xs font-bold transition-colors ${
      active
        ? "border-amber-300 bg-amber-300/15 text-amber-100 shadow-[0_0_20px_rgba(252,211,77,0.08)]"
        : "border-slate-700 bg-slate-950/70 text-slate-300 hover:border-amber-400/50 hover:text-amber-100"
    }`;

  return (
    <section
      aria-labelledby="ambulance-lab-title"
      className="rounded-2xl border border-amber-400/20 bg-[#0d121d] p-4 shadow-2xl sm:p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-amber-300/80">
            Interrupt service routine · ISR preemption module
          </p>
          <h2 id="ambulance-lab-title" className="mt-1 text-lg font-black text-white sm:text-xl">
            Ambulance Emergency Lab
          </h2>
          <p className="mt-1 text-xs font-semibold text-slate-400">
            Exercise safe clearance, exclusive emergency passage, and scheduler recovery.
          </p>
        </div>
        <span className="rounded-full border border-slate-700 bg-slate-950 px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-300">
          {snapshot.emergencyVehicles.length} request
          {snapshot.emergencyVehicles.length === 1 ? "" : "s"} logged
        </span>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <button type="button" className={scenarioButtonClass(scenario === "SINGLE")} onClick={onSingleAmbulance}>
          🚑 Single Ambulance
        </button>
        <button type="button" className={scenarioButtonClass(scenario === "REPEATED")} onClick={onRepeatedArrivals}>
          🔄 Repeated Arrivals
        </button>
        <button type="button" className={scenarioButtonClass(scenario === "CONFLICTING")} onClick={onConflictingRequests}>
          ⚠️ Conflicting Requests
        </button>
        <button
          type="button"
          className="flex min-h-12 items-center justify-center rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-xs font-bold text-slate-300 transition-colors hover:border-rose-400/60 hover:text-rose-200"
          onClick={onReset}
        >
          ↺ Reset Lab
        </button>
      </div>

      {snapshot.emergencyVehicles.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {snapshot.emergencyVehicles.slice(-4).map((vehicle) => (
            <span
              key={vehicle.id}
              className="inline-flex items-center gap-2 rounded-lg border border-rose-400/20 bg-rose-400/5 px-2.5 py-1.5 text-[10px] font-bold text-slate-200"
            >
              <span className="text-rose-300">🚑 {vehicle.id}</span>
              {vehicle.lane} · {vehicle.status.replace("_", " ")}
            </span>
          ))}
        </div>
      )}

      <div className="mt-4 grid gap-3 lg:grid-cols-[1.15fr_1fr]">
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="rounded-xl border border-slate-700 bg-slate-950/70 p-3">
            <span className="block text-[9px] font-bold uppercase tracking-wider text-slate-500">
              Interrupt verification
            </span>
            <span className={`mt-1 block text-sm font-black ${
              interruptionStatus === "ACTIVE PREEMPTION"
                ? "text-rose-300"
                : interruptionStatus === "VERIFIED"
                ? "text-amber-300"
                : "text-slate-200"
            }`}>
              {interruptionStatus}
            </span>
          </div>
          <div className="rounded-xl border border-slate-700 bg-slate-950/70 p-3">
            <span className="block text-[9px] font-bold uppercase tracking-wider text-slate-500">
              Signal phase state
            </span>
            <span className="mt-1 block text-sm font-black text-amber-200">
              {SIGNAL_LABELS[snapshot.emergencyState]}
            </span>
          </div>
        </div>

        <div className="rounded-xl border border-slate-700 bg-slate-950/70 p-3">
          <div className="mb-2 flex items-center justify-between gap-3">
            <h3 className="text-[10px] font-black uppercase tracking-wider text-slate-200">
              Starved lane aging monitor
            </h3>
            <span className="text-[9px] font-semibold text-slate-500">
              +0.25× per {2}s waited
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {DIRECTIONS.map((lane: Direction) => {
              const starved = snapshot.laneWait[lane] >= STARVATION_LIMIT_SECONDS;
              return (
                <div
                  key={lane}
                  className={`rounded-lg border px-2.5 py-2 ${
                    starved
                      ? "border-amber-400/40 bg-amber-400/10"
                      : "border-slate-800 bg-slate-900/70"
                  }`}
                >
                  <div className="flex items-center justify-between gap-1 text-[10px]">
                    <span className="font-black text-slate-200">{lane}</span>
                    <span className={`font-black ${starved ? "text-amber-200" : "text-emerald-300"}`}>
                      {snapshot.agingMultiplier[lane].toFixed(1)}×
                      {starved ? " ⚡ STARVED" : ""}
                    </span>
                  </div>
                  <div className="mt-1 text-[9px] font-semibold text-slate-500">
                    {snapshot.laneWait[lane].toFixed(1)}s waiting · {snapshot.queued[lane]} queued
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 xl:grid-cols-4">
        {METRICS.map((metric) => (
          <div
            key={metric.key}
            className="rounded-xl border border-slate-700 bg-gradient-to-br from-slate-900 to-slate-950 p-3"
          >
            <span className="block text-[9px] font-bold uppercase tracking-wider text-slate-500">
              {metric.label}
            </span>
            <span className={`mt-1 block text-xl font-black tabular-nums ${metric.color}`}>
              {metrics[metric.key].toFixed(metric.key === "ordinaryServed" ? 0 : 1)}
              <span className="ml-1 text-[10px] font-bold">{metric.unit}</span>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
};

export default AmbulanceLabPanel;
