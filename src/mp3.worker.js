self.onmessage = ({ data }) => {
  if (data.type !== "encode") return;
  try {
    importScripts(data.scriptUrl);
    const lamejs = self.lamejs;
    if (!lamejs?.Mp3Encoder) throw new Error("couldn't load the MP3 encoder");
    const left = new Int16Array(data.left);
    const right = new Int16Array(data.right);
    const encoder = new lamejs.Mp3Encoder(2, 44100, data.bitrate);
    const chunks = [];
    const batchSize = 1152;
    for (let offset = 0; offset < left.length; offset += batchSize) {
      const end = Math.min(offset + batchSize, left.length);
      const chunk = encoder.encodeBuffer(
        left.subarray(offset, end),
        right.subarray(offset, end),
      );
      if (chunk.length) chunks.push(new Uint8Array(chunk));
      if (offset % (batchSize * 64) === 0 || end === left.length)
        self.postMessage({ type: "progress", value: end / left.length });
    }
    const tail = encoder.flush();
    if (tail.length) chunks.push(new Uint8Array(tail));
    if (!chunks.length) throw new Error("this WAV file contains no audio samples");
    const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
    const output = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.length;
    }
    self.postMessage({ type: "complete", bytes: output.buffer }, [output.buffer]);
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error?.message || "the MP3 encoder failed",
    });
  }
};
