import { optimise } from "@jsquash/oxipng";
import { init as initOxipng } from "@jsquash/oxipng/optimise";
import oxipngWasmUrl from "@jsquash/oxipng/codec/pkg/squoosh_oxipng_bg.wasm?url";

let oxipngReady;

async function ensureOxipng() {
  if (!oxipngReady) oxipngReady = initOxipng(oxipngWasmUrl);
  await oxipngReady;
}

export function getEmbeddedPngs(svgText) {
  const images = [];
  const expression = /data:image\/(png|jpeg|jpg)\s*;\s*base64\s*,([^"'\s)>]+)/gi;
  let match;
  let uriIndex = 0;
  while ((match = expression.exec(svgText))) {
    const index = uriIndex++;
    if (match[1].toLowerCase() !== "png") continue;
    try {
      const binary = atob(match[2].replace(/\s/g, ""));
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++)
        bytes[index] = binary.charCodeAt(index);
      images.push({ index, bytes: bytes.buffer });
    } catch {
      images.push({ index, bytes: null });
    }
  }
  return images;
}

export function replaceEmbeddedImage(svgText, imageIndex, mimeType, bytes) {
  let index = 0;
  const expression = /data:image\/(?:png|jpeg|jpg)\s*;\s*base64\s*,([^"'\s)>]+)/gi;
  return svgText.replace(expression, (uri) => {
    if (index++ !== imageIndex) return uri;
    const binary = Array.from(new Uint8Array(bytes), (byte) =>
      String.fromCharCode(byte),
    ).join("");
    const base64 = btoa(binary);
    return `data:${mimeType};base64,${base64}`;
  });
}

export async function inspectPng(bytes) {
  const blob = new Blob([bytes], { type: "image/png" });
  let image;
  let url = "";
  try {
    if (typeof createImageBitmap === "function") {
      image = await createImageBitmap(blob);
    } else {
      url = URL.createObjectURL(blob);
      image = await new Promise((resolve, reject) => {
        const element = new Image();
        element.onload = () => resolve(element);
        element.onerror = () => reject(new Error("couldn't read this PNG image"));
        element.src = url;
      });
    }
    const canvas =
      typeof OffscreenCanvas === "function"
        ? new OffscreenCanvas(image.width, image.height)
        : Object.assign(document.createElement("canvas"), {
            width: image.width,
            height: image.height,
          });
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, image.width, image.height).data;
    let transparent = false;
    for (let index = 3; index < pixels.length; index += 4) {
      if (pixels[index] < 255) {
        transparent = true;
        break;
      }
    }
    return { transparent, width: image.width, height: image.height };
  } finally {
    image?.close?.();
    if (url) URL.revokeObjectURL(url);
  }
}

export async function optimisePng(bytes) {
  await ensureOxipng();
  return optimise(bytes, { level: 3 });
}

export async function pngToJpg(bytes, quality = 0.9) {
  const blob = new Blob([bytes], { type: "image/png" });
  let image;
  let url = "";
  try {
    if (typeof createImageBitmap === "function") {
      image = await createImageBitmap(blob);
    } else {
      url = URL.createObjectURL(blob);
      image = await new Promise((resolve, reject) => {
        const element = new Image();
        element.onload = () => resolve(element);
        element.onerror = () => reject(new Error("couldn't read this PNG image"));
        element.src = url;
      });
    }
    const canvas =
      typeof OffscreenCanvas === "function"
        ? new OffscreenCanvas(image.width, image.height)
        : Object.assign(document.createElement("canvas"), {
            width: image.width,
            height: image.height,
          });
    const context = canvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, image.width, image.height);
    context.drawImage(image, 0, 0);
    const output = await new Promise((resolve, reject) => {
      canvas.convertToBlob
        ? canvas.convertToBlob({ type: "image/jpeg", quality }).then(resolve, reject)
        : canvas.toBlob(
            (result) =>
              result
                ? resolve(result)
                : reject(new Error("couldn't convert this PNG to JPG")),
            "image/jpeg",
            quality,
          );
    });
    return output.arrayBuffer();
  } finally {
    image?.close?.();
    if (url) URL.revokeObjectURL(url);
  }
}
