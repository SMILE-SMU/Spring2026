/**
 * Mediapipe tracking wrapper for Music Body Face
 * Uses MediaPipe Hand Landmarker (Tasks Vision API)
 */

import {
  HandLandmarker,
  FilesetResolver,
  type HandLandmarkerResult,
} from "@mediapipe/tasks-vision";

export interface Landmark {
  x: number;
  y: number;
  z: number;
}

export interface HandData {
  landmarks: Landmark[];
  handedness: "Left" | "Right";
}

export interface TrackingResult {
  hands: HandData[]; // 0-2 hands detected
}

export interface TrailPoint {
  x: number; // normalized 0-1
  y: number; // normalized 0-1
  width: number; // pixels
}

export interface HandTrail {
  handedness: "Left" | "Right";
  points: TrailPoint[];
  color: string; // any valid canvas strokeStyle
  alpha: number; // 0-1
}

export interface DrawOverlays {
  trails?: HandTrail[];
}

export interface Tracker {
  handLandmarker: HandLandmarker | null;
  isReady: boolean;
  // Track current settings for potential reinitialization
  currentNumHands: number;
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

export function createTracker(): Tracker {
  return {
    handLandmarker: null,
    isReady: false,
    currentNumHands: 2,
  };
}

// Cache the vision fileset so we don't reload WASM on reinitialization
let cachedVision: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>> | null = null;

/**
 * Check if WebGL is available. MediaPipe requires WebGL for video frame processing
 * even when running inference on CPU.
 */
export function checkWebGLSupport(): { supported: boolean; error?: string } {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) {
      return {
        supported: false,
        error: 'WebGL is not available. This is usually caused by outdated graphics drivers or disabled hardware acceleration.'
      };
    }
    return { supported: true };
  } catch (e) {
    return {
      supported: false,
      error: `WebGL check failed: ${e instanceof Error ? e.message : 'Unknown error'}`
    };
  }
}

export async function initializeTracker(
  tracker: Tracker,
  numHands: number = 2
): Promise<void> {
  // Check WebGL support first - MediaPipe requires it even for CPU inference
  const webglCheck = checkWebGLSupport();
  if (!webglCheck.supported) {
    throw new Error(`WebGL Required: ${webglCheck.error}\n\nTo fix this:\n1. Update your graphics drivers\n2. Enable hardware acceleration in your browser (Chrome: Settings → System → "Use hardware acceleration")\n3. Try a different browser (Chrome recommended)\n4. Check chrome://gpu for details`);
  }

  // Reuse cached vision fileset if available
  if (!cachedVision) {
    cachedVision = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
    );
  }
  const vision = cachedVision;

  // Close existing hand landmarker if reinitializing
  if (tracker.handLandmarker) {
    tracker.handLandmarker.close();
    tracker.handLandmarker = null;
  }

  try {
    // Initialize hand landmarker with GPU acceleration
    // Lower confidence thresholds slightly for faster detection (~5-10ms savings)
    tracker.handLandmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath:
          "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
        delegate: "GPU",
      },
      runningMode: "VIDEO",
      numHands,
      minHandDetectionConfidence: 0.4, // Default is 0.5
      minHandPresenceConfidence: 0.4, // Default is 0.5
      minTrackingConfidence: 0.4, // Default is 0.5
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
      numHands,
      minHandDetectionConfidence: 0.4,
      minHandPresenceConfidence: 0.4,
      minTrackingConfidence: 0.4,
    });
  }

  console.log(`Hand tracker initialized (${numHands} hand${numHands > 1 ? 's' : ''})`);
  tracker.currentNumHands = numHands;
  tracker.isReady = true;
}

/**
 * Reinitialize tracker with different number of hands.
 * Used when switching between single-hand and two-hand mode for lower latency.
 */
export async function setNumHands(tracker: Tracker, numHands: number): Promise<void> {
  if (!tracker.isReady) return;
  if (tracker.currentNumHands === numHands) return;

  console.log(`[LATENCY] Reinitializing tracker for ${numHands} hand(s)`);
  await initializeTracker(tracker, numHands);
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
      hands.push({ landmarks, handedness });
    }
  }

  return { hands };
}

export function drawLandmarks(
  ctx: CanvasRenderingContext2D,
  result: TrackingResult,
  overlays?: DrawOverlays
): void {
  const { width, height } = ctx.canvas;
  ctx.clearRect(0, 0, width, height);

  // Draw hand-movement trails (per-note)
  if (overlays?.trails && overlays.trails.length > 0) {
    for (const trail of overlays.trails) {
      if (!trail.points || trail.points.length < 2) continue;
      if (trail.alpha <= 0) continue;

      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, trail.alpha));
      ctx.strokeStyle = trail.color;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.shadowColor = trail.color;
      ctx.shadowBlur = 12;

      // Vary thickness by stroking each segment separately.
      for (let i = 1; i < trail.points.length; i++) {
        const a = trail.points[i - 1];
        const b = trail.points[i];
        const segmentWidth = Math.max(1, (a.width + b.width) / 2);
        ctx.lineWidth = segmentWidth;
        ctx.beginPath();
        ctx.moveTo(a.x * width, a.y * height);
        ctx.lineTo(b.x * width, b.y * height);
        ctx.stroke();
      }

      ctx.restore();
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
    
    // Position indicator (screen-space palm center Y: 0 = top, 1 = bottom)
    const wrist = hand.landmarks[HAND.WRIST];
    const indexMcp = hand.landmarks[HAND.INDEX_MCP];
    const middleMcp = hand.landmarks[HAND.MIDDLE_MCP];
    const ringMcp = hand.landmarks[HAND.RING_MCP];
    const pinkyMcp = hand.landmarks[HAND.PINKY_MCP];
    const pts = [wrist, indexMcp, middleMcp, ringMcp, pinkyMcp].filter(Boolean) as Landmark[];
    let palmY = 0.5;
    if (pts.length > 0) {
      palmY = pts.reduce((sum, p) => sum + p.y, 0) / pts.length;
    }
    const clampedWristY = Math.max(0, Math.min(1, palmY));
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
