/**
 * Audio engine for Music Body Face using Tone.js
 * Implements attack-sustain-release sample playback with crossfade looping
 */

import * as Tone from "tone";

// Playback states
type PlayState = "idle" | "attack" | "sustain" | "release";

export type ArticulationLayer = "soft" | "medium" | "hard";
export type InstrumentMode = "brass" | "strings";
type SampleGroup = "brass:trombone" | "strings:cello" | "strings:viola";

export interface AudioEngine {
  buffer: AudioBuffer | null;
  sourceNode: AudioBufferSourceNode | null;
  sourceNode2: AudioBufferSourceNode | null; // Second source for crossfade
  sourceGain1: GainNode | null; // Gain for first source (crossfade)
  sourceGain2: GainNode | null; // Gain for second source (crossfade)
  pitchShift: Tone.PitchShift | null;
  filter: Tone.Filter | null; // Lowpass filter for wah effect
  delay: Tone.FeedbackDelay | null; // Feedback delay for echo effect
  gain: Tone.Gain | null;
  limiter: Tone.Limiter | null;
  volume: Tone.Volume | null;
  isRunning: boolean;
  isLoaded: boolean;
  currentSample: string | null;
  playState: PlayState;
  loopStart: number; // seconds
  loopEnd: number; // seconds
  useASR: boolean; // true for long samples, false for short (one-shot)
  loopSchedulerId: number | null; // For canceling the loop scheduler
  activeSource: 1 | 2; // Which source is currently active
  lastHandY: number; // Last hand Y position for pitch-based sample selection
  currentLayer: ArticulationLayer; // soft, medium, or hard based on movement jerkiness
  instrumentMode: InstrumentMode; // brass (trombone) or strings (cello/viola)
  currentGroup: SampleGroup; // which sample group the currently loaded buffer came from
}

export interface AudioParams {
  pitchShift: number;
  gain: number;
  filterCutoff: number; // 0-1, maps to frequency range for wah effect
  delayTime: number; // 0-1, maps to delay time (0 = no delay, 1 = max delay)
  feedback: number; // 0-1, maps to feedback amount
}

// Sample categories to pick from
const BRASS_FOLDERS = [
  "Trombone/Standard/Hard Layer",
  "Trombone/Standard/Medium Layer",
  "Trombone/Standard/Soft Layer",
  "Trombone/Harmo Mute/Hard Layer",
  "Trombone/Harmo Mute/Soft Layer",
];

const STRINGS_FOLDERS = ["Cello Soft", "Viola Soft"] as const;

// Note name to semitone offset (C = 0)
const NOTE_TO_SEMITONE: Record<string, number> = {
  'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11,
  'Cs': 1, 'Db': 1, 'Ds': 3, 'Eb': 3, 'Fs': 6, 'Gb': 6,
  'Gs': 8, 'Ab': 8, 'As': 10, 'Bb': 10,
};

interface SampleInfo {
  path: string;
  midiNote: number; // MIDI note number for sorting (C4 = 60)
  octave: number; // Octave number (2-7 typically)
  layer: ArticulationLayer; // soft, medium, or hard
  group: SampleGroup;
}

// Samples grouped by (group -> octave)
let samplesByGroupAndOctave: Map<SampleGroup, Map<number, SampleInfo[]>> = new Map();
let sortedOctavesByGroup: Map<SampleGroup, number[]> = new Map();
let samplesLoaded = false;

/**
 * Parse note name and octave from filename.
 * Supports multiple formats:
 *   - "cello_A3_15_forte..." -> { note: "A", octave: 3 }
 *   - "TB Hard A2.wav" -> { note: "A", octave: 2 }
 *   - "Mute TB Soft B3.wav" -> { note: "B", octave: 3 }
 */
function parseNoteFromFilename(filename: string): { note: string; octave: number } | null {
  // Most of our .wav filenames contain the note+octave right before the extension.
  // Examples:
  // - "TB Med A2.wav"
  // - "Mute TB Soft C4.wav"
  // - "Cello softA1.wav"
  // - "Viola Soft A3.wav"
  const endMatch = filename.match(/([A-G])([sb]?)(\d)\.(wav|mp3)$/i);
  if (endMatch) {
    const noteLetter = endMatch[1].toUpperCase();
    const accidental = (endMatch[2] ?? "").toLowerCase(); // 's' or 'b' or ''
    const octave = parseInt(endMatch[3], 10);
    const note = accidental ? `${noteLetter}${accidental}`.replace("b", "b").replace("s", "s") : noteLetter;
    return { note: note === "Cb" ? "B" : note, octave };
  }
  
  // Fall back to old format: _A3_, _Cs4_, _Bb2_, etc.
  const oldFormatMatch = filename.match(/_([A-G][sb]?)(\d)_/i);
  if (oldFormatMatch) {
    let note = oldFormatMatch[1];
    // Normalize: 's' for sharp, 'b' for flat
    note = note.charAt(0).toUpperCase() + note.slice(1).toLowerCase();
    if (note.length > 1 && note[1] === 's') {
      note = note[0] + 's';
    }
    const octave = parseInt(oldFormatMatch[2], 10);
    return { note, octave };
  }
  
  return null;
}

/**
 * Convert note name and octave to MIDI note number.
 * C4 = 60 (middle C)
 */
function noteToMidi(note: string, octave: number): number {
  const semitone = NOTE_TO_SEMITONE[note] ?? NOTE_TO_SEMITONE[note[0]] ?? 0;
  return (octave + 1) * 12 + semitone;
}

/**
 * Parse articulation layer from folder path.
 * Looks for "Soft", "Medium", or "Hard" in the path.
 */
function parseLayerFromPath(folderPath: string): ArticulationLayer {
  const lowerPath = folderPath.toLowerCase();
  if (lowerPath.includes("soft")) return "soft";
  if (lowerPath.includes("hard")) return "hard";
  return "medium"; // Default to medium
}

/**
 * Load samples and group by octave for dramatic pitch mapping.
 */
async function loadSampleManifest(): Promise<void> {
  if (samplesLoaded) return;
  
  try {
    const response = await fetch("/audio/manifest.json");
    const manifest: Record<string, string[]> = await response.json();
    
    samplesByGroupAndOctave = new Map();
    sortedOctavesByGroup = new Map();

    const allFolders: string[] = [...BRASS_FOLDERS, ...STRINGS_FOLDERS];

    for (const folder of allFolders) {
      const files = manifest[folder] ?? [];

      let group: SampleGroup;
      let layer: ArticulationLayer = "medium";

      if (folder.startsWith("Trombone/")) {
        group = "brass:trombone";
        layer = parseLayerFromPath(folder);
      } else if (folder === "Cello Soft") {
        group = "strings:cello";
      } else if (folder === "Viola Soft") {
        group = "strings:viola";
      } else {
        continue;
      }

      if (!samplesByGroupAndOctave.has(group)) {
        samplesByGroupAndOctave.set(group, new Map());
      }
      const groupMap = samplesByGroupAndOctave.get(group)!;

      for (const file of files) {
        const parsed = parseNoteFromFilename(file);
        if (!parsed) continue;

        const midiNote = noteToMidi(parsed.note, parsed.octave);
        const sample: SampleInfo = {
          path: `/audio/${folder}/${file}`,
          midiNote,
          octave: parsed.octave,
          layer,
          group,
        };

        if (!groupMap.has(parsed.octave)) groupMap.set(parsed.octave, []);
        groupMap.get(parsed.octave)!.push(sample);
      }
    }

    // Sort octaves and samples for each group
    for (const [group, groupMap] of samplesByGroupAndOctave.entries()) {
      const sortedOctaves = Array.from(groupMap.keys()).sort((a, b) => a - b);
      sortedOctavesByGroup.set(group, sortedOctaves);
      for (const samples of groupMap.values()) {
        samples.sort((a, b) => a.midiNote - b.midiNote);
      }
    }
    
    samplesLoaded = true;
  } catch (err) {
    console.error("Failed to load sample manifest:", err);
  }
}

/**
 * Get a sample based on hand Y position and articulation layer.
 * Maps hand position to OCTAVE first for dramatic pitch differences,
 * then filters by layer (soft/medium/hard based on movement jerkiness),
 * then picks randomly within that subset.
 */
function getSampleByPitchGroupAndLayer(handY: number, group: SampleGroup, layer: ArticulationLayer): string {
  const groupOctaves = sortedOctavesByGroup.get(group) ?? [];
  const groupMap = samplesByGroupAndOctave.get(group);

  if (!groupMap || groupOctaves.length === 0) {
    // Fallbacks (must exist locally)
    if (group === "strings:cello") return "/audio/Cello Soft/Cello softC3.wav";
    if (group === "strings:viola") return "/audio/Viola Soft/Viola Soft C4.wav";
    return "/audio/Trombone/Standard/Medium Layer/TB Med A3.wav";
  }
  
  // Invert Y: 0 (top of screen/high hand) = high pitch, 1 (bottom/low hand) = low pitch
  const pitchPosition = 1 - handY;
  
  // Map position to octave index
  // pitchPosition 0 = lowest octave, 1 = highest octave
  const octaveIndex = Math.floor(pitchPosition * groupOctaves.length);
  const clampedIndex = Math.max(0, Math.min(groupOctaves.length - 1, octaveIndex));
  const targetOctave = groupOctaves[clampedIndex];
  
  // Get samples in this octave
  const octaveSamples = groupMap.get(targetOctave) ?? [];
  if (octaveSamples.length === 0) {
    // Shouldn't happen if our indices are consistent, but keep it safe.
    return "/audio/Trombone/Standard/Medium Layer/TB Med A3.wav";
  }
  
  // Filter by layer
  let layerSamples = octaveSamples;
  if (group.startsWith("brass:")) {
    layerSamples = octaveSamples.filter((s: SampleInfo) => s.layer === layer);
    if (layerSamples.length === 0) layerSamples = octaveSamples;
  }
  
  // Pick a random sample from filtered set
  const randomIndex = Math.floor(Math.random() * layerSamples.length);
  const sample = layerSamples[randomIndex];
  
  return sample.path;
}

// Loop point percentages (of total duration) - tighter loop region
const LOOP_START_PERCENT = 0.30; // Start looping at 30% into sample
const LOOP_END_PERCENT = 0.70; // Loop back before 70% of sample

// Crossfade duration in seconds
const CROSSFADE_DURATION = 0.15;

// Fade out duration when stopping (prevents clicks)
const FADE_OUT_DURATION = 0.1;

// Filter settings for wah effect
const FILTER_MIN_FREQ = 200; // Hz - "w" sound (closed hand)
const FILTER_MAX_FREQ = 4000; // Hz - "ah" sound (open hand)
const FILTER_Q = 4; // Resonance - higher = more pronounced wah

// Delay settings
const DELAY_MIN_TIME = 0.01; // seconds - minimum delay (nearly no delay)
const DELAY_MAX_TIME = 3.0; // seconds - maximum delay (3 seconds as requested)
const DELAY_WET = 0.5; // Fixed wet/dry mix for now
const DELAY_MAX_FEEDBACK = 0.85; // Maximum feedback (avoid infinite loops)

// Minimum duration (seconds) to use ASR looping; shorter samples play once
const ASR_MIN_DURATION = 0.5;

// How far to search for good loop points (in seconds from target)
const LOOP_SEARCH_WINDOW = 0.15;

// Window size for RMS calculation (in seconds)
const RMS_WINDOW = 0.03; // 30ms window for RMS

// Quality thresholds for accepting a sample's loop points
const MAX_RMS_DIFF = 0.05; // Maximum 5% RMS difference between loop points
const MIN_LOOP_LENGTH = 0.4; // Minimum loop length in seconds
const MAX_LOOP_LENGTH = 4.0; // Maximum loop length in seconds
const MAX_SAMPLE_RETRIES = 5; // How many samples to try before giving up

/**
 * Calculate RMS (root mean square) amplitude over a window centered at a sample index.
 * RMS gives a better measure of perceived loudness than instantaneous amplitude.
 */
function calculateRMS(channelData: Float32Array, centerSample: number, windowSamples: number): number {
  const halfWindow = Math.floor(windowSamples / 2);
  const start = Math.max(0, centerSample - halfWindow);
  const end = Math.min(channelData.length - 1, centerSample + halfWindow);
  
  let sumSquares = 0;
  let count = 0;
  for (let i = start; i <= end; i++) {
    sumSquares += channelData[i] * channelData[i];
    count++;
  }
  
  return Math.sqrt(sumSquares / count);
}

interface LoopPointResult {
  loopStart: number;
  loopEnd: number;
  rmsDiff: number; // Normalized RMS difference (0-1)
  loopLength: number; // Length of loop in seconds
  isAcceptable: boolean; // Whether this meets quality thresholds
}

/**
 * Find optimal loop points by analyzing the audio buffer for matching RMS levels.
 * Looks for points where the perceived volume (RMS) is similar at both loop boundaries.
 * Returns quality metrics so caller can decide whether to accept or retry.
 */
function findOptimalLoopPoints(
  buffer: AudioBuffer,
  targetStart: number,
  targetEnd: number
): LoopPointResult {
  const sampleRate = buffer.sampleRate;
  const channelData = buffer.getChannelData(0); // Use first channel
  
  // Convert times to sample indices
  const targetStartSample = Math.floor(targetStart * sampleRate);
  const targetEndSample = Math.floor(targetEnd * sampleRate);
  const searchWindowSamples = Math.floor(LOOP_SEARCH_WINDOW * sampleRate);
  const rmsWindowSamples = Math.floor(RMS_WINDOW * sampleRate);
  
  // Search ranges
  const startMin = Math.max(rmsWindowSamples, targetStartSample - searchWindowSamples);
  const startMax = Math.min(channelData.length - rmsWindowSamples - 1, targetStartSample + searchWindowSamples);
  const endMin = Math.max(rmsWindowSamples, targetEndSample - searchWindowSamples);
  const endMax = Math.min(channelData.length - rmsWindowSamples - 1, targetEndSample + searchWindowSamples);
  
  // Pre-calculate RMS values for candidate points in both regions
  const step = Math.floor(sampleRate * 0.002); // Check every 2ms
  
  const startCandidates: { sample: number; rms: number }[] = [];
  for (let s = startMin; s <= startMax; s += step) {
    startCandidates.push({
      sample: s,
      rms: calculateRMS(channelData, s, rmsWindowSamples),
    });
  }
  
  const endCandidates: { sample: number; rms: number }[] = [];
  for (let e = endMin; e <= endMax; e += step) {
    endCandidates.push({
      sample: e,
      rms: calculateRMS(channelData, e, rmsWindowSamples),
    });
  }
  
  // Find the pair with the most similar RMS values
  let bestMatch = {
    startSample: targetStartSample,
    endSample: targetEndSample,
    rmsDiff: Infinity,
    startRMS: 0,
    endRMS: 0,
  };
  
  for (const startCandidate of startCandidates) {
    for (const endCandidate of endCandidates) {
      const rmsDiff = Math.abs(startCandidate.rms - endCandidate.rms);
      if (rmsDiff < bestMatch.rmsDiff) {
        bestMatch = {
          startSample: startCandidate.sample,
          endSample: endCandidate.sample,
          rmsDiff,
          startRMS: startCandidate.rms,
          endRMS: endCandidate.rms,
        };
      }
    }
  }
  
  const loopStart = bestMatch.startSample / sampleRate;
  const loopEnd = bestMatch.endSample / sampleRate;
  const loopLength = loopEnd - loopStart;
  
  // Normalize RMS diff relative to the average RMS level
  const avgRMS = (bestMatch.startRMS + bestMatch.endRMS) / 2;
  const normalizedRmsDiff = avgRMS > 0 ? bestMatch.rmsDiff / avgRMS : bestMatch.rmsDiff;
  
  // Check quality thresholds
  const isAcceptable = 
    normalizedRmsDiff <= MAX_RMS_DIFF &&
    loopLength >= MIN_LOOP_LENGTH &&
    loopLength <= MAX_LOOP_LENGTH;
  
  const startOffset = (bestMatch.startSample - targetStartSample) / sampleRate * 1000;
  const endOffset = (bestMatch.endSample - targetEndSample) / sampleRate * 1000;
  
  const status = isAcceptable ? '✓' : '✗';
  console.log(
    `${status} Loop points: ` +
    `start ${startOffset >= 0 ? '+' : ''}${startOffset.toFixed(1)}ms (RMS: ${bestMatch.startRMS.toFixed(4)}), ` +
    `end ${endOffset >= 0 ? '+' : ''}${endOffset.toFixed(1)}ms (RMS: ${bestMatch.endRMS.toFixed(4)}), ` +
    `diff: ${(normalizedRmsDiff * 100).toFixed(1)}%, length: ${loopLength.toFixed(2)}s`
  );
  
  return {
    loopStart,
    loopEnd,
    rmsDiff: normalizedRmsDiff,
    loopLength,
    isAcceptable,
  };
}

async function getRandomSample(): Promise<string> {
  try {
    const response = await fetch("/audio/manifest.json");
    const manifest: Record<string, string[]> = await response.json();
    
    const availableFolders: string[] = BRASS_FOLDERS.filter(
      (folder: string) => (manifest[folder]?.length ?? 0) > 0
    );
    
    if (availableFolders.length === 0) {
      console.warn("No samples found in preferred folders, using fallback");
      return "/audio/Trombone/Standard/Medium Layer/TB Med A3.wav";
    }
    
    const folderIndex = Math.floor(Math.random() * availableFolders.length);
    const folder = availableFolders[folderIndex];
    const files = manifest[folder];
    const fileIndex = Math.floor(Math.random() * files.length);
    const file = files[fileIndex];
    
    const samplePath = `/audio/${folder}/${file}`;
    console.log("🎵 SELECTED SAMPLE:", samplePath);
    return samplePath;
  } catch (err) {
    console.error("Failed to load manifest, using fallback sample:", err);
    return "/audio/Trombone/Standard/Medium Layer/TB Med A3.wav";
  }
}

async function loadAudioBuffer(url: string): Promise<AudioBuffer> {
  const response = await fetch(url);
  const arrayBuffer = await response.arrayBuffer();
  return await Tone.getContext().decodeAudioData(arrayBuffer);
}

export function createAudioEngine(): AudioEngine {
  return {
    buffer: null,
    sourceNode: null,
    sourceNode2: null,
    sourceGain1: null,
    sourceGain2: null,
    pitchShift: null,
    filter: null,
    delay: null,
    gain: null,
    limiter: null,
    volume: null,
    isRunning: false,
    isLoaded: false,
    currentSample: null,
    playState: "idle",
    loopStart: 0,
    loopEnd: 0,
    useASR: false,
    loopSchedulerId: null,
    activeSource: 1,
    lastHandY: 0.5, // Default to middle pitch
    currentLayer: "medium", // Default to medium articulation
    instrumentMode: "brass",
    currentGroup: "brass:trombone",
  };
}

export async function startAudio(engine: AudioEngine): Promise<void> {
  if (engine.isRunning) return;

  await Tone.start();
  // Minimize audio latency
  Tone.getContext().lookAhead = 0.005;
  console.log("Tone.js started, lookAhead:", Tone.getContext().lookAhead);
  
  // Load sample manifest for pitch-based selection
  await loadSampleManifest();

  // Create output chain: sources -> pitchShift -> filter -> delay -> gain -> volume -> limiter -> dest
  // Limiter at -3dB gives more headroom and less aggressive limiting
  const limiter = new Tone.Limiter(-3).toDestination();
  // Reduced volume boost (was +12dB) - with two hands playing, this prevents summing distortion
  const volume = new Tone.Volume(6).connect(limiter);
  const gain = new Tone.Gain(0).connect(volume);
  
  // Feedback delay for echo effect (DISABLED for now)
  const delay = new Tone.FeedbackDelay({
    delayTime: DELAY_MIN_TIME, // Start with minimal delay
    feedback: 0, // Feedback disabled - no repeating echoes
    wet: 0, // DISABLED - set to 0 to bypass delay
    maxDelay: DELAY_MAX_TIME + 0.5, // Buffer for max delay
  }).connect(gain);
  
  // Lowpass filter for wah effect - connect directly to gain, bypassing delay
  const filter = new Tone.Filter({
    type: "lowpass",
    frequency: FILTER_MAX_FREQ, // Start open
    Q: FILTER_Q,
    rolloff: -24, // Steeper rolloff for more pronounced effect
  }).connect(gain); // Bypass delay for now
  
  const pitchShift = new Tone.PitchShift({
    pitch: 0,
    windowSize: 0.03, // Reduced from 0.05 for less latency
    delayTime: 0,
  }).connect(filter);

  // Create crossfade gain nodes
  const ctx = Tone.getContext().rawContext;
  const sourceGain1 = ctx.createGain();
  const sourceGain2 = ctx.createGain();
  sourceGain1.gain.value = 1;
  sourceGain2.gain.value = 0;
  
  // Connect source gains to pitch shift
  // @ts-ignore - Tone.js input is compatible with Web Audio
  sourceGain1.connect(pitchShift.input.input || pitchShift.input);
  // @ts-ignore
  sourceGain2.connect(pitchShift.input.input || pitchShift.input);

  engine.pitchShift = pitchShift;
  engine.filter = filter;
  engine.delay = delay;
  engine.gain = gain;
  engine.limiter = limiter;
  engine.volume = volume;
  engine.sourceGain1 = sourceGain1;
  engine.sourceGain2 = sourceGain2;
  engine.isRunning = true;

  // Load initial sample
  await loadNewSample(engine);
}

async function loadNewSample(engine: AudioEngine, retryCount: number = 0): Promise<void> {
  // Choose which family of samples to use
  let group: SampleGroup = "brass:trombone";
  if (engine.instrumentMode === "strings") {
    group = Math.random() < 0.5 ? "strings:cello" : "strings:viola";
  }
  engine.currentGroup = group;

  const samplePath = getSampleByPitchGroupAndLayer(engine.lastHandY, group, engine.currentLayer);
  engine.currentSample = samplePath;
  
  try {
    const buffer = await loadAudioBuffer(samplePath);
    const duration = buffer.duration;
    
    // Use ASR for long samples, one-shot for short ones
    const useASR = duration >= ASR_MIN_DURATION;
    
    if (useASR) {
      // Calculate optimal loop points for ASR
      const targetStart = duration * LOOP_START_PERCENT;
      const targetEnd = duration * LOOP_END_PERCENT;
      const optimal = findOptimalLoopPoints(buffer, targetStart, targetEnd);
      
      // Check if this sample meets quality thresholds
      if (!optimal.isAcceptable && retryCount < MAX_SAMPLE_RETRIES) {
        console.log(`Sample rejected (attempt ${retryCount + 1}/${MAX_SAMPLE_RETRIES}), trying another...`);
        await loadNewSample(engine, retryCount + 1);
        return;
      }
      
      if (!optimal.isAcceptable) {
        console.warn(`Using sample despite poor loop quality (exhausted ${MAX_SAMPLE_RETRIES} retries)`);
      }
      
      engine.buffer = buffer;
      engine.useASR = true;
      engine.loopStart = optimal.loopStart;
      engine.loopEnd = optimal.loopEnd;
      console.log(`✓ Sample accepted: ${duration.toFixed(2)}s (ASR mode), loop: ${engine.loopStart.toFixed(3)}s - ${engine.loopEnd.toFixed(3)}s`);
    } else {
      // Short sample: no loop, always acceptable
      engine.buffer = buffer;
      engine.useASR = false;
      engine.loopStart = 0;
      engine.loopEnd = duration;
      console.log(`✓ Sample accepted: ${duration.toFixed(2)}s (one-shot mode)`);
    }
    
    engine.isLoaded = true;
  } catch (err) {
    console.error("Failed to load sample:", err);
    
    // Retry on load failure too
    if (retryCount < MAX_SAMPLE_RETRIES) {
      console.log(`Load failed, trying another sample...`);
      await loadNewSample(engine, retryCount + 1);
    }
  }
}

export function stopAudio(engine: AudioEngine): void {
  if (!engine.isRunning) return;

  stopCurrentSound(engine);
  
  engine.pitchShift?.dispose();
  engine.filter?.dispose();
  engine.gain?.dispose();
  engine.volume?.dispose();
  engine.limiter?.dispose();
  engine.sourceGain1?.disconnect();
  engine.sourceGain2?.disconnect();

  engine.buffer = null;
  engine.pitchShift = null;
  engine.filter = null;
  engine.gain = null;
  engine.volume = null;
  engine.limiter = null;
  engine.sourceGain1 = null;
  engine.sourceGain2 = null;
  engine.isRunning = false;
  engine.isLoaded = false;
  engine.currentSample = null;
  engine.playState = "idle";
}

function stopCurrentSound(engine: AudioEngine, fade: boolean = false): void {
  // Cancel any scheduled loop
  if (engine.loopSchedulerId !== null) {
    clearTimeout(engine.loopSchedulerId);
    engine.loopSchedulerId = null;
  }
  
  const ctx = Tone.getContext().rawContext;
  const now = ctx.currentTime;
  
  if (fade && (engine.sourceGain1 || engine.sourceGain2)) {
    // Fade out both gains to prevent clicks
    if (engine.sourceGain1) {
      engine.sourceGain1.gain.setValueAtTime(engine.sourceGain1.gain.value, now);
      engine.sourceGain1.gain.linearRampToValueAtTime(0, now + FADE_OUT_DURATION);
    }
    if (engine.sourceGain2) {
      engine.sourceGain2.gain.setValueAtTime(engine.sourceGain2.gain.value, now);
      engine.sourceGain2.gain.linearRampToValueAtTime(0, now + FADE_OUT_DURATION);
    }
    
    // Stop sources after fade completes
    setTimeout(() => {
      stopSourceNodes(engine);
    }, FADE_OUT_DURATION * 1000 + 50);
  } else {
    // Stop immediately
    stopSourceNodes(engine);
  }
}

function stopSourceNodes(engine: AudioEngine): void {
  if (engine.sourceNode) {
    try {
      engine.sourceNode.stop();
      engine.sourceNode.disconnect();
    } catch (e) {
      // Already stopped
    }
    engine.sourceNode = null;
  }
  
  if (engine.sourceNode2) {
    try {
      engine.sourceNode2.stop();
      engine.sourceNode2.disconnect();
    } catch (e) {
      // Already stopped
    }
    engine.sourceNode2 = null;
  }
  
  // Reset gains
  if (engine.sourceGain1) engine.sourceGain1.gain.value = 1;
  if (engine.sourceGain2) engine.sourceGain2.gain.value = 0;
  engine.activeSource = 1;
}

// Create and start a new source node
function createSource(engine: AudioEngine, startTime: number, gainNode: GainNode): AudioBufferSourceNode {
  const ctx = Tone.getContext().rawContext;
  const source = ctx.createBufferSource();
  source.buffer = engine.buffer!;
  source.connect(gainNode);
  source.start(0, startTime);
  return source;
}

// Schedule the next crossfade loop iteration
function scheduleNextLoop(engine: AudioEngine): void {
  if (engine.playState !== "sustain" || !engine.buffer) return;
  
  const loopDuration = engine.loopEnd - engine.loopStart;
  const timeUntilCrossfade = (loopDuration - CROSSFADE_DURATION) * 1000;
  
  engine.loopSchedulerId = window.setTimeout(() => {
    if (engine.playState !== "sustain") return;
    
    performCrossfade(engine);
  }, timeUntilCrossfade);
}

// Perform the crossfade between sources
function performCrossfade(engine: AudioEngine): void {
  if (!engine.buffer || !engine.sourceGain1 || !engine.sourceGain2) return;
  
  const ctx = Tone.getContext().rawContext;
  const now = ctx.currentTime;
  
  if (engine.activeSource === 1) {
    // Fade out source 1, fade in source 2
    engine.sourceNode2 = createSource(engine, engine.loopStart, engine.sourceGain2);
    
    engine.sourceGain1.gain.setValueAtTime(1, now);
    engine.sourceGain1.gain.linearRampToValueAtTime(0, now + CROSSFADE_DURATION);
    engine.sourceGain2.gain.setValueAtTime(0, now);
    engine.sourceGain2.gain.linearRampToValueAtTime(1, now + CROSSFADE_DURATION);
    
    // Stop old source after crossfade
    setTimeout(() => {
      if (engine.sourceNode) {
        try {
          engine.sourceNode.stop();
          engine.sourceNode.disconnect();
        } catch (e) {}
        engine.sourceNode = null;
      }
    }, CROSSFADE_DURATION * 1000 + 50);
    
    engine.activeSource = 2;
  } else {
    // Fade out source 2, fade in source 1
    engine.sourceNode = createSource(engine, engine.loopStart, engine.sourceGain1);
    
    engine.sourceGain2.gain.setValueAtTime(1, now);
    engine.sourceGain2.gain.linearRampToValueAtTime(0, now + CROSSFADE_DURATION);
    engine.sourceGain1.gain.setValueAtTime(0, now);
    engine.sourceGain1.gain.linearRampToValueAtTime(1, now + CROSSFADE_DURATION);
    
    // Stop old source after crossfade
    setTimeout(() => {
      if (engine.sourceNode2) {
        try {
          engine.sourceNode2.stop();
          engine.sourceNode2.disconnect();
        } catch (e) {}
        engine.sourceNode2 = null;
      }
    }, CROSSFADE_DURATION * 1000 + 50);
    
    engine.activeSource = 1;
  }
  
  // Schedule next loop
  scheduleNextLoop(engine);
}

// Start playing the sample (attack phase)
export function triggerAttack(engine: AudioEngine): void {
  if (!engine.isRunning || !engine.isLoaded || !engine.buffer || !engine.sourceGain1) {
    console.log("Cannot trigger attack - not ready");
    return;
  }
  
  // Check if we're actually playing (sourceNode exists and is active)
  // If playState is not idle but no source is playing, reset to idle
  if (engine.playState !== "idle") {
    const hasActiveSource = engine.sourceNode !== null || engine.sourceNode2 !== null;
    if (!hasActiveSource) {
      console.log("State was stuck, resetting to idle");
      engine.playState = "idle";
    } else {
      console.log("Already playing, ignoring attack");
      return;
    }
  }

  if (engine.useASR) {
    // Long sample: ASR mode with crossfade looping
    console.log("🎹 ATTACK (ASR) - starting sample");
    
    // Reset gains
    engine.sourceGain1.gain.value = 1;
    engine.sourceGain2!.gain.value = 0;
    engine.activeSource = 1;
    
    // Start from beginning
    engine.sourceNode = createSource(engine, 0, engine.sourceGain1);
    engine.playState = "attack";
    
    // Schedule transition to sustain when we reach loop start
    const timeToLoop = engine.loopStart * 1000;
    setTimeout(() => {
      if (engine.playState === "attack") {
        console.log("🔄 SUSTAIN - starting crossfade loop");
        engine.playState = "sustain";
        
        // Schedule first crossfade
        const loopDuration = engine.loopEnd - engine.loopStart;
        const timeUntilCrossfade = (loopDuration - CROSSFADE_DURATION) * 1000;
        
        engine.loopSchedulerId = window.setTimeout(() => {
          if (engine.playState === "sustain") {
            performCrossfade(engine);
          }
        }, timeUntilCrossfade);
      }
    }, timeToLoop);
  } else {
    // Short sample: one-shot mode - play once, no loop
    console.log("🎹 PLAY (one-shot) - starting sample");
    
    engine.sourceGain1.gain.value = 1;
    engine.sourceNode = createSource(engine, 0, engine.sourceGain1);
    engine.playState = "sustain";
    
    // When sample ends naturally, go back to idle and load new sample
    engine.sourceNode.onended = async () => {
      if (engine.playState !== "idle") {
        console.log("Short sample ended naturally, loading new sample");
        engine.playState = "idle";
        engine.sourceNode = null;
        await loadNewSample(engine);
      }
    };
  }
}

// Release the sample (play through to end for ASR, fade out for one-shot)
export function triggerRelease(engine: AudioEngine): void {
  if (!engine.isRunning || !engine.buffer) {
    return;
  }
  
  if (engine.playState === "idle" || engine.playState === "release") {
    return;
  }

  if (engine.useASR && engine.sourceGain1 && engine.sourceGain2) {
    // Long sample: ASR mode - crossfade to release portion
    console.log("🎹 RELEASE (ASR) - crossfading to ending");
    
    // Cancel any scheduled crossfade
    if (engine.loopSchedulerId !== null) {
      clearTimeout(engine.loopSchedulerId);
      engine.loopSchedulerId = null;
    }
    
    engine.playState = "release";
    
    const ctx = Tone.getContext().rawContext;
    const now = ctx.currentTime;
    
    // Create a new source starting at loopEnd (the release portion)
    const releaseSource = ctx.createBufferSource();
    releaseSource.buffer = engine.buffer;
    
    // Use the inactive gain node for the release
    const releaseGain = engine.activeSource === 1 ? engine.sourceGain2 : engine.sourceGain1;
    const currentGain = engine.activeSource === 1 ? engine.sourceGain1 : engine.sourceGain2;
    
    releaseSource.connect(releaseGain);
    releaseSource.start(0, engine.loopEnd); // Start from release portion
    
    // Crossfade: fade out current, fade in release
    currentGain.gain.setValueAtTime(currentGain.gain.value, now);
    currentGain.gain.linearRampToValueAtTime(0, now + CROSSFADE_DURATION);
    releaseGain.gain.setValueAtTime(0, now);
    releaseGain.gain.linearRampToValueAtTime(1, now + CROSSFADE_DURATION);
    
    // Stop current source after crossfade
    setTimeout(() => {
      if (engine.activeSource === 1 && engine.sourceNode) {
        try { engine.sourceNode.stop(); engine.sourceNode.disconnect(); } catch (e) {}
        engine.sourceNode = null;
      } else if (engine.sourceNode2) {
        try { engine.sourceNode2.stop(); engine.sourceNode2.disconnect(); } catch (e) {}
        engine.sourceNode2 = null;
      }
    }, CROSSFADE_DURATION * 1000 + 50);
    
    // When release portion ends, go to idle and load new sample
    const releaseDuration = engine.buffer.duration - engine.loopEnd;
    releaseSource.onended = async () => {
      if (engine.playState === "release") {
        console.log("Release ended, loading new sample");
        engine.playState = "idle";
        // Clear source nodes and reset gains
        engine.sourceNode = null;
        engine.sourceNode2 = null;
        engine.sourceGain1!.gain.value = 1;
        engine.sourceGain2!.gain.value = 0;
        engine.activeSource = 1;
        await loadNewSample(engine);
      }
    };
    
    console.log(`Release portion: ${releaseDuration.toFixed(2)}s`);
  } else {
    // Short sample: one-shot mode - fade out
    console.log("🎹 STOP (one-shot) - fading out");
    stopCurrentSound(engine, true); // Use fade
    engine.playState = "idle";
    // Ensure source nodes are nulled for our state check
    engine.sourceNode = null;
    engine.sourceNode2 = null;
    
    // Load new sample for next time (after fade)
    setTimeout(() => {
      loadNewSample(engine);
    }, FADE_OUT_DURATION * 1000 + 50);
  }
}

export function updateAudioParams(engine: AudioEngine, params: AudioParams): void {
  if (!engine.isRunning || !engine.gain) return;

  // Pitch shift disabled for now
  // if (engine.pitchShift) {
  //   engine.pitchShift.pitch = params.pitchShift;
  // }

  // Update gain - fast ramp for responsive volume
  engine.gain.gain.rampTo(params.gain, 0.005);
  
  // Update filter cutoff for wah effect
  if (engine.filter) {
    const cutoff = FILTER_MIN_FREQ * Math.pow(FILTER_MAX_FREQ / FILTER_MIN_FREQ, params.filterCutoff);
    engine.filter.frequency.rampTo(cutoff, 0.008); // Fast ramp
  }
  
  // Update delay parameters (delay is currently bypassed)
  if (engine.delay && engine.delay.wet.value > 0) {
    const delayTime = DELAY_MIN_TIME + Math.pow(params.delayTime, 3) * (DELAY_MAX_TIME - DELAY_MIN_TIME);
    engine.delay.delayTime.rampTo(delayTime, 0.1);
  }
}

export async function swapSample(engine: AudioEngine): Promise<void> {
  console.log("🔄 SWAP SAMPLE called");
  if (!engine.isRunning) {
    return;
  }
  
  stopCurrentSound(engine);
  engine.playState = "idle";
  await loadNewSample(engine);
}

// Get current play state for UI
export function getPlayState(engine: AudioEngine): PlayState {
  return engine.playState;
}

// Update hand Y position for pitch-based sample selection
export function setHandY(engine: AudioEngine, handY: number): void {
  engine.lastHandY = handY;
}

// Update articulation layer based on movement jerkiness
export function setLayer(engine: AudioEngine, layer: ArticulationLayer): void {
  engine.currentLayer = layer;
}

// Update instrument mode (brass vs strings)
export function setInstrumentMode(engine: AudioEngine, mode: InstrumentMode): void {
  engine.instrumentMode = mode;
}
