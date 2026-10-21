import type { DetectedObject, ObjectDetection } from "@tensorflow-models/coco-ssd";

export const VEHICLE_CLASSES = new Set(["car", "bus", "truck", "motorcycle"]);
export const DETECTION_INTERVAL_MS = 250;
export const TRACK_EXPIRY_MS = 2000;
export const VEHICLE_CONFIDENCE = 0.35;
export const VERIFIED_CONFIDENCE = 0.65;
export const TRACK_MATCH_DISTANCE = 0.12;

export interface DetectionBox {
  id: string;
  className: string;
  score: number;
  x: number;
  y: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  previousCenterX: number | null;
  previousCenterY: number | null;
  lastSeenMs: number;
}

export interface RawDetection {
  className: string;
  score: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LaneCalibration {
  x: number;
  y: number;
  width: number;
  height: number;
  axis: "x" | "y";
  stopLine: number;
  crossingDirection: "POSITIVE" | "NEGATIVE";
}

export interface SignalSample {
  red: boolean;
  available: boolean;
  observedAt: number;
}

export type LaneCalibrations = Record<
  "NORTH" | "EAST" | "SOUTH" | "WEST",
  LaneCalibration
>;

export type VehicleDetector = Pick<ObjectDetection, "detect" | "dispose">;

export async function loadVehicleDetector(): Promise<VehicleDetector> {
  // The model and weights are downloaded by the browser; frames stay on-device.
  const tf = await import("@tensorflow/tfjs-core");
  await import("@tensorflow/tfjs-backend-webgl");
  await import("@tensorflow/tfjs-backend-cpu");
  let backendReady = false;
  try {
    backendReady = await tf.setBackend("webgl");
  } catch {
    backendReady = false;
  }
  if (!backendReady) backendReady = await tf.setBackend("cpu");
  if (!backendReady) throw new Error("No supported TensorFlow.js backend is available.");
  await tf.ready();
  const cocoSsd = await import("@tensorflow-models/coco-ssd");
  return cocoSsd.load({ base: "lite_mobilenet_v2" });
}

export async function detectVehicles(
  model: VehicleDetector,
  video: HTMLVideoElement
): Promise<RawDetection[]> {
  const predictions = await model.detect(video, 30, VEHICLE_CONFIDENCE);
  return predictions
    .filter((prediction: DetectedObject) =>
      VEHICLE_CLASSES.has(prediction.class)
    )
    .map((prediction) => ({
      className: prediction.class,
      score: prediction.score,
      x: prediction.bbox[0] / video.videoWidth,
      y: prediction.bbox[1] / video.videoHeight,
      width: prediction.bbox[2] / video.videoWidth,
      height: prediction.bbox[3] / video.videoHeight,
    }));
}

export function updateTracks(
  detections: RawDetection[],
  previousTracks: DetectionBox[],
  now: number,
  nextId: number
): { tracks: DetectionBox[]; nextId: number } {
  const available = new Set(
    previousTracks
      .filter((track) => now - track.lastSeenMs <= TRACK_EXPIRY_MS)
      .map((track) => track.id)
  );
  const tracks: DetectionBox[] = [];

  for (const detection of detections) {
    const centerX = detection.x + detection.width / 2;
    const centerY = detection.y + detection.height / 2;
    let match: DetectionBox | undefined;
    let matchDistance = TRACK_MATCH_DISTANCE;

    for (const candidate of previousTracks) {
      if (!available.has(candidate.id) || candidate.className !== detection.className) continue;
      const distance = Math.hypot(
        candidate.centerX - centerX,
        candidate.centerY - centerY
      );
      if (distance < matchDistance) {
        match = candidate;
        matchDistance = distance;
      }
    }

    const id = match?.id ?? `CAM-${String(nextId++).padStart(4, "0")}`;
    if (match) available.delete(match.id);
    tracks.push({
      id,
      className: detection.className,
      score: detection.score,
      x: detection.x,
      y: detection.y,
      width: detection.width,
      height: detection.height,
      centerX,
      centerY,
      previousCenterX: match?.centerX ?? null,
      previousCenterY: match?.centerY ?? null,
      lastSeenMs: now,
    });
  }

  return {
    tracks: [
      ...tracks,
      ...previousTracks.filter(
        (track) =>
          available.has(track.id) && now - track.lastSeenMs <= TRACK_EXPIRY_MS
      ),
    ],
    nextId,
  };
}

export function isInsideLane(
  track: DetectionBox,
  calibration: LaneCalibration
): boolean {
  return (
    track.centerX >= calibration.x &&
    track.centerX <= calibration.x + calibration.width &&
    track.centerY >= calibration.y &&
    track.centerY <= calibration.y + calibration.height
  );
}

function pointInsideLane(
  x: number,
  y: number,
  calibration: LaneCalibration
): boolean {
  return (
    x >= calibration.x &&
    x <= calibration.x + calibration.width &&
    y >= calibration.y &&
    y <= calibration.y + calibration.height
  );
}

export function crossedStopLine(
  track: DetectionBox,
  calibration: LaneCalibration
): boolean {
  if (
    track.previousCenterX === null ||
    track.previousCenterY === null ||
    !isInsideLane(track, calibration) ||
    !pointInsideLane(track.previousCenterX, track.previousCenterY, calibration)
  ) {
    return false;
  }
  const previous =
    calibration.axis === "x" ? track.previousCenterX : track.previousCenterY;
  const current =
    calibration.axis === "x" ? track.centerX : track.centerY;

  return calibration.crossingDirection === "POSITIVE"
    ? previous < calibration.stopLine && current >= calibration.stopLine
    : previous > calibration.stopLine && current <= calibration.stopLine;
}

/** A red crossing is confirmed only if consecutive samples bracket it on red. */
export function canVerifyRedCrossing(
  previous: SignalSample | undefined,
  current: SignalSample,
  maximumGapMs: number
): boolean {
  return Boolean(
    previous &&
      previous.available &&
      previous.red &&
      current.available &&
      current.red &&
      current.observedAt - previous.observedAt <= maximumGapMs
  );
}
