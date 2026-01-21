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
  let audioParams1: AudioParams = $state({ pitchShift: 0, gain: 0, filterCutoff: 1, delayTime: 0, feedback: 0 });
  let audioParams2: AudioParams = $state({ pitchShift: 0, gain: 0, filterCutoff: 1, delayTime: 0, feedback: 0 });

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
    return { phase: "idle", color: trailColorForY(0.5), points: [], alpha: 0, fadeStartMs: 0 };
  }

  let trails: Record<Handedness, HandTrailState> = {
    Left: createTrailState(),
    Right: createTrailState(),
  };

  function startTrail(handedness: Handedness, screenY: number): void {
    trails[handedness] = {
      phase: "active",
      color: trailColorForY(screenY),
      points: [],
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
    trails[handedness] = { ...trails[handedness], phase: "idle", points: [], alpha: 0, fadeStartMs: 0 };
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
      if (Math.sqrt(dx * dx + dy * dy) < TRAIL_POINT_MIN_DIST) return;
    }

    pts.push({ x: clampedX, y: clampedY, width });
    if (pts.length > TRAIL_MAX_POINTS) pts.splice(0, pts.length - TRAIL_MAX_POINTS);
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
    audioParams1 = { pitchShift: 0, gain: 0, filterCutoff: 1, delayTime: 0, feedback: 0 };
    audioParams2 = { pitchShift: 0, gain: 0, filterCutoff: 1, delayTime: 0, feedback: 0 };
    clearTrail("Left");
    clearTrail("Right");
    handStates = {
      "Left": createHandState(),
      "Right": createHandState(),
    };
    debugInfo = "";
  });

  // Thresholds and smoothing (higher = more responsive, lower latency)
  const PITCH_SMOOTHING = 0.3; // Fast pitch response
  const OPENNESS_SMOOTHING = 0.4; // Fast openness response
  const OPENNESS_MIN = 0.08;
  const OPENNESS_MAX = 0.18;
  const MAX_GAIN = 1.0;
  const MIN_PLAYING_GAIN = 0.25;
  const RELEASE_GAIN = 0.5;
  const FIST_CLOSED_THRESHOLD = 0.09;
  const HAND_OPEN_THRESHOLD = 0.13;
  const RELEASE_TIMEOUT_MS = 2000;
  
  // Jerkiness settings
  const JERKINESS_SMOOTHING = 0.4; // Faster response
  const SOFT_THRESHOLD = 0.15;
  const HARD_THRESHOLD = 0.4;
  
  // Delay settings (velocity and rotation tracking)
  const VELOCITY_SMOOTHING = 0.1; // Faster velocity response
  const MAX_VELOCITY = 2.0;
  const ROTATION_SMOOTHING = 0.3; // Faster rotation response
  
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
    audioParams1 = { pitchShift: 0, gain: 0, filterCutoff: 1, delayTime: 0, feedback: 0 };
    audioParams2 = { pitchShift: 0, gain: 0, filterCutoff: 1, delayTime: 0, feedback: 0 };
    clearTrail("Left");
    clearTrail("Right");
    // Reset hand states
    handStates = {
      "Left": createHandState(),
      "Right": createHandState(),
    };
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
    
    if (state.prevHandPos && dt > 0) {
      const dx = currentPos.x - state.prevHandPos.x;
      const dy = currentPos.y - state.prevHandPos.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const velocity = distance / dt;
      
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
    
    // Calculate pitch shift
    const normalizedY = 1 - indexTip.y;
    const targetPitch = (normalizedY - 0.5) * 6;
    state.smoothedPitch = PITCH_SMOOTHING * targetPitch + (1 - PITCH_SMOOTHING) * state.smoothedPitch;
    const pitchShift = state.smoothedPitch;

    // Calculate hand openness
    const fingertips = [indexTip, middleTip, ringTip, pinkyTip, thumbTip].filter(t => t != null);
    let totalDistance = 0;
    let validCount = 0;
    
    for (const tip of fingertips) {
      if (tip) {
        const dx = tip.x - wrist.x;
        const dy = tip.y - wrist.y;
        const dz = (tip.z !== undefined && wrist.z !== undefined) ? (tip.z - wrist.z) * 0.5 : 0;
        totalDistance += Math.sqrt(dx * dx + dy * dy + dz * dz);
        validCount++;
      }
    }
    
    const avgDistance = validCount >= 3 ? totalDistance / validCount : state.smoothedOpenness;
    state.smoothedOpenness = OPENNESS_SMOOTHING * avgDistance + (1 - OPENNESS_SMOOTHING) * state.smoothedOpenness;

    // Apply user calibration so "closed" can be easier to trigger.
    const effectiveOpenness = state.smoothedOpenness / Math.max(1, opennessSensitivity);

    const normalizedOpenness = Math.max(0, Math.min(
      (effectiveOpenness - OPENNESS_MIN) / (OPENNESS_MAX - OPENNESS_MIN),
      1.0
    ));
    
    const curvedGain = Math.pow(normalizedOpenness, 0.5);
    const isFistClosed = effectiveOpenness < FIST_CLOSED_THRESHOLD;
    const isHandOpen = effectiveOpenness > HAND_OPEN_THRESHOLD;
    
    let gain: number;
    
    if (state.isInRelease) {
      gain = RELEASE_GAIN;
      const releaseElapsed = Date.now() - state.releaseStartTime;
      if (isHandOpen || releaseElapsed > RELEASE_TIMEOUT_MS) {
        state.isInRelease = false;
        if (isHandOpen) {
          startTrail(hand.handedness, palm.y);
          audioComp?.attack();
          state.wasPlaying = true;
        }
      }
    } else if (state.wasPlaying) {
      gain = MIN_PLAYING_GAIN + curvedGain * (MAX_GAIN - MIN_PLAYING_GAIN);
    } else {
      gain = curvedGain * MAX_GAIN;
    }
    
    // State transitions
    if (isHandOpen && !state.wasPlaying && !state.isInRelease) {
      console.log(`${hand.handedness} → ATTACK`);
      startTrail(hand.handedness, palm.y);
      if (DEBUG_HAND) {
        console.log(
          `[hand ${hand.handedness}] ATTACK requested; openness=${state.smoothedOpenness.toFixed(3)} ` +
          `(effective=${effectiveOpenness.toFixed(3)}, sens=${opennessSensitivity.toFixed(1)}) ` +
          `(open>${HAND_OPEN_THRESHOLD}, fist<${FIST_CLOSED_THRESHOLD}) ` +
          `audioState=${audioComp?.playState?.() ?? "?"}`
        );
      }
      audioComp?.attack();
      state.wasPlaying = true;
    } else if (isFistClosed && state.wasPlaying) {
      console.log(`${hand.handedness} → RELEASE`);
      releaseTrail(hand.handedness, timestamp);
      if (DEBUG_HAND) {
        console.log(
          `[hand ${hand.handedness}] RELEASE requested; openness=${state.smoothedOpenness.toFixed(3)} ` +
          `(effective=${effectiveOpenness.toFixed(3)}, sens=${opennessSensitivity.toFixed(1)}) ` +
          `(open>${HAND_OPEN_THRESHOLD}, fist<${FIST_CLOSED_THRESHOLD}) ` +
          `audioState=${audioComp?.playState?.() ?? "?"}`
        );
      }
      audioComp?.release();
      state.wasPlaying = false;
      state.isInRelease = true;
      state.releaseStartTime = Date.now();
    }

    const filterCutoff = normalizedOpenness;
    const delayTime = state.smoothedVelocity;
    const feedback = state.smoothedPalmRotation;

    if (state.wasPlaying) {
      addTrailPoint(hand.handedness, palm.x, palm.y, normalizedOpenness);
    }

    return { pitchShift, gain, filterCutoff, delayTime, feedback };
  }

  function handleTrackingResult(result: TrackingResult, timestamp: number): void {
    // In single-hand mode, pick only one detected hand to drive audio.
    // Prefer Right if both are present (more common for users).
    const activeHands = singleHandMode
      ? (() => {
          if (result.hands.length <= 1) return result.hands;
          const right = result.hands.find((h) => h.handedness === "Right");
          return [right ?? result.hands[0]];
        })()
      : result.hands;

    const selectedHandedness = singleHandMode ? (activeHands[0]?.handedness ?? null) : null;

    // Track which hands are currently detected (after filtering for single-hand mode)
    const detectedHandedness = new Set(activeHands.map(h => h.handedness));
    
    // Process each detected hand independently
    for (const hand of activeHands) {
      const state = handStates[hand.handedness];
      const audioComp = hand.handedness === "Left" ? audioComponent1 : audioComponent2;
      
      const params = processHand(hand, state, audioComp, timestamp);
      
      if (hand.handedness === "Left") {
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
          state.prevHandPos = null;

          const params: AudioParams = {
            pitchShift: handedness === "Left" ? audioParams1.pitchShift : audioParams2.pitchShift,
            gain: 0,
            filterCutoff: 1,
            delayTime: 0,
            feedback: state.smoothedPalmRotation,
          };

          if (handedness === "Left") {
            audioParams1 = params;
          } else {
            audioParams2 = params;
          }
          continue;
        }
        
        // Trigger release if was playing
        if (state.wasPlaying) {
          console.log(`${handedness} hand lost → RELEASE`);
          releaseTrail(handedness, timestamp);
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
        
        const params: AudioParams = {
          pitchShift: handedness === "Left" ? audioParams1.pitchShift : audioParams2.pitchShift,
          gain,
          filterCutoff: state.isInRelease ? 0.7 : 1,
          delayTime: state.smoothedVelocity,
          feedback: state.smoothedPalmRotation,
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
