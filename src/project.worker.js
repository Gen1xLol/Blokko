import JSZip from "jszip";
import { inspectProject } from "./project.js";
import { getEmbeddedPngs, inspectPng } from "./images.js";

let archive;

self.onmessage = async (event) => {
  const { type, file, id } = event.data;
  if (type !== "load") return;
  const progress = (value, status) =>
    self.postMessage({ type: "progress", id, value, status });

  try {
    progress(0, "Reading the project file...");
    const buffer = await readFile(file, (loaded, total) => {
      progress(Math.min(28, (loaded / total) * 28), "Reading the project file...");
    });
    progress(30, "Opening project archive...");
    archive = await JSZip.loadAsync(buffer);
    progress(40, "Reading project data...");
    const entry =
      archive.file("project.json") ??
      Object.values(archive.files).find(
        (item) => !item.dir && item.name.toLowerCase().endsWith(".json"),
      );
    if (!entry) throw new Error("this archive does not contain a project.json file.");
    const data = JSON.parse(await entry.async("text"));
    if (!Array.isArray(data.targets) || !data.targets.length)
      throw new Error(
        "this file is not a valid TurboWarp or PenguinMod project.",
      );
    const analyzed = inspectProject(data, file, archive);
    const svgAssets = [
      ...new Map(analyzed.svgAssets.map((asset) => [asset.filename, asset])).values(),
    ];
    const spriteTargets = analyzed.targetStats
      .filter((target) => !target.isStage)
      .slice()
      .sort((a, b) => b.blocks - a.blocks)
      .slice(0, 10);
    const total = analyzed.imageAssets.length + svgAssets.length + spriteTargets.length;
    let completed = 0;
    const step = (status) => {
      completed++;
      progress(42 + (total ? (completed / total) * 56 : 56), status);
    };

    for (const asset of analyzed.imageAssets) {
      if (asset.available) {
        try {
          const bytes = await archive.file(asset.filename).async("arraybuffer");
          const details = await inspectPng(bytes);
          asset.transparent = details.transparent;
        } catch {
          asset.transparent = true;
        }
      }
      step(`Inspecting PNG costumes (${completed + 1} of ${total})...`);
    }

    for (const svgAsset of svgAssets) {
      if (svgAsset.available) {
        try {
          const svgText = await archive.file(svgAsset.filename).async("text");
          for (const embedded of getEmbeddedPngs(svgText)) {
            const asset = {
              ...svgAsset,
              key: `${svgAsset.filename}#embedded-png-${embedded.index}`,
              name: `${svgAsset.name} - embedded PNG ${embedded.index + 1}`,
              filename: svgAsset.filename,
              sourceFilename: svgAsset.filename,
              embeddedIndex: embedded.index,
              isEmbedded: true,
              transparent: true,
              available: Boolean(embedded.bytes),
            };
            if (embedded.bytes) {
              try {
                const details = await inspectPng(embedded.bytes);
                asset.transparent = details.transparent;
              } catch {
                asset.transparent = true;
              }
            }
            analyzed.imageAssets.push(asset);
          }
        } catch {
          continue;
        } finally {
          step(`Inspecting SVG assets (${completed + 1} of ${total})...`);
        }
      } else {
        step(`Inspecting SVG assets (${completed + 1} of ${total})...`);
      }
    }

    const spriteColors = {};
    for (const target of spriteTargets) {
      const color = await getDominantColor(target.currentCostume);
      if (color) spriteColors[target.index] = color;
      step(`Loading sprite images (${completed + 1} of ${total})...`);
    }

    const { archive: ignoredArchive, file: ignoredFile, ...project } = analyzed;
    progress(100, "Project ready");
    self.postMessage({ type: "complete", id, project, spriteColors });
  } catch (error) {
    self.postMessage({
      type: "error",
      id,
      message: error?.message || "couldn't read this project file",
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
    reader.onerror = () => reject(reader.error ?? new Error("couldn't read this project file"));
    reader.readAsArrayBuffer(file);
  });
}

async function getDominantColor(costume) {
  if (!costume?.assetId || typeof createImageBitmap !== "function") return null;
  const format = (
    costume.dataFormat ??
    costume.md5ext?.split(".").pop() ??
    "png"
  ).toLowerCase();
  const filename = costume.md5ext || `${costume.assetId}.${format}`;
  const entry = archive.file(filename) ?? archive.file(`${costume.assetId}.${format}`);
  if (!entry) return null;
  let image;
  try {
    const bytes = await entry.async("uint8array");
    const mimeType =
      format === "svg"
        ? "image/svg+xml"
        : `image/${format === "jpg" ? "jpeg" : format}`;
    image = await createImageBitmap(new Blob([bytes], { type: mimeType }));
    const canvas = new OffscreenCanvas(32, 32);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const colors = new Map();
    for (let offset = 0; offset < pixels.length; offset += 4) {
      const alpha = pixels[offset + 3];
      if (alpha < 96) continue;
      const red = pixels[offset];
      const green = pixels[offset + 1];
      const blue = pixels[offset + 2];
      const key = `${red >> 4},${green >> 4},${blue >> 4}`;
      const bucket = colors.get(key) ?? { count: 0, red: 0, green: 0, blue: 0 };
      bucket.count += alpha;
      bucket.red += red * alpha;
      bucket.green += green * alpha;
      bucket.blue += blue * alpha;
      colors.set(key, bucket);
    }
    const dominant = [...colors.values()].sort((a, b) => b.count - a.count)[0];
    if (!dominant) return null;
    return `#${[dominant.red, dominant.green, dominant.blue]
      .map((channel) =>
        Math.round(channel / dominant.count)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")}`;
  } catch {
    return null;
  } finally {
    image?.close?.();
  }
}
