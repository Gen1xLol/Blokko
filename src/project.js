export function getStageSize(data) {
  let width = data.stageWidth ?? 480;
  let height = data.stageHeight ?? 360;
  const stage = data.targets?.find((target) => target.isStage);

  for (const comment of Object.values(stage?.comments ?? {})) {
    const text = typeof comment?.text === "string" ? comment.text : "";
    const markerIndex = text.indexOf("// _twconfig_");
    if (markerIndex === -1) continue;

    const prefix = text.slice(0, markerIndex).trim();
    const jsonStart = prefix.indexOf("{");
    if (jsonStart === -1) continue;

    try {
      const config = JSON.parse(prefix.slice(jsonStart));
      if (Number.isFinite(config.width) && config.width > 0)
        width = config.width;
      if (Number.isFinite(config.height) && config.height > 0)
        height = config.height;
    } catch {
      // we ignore invalid JSON in the comment
    }
  }

  return `${width} × ${height}`;
}

export function inspectProject(data, file, archive) {
  const declaredExtensions = [...new Set(data.extensions ?? [])];
  const extensionUsage = new Map(declaredExtensions.map((name) => [name, 0]));
  const categoryUsage = new Map();
  const blockStores = [
    ...new Set(data.targets.map((target) => target.blocks).filter(Boolean)),
  ];
  const targetStats = data.targets.map((target, index) => {
    const categories = new Map();
    const allBlocks = Object.values(target.blocks ?? {});
    const blocks = allBlocks.filter(
      (block) => block?.opcode && !block.shadow,
    );
    for (const block of blocks) {
      const opcode = block.opcode;
      const namespace = opcode.split("_")[0];
      const extension = declaredExtensions.find((name) =>
        opcode.startsWith(`${name}_`),
      );
      let category;
      if (extension) {
        category = "Extensions";
        extensionUsage.set(extension, extensionUsage.get(extension) + 1);
      } else if (namespace === "motion") category = "Motion";
      else if (namespace === "looks") category = "Looks";
      else if (namespace === "control") category = "Control";
      else if (namespace === "event") category = "Events";
      else if (namespace === "operator" || namespace === "operators")
        category = "Operators";
      else if (namespace === "sensing") category = "Sensing";
      else if (namespace === "sound") category = "Sound";
      else if (opcode.startsWith("data_list")) category = "Lists";
      else if (namespace === "data") category = "Variables";
      else if (namespace === "procedures") category = "My Blocks";
      else if (namespace === "pen") category = "Pen";
      else category = "Other";
      categories.set(category, (categories.get(category) ?? 0) + 1);
      categoryUsage.set(category, (categoryUsage.get(category) ?? 0) + 1);
    }
    return {
      index,
      name: target.name || (target.isStage ? "Stage" : "Sprite"),
      isStage: Boolean(target.isStage),
      currentCostume: target.costumes?.[target.currentCostume] ?? null,
      blocks: allBlocks.filter((block) => !block.shadow).length,
      scripts: allBlocks.filter((block) => !block.parent).length,
      categories,
      variables: Object.keys(target.variables ?? {}).length,
      lists: Object.keys(target.lists ?? {}).length,
      costumes: target.costumes?.length ?? 0,
      sounds: target.sounds?.length ?? 0,
    };
  });
  const palette = {
    Motion: "#4C97FF",
    Looks: "#9966FF",
    Sound: "#CF63CF",
    Events: "#FFBF00",
    Control: "#FFAB19",
    Sensing: "#5CB1D6",
    Operators: "#59C059",
    Variables: "#FF8C1A",
    Lists: "#FF661A",
    "My Blocks": "#FF6680",
    Pen: "#0FBD8C",
    Extensions: "#2BBE8C",
    Other: "#89858b",
  };
  const audioAssets = [];
  const imageAssets = [];
  const svgAssets = [];
  data.targets.forEach((target, targetIndex) =>
    (target.sounds ?? []).forEach((sound, soundIndex) => {
      const format = (
        sound.dataFormat ??
        sound.md5ext?.split(".").pop() ??
        ""
      ).toLowerCase();
      if (format !== "wav") return;
      const filename = sound.md5ext || `${sound.assetId}.${format}`;
      const entry =
        archive?.file(filename) ?? archive?.file(`${sound.assetId}.${format}`);
      audioAssets.push({
        key: filename,
        filename,
        name: sound.name || filename,
        target: target.name || (target.isStage ? "Stage" : "Sprite"),
        targetIndex,
        soundIndex,
        assetId: sound.assetId,
        rate: sound.rate ?? 0,
        samples: sound.sampleCount ?? 0,
        available: Boolean(entry),
      });
    }),
  );
  data.targets.forEach((target, targetIndex) =>
    (target.costumes ?? []).forEach((costume, costumeIndex) => {
      const format = (
        costume.dataFormat ??
        costume.md5ext?.split(".").pop() ??
        ""
      ).toLowerCase();
      if (format !== "png" && format !== "svg") return;
      const filename = costume.md5ext || `${costume.assetId}.${format}`;
      const entry =
        archive?.file(filename) ?? archive?.file(`${costume.assetId}.${format}`);
      const asset = {
        key: filename,
        filename,
        name: costume.name || filename,
        target: target.name || (target.isStage ? "Stage" : "Sprite"),
        targetIndex,
        costumeIndex,
        assetId: costume.assetId,
        available: Boolean(entry),
        transparent: format === "png" ? null : true,
      };
      if (format === "png") imageAssets.push(asset);
      else svgAssets.push(asset);
    }),
  );
  const uniqueImageAssets = [
    ...new Map(imageAssets.map((asset) => [asset.key, asset])).values(),
  ];
  const assetsByKey = new Map(audioAssets.map((asset) => [asset.key, asset]));
  const uniqueAudioAssets = [...assetsByKey.values()];
  return {
    name: file.name.replace(/\.(sb3|pmp)$/i, ""),
    filename: file.name,
    extension: file.name.split(".").pop(),
    file,
    size: file.size,
    platform:
      data.meta?.platform?.name ??
      (declaredExtensions.length ? "PenguinMod" : "TurboWarp"),
    data,
    archive,
    hasArchive: Boolean(archive),
    blocks: blockStores.reduce(
      (sum, store) =>
        sum + Object.values(store).filter((block) => !block.shadow).length,
      0,
    ),
    scripts: blockStores.reduce(
      (sum, store) =>
        sum + Object.values(store).filter((block) => !block.parent).length,
      0,
    ),
    sprites: blockStores.length - 1,
    targets: targetStats,
    targetStats,
    costumes: targetStats.reduce((sum, target) => sum + target.costumes, 0),
    sounds: targetStats.reduce((sum, target) => sum + target.sounds, 0),
    variables: targetStats.reduce((sum, target) => sum + target.variables, 0),
    lists: targetStats.reduce((sum, target) => sum + target.lists, 0),
    extensions: declaredExtensions,
    extensionStats: [...extensionUsage].map(([name, value]) => ({
      label: name,
      value,
      color: palette.Extensions,
    })),
    categories: [...categoryUsage]
      .map(([label, value]) => ({
        label,
        value,
        color: palette[label] ?? palette.Other,
      }))
      .sort((a, b) => b.value - a.value),
    fonts: data.customFonts?.length ?? 0,
    stageSize: getStageSize(data),
    audioAssets: uniqueAudioAssets,
    imageAssets: uniqueImageAssets,
    svgAssets,
  };
}
