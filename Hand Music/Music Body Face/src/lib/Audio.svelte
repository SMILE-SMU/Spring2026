<script lang="ts">
  /**
   * Audio component using Tone.js with attack-sustain-release
   */

  import type { AudioEngine, AudioParams, InstrumentMode } from "../audio/engine";
  import {
    createAudioEngine,
    startAudio,
    stopAudio,
    updateAudioParams,
    triggerAttack,
    triggerRelease,
    swapSample,
    getPlayState,
    setHandY,
    setLayer,
    setInstrumentMode,
  } from "../audio/engine";

  interface Props {
    params?: AudioParams;
  }

  let { params }: Props = $props();

  let engine: AudioEngine = createAudioEngine();

  export function isRunning(): boolean {
    return engine.isRunning;
  }

  export async function start(): Promise<void> {
    await startAudio(engine);
  }

  export function stop(): void {
    stopAudio(engine);
  }

  export function attack(): void {
    triggerAttack(engine);
  }

  export function release(): void {
    triggerRelease(engine);
  }

  export async function changeSample(): Promise<void> {
    await swapSample(engine);
  }

  export function playState(): string {
    return getPlayState(engine);
  }

  export function updateHandY(y: number): void {
    setHandY(engine, y);
  }

  export function updateLayer(layer: "soft" | "medium" | "hard"): void {
    setLayer(engine, layer);
  }

  export function setMode(mode: InstrumentMode): void {
    setInstrumentMode(engine, mode);
  }

  // React to param changes
  $effect(() => {
    if (params) {
      updateAudioParams(engine, params);
    }
  });
</script>

<!-- Audio is non-visual, no markup needed -->
