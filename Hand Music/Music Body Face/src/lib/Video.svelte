<script lang="ts">
  /**
   * Webcam capture with canvas overlay for landmark visualization
   */

  interface Props {
    onFrame?: (video: HTMLVideoElement, timestamp: number) => void;
  }

  let { onFrame }: Props = $props();

  let videoElement: HTMLVideoElement | null = $state(null);
  let canvasElement: HTMLCanvasElement | null = $state(null);
  let isStreaming = $state(false);
  let animationId: number | null = null;

  export function getVideo(): HTMLVideoElement | null {
    return videoElement;
  }

  export function getCanvas(): HTMLCanvasElement | null {
    return canvasElement;
  }

  export function getContext(): CanvasRenderingContext2D | null {
    return canvasElement?.getContext("2d") ?? null;
  }

  export async function start(): Promise<void> {
    if (!videoElement || isStreaming) return;

    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: "user" },
      audio: false,
    });

    videoElement.srcObject = stream;
    await videoElement.play();

    // Match canvas size to video
    if (canvasElement) {
      canvasElement.width = videoElement.videoWidth;
      canvasElement.height = videoElement.videoHeight;
    }

    isStreaming = true;
    requestFrame();
  }

  export function stop(): void {
    if (!videoElement) return;

    const stream = videoElement.srcObject as MediaStream | null;
    stream?.getTracks().forEach((track) => track.stop());
    videoElement.srcObject = null;

    if (animationId !== null) {
      cancelAnimationFrame(animationId);
      animationId = null;
    }

    isStreaming = false;
  }

  function requestFrame(): void {
    if (!isStreaming) return;

    animationId = requestAnimationFrame((timestamp) => {
      if (videoElement && onFrame) {
        onFrame(videoElement, timestamp);
      }
      requestFrame();
    });
  }
</script>

<div class="video-container">
  <video bind:this={videoElement} playsinline muted></video>
  <canvas bind:this={canvasElement}></canvas>
</div>

<style>
  .video-container {
    position: relative;
    width: 100%;
    height: 100%;
  }

  video {
    width: 100%;
    height: 100%;
    object-fit: cover;
    transform: scaleX(-1);
  }

  canvas {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    transform: scaleX(-1);
    pointer-events: none;
  }
</style>

