import JSZip from "jszip";
import lameScriptUrl from "lamejs/lame.all.js?url";
import { decodeWav } from "./audio.js";
import {
  convertImage,
  getEmbeddedPngs,
  replaceEmbeddedImage,
} from "./images.js";

self.onmessage = async ({ data: request }) => {
  if (request.type !== "convert") return;
  const { id, file, audioAssets, imageAssets, imageFormats, bitrate } = request;
  const selectedAssetNames = [...audioAssets, ...imageAssets]
    .map((asset) => asset.name)
    .filter(Boolean);
  let errorAssetNames = selectedAssetNames.join(", ") || "selected assets";
  const progress = (value, status) =>
    self.postMessage({ type: "progress", id, value, status });

  try {
    progress(1, "Reading the project archive...");
    const fileBuffer = await readFile(file, (loaded, total) =>
      progress(
        Math.min(10, (loaded / total) * 10),
        "Reading the project archive...",
      ),
    );
    const archive = await JSZip.loadAsync(fileBuffer);
    const projectEntry = archive.file("project.json");
    if (!projectEntry)
      throw new Error("this archive does not contain project.json");
    const projectData = JSON.parse(await projectEntry.async("text"));
    const total = audioAssets.length + imageAssets.length;
    let completed = 0;
    const changes = [];
    const report = (fraction, status) =>
      progress(12 + ((completed + fraction) / Math.max(total, 1)) * 78, status);

    for (const asset of audioAssets) {
      errorAssetNames = asset.name || errorAssetNames;
      const archiveEntry =
        archive.file(asset.filename) ?? archive.file(`${asset.assetId}.wav`);
      if (!archiveEntry)
        throw new Error("couldn't find this sound in the project archive");
      const input = await archiveEntry.async("arraybuffer");
      const output = await convertWav(
        input,
        asset.samples,
        asset.rate,
        bitrate,
        (fraction) => report(fraction, `Converting ${asset.name} to MP3...`),
      );
      const newFilename = `${asset.assetId}.mp3`;
      archive.file(newFilename, output.bytes);
      archive.remove(archiveEntry.name);
      for (const target of projectData.targets)
        for (const sound of target.sounds ?? []) {
          const current =
            sound.md5ext || `${sound.assetId}.${sound.dataFormat}`;
          if (current !== asset.key) continue;
          sound.dataFormat = "mp3";
          sound.md5ext = newFilename;
          sound.rate = 44100;
          sound.sampleCount = output.sampleCount;
        }
      changes.push({
        name: asset.name,
        note: "WAV to MP3",
        savings: getSavingsPercent(input.byteLength, output.bytes.size),
      });
      completed++;
      report(0, `Converted ${asset.name}`);
    }

    const embeddedAssets = imageAssets.filter((asset) => asset.isEmbedded);
    const embeddedBySvg = new Map();
    for (const asset of embeddedAssets) {
      if (!embeddedBySvg.has(asset.sourceFilename))
        embeddedBySvg.set(asset.sourceFilename, []);
      embeddedBySvg.get(asset.sourceFilename).push(asset);
    }
    for (const [svgFilename, assets] of embeddedBySvg) {
      errorAssetNames =
        assets
          .map((asset) => asset.name)
          .filter(Boolean)
          .join(", ") || errorAssetNames;
      let svgText = await archive.file(svgFilename).async("text");
      for (const asset of assets.sort(
        (a, b) => b.embeddedIndex - a.embeddedIndex,
      )) {
        errorAssetNames = asset.name || errorAssetNames;
        const embedded = getEmbeddedPngs(svgText).find(
          (image) => image.index === asset.embeddedIndex,
        );
        if (!embedded?.bytes)
          throw new Error(
            `couldn't read embedded PNG ${asset.embeddedIndex + 1}`,
          );
        const {
          format,
          bytes: output,
          jpgRejected,
        } = await convertImage(
          embedded.bytes,
          imageFormats[asset.key] === "jpg" && asset.transparent === false,
        );
        svgText = replaceEmbeddedImage(
          svgText,
          asset.embeddedIndex,
          format === "jpg" ? "image/jpeg" : "image/png",
          output,
        );
        changes.push({
          name: asset.name,
          note: describeFormat(format, jpgRejected),
          savings: getSavingsPercent(
            embedded.bytes.byteLength,
            output.byteLength,
          ),
        });
        completed++;
        report(0, `Converted ${asset.name}`);
      }
      archive.file(svgFilename, svgText);
    }

    for (const asset of imageAssets) {
      if (asset.isEmbedded) continue;
      errorAssetNames = asset.name || errorAssetNames;
      const archiveEntry = archive.file(asset.filename);
      if (!archiveEntry)
        throw new Error("couldn't find this image in the project archive");
      const input = await archiveEntry.async("arraybuffer");
      const {
        format,
        bytes: output,
        jpgRejected,
      } = await convertImage(
        input,
        imageFormats[asset.key] === "jpg" && asset.transparent === false,
      );
      const newFilename =
        format === "jpg" ? `${asset.assetId}.jpg` : asset.filename;
      archive.file(newFilename, output);
      if (newFilename !== asset.filename) archive.remove(archiveEntry.name);
      for (const target of projectData.targets)
        for (const costume of target.costumes ?? []) {
          const current =
            costume.md5ext || `${costume.assetId}.${costume.dataFormat}`;
          if (current !== asset.filename || format !== "jpg") continue;
          costume.dataFormat = "jpg";
          costume.md5ext = newFilename;
        }
      changes.push({
        name: asset.name,
        note: describeFormat(format, jpgRejected),
        savings: getSavingsPercent(input.byteLength, output.byteLength),
      });
      completed++;
      report(0, `Converted ${asset.name}`);
    }

    errorAssetNames = selectedAssetNames.join(", ") || "selected assets";
    archive.file("project.json", JSON.stringify(projectData));
    progress(92, "Packaging the converted project...");
    const blob = await archive.generateAsync(
      {
        type: "blob",
        compression: "DEFLATE",
        compressionOptions: { level: 6 },
      },
      (metadata) =>
        progress(
          92 + metadata.percent * 0.08,
          "Packaging the converted project...",
        ),
    );
    self.postMessage({ type: "complete", id, blob, changes });
  } catch (error) {
    self.postMessage({
      type: "error",
      id,
      message: `${error?.message || "something went wrong while converting the selected assets"} (${errorAssetNames})`,
    });
  }
};

function readFile(file, onProgress) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded, event.total);
    };
    reader.onload = () => resolve(reader.result);
    reader.onerror = () =>
      reject(reader.error ?? new Error("couldn't read the project file"));
    reader.readAsArrayBuffer(file);
  });
}

async function convertWav(
  bytes,
  expectedSamples,
  sourceSampleRate,
  bitrate,
  onProgress,
) {
  const decoded = decodeWav(bytes, expectedSamples, sourceSampleRate);
  const sourceCount =
    expectedSamples > 0
      ? Math.min(expectedSamples, decoded.sampleCount)
      : decoded.sampleCount;
  if (!sourceCount) throw new Error("this WAV file contains no audio samples");
  const sampleRate = 44100;
  const sampleCount = Math.ceil(
    (sourceCount / decoded.sampleRate) * sampleRate,
  );
  const left = new Int16Array(sampleCount);
  const right = new Int16Array(sampleCount);
  const channels = decoded.channels;
  const values = new Array(channels.length);
  for (let index = 0; index < sampleCount; index++) {
    const position = Math.min(
      (index * decoded.sampleRate) / sampleRate,
      sourceCount - 1,
    );
    const sourceIndex = Math.floor(position);
    const nextIndex = Math.min(sourceIndex + 1, sourceCount - 1);
    const mix = position - sourceIndex;
    for (let channel = 0; channel < channels.length; channel++)
      values[channel] =
        channels[channel][sourceIndex] +
        (channels[channel][nextIndex] - channels[channel][sourceIndex]) * mix;
    const [leftSample, rightSample] = toStereo(values);
    left[index] = toInt16(leftSample);
    right[index] = toInt16(rightSample);
  }

  const encoded = await encodeMp3(left, right, bitrate, onProgress);
  return { bytes: new Blob([encoded], { type: "audio/mpeg" }), sampleCount };
}

function encodeMp3(left, right, bitrate, onProgress) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./mp3.worker.js", import.meta.url));
    worker.onmessage = ({ data }) => {
      if (data.type === "progress") onProgress(data.value);
      else if (data.type === "complete") {
        worker.terminate();
        resolve(data.bytes);
      } else if (data.type === "error") {
        worker.terminate();
        reject(new Error(data.message));
      }
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || "the MP3 encoder failed"));
    };
    worker.postMessage(
      {
        type: "encode",
        scriptUrl: lameScriptUrl,
        left: left.buffer,
        right: right.buffer,
        bitrate,
      },
      [left.buffer, right.buffer],
    );
  });
}

function toStereo(values) {
  if (values.length === 1) return [values[0], values[0]];
  if (values.length === 2) return values;
  let left = values[0];
  let right = values[1];
  let leftWeight = 1;
  let rightWeight = 1;
  if (values[2] !== undefined) {
    left += values[2] * 0.707;
    right += values[2] * 0.707;
    leftWeight += 0.707;
    rightWeight += 0.707;
  }
  if (values[3] !== undefined) {
    left += values[3] * 0.5;
    right += values[3] * 0.5;
    leftWeight += 0.5;
    rightWeight += 0.5;
  }
  for (let index = 4; index < values.length; index++) {
    const weight = index % 2 === 0 ? 0.707 : 0.707;
    if (index % 2 === 0) {
      left += values[index] * weight;
      leftWeight += weight;
    } else {
      right += values[index] * weight;
      rightWeight += weight;
    }
  }
  return [left / leftWeight, right / rightWeight];
}

function toInt16(sample) {
  const bounded = Math.max(-1, Math.min(1, sample));
  return Math.round(bounded < 0 ? bounded * 32768 : bounded * 32767);
}

function describeFormat(format, jpgRejected) {
  return jpgRejected ? "PNG, JPG wouldn't save enough" : format.toUpperCase();
}

function getSavingsPercent(before, after) {
  return before ? ((before - after) / before) * 100 : 0;
}
