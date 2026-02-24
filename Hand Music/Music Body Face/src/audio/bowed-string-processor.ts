/**
 * Bowed string physical model using a digital waveguide approach.
 *
 * The processor code is embedded as a string constant and registered via Blob URL
 * to avoid AudioWorklet build configuration issues with Vite.
 */

export const BOWED_STRING_PROCESSOR_NAME = "bowed-string-processor";

export const bowedStringProcessorCode = /* javascript */ `
/**
 * Digital waveguide bowed string model.
 *
 * Architecture:
 *   Two delay lines (nut-side and bridge-side of the bow contact point)
 *   connected in a loop with:
 *   - Bow-string friction interaction (stick-slip)
 *   - One-pole loss filters at nut and bridge reflections
 *   - Body resonance filter (cascaded biquads)
 *   - DC blocker and soft clipping for stability
 */
class BowedStringProcessor extends AudioWorkletProcessor {

  static get parameterDescriptors() {
    return [
      { name: "frequency",   defaultValue: 220,  minValue: 55,   maxValue: 1760, automationRate: "a-rate" },
      { name: "bowVelocity", defaultValue: 0,     minValue: 0,    maxValue: 1,    automationRate: "a-rate" },
      { name: "bowForce",    defaultValue: 0.5,   minValue: 0,    maxValue: 1,    automationRate: "a-rate" },
      { name: "bowPosition", defaultValue: 0.12,  minValue: 0.02, maxValue: 0.5,  automationRate: "a-rate" },
    ];
  }

  constructor(options) {
    super(options);

    // Maximum delay line length: support down to 55 Hz at 48 kHz = 873 samples.
    // Use 2048 for headroom.
    this.maxDelay = 2048;

    // Delay line buffers (Float64 for numerical stability over long sustains)
    this.nutLine  = new Float64Array(this.maxDelay);
    this.bridgeLine = new Float64Array(this.maxDelay);
    this.nutWritePtr = 0;
    this.bridgeWritePtr = 0;

    // One-pole loss filter states (nut and bridge reflections)
    this.nutFilterState = 0;
    this.bridgeFilterState = 0;

    // Body resonance: three cascaded biquad sections
    // Each section stores two z-delay states: z1, z2
    this.bodyFilters = [
      // Section 0: peak at ~180 Hz (cello body air mode)
      { b0: 0, b1: 0, b2: 0, a1: 0, a2: 0, z1: 0, z2: 0 },
      // Section 1: peak at ~550 Hz (main plate mode)
      { b0: 0, b1: 0, b2: 0, a1: 0, a2: 0, z1: 0, z2: 0 },
      // Section 2: peak at ~1200 Hz (upper body resonance)
      { b0: 0, b1: 0, b2: 0, a1: 0, a2: 0, z1: 0, z2: 0 },
    ];
    this.computeBodyFilterCoeffs(sampleRate);

    // DC blocker state
    this.dcPrevIn  = 0;
    this.dcPrevOut = 0;

    // Output gain (tuned so normal bowing is around -6 dBFS)
    this.outputGain = 0.35;

    // Silence detection
    this.silentSamples = 0;
    this.silenceThreshold = 256; // ~5ms at 48kHz before engaging silence mode

    // Smooth bow velocity to reduce clicks on sudden open/close
    this.smoothBowVel = 0;
  }

  /**
   * Compute biquad peaking EQ coefficients for body resonance filters.
   * Using the Audio EQ Cookbook formulas for peaking EQ.
   */
  computeBodyFilterCoeffs(sr) {
    const specs = [
      { freq: 180,  gainDb: 8,  Q: 2.5 },
      { freq: 550,  gainDb: 10, Q: 3.0 },
      { freq: 1200, gainDb: 5,  Q: 2.0 },
    ];

    for (let i = 0; i < specs.length; i++) {
      const { freq, gainDb, Q } = specs[i];
      const A  = Math.pow(10, gainDb / 40); // sqrt of linear gain
      const w0 = 2 * Math.PI * freq / sr;
      const sinW0 = Math.sin(w0);
      const cosW0 = Math.cos(w0);
      const alpha = sinW0 / (2 * Q);

      const b0 =  1 + alpha * A;
      const b1 = -2 * cosW0;
      const b2 =  1 - alpha * A;
      const a0 =  1 + alpha / A;
      const a1 = -2 * cosW0;
      const a2 =  1 - alpha / A;

      // Normalize by a0
      this.bodyFilters[i].b0 = b0 / a0;
      this.bodyFilters[i].b1 = b1 / a0;
      this.bodyFilters[i].b2 = b2 / a0;
      this.bodyFilters[i].a1 = a1 / a0;
      this.bodyFilters[i].a2 = a2 / a0;
    }
  }

  /**
   * Read from a circular delay line with fractional delay (linear interpolation).
   */
  readFractional(buffer, writePtr, delaySamples) {
    const size = this.maxDelay;
    let readPos = writePtr - delaySamples;
    if (readPos < 0) readPos += size;
    const intPart = Math.floor(readPos);
    const frac = readPos - intPart;
    const idx0 = intPart % size;
    const idx1 = (intPart + 1) % size;
    return buffer[idx0] * (1 - frac) + buffer[idx1] * frac;
  }

  /**
   * Apply a single biquad section (transposed direct form II).
   */
  applyBiquad(section, x) {
    const y = section.b0 * x + section.z1;
    section.z1 = section.b1 * x - section.a1 * y + section.z2;
    section.z2 = section.b2 * x - section.a2 * y;
    return y;
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const outChannel = output[0];
    const blockSize = outChannel.length;

    const freqParam     = parameters.frequency;
    const bowVelParam   = parameters.bowVelocity;
    const bowForceParam = parameters.bowForce;
    const bowPosParam   = parameters.bowPosition;

    for (let i = 0; i < blockSize; i++) {
      // Read a-rate params (may be single value if k-rate, or per-sample)
      const freq     = freqParam.length > 1    ? freqParam[i]     : freqParam[0];
      const rawBowVel = bowVelParam.length > 1  ? bowVelParam[i]   : bowVelParam[0];
      const bowForce = bowForceParam.length > 1 ? bowForceParam[i] : bowForceParam[0];
      const bowPos   = bowPosParam.length > 1   ? bowPosParam[i]   : bowPosParam[0];

      // Smooth bow velocity to prevent clicks (time constant ~3ms)
      const bowSmoothAlpha = 0.06;
      this.smoothBowVel += bowSmoothAlpha * (rawBowVel - this.smoothBowVel);
      const bowVel = this.smoothBowVel;

      // Silence detection: skip processing when bow is off and string has decayed
      if (bowVel < 0.001) {
        this.silentSamples++;
        if (this.silentSamples > this.silenceThreshold) {
          // Check if delay lines are effectively silent
          const nutEnergy = Math.abs(this.nutLine[this.nutWritePtr]);
          const bridgeEnergy = Math.abs(this.bridgeLine[this.bridgeWritePtr]);
          if (nutEnergy < 1e-10 && bridgeEnergy < 1e-10) {
            outChannel[i] = 0;
            continue;
          }
        }
      } else {
        this.silentSamples = 0;
      }

      // --- Delay line lengths from frequency and bow position ---
      const totalDelay = sampleRate / Math.max(55, freq);
      // Subtract ~1 sample for filter group delays
      const nutDelayLen    = Math.max(1, bowPos * totalDelay - 0.5);
      const bridgeDelayLen = Math.max(1, (1 - bowPos) * totalDelay - 0.5);

      // --- Read incoming traveling waves at bow point ---
      const nutIncoming    = this.readFractional(this.nutLine,    this.nutWritePtr,    nutDelayLen);
      const bridgeIncoming = this.readFractional(this.bridgeLine, this.bridgeWritePtr, bridgeDelayLen);

      // --- Bow-string friction interaction ---
      // String velocity at bow point (sum of incoming waves)
      const vString = nutIncoming + bridgeIncoming;

      // Scale bow velocity to physical units (arbitrary but tuned for good response)
      const vBow = bowVel * 0.2;
      const deltaV = vBow - vString;

      // Friction curve: hyperbolic stick-slip model
      // Higher bowForce = stronger friction = louder sound with more harmonics
      const frictionCoeff = 0.4;
      const frictionSlope = 80.0;
      const force = bowForce * frictionCoeff * deltaV * Math.exp(-frictionSlope * deltaV * deltaV);

      // Inject force equally into both directions
      const injection = force * 0.5;

      // --- Loss filters at reflection points ---
      // Frequency-dependent: higher frequencies decay faster (warm string sound)
      const baseLoss = 0.995;
      const freqLoss = Math.max(0.0, Math.min(0.003, 0.0002 * (freq - 100)));
      const lossCoeff = Math.max(0.88, Math.min(0.998, baseLoss - freqLoss));

      // Nut reflection: invert + lowpass
      const nutReflectedRaw = -(bridgeIncoming + injection);
      this.nutFilterState = lossCoeff * nutReflectedRaw + (1 - lossCoeff) * this.nutFilterState;
      const nutReflected = this.nutFilterState;

      // Bridge reflection: invert + lowpass (slightly different loss)
      const bridgeReflectedRaw = -(nutIncoming + injection);
      const bridgeLoss = Math.max(0.88, Math.min(0.998, lossCoeff * 0.998));
      this.bridgeFilterState = bridgeLoss * bridgeReflectedRaw + (1 - bridgeLoss) * this.bridgeFilterState;
      const bridgeReflected = this.bridgeFilterState;

      // --- Write to delay lines ---
      this.nutLine[this.nutWritePtr]       = nutReflected;
      this.bridgeLine[this.bridgeWritePtr] = bridgeReflected;

      // Advance write pointers
      this.nutWritePtr    = (this.nutWritePtr + 1)    % this.maxDelay;
      this.bridgeWritePtr = (this.bridgeWritePtr + 1) % this.maxDelay;

      // --- Output: bridge-side signal through body resonance ---
      let bodyOut = bridgeIncoming + injection;

      // Apply body resonance filters (cascaded biquads)
      for (let f = 0; f < this.bodyFilters.length; f++) {
        bodyOut = this.applyBiquad(this.bodyFilters[f], bodyOut);
      }

      // --- DC blocker ---
      const dcOut = bodyOut - this.dcPrevIn + 0.9975 * this.dcPrevOut;
      this.dcPrevIn  = bodyOut;
      this.dcPrevOut = dcOut;

      // --- Soft clipping (tanh) for stability ---
      const scaled = dcOut * this.outputGain;
      // Fast tanh approximation
      const x2 = scaled * scaled;
      const tanhApprox = scaled * (27 + x2) / (27 + 9 * x2);
      outChannel[i] = tanhApprox;
    }

    // Fill remaining channels (if stereo output requested) with copy of channel 0
    for (let ch = 1; ch < output.length; ch++) {
      output[ch].set(outChannel);
    }

    return true;
  }
}

registerProcessor("${BOWED_STRING_PROCESSOR_NAME}", BowedStringProcessor);
`;

// Track which AudioContexts have already registered the processor
const registeredContexts = new WeakSet<BaseAudioContext>();

/**
 * Register the bowed string AudioWorklet processor on the given context.
 * Safe to call multiple times -- subsequent calls are no-ops.
 */
export async function ensureBowedStringWorklet(ctx: BaseAudioContext): Promise<void> {
  if (registeredContexts.has(ctx)) return;
  const blob = new Blob([bowedStringProcessorCode], { type: "application/javascript" });
  const url = URL.createObjectURL(blob);
  await ctx.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);
  registeredContexts.add(ctx);
}
