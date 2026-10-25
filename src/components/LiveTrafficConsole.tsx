import React, { useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import { DIRECTIONS, isLaneRed } from "../simEngine";
import type { Direction, Sim, ViolationLogEntry } from "../simEngine";
import {
  DETECTION_INTERVAL_MS,
  TRACK_EXPIRY_MS,
  detectVehicles,
  isInsideLane,
  loadVehicleDetector,
  updateTracks,
} from "../vehicleDetection";
import type {
  DetectionBox,
  LaneCalibration,
  LaneCalibrations,
  VehicleDetector,
} from "../vehicleDetection";

interface LiveTrafficConsoleProps {
  simulationRef: MutableRefObject<Sim>;
}

type VideoSource = "LIVE CAMERA" | "VIDEO FILE" | "DEMO VIDEO" | null;
type DetectionStatus = "NOT STARTED" | "LOADING" | "READY" | "ERROR";
type VehicleClass = "car" | "bus" | "truck" | "motorcycle";

const VEHICLE_LABELS: Record<VehicleClass, string> = {
  car: "Car",
  bus: "Bus",
  truck: "Truck",
  motorcycle: "Motorcycle",
};
const BOX_COLORS = ["#38bdf8", "#10b981", "#f59e0b", "#a855f7"];
const LANE_COLOR: Record<Direction, string> = {
  NORTH: "#fb7185",
  EAST: "#60a5fa",
  SOUTH: "#c084fc",
  WEST: "#fbbf24",
};

const INITIAL_CALIBRATION: LaneCalibrations = {
  NORTH: { x: 0.35, y: 0.02, width: 0.3, height: 0.48, axis: "y", stopLine: 0.45, crossingDirection: "POSITIVE" },
  EAST: { x: 0.5, y: 0.35, width: 0.48, height: 0.3, axis: "x", stopLine: 0.65, crossingDirection: "POSITIVE" },
  SOUTH: { x: 0.35, y: 0.5, width: 0.3, height: 0.48, axis: "y", stopLine: 0.55, crossingDirection: "NEGATIVE" },
  WEST: { x: 0.02, y: 0.35, width: 0.48, height: 0.3, axis: "x", stopLine: 0.45, crossingDirection: "NEGATIVE" },
};

function boxColor(track: DetectionBox): string {
  const numericId = Number(track.id.match(/\d+$/)?.[0] ?? 0);
  return BOX_COLORS[numericId % BOX_COLORS.length];
}

function drawOverlay(
  context: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  video: HTMLVideoElement,
  tracks: DetectionBox[],
  calibrations: LaneCalibrations,
  calibrationEnabled: boolean
): void {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return;
  const dpr = window.devicePixelRatio || 1;
  const pixelWidth = Math.round(width * dpr);
  const pixelHeight = Math.round(height * dpr);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);

  const videoWidth = video.videoWidth;
  const videoHeight = video.videoHeight;
  if (!videoWidth || !videoHeight) return;
  const scale = Math.min(width / videoWidth, height / videoHeight);
  const renderedWidth = videoWidth * scale;
  const renderedHeight = videoHeight * scale;
  const offsetX = (width - renderedWidth) / 2;
  const offsetY = (height - renderedHeight) / 2;
  const xAt = (value: number) => offsetX + value * renderedWidth;
  const yAt = (value: number) => offsetY + value * renderedHeight;

  if (calibrationEnabled) {
    for (const lane of DIRECTIONS) {
      const calibration = calibrations[lane];
      context.strokeStyle = LANE_COLOR[lane];
      context.lineWidth = 2;
      context.setLineDash([7, 4]);
      context.strokeRect(
        xAt(calibration.x),
        yAt(calibration.y),
        calibration.width * renderedWidth,
        calibration.height * renderedHeight
      );
      context.setLineDash([]);
      context.beginPath();
      if (calibration.axis === "x") {
        context.moveTo(xAt(calibration.stopLine), yAt(calibration.y));
        context.lineTo(xAt(calibration.stopLine), yAt(calibration.y + calibration.height));
      } else {
        context.moveTo(xAt(calibration.x), yAt(calibration.stopLine));
        context.lineTo(xAt(calibration.x + calibration.width), yAt(calibration.stopLine));
      }
      context.stroke();
      context.fillStyle = LANE_COLOR[lane];
      context.font = "bold 11px monospace";
      context.fillText(lane, xAt(calibration.x) + 4, yAt(calibration.y) + 14);
    }
  }

  const now = performance.now();
  for (const track of tracks) {
    if (now - track.lastSeenMs > 900) continue;
    const x = xAt(track.x);
    const y = yAt(track.y);
    const boxWidth = track.width * renderedWidth;
    const boxHeight = track.height * renderedHeight;
    const color = boxColor(track);
    const corner = Math.min(12, boxWidth / 3, boxHeight / 3);

    context.fillStyle = "rgba(56, 189, 248, 0.1)";
    context.fillRect(x, y, boxWidth, boxHeight);
    context.strokeStyle = color;
    context.lineWidth = 2;
    context.strokeRect(x, y, boxWidth, boxHeight);
    context.shadowColor = color;
    context.shadowBlur = 8;
    context.beginPath();
    context.moveTo(x, y + corner);
    context.lineTo(x, y);
    context.lineTo(x + corner, y);
    context.moveTo(x + boxWidth - corner, y);
    context.lineTo(x + boxWidth, y);
    context.lineTo(x + boxWidth, y + corner);
    context.moveTo(x, y + boxHeight - corner);
    context.lineTo(x, y + boxHeight);
    context.lineTo(x + corner, y + boxHeight);
    context.moveTo(x + boxWidth - corner, y + boxHeight);
    context.lineTo(x + boxWidth, y + boxHeight);
    context.lineTo(x + boxWidth, y + boxHeight - corner);
    context.stroke();
    context.shadowBlur = 0;

    const className = VEHICLE_LABELS[track.className as VehicleClass]?.toLowerCase()
      ?? track.className;
    const trackId = Number(track.id.match(/\d+$/)?.[0] ?? 0) || track.id;
    const label = `${className}: ${(track.score * 100).toFixed(1)} id: ${trackId}`;
    context.font = "bold 11px monospace";
    const labelWidth = context.measureText(label).width + 12;
    const labelHeight = 20;
    const labelX = Math.max(2, Math.min(x, width - labelWidth - 2));
    const labelY = y - labelHeight >= offsetY ? y - labelHeight : y;
    context.fillStyle = "rgba(2, 6, 23, 0.94)";
    context.fillRect(labelX, labelY, labelWidth, labelHeight);
    context.strokeStyle = color;
    context.lineWidth = 1;
    context.strokeRect(labelX, labelY, labelWidth, labelHeight);
    context.fillStyle = color;
    context.fillText(label, labelX + 6, labelY + 14);

    const centerX = xAt(track.centerX);
    const centerY = yAt(track.centerY);
    context.beginPath();
    context.arc(centerX, centerY, 3.5, 0, Math.PI * 2);
    context.fillStyle = "#fff";
    context.fill();
    context.strokeStyle = color;
    context.lineWidth = 1.5;
    context.stroke();
    if (track.previousCenterX !== null && track.previousCenterY !== null) {
      const dx = (track.centerX - track.previousCenterX) * renderedWidth;
      const dy = (track.centerY - track.previousCenterY) * renderedHeight;
      const distance = Math.hypot(dx, dy);
      if (distance > 1) {
        const arrowLength = Math.min(15, distance);
        const endX = centerX + dx / distance * arrowLength;
        const endY = centerY + dy / distance * arrowLength;
        const angle = Math.atan2(dy, dx);
        context.beginPath();
        context.moveTo(centerX, centerY);
        context.lineTo(endX, endY);
        context.lineTo(endX - 5 * Math.cos(angle - Math.PI / 6), endY - 5 * Math.sin(angle - Math.PI / 6));
        context.moveTo(endX, endY);
        context.lineTo(endX - 5 * Math.cos(angle + Math.PI / 6), endY - 5 * Math.sin(angle + Math.PI / 6));
        context.strokeStyle = color;
        context.lineWidth = 2;
        context.stroke();
      }
    }
  }
}

export const LiveTrafficConsole: React.FC<LiveTrafficConsoleProps> = ({ simulationRef }) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const modelRef = useRef<VehicleDetector | null>(null);
  const modelPromiseRef = useRef<Promise<VehicleDetector> | null>(null);
  const tracksRef = useRef<DetectionBox[]>([]);
  const nextTrackIdRef = useRef(102);
  const fileUrlRef = useRef<string | null>(null);
  const calibrationsRef = useRef(INITIAL_CALIBRATION);
  const calibrationEnabledRef = useRef(false);
  const mountedRef = useRef(false);

  const [source, setSource] = useState<VideoSource>("DEMO VIDEO");
  const [videoFileUrl, setVideoFileUrl] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(true);
  const [detectionEnabled, setDetectionEnabled] = useState(false);
  const [detectionStatus, setDetectionStatus] = useState<DetectionStatus>("LOADING");
  const [detectionError, setDetectionError] = useState<string | null>(null);
  const [playerMessage, setPlayerMessage] = useState<string | null>(null);
  const [tracks, setTracks] = useState<DetectionBox[]>([]);
  const [fps, setFps] = useState(0);
  const [calibrations, setCalibrations] = useState<LaneCalibrations>(INITIAL_CALIBRATION);
  const [calibrationEnabled, setCalibrationEnabled] = useState(false);
  const [simulationTime, setSimulationTime] = useState(simulationRef.current.clock);
  const [violationLog, setViolationLog] = useState<ViolationLogEntry[]>([]);

  calibrationsRef.current = calibrations;
  calibrationEnabledRef.current = calibrationEnabled;

  const changeSource = (nextSource: VideoSource, nextFileUrl: string | null = null) => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (fileUrlRef.current) URL.revokeObjectURL(fileUrlRef.current);
    fileUrlRef.current = nextFileUrl;
    setVideoFileUrl(nextFileUrl);
    setSource(nextSource);
    setIsPlaying(nextSource !== null);
    setPlayerMessage(null);
    setDetectionError(null);
    tracksRef.current = [];
    setTracks([]);
    setFps(0);
  };

  const selectVideoFile = (file: File | undefined) => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    changeSource("VIDEO FILE", url);
  };

  const selectDemoVideo = () => changeSource("DEMO VIDEO");

  const connectCamera = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setPlayerMessage("Camera access is unavailable; choose a demo or video file instead.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" } },
      });
      changeSource("LIVE CAMERA");
      streamRef.current = stream;
    } catch (error) {
      setPlayerMessage(`Unable to connect camera: ${error instanceof Error ? error.message : "browser error"}`);
    }
  };

  const togglePlayback = () => {
    if (!source) return;
    setIsPlaying((playing) => !playing);
  };

  const startDetection = async () => {
    setDetectionError(null);
    setDetectionStatus("LOADING");
    try {
      modelPromiseRef.current ??= loadVehicleDetector();
      const model = await modelPromiseRef.current;
      if (!mountedRef.current) return;
      modelRef.current = model;
      setDetectionEnabled(true);
      setDetectionStatus("READY");
    } catch (error) {
      modelPromiseRef.current = null;
      setDetectionEnabled(false);
      setDetectionStatus("ERROR");
      setDetectionError(
        `Vehicle detector could not load: ${error instanceof Error ? error.message : "model or network error"}`
      );
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      if (fileUrlRef.current) URL.revokeObjectURL(fileUrlRef.current);
      modelRef.current?.dispose();
    };
  }, []);

  useEffect(() => {
    if (!source) {
      setDetectionEnabled(false);
      setDetectionStatus("NOT STARTED");
      return;
    }
    void startDetection();
  }, [source, videoFileUrl]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (source === "LIVE CAMERA") {
      video.removeAttribute("src");
      video.srcObject = streamRef.current;
    } else {
      video.srcObject = null;
    }
  }, [source, videoFileUrl]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !source) return;
    let cancelled = false;
    const tryPlay = () => {
      if (cancelled || !isPlaying || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.paused) return;
      void video.play().catch((error: unknown) => {
        if (cancelled || (error instanceof DOMException && error.name === "AbortError")) return;
        setPlayerMessage(`Playback could not start: ${error instanceof Error ? error.message : "browser error"}`);
      });
    };
    if (!isPlaying) {
      video.pause();
    } else if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      tryPlay();
    } else {
      video.addEventListener("loadeddata", tryPlay);
    }
    return () => {
      cancelled = true;
      video.removeEventListener("loadeddata", tryPlay);
    };
  }, [source, videoFileUrl, isPlaying]);

  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const model = modelRef.current;
    const context = canvas?.getContext("2d");
    if (!video || !canvas || !context) return;
    let animationFrame = 0;
    let lastInference = 0;
    let inferenceInFlight = false;
    let frameCount = 0;
    let fpsStartedAt = performance.now();
    let cancelled = false;

    const render = (now: number) => {
      drawOverlay(
        context,
        canvas,
        video,
        tracksRef.current,
        calibrationsRef.current,
        calibrationEnabledRef.current
      );
      if (
        model &&
        detectionEnabled &&
        isPlaying &&
        source &&
        !video.paused &&
        video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
        now - lastInference >= DETECTION_INTERVAL_MS &&
        !inferenceInFlight
      ) {
        lastInference = now;
        inferenceInFlight = true;
        void detectVehicles(model, video)
          .then((detections) => {
            if (cancelled) return;
            const updated = updateTracks(
              detections,
              tracksRef.current,
              performance.now(),
              nextTrackIdRef.current
            );
            tracksRef.current = updated.tracks;
            nextTrackIdRef.current = updated.nextId;
            setTracks(updated.tracks);
            frameCount++;
            const elapsed = performance.now() - fpsStartedAt;
            if (elapsed >= 1000) {
              setFps(Math.round(frameCount * 1000 / elapsed));
              frameCount = 0;
              fpsStartedAt = performance.now();
            }
          })
          .catch((error: unknown) => {
            if (cancelled) return;
            setDetectionEnabled(false);
            setDetectionStatus("ERROR");
            setDetectionError(
              `Vehicle detection failed: ${error instanceof Error ? error.message : "inference error"}`
            );
          })
          .finally(() => {
            inferenceInFlight = false;
          });
      }
      if (!cancelled && isPlaying && source) {
        animationFrame = requestAnimationFrame(render);
      }
    };

    render(performance.now());
    const resizeObserver = new ResizeObserver(() => {
      drawOverlay(context, canvas, video, tracksRef.current, calibrationsRef.current, calibrationEnabledRef.current);
    });
    resizeObserver.observe(canvas);
    const redrawAfterMetadata = () => {
      drawOverlay(context, canvas, video, tracksRef.current, calibrationsRef.current, calibrationEnabledRef.current);
    };
    video.addEventListener("loadedmetadata", redrawAfterMetadata);
    return () => {
      cancelled = true;
      cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      video.removeEventListener("loadedmetadata", redrawAfterMetadata);
    };
  }, [source, isPlaying, detectionEnabled]);

  useEffect(() => {
    const updateSimulationLog = () => {
      const simulation = simulationRef.current;
      setViolationLog(simulation.violationLog.map((entry) => ({ ...entry })));
      setSimulationTime(simulation.clock);
    };
    updateSimulationLog();
    const timer = window.setInterval(updateSimulationLog, 500);
    return () => window.clearInterval(timer);
  }, [simulationRef]);

  const changeCalibration = <K extends keyof LaneCalibration,>(
    lane: Direction,
    key: K,
    value: LaneCalibration[K]
  ) => {
    setCalibrations((current) => {
      const next = { ...current[lane], [key]: value };
      next.x = Math.min(next.x, 1);
      next.y = Math.min(next.y, 1);
      next.width = Math.min(next.width, 1 - next.x);
      next.height = Math.min(next.height, 1 - next.y);
      next.stopLine = Math.min(Math.max(next.stopLine, 0), 1);
      return { ...current, [lane]: next };
    });
  };

  const now = performance.now();
  const liveTracks = tracks.filter((track) => now - track.lastSeenMs <= 900);
  const vehicleCounts = liveTracks.reduce<Record<VehicleClass, number>>(
    (counts, track) => {
      if (track.className in counts) {
        const className = track.className as VehicleClass;
        counts[className] += 1;
      }
      return counts;
    },
    { car: 0, bus: 0, truck: 0, motorcycle: 0 }
  );
  const laneCounts = Object.fromEntries(
    DIRECTIONS.map((lane) => {
      const laneTracks = calibrationEnabled
        ? liveTracks.filter((track) => isInsideLane(track, calibrations[lane]))
        : [];
      const calibration = calibrations[lane];
      const queue = laneTracks.filter((track) => {
        const coordinate = calibration.axis === "x" ? track.centerX : track.centerY;
        return calibration.crossingDirection === "POSITIVE"
          ? coordinate < calibration.stopLine
          : coordinate > calibration.stopLine;
      }).length;
      return [lane, { count: laneTracks.length, queue }];
    })
  ) as Record<Direction, { count: number; queue: number }>;
  const laneSignal = (lane: Direction) => isLaneRed(simulationRef.current, lane) ? "RED" : "GREEN";
  const recentViolations = [...violationLog].reverse().slice(0, 6);
  const videoSource = source === "DEMO VIDEO" ? "/traffic.mp4" : source === "VIDEO FILE" ? videoFileUrl ?? undefined : undefined;

  return (
    <div className="space-y-6 font-mono text-slate-100">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-700/60 bg-slate-900 p-4">
        <div>
          <div className="text-xs font-bold uppercase tracking-wider text-white">LIVE CCTV FEED — CAMERA INPUT &amp; VEHICLE DETECTION</div>
          <p className="mt-1 text-[10px] text-slate-400">Video stays in the browser; vehicle inference runs locally.</p>
        </div>
        <span className={`rounded border px-2 py-1 text-[10px] font-bold ${
          source === "LIVE CAMERA" ? "border-rose-500/40 bg-rose-950 text-rose-300" :
          source ? "border-cyan-500/40 bg-cyan-950 text-cyan-300" :
          "border-slate-700 bg-slate-800 text-slate-400"
        }`}>SOURCE: {source ?? "DISCONNECTED"}</span>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <section className="space-y-4 rounded-2xl border border-slate-700/60 bg-slate-900 p-4 lg:col-span-7">
          <div className="relative aspect-video w-full overflow-hidden rounded-xl border border-slate-800 bg-black">
            {source ? (
              <video
                ref={videoRef}
                src={source === "LIVE CAMERA" ? undefined : videoSource}
                loop={source === "DEMO VIDEO"}
                muted
                playsInline
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
                onError={() => setPlayerMessage(source === "DEMO VIDEO" ? "Bundled demo video could not be loaded." : "Selected video could not be decoded.")}
                className="absolute inset-0 h-full w-full object-contain"
              />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center text-xs text-slate-500">Select a demo, uploaded video, or camera source.</div>
            )}
            <canvas
              ref={canvasRef}
              className="pointer-events-none absolute inset-0 h-full w-full"
              aria-label="Video detection bounding-box overlay"
            />
            <div className="pointer-events-none absolute left-3 top-3 flex flex-wrap gap-2 text-[10px] font-bold">
              <span className="rounded border border-slate-700 bg-black/80 px-2 py-1">{source ?? "DISCONNECTED"}</span>
              <span className="rounded border border-slate-700 bg-black/80 px-2 py-1 text-cyan-300">DETECTOR: {detectionStatus}</span>
            </div>
            {detectionError && <div role="status" className="absolute bottom-3 left-3 right-3 rounded border border-amber-500/40 bg-slate-950/90 p-2 text-[10px] text-amber-200">{detectionError}</div>}
          </div>

          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => void connectCamera()} className="rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-3 py-2 text-[11px] font-bold text-cyan-300 hover:bg-cyan-500/20">CONNECT CAMERA</button>
            <button type="button" onClick={togglePlayback} disabled={!source} className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-[11px] font-bold text-white disabled:opacity-40">{isPlaying ? "PAUSE" : "PLAY"}</button>
            <button type="button" onClick={selectDemoVideo} className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] font-bold text-amber-300">DEMO VIDEO</button>
            <label className="cursor-pointer rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-[11px] font-bold text-slate-200">
              SELECT VIDEO FILE
              <input className="hidden" type="file" accept="video/*" onChange={(event) => selectVideoFile(event.currentTarget.files?.[0])} />
            </label>
            {source && <button type="button" onClick={() => changeSource(null)} className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-[11px] font-bold text-rose-300">DISCONNECT</button>}
          </div>
          {playerMessage && <div role="status" className="rounded-lg border border-slate-700 bg-slate-950/70 px-3 py-2 text-[10px] text-slate-300">{playerMessage}</div>}
          <div className="grid grid-cols-3 gap-2 text-center">
            <Metric label="LIVE DETECTIONS" value={String(liveTracks.length)} />
            <Metric label="INFERENCE FPS" value={String(fps)} />
            <Metric label="MODEL" value={detectionStatus} />
          </div>
          <p className="text-[10px] leading-relaxed text-slate-500">COCO-SSD detects cars, buses, trucks, and motorcycles. Model weights load in the browser and video frames are processed locally.</p>
        </section>

        <section className="space-y-4 rounded-2xl border border-slate-700/60 bg-slate-900 p-5 lg:col-span-5">
          <h3 className="text-xs font-bold uppercase tracking-wider text-cyan-400">Camera detections &amp; simulation signals</h3>
          {!calibrationEnabled && <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-[10px] text-amber-200">Lane-specific counts use the editable regions below. Vehicle totals update directly from active bounding boxes.</div>}
          <div className="rounded-lg border border-cyan-500/25 bg-slate-950/60 p-3" aria-live="polite">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-bold uppercase tracking-wide text-cyan-300">LIVE DETECTED VEHICLES</span>
              <span className="text-sm font-bold text-white">{liveTracks.length}</span>
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-slate-300">
              {(Object.keys(VEHICLE_LABELS) as VehicleClass[]).map((vehicleClass) => (
                <span key={vehicleClass}>{VEHICLE_LABELS[vehicleClass]}: <b className="text-white">{vehicleCounts[vehicleClass]}</b></span>
              ))}
            </div>
          </div>
          <div className="space-y-2">
            {DIRECTIONS.map((lane) => (
              <div key={lane} className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-[11px]">
                <span className="font-bold" style={{ color: LANE_COLOR[lane] }}>{lane}</span>
                <span className="text-slate-300">{calibrationEnabled ? `${laneCounts[lane].count} detected · ${laneCounts[lane].queue} queued` : "NOT CALIBRATED"}</span>
                <span className={laneSignal(lane) === "GREEN" ? "text-emerald-300" : "text-rose-300"}>SIM {laneSignal(lane)}</span>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Metric label="SIMULATION TIME" value={`${simulationTime.toFixed(1)}s`} />
            <Metric label="RECORDED VIOLATIONS" value={String(violationLog.length)} />
          </div>
          <p className="text-[10px] text-slate-500">Signal state remains controlled by the simulation engine; camera detections do not control signals.</p>
        </section>
      </div>

      <section className="space-y-4 rounded-2xl border border-slate-700/60 bg-slate-900 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wider text-amber-300">Lane regions &amp; virtual stop lines</h3>
            <p className="mt-1 text-[10px] text-slate-400">Adjust normalized regions over the active video frame.</p>
          </div>
          <label className="flex items-center gap-2 text-[10px] font-bold text-slate-200">
            <input type="checkbox" checked={calibrationEnabled} onChange={(event) => setCalibrationEnabled(event.currentTarget.checked)} />
            Show lane regions and stop lines
          </label>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {DIRECTIONS.map((lane) => (
            <div key={lane} className="space-y-3 rounded-xl border border-slate-800 bg-slate-950/50 p-3">
              <div className="text-[11px] font-bold" style={{ color: LANE_COLOR[lane] }}>{lane} REGION</div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-2">
                {(["x", "y", "width", "height"] as const).map((field) => (
                  <label key={field} className="text-[9px] text-slate-400">
                    REGION {field.toUpperCase()} · {Math.round(calibrations[lane][field] * 100)}%
                    <input type="range" min="0" max="100" value={Math.round(calibrations[lane][field] * 100)} onChange={(event) => changeCalibration(lane, field, Number(event.currentTarget.value) / 100)} className="mt-1 block w-full accent-cyan-400" />
                  </label>
                ))}
              </div>
              <div className="grid grid-cols-3 gap-2">
                <label className="text-[9px] text-slate-400">
                  LINE AXIS
                  <select value={calibrations[lane].axis} onChange={(event) => changeCalibration(lane, "axis", event.currentTarget.value === "x" ? "x" : "y")} className="mt-1 w-full rounded bg-slate-900 p-1 text-[10px] text-white">
                    <option value="x">Vertical (X)</option><option value="y">Horizontal (Y)</option>
                  </select>
                </label>
                <label className="text-[9px] text-slate-400">
                  STOP LINE · {Math.round(calibrations[lane].stopLine * 100)}%
                  <input type="range" min="0" max="100" value={Math.round(calibrations[lane].stopLine * 100)} onChange={(event) => changeCalibration(lane, "stopLine", Number(event.currentTarget.value) / 100)} className="mt-2 block w-full accent-rose-400" />
                </label>
                <label className="text-[9px] text-slate-400">
                  CROSSING
                  <select value={calibrations[lane].crossingDirection} onChange={(event) => changeCalibration(lane, "crossingDirection", event.currentTarget.value === "POSITIVE" ? "POSITIVE" : "NEGATIVE")} className="mt-1 w-full rounded bg-slate-900 p-1 text-[10px] text-white">
                    <option value="POSITIVE">Low to high</option><option value="NEGATIVE">High to low</option>
                  </select>
                </label>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-2xl border border-slate-700/60 bg-slate-900 p-4">
        <h3 className="mb-3 text-xs font-bold uppercase tracking-wider text-rose-300">Recorded simulation violations</h3>
        {recentViolations.length === 0 ? <p className="text-[10px] text-slate-500">No simulation violations recorded.</p> : (
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
