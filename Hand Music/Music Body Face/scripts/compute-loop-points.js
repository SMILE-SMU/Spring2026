#!/usr/bin/env node
/**
 * Pre-compute loop points for all audio samples and save to manifest.
 * This eliminates the ~20-50ms findOptimalLoopPoints() call at runtime.
 *
 * Run with: node scripts/compute-loop-points.js
 */

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = join(__dirname, '..', 'static');
const MANIFEST_PATH = join(STATIC_DIR, 'audio', 'manifest.json');
const OUTPUT_PATH = join(STATIC_DIR, 'audio', 'manifest-with-loops.json');

// Loop point parameters (must match engine.ts)
const LOOP_START_PERCENT = 0.30;
const LOOP_END_PERCENT = 0.70;
const LOOP_SEARCH_WINDOW = 0.15;
const RMS_WINDOW = 0.03;
const MAX_RMS_DIFF = 0.05;
const MIN_LOOP_LENGTH = 0.4;
const MAX_LOOP_LENGTH = 4.0;
const ASR_MIN_DURATION = 0.5;

// We need a WAV decoder - use the built-in Web Audio API via a minimal decoder
// For Node.js, we'll use a simple WAV parser

function parseWavHeader(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  // Check RIFF header
  const riff = String.fromCharCode(buffer[0], buffer[1], buffer[2], buffer[3]);
  if (riff !== 'RIFF') throw new Error('Not a WAV file');

  const wave = String.fromCharCode(buffer[8], buffer[9], buffer[10], buffer[11]);
  if (wave !== 'WAVE') throw new Error('Not a WAV file');

  // Find fmt chunk
  let offset = 12;
  let sampleRate = 44100;
  let numChannels = 1;
  let bitsPerSample = 16;
  let dataOffset = 0;
  let dataSize = 0;

  while (offset < buffer.length - 8) {
    const chunkId = String.fromCharCode(buffer[offset], buffer[offset+1], buffer[offset+2], buffer[offset+3]);
    const chunkSize = view.getUint32(offset + 4, true);

    if (chunkId === 'fmt ') {
      numChannels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
      bitsPerSample = view.getUint16(offset + 22, true);
    } else if (chunkId === 'data') {
      dataOffset = offset + 8;
      dataSize = chunkSize;
      break;
    }

    offset += 8 + chunkSize;
    if (chunkSize % 2 !== 0) offset++; // Padding byte
  }

  if (dataOffset === 0) throw new Error('No data chunk found');

  return { sampleRate, numChannels, bitsPerSample, dataOffset, dataSize };
}

function extractChannelData(buffer, header) {
  const { sampleRate, numChannels, bitsPerSample, dataOffset, dataSize } = header;
  const bytesPerSample = bitsPerSample / 8;
  const numSamples = Math.floor(dataSize / (bytesPerSample * numChannels));
  const channelData = new Float32Array(numSamples);

  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  for (let i = 0; i < numSamples; i++) {
    const sampleOffset = dataOffset + i * bytesPerSample * numChannels;
    let sample;

    if (bitsPerSample === 16) {
      sample = view.getInt16(sampleOffset, true) / 32768;
    } else if (bitsPerSample === 24) {
      // 24-bit samples need manual handling
      const b0 = buffer[sampleOffset];
      const b1 = buffer[sampleOffset + 1];
      const b2 = buffer[sampleOffset + 2];
      sample = ((b2 << 16) | (b1 << 8) | b0) / 8388608;
      if (sample > 1) sample -= 2;
    } else if (bitsPerSample === 32) {
      sample = view.getFloat32(sampleOffset, true);
    } else {
      sample = (buffer[sampleOffset] - 128) / 128; // 8-bit
    }

    channelData[i] = sample;
  }

  return { channelData, sampleRate, duration: numSamples / sampleRate };
}

function calculateRMS(channelData, centerSample, windowSamples) {
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

function findOptimalLoopPoints(channelData, sampleRate, duration) {
  const targetStart = duration * LOOP_START_PERCENT;
  const targetEnd = duration * LOOP_END_PERCENT;

  const targetStartSample = Math.floor(targetStart * sampleRate);
  const targetEndSample = Math.floor(targetEnd * sampleRate);
  const searchWindowSamples = Math.floor(LOOP_SEARCH_WINDOW * sampleRate);
  const rmsWindowSamples = Math.floor(RMS_WINDOW * sampleRate);

  const startMin = Math.max(rmsWindowSamples, targetStartSample - searchWindowSamples);
  const startMax = Math.min(channelData.length - rmsWindowSamples - 1, targetStartSample + searchWindowSamples);
  const endMin = Math.max(rmsWindowSamples, targetEndSample - searchWindowSamples);
  const endMax = Math.min(channelData.length - rmsWindowSamples - 1, targetEndSample + searchWindowSamples);

  const step = Math.floor(sampleRate * 0.002);

  const startCandidates = [];
  for (let s = startMin; s <= startMax; s += step) {
    startCandidates.push({
      sample: s,
      rms: calculateRMS(channelData, s, rmsWindowSamples),
    });
  }

  const endCandidates = [];
  for (let e = endMin; e <= endMax; e += step) {
    endCandidates.push({
      sample: e,
      rms: calculateRMS(channelData, e, rmsWindowSamples),
    });
  }

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

  const avgRMS = (bestMatch.startRMS + bestMatch.endRMS) / 2;
  const normalizedRmsDiff = avgRMS > 0 ? bestMatch.rmsDiff / avgRMS : bestMatch.rmsDiff;

  const isAcceptable =
    normalizedRmsDiff <= MAX_RMS_DIFF &&
    loopLength >= MIN_LOOP_LENGTH &&
    loopLength <= MAX_LOOP_LENGTH;

  return {
    loopStart: Math.round(loopStart * 1000) / 1000, // Round to ms precision
    loopEnd: Math.round(loopEnd * 1000) / 1000,
    rmsDiff: Math.round(normalizedRmsDiff * 1000) / 1000,
    isAcceptable,
    useASR: duration >= ASR_MIN_DURATION,
  };
}

async function processFile(filePath) {
  try {
    const buffer = await readFile(filePath);
    const header = parseWavHeader(buffer);
    const { channelData, sampleRate, duration } = extractChannelData(buffer, header);

    if (duration < ASR_MIN_DURATION) {
      return { useASR: false, duration: Math.round(duration * 1000) / 1000 };
    }

    const result = findOptimalLoopPoints(channelData, sampleRate, duration);
    return { ...result, duration: Math.round(duration * 1000) / 1000 };
  } catch (err) {
    console.error(`Error processing ${filePath}:`, err.message);
    return null;
  }
}

async function main() {
  console.log('Loading manifest...');
  const manifestData = await readFile(MANIFEST_PATH, 'utf-8');
  const manifest = JSON.parse(manifestData);

  const extendedManifest = {
    files: {},
    loopPoints: {},
  };

  // Copy original file lists
  extendedManifest.files = { ...manifest };

  let totalFiles = 0;
  let processedFiles = 0;
  let acceptableLoops = 0;

  // Count total files
  for (const folder of Object.keys(manifest)) {
    totalFiles += manifest[folder].length;
  }

  console.log(`Processing ${totalFiles} files...`);

  for (const folder of Object.keys(manifest)) {
    const files = manifest[folder];

    for (const file of files) {
      const filePath = join(STATIC_DIR, 'audio', folder, file);
      const samplePath = `/audio/${folder}/${file}`;

      if (!existsSync(filePath)) {
        console.warn(`  File not found: ${filePath}`);
        continue;
      }

      const result = await processFile(filePath);
      processedFiles++;

      if (result) {
        extendedManifest.loopPoints[samplePath] = result;
        if (result.isAcceptable) acceptableLoops++;

        const status = result.useASR ? (result.isAcceptable ? '✓' : '✗') : '○';
        process.stdout.write(`\r  [${processedFiles}/${totalFiles}] ${status} ${file.substring(0, 30).padEnd(30)}`);
      }
    }
  }

  console.log('\n');
  console.log(`Processed: ${processedFiles}/${totalFiles} files`);
  console.log(`Acceptable loops: ${acceptableLoops}/${processedFiles} (${Math.round(acceptableLoops/processedFiles*100)}%)`);

  // Write extended manifest
  await writeFile(OUTPUT_PATH, JSON.stringify(extendedManifest, null, 2));
  console.log(`\nWritten to: ${OUTPUT_PATH}`);
}

main().catch(console.error);
