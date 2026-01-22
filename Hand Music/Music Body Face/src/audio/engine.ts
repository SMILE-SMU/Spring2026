/**
 * Audio engine for Music Body Face using Tone.js
 * Implements attack-sustain-release sample playback with crossfade looping
 */

import * as Tone from "tone";

// Debug logging (set to false to silence)
const DEBUG_AUDIO = true;

// Reverb enable (tied to visual trail length mapping in App). Toggle for debugging.
const ENABLE_REVERB = true;
// Wah enable (filter cutoff follows hand openness). Disable to isolate vibrato.
const ENABLE_WAH = true;
// Vibrato enable (Tone.PitchShift driven by hand motion). Disable to isolate other issues.
const ENABLE_VIBRATO = true;

// Stable IDs for engines + source nodes for readable logs
let nextEngineId = 1;
const engineIds = new WeakMap<object, number>();
function engineId(engine: object): number {
  const existing = engineIds.get(engine);
  if (existing) return existing;
  const id = nextEngineId++;
  engineIds.set(engine, id);
  return id;
}

let nextSourceId = 1;
const sourceIds = new WeakMap<AudioBufferSourceNode, number>();
function sourceId(node: AudioBufferSourceNode | null): string {
  if (!node) return "∅";
  const existing = sourceIds.get(node);
  if (existing) return String(existing);
  const id = nextSourceId++;
  sourceIds.set(node, id);
  return String(id);
}

function attachEndedCleanup(engine: AudioEngine, node: AudioBufferSourceNode, slot: "sourceNode" | "sourceNode2"): void {
  // Only set this if nothing else already owns onended (ASR sources).
  // For one-shot sources we override onended elsewhere.
  if (node.onended) return;
  node.onended = () => {
    if (DEBUG_AUDIO) dlog(engine, `source ended (src=${sourceId(node)})`);
    if (slot === "sourceNode" && engine.sourceNode === node) engine.sourceNode = null;
    if (slot === "sourceNode2" && engine.sourceNode2 === node) engine.sourceNode2 = null;
  };
}

function debugState(engine: AudioEngine): Record<string, unknown> {
  return {
    id: engineId(engine as unknown as object),
    playState: engine.playState,
    isRunning: engine.isRunning,
    isLoaded: engine.isLoaded,
    useASR: engine.useASR,
    currentSample: engine.currentSample,
    activeSource: engine.activeSource,
    loopSchedulerId: engine.loopSchedulerId,
    src1: sourceId(engine.sourceNode),
    src2: sourceId(engine.sourceNode2),
    g1: engine.sourceGain1 ? Number(engine.sourceGain1.gain.value.toFixed(3)) : null,
    g2: engine.sourceGain2 ? Number(engine.sourceGain2.gain.value.toFixed(3)) : null,
  };
}

function dlog(engine: AudioEngine, message: string, extra?: Record<string, unknown>): void {
  if (!DEBUG_AUDIO) return;
  // Keep it compact + searchable
  console.log(`[audio#${engineId(engine as unknown as object)}] ${message}`, extra ?? debugState(engine));
}

// Playback states
type PlayState = "idle" | "attack" | "sustain" | "release";

export type ArticulationLayer = "soft" | "medium" | "hard";
export type InstrumentMode = "brass" | "strings";
export type PitchMode = "low" | "mid" | "high" | "all";
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
  reverb: Tone.JCReverb | null;
  gain: Tone.Gain | null; // dry gain (note amplitude)
  wetGain: Tone.Gain | null; // wet gain (reverb level, not tied to dry)
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
  pitchMode: PitchMode; // low/mid/high pitch mapping bands
  lastReverbDecay: number; // seconds
  lastReverbUpdateAt: number; // Tone.now() seconds
  isReverbGenerating: boolean;
}

export interface AudioParams {
  pitchShift: number;
  gain: number;
  filterCutoff: number; // 0-1, maps to frequency range for wah effect
  delayTime: number; // 0-1, maps to delay time (0 = no delay, 1 = max delay)
  feedback: number; // 0-1, maps to feedback amount
  reverbMix: number; // 0-0.75 (wet)
  reverbDecay: number; // seconds (tail length), typically <= 6
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
// Flattened, sorted sample lists for deterministic pitch mapping
let samplesByGroupSorted: Map<SampleGroup, SampleInfo[]> = new Map();
let brassSamplesByGroupAndLayerSorted: Map<string, SampleInfo[]> = new Map();
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

    // Build flattened, sorted lists (for mapping hand Y -> closest pitch)
    samplesByGroupSorted = new Map();
    brassSamplesByGroupAndLayerSorted = new Map();

    for (const [group, groupMap] of samplesByGroupAndOctave.entries()) {
      const flat: SampleInfo[] = Array.from(groupMap.values()).flat();
      flat.sort((a, b) => a.midiNote - b.midiNote);
      samplesByGroupSorted.set(group, flat);

      if (group.startsWith("brass:")) {
        for (const layer of ["soft", "medium", "hard"] as const) {
          const layered = flat.filter((s) => s.layer === layer);
          const key = `${group}:${layer}`;
          // If a layer is missing (shouldn't happen), fall back to all samples.
          brassSamplesByGroupAndLayerSorted.set(key, layered.length > 0 ? layered : flat);
        }
      }
    }
    
    samplesLoaded = true;
  } catch (err) {
    console.error("Failed to load sample manifest:", err);
  }
}

/**
 * Get a sample based on hand Y position and articulation layer.
 * Maps hand position to a TARGET PITCH, then picks the closest sample pitch.
 * handY is normalized screen Y: 0 = top (highest pitch), 1 = bottom (lowest pitch).
 */
function getSampleByPitchGroupAndLayer(
  handY: number,
  group: SampleGroup,
  layer: ArticulationLayer,
  pitchMode: PitchMode
): string {
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
  const pitchPosition = 1 - clamp01(handY); // 0 = lowest, 1 = highest

  let candidates =
    group.startsWith("brass:")
      ? (brassSamplesByGroupAndLayerSorted.get(`${group}:${layer}`) ?? [])
      : (samplesByGroupSorted.get(group) ?? []);

  if (candidates.length === 0) {
    // Fallbacks (must exist locally)
    if (group === "strings:cello") return "/audio/Cello Soft/Cello softC3.wav";
    if (group === "strings:viola") return "/audio/Viola Soft/Viola Soft C4.wav";
    return "/audio/Trombone/Standard/Medium Layer/TB Med A3.wav";
  }

  // Apply pitch mode filtering so each mode uses the full hand Y range.
  // - Brass (trombone): prefer octave-based split if we have 3+ distinct octaves.
  // - Strings: split into 3 even groups of unique pitches (MIDI notes).
  const applyPitchMode = (list: SampleInfo[], mode: PitchMode): SampleInfo[] => {
    if (list.length === 0) return list;
    if (mode === "all") return list;

    // Brass: octave mapping (low=lowest octave, mid=median octave, high=highest octave)
    if (group.startsWith("brass:")) {
      const octaves = Array.from(new Set(list.map((s) => s.octave))).sort((a, b) => a - b);
      if (octaves.length >= 3) {
        const lowOct = octaves[0];
        const highOct = octaves[octaves.length - 1];
        const midOct = octaves[Math.floor(octaves.length / 2)];
        const targetOct = mode === "low" ? lowOct : mode === "high" ? highOct : midOct;
        const filtered = list.filter((s) => s.octave === targetOct);
        return filtered.length > 0 ? filtered : list;
      }
      // Fall back to generic 3-way split if octave info isn't useful.
    }

    // Generic: split unique pitches into 3 even bands
    const uniqueMidi = Array.from(new Set(list.map((s) => s.midiNote))).sort((a, b) => a - b);
    if (uniqueMidi.length <= 2) return list;

    const base = Math.floor(uniqueMidi.length / 3);
    const rem = uniqueMidi.length % 3;
    const lowCount = base + (rem > 0 ? 1 : 0);
    const midCount = base + (rem > 1 ? 1 : 0);
    const lowEnd = lowCount; // exclusive
    const midEnd = lowCount + midCount; // exclusive

    const lowSet = new Set(uniqueMidi.slice(0, lowEnd));
    const midSet = new Set(uniqueMidi.slice(lowEnd, midEnd));
    const highSet = new Set(uniqueMidi.slice(midEnd));

    const allowed =
      mode === "low" ? lowSet :
      mode === "high" ? highSet :
      midSet;

    const filtered = list.filter((s) => allowed.has(s.midiNote));
    return filtered.length > 0 ? filtered : list;
  };

  candidates = applyPitchMode(candidates, pitchMode);
  
  const minMidi = candidates[0].midiNote;
  const maxMidi = candidates[candidates.length - 1].midiNote;
  const targetMidi = Math.round(minMidi + pitchPosition * (maxMidi - minMidi));

  // Binary search for insertion point
  let lo = 0;
  let hi = candidates.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const m = candidates[mid].midiNote;
    if (m === targetMidi) {
      lo = mid;
      break;
    }
    if (m < targetMidi) lo = mid + 1;
    else hi = mid - 1;
  }

  const rightIdx = Math.min(Math.max(lo, 0), candidates.length - 1);
  const leftIdx = Math.max(rightIdx - 1, 0);

  const leftMidi = candidates[leftIdx].midiNote;
  const rightMidi = candidates[rightIdx].midiNote;
  const leftDist = Math.abs(leftMidi - targetMidi);
  const rightDist = Math.abs(rightMidi - targetMidi);

  const chosenMidi =
    leftDist < rightDist ? leftMidi :
    rightDist < leftDist ? rightMidi :
    // Tie: pick either side (adds tiny variety but same pitch neighborhood)
    (Math.random() < 0.5 ? leftMidi : rightMidi);

  // If multiple samples share the same pitch, pick one at random among them.
  let start = leftIdx;
  while (start > 0 && candidates[start - 1].midiNote === chosenMidi) start--;
  let end = rightIdx;
  while (end < candidates.length - 1 && candidates[end + 1].midiNote === chosenMidi) end++;

  const pickIdx = start + Math.floor(Math.random() * (end - start + 1));
  return candidates[pickIdx].path;
}

// Loop point percentages (of total duration) - tighter loop region
const LOOP_START_PERCENT = 0.30; // Start looping at 30% into sample
const LOOP_END_PERCENT = 0.70; // Loop back before 70% of sample

// Crossfade duration in seconds
const CROSSFADE_DURATION = 0.15;
// When retriggering during a release tail, allow a brief overlap
const RETRIGGER_CROSSFADE_DURATION = 0.12;

// Fade out duration when stopping (prevents clicks)
const FADE_OUT_DURATION = 0.1;
// Tiny de-click fade when force-stopping an active source
const DECLICK_STOP_DURATION = 0.01;

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
    reverb: null,
    gain: null,
    wetGain: null,
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
    pitchMode: "mid",
    lastReverbDecay: 1,
    lastReverbUpdateAt: 0,
    isReverbGenerating: false,
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

  // Create output chain:
  // sources -> pitchShift -> filter -> dryGain -> volume -> limiter -> dest
  // and optionally filter -> reverb(100% wet) -> wetGain -> volume
  // Limiter at -3dB gives more headroom and less aggressive limiting
  const limiter = new Tone.Limiter(-3).toDestination();
  // Reduced volume boost (was +12dB) - with two hands playing, this prevents summing distortion
  const volume = new Tone.Volume(6).connect(limiter);
  const dryGain = new Tone.Gain(0).connect(volume);
  const wetGain = ENABLE_REVERB ? new Tone.Gain(0).connect(volume) : null;
  // Use JCReverb (algorithmic) so "tail length" can change continuously without
  // regenerating an impulse response (Tone.Reverb.generate()).
  const reverb = ENABLE_REVERB
    ? new Tone.JCReverb({
        roomSize: 0.2,
        wet: 1, // fully wet; mix handled by wetGain
      }).connect(wetGain!)
    : null;
  
  // Feedback delay for echo effect (DISABLED for now)
  const delay = new Tone.FeedbackDelay({
    delayTime: DELAY_MIN_TIME, // Start with minimal delay
    feedback: 0, // Feedback disabled - no repeating echoes
    wet: 0, // DISABLED - set to 0 to bypass delay
    maxDelay: DELAY_MAX_TIME + 0.5, // Buffer for max delay
  }).connect(dryGain);
  
  // Lowpass filter for wah effect - feed both dry + reverb
  const filter = new Tone.Filter({
    type: "lowpass",
    frequency: FILTER_MAX_FREQ, // Start open
    Q: FILTER_Q,
    rolloff: -24, // Steeper rolloff for more pronounced effect
  });
  filter.connect(dryGain); // bypass delay for now
  if (ENABLE_REVERB) {
    filter.connect(reverb!);
  }
  
  const pitchShift = new Tone.PitchShift({
    pitch: 0,
    // Larger window + tiny delay makes modulation smoother/less grainy
    // (at the cost of a bit more latency).
    windowSize: 0.08,
    delayTime: 0.01,
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
  engine.reverb = reverb;
  engine.gain = dryGain;
  engine.wetGain = wetGain;
  engine.limiter = limiter;
  engine.volume = volume;
  engine.sourceGain1 = sourceGain1;
  engine.sourceGain2 = sourceGain2;
  engine.isRunning = true;
  engine.lastReverbDecay = 1;
  engine.lastReverbUpdateAt = Tone.now();
  engine.isReverbGenerating = false;

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

  const samplePath = getSampleByPitchGroupAndLayer(engine.lastHandY, group, engine.currentLayer, engine.pitchMode);
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
  engine.reverb?.dispose();
  engine.gain?.dispose();
  engine.wetGain?.dispose();
  engine.volume?.dispose();
  engine.limiter?.dispose();
  engine.sourceGain1?.disconnect();
  engine.sourceGain2?.disconnect();

  engine.buffer = null;
  engine.pitchShift = null;
  engine.filter = null;
  engine.reverb = null;
  engine.gain = null;
  engine.wetGain = null;
  engine.volume = null;
  engine.limiter = null;
  engine.sourceGain1 = null;
  engine.sourceGain2 = null;
  engine.isRunning = false;
  engine.isLoaded = false;
  engine.currentSample = null;
  engine.playState = "idle";
}

function stopCurrentSound(engine: AudioEngine, fade: boolean = true): void {
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
    // Stop immediately (still try to de-click quickly)
    if (engine.sourceGain1) {
      engine.sourceGain1.gain.setValueAtTime(engine.sourceGain1.gain.value, now);
      engine.sourceGain1.gain.linearRampToValueAtTime(0, now + DECLICK_STOP_DURATION);
    }
    if (engine.sourceGain2) {
      engine.sourceGain2.gain.setValueAtTime(engine.sourceGain2.gain.value, now);
      engine.sourceGain2.gain.linearRampToValueAtTime(0, now + DECLICK_STOP_DURATION);
    }
    setTimeout(() => {
      stopSourceNodes(engine);
    }, DECLICK_STOP_DURATION * 1000 + 20);
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

function safeStopAndDisconnect(node: AudioBufferSourceNode): void {
  // Do NOT touch lane gain automation here: during crossfading the same gain nodes
  // get reused quickly, and cancelling/ramping can mute the currently-active lane.
  // We only stop/disconnect; crossfades already ramp gains to 0 before cleanup.
  try {
    node.stop();
    node.disconnect();
  } catch (e) {
    // Already stopped
  }
}

// Create and start a new source node
function createSource(engine: AudioEngine, startOffset: number, gainNode: GainNode, when: number = 0): AudioBufferSourceNode {
  const ctx = Tone.getContext().rawContext;
  const source = ctx.createBufferSource();
  source.buffer = engine.buffer!;
  source.connect(gainNode);
  source.start(when, startOffset);
  // Tag for debugging
  sourceId(source);
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
    const old = engine.sourceNode;
    const oldId = sourceId(old);
    engine.sourceNode2 = createSource(engine, engine.loopStart, engine.sourceGain2);
    attachEndedCleanup(engine, engine.sourceNode2, "sourceNode2");
    dlog(engine, `crossfade 1→2 (old=${oldId}, new=${sourceId(engine.sourceNode2)})`);
    
    engine.sourceGain1.gain.setValueAtTime(1, now);
    engine.sourceGain1.gain.linearRampToValueAtTime(0, now + CROSSFADE_DURATION);
    engine.sourceGain2.gain.setValueAtTime(0, now);
    engine.sourceGain2.gain.linearRampToValueAtTime(1, now + CROSSFADE_DURATION);
    
    // Stop old source after crossfade
    setTimeout(() => {
      if (old) {
        safeStopAndDisconnect(old);
        if (DEBUG_AUDIO) dlog(engine, `crossfade cleanup stopped src1=${sourceId(old)}`);
        if (engine.sourceNode === old) engine.sourceNode = null;
      }
    }, CROSSFADE_DURATION * 1000 + 50);
    
    engine.activeSource = 2;
  } else {
    // Fade out source 2, fade in source 1
    const old = engine.sourceNode2;
    const oldId = sourceId(old);
    engine.sourceNode = createSource(engine, engine.loopStart, engine.sourceGain1);
    attachEndedCleanup(engine, engine.sourceNode, "sourceNode");
    dlog(engine, `crossfade 2→1 (old=${oldId}, new=${sourceId(engine.sourceNode)})`);
    
    engine.sourceGain2.gain.setValueAtTime(1, now);
    engine.sourceGain2.gain.linearRampToValueAtTime(0, now + CROSSFADE_DURATION);
    engine.sourceGain1.gain.setValueAtTime(0, now);
    engine.sourceGain1.gain.linearRampToValueAtTime(1, now + CROSSFADE_DURATION);
    
    // Stop old source after crossfade
    setTimeout(() => {
      if (old) {
        safeStopAndDisconnect(old);
        if (DEBUG_AUDIO) dlog(engine, `crossfade cleanup stopped src2=${sourceId(old)}`);
        if (engine.sourceNode2 === old) engine.sourceNode2 = null;
      }
    }, CROSSFADE_DURATION * 1000 + 50);
    
    engine.activeSource = 1;
  }
  
  // Schedule next loop
  scheduleNextLoop(engine);
}

// Start playing the sample (attack phase)
export function triggerAttack(engine: AudioEngine): void {
  if (DEBUG_AUDIO) dlog(engine, "attack() called");
  if (!engine.isRunning || !engine.isLoaded || !engine.buffer || !engine.sourceGain1) {
    dlog(engine, "Cannot trigger attack - not ready");
    return;
  }

  // If the user re-opens the hand during a release tail, retrigger with a short overlap.
  // Important constraints:
  // - Do NOT leave any untracked playing sources.
  // - Do NOT let releaseSource.onended load a new sample mid-note.
  if (engine.playState === "release" && engine.useASR && engine.sourceGain2) {
    dlog(engine, "Attack requested during release; retrigger with short crossfade (v2)");

    // Cancel any scheduled loop (release already does this, but be safe).
    if (engine.loopSchedulerId !== null) {
      clearTimeout(engine.loopSchedulerId);
      engine.loopSchedulerId = null;
    }

    const ctx = Tone.getContext().rawContext;
    const now = ctx.currentTime;
    const stopAt = now + DECLICK_STOP_DURATION;

    // In release, the "release tail" lives on the inactive lane.
    const attackLaneIndex: 1 | 2 = engine.activeSource;
    const releaseLaneIndex: 1 | 2 = engine.activeSource === 1 ? 2 : 1;

    const attackGain = attackLaneIndex === 1 ? engine.sourceGain1 : engine.sourceGain2!;
    const releaseGain = releaseLaneIndex === 1 ? engine.sourceGain1 : engine.sourceGain2!;
    const attackSlot: "sourceNode" | "sourceNode2" = attackLaneIndex === 1 ? "sourceNode" : "sourceNode2";
    const releaseSlot: "sourceNode" | "sourceNode2" = releaseLaneIndex === 1 ? "sourceNode" : "sourceNode2";

    // Capture the current release tail source (if any) so we can fade+stop it after overlap.
    const releaseSource = engine[releaseSlot];

    // Stop anything currently on the attack lane (old note's current lane).
    const oldAttack = engine[attackSlot];
    if (oldAttack) {
      // De-click: ramp the lane gain down briefly, then stop.
      attackGain.gain.cancelScheduledValues(now);
      attackGain.gain.setValueAtTime(attackGain.gain.value, now);
      attackGain.gain.linearRampToValueAtTime(0, stopAt);
      setTimeout(() => {
        safeStopAndDisconnect(oldAttack);
        if (engine[attackSlot] === oldAttack) engine[attackSlot] = null;
      }, DECLICK_STOP_DURATION * 1000 + 20);
    }

    // Cancel old gain automation and set explicit start values.
    releaseGain.gain.cancelScheduledValues(now);
    // New attack fades in from 0.
    attackGain.gain.setValueAtTime(0, stopAt);
    // Release lane starts at whatever it is right now.
    releaseGain.gain.setValueAtTime(releaseGain.gain.value, now);

    // Start the new note on the attack lane.
    const newSource = createSource(engine, 0, attackGain, stopAt);
    engine[attackSlot] = newSource;
    attachEndedCleanup(engine, newSource, attackSlot);

    // Short overlap crossfade: release down, attack up.
    attackGain.gain.linearRampToValueAtTime(1, stopAt + RETRIGGER_CROSSFADE_DURATION);
    releaseGain.gain.linearRampToValueAtTime(0, stopAt + RETRIGGER_CROSSFADE_DURATION);

    // Stop the release tail after overlap, if it exists.
    if (releaseSource) {
      setTimeout(() => {
        safeStopAndDisconnect(releaseSource);
        if (engine[releaseSlot] === releaseSource) engine[releaseSlot] = null;
        dlog(engine, `retrigger cleanup stopped release src=${sourceId(releaseSource)}`);
      }, RETRIGGER_CROSSFADE_DURATION * 1000 + 50);
    }

    // Start the normal ASR scheduling for the new note.
    engine.playState = "attack";
    const timeToLoop = engine.loopStart * 1000;
    setTimeout(() => {
      if (engine.playState === "attack") {
        dlog(engine, "🔄 SUSTAIN - starting crossfade loop");
        engine.playState = "sustain";

        const loopDuration = engine.loopEnd - engine.loopStart;
        const timeUntilCrossfade = (loopDuration - CROSSFADE_DURATION) * 1000;
        engine.loopSchedulerId = window.setTimeout(() => {
          if (engine.playState === "sustain") {
            performCrossfade(engine);
          }
        }, timeUntilCrossfade);
      }
    }, timeToLoop);

    return;
  }
  
  // Check if we're actually playing (sourceNode exists and is active)
  // If playState is not idle but no source is playing, reset to idle
  if (engine.playState !== "idle") {
    const hasActiveSource = engine.sourceNode !== null || engine.sourceNode2 !== null;
    if (!hasActiveSource) {
      dlog(engine, "State was stuck (no active source), resetting to idle");
      engine.playState = "idle";
    } else {
      // If sources exist but both crossfade lanes are effectively silent,
      // allow a new attack instead of "open hand -> nothing".
      const g1 = engine.sourceGain1 ? engine.sourceGain1.gain.value : 0;
      const g2 = engine.sourceGain2 ? engine.sourceGain2.gain.value : 0;
      const lanesSilent = g1 < 0.001 && g2 < 0.001;
      if (lanesSilent) {
        dlog(engine, "State looked stuck (silent lanes), forcing reset to idle");
        stopCurrentSound(engine, true);
        engine.playState = "idle";
      } else {
        dlog(engine, "Already playing, ignoring attack");
        return;
      }
    }
  }

  if (engine.useASR) {
    // Long sample: ASR mode with crossfade looping
    dlog(engine, "🎹 ATTACK (ASR) - starting sample");
    
    // Reset gains
    engine.sourceGain1.gain.value = 1;
    engine.sourceGain2!.gain.value = 0;
    engine.activeSource = 1;
    
    // Start from beginning
    engine.sourceNode = createSource(engine, 0, engine.sourceGain1);
    attachEndedCleanup(engine, engine.sourceNode, "sourceNode");
    engine.playState = "attack";
    
    // Schedule transition to sustain when we reach loop start
    const timeToLoop = engine.loopStart * 1000;
    setTimeout(() => {
      if (engine.playState === "attack") {
        dlog(engine, "🔄 SUSTAIN - starting crossfade loop");
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
    dlog(engine, "🎹 PLAY (one-shot) - starting sample");
    
    engine.sourceGain1.gain.value = 1;
    engine.sourceNode = createSource(engine, 0, engine.sourceGain1);
    engine.playState = "sustain";
    
    // When sample ends naturally, go back to idle and load new sample
    engine.sourceNode.onended = async () => {
      // clear tracked source
      if (engine.sourceNode) engine.sourceNode = null;
      if (engine.playState !== "idle") {
        dlog(engine, "Short sample ended naturally, loading new sample");
        engine.playState = "idle";
        await loadNewSample(engine);
      }
    };
  }
}

// Release the sample (play through to end for ASR, fade out for one-shot)
export function triggerRelease(engine: AudioEngine): void {
  if (DEBUG_AUDIO) dlog(engine, "release() called");
  if (!engine.isRunning || !engine.buffer) {
    return;
  }
  
  if (engine.playState === "idle" || engine.playState === "release") {
    return;
  }

  if (engine.useASR && engine.sourceGain1 && engine.sourceGain2) {
    // Long sample: ASR mode - crossfade to release portion
    dlog(engine, "🎹 RELEASE (ASR) - crossfading to ending");
    
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
    const oldSource = engine.activeSource === 1 ? engine.sourceNode : engine.sourceNode2;
    
    releaseSource.connect(releaseGain);
    releaseSource.start(0, engine.loopEnd); // Start from release portion

    // Track the release source on the engine so we don't get "stuck in release"
    // with no tracked active source (which can cause silent "Already playing").
    if (engine.activeSource === 1) {
      engine.sourceNode2 = releaseSource;
      sourceId(releaseSource);
    } else {
      engine.sourceNode = releaseSource;
      sourceId(releaseSource);
    }
    
    // Crossfade: fade out current, fade in release.
    // IMPORTANT: cancel any in-flight gain automation (e.g. if user closes during a loop crossfade),
    // otherwise competing ramps can cause audible hitches.
    currentGain.gain.cancelScheduledValues(now);
    releaseGain.gain.cancelScheduledValues(now);
    currentGain.gain.setValueAtTime(currentGain.gain.value, now);
    currentGain.gain.linearRampToValueAtTime(0, now + CROSSFADE_DURATION);
    releaseGain.gain.setValueAtTime(0, now);
    releaseGain.gain.linearRampToValueAtTime(1, now + CROSSFADE_DURATION);
    
    // Stop current source after crossfade
    setTimeout(() => {
      if (!oldSource) return;
      safeStopAndDisconnect(oldSource);
      if (DEBUG_AUDIO) dlog(engine, `release cleanup stopped old=${sourceId(oldSource)}`);
      if (engine.sourceNode === oldSource) engine.sourceNode = null;
      if (engine.sourceNode2 === oldSource) engine.sourceNode2 = null;
    }, CROSSFADE_DURATION * 1000 + 50);
    
    // When release portion ends:
    // - Always clear the tracked slot for this release source
    // - Only load the next sample if we're still in release state
    const releaseDuration = engine.buffer.duration - engine.loopEnd;
    releaseSource.onended = async () => {
      // Always clear tracked slots if they still point at this node
      if (engine.sourceNode === releaseSource) engine.sourceNode = null;
      if (engine.sourceNode2 === releaseSource) engine.sourceNode2 = null;
      dlog(engine, `release source ended src=${sourceId(releaseSource)}`);
      if (engine.playState === "release") {
        dlog(engine, "Release ended, loading new sample");
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
    dlog(engine, "🎹 STOP (one-shot) - fading out");
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

  // Pitch shift (used for velocity-driven vibrato)
  if (engine.pitchShift) {
    const target = ENABLE_VIBRATO ? params.pitchShift : 0;
    // Smooth parameter changes to reduce "steppy" / glitchy artifacts.
    // Tone's PitchShift.pitch is a Signal in practice, but keep this defensive.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p: any = (engine.pitchShift as any).pitch;
    if (p && typeof p.rampTo === "function") {
      p.rampTo(target, 0.03);
    } else {
      engine.pitchShift.pitch = target;
    }
  }

  // Update gain - slightly slower ramp to reduce jitter/pops
  engine.gain.gain.rampTo(params.gain, 0.015);
  
  // Update filter cutoff for wah effect
  if (engine.filter) {
    if (ENABLE_WAH) {
      const cutoff = FILTER_MIN_FREQ * Math.pow(FILTER_MAX_FREQ / FILTER_MIN_FREQ, params.filterCutoff);
      engine.filter.frequency.rampTo(cutoff, 0.008); // Fast ramp
    } else {
      // Keep filter fully open so it has no audible "wah" behavior.
      engine.filter.frequency.rampTo(FILTER_MAX_FREQ, 0.02);
    }
  }
  
  // Update delay parameters (delay is currently bypassed)
  if (engine.delay && engine.delay.wet.value > 0) {
    const delayTime = DELAY_MIN_TIME + Math.pow(params.delayTime, 3) * (DELAY_MAX_TIME - DELAY_MIN_TIME);
    engine.delay.delayTime.rampTo(delayTime, 0.1);
  }

  // Update reverb (mix + tail length)
  if (ENABLE_REVERB && engine.reverb && engine.wetGain) {
    const wet = Math.max(0, Math.min(0.75, params.reverbMix));
    engine.wetGain.gain.rampTo(wet, 0.05);

    // Map requested "decay seconds" onto JCReverb roomSize (0..1).
    // This isn't a 1:1 seconds mapping, but it tracks the gesture continuously.
    const desiredDecay = Math.max(0.3, Math.min(6.0, params.reverbDecay));
    const x = (desiredDecay - 0.3) / (6.0 - 0.3);
    const room = 0.05 + 0.95 * x;
    // roomSize is a Signal; ramp to avoid zipper noise.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rs: any = (engine.reverb as any).roomSize;
    if (rs && typeof rs.rampTo === "function") rs.rampTo(room, 0.12);
    else if (rs && typeof rs.value === "number") rs.value = room;
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

// Update pitch mode banding (low/mid/high)
export function setPitchMode(engine: AudioEngine, mode: PitchMode): void {
  engine.pitchMode = mode;
}
