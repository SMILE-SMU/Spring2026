<script lang="ts">
  /**
   * Mediapipe tracking component
   */

  import type { TrackingResult, Tracker } from "../tracking/mediapipe";
  import {
    createTracker,
    initializeTracker,
    processFrame,
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

  export async function initialize(performanceMode: boolean = false): Promise<void> {
    await initializeTracker(tracker, performanceMode);
    onReady?.();
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

