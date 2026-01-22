<script lang="ts">
  /**
   * Music Body Face - Main Application
   * Movement-driven musical instrument for SMILE ensemble
   * Uses Tone.js for audio and Mediapipe for tracking
   */

  import Video from "./lib/Video.svelte";
  import Tracker from "./lib/Tracker.svelte";
  import Audio from "./lib/Audio.svelte";
  import type { TrackingResult, HandData } from "./tracking/mediapipe";
  import type { HandTrail } from "./tracking/mediapipe";
  import { HAND, drawLandmarks } from "./tracking/mediapipe";
  import type { AudioParams, InstrumentMode, PitchMode } from "./audio/engine";

  // State
  let isRunning = $state(false);
  let isLoading = $state(false);
  let trackerReady = $state(false);
  let performanceMode = $state(false); // Lighter tracking for slower computers
  let singleHandMode = $state(false); // Limit instrument to one hand (default: 2 hands)
  let frameCount = 0; // For frame skipping in performance mode
  let instrumentMode: InstrumentMode = $state("brass");
  let pitchMode: PitchMode = $state("mid");
  // User-adjustable openness calibration:
  // 1 = current behavior (strict), 2.5 = easier to register "closed"
  let opennessSensitivity = $state(1);

  // Component refs
  let videoComponent: Video | null = $state(null);
  let trackerComponent: Tracker | null = $state(null);
  // Two audio components for two hands
  let audioComponent1: Audio | null = $state(null);
  let audioComponent2: Audio | null = $state(null);

  // Audio parameters for each hand
  let audioParams1: AudioParams = $state({ pitchShift: 0, gain: 0, filterCutoff: 1, delayTime: 0, feedback: 0, reverbMix: 0, reverbDecay: 1 });
  let audioParams2: AudioParams = $state({ pitchShift: 0, gain: 0, filterCutoff: 1, delayTime: 0, feedback: 0, reverbMix: 0, reverbDecay: 1 });

  // Debug display
  let debugInfo = $state("");
  const DEBUG_HAND = true;

  // Per-hand tracking state (indexed by 0 or 1)
  interface HandState {
    smoothedPitch: number;
    smoothedOpenness: number;
    wasPlaying: boolean;
    isInRelease: boolean;
    prevHandPos: { x: number; y: number } | null;
    prevVelocity: number;
    smoothedJerkiness: number;
    smoothedVelocity: number;
    smoothedPalmRotation: number;
    releaseStartTime: number;
    lastTimestamp: number;
    // Vibrato gating based on Y oscillation (no LFO)
    prevYVelocity: number; // normalized units/sec
    lastFlipMs: number; // timestamp of last direction change
    flipHzEma: number; // estimated direction-change rate (Hz)
    pitchTargetLp: number; // low-passed target pitch shift (semitones)
    // Tracking dropout handling
    lastSeenMs: number; // last time this hand was detected (ms)
    lastParams: AudioParams; // last computed params (for short dropouts)
    // Smooth re-acquire after tracking loss
    reacquireFromParams: AudioParams | null;
    reacquireStartMs: number;
    // Reverb smoothing (avoid wet jumps)
    reverbMixSmooth: number;
    // Open/closed debounce (prevents one-frame false triggers)
    openConfirmMs: number;
    closedConfirmMs: number;
    // Prevent rapid re-triggers from noisy thresholds
    lastAttackMs: number;
    lastReleaseMs: number;
    // Extra stability for fast motion
    opennessHist: number[]; // recent per-frame openness measurements (median filter)
    gainSmooth: number; // slew-limited gain to reduce audible jitter
    closedOpennessSlew: number; // extra smoothing used ONLY for closed/release detection
  }
  
  function createHandState(): HandState {
    return {
      smoothedPitch: 0,
      smoothedOpenness: 0,
      wasPlaying: false,
      isInRelease: false,
      prevHandPos: null,
      prevVelocity: 0,
      smoothedJerkiness: 0,
      smoothedVelocity: 0,
      smoothedPalmRotation: 0.5,
      releaseStartTime: 0,
      lastTimestamp: 0,
      prevYVelocity: 0,
      lastFlipMs: 0,
      flipHzEma: 0,
      pitchTargetLp: 0,
      lastSeenMs: 0,
      lastParams: { pitchShift: 0, gain: 0, filterCutoff: 1, delayTime: 0, feedback: 0, reverbMix: 0, reverbDecay: 1 },
      reacquireFromParams: null,
      reacquireStartMs: 0,
      reverbMixSmooth: 0,
      openConfirmMs: 0,
      closedConfirmMs: 0,
      lastAttackMs: 0,
      lastReleaseMs: 0,
      opennessHist: [],
      gainSmooth: 0,
      closedOpennessSlew: 0,
    };
  }
  
  // State for each hand (index by handedness: Left=0, Right=1)
  let handStates: Record<string, HandState> = {
    "Left": createHandState(),
    "Right": createHandState(),
  };

  // Per-note trail visualization (one per hand)
  type Handedness = "Left" | "Right";
  type TrailPhase = "idle" | "active" | "fading";
  interface HandTrailState {
    phase: TrailPhase;
    color: string;
    points: { x: number; y: number; width: number }[];
    lengthNorm: number; // accumulated visible trail length (normalized units)
    alpha: number;
    fadeStartMs: number;
  }

  const TRAIL_MIN_WIDTH = 2;
  const TRAIL_MAX_WIDTH = 14;
  const TRAIL_FADE_MS = 450;
  const TRAIL_POINT_MIN_DIST = 0.003;
  const TRAIL_MAX_POINTS = 260;

  function trailColorForY(screenY: number): string {
    // bottom (y=1) hot, top (y=0) cool
    const y = Math.max(0, Math.min(1, screenY));
    const baseHue = 220 - y * 200; // 220 (cool) .. 20 (hot)
    const jitter = (Math.random() * 16) - 8;
    return `hsl(${Math.round(baseHue + jitter)} 88% 60%)`;
  }

  function createTrailState(): HandTrailState {
    return { phase: "idle", color: trailColorForY(0.5), points: [], lengthNorm: 0, alpha: 0, fadeStartMs: 0 };
  }

  let trails: Record<Handedness, HandTrailState> = {
    Left: createTrailState(),
    Right: createTrailState(),
  };

  // In single-hand mode, Mediapipe can occasionally flip handedness labels during fast motion.
  // Latch to the previously-used engine to prevent audio dropouts/switching.
  let singleHandLatched: Handedness | null = $state(null);

  function startTrail(handedness: Handedness, screenY: number): void {
    trails[handedness] = {
      phase: "active",
      color: trailColorForY(screenY),
      points: [],
      lengthNorm: 0,
      alpha: 1,
      fadeStartMs: 0,
    };
  }

  function releaseTrail(handedness: Handedness, nowMs: number): void {
    const t = trails[handedness];
    if (t.phase === "idle") return;
    trails[handedness] = { ...t, phase: "fading", fadeStartMs: nowMs, alpha: 1 };
  }

  function clearTrail(handedness: Handedness): void {
    trails[handedness] = { ...trails[handedness], phase: "idle", points: [], lengthNorm: 0, alpha: 0, fadeStartMs: 0 };
  }

  // Reverb mapping from visible trail length
  const REVERB_MAX_MIX = 0.75;
  const REVERB_MIN_TAIL = 0.3;
  const REVERB_MAX_TAIL = 6.0;
  const REVERB_MAX_TRAIL_HEIGHTS = 2.0; // max effect at ~2x screen height of trail length
  const REVERB_MIX_SMOOTH = 0.08;
  const REVERB_DECAY_DURING_PLAY = 1.0; // keep stable during note to avoid reverb regeneration glitches

  type ReverbHold = { startMs: number; mix: number; decay: number } | null;
  const reverbHold: Record<Handedness, ReverbHold> = $state({ Left: null, Right: null });

  function mapTrailToReverb(lengthNorm: number): { mix: number; decay: number } {
    const x = Math.max(0, Math.min(1, lengthNorm / REVERB_MAX_TRAIL_HEIGHTS));
    const mix = REVERB_MAX_MIX * x;
    const decay = REVERB_MIN_TAIL + (REVERB_MAX_TAIL - REVERB_MIN_TAIL) * x;
    return { mix: lengthNorm < 0.02 ? 0 : mix, decay };
  }

  function currentReverbFor(handedness: Handedness, state: HandState, nowMs: number): { reverbMix: number; reverbDecay: number } {
    const hold = reverbHold[handedness];
    if (hold) {
      const elapsed = Math.max(0, (nowMs - hold.startMs) / 1000);
      const t = Math.max(0, 1 - elapsed / Math.max(0.001, hold.decay));
      if (t <= 0.001) {
        reverbHold[handedness] = null;
        return { reverbMix: 0, reverbDecay: 1 };
      }
      return { reverbMix: hold.mix * t, reverbDecay: hold.decay };
    }
    const mapped = mapTrailToReverb(trails[handedness].lengthNorm);
    state.reverbMixSmooth = REVERB_MIX_SMOOTH * mapped.mix + (1 - REVERB_MIX_SMOOTH) * state.reverbMixSmooth;
    return { reverbMix: state.reverbMixSmooth, reverbDecay: REVERB_DECAY_DURING_PLAY };
  }

  function updateTrailFade(nowMs: number): void {
    for (const handedness of ["Left", "Right"] as const) {
      const t = trails[handedness];
      if (t.phase !== "fading") continue;
      const elapsed = Math.max(0, nowMs - t.fadeStartMs);
      const a = Math.max(0, 1 - elapsed / TRAIL_FADE_MS);
      t.alpha = a;
      if (a <= 0.001) clearTrail(handedness);
    }
  }

  function addTrailPoint(handedness: Handedness, x: number, y: number, normalizedOpenness: number): void {
    const t = trails[handedness];
    if (t.phase !== "active") return;
    const pts = t.points;
    const clampedX = Math.max(0, Math.min(1, x));
    const clampedY = Math.max(0, Math.min(1, y));
    const width = TRAIL_MIN_WIDTH + Math.max(0, Math.min(1, normalizedOpenness)) * (TRAIL_MAX_WIDTH - TRAIL_MIN_WIDTH);

    const last = pts.length > 0 ? pts[pts.length - 1] : null;
    if (last) {
      const dx = clampedX - last.x;
      const dy = clampedY - last.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < TRAIL_POINT_MIN_DIST) return;
      t.lengthNorm += d;
    }

    pts.push({ x: clampedX, y: clampedY, width });
    if (pts.length > TRAIL_MAX_POINTS) {
      pts.splice(0, pts.length - TRAIL_MAX_POINTS);
      // Recompute length to match what is visible
      let sum = 0;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        sum += Math.sqrt(dx * dx + dy * dy);
      }
      t.lengthNorm = sum;
    }
  }

  // If toggled while running, reset state to avoid stuck notes.
  let prevSingleHandMode = $state(false);
  let hasPrevSingleHandMode = $state(false);
  $effect(() => {
    const current = singleHandMode;
    if (!hasPrevSingleHandMode) {
      prevSingleHandMode = current;
      hasPrevSingleHandMode = true;
      return;
    }
    if (prevSingleHandMode === current) return;
    prevSingleHandMode = current;

    if (!isRunning) return;

    console.log(`Single hand mode ${current ? "enabled" : "disabled"} (resetting)`);
    audioComponent1?.release();
    audioComponent2?.release();
    audioParams1 = { pitchShift: 0, gain: 0, filterCutoff: 1, delayTime: 0, feedback: 0, reverbMix: 0, reverbDecay: 1 };
    audioParams2 = { pitchShift: 0, gain: 0, filterCutoff: 1, delayTime: 0, feedback: 0, reverbMix: 0, reverbDecay: 1 };
    clearTrail("Left");
    clearTrail("Right");
    reverbHold.Left = null;
    reverbHold.Right = null;
    handStates = {
      "Left": createHandState(),
      "Right": createHandState(),
    };
    singleHandLatched = null;
    debugInfo = "";
  });

  // Thresholds and smoothing (higher = more responsive, lower latency)
  // Vibrato (PitchShift) driven directly by Y-velocity (no LFO).
  // Only active when the hand is oscillating up/down quickly enough.
  // Tone.PitchShift expects semitones; we keep this in cents-scale.
  const VIBRATO_MAX_CENTS = 8; // hard cap (very subtle)
  const VIBRATO_VEL_THRESHOLD = 0.38; // must be moving faster than this
  const VIBRATO_FLIP_HZ_THRESHOLD = 5.0; // must be oscillating up/down quickly
  const VIBRATO_FLIP_HZ_SMOOTH = 0.25; // EMA smoothing
  const VIBRATO_CENTS_PER_VEL = 14; // cents per (normalized units/sec)
  const VIBRATO_PITCH_SMOOTH_ATTACK = 0.25;
  const VIBRATO_PITCH_SMOOTH_RELEASE = 0.55;
  const VIBRATO_RECENT_FLIP_MS = 140; // must have flipped direction very recently
  const VIBRATO_FLIP_DECAY_SEC = 0.10; // decay flip estimate quickly when not oscillating
  const VIBRATO_LP_TAU_BASE = 0.08; // seconds
  const VIBRATO_LP_TAU_FAST = 0.22; // seconds (more smoothing at very high speeds)
  const VIBRATO_SLEW_SEMITONES_PER_SEC = 0.35; // stronger slew limiting for stability
  // Openness smoothing: keep it simple + predictable.
  const OPENNESS_SMOOTHING = 0.35;
  const OPENNESS_MIN = 0.08;
  const OPENNESS_MAX = 0.18;
  const MAX_GAIN = 1.0;
  const MIN_PLAYING_GAIN = 0.25;
  const RELEASE_GAIN = 0.5;
  const FIST_CLOSED_THRESHOLD = 0.09;
  const HAND_OPEN_THRESHOLD = 0.12;
  const RELEASE_TIMEOUT_MS = 2000;
  const OPEN_CONFIRM_MS = 35;
  const OPEN_CONFIRM_MS_RELEASE = 25; // re-open should re-trigger fast during release (but not on 1 noisy frame)
  const CLOSED_CONFIRM_MS = 90;
  
  // Jerkiness settings
  const JERKINESS_SMOOTHING = 0.4; // Faster response
  const SOFT_THRESHOLD = 0.15;
  const HARD_THRESHOLD = 0.4;
  
  // Delay settings (velocity and rotation tracking)
  const VELOCITY_SMOOTHING = 0.1; // Faster velocity response
  const MAX_VELOCITY = 2.0;
  const ROTATION_SMOOTHING = 0.3; // Faster rotation response

  // Tracking robustness: briefly hold state when detection drops out.
  // This prevents "terrible behavior" in fast motion / low light.
  const TRACKING_LOSS_GRACE_MS = 600;
  const TRACKING_LOSS_MAX_HOLD_MS = 3000; // safety: eventually release to avoid stuck notes
  
  // Handlers
  async function handleStart(): Promise<void> {
    isLoading = true;

    // Initialize tracker if not ready
    if (!trackerReady && trackerComponent) {
      await trackerComponent.initialize(performanceMode);
    }

    // Start video
    if (videoComponent) {
      await videoComponent.start();
    }

    // Start both audio engines (must be triggered by user gesture)
    console.log("Starting audio engines...");
    await audioComponent1?.start();
    console.log("Audio 1 started");
    await audioComponent2?.start();
    console.log("Audio 2 started");

    // Apply current instrument mode to both engines
    audioComponent1?.setMode(instrumentMode);
    audioComponent2?.setMode(instrumentMode);

    // Apply current pitch mode to both engines (takes effect on next sample selection)
    audioComponent1?.setPitch(pitchMode);
    audioComponent2?.setPitch(pitchMode);

    isLoading = false;
    isRunning = true;
  }

  function handleStop(): void {
    videoComponent?.stop();
    audioComponent1?.stop();
    audioComponent2?.stop();
    audioParams1 = { pitchShift: 0, gain: 0, filterCutoff: 1, delayTime: 0, feedback: 0, reverbMix: 0, reverbDecay: 1 };
    audioParams2 = { pitchShift: 0, gain: 0, filterCutoff: 1, delayTime: 0, feedback: 0, reverbMix: 0, reverbDecay: 1 };
    clearTrail("Left");
    clearTrail("Right");
    reverbHold.Left = null;
    reverbHold.Right = null;
    // Reset hand states
    handStates = {
      "Left": createHandState(),
      "Right": createHandState(),
    };
    singleHandLatched = null;
    frameCount = 0;
    isRunning = false;
  }

  async function toggleInstrumentMode(): Promise<void> {
    instrumentMode = instrumentMode === "brass" ? "strings" : "brass";
    audioComponent1?.setMode(instrumentMode);
    audioComponent2?.setMode(instrumentMode);
    // Immediately swap samples so the mode switch is audible even if already playing
    await audioComponent1?.changeSample();
    await audioComponent2?.changeSample();
  }

  function togglePitchMode(): void {
    pitchMode =
      pitchMode === "low" ? "mid" :
      pitchMode === "mid" ? "high" :
      pitchMode === "high" ? "all" :
      "low";
    // Only affects NEXT sample selection (after release/end), as requested.
    audioComponent1?.setPitch(pitchMode);
    audioComponent2?.setPitch(pitchMode);
  }

  function handleTrackerReady(): void {
    trackerReady = true;
  }

  function handleVideoFrame(video: HTMLVideoElement, timestamp: number): void {
    // In performance mode, skip every other frame
    if (performanceMode) {
      frameCount++;
      if (frameCount % 2 !== 0) return;
    }
    trackerComponent?.process(video, timestamp);
  }

  // Process a single hand and return its audio params
  function processHand(
    hand: HandData,
    state: HandState,
    audioComp: Audio | null,
    timestamp: number
  ): AudioParams {
    const landmarks = hand.landmarks;
    const wrist = landmarks[HAND.WRIST];
    const indexTip = landmarks[HAND.INDEX_TIP];
    const middleTip = landmarks[HAND.MIDDLE_TIP];
    const ringTip = landmarks[HAND.RING_TIP];
    const pinkyTip = landmarks[HAND.PINKY_TIP];
    const thumbTip = landmarks[HAND.THUMB_TIP];
    const indexMcp = landmarks[HAND.INDEX_MCP];
    const middleMcp = landmarks[HAND.MIDDLE_MCP];
    const ringMcp = landmarks[HAND.RING_MCP];
    const pinkyMcp = landmarks[HAND.PINKY_MCP];

    // Palm center (rough): average wrist + 4 MCP knuckles.
    // This is more stable than the wrist alone and better represents the palm.
    const palm = (() => {
      const pts = [wrist, indexMcp, middleMcp, ringMcp, pinkyMcp].filter(Boolean);
      let x = 0;
      let y = 0;
      for (const p of pts) {
        x += p.x;
        y += p.y;
      }
      const n = pts.length || 1;
      return { x: x / n, y: y / n };
    })();

    // Calculate jerkiness from hand movement acceleration
    const currentPos = { x: wrist.x, y: wrist.y };
    const dt = state.lastTimestamp > 0 ? (timestamp - state.lastTimestamp) / 1000 : 0.033;
    state.lastTimestamp = timestamp;
    let yVelocity = 0; // normalized units/sec (positive = moving down)
    
    if (state.prevHandPos && dt > 0) {
      const dx = currentPos.x - state.prevHandPos.x;
      const dy = currentPos.y - state.prevHandPos.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const velocity = distance / dt;
      yVelocity = dy / dt;
      
      const acceleration = Math.abs(velocity - state.prevVelocity) / dt;
      const normalizedJerk = Math.min(1, acceleration / 30);
      state.smoothedJerkiness = JERKINESS_SMOOTHING * normalizedJerk + (1 - JERKINESS_SMOOTHING) * state.smoothedJerkiness;
      
      const normalizedVelocity = Math.min(1, velocity / MAX_VELOCITY);
      if (normalizedVelocity > state.smoothedVelocity) {
        state.smoothedVelocity = VELOCITY_SMOOTHING * normalizedVelocity + (1 - VELOCITY_SMOOTHING) * state.smoothedVelocity;
      } else {
        state.smoothedVelocity = 0.02 * normalizedVelocity + 0.98 * state.smoothedVelocity;
      }
      
      state.prevVelocity = velocity;
    } else {
      state.smoothedVelocity *= 0.98;
    }
    state.prevHandPos = currentPos;
    
    // Determine layer based on jerkiness
    let layer: "soft" | "medium" | "hard";
    if (state.smoothedJerkiness < SOFT_THRESHOLD) {
      layer = "soft";
    } else if (state.smoothedJerkiness > HARD_THRESHOLD) {
      layer = "hard";
    } else {
      layer = "medium";
    }
    audioComp?.updateLayer(layer);
    
    // Calculate palm rotation
    if (indexMcp && pinkyMcp && wrist.z !== undefined && indexMcp.z !== undefined && pinkyMcp.z !== undefined) {
      const avgKnuckleZ = (indexMcp.z + pinkyMcp.z) / 2;
      const zDiff = wrist.z - avgKnuckleZ;
      const rawRotation = (zDiff + 0.1) / 0.2;
      const clampedRotation = Math.max(0, Math.min(1, rawRotation));
      state.smoothedPalmRotation = ROTATION_SMOOTHING * clampedRotation + (1 - ROTATION_SMOOTHING) * state.smoothedPalmRotation;
    }
    
    // Update hand Y position for pitch-based sample selection
    // Use palm center screen-space Y (0 = top, 1 = bottom) so top selects highest pitches.
    const handYForPitch = palm.y;
    audioComp?.updateHandY(handYForPitch);
    
    // Vibrato from Y-velocity directly (no LFO).
    // Gate it so it ONLY engages when the hand is oscillating up/down quickly:
    // - velocity magnitude is high enough
    // - AND direction flips (sign changes) are frequent enough (Hz threshold)
    const absYVel = Math.abs(yVelocity);
    const prevYVel = state.prevYVelocity;
    const signFlip = prevYVel !== 0 && (prevYVel > 0) !== (yVelocity > 0);
    state.prevYVelocity = yVelocity;

    if (signFlip && absYVel > VIBRATO_VEL_THRESHOLD && Math.abs(prevYVel) > VIBRATO_VEL_THRESHOLD) {
      const nowMs = timestamp;
      if (state.lastFlipMs > 0) {
        const flipDt = Math.max(1, nowMs - state.lastFlipMs) / 1000;
        const instHz = 1 / flipDt;
        state.flipHzEma = VIBRATO_FLIP_HZ_SMOOTH * instHz + (1 - VIBRATO_FLIP_HZ_SMOOTH) * state.flipHzEma;
      }
      state.lastFlipMs = nowMs;
    } else if (dt > 0) {
      // decay flip rate estimate toward 0 when not oscillating
      state.flipHzEma *= Math.exp(-dt / VIBRATO_FLIP_DECAY_SEC);
    }

    const recentFlipOk = state.lastFlipMs > 0 && (timestamp - state.lastFlipMs) <= VIBRATO_RECENT_FLIP_MS;
    const vibratoActive =
      absYVel > VIBRATO_VEL_THRESHOLD &&
      state.flipHzEma >= VIBRATO_FLIP_HZ_THRESHOLD &&
      recentFlipOk;
    const targetCents = vibratoActive
      ? Math.max(-VIBRATO_MAX_CENTS, Math.min(VIBRATO_MAX_CENTS, (-yVelocity) * VIBRATO_CENTS_PER_VEL))
      : 0;
    const targetSemitonesRaw = targetCents / 100;

    // Low-pass the target more when moving extremely fast
    const tau = absYVel > 0.75 ? VIBRATO_LP_TAU_FAST : VIBRATO_LP_TAU_BASE;
    const lpAlpha = dt > 0 ? Math.max(0, Math.min(1, dt / (tau + dt))) : 1;
    state.pitchTargetLp = state.pitchTargetLp + lpAlpha * (targetSemitonesRaw - state.pitchTargetLp);
    const targetSemitones = state.pitchTargetLp;

    const smooth = Math.abs(targetSemitones) > Math.abs(state.smoothedPitch) ? VIBRATO_PITCH_SMOOTH_ATTACK : VIBRATO_PITCH_SMOOTH_RELEASE;
    const next = smooth * targetSemitones + (1 - smooth) * state.smoothedPitch;

    // Slew-limit to prevent glitchy pitch jumps at extreme speeds
    if (dt > 0) {
      const maxDelta = VIBRATO_SLEW_SEMITONES_PER_SEC * dt;
      const delta = next - state.smoothedPitch;
      state.smoothedPitch += Math.max(-maxDelta, Math.min(maxDelta, delta));
    } else {
      state.smoothedPitch = next;
    }

    // Hard cap and deadzone
    const maxSemitones = VIBRATO_MAX_CENTS / 100;
    const capped = Math.max(-maxSemitones, Math.min(maxSemitones, state.smoothedPitch));
    const pitchShift = Math.abs(capped) < 0.0005 ? 0 : capped;

    // Calculate hand openness (simple + robust):
    // use median fingertip distance and a single EMA. Everything else was adding chaos.
    const fingertips = [indexTip, middleTip, ringTip, pinkyTip, thumbTip].filter(Boolean);
    const distances: number[] = [];
    for (const tip of fingertips) {
      const dx = tip.x - wrist.x;
      const dy = tip.y - wrist.y;
      const dz = (tip.z !== undefined && wrist.z !== undefined) ? (tip.z - wrist.z) * 0.5 : 0;
      distances.push(Math.sqrt(dx * dx + dy * dy + dz * dz));
    }
    let measuredOpenness = state.smoothedOpenness;
    if (distances.length >= 3) {
      distances.sort((a, b) => a - b);
      measuredOpenness = distances[Math.floor(distances.length / 2)];
    }
    state.smoothedOpenness = OPENNESS_SMOOTHING * measuredOpenness + (1 - OPENNESS_SMOOTHING) * state.smoothedOpenness;

    const opennessForControls = state.smoothedOpenness;
    const closedOpenness = state.smoothedOpenness / Math.max(1, opennessSensitivity);

    const normalizedOpenness = Math.max(0, Math.min(
      (opennessForControls - OPENNESS_MIN) / (OPENNESS_MAX - OPENNESS_MIN),
      1.0
    ));
    
    const curvedGain = Math.pow(normalizedOpenness, 0.5);
    const isFistClosedRaw = closedOpenness < FIST_CLOSED_THRESHOLD;
    const isHandOpenRaw = opennessForControls > HAND_OPEN_THRESHOLD;
    // Make open/closed mutually exclusive to avoid flapping when tracking jitters.
    const openCandidate = isHandOpenRaw && !isFistClosedRaw;
    const closedCandidate = isFistClosedRaw && !isHandOpenRaw;

    const dtMs = dt * 1000;
    if (openCandidate) state.openConfirmMs = Math.min(1000, state.openConfirmMs + dtMs);
    else state.openConfirmMs = 0;
    if (closedCandidate) state.closedConfirmMs = Math.min(1000, state.closedConfirmMs + dtMs);
    else state.closedConfirmMs = 0;

    const isHandOpen = state.openConfirmMs >= OPEN_CONFIRM_MS;
    const isFistClosed = state.closedConfirmMs >= CLOSED_CONFIRM_MS;
    
    let gain: number;
    
    if (state.isInRelease) {
      gain = RELEASE_GAIN;
      const releaseElapsed = Date.now() - state.releaseStartTime;
      // During release, allow immediate re-trigger — but ONLY if we actually detect the hand as open.
      // (openConfirmMs is 0 when not open, so OPEN_CONFIRM_MS_RELEASE=0 alone would always be "true".)
      const isHandOpenForRelease = openCandidate && state.openConfirmMs >= OPEN_CONFIRM_MS_RELEASE;
      if (isHandOpenForRelease || releaseElapsed > RELEASE_TIMEOUT_MS) {
        state.isInRelease = false;
        if (isHandOpenForRelease) {
          reverbHold[hand.handedness] = null;
          state.reverbMixSmooth = 0;
          state.openConfirmMs = 0;
          state.closedConfirmMs = 0;
          startTrail(hand.handedness, palm.y);
          audioComp?.attack();
          state.wasPlaying = true;
          state.lastAttackMs = timestamp;
        }
      }
    } else if (state.wasPlaying) {
      gain = MIN_PLAYING_GAIN + curvedGain * (MAX_GAIN - MIN_PLAYING_GAIN);
    } else {
      gain = curvedGain * MAX_GAIN;
    }

    // Gentle gain smoothing only (prevents audible jitter without latency).
    state.gainSmooth = 0.22 * gain + 0.78 * state.gainSmooth;
    gain = state.gainSmooth;
    
    // State transitions (simple)
    if (isHandOpen && !state.wasPlaying && !state.isInRelease) {
      console.log(`${hand.handedness} → ATTACK`);
      reverbHold[hand.handedness] = null;
      state.reverbMixSmooth = 0;
      state.openConfirmMs = 0;
      state.closedConfirmMs = 0;
      startTrail(hand.handedness, palm.y);
      if (DEBUG_HAND) {
        console.log(
          `[hand ${hand.handedness}] ATTACK requested; openness=${state.smoothedOpenness.toFixed(3)} ` +
          `(open=${opennessForControls.toFixed(3)}, closed=${closedOpenness.toFixed(3)}, sens=${opennessSensitivity.toFixed(1)}) ` +
          `(open>${HAND_OPEN_THRESHOLD}, fist<${FIST_CLOSED_THRESHOLD}) ` +
          `audioState=${audioComp?.playState?.() ?? "?"}`
        );
      }
      audioComp?.attack();
      state.wasPlaying = true;
      state.lastAttackMs = timestamp;
    } else if (isFistClosed && state.wasPlaying) {
      console.log(`${hand.handedness} → RELEASE`);
      releaseTrail(hand.handedness, timestamp);
      // Hold reverb settings from current trail length so tail rings out after release
      const mapped = mapTrailToReverb(trails[hand.handedness].lengthNorm);
      reverbHold[hand.handedness] = { startMs: timestamp, mix: mapped.mix, decay: mapped.decay };
      if (DEBUG_HAND) {
        console.log(
          `[hand ${hand.handedness}] RELEASE requested; openness=${state.smoothedOpenness.toFixed(3)} ` +
          `(open=${opennessForControls.toFixed(3)}, closed=${closedOpenness.toFixed(3)}, sens=${opennessSensitivity.toFixed(1)}) ` +
          `(open>${HAND_OPEN_THRESHOLD}, fist<${FIST_CLOSED_THRESHOLD}) ` +
          `audioState=${audioComp?.playState?.() ?? "?"}`
        );
      }
      audioComp?.release();
      state.wasPlaying = false;
      state.isInRelease = true;
      state.releaseStartTime = Date.now();
      state.lastReleaseMs = timestamp;
    }

    const filterCutoff = normalizedOpenness;
    const delayTime = state.smoothedVelocity;
    const feedback = state.smoothedPalmRotation;

    const rv = currentReverbFor(hand.handedness, state, timestamp);

    if (state.wasPlaying) {
      addTrailPoint(hand.handedness, palm.x, palm.y, normalizedOpenness);
    }

    const computed: AudioParams = { pitchShift, gain, filterCutoff, delayTime, feedback, reverbMix: rv.reverbMix, reverbDecay: rv.reverbDecay };

    // Save last good params for dropout hold.
    state.lastSeenMs = timestamp;
    state.lastParams = computed;
    return computed;
  }

  function handleTrackingResult(result: TrackingResult, timestamp: number): void {
    // In single-hand mode, pick only one detected hand to drive audio.
    // Prefer Right if both are present (more common for users), but latch the engine hand
    // to prevent dropouts when Mediapipe flips handedness during fast motion.
    let activeHands: HandData[] = result.hands;
    let selectedHandedness: Handedness | null = null;
    if (singleHandMode) {
      if (result.hands.length === 0) {
        activeHands = [];
        selectedHandedness = singleHandLatched;
      } else if (result.hands.length === 1) {
        activeHands = [result.hands[0]];
        selectedHandedness = singleHandLatched ?? result.hands[0].handedness;
        singleHandLatched = selectedHandedness;
      } else {
        const right = result.hands.find((h) => h.handedness === "Right");
        const chosen = right ?? result.hands[0];
        activeHands = [chosen];
        selectedHandedness = chosen.handedness;
        singleHandLatched = selectedHandedness;
      }
    }

    // Track which engines/hands are currently driving audio (after single-hand latching)
    const detectedHandedness = new Set<Handedness>();
    if (singleHandMode) {
      if (activeHands.length > 0 && selectedHandedness) detectedHandedness.add(selectedHandedness);
    } else {
      for (const h of activeHands) detectedHandedness.add(h.handedness);
    }
    
    // Process each detected hand independently
    for (const hand of activeHands) {
      const controllerHandedness: Handedness = singleHandMode ? (selectedHandedness ?? hand.handedness) : hand.handedness;
      const state = handStates[controllerHandedness];
      const audioComp = controllerHandedness === "Left" ? audioComponent1 : audioComponent2;
      
      const params = processHand(hand, state, audioComp, timestamp);
      
      if (controllerHandedness === "Left") {
        audioParams1 = params;
      } else {
        audioParams2 = params;
      }
    }
    
    // Handle hands that were lost - process each hand independently
    for (const handedness of ["Left", "Right"] as const) {
      if (!detectedHandedness.has(handedness)) {
        const state = handStates[handedness];
        const audioComp = handedness === "Left" ? audioComponent1 : audioComponent2;

        // In single-hand mode, force the non-selected hand to be fully silent/idle.
        if (singleHandMode && handedness !== selectedHandedness) {
          if (state.wasPlaying || state.isInRelease) {
            audioComp?.release();
          }
          state.wasPlaying = false;
          state.isInRelease = false;
          state.releaseStartTime = 0;
          state.smoothedVelocity *= 0.9;
          state.smoothedPalmRotation *= 0.95;
          state.smoothedOpenness = 0;
          state.openConfirmMs = 0;
          state.closedConfirmMs = 0;
          state.lastAttackMs = 0;
          state.lastReleaseMs = 0;
          state.opennessHist = [];
          state.gainSmooth = 0;
          state.closedOpennessSlew = 0;
          state.prevHandPos = null;
          reverbHold[handedness] = null;
          state.reverbMixSmooth = 0;

          const params: AudioParams = {
            pitchShift: handedness === "Left" ? audioParams1.pitchShift : audioParams2.pitchShift,
            gain: 0,
            filterCutoff: 1,
            delayTime: 0,
            feedback: state.smoothedPalmRotation,
            reverbMix: 0,
            reverbDecay: 1,
          };

          if (handedness === "Left") {
            audioParams1 = params;
          } else {
            audioParams2 = params;
          }
          continue;
        }

        // If tracking drops briefly, hold the last state/params instead of releasing.
        const msSinceSeen = state.lastSeenMs > 0 ? (timestamp - state.lastSeenMs) : Number.POSITIVE_INFINITY;
        const withinGrace = msSinceSeen <= TRACKING_LOSS_GRACE_MS;
        const withinMaxHold = msSinceSeen <= TRACKING_LOSS_MAX_HOLD_MS;

        if (state.wasPlaying && withinGrace) {
          // Keep playing: do not trigger release, do not zero params.
          if (handedness === "Left") audioParams1 = state.lastParams;
          else audioParams2 = state.lastParams;
          continue;
        }
        if (state.wasPlaying && withinMaxHold) {
          // Still missing but not too long: gently decay modulation, keep gain.
          const held: AudioParams = {
            ...state.lastParams,
            delayTime: state.lastParams.delayTime * 0.9,
            feedback: state.lastParams.feedback * 0.98,
          };
          state.lastParams = held;
          if (handedness === "Left") audioParams1 = held;
          else audioParams2 = held;
          continue;
        }

        // Past the max hold: trigger release if was playing
        if (state.wasPlaying) {
          console.log(`${handedness} hand lost (>${TRACKING_LOSS_MAX_HOLD_MS}ms) → RELEASE`);
          releaseTrail(handedness, timestamp);
          const mapped = mapTrailToReverb(trails[handedness].lengthNorm);
          reverbHold[handedness] = { startMs: timestamp, mix: mapped.mix, decay: mapped.decay };
          audioComp?.release();
          state.wasPlaying = false;
          state.isInRelease = true;
          state.releaseStartTime = Date.now();
        }
        
        // Check for release timeout
        if (state.isInRelease) {
          const releaseElapsed = Date.now() - state.releaseStartTime;
          if (releaseElapsed > RELEASE_TIMEOUT_MS) {
            state.isInRelease = false;
          }
        }
        
        // Decay values
        state.smoothedVelocity *= 0.9;
        state.smoothedPalmRotation *= 0.95;
        state.smoothedOpenness = 0;
        state.prevHandPos = null; // Reset position tracking
        
        // Set gain to 0 when not in release, otherwise fixed release gain
        const gain = state.isInRelease ? RELEASE_GAIN : 0;

        const rv = currentReverbFor(handedness, state, timestamp);
        const params: AudioParams = {
          pitchShift: handedness === "Left" ? audioParams1.pitchShift : audioParams2.pitchShift,
          gain,
          filterCutoff: state.isInRelease ? 0.7 : 1,
          delayTime: state.smoothedVelocity,
          feedback: state.smoothedPalmRotation,
          reverbMix: rv.reverbMix,
          reverbDecay: rv.reverbDecay,
        };
        
        if (handedness === "Left") {
          audioParams1 = params;
        } else {
          audioParams2 = params;
        }
      }
    }

    updateTrailFade(timestamp);

    // Draw landmarks + trails (only the active hand(s) in single-hand mode)
    const ctx = videoComponent?.getContext();
    if (ctx) {
      const visibleHands = singleHandMode ? activeHands : result.hands;
      const visibleHandedness = new Set(visibleHands.map((h) => h.handedness));
      const trailOverlays: HandTrail[] = [];
      for (const handedness of ["Left", "Right"] as const) {
        const t = trails[handedness];
        if (t.phase === "idle") continue;
        if (!visibleHandedness.has(handedness)) continue;
        trailOverlays.push({ handedness, points: t.points, color: t.color, alpha: t.alpha });
      }
      drawLandmarks(ctx, singleHandMode ? { ...result, hands: activeHands } : result, { trails: trailOverlays });
    }
    
    // Build debug showing both hands' states
    const leftState = handStates["Left"];
    const rightState = handStates["Right"];
    const leftEmoji = leftState.wasPlaying ? "▶️" : (leftState.isInRelease ? "⏹️" : "⏸️");
    const rightEmoji = rightState.wasPlaying ? "▶️" : (rightState.isInRelease ? "⏹️" : "⏸️");
    const leftDetected = detectedHandedness.has("Left");
    const rightDetected = detectedHandedness.has("Right");
    
    debugInfo = `L:${leftEmoji}${leftDetected ? leftState.smoothedOpenness.toFixed(2) : "---"} | R:${rightEmoji}${rightDetected ? rightState.smoothedOpenness.toFixed(2) : "---"}`;
  }
</script>

<main>
  <header>
    <h1>Hand Music</h1>
    <p class="status">
      {#if isLoading}
        Loading...
      {:else if isRunning}
        {debugInfo || "Open hand = play, close fist = release"}
      {:else}
        Ready
      {/if}
    </p>
  </header>

  <section class="controls">
    <div class="control-row">
      {#if !isRunning}
        <button onclick={handleStart} disabled={isLoading}>
          {isLoading ? "Loading..." : "Start"}
        </button>
      {:else}
        <button onclick={handleStop}>Stop</button>
      {/if}

      <button onclick={toggleInstrumentMode} disabled={isLoading}>
        Mode: {instrumentMode === "brass" ? "Brass (Trombone)" : "Strings (Cello/Viola)"}
      </button>

      <button onclick={togglePitchMode} disabled={isLoading}>
        Pitch: {pitchMode === "low" ? "Low" : pitchMode === "mid" ? "Mid" : pitchMode === "high" ? "High" : "All"}
      </button>
    </div>

    <label class="toggle-label">
      <input type="checkbox" bind:checked={singleHandMode} disabled={isLoading} />
      <span>Single hand mode</span>
      <span class="hint">(only one hand controls the instrument)</span>
    </label>

    {#if !isRunning}
      <label class="toggle-label">
        <input type="checkbox" bind:checked={performanceMode} />
        <span>Performance Mode</span>
        <span class="hint">(for slower computers - disables body tracking)</span>
      </label>
    {:else if performanceMode}
      <span class="mode-indicator">⚡ Performance Mode</span>
    {/if}
  </section>

  <section class="stage">
    <Video bind:this={videoComponent} onFrame={handleVideoFrame} />
    <div class="openness-slider" aria-label="Openness sensitivity">
      <div class="openness-slider__label">Close sensitivity</div>
      <div class="openness-slider__range-wrap">
        <input
          class="openness-slider__range"
          type="range"
        min="1"
        max="2.5"
          step="0.1"
          bind:value={opennessSensitivity}
        />
      </div>
      <div class="openness-slider__value">{opennessSensitivity.toFixed(1)}×</div>
    </div>
  </section>

  <Tracker
    bind:this={trackerComponent}
    onResult={handleTrackingResult}
    onReady={handleTrackerReady}
  />

  <!-- Two audio engines, one for each hand -->
  <Audio bind:this={audioComponent1} params={audioParams1} />
  <Audio bind:this={audioComponent2} params={audioParams2} />
</main>

<style>
  main {
    display: flex;
    flex-direction: column;
    align-items: center;
    min-height: 100vh;
    padding: 2rem;
    background: #0a0a0a;
    color: #fff;
    font-family: system-ui, sans-serif;
  }

  header {
    text-align: center;
    margin-bottom: 1.5rem;
  }

  header h1 {
    margin: 0;
    font-size: 1.75rem;
    font-weight: 300;
    letter-spacing: 0.05em;
  }

  .status {
    margin: 0.5rem 0 0;
    font-size: 0.875rem;
    color: #888;
  }

  .controls {
    margin-bottom: 1.5rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
  }

  .control-row {
    display: flex;
    gap: 1rem;
    align-items: center;
  }

  .toggle-label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.875rem;
    color: #aaa;
    cursor: pointer;
  }

  .toggle-label input[type="checkbox"] {
    width: 1rem;
    height: 1rem;
    cursor: pointer;
  }

  .toggle-label .hint {
    font-size: 0.75rem;
    color: #666;
  }

  .mode-indicator {
    font-size: 0.75rem;
    color: #ffcc00;
    margin-left: 0.5rem;
  }

  .stage {
    position: relative;
    width: 100%;
    max-width: 640px;
    aspect-ratio: 4 / 3;
    background: #111;
    border-radius: 8px;
    overflow: hidden;
  }

  /* Vertical slider overlay (right side) to calibrate open/closed mapping */
  .openness-slider {
    position: absolute;
    top: 0.75rem;
    right: 0.75rem;
    height: calc(100% - 1.5rem);
    width: 44px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-start;
    gap: 0.4rem;
    pointer-events: auto;
    z-index: 10;
    touch-action: none;
    user-select: none;
    background: rgba(0, 0, 0, 0.35);
    border: 1px solid rgba(180, 120, 255, 0.25);
    border-radius: 10px;
    padding: 0.5rem 0.35rem;
    backdrop-filter: blur(6px);
  }

  .openness-slider__label {
    writing-mode: vertical-rl;
    transform: rotate(180deg);
    font-size: 0.7rem;
    color: rgba(200, 160, 255, 0.9);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .openness-slider__value {
    font-size: 0.75rem;
    color: rgba(230, 210, 255, 0.9);
    font-variant-numeric: tabular-nums;
  }

  .openness-slider__range-wrap {
    flex: 1;
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0.25rem 0;
  }

  .openness-slider__range {
    /* True vertical slider, full height */
    -webkit-appearance: slider-vertical;
    appearance: slider-vertical;
    width: 18px;
    height: 100%;
    margin: 0;
    background: transparent;
    cursor: pointer;
    touch-action: none;
  }

  .openness-slider__range::-webkit-slider-runnable-track {
    width: 18px;
    background: rgba(200, 160, 255, 0.25);
    border-radius: 999px;
  }

  .openness-slider__range::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: rgba(200, 160, 255, 0.95);
    border: 2px solid rgba(50, 20, 70, 0.85);
    box-shadow: 0 0 0 4px rgba(160, 80, 255, 0.18);
    margin: 0; /* vertical slider */
  }

  .openness-slider__range::-moz-range-track {
    width: 18px;
    background: rgba(200, 160, 255, 0.25);
    border-radius: 999px;
  }

  .openness-slider__range::-moz-range-thumb {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: rgba(200, 160, 255, 0.95);
    border: 2px solid rgba(50, 20, 70, 0.85);
    box-shadow: 0 0 0 4px rgba(160, 80, 255, 0.18);
  }

  button {
    padding: 0.75rem 2rem;
    font-size: 1rem;
    background: #222;
    color: #fff;
    border: 1px solid #444;
    border-radius: 4px;
    cursor: pointer;
    transition: background 0.15s;
  }

  button:hover:not(:disabled) {
    background: #333;
  }

  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
