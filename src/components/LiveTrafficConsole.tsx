import React, { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import {
  DIRECTIONS,
  isLaneRed,
  recordCameraViolation,
} from "../simEngine";
import type { Direction, Sim, ViolationLogEntry } from "../simEngine";
import {
  DETECTION_INTERVAL_MS,
  TRACK_EXPIRY_MS,
  VERIFIED_CONFIDENCE,
  canVerifyRedCrossing,
  crossedStopLine,
  detectVehicles,
  isInsideLane,
  loadVehicleDetector,
  updateTracks,
} from "../vehicleDetection";
import type {
  DetectionBox,
  LaneCalibration,
  LaneCalibrations,
  SignalSample,
  VehicleDetector,
} from "../vehicleDetection";

interface LiveTrafficConsoleProps {
  simulationRef: MutableRefObject<Sim>;
  onSimulationUpdate: () => void;
}

type VideoSource = "LIVE CAMERA" | "VIDEO FILE" | "DEMO VIDEO" | null;
type DetectionStatus = "NOT STARTED" | "LOADING" | "READY" | "ERROR";
type DetectionEventStatus = "VIOLATION" | "UNVERIFIED" | "CLEARED";

interface DetectionEvent {
  id: string;
  at: number;
  lane: Direction;
  trackingId: string;
  status: DetectionEventStatus;
  detail: string;
}

const INITIAL_CALIBRATION: LaneCalibrations = {
  NORTH: {
    x: 0.35,
    y: 0.02,
    width: 0.3,
    height: 0.48,
    axis: "y",
    stopLine: 0.45,
    crossingDirection: "POSITIVE",
  },
  EAST: {
    x: 0.5,
    y: 0.35,
    width: 0.48,
    height: 0.3,
    axis: "x",
    stopLine: 0.65,
    crossingDirection: "POSITIVE",
  },
  SOUTH: {
    x: 0.35,
    y: 0.5,
    width: 0.3,
    height: 0.48,
    axis: "y",
    stopLine: 0.55,
    crossingDirection: "NEGATIVE",
  },
  WEST: {
    x: 0.02,
    y: 0.35,
    width: 0.48,
    height: 0.3,
    axis: "x",
    stopLine: 0.45,
    crossingDirection: "NEGATIVE",
  },
};

const LANE_COLOR: Record<Direction, string> = {
  NORTH: "#fb7185",
  EAST: "#60a5fa",
  SOUTH: "#c084fc",
  WEST: "#fbbf24",
};
const VEHICLE_LABEL: Record<string, string> = {
  car: "CAR",
  bus: "BUS",
  truck: "TRUCK",
  motorcycle: "MOTORCYCLE",
};
const MAX_SIGNAL_SAMPLE_GAP_MS = 750;

export const LiveTrafficConsole: React.FC<LiveTrafficConsoleProps> = ({
  simulationRef,
  onSimulationUpdate,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const modelRef = useRef<VehicleDetector | null>(null);
  const tracksRef = useRef<DetectionBox[]>([]);
  const nextTrackIdRef = useRef(1);
  const crossedTracksRef = useRef(new Set<string>());
  const signalObservationsRef = useRef(new Map<string, SignalSample>());
  const fileUrlRef = useRef<string | null>(null);
  const calibrationRef = useRef<LaneCalibrations>(INITIAL_CALIBRATION);
  const calibrationEnabledRef = useRef(false);
  const sourceRef = useRef<VideoSource>("DEMO VIDEO");
  const videoSignalSynchronizedRef = useRef(false);
  const detectionEnabledRef = useRef(false);
  const mountedRef = useRef(false);

  const [source, setSource] = useState<VideoSource>("DEMO VIDEO");
  const [videoFileUrl, setVideoFileUrl] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(true);
  const [detectionEnabled, setDetectionEnabled] = useState(false);
  const [detectionStatus, setDetectionStatus] =
    useState<DetectionStatus>("NOT STARTED");
  const [detectionError, setDetectionError] = useState<string | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [tracks, setTracks] = useState<DetectionBox[]>([]);
  const [fps, setFps] = useState(0);
  const [calibrations, setCalibrations] =
    useState<LaneCalibrations>(INITIAL_CALIBRATION);
  const [calibrationEnabled, setCalibrationEnabled] = useState(false);
  const [videoSignalSynchronized, setVideoSignalSynchronized] = useState(false);
  const [events, setEvents] = useState<DetectionEvent[]>([]);
  const [violationLog, setViolationLog] = useState<ViolationLogEntry[]>([]);
  const [simulationTime, setSimulationTime] = useState(0);

  calibrationRef.current = calibrations;
  calibrationEnabledRef.current = calibrationEnabled;
  sourceRef.current = source;
  videoSignalSynchronizedRef.current = videoSignalSynchronized;
  detectionEnabledRef.current = detectionEnabled;

  const addEvent = useCallback((event: DetectionEvent) => {
    setEvents((current) => [event, ...current].slice(0, 30));
  }, []);

  const selectSource = useCallback((nextSource: VideoSource) => {
    const oldStream = streamRef.current;
    if (oldStream) oldStream.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;

    if (fileUrlRef.current) URL.revokeObjectURL(fileUrlRef.current);
    fileUrlRef.current = null;
    setVideoFileUrl(null);
    setCameraError(null);
    setDetectionError(null);
    setVideoSignalSynchronized(false);
    videoSignalSynchronizedRef.current = false;
    setSource(nextSource);
    setIsPlaying(nextSource !== null);
    setTracks([]);
    tracksRef.current = [];
    crossedTracksRef.current.clear();
    signalObservationsRef.current.clear();
    if (nextSource !== "LIVE CAMERA") {
      setDetectionEnabled(false);
      detectionEnabledRef.current = false;
    }
  }, []);

  const connectCamera = async () => {
    setCameraError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError("Camera access is not supported by this browser or context. Use HTTPS or localhost.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" } },
      });
      selectSource("LIVE CAMERA");
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setIsPlaying(true);
    } catch (error) {
      const name = error instanceof DOMException ? error.name : "";
      const message =
        name === "NotAllowedError" || name === "SecurityError"
          ? "Camera permission was denied. Allow camera access in your browser settings and try again."
          : name === "NotFoundError" || name === "DevicesNotFoundError"
          ? "No camera device is available."
          : name === "NotReadableError" || name === "TrackStartError"
          ? "The camera is busy or could not be started."
          : `Unable to connect to the camera: ${
              error instanceof Error ? error.message : "unknown browser error"
            }`;
      setCameraError(message);
    }
  };

  const disconnectCamera = () => {
    selectSource(null);
    setFps(0);
  };

  const selectVideoFile = (file: File | undefined) => {
    if (!file) return;
    selectSource("VIDEO FILE");
    const url = URL.createObjectURL(file);
    fileUrlRef.current = url;
    setVideoFileUrl(url);
    setIsPlaying(true);
  };

  const togglePlayback = async () => {
    const video = videoRef.current;
    if (!video || !source) return;
    if (isPlaying) {
      video.pause();
      setIsPlaying(false);
      return;
    }
    try {
      await video.play();
      setIsPlaying(true);
      setCameraError(null);
    } catch (error) {
      setCameraError(
        `Unable to resume video: ${
          error instanceof Error ? error.message : "browser playback error"
        }`
      );
    }
  };

  const startDetection = async () => {
    setDetectionError(null);
    setDetectionStatus("LOADING");
    try {
      const model = modelRef.current ?? (await loadVehicleDetector());
      if (!mountedRef.current) {
        if (model !== modelRef.current) model.dispose();
        return;
      }
      modelRef.current = model;
      setDetectionStatus("READY");
      setDetectionEnabled(true);
      detectionEnabledRef.current = true;
    } catch (error) {
      setDetectionStatus("ERROR");
      setDetectionEnabled(false);
      detectionEnabledRef.current = false;
      setDetectionError(
        `Vehicle detector could not load: ${
          error instanceof Error ? error.message : "model or network error"
        }`
      );
    }
  };

  const stopDetection = () => {
    setDetectionEnabled(false);
    detectionEnabledRef.current = false;
    setTracks([]);
    tracksRef.current = [];
    crossedTracksRef.current.clear();
    signalObservationsRef.current.clear();
    setFps(0);
  };

  const changeCalibration = <K extends keyof LaneCalibration,>(
    lane: Direction,
    key: K,
    value: LaneCalibration[K]
  ) => {
    signalObservationsRef.current.clear();
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

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = source === "LIVE CAMERA" ? streamRef.current : null;
    if (source !== "LIVE CAMERA") {
      video.src = source === "DEMO VIDEO" ? "/traffic.mp4" : videoFileUrl ?? "";
      video.load();
      if (source && isPlaying) {
        void video.play().catch((error: unknown) => {
          setCameraError(
            `Unable to play selected video: ${
              error instanceof Error ? error.message : "browser playback error"
            }`
          );
        });
      }
    }
  }, [source, videoFileUrl]);

  useEffect(() => {
    const video = videoRef.current;
    const model = modelRef.current;
    if (!video || !detectionEnabled || !model) return;
    let frameId = 0;
    let lastInference = 0;
    let inferenceInFlight = false;
    let frameCount = 0;
    let fpsStart = performance.now();
    let cancelled = false;

    const renderLoop = (now: number) => {
      if (cancelled) return;
      if (
        sourceRef.current &&
        detectionEnabledRef.current &&
        isPlaying &&
        video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
        now - lastInference >= DETECTION_INTERVAL_MS &&
        !inferenceInFlight
      ) {
        lastInference = now;
        inferenceInFlight = true;
        void detectVehicles(model, video)
          .then((rawDetections) => {
            if (cancelled) return;
            const observedAt = performance.now();
            const updated = updateTracks(
              rawDetections,
              tracksRef.current,
              observedAt,
              nextTrackIdRef.current
            );
            tracksRef.current = updated.tracks;
            nextTrackIdRef.current = updated.nextId;
            setTracks(updated.tracks);

            if (calibrationEnabledRef.current) {
              const sim = simulationRef.current;
              const signalAvailable = sim.started && !sim.finished;
              const currentSignal: Record<Direction, boolean> = {
                NORTH: isLaneRed(sim, "NORTH"),
                EAST: isLaneRed(sim, "EAST"),
                SOUTH: isLaneRed(sim, "SOUTH"),
                WEST: isLaneRed(sim, "WEST"),
              };
              const activeTrackIds = new Set(updated.tracks.map((track) => track.id));
              for (const key of crossedTracksRef.current) {
                const trackId = key.slice(key.indexOf(":") + 1);
                if (!activeTrackIds.has(trackId)) crossedTracksRef.current.delete(key);
              }
              for (const [key, observation] of signalObservationsRef.current) {
                if (observedAt - observation.observedAt > TRACK_EXPIRY_MS) {
                  signalObservationsRef.current.delete(key);
                }
              }

              for (const track of updated.tracks) {
                if (track.lastSeenMs !== observedAt) continue;
                const crossingLanes = DIRECTIONS.filter((lane) =>
                  crossedStopLine(track, calibrationRef.current[lane])
                );
                const unhandledLanes = crossingLanes.filter((lane) => {
                  const key = `${lane}:${track.id}`;
                  if (crossedTracksRef.current.has(key)) return false;
                  crossedTracksRef.current.add(key);
                  return true;
                });
                if (unhandledLanes.length > 0) {
                  const lane = unhandledLanes[0];
                  const eventId = `${lane}:${track.id}:${Math.round(observedAt)}`;
                  const previousSignal = signalObservationsRef.current.get(
                    `${lane}:${track.id}`
                  );
                  if (crossingLanes.length > 1) {
                    addEvent({
                      id: eventId,
                      at: Date.now(),
                      lane,
                      trackingId: track.id,
                      status: "UNVERIFIED",
                      detail: `Overlapping lane regions make this crossing ambiguous (${crossingLanes.join(", ")}).`,
                    });
                  } else if (
                    track.score < VERIFIED_CONFIDENCE ||
                    sourceRef.current === "DEMO VIDEO" ||
                    (sourceRef.current === "VIDEO FILE" &&
                      !videoSignalSynchronizedRef.current)
                  ) {
                    addEvent({
                      id: eventId,
                      at: Date.now(),
                      lane,
                      trackingId: track.id,
                      status: "UNVERIFIED",
                      detail:
                        sourceRef.current === "DEMO VIDEO"
                          ? "Demo footage is not synchronized with the simulation signal."
                          : sourceRef.current === "VIDEO FILE" &&
                            !videoSignalSynchronizedRef.current
                          ? "Video-file time is not synchronized with the active simulation signal."
                          : `Detection confidence ${Math.round(track.score * 100)}% is below the verification threshold.`,
                    });
                  } else if (!currentSignal[lane]) {
                    addEvent({
                      id: eventId,
                      at: Date.now(),
                      lane,
                      trackingId: track.id,
                      status: "CLEARED",
                      detail: "Crossing observed while the authoritative simulation signal was green.",
                    });
                  } else if (
                    !canVerifyRedCrossing(
                      previousSignal,
                      {
                        red: currentSignal[lane],
                        available: signalAvailable,
                        observedAt,
                      },
                      MAX_SIGNAL_SAMPLE_GAP_MS
                    )
                  ) {
                    addEvent({
                      id: eventId,
                      at: Date.now(),
                      lane,
                      trackingId: track.id,
                      status: "UNVERIFIED",
                      detail: "The signal was not continuously verified as red across consecutive detections; the crossing may have started before a phase change.",
                    });
                  } else {
                    const result = recordCameraViolation(sim, lane, track.id);
                    if (result === "RECORDED") {
                      addEvent({
                        id: eventId,
                        at: Date.now(),
                        lane,
                        trackingId: track.id,
                        status: "VIOLATION",
                        detail: "Crossed the calibrated stop line while the authoritative simulation signal remained red.",
                      });
                      setViolationLog(sim.violationLog.map((entry) => ({ ...entry })));
                      onSimulationUpdate();
                    } else {
                      addEvent({
                        id: eventId,
                        at: Date.now(),
                        lane,
                        trackingId: track.id,
                        status: result === "SIGNAL_GREEN" ? "CLEARED" : "UNVERIFIED",
                        detail:
                          result === "SIGNAL_GREEN"
                            ? "Crossing observed while the authoritative signal was green."
                            : result === "SIGNAL_UNAVAILABLE"
                            ? "No active simulation signal is available; no violation was recorded."
                            : "Duplicate crossing already exists in the simulation violation log.",
                      });
                    }
                    setSimulationTime(sim.clock);
                  }
                }

                for (const lane of DIRECTIONS) {
                  if (!isInsideLane(track, calibrationRef.current[lane])) continue;
                  signalObservationsRef.current.set(`${lane}:${track.id}`, {
                    red: currentSignal[lane],
                    available: signalAvailable,
                    observedAt,
                  });
                }
              }
            }

            frameCount++;
            const fpsElapsed = performance.now() - fpsStart;
            if (fpsElapsed >= 1000) {
              setFps(Math.round((frameCount * 1000) / fpsElapsed));
              frameCount = 0;
              fpsStart = performance.now();
            }
          })
          .catch((error: unknown) => {
            if (cancelled) return;
            setDetectionEnabled(false);
            detectionEnabledRef.current = false;
            tracksRef.current = [];
            setTracks([]);
            crossedTracksRef.current.clear();
            signalObservationsRef.current.clear();
            setDetectionStatus("ERROR");
            setDetectionError(
              `Vehicle detection failed: ${
                error instanceof Error ? error.message : "inference error"
              }`
            );
          })
          .finally(() => {
            inferenceInFlight = false;
          });
      }
      frameId = requestAnimationFrame(renderLoop);
    };

    frameId = requestAnimationFrame(renderLoop);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frameId);
    };
  }, [addEvent, detectionEnabled, isPlaying, onSimulationUpdate, simulationRef]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
      if (fileUrlRef.current) URL.revokeObjectURL(fileUrlRef.current);
      modelRef.current?.dispose();
    };
  }, []);

  useEffect(() => {
    const updateLog = () => {
      const sim = simulationRef.current;
      setViolationLog(sim.violationLog.map((entry) => ({ ...entry })));
      setSimulationTime(sim.clock);
    };
    updateLog();
    const timer = window.setInterval(updateLog, 500);
    return () => window.clearInterval(timer);
  }, [simulationRef]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const pixelRatio = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * pixelRatio);
    canvas.height = Math.round(height * pixelRatio);
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, width, height);

    const videoWidth = video.videoWidth || width;
    const videoHeight = video.videoHeight || height;
    const scale = Math.min(width / videoWidth, height / videoHeight);
    const renderedWidth = videoWidth * scale;
    const renderedHeight = videoHeight * scale;
    const offsetX = (width - renderedWidth) / 2;
    const offsetY = (height - renderedHeight) / 2;
    const projectX = (value: number) => offsetX + value * renderedWidth;
    const projectY = (value: number) => offsetY + value * renderedHeight;

    if (calibrationEnabled) {
      for (const lane of DIRECTIONS) {
        const calibration = calibrations[lane];
        context.strokeStyle = LANE_COLOR[lane];
        context.lineWidth = 2;
        context.setLineDash([7, 4]);
        context.strokeRect(
          projectX(calibration.x),
          projectY(calibration.y),
          calibration.width * renderedWidth,
          calibration.height * renderedHeight
        );
        context.setLineDash([]);
        context.beginPath();
        if (calibration.axis === "x") {
          const lineX = projectX(calibration.stopLine);
          context.moveTo(lineX, projectY(calibration.y));
          context.lineTo(lineX, projectY(calibration.y + calibration.height));
        } else {
          const lineY = projectY(calibration.stopLine);
          context.moveTo(projectX(calibration.x), lineY);
          context.lineTo(projectX(calibration.x + calibration.width), lineY);
        }
        context.stroke();
        context.fillStyle = LANE_COLOR[lane];
        context.font = "bold 11px monospace";
        context.fillText(lane, projectX(calibration.x) + 4, projectY(calibration.y) + 14);
      }
    }

    for (const track of tracks) {
      context.strokeStyle = "#34d399";
      context.lineWidth = 2;
      context.strokeRect(
        projectX(track.x),
        projectY(track.y),
        track.width * renderedWidth,
        track.height * renderedHeight
      );
      context.fillStyle = "#064e3b";
      const label = `${track.id} ${VEHICLE_LABEL[track.className] ?? track.className} ${Math.round(track.score * 100)}%`;
      context.font = "bold 10px monospace";
      const labelWidth = context.measureText(label).width + 8;
      const labelY = Math.max(offsetY, projectY(track.y) - 16);
      context.fillRect(projectX(track.x), labelY, labelWidth, 16);
      context.fillStyle = "#ffffff";
      context.fillText(label, projectX(track.x) + 4, labelY + 11);
    }
  }, [calibrationEnabled, calibrations, tracks, source]);

  const laneCounts = Object.fromEntries(
    DIRECTIONS.map((lane) => {
      const laneTracks = calibrationEnabled
        ? tracks.filter((track) => isInsideLane(track, calibrations[lane]))
        : [];
      const calibration = calibrations[lane];
      const queueCount = laneTracks.filter((track) => {
        const coordinate =
          calibration.axis === "x" ? track.centerX : track.centerY;
        return calibration.crossingDirection === "POSITIVE"
          ? coordinate < calibration.stopLine
          : coordinate > calibration.stopLine;
      }).length;
      return [lane, { count: laneTracks.length, queue: queueCount }];
    })
  ) as Record<Direction, { count: number; queue: number }>;

  const laneSignal = (lane: Direction) =>
    isLaneRed(simulationRef.current, lane) ? "RED" : "GREEN";

  const videoSource = source === "DEMO VIDEO" ? "/traffic.mp4" : videoFileUrl ?? undefined;
  const recentViolations = [...violationLog].reverse().slice(0, 6);

  return (
    <div className="space-y-6 font-mono text-slate-100">
      <div className="flex flex-wrap items-center justify-between gap-3 p-4 bg-slate-900 border border-slate-700/60 rounded-xl">
        <div>
          <div className="text-xs font-bold text-white uppercase tracking-wider">
            LIVE CCTV FEED — CAMERA INPUT & VEHICLE DETECTION
          </div>
          <p className="mt-1 text-[10px] text-slate-400">
            Browser-local inference. Video frames are not uploaded.
          </p>
        </div>
        <span className={`text-[10px] border px-2 py-1 rounded font-bold ${
          source === "LIVE CAMERA"
            ? "bg-rose-950 text-rose-300 border-rose-500/40"
            : source
            ? "bg-amber-950 text-amber-300 border-amber-500/40"
            : "bg-slate-800 text-slate-400 border-slate-700"
        }`}>
          SOURCE: {source ?? "DISCONNECTED"}
        </span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <section className="lg:col-span-7 bg-slate-900 border border-slate-700/60 p-4 rounded-2xl space-y-4">
          <div className="relative aspect-video w-full bg-black rounded-xl border border-slate-800 overflow-hidden">
            {source ? (
              <video
                ref={videoRef}
                src={source === "LIVE CAMERA" ? undefined : videoSource}
                autoPlay
                loop={source === "DEMO VIDEO"}
                muted
                playsInline
                onLoadedMetadata={() => {
                  if (isPlaying) {
                    void videoRef.current?.play().catch((error: unknown) => {
                      setCameraError(
                        `Unable to play selected video: ${
                          error instanceof Error ? error.message : "browser playback error"
                        }`
                      );
                    });
                  }
                }}
                onError={() => {
                  if (source !== "LIVE CAMERA") {
                    setCameraError(
                      source === "DEMO VIDEO"
                        ? "The bundled demo video could not be loaded."
                        : "The selected video file could not be decoded."
                    );
                  }
                }}
                className="absolute inset-0 h-full w-full object-contain"
              />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center text-xs text-slate-500">
                No video source connected
              </div>
            )}
            <canvas
              ref={canvasRef}
              className="absolute inset-0 h-full w-full pointer-events-none"
            />
            <div className="absolute top-3 left-3 flex flex-wrap gap-2 text-[10px] font-bold">
              <span className="bg-black/80 border border-slate-700 px-2 py-1 rounded">
                {source ?? "DISCONNECTED"}
              </span>
              <span className="bg-black/80 border border-slate-700 px-2 py-1 rounded text-cyan-300">
                DETECTOR: {detectionEnabled ? detectionStatus : "PAUSED"}
              </span>
            </div>
            {detectionError && (
              <div className="absolute bottom-3 left-3 right-3 bg-rose-950/95 border border-rose-500/50 p-2 rounded text-[10px] text-rose-200">
                {detectionError}
              </div>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            <button onClick={connectCamera} className="rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-3 py-2 text-[11px] font-bold text-cyan-300 hover:bg-cyan-500/20">
              CONNECT CAMERA
            </button>
            <button onClick={togglePlayback} disabled={!source} className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-[11px] font-bold text-white disabled:opacity-40">
              {isPlaying ? "PAUSE" : "START"}
            </button>
            <button onClick={disconnectCamera} disabled={!source} className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-[11px] font-bold text-rose-300 disabled:opacity-40">
              DISCONNECT
            </button>
            <button onClick={() => selectSource("DEMO VIDEO")} className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] font-bold text-amber-300">
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
            {detectionEnabled ? (
              <button onClick={stopDetection} className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-[11px] font-bold text-emerald-300">
                STOP DETECTION
              </button>
            ) : (
              <button
                onClick={() => void startDetection()}
                disabled={!source || detectionStatus === "LOADING"}
                className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-[11px] font-bold text-emerald-300 disabled:opacity-40"
              >
                {detectionStatus === "LOADING" ? "LOADING MODEL..." : "START DETECTION"}
              </button>
            )}
          </div>

          {cameraError && (
            <div role="alert" className="rounded-lg border border-rose-500/40 bg-rose-950/40 p-3 text-[11px] text-rose-200">
              {cameraError}
            </div>
          )}

          {source === "VIDEO FILE" && (
            <label className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-[10px] text-amber-200">
              <input
                type="checkbox"
                checked={videoSignalSynchronized}
                onChange={(event) => {
                  signalObservationsRef.current.clear();
                  crossedTracksRef.current.clear();
                  setVideoSignalSynchronized(event.currentTarget.checked);
                }}
              />
              I confirm this video file is synchronized with the active simulation signal (simulation demonstration only).
            </label>
          )}

          <div className="grid grid-cols-3 gap-2 text-center">
            <Metric label="DETECTIONS" value={String(tracks.filter((track) => performance.now() - track.lastSeenMs < 1000).length)} />
            <Metric label="INFERENCE FPS" value={String(fps)} />
            <Metric label="MODEL" value={detectionStatus} />
          </div>
          <p className="text-[10px] leading-relaxed text-slate-500">
            COCO-SSD Lite MobileNet v2 detects cars, buses, trucks, and motorcycles. Model weights are fetched by the browser when detection starts; inference runs locally and camera frames are not sent to a service.
          </p>
        </section>

        <section className="lg:col-span-5 bg-slate-900 border border-slate-700/60 p-5 rounded-2xl space-y-4">
          <h3 className="text-xs font-bold text-cyan-400 uppercase tracking-wider">
            Camera detections & simulation signals
          </h3>
          {!calibrationEnabled && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-[10px] text-amber-200">
              Lane counts and stop-line checks are disabled until this camera angle is calibrated. Bounding boxes remain available.
            </div>
          )}
          <div className="space-y-2">
            {DIRECTIONS.map((lane) => (
              <div key={lane} className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-[11px]">
                <span style={{ color: LANE_COLOR[lane] }} className="font-bold">{lane}</span>
                <span className="text-slate-300">
                  {calibrationEnabled ? `${laneCounts[lane].count} detected · ${laneCounts[lane].queue} queued` : "NOT CALIBRATED"}
                </span>
                <span className={laneSignal(lane) === "GREEN" ? "text-emerald-300" : "text-rose-300"}>
                  SIM {laneSignal(lane)}
                </span>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Metric label="SIMULATION TIME" value={`${simulationTime.toFixed(1)}s`} />
            <Metric label="VERIFIED VIOLATIONS" value={String(violationLog.length)} />
          </div>
          <p className="text-[10px] text-slate-500">
            Recommended signal changes are intentionally omitted: the camera does not control signals. The simulation engine remains authoritative.
          </p>
        </section>
      </div>

      <section className="rounded-2xl border border-slate-700/60 bg-slate-900 p-4 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wider text-amber-300">Lane regions & virtual stop lines</h3>
            <p className="mt-1 text-[10px] text-slate-400">Coordinates are normalized to the video frame (0–100%). Each region is explicitly mapped to its named simulator lane.</p>
          </div>
          <label className="flex items-center gap-2 text-[10px] font-bold text-slate-200">
            <input
              type="checkbox"
              checked={calibrationEnabled}
              onChange={(event) => {
                signalObservationsRef.current.clear();
                crossedTracksRef.current.clear();
                setCalibrationEnabled(event.currentTarget.checked);
              }}
            />
            I calibrated these regions and stop lines for this camera
          </label>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {DIRECTIONS.map((lane) => (
            <div key={lane} className="rounded-xl border border-slate-800 bg-slate-950/50 p-3 space-y-3">
              <div className="text-[11px] font-bold" style={{ color: LANE_COLOR[lane] }}>{lane} CAMERA REGION</div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-2">
                {(["x", "y", "width", "height"] as const).map((field) => (
                  <label key={field} className="text-[9px] text-slate-400">
                    ROI {field.toUpperCase()} {Math.round(calibrations[lane][field] * 100)}%
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={Math.round(calibrations[lane][field] * 100)}
                      onChange={(event) =>
                        changeCalibration(lane, field, Number(event.currentTarget.value) / 100)
                      }
                      className="mt-1 block w-full accent-cyan-400"
                    />
                  </label>
                ))}
              </div>
              <div className="grid grid-cols-3 gap-2">
                <label className="text-[9px] text-slate-400">
                  LINE AXIS
                  <select
                    value={calibrations[lane].axis}
                    onChange={(event) =>
                      changeCalibration(
                        lane,
                        "axis",
                        event.currentTarget.value === "x" ? "x" : "y"
                      )
                    }
                    className="mt-1 w-full rounded bg-slate-900 p-1 text-[10px] text-white"
                  >
                    <option value="x">Vertical (X)</option>
                    <option value="y">Horizontal (Y)</option>
                  </select>
                </label>
                <label className="text-[9px] text-slate-400">
                  LINE {Math.round(calibrations[lane].stopLine * 100)}%
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={Math.round(calibrations[lane].stopLine * 100)}
                    onChange={(event) =>
                      changeCalibration(lane, "stopLine", Number(event.currentTarget.value) / 100)
                    }
                    className="mt-2 block w-full accent-rose-400"
                  />
                </label>
                <label className="text-[9px] text-slate-400">
                  CROSSING
                  <select
                    value={calibrations[lane].crossingDirection}
                    onChange={(event) =>
                      changeCalibration(
                        lane,
                        "crossingDirection",
                        event.currentTarget.value === "POSITIVE" ? "POSITIVE" : "NEGATIVE"
                      )
                    }
                    className="mt-1 w-full rounded bg-slate-900 p-1 text-[10px] text-white"
                  >
                    <option value="POSITIVE">Low to high</option>
                    <option value="NEGATIVE">High to low</option>
                  </select>
                </label>
              </div>
            </div>
          ))}
        </div>
        <p className="text-[10px] text-amber-200/80">
          Confirmed crossings require active calibration, stable tracking, sufficient model confidence, and consecutive red-signal samples from the shared simulation. Demo footage is always UNVERIFIED; video files stay UNVERIFIED unless the operator explicitly confirms signal-time synchronization.
        </p>
      </section>

      <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <EventPanel events={events} />
        <div className="rounded-2xl border border-slate-700/60 bg-slate-900 p-4">
          <h3 className="mb-3 text-xs font-bold uppercase tracking-wider text-rose-300">Verified simulation violations</h3>
          {recentViolations.length === 0 ? (
            <p className="text-[10px] text-slate-500">No verified visual violations recorded.</p>
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
        </div>
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

const EventPanel: React.FC<{ events: DetectionEvent[] }> = ({ events }) => (
  <div className="rounded-2xl border border-slate-700/60 bg-slate-900 p-4">
    <h3 className="mb-3 text-xs font-bold uppercase tracking-wider text-cyan-300">Recent visual crossing events</h3>
    {events.length === 0 ? (
      <p className="text-[10px] text-slate-500">No calibrated stop-line crossings observed.</p>
    ) : (
      <ul className="space-y-2">
        {events.map((event) => (
          <li key={event.id} className="rounded-lg border border-slate-800 bg-slate-950/60 p-2 text-[10px]">
            <div className="flex justify-between gap-2">
              <span className={`font-bold ${
                event.status === "VIOLATION" ? "text-rose-300" :
                event.status === "UNVERIFIED" ? "text-amber-300" : "text-emerald-300"
              }`}>{event.status} · {event.lane} · {event.trackingId}</span>
              <time className="text-slate-500">{new Date(event.at).toLocaleTimeString()}</time>
            </div>
            <p className="mt-1 text-slate-400">{event.detail}</p>
          </li>
        ))}
      </ul>
    )}
  </div>
);

export default LiveTrafficConsole;
