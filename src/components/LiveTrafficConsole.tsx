import React, { useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import { DIRECTIONS, isLaneRed } from "../simEngine";
import type { Direction, Sim, ViolationLogEntry } from "../simEngine";

interface LiveTrafficConsoleProps {
  simulationRef: MutableRefObject<Sim>;
}

type VideoSource = "LIVE CAMERA" | "VIDEO FILE" | "DEMO VIDEO" | null;

const LANE_COLOR: Record<Direction, string> = {
  NORTH: "#fb7185",
  EAST: "#60a5fa",
  SOUTH: "#c084fc",
  WEST: "#fbbf24",
};

export const LiveTrafficConsole: React.FC<LiveTrafficConsoleProps> = ({ simulationRef }) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const fileUrlRef = useRef<string | null>(null);
  const [source, setSource] = useState<VideoSource>("DEMO VIDEO");
  const [videoUrl, setVideoUrl] = useState<string | undefined>("/traffic.mp4");
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [isPlaying, setIsPlaying] = useState(true);
  const [playerMessage, setPlayerMessage] = useState<string | null>(null);
  const [simulationTime, setSimulationTime] = useState(simulationRef.current.clock);
  const [violationLog, setViolationLog] = useState<ViolationLogEntry[]>([]);

  useEffect(() => {
    return () => {
      stream?.getTracks().forEach((track) => track.stop());
      if (fileUrlRef.current) URL.revokeObjectURL(fileUrlRef.current);
    };
  }, [stream]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = source === "LIVE CAMERA" ? stream : null;
  }, [source, stream]);

  useEffect(() => {
    const updateSimulationStatus = () => {
      const simulation = simulationRef.current;
      setViolationLog(simulation.violationLog.map((entry) => ({ ...entry })));
      setSimulationTime(simulation.clock);
    };
    updateSimulationStatus();
    const timer = window.setInterval(updateSimulationStatus, 500);
    return () => window.clearInterval(timer);
  }, [simulationRef]);

  const changeSource = (nextSource: VideoSource, nextUrl?: string) => {
    stream?.getTracks().forEach((track) => track.stop());
    setStream(null);
    if (fileUrlRef.current) {
      URL.revokeObjectURL(fileUrlRef.current);
      fileUrlRef.current = null;
    }
    if (nextUrl?.startsWith("blob:")) fileUrlRef.current = nextUrl;
    setSource(nextSource);
    setVideoUrl(nextUrl);
    setPlayerMessage(null);
    setIsPlaying(nextSource !== null);
  };

  const selectVideoFile = (file: File | undefined) => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    changeSource("VIDEO FILE", url);
  };

  const selectDemoVideo = () => changeSource("DEMO VIDEO", "/traffic.mp4");

  const connectCamera = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setPlayerMessage("Camera access is unavailable. Choose a demo or video file instead.");
      return;
    }
    try {
      const cameraStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" } },
      });
      changeSource("LIVE CAMERA");
      setStream(cameraStream);
    } catch (error) {
      setPlayerMessage(
        `Unable to connect camera: ${error instanceof Error ? error.message : "browser error"}`
      );
    }
  };

  const togglePlayback = () => {
    const video = videoRef.current;
    if (!video || !source) return;
    if (video.paused) {
      void video.play().catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setPlayerMessage(
          `Playback could not start: ${error instanceof Error ? error.message : "browser error"}`
        );
      });
    } else {
      video.pause();
    }
  };

  const laneSignal = (lane: Direction) =>
    isLaneRed(simulationRef.current, lane) ? "RED" : "GREEN";
  const recentViolations = [...violationLog].reverse().slice(0, 6);

  return (
    <div className="space-y-6 font-mono text-slate-100">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-700/60 bg-slate-900 p-4">
        <div>
          <div className="text-xs font-bold uppercase tracking-wider text-white">
            LIVE CCTV FEED — CAMERA INPUT
          </div>
          <p className="mt-1 text-[10px] text-slate-400">
            Demo, uploaded, or connected camera video.
          </p>
        </div>
        <span className={`rounded border px-2 py-1 text-[10px] font-bold ${
          source
            ? "border-emerald-500/40 bg-emerald-950 text-emerald-300"
            : "border-slate-700 bg-slate-800 text-slate-400"
        }`}>
          {source ? "STATUS: LIVE" : "STATUS: OFFLINE"}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <section className="space-y-4 rounded-2xl border border-slate-700/60 bg-slate-900 p-4 lg:col-span-7">
          <div className="relative aspect-video w-full overflow-hidden rounded-xl border border-slate-800 bg-black">
            {source ? (
              <video
                ref={videoRef}
                src={source === "LIVE CAMERA" ? undefined : videoUrl}
                autoPlay
                loop
                muted
                playsInline
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
                onError={() => setPlayerMessage(
                  source === "DEMO VIDEO"
                    ? "Bundled demo video could not be loaded."
                    : "Selected video could not be played."
                )}
                className="absolute inset-0 h-full w-full object-cover pointer-events-none"
              />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center text-xs text-slate-500">
                Select a demo, uploaded video, or camera source.
              </div>
            )}
            <div className="pointer-events-none absolute left-3 top-3 rounded border border-emerald-500/40 bg-black/80 px-2 py-1 text-[10px] font-bold text-emerald-300">
              {source ? "FEED: ACTIVE" : "FEED: OFFLINE"}
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void connectCamera()}
              className="rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-3 py-2 text-[11px] font-bold text-cyan-300 hover:bg-cyan-500/20"
            >
              CONNECT CAMERA
            </button>
            <button
              type="button"
              onClick={togglePlayback}
              disabled={!source}
              className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-[11px] font-bold text-white disabled:opacity-40"
            >
              {isPlaying ? "PAUSE" : "PLAY"}
            </button>
            <button
              type="button"
              onClick={selectDemoVideo}
              className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] font-bold text-amber-300"
            >
              DEMO VIDEO
            </button>
            <label className="cursor-pointer rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-[11px] font-bold text-slate-200">
              SELECT VIDEO FILE
              <input
                className="hidden"
                type="file"
                accept="video/*"
                onChange={(event) => selectVideoFile(event.currentTarget.files?.[0])}
              />
            </label>
            {source && (
              <button
                type="button"
                onClick={() => changeSource(null)}
                className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-[11px] font-bold text-rose-300"
              >
                DISCONNECT
              </button>
            )}
          </div>
          {playerMessage && (
            <div role="status" className="rounded-lg border border-slate-700 bg-slate-950/70 px-3 py-2 text-[10px] text-slate-300">
              {playerMessage}
            </div>
          )}
          <div className="grid grid-cols-3 gap-2 text-center">
            <Metric label="VIDEO SOURCE" value={source ?? "OFFLINE"} />
            <Metric label="PLAYBACK" value={source ? (isPlaying ? "PLAYING" : "PAUSED") : "STOPPED"} />
            <Metric label="FEED STATUS" value={source ? "LIVE" : "OFFLINE"} />
          </div>
        </section>

        <section className="space-y-4 rounded-2xl border border-slate-700/60 bg-slate-900 p-5 lg:col-span-5">
          <h3 className="text-xs font-bold uppercase tracking-wider text-cyan-400">
            Camera feed &amp; simulation signals
          </h3>
          <div className="space-y-2">
            {DIRECTIONS.map((lane) => (
              <div
                key={lane}
                className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-[11px]"
              >
                <span className="font-bold" style={{ color: LANE_COLOR[lane] }}>{lane}</span>
                <span className={laneSignal(lane) === "GREEN" ? "text-emerald-300" : "text-rose-300"}>
                  SIM {laneSignal(lane)}
                </span>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Metric label="SIMULATION TIME" value={`${simulationTime.toFixed(1)}s`} />
            <Metric label="RECORDED VIOLATIONS" value={String(violationLog.length)} />
          </div>
          <p className="text-[10px] text-slate-500">
            Signal state remains controlled by the simulation engine.
          </p>
        </section>
      </div>

      <section className="rounded-2xl border border-slate-700/60 bg-slate-900 p-4">
        <h3 className="mb-3 text-xs font-bold uppercase tracking-wider text-rose-300">
          Recorded simulation violations
        </h3>
        {recentViolations.length === 0 ? (
          <p className="text-[10px] text-slate-500">No simulation violations recorded.</p>
        ) : (
          <ul className="space-y-2">
            {recentViolations.map((violation) => (
              <li key={violation.id} className="rounded-lg border border-slate-800 bg-slate-950/60 p-2 text-[10px]">
                <div className="flex justify-between gap-2">
                  <span className="font-bold text-rose-300">{violation.type} · {violation.lane}</span>
                  <span className="text-slate-500">sim {violation.timestamp.toFixed(1)}s</span>
                </div>
                <p className="mt-1 text-slate-300">{violation.vehicleId} · {violation.id}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
};

const Metric: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-2">
    <span className="block text-[9px] text-slate-500">{label}</span>
    <span className="text-[11px] font-bold text-white">{value}</span>
  </div>
);

export default LiveTrafficConsole;
