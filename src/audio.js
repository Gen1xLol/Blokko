import lameUrl from "lamejs/lame.all.js?url";

let encoderPromise;

export async function convertWav(bytes, expectedSamples = 0, bitrate = 192) {
  const AudioContextType = window.AudioContext || window.webkitAudioContext;
  const OfflineAudioContextType =
    window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!AudioContextType || !OfflineAudioContextType)
    throw new Error("audio conversion is not supported in this browser (boo!)");
  const context = new AudioContextType();
  try {
    const sampleRate = 44100;
    const decoded = decodeWav(bytes);
    const decodedCount =
      expectedSamples > 0
        ? Math.min(expectedSamples, decoded.sampleCount)
        : decoded.sampleCount;
    const sourceBuffer = context.createBuffer(
      decoded.channels.length,
      decodedCount,
      decoded.sampleRate,
    );
    decoded.channels.forEach((channel, index) =>
      sourceBuffer.copyToChannel(channel.subarray(0, decodedCount), index),
    );
    const offline = new OfflineAudioContextType(
      2,
      Math.ceil((decodedCount / decoded.sampleRate) * sampleRate),
      sampleRate,
    );
    const source = offline.createBufferSource();
    source.buffer = sourceBuffer;
    source.connect(offline.destination);
    source.start(0);
    const stereo = await offline.startRendering();
    const lamejs = await loadEncoder();
    const encoder = new lamejs.Mp3Encoder(2, sampleRate, bitrate);
    const left = toInt16(stereo.getChannelData(0));
    const right = toInt16(stereo.getChannelData(1));
    const chunks = [];
    for (let offset = 0; offset < left.length; offset += 1152) {
      const part = encoder.encodeBuffer(
        left.subarray(offset, offset + 1152),
        right.subarray(offset, offset + 1152),
      );
      if (part.length) chunks.push(new Uint8Array(part));
    }
    const tail = encoder.flush();
    if (tail.length) chunks.push(new Uint8Array(tail));
    if (!chunks.length)
      throw new Error("this WAV file contains no audio samples");
    return {
      bytes: new Blob(chunks, { type: "audio/mpeg" }),
      sampleRate,
      sampleCount: left.length,
    };
  } finally {
    await context.close();
  }
}

export function decodeWav(bytes) {
  const view = new DataView(bytes);
  if (view.byteLength < 12 || readFourCC(view, 8) !== "WAVE")
    throw new Error("this sound is not a supported WAV file");
  const container = readFourCC(view, 0);
  const bigEndian = container === "RIFX";
  const rf64 = container === "RF64";
  if (container !== "RIFF" && !bigEndian && !rf64)
    throw new Error("this sound is not a supported WAV file");
  let format = null;
  const dataChunks = [];
  let rf64DataLength = null;
  for (let offset = 12; offset + 8 <= view.byteLength;) {
    const id = readFourCC(view, offset);
    let size = view.getUint32(offset + 4, !bigEndian);
    const start = offset + 8;
    if (rf64 && id === "ds64" && size >= 28) {
      const low = view.getUint32(start + 8, true);
      const high = view.getUint32(start + 12, true);
      rf64DataLength = high * 0x100000000 + low;
    }
    if (rf64 && size === 0xffffffff && id === "data" && rf64DataLength !== null)
      size = rf64DataLength;
    if (size > view.byteLength - start) {
      if (id === "data" && rf64 && rf64DataLength === null)
        throw new Error("this RF64 file is missing its data size header");
      throw new Error("this WAV file is incomplete or damaged");
    }
    if (id === "fmt ") {
      if (size < 16)
        throw new Error("this WAV file has an incomplete format header.");
      format = {
        code: view.getUint16(start, !bigEndian),
        channels: view.getUint16(start + 2, !bigEndian),
        sampleRate: view.getUint32(start + 4, !bigEndian),
        blockAlign: view.getUint16(start + 12, !bigEndian),
        bitsPerSample: view.getUint16(start + 14, !bigEndian),
        samplesPerBlock:
          size >= 20 ? view.getUint16(start + 18, !bigEndian) : 0,
        validBitsPerSample: 0,
        bigEndian,
        coefficients: [],
      };
      if (format.code === 2 && size >= 22) {
        const coefficientCount = view.getUint16(start + 20, !bigEndian);
        for (let index = 0; index < coefficientCount; index++) {
          const coefficientOffset = start + 22 + index * 4;
          if (coefficientOffset + 4 > start + size) break;
          format.coefficients.push([
            view.getInt16(coefficientOffset, !bigEndian),
            view.getInt16(coefficientOffset + 2, !bigEndian),
          ]);
        }
      }
      if (format.code === 65534 && size >= 40) {
        format.code = view.getUint16(start + 24, !bigEndian);
        format.validBitsPerSample = view.getUint16(start + 18, !bigEndian);
      }
    }
    if (id === "data") dataChunks.push(new Uint8Array(bytes, start, size));
    offset = start + size + (size % 2);
  }
  if (
    !format ||
    !dataChunks.length ||
    !format.channels ||
    !format.sampleRate ||
    !format.blockAlign
  )
    throw new Error("this WAV file is missing its format or audio data.");
  const audioLength = dataChunks.reduce(
    (length, chunk) => length + chunk.length,
    0,
  );
  const audioBytes = new Uint8Array(audioLength);
  let audioOffset = 0;
  for (const chunk of dataChunks) {
    audioBytes.set(chunk, audioOffset);
    audioOffset += chunk.length;
  }
  if (format.code === 17) return decodeImaAdpcm(audioBytes, format);
  if (format.code === 2) return decodeMsAdpcm(audioBytes, format);
  if (format.code === 1 || format.code === 3)
    return decodePcm(audioBytes, format);
  if (format.code === 6 || format.code === 7)
    return decodeCompanded(audioBytes, format);
  throw new Error(
    `this WAV uses audio encoding ${format.code}, which Blokko cannot convert yet :(`,
  );
}

function readFourCC(view, offset) {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

function decodePcm(bytes, format) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bytesPerSample = Math.ceil(format.bitsPerSample / 8);
  if (!bytesPerSample || format.blockAlign < bytesPerSample * format.channels)
    throw new Error("this WAV file has an unsupported sample layout.");
  if (format.code === 1 && ![8, 16, 24, 32].includes(format.bitsPerSample))
    throw new Error(`PCM ${format.bitsPerSample}-bit WAV is not supported.`);
  if (format.code === 3 && ![32, 64].includes(format.bitsPerSample))
    throw new Error(`float ${format.bitsPerSample}-bit WAV is not supported.`);
  const frameCount = Math.floor(bytes.byteLength / format.blockAlign);
  const channels = Array.from(
    { length: format.channels },
    () => new Float32Array(frameCount),
  );
  for (let frame = 0; frame < frameCount; frame++)
    for (let channel = 0; channel < format.channels; channel++) {
      const offset = frame * format.blockAlign + channel * bytesPerSample;
      let sample;
      if (format.code === 3)
        sample =
          format.bitsPerSample === 32
            ? view.getFloat32(offset, !format.bigEndian)
            : view.getFloat64(offset, !format.bigEndian);
      else if (format.bitsPerSample === 8 && !format.bigEndian)
        sample = (view.getUint8(offset) - 128) / 128;
      else {
        let value;
        if (format.bitsPerSample === 8) value = view.getUint8(offset) - 128;
        else if (format.bitsPerSample === 16)
          value = view.getInt16(offset, !format.bigEndian);
        else if (format.bitsPerSample === 24) {
          value =
            view.getUint8(offset + (format.bigEndian ? 2 : 0)) |
            (view.getUint8(offset + 1) << 8) |
            (view.getUint8(offset + (format.bigEndian ? 0 : 2)) << 16);
          if (value & 0x800000) value |= 0xff000000;
        } else value = view.getInt32(offset, !format.bigEndian);
        const validBits = format.validBitsPerSample || format.bitsPerSample;
        if (validBits < format.bitsPerSample)
          value = Math.trunc(value / 2 ** (format.bitsPerSample - validBits));
        sample = value / 2 ** (validBits - 1);
      }
      channels[channel][frame] = Number.isFinite(sample)
        ? Math.max(-1, Math.min(1, sample))
        : 0;
    }
  return { channels, sampleCount: frameCount, sampleRate: format.sampleRate };
}

function decodeCompanded(bytes, format) {
  if (format.bitsPerSample !== 8 || format.blockAlign < format.channels)
    throw new Error("this WAV file has an unsupported sample layout.");
  const frameCount = Math.floor(bytes.byteLength / format.blockAlign);
  const channels = Array.from(
    { length: format.channels },
    () => new Float32Array(frameCount),
  );
  for (let frame = 0; frame < frameCount; frame++)
    for (let channel = 0; channel < format.channels; channel++) {
      const encoded = bytes[frame * format.blockAlign + channel];
      const sample =
        format.code === 7 ? decodeMuLaw(encoded) : decodeALaw(encoded);
      channels[channel][frame] = sample / 32768;
    }
  return { channels, sampleCount: frameCount, sampleRate: format.sampleRate };
}

function decodeMuLaw(encoded) {
  const value = ~encoded & 0xff;
  const magnitude = ((value & 0x0f) << 3) + 0x84;
  const shifted = magnitude << ((value >> 4) & 7);
  return value & 0x80 ? 0x84 - shifted : shifted - 0x84;
}

function decodeALaw(encoded) {
  const value = encoded ^ 0x55;
  let magnitude = (value & 0x0f) << 4;
  const segment = (value >> 4) & 7;
  if (segment === 0) magnitude += 8;
  else if (segment === 1) magnitude += 0x108;
  else magnitude = (magnitude + 0x108) << (segment - 1);
  return value & 0x80 ? magnitude : -magnitude;
}

function decodeMsAdpcm(bytes, format) {
  const adaptation = [
    230, 230, 230, 230, 307, 409, 512, 614, 768, 614, 512, 409, 307, 230, 230,
    230,
  ];
  const defaultCoefficients = [
    [256, 0],
    [512, -256],
    [0, 0],
    [192, 64],
    [240, 0],
    [460, -208],
    [392, -232],
  ];
  if (format.channels > 2 || format.blockAlign < 7 * format.channels)
    throw new Error("this MS ADPCM WAV has an unsupported sample layout.");
  const coefficients = format.coefficients.length
    ? format.coefficients
    : defaultCoefficients;
  const channels = Array.from({ length: format.channels }, () => []);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerSize = 7 * format.channels;
  for (
    let offset = 0;
    offset + headerSize <= bytes.length;
    offset += format.blockAlign
  ) {
    const blockEnd = Math.min(offset + format.blockAlign, bytes.length);
    const predictors = [];
    const deltas = [];
    const previous = [];
    const current = [];
    for (let channel = 0; channel < format.channels; channel++) {
      predictors[channel] = bytes[offset + channel];
      if (!coefficients[predictors[channel]])
        throw new Error("this MS ADPCM WAV has an invalid predictor.");
    }
    let cursor = offset + format.channels;
    for (let channel = 0; channel < format.channels; channel++) {
      deltas[channel] = Math.max(16, view.getInt16(cursor, !format.bigEndian));
      cursor += 2;
    }
    for (let channel = 0; channel < format.channels; channel++) {
      current[channel] = view.getInt16(cursor, !format.bigEndian);
      cursor += 2;
    }
    for (let channel = 0; channel < format.channels; channel++) {
      previous[channel] = view.getInt16(cursor, !format.bigEndian);
      cursor += 2;
    }
    for (let channel = 0; channel < format.channels; channel++) {
      channels[channel].push(
        previous[channel] / 32768,
        current[channel] / 32768,
      );
    }
    while (cursor < blockEnd) {
      const packed = bytes[cursor++];
      const nibbles =
        format.channels === 1
          ? [packed >> 4, packed & 15]
          : [packed >> 4, packed & 15];
      for (let channel = 0; channel < format.channels; channel++) {
        let nibble = nibbles[channel];
        if (nibble & 8) nibble -= 16;
        const [coefficient1, coefficient2] = coefficients[predictors[channel]];
        const prediction =
          (current[channel] * coefficient1 + previous[channel] * coefficient2) /
          256;
        const sample = Math.max(
          -32768,
          Math.min(32767, Math.trunc(prediction) + nibble * deltas[channel]),
        );
        previous[channel] = current[channel];
        current[channel] = sample;
        deltas[channel] = Math.max(
          16,
          Math.trunc((adaptation[nibble & 7] * deltas[channel]) / 256),
        );
        channels[channel].push(sample / 32768);
      }
    }
  }
  let sampleCount = Math.min(...channels.map((channel) => channel.length));
  if (format.samplesPerBlock)
    sampleCount = Math.min(
      sampleCount,
      Math.floor(bytes.length / format.blockAlign) * format.samplesPerBlock,
    );
  if (!sampleCount)
    throw new Error("this MS ADPCM WAV contains no audio samples");
  return {
    channels: channels.map((channel) =>
      Float32Array.from(channel.slice(0, sampleCount)),
    ),
    sampleCount,
    sampleRate: format.sampleRate,
  };
}

function decodeImaAdpcm(bytes, format) {
  const indexTable = [-1, -1, -1, -1, 2, 4, 6, 8];
  const stepTable = [
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
    50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230,
    253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
    1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024,
    3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493,
    10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086,
    29794, 32767,
  ];
  const bytesPerChannelHeader = 4;
  const channels = Array.from({ length: format.channels }, () => []);
  const steps = [];
  const indices = [];
  let offset = 0;
  while (offset + bytesPerChannelHeader * format.channels <= bytes.byteLength) {
    const blockEnd = Math.min(offset + format.blockAlign, bytes.byteLength);
    steps.length = 0;
    indices.length = 0;
    for (let channel = 0; channel < format.channels; channel++) {
      const header = offset + channel * bytesPerChannelHeader;
      const predictor = new DataView(
        bytes.buffer,
        bytes.byteOffset + header,
        2,
      ).getInt16(0, true);
      steps[channel] = predictor;
      indices[channel] = Math.min(
        88,
        bytes[offset + channel * bytesPerChannelHeader + 2],
      );
      channels[channel].push(predictor / 32768);
    }
    let cursor = offset + bytesPerChannelHeader * format.channels;
    if (format.channels === 1) {
      while (cursor < blockEnd) {
        const packed = bytes[cursor++];
        for (const nibble of [packed & 15, packed >> 4]) {
          const sample = imaSample(
            nibble,
            0,
            steps,
            indices,
            stepTable,
            indexTable,
          );
          channels[0].push(sample / 32768);
        }
      }
    } else if (format.channels === 2) {
      while (cursor < blockEnd)
        for (let channel = 0; channel < 2 && cursor < blockEnd; channel++) {
          const groupEnd = Math.min(cursor + 4, blockEnd);
          while (cursor < groupEnd) {
            const packed = bytes[cursor++];
            for (const nibble of [packed & 15, packed >> 4]) {
              const sample = imaSample(
                nibble,
                channel,
                steps,
                indices,
                stepTable,
                indexTable,
              );
              channels[channel].push(sample / 32768);
            }
          }
        }
    } else
      throw new Error(
        "IMA ADPCM WAV files with more than two channels aren't supported",
      );
    offset += format.blockAlign;
  }
  const sampleCount = Math.min(...channels.map((channel) => channel.length));
  if (!sampleCount)
    throw new Error("this IMA ADPCM WAV contains no audio samples");
  return {
    channels: channels.map((channel) =>
      Float32Array.from(channel.slice(0, sampleCount)),
    ),
    sampleCount,
    sampleRate: format.sampleRate,
  };
}

function imaSample(
  nibble,
  channel,
  predictors,
  indices,
  stepTable,
  indexTable,
) {
  const step = stepTable[indices[channel]];
  let difference = step >> 3;
  if (nibble & 1) difference += step >> 2;
  if (nibble & 2) difference += step >> 1;
  if (nibble & 4) difference += step;
  predictors[channel] = Math.max(
    -32768,
    Math.min(
      32767,
      predictors[channel] + (nibble & 8 ? -difference : difference),
    ),
  );
  indices[channel] = Math.max(
    0,
    Math.min(88, indices[channel] + indexTable[nibble & 7]),
  );
  return predictors[channel];
}

function loadEncoder() {
  if (window.lamejs?.Mp3Encoder) return Promise.resolve(window.lamejs);
  if (!encoderPromise)
    encoderPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = lameUrl;
      script.onload = () =>
        window.lamejs?.Mp3Encoder
          ? resolve(window.lamejs)
          : reject(new Error("couldn't load the MP3 encoder"));
      script.onerror = () =>
        reject(new Error("couldn't load the MP3 encoder script"));
      document.head.appendChild(script);
    });
  return encoderPromise;
}

function toInt16(samples) {
  const output = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index++) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    output[index] = sample < 0 ? sample * 32768 : sample * 32767;
  }
  return output;
}
