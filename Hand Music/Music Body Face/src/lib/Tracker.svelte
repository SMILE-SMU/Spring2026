<script lang="ts">
  /**
   * Mediapipe tracking component
   */

  import type { TrackingResult, Tracker } from "../tracking/mediapipe";
  import {
    createTracker,
    initializeTracker,
    processFrame,
    setNumHands,
  } from "../tracking/mediapipe";

  interface Props {
    onResult?: (result: TrackingResult, timestamp: number) => void;
    onReady?: () => void;
  }

  let { onResult, onReady }: Props = $props();

  let tracker: Tracker = createTracker();

  export function isReady(): boolean {
    return tracker.isReady;
  }

  export async function initialize(numHands: number = 2): Promise<void> {
    await initializeTracker(tracker, numHands);
    onReady?.();
  }

  export async function updateNumHands(numHands: number): Promise<void> {
    await setNumHands(tracker, numHands);
  }

  export function process(video: HTMLVideoElement, timestamp: number): void {
    if (!tracker.isReady) return;

    const result = processFrame(tracker, video, timestamp);
    if (result) {
      onResult?.(result, timestamp);
    }
  }
</script>

<!-- Tracker is non-visual, no markup needed -->

