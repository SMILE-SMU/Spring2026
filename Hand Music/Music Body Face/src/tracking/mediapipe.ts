/**
 * Mediapipe tracking wrapper for Music Body Face
 * Uses MediaPipe Hand Landmarker + Pose Landmarker (Tasks Vision API)
 */

import {
  HandLandmarker,
  PoseLandmarker,
  FilesetResolver,
  type HandLandmarkerResult,
  type PoseLandmarkerResult,
} from "@mediapipe/tasks-vision";

export interface Landmark {
  x: number;
  y: number;
  z: number;
}

export interface HandData {
  landmarks: Landmark[];
  handedness: "Left" | "Right";
  bodyRelativeY: number;
}

export interface TrackingResult {
  hands: HandData[]; // 0-2 hands detected
  poseLandmarks: Landmark[] | null;
}

export interface Tracker {
  handLandmarker: HandLandmarker | null;
  poseLandmarker: PoseLandmarker | null;
  isReady: boolean;
}

// Hand landmark indices (21 per hand)
export const HAND = {
  WRIST: 0,
  THUMB_CMC: 1,
  THUMB_MCP: 2,
  THUMB_IP: 3,
  THUMB_TIP: 4,
  INDEX_MCP: 5,
  INDEX_PIP: 6,
  INDEX_DIP: 7,
  INDEX_TIP: 8,
  MIDDLE_MCP: 9,
  MIDDLE_PIP: 10,
  MIDDLE_DIP: 11,
  MIDDLE_TIP: 12,
  RING_MCP: 13,
  RING_PIP: 14,
  RING_DIP: 15,
  RING_TIP: 16,
  PINKY_MCP: 17,
  PINKY_PIP: 18,
  PINKY_DIP: 19,
  PINKY_TIP: 20,
} as const;

// Pose landmark indices (33 landmarks)
export const POSE = {
  NOSE: 0,
  LEFT_EYE_INNER: 1,
  LEFT_EYE: 2,
  LEFT_EYE_OUTER: 3,
  RIGHT_EYE_INNER: 4,
  RIGHT_EYE: 5,
  RIGHT_EYE_OUTER: 6,
  LEFT_EAR: 7,
  RIGHT_EAR: 8,
  MOUTH_LEFT: 9,
  MOUTH_RIGHT: 10,
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_PINKY: 17,
  RIGHT_PINKY: 18,
  LEFT_INDEX: 19,
  RIGHT_INDEX: 20,
  LEFT_THUMB: 21,
  RIGHT_THUMB: 22,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
} as const;

export function createTracker(): Tracker {
  return {
    handLandmarker: null,
    poseLandmarker: null,
    isReady: false,
  };
}

export async function initializeTracker(tracker: Tracker, performanceMode: boolean = false): Promise<void> {
  const vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
  );

  // In performance mode, try CPU first as it's more compatible
  // In normal mode, try GPU first for speed
  const delegate = performanceMode ? "CPU" : "GPU";

  try {
    // Initialize hand landmarker for 2 hands
    tracker.handLandmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath:
          "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
        delegate,
      },
      runningMode: "VIDEO",
      numHands: 2,
    });
  } catch (e) {
    console.warn("GPU hand tracking failed, falling back to CPU");
    tracker.handLandmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath:
          "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
        delegate: "CPU",
      },
      runningMode: "VIDEO",
      numHands: 2,
    });
  }

  // Only initialize pose landmarker if NOT in performance mode
  if (!performanceMode) {
    try {
      tracker.poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath:
            "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
          delegate,
        },
        runningMode: "VIDEO",
        numPoses: 1,
      });
    } catch (e) {
      console.warn("GPU pose tracking failed, falling back to CPU");
      tracker.poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath:
            "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
          delegate: "CPU",
        },
        runningMode: "VIDEO",
        numPoses: 1,
      });
    }
    console.log("Hand + Pose trackers initialized");
  } else {
    console.log("Hand tracker initialized (Performance Mode - no pose tracking)");
  }

  tracker.isReady = true;
}

/**
 * Calculate body-relative hand position.
 * Returns 0 when hand is at lowest visible body part, 1 when above highest.
 * Adapts to whatever body parts are visible on screen.
 */
function calculateBodyRelativeHandY(
  handWristY: number,
  poseLandmarks: Landmark[] | null
): number {
  if (!poseLandmarks) {
    // Fallback: use absolute position (0.7 = low, 0.3 = high in frame)
    return 1 - handWristY;
  }

  // Find the highest and lowest visible body landmarks
  // Priority for high point: nose > eyes > ears > shoulders
  // Priority for low point: hips > shoulders (if hips not visible)
  
  let highestY: number | null = null;
  let lowestY: number | null = null;
  
  // Check for high point (head area)
  const headPoints = [
    poseLandmarks[POSE.NOSE],
    poseLandmarks[POSE.LEFT_EYE],
    poseLandmarks[POSE.RIGHT_EYE],
    poseLandmarks[POSE.LEFT_EAR],
    poseLandmarks[POSE.RIGHT_EAR],
  ].filter(p => p && p.y > 0 && p.y < 1); // Valid points in frame
  
  if (headPoints.length > 0) {
    // Use the highest (smallest Y) head point
    highestY = Math.min(...headPoints.map(p => p.y));
    // Extend above head
    highestY = Math.max(0, highestY - 0.1);
  }
  
  // Check for low point
  const leftHip = poseLandmarks[POSE.LEFT_HIP];
  const rightHip = poseLandmarks[POSE.RIGHT_HIP];
  const leftShoulder = poseLandmarks[POSE.LEFT_SHOULDER];
  const rightShoulder = poseLandmarks[POSE.RIGHT_SHOULDER];
  
  // Try hips first
  if (leftHip && rightHip && leftHip.y > 0 && rightHip.y > 0) {
    lowestY = (leftHip.y + rightHip.y) / 2;
  } 
  // Fall back to shoulders if hips not visible (chest level)
  else if (leftShoulder && rightShoulder && leftShoulder.y > 0 && rightShoulder.y > 0) {
    lowestY = (leftShoulder.y + rightShoulder.y) / 2;
    // Add some range below shoulders to represent chest
    lowestY = Math.min(1, lowestY + 0.15);
  }
  
  // If we couldn't find reference points, use frame-relative
  if (highestY === null || lowestY === null) {
    return 1 - handWristY;
  }
  
  // Calculate relative position
  const bodyRange = lowestY - highestY;
  if (bodyRange <= 0.05) return 0.5; // Range too small
  
  const relativeY = (lowestY - handWristY) / bodyRange;
  return Math.max(0, Math.min(1, relativeY));
}

export function processFrame(
  tracker: Tracker,
  video: HTMLVideoElement,
  timestamp: number
): TrackingResult | null {
  if (!tracker.isReady || !tracker.handLandmarker) {
    return null;
  }

  // Process hand tracking (up to 2 hands)
  const handResult: HandLandmarkerResult = tracker.handLandmarker.detectForVideo(
    video,
    timestamp
  );

  // Process pose tracking (only if available - not in performance mode)
  let poseResult: PoseLandmarkerResult | null = null;
  if (tracker.poseLandmarker) {
    poseResult = tracker.poseLandmarker.detectForVideo(video, timestamp);
  }

  // Extract pose landmarks (if available)
  let poseLandmarks: Landmark[] | null = null;
  if (poseResult && poseResult.landmarks && poseResult.landmarks.length > 0) {
    poseLandmarks = poseResult.landmarks[0].map((lm) => ({
      x: lm.x,
      y: lm.y,
      z: lm.z,
    }));
  }

  // Extract all detected hands (0-2)
  const hands: HandData[] = [];
  
  if (handResult.landmarks && handResult.landmarks.length > 0) {
    for (let i = 0; i < handResult.landmarks.length; i++) {
      const landmarks = handResult.landmarks[i].map((lm) => ({
        x: lm.x,
        y: lm.y,
        z: lm.z,
      }));
      
      const handedness = handResult.handednesses?.[i]?.[0]?.categoryName as "Left" | "Right" ?? "Right";
      const wristY = landmarks[HAND.WRIST].y;
      const bodyRelativeY = calculateBodyRelativeHandY(wristY, poseLandmarks);
      
      hands.push({ landmarks, handedness, bodyRelativeY });
    }
  }

  return { hands, poseLandmarks };
}

export function drawLandmarks(
  ctx: CanvasRenderingContext2D,
  result: TrackingResult
): void {
  const { width, height } = ctx.canvas;
  ctx.clearRect(0, 0, width, height);

  // Draw pose landmarks (skeleton)
  if (result.poseLandmarks) {
    const poseConnections = [
      [POSE.LEFT_SHOULDER, POSE.RIGHT_SHOULDER],
      [POSE.LEFT_SHOULDER, POSE.LEFT_ELBOW],
      [POSE.LEFT_ELBOW, POSE.LEFT_WRIST],
      [POSE.RIGHT_SHOULDER, POSE.RIGHT_ELBOW],
      [POSE.RIGHT_ELBOW, POSE.RIGHT_WRIST],
      [POSE.LEFT_SHOULDER, POSE.LEFT_HIP],
      [POSE.RIGHT_SHOULDER, POSE.RIGHT_HIP],
      [POSE.LEFT_HIP, POSE.RIGHT_HIP],
    ];

    ctx.strokeStyle = "#4488ff44";
    ctx.lineWidth = 3;
    for (const [from, to] of poseConnections) {
      const fromLm = result.poseLandmarks[from];
      const toLm = result.poseLandmarks[to];
      if (fromLm && toLm) {
        ctx.beginPath();
        ctx.moveTo(fromLm.x * width, fromLm.y * height);
        ctx.lineTo(toLm.x * width, toLm.y * height);
        ctx.stroke();
      }
    }

    // Draw key pose landmarks
    ctx.fillStyle = "#4488ff44";
    const keyPosePoints = [POSE.NOSE, POSE.LEFT_SHOULDER, POSE.RIGHT_SHOULDER, POSE.LEFT_HIP, POSE.RIGHT_HIP];
    for (const idx of keyPosePoints) {
      const lm = result.poseLandmarks[idx];
      if (lm) {
        ctx.beginPath();
        ctx.arc(lm.x * width, lm.y * height, 6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // Draw hand landmarks for each detected hand
  const handColors = ["#00ff88", "#ff8800"]; // Green for first hand, orange for second
  const connections = [
    [HAND.WRIST, HAND.THUMB_CMC], [HAND.THUMB_CMC, HAND.THUMB_MCP], 
    [HAND.THUMB_MCP, HAND.THUMB_IP], [HAND.THUMB_IP, HAND.THUMB_TIP],
    [HAND.WRIST, HAND.INDEX_MCP], [HAND.INDEX_MCP, HAND.INDEX_PIP],
    [HAND.INDEX_PIP, HAND.INDEX_DIP], [HAND.INDEX_DIP, HAND.INDEX_TIP],
    [HAND.WRIST, HAND.MIDDLE_MCP], [HAND.MIDDLE_MCP, HAND.MIDDLE_PIP],
    [HAND.MIDDLE_PIP, HAND.MIDDLE_DIP], [HAND.MIDDLE_DIP, HAND.MIDDLE_TIP],
    [HAND.WRIST, HAND.RING_MCP], [HAND.RING_MCP, HAND.RING_PIP],
    [HAND.RING_PIP, HAND.RING_DIP], [HAND.RING_DIP, HAND.RING_TIP],
    [HAND.WRIST, HAND.PINKY_MCP], [HAND.PINKY_MCP, HAND.PINKY_PIP],
    [HAND.PINKY_PIP, HAND.PINKY_DIP], [HAND.PINKY_DIP, HAND.PINKY_TIP],
    [HAND.INDEX_MCP, HAND.MIDDLE_MCP], [HAND.MIDDLE_MCP, HAND.RING_MCP],
    [HAND.RING_MCP, HAND.PINKY_MCP],
  ];

  for (let handIdx = 0; handIdx < result.hands.length; handIdx++) {
    const hand = result.hands[handIdx];
    const color = handColors[handIdx % handColors.length];
    
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    for (const [from, to] of connections) {
      const fromLm = hand.landmarks[from];
      const toLm = hand.landmarks[to];
      ctx.beginPath();
      ctx.moveTo(fromLm.x * width, fromLm.y * height);
      ctx.lineTo(toLm.x * width, toLm.y * height);
      ctx.stroke();
    }

    // Draw each landmark as a dot
    ctx.fillStyle = color;
    for (const lm of hand.landmarks) {
      const x = lm.x * width;
      const y = lm.y * height;
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
    }

    // Highlight index finger tip
    const indexTip = hand.landmarks[HAND.INDEX_TIP];
    if (indexTip) {
      ctx.fillStyle = "#ff3366";
      ctx.beginPath();
      ctx.arc(indexTip.x * width, indexTip.y * height, 8, 0, Math.PI * 2);
      ctx.fill();
    }
    
    // Draw handedness label
    ctx.fillStyle = color;
    ctx.font = "14px sans-serif";
    ctx.textAlign = "center";
    const wrist = hand.landmarks[HAND.WRIST];
    ctx.fillText(hand.handedness, wrist.x * width, wrist.y * height + 20);
  }

  // Draw body-relative indicator for each hand (vertical bars on the side)
  const barWidth = 20;
  const barSpacing = 25;
  const barTop = 50;
  const barHeight = height - 100;
  
  for (let i = 0; i < result.hands.length; i++) {
    const hand = result.hands[i];
    const barX = width - 30 - (i * barSpacing);
    const color = handColors[i % handColors.length];
    
    // Background bar
    ctx.fillStyle = "#ffffff22";
    ctx.fillRect(barX - 5, barTop, 10, barHeight);
    
    // Position indicator (screen-space wrist Y: 0 = top, 1 = bottom)
    const wristY = hand.landmarks[HAND.WRIST]?.y ?? 0.5;
    const clampedWristY = Math.max(0, Math.min(1, wristY));
    const indicatorY = barTop + clampedWristY * barHeight;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(barX, indicatorY, 8, 0, Math.PI * 2);
    ctx.fill();
  }
  
  // Labels (only once)
  if (result.hands.length > 0) {
    const barX = width - 30;
    ctx.fillStyle = "#ffffff88";
    ctx.font = "12px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("HIGH", barX, barTop - 10);
    ctx.fillText("LOW", barX, barTop + barHeight + 20);
  }
}
