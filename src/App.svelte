<script>
  import {
    createExtensionMetadata,
    getExtensionSourceLabel,
    lookUpExtensionMetadata,
  } from "./extensions.js";
  import { getStatDetail } from "./stat-details.js";
  import "@material/web/button/filled-button.js";
  import "@material/web/button/filled-tonal-button.js";
  import "@material/web/button/outlined-button.js";
  import "@material/web/button/text-button.js";
  import "@material/web/checkbox/checkbox.js";
  import "@material/web/divider/divider.js";
  import "@material/web/icon/icon.js";
  import "@material/web/iconbutton/icon-button.js";
  import "@material/web/labs/card/filled-card.js";
  import "@material/web/labs/card/outlined-card.js";
  import "@material/web/list/list.js";
  import "@material/web/list/list-item.js";
  import "@material/web/progress/linear-progress.js";
  import "@material/web/select/outlined-select.js";
  import "@material/web/select/select-option.js";
  import "@material/web/switch/switch.js";
  import "@material/web/tabs/primary-tab.js";
  import "@material/web/tabs/tabs.js";
  import "@material/web/textfield/outlined-text-field.js";
  import { styles as typescaleStyles } from "@material/web/typography/md-typescale-styles.js";
  import { ArcElement, Chart, Legend, PieController, Tooltip } from "chart.js";
  import { onDestroy } from "svelte";
  import { quartOut } from "svelte/easing";
  import { Tween } from "svelte/motion";

  Chart.register(PieController, ArcElement, Tooltip, Legend);
  document.adoptedStyleSheets = [
    ...document.adoptedStyleSheets,
    typescaleStyles.styleSheet,
  ];

  const initialStats = {
    blocks: 0,
    scripts: 0,
    sprites: 0,
    extensions: 0,
    media: 0,
  };
  let project = $state(null);
  const animatedStats = new Tween(
    { ...initialStats },
    { duration: 1500, easing: quartOut },
  );
  let originalUrl = $state("");
  let packagedUrl = $state("");
  let packagedName = $state("");
  let selectedAssets = $state([]);
  let selectedImages = $state([]);
  let imageFormats = $state({});
  let conversionResults = $state(null);
  let bitrate = $state(192);
  let loading = $state(false);
  let loadProgress = $state(0);
  let loadStatus = $state("");
  let converting = $state(false);
  let conversionProgress = $state(0);
  let conversionStatus = $state("");
  let error = $state("");
  let search = $state("");
  let activeChart = $state("Categories");
  let dragOver = $state(false);
  let fileInput = $state(null);
  let toast = $state("");
  let pieTooltip = $state(null);
  let pieTooltipPosition = $state({ x: 0, y: 0 });
  let pieTooltipTarget = { x: 0, y: 0 };
  let pieTooltipFrame = 0;
  let pieTooltipPinned = false;
  let pieCanvas = $state(null);
  let pieChart;
  let spriteColors = $state({});
  let extensionMetadata = $state([]);
  let extensionLookupBusy = $state(false);
  let extensionLookupId = 0;
  let cancelActiveLoad;
  let projectWorker;
  let activeLoadId = 0;
  let conversionWorker;

  const stats = $derived(
    project
      ? [
          {
            key: "blocks",
            label: "Blocks",
            value: project.blocks,
            detail: getStatDetail("blocks", project.blocks),
          },
          {
            key: "scripts",
            label: "Scripts",
            value: project.scripts,
            detail: getStatDetail("scripts", project.scripts),
          },
          {
            key: "sprites",
            label: "Sprites",
            value: project.sprites,
            detail: `not including the stage`,
          },
          {
            key: "extensions",
            label: "Extensions",
            value: project.extensions.length,
            detail: "used by this project",
          },
          {
            key: "media",
            label: "Media assets",
            value: project.costumes + project.sounds,
            detail: "(this gets replaced later)",
          },
        ].map((item) => ({
          ...item,
          digits: Math.max(1, formatNumber(item.value).replace(/\./g, "").length),
        }))
      : [],
  );
  const filteredExtensions = $derived(
    extensionMetadata.filter((item) =>
      `${item.name} ${item.id}`
        .toLowerCase()
        .includes(search.trim().toLowerCase()),
    ),
  );
  const visibleAudioAssets = $derived(project?.audioAssets ?? []);
  const visibleImageAssets = $derived(project?.imageAssets ?? []);
  const opaqueImageAssets = $derived(
    visibleImageAssets.filter(
      (asset) => asset.available && asset.transparent === false,
    ),
  );
  const opaqueImagesAreJpg = $derived(
    opaqueImageAssets.length > 0 &&
      opaqueImageAssets.every((asset) => imageFormats[asset.key] === "jpg"),
  );
  const chartData = $derived(getChartData());
  const chartTotal = $derived(
    chartData.reduce((sum, item) => sum + item.value, 0),
  );
  const compact = $derived(Boolean(project) && !loading);
  const chartOptions = ["Categories", "Sprites", "Media", "Extensions"];
  const bitrateOptions = [128, 160, 192, 224, 256, 320];
  const chartColors = [
    "#4C97FF",
    "#9966FF",
    "#CF63CF",
    "#FFBF00",
    "#FFAB19",
    "#5CB1D6",
    "#59C059",
    "#FF8C1A",
    "#FF661A",
    "#FF6680",
    "#2BBE8C",
    "#758195",
  ];

  $effect(() => {
    const canvas = pieCanvas;
    const items = chartData;
    const total = chartTotal;
    if (!canvas) {
      pieChart?.destroy();
      pieChart = undefined;
      clearPieTooltip();
      return;
    }
    if (pieChart && pieChart.canvas !== canvas) {
      pieChart.destroy();
      pieChart = undefined;
    }

    const sliceBorder =
      getComputedStyle(document.documentElement)
        .getPropertyValue("--md-sys-color-surface-container-low")
        .trim() || "#ffffff";
    const data = {
      labels: items.map((item) => item.label),
      datasets: [
        {
          data: items.map((item) => item.value),
          backgroundColor: items.map((item) => item.chartColor ?? item.color),
          borderColor: sliceBorder,
          borderWidth: 1,
          hoverBorderWidth: 1,
          hoverOffset: 7,
        },
      ],
    };
    const externalTooltip = (context) =>
      updatePieTooltip(context.chart, context.tooltip, items, total);

    if (!pieChart) {
      pieChart = new Chart(canvas, {
        type: "pie",
        data,
        options: {
          responsive: true,
          maintainAspectRatio: false,
          devicePixelRatio: window.devicePixelRatio || 1,
          animation: {
            duration: 480,
            easing: "easeOutQuart",
            animateRotate: true,
            animateScale: true,
          },
          interaction: { mode: "nearest", intersect: true },
          events: ["mousemove", "mouseout", "click", "touchstart", "touchmove"],
          onHover: (event, activeElements) => {
            if (event.native?.type?.startsWith("touch"))
              pieTooltipPinned = activeElements.length > 0;
            else if (event.native?.type === "mousemove")
              pieTooltipPinned = false;
          },
          plugins: {
            legend: { display: false },
            tooltip: {
              enabled: false,
              external: externalTooltip,
              callbacks: {
                label: (context) => {
                  const value = Number(context.raw) || 0;
                  const percent = total
                    ? ((value / total) * 100).toFixed(1)
                    : "0.0";
                  return `${formatNumber(value)} (${percent}%)`;
                },
              },
            },
          },
        },
      });
      return;
    }

    pieChart.data = data;
    pieChart.options.plugins.tooltip.external = externalTooltip;
    pieChart.options.plugins.tooltip.callbacks.label = (context) => {
      const value = Number(context.raw) || 0;
      const percent = total ? ((value / total) * 100).toFixed(1) : "0.0";
      return `${formatNumber(value)} (${percent}%)`;
    };
    pieChart.update();
  });

  onDestroy(() => {
    animatedStats.set(animatedStats.current, { duration: 0 });
    pieChart?.destroy();
    projectWorker?.terminate();
    conversionWorker?.terminate();
  });

  function getChartData() {
    if (!project) return [];
    if (activeChart === "Sprites")
      return project.targetStats
        .filter((target) => !target.isStage)
        .slice()
        .sort((a, b) => b.blocks - a.blocks)
        .slice(0, 10)
        .map((target) => {
          const color = spriteColors[target.index];
          return {
            label: target.name,
            value: target.blocks,
            color: color ?? "#758195",
          };
        });
    if (activeChart === "Media")
      return [
        { label: "Costumes", value: project.costumes, color: chartColors[1] },
        { label: "Sounds", value: project.sounds, color: chartColors[2] },
        { label: "Fonts", value: project.fonts, color: chartColors[5] },
      ];
    if (activeChart === "Extensions")
      return project.extensionStats
        .slice()
        .sort((a, b) => b.value - a.value)
        .slice(0, 10)
        .map((item) => {
          const metadata = extensionMetadata.find(
            (extension) => extension.id === item.label,
          );
          return {
            ...item,
            label: metadata?.name ?? humanizeExtensionId(item.label),
            color: metadata?.color ?? "#2BBE8C",
          };
        });
    return project.categories;
  }

  function setPieTooltipPosition(event, snap = false) {
    pieTooltipTarget = {
      x: Math.max(8, Math.min(event.clientX + 14, window.innerWidth - 190)),
      y: Math.max(8, Math.min(event.clientY + 14, window.innerHeight - 90)),
    };
    if (snap) pieTooltipPosition = { ...pieTooltipTarget };
    if (!pieTooltipFrame)
      pieTooltipFrame = requestAnimationFrame(animatePieTooltip);
  }

  function animatePieTooltip() {
    const x =
      pieTooltipPosition.x + (pieTooltipTarget.x - pieTooltipPosition.x) * 0.22;
    const y =
      pieTooltipPosition.y + (pieTooltipTarget.y - pieTooltipPosition.y) * 0.22;
    pieTooltipPosition = { x, y };
    if (
      Math.abs(pieTooltipTarget.x - x) > 0.5 ||
      Math.abs(pieTooltipTarget.y - y) > 0.5
    )
      pieTooltipFrame = requestAnimationFrame(animatePieTooltip);
    else pieTooltipFrame = 0;
  }

  function showPieTooltip(event, item) {
    const isFirstShow = !pieTooltip;
    pieTooltip = { ...item, percent: (item.share * 100).toFixed(1) };
    setPieTooltipPosition(event, isFirstShow);
  }

  function updatePieTooltip(chart, tooltip, items, total) {
    if (!tooltip || tooltip.opacity === 0) {
      if (!pieTooltipPinned) pieTooltip = null;
      return;
    }
    const point = tooltip.dataPoints?.[0];
    const item = point && items[point.dataIndex];
    if (!item) return;
    const rect = chart.canvas.getBoundingClientRect();
    showPieTooltip(
      {
        clientX: rect.left + tooltip.caretX,
        clientY: rect.top + tooltip.caretY,
      },
      { ...item, share: total ? item.value / total : 0 },
    );
  }

  function clearPieTooltip() {
    pieTooltipPinned = false;
    pieTooltip = null;
  }

  function handleChartTab(event) {
    const option = chartOptions[event.currentTarget.activeTabIndex];
    if (option && option !== activeChart) selectChart(option);
  }

  function setAudioSelected(key, checked) {
    clearConvertedDownload();
    selectedAssets = checked
      ? [...selectedAssets.filter((item) => item !== key), key]
      : selectedAssets.filter((item) => item !== key);
  }

  function setImageSelected(key, checked) {
    clearConvertedDownload();
    selectedImages = checked
      ? [...selectedImages.filter((item) => item !== key), key]
      : selectedImages.filter((item) => item !== key);
  }

  function selectChart(option) {
    activeChart = option;
    clearPieTooltip();
    if (option === "Sprites") void loadSpriteColors();
  }

  function loadSpriteColors() {
    if (project) spriteColors = project.spriteColors ?? {};
  }

  function formatNumber(value) {
    return String(Math.round(Number(value) || 0)).replace(
      /\B(?=(\d{3})+(?!\d))/g,
      ".",
    );
  }

  function animateStats(analyzed) {
    animatedStats.set({ ...initialStats }, { duration: 0 });
    animatedStats.set({
      blocks: analyzed.blocks,
      scripts: analyzed.scripts,
      sprites: analyzed.sprites,
      extensions: analyzed.extensions.length,
      media: analyzed.costumes + analyzed.sounds,
    });
  }

  function formatBytes(bytes) {
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
    if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  function setError(message = "") {
    error = message;
  }

  function showToast(message) {
    toast = message;
    setTimeout(() => (toast = ""), 2400);
  }

  async function handleProjectInput(event) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    await loadProject(file);
  }

  async function loadProject(file) {
    if (!file) return;
    const loadId = ++activeLoadId;
    cancelActiveLoad?.();
    projectWorker?.terminate();
    loading = true;
    loadProgress = 0;
    loadStatus = "Starting project loader...";
    error = "";
    let worker;
    try {
      const extension = file.name.split(".").pop().toLowerCase();
      if (!["sb3", "pmp"].includes(extension))
        throw new Error("must be .sb3 or .pmp");
      const result = await new Promise((resolve, reject) => {
        worker = new Worker(new URL("./project.worker.js", import.meta.url), {
          type: "module",
        });
        projectWorker = worker;
        cancelActiveLoad = () => reject(new Error("project loading was cancelled"));
        worker.onmessage = ({ data: message }) => {
          if (message.id !== loadId) return;
          if (message.type === "progress") {
            loadProgress = message.value;
            loadStatus = message.status;
          } else if (message.type === "complete") {
            resolve(message);
          } else if (message.type === "error") {
            reject(new Error(message.message));
          }
        };
        worker.onerror = (event) =>
          reject(new Error(event.message || "couldn't load this project"));
        worker.postMessage({ type: "load", file, id: loadId });
      });
      if (loadId !== activeLoadId) return;
      const analyzed = { ...result.project, file, spriteColors: result.spriteColors };
      if (originalUrl) URL.revokeObjectURL(originalUrl);
      if (packagedUrl) URL.revokeObjectURL(packagedUrl);
      originalUrl = URL.createObjectURL(file);
      packagedUrl = "";
      packagedName = "";
      selectedAssets = [];
      selectedImages = [];
      imageFormats = {};
      spriteColors = result.spriteColors ?? {};
      animateStats(analyzed);
      project = analyzed;
      void loadExtensionMetadata(
        analyzed.extensions,
        analyzed.data.extensionURLs ?? {},
      );
      activeChart = "Categories";
      search = "";
      showToast(`Opened ${file.name}`);
    } catch (exception) {
      if (loadId === activeLoadId)
        error = exception.message || "couldn't read this project file";
    } finally {
      worker?.terminate();
      if (projectWorker === worker) projectWorker = null;
      if (loadId === activeLoadId) {
        cancelActiveLoad = null;
        loading = false;
        loadStatus = "";
      }
    }
  }

  async function loadExtensionMetadata(extensionIds, extensionURLs) {
    const lookupId = ++extensionLookupId;
    extensionLookupBusy = true;
    const vmSource =
      project.extension.toLowerCase() === "pmp" ? "penguinmod" : "scratch";
    extensionMetadata = createExtensionMetadata(
      extensionIds,
      extensionURLs,
      vmSource,
    );
    const results = await lookUpExtensionMetadata(
      extensionIds,
      extensionURLs,
      vmSource,
    );
    if (lookupId !== extensionLookupId) return;
    extensionMetadata = results;
    extensionLookupBusy = false;
  }

  function handleProjectDrop(event) {
    event.preventDefault();
    dragOver = false;
    loadProject(event.dataTransfer.files[0]);
  }

  function clearConvertedDownload() {
    if (packagedUrl) URL.revokeObjectURL(packagedUrl);
    packagedUrl = "";
    packagedName = "";
    conversionResults = null;
  }

  function selectAllImages() {
    clearConvertedDownload();
    selectedImages =
      selectedImages.length ===
      visibleImageAssets.filter((asset) => asset.available).length
        ? []
        : visibleImageAssets
            .filter((asset) => asset.available)
            .map((asset) => asset.key);
  }

  function toggleOpaqueImagesFormat() {
    if (!opaqueImageAssets.length) return;
    clearConvertedDownload();
    const useJpg = !opaqueImagesAreJpg;
    const formats = { ...imageFormats };
    for (const asset of opaqueImageAssets)
      formats[asset.key] = useJpg ? "jpg" : "png";
    imageFormats = formats;
  }

  function selectAllAudio() {
    clearConvertedDownload();
    selectedAssets =
      selectedAssets.length ===
      visibleAudioAssets.filter((asset) => asset.available).length
        ? []
        : visibleAudioAssets
            .filter((asset) => asset.available)
            .map((asset) => asset.key);
  }

  async function convertSelectedAssets() {
    if (
      !project?.hasArchive ||
      (!selectedAssets.length && !selectedImages.length) ||
      converting
    )
      return;
    converting = true;
    error = "";
    conversionProgress = 0;
    conversionStatus = "Starting conversion...";
    const conversionId = Date.now();
    let errorAssetNames = [...selectedAssets, ...selectedImages];
    let worker;
    try {
      const audioAssets = selectedAssets.map((key) =>
        visibleAudioAssets.find((asset) => asset.key === key),
      );
      const imageAssets = selectedImages.map((key) =>
        visibleImageAssets.find((asset) => asset.key === key),
      );
      errorAssetNames = [
        ...audioAssets.map((asset, index) => asset?.name || selectedAssets[index]),
        ...imageAssets.map((asset, index) => asset?.name || selectedImages[index]),
      ];
      if (audioAssets.some((asset) => !asset) || imageAssets.some((asset) => !asset))
        throw new Error("a selected asset is no longer available");
      const result = await new Promise((resolve, reject) => {
        worker = new Worker(new URL("./conversion.worker.js", import.meta.url), {
          type: "module",
        });
        conversionWorker = worker;
        worker.onmessage = ({ data: message }) => {
          if (message.id !== conversionId) return;
          if (message.type === "progress") {
            conversionProgress = message.value;
            conversionStatus = message.status;
          } else if (message.type === "complete") resolve(message);
          else if (message.type === "error") reject(new Error(message.message));
        };
        worker.onerror = (event) =>
          reject(new Error(event.message || "couldn't convert the selected assets"));
        worker.postMessage({
          type: "convert",
          id: conversionId,
          file: project.file,
          audioAssets: JSON.parse(JSON.stringify(audioAssets)),
          imageAssets: JSON.parse(JSON.stringify(imageAssets)),
          imageFormats: JSON.parse(JSON.stringify(imageFormats)),
          bitrate,
        });
      });
      const { blob, changes } = result;
      if (packagedUrl) URL.revokeObjectURL(packagedUrl);
      packagedUrl = URL.createObjectURL(blob);
      packagedName = `${project.name}-converted.${project.extension}`;
      conversionResults = {
        overall: getSavingsPercent(project.size, blob.size),
        before: project.size,
        after: blob.size,
        assets: changes,
      };
    } catch (exception) {
      const message =
        exception.message ||
        "something went wrong while converting the selected assets";
      const names = errorAssetNames.filter(Boolean);
      const hasAssetName =
        names.some((name) => message.endsWith(`(${name})`)) ||
        message.endsWith(`(${names.join(", ")})`);
      error = hasAssetName
        ? message
        : `${message} (${names.join(", ") || "selected assets"})`;
    } finally {
      worker?.terminate();
      if (conversionWorker === worker) conversionWorker = null;
      converting = false;
      conversionStatus = "";
    }
  }

  function getSavingsPercent(before, after) {
    return before ? ((before - after) / before) * 100 : 0;
  }

  function formatSavings(percent) {
    return `${Math.abs(percent).toFixed(1)}%`;
  }
</script>

<svelte:head>
  <title>{project ? `${project.name} - Blokko` : "Blokko"}</title>
</svelte:head>

{#snippet digits(value)}
  {#each Array.from(String(value)) as char}<span class:one={char === "1"}>{char}</span>{/each}
{/snippet}

<div class="app-shell">
  <main id="top">
    <header class="top-app-bar">
      <div>
        <h1
          class="app-name {compact
            ? 'md-typescale-headline-large'
            : 'md-typescale-display-large'}"
        >
          Blokko
        </h1>
        <p class="tagline md-typescale-body-large">
          Take a looksie inside your TurboWarp or PenguinMod projects!
        </p>
      </div>
      {#if compact}
        <md-filled-tonal-button onclick={() => fileInput?.click()}>
          <md-icon slot="icon">refresh</md-icon>Choose another file
        </md-filled-tonal-button>
      {/if}
    </header>

    <input
      bind:this={fileInput}
      class="file-input"
      type="file"
      accept=".sb3,.pmp"
      onchange={handleProjectInput}
    />
    {#if loading || !project}
      <section
        class:dragOver
        class="upload-panel"
        aria-label="Drop zone"
        ondragover={(event) => {
          event.preventDefault();
          dragOver = true;
        }}
        ondragleave={() => (dragOver = false)}
        ondrop={handleProjectDrop}
      >
        <md-outlined-card>
          {#if loading}
            <h2 class="md-typescale-headline-small">Getting your project ready</h2>
            <p class="md-typescale-body-large">{loadStatus}</p>
            <div class="progress-row">
              <md-linear-progress
                value={loadProgress / 100}
                aria-label="Project loading progress"
              ></md-linear-progress>
              <strong class="progress-label md-typescale-label-large">
                {Math.round(loadProgress)}%
              </strong>
            </div>
          {:else}
            <div class="glyph"><md-icon>upload_file</md-icon></div>
            <h2 class="md-typescale-headline-small">Drop a project file here</h2>
            <p class="md-typescale-body-large">
              Choose a TurboWarp or PenguinMod project to inspect!
            </p>
            <md-filled-button onclick={() => fileInput?.click()}>
              <md-icon slot="icon">upload</md-icon>Choose project
            </md-filled-button>
            <span class="format-hint md-typescale-body-small">
              Supports .sb3 and .pmp files :)
            </span>
          {/if}
        </md-outlined-card>
      </section>
    {:else}
      <section class="file-summary">
        <div class="file-description">
          <h2 class="md-typescale-headline-medium">{project.name}</h2>
          <p class="muted md-typescale-body-large">
            {project.platform}
            -
            {formatBytes(project.size)}
          </p>
        </div>
        <md-outlined-button href={originalUrl} download={project.filename}>
          <md-icon slot="icon">download</md-icon>Download original
          <span class="ext">.{project.extension}</span>
        </md-outlined-button>
      </section>

      <md-filled-card
        class="stats-rail"
        role="group"
        aria-label="Project statistics"
      >
        <md-list>
          {#each stats as item, index}
            {#if index > 0}<md-divider></md-divider>{/if}
            <md-list-item>
              <div slot="headline" class="stat-row">
                <div class="stat-copy">
                  <div class="md-typescale-title-small">{item.label}</div>
                  <div class="md-typescale-body-medium">
                    {#if item.label === "Media assets"}
                      {project.costumes} costumes
                      and
                      {project.sounds} sounds
                    {:else}
                      {item.detail}
                    {/if}
                  </div>
                </div>
                <span
                  class="stat-counter-slot"
                  style={`--stat-digits: ${item.digits}`}
                >
                  <strong class="stat-value numbers">
                    {@render digits(formatNumber(animatedStats.current[item.key] ?? item.value))}
                  </strong>
                </span>
              </div>
            </md-list-item>
          {/each}
        </md-list>
      </md-filled-card>

      <section class="content-grid">
        <md-filled-card class="chart-surface">
          <div class="section-heading">
            <h2 class="md-typescale-title-large">Block and asset counts</h2>
          </div>
          <md-tabs aria-label="Chart data" onchange={handleChartTab}>
            {#each chartOptions as option}
              <md-primary-tab active={activeChart === option}>
                {option}
              </md-primary-tab>
            {/each}
          </md-tabs>
          <div class="chart" aria-label={`${activeChart} pie chart`}>
            <div class="chart-stage">
              {#if chartTotal > 0}
                <div class="pie-chart-box">
                  <canvas
                    bind:this={pieCanvas}
                    class="pie-canvas"
                    aria-label={`${activeChart}: ${chartData.map((item) => `${item.label} ${item.value}`).join(", ")}`}
                  >
                    {activeChart} pie chart
                  </canvas>
                </div>
                <md-list class="legend">
                  {#each chartData as item}
                    <md-list-item title={`${item.label}: ${item.value}`}>
                      <span
                        slot="start"
                        class="swatch"
                        style={`--swatch:${item.color}`}
                      ></span>
                      <div slot="headline" class="ellipsis">{item.label}</div>
                      <span
                        slot="trailing-supporting-text"
                        class="legend-value md-typescale-label-large"
                      >
                        {formatNumber(item.value)}
                      </span>
                    </md-list-item>
                  {/each}
                </md-list>
              {:else}
                <div class="empty-chart md-typescale-body-large">
                  No {activeChart.toLowerCase()} to display.
                </div>
              {/if}
            </div>
          </div>
          <div class="chart-footer md-typescale-body-small">
            {activeChart === "Categories"
              ? `${formatNumber(project.blocks)} block records across ${project.targets.length} targets`
              : `${formatNumber(chartTotal)} total`}
          </div>
        </md-filled-card>

        <md-outlined-card class="detail-card">
          <div class="section-heading">
            <h2 class="md-typescale-title-large">At a glance</h2>
          </div>
          <dl class="details-list">
            <div>
              <dt class="md-typescale-label-medium">Variables</dt>
              <dd class="md-typescale-title-large">{project.variables}</dd>
            </div>
            <div>
              <dt class="md-typescale-label-medium">Lists</dt>
              <dd class="md-typescale-title-large">{project.lists}</dd>
            </div>
            <div>
              <dt class="md-typescale-label-medium">Custom fonts</dt>
              <dd class="md-typescale-title-large">{project.fonts}</dd>
            </div>
            <div>
              <dt class="md-typescale-label-medium">Stage</dt>
              <dd class="md-typescale-title-large">{project.stageSize}</dd>
            </div>
          </dl>
          <md-divider></md-divider>
          <div class="extension-title">
            <span class="md-typescale-title-medium">Extensions</span>
            <span class="count-badge md-typescale-label-medium">
              {project.extensions.length}
            </span>
          </div>
          <md-outlined-text-field
            class="extension-search"
            label="Filter extensions"
            placeholder="Filter by name or ID"
            value={search}
            oninput={(event) => (search = event.currentTarget.value)}
          >
            <md-icon slot="leading-icon">search</md-icon>
            {#if search}
              <md-icon-button
                slot="trailing-icon"
                aria-label="Clear filter"
                onclick={() => (search = "")}
              >
                <md-icon>close</md-icon>
              </md-icon-button>
            {/if}
          </md-outlined-text-field>
          <md-list class="extension-list">
            {#each filteredExtensions as extension}
              <md-list-item title={extension.reason ?? extension.source}>
                <span
                  slot="start"
                  class="swatch"
                  style={`--swatch:${extension.color}`}
                ></span>
                <div slot="headline" class="ellipsis">{extension.name}</div>
                <div slot="supporting-text" class="ellipsis">
                  {extension.id}
                  {getExtensionSourceLabel(extension)}
                </div>
              </md-list-item>
            {/each}
            {#if filteredExtensions.length === 0}
              <span class="empty-extension md-typescale-body-large">
                {search ? "No matching extensions." : "This project has no extensions."}
              </span>
            {/if}
          </md-list>
        </md-outlined-card>
      </section>
    {/if}

    {#if project && !loading}
      <md-outlined-card class="asset-card">
        <div class="section-heading">
          <div>
            <h2 class="md-typescale-title-large">Convert WAVs to MP3s</h2>
          </div>
        </div>
        {#if visibleAudioAssets.length}
          <div class="toolbar">
            <md-text-button disabled={converting} onclick={selectAllAudio}>
              {selectedAssets.length ===
              visibleAudioAssets.filter((asset) => asset.available).length
                ? "Clear selection"
                : "Select all"}
            </md-text-button>
            <span class="selected-count md-typescale-label-large">
              {selectedAssets.length} selected
            </span>
          </div>
          <div class="table-wrap">
            <table class="data-table">
              <thead class="md-typescale-label-large">
                <tr>
                  <th class="check-cell"></th>
                  <th>Sound</th>
                  <th>Target</th>
                  <th>Length</th>
                  <th>Format</th>
                  <th>Filename</th>
                </tr>
              </thead>
              <tbody class="md-typescale-body-medium">
                {#each visibleAudioAssets as asset}
                  <tr class:selected={selectedAssets.includes(asset.key)}>
                    <td class="check-cell">
                      <md-checkbox
                        checked={selectedAssets.includes(asset.key)}
                        disabled={converting || !asset.available}
                        onchange={(event) =>
                          setAudioSelected(asset.key, event.currentTarget.checked)}
                        aria-label={`Select ${asset.name}`}
                      ></md-checkbox>
                    </td>
                    <td class="asset-label">{asset.name}</td>
                    <td>{asset.target}</td>
                    <td>
                      {asset.samples && asset.rate
                        ? `${(asset.samples / asset.rate).toFixed(1)} s`
                        : "-"}
                    </td>
                    <td>
                      <span class="format-tag md-typescale-label-medium">WAV</span>
                    </td>
                    <td class:missing={!asset.available} class="asset-name">
                      {asset.available ? asset.filename : "Missing from project, somehow"}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          <div class="conversion-footer">
            <md-outlined-select
              class="bitrate-select"
              label="MP3 bitrate"
              menu-positioning="popover"
              value={String(bitrate)}
              onchange={(event) => {
                bitrate = Number(event.currentTarget.value);
                clearConvertedDownload();
              }}
            >
              {#each bitrateOptions as quality}
                <md-select-option
                  value={String(quality)}
                  selected={quality === bitrate}
                >
                  <div slot="headline">{quality} kbps</div>
                </md-select-option>
              {/each}
            </md-outlined-select>
          </div>
        {:else}
          <div class="empty-asset-panel md-typescale-body-large">
            <md-icon>graphic_eq</md-icon>
            <span>This project has no WAV sound assets.</span>
          </div>
        {/if}
      </md-outlined-card>
    {/if}

    {#if project && !loading}
      <md-outlined-card class="asset-card">
        <div class="section-heading">
          <div>
            <h2 class="md-typescale-title-large">Optimize PNGs</h2>
          </div>
        </div>
        {#if visibleImageAssets.length}
          <div class="toolbar">
            <md-text-button disabled={converting} onclick={selectAllImages}>
              {selectedImages.length ===
              visibleImageAssets.filter((asset) => asset.available).length
                ? "Clear selection"
                : "Select all"}
            </md-text-button>
            <div class="switch-row">
              <md-switch
                id="opaque-images-jpg"
                selected={opaqueImagesAreJpg}
                disabled={converting || !opaqueImageAssets.length}
                onchange={toggleOpaqueImagesFormat}
              ></md-switch>
              <label class="md-typescale-label-large" for="opaque-images-jpg">
                Set opaque images to JPG
              </label>
            </div>
            <span class="selected-count md-typescale-label-large">
              {selectedImages.length} selected
            </span>
          </div>
          <div class="table-wrap">
            <table class="data-table image-table">
              <thead class="md-typescale-label-large">
                <tr>
                  <th class="check-cell"></th>
                  <th>Costume</th>
                  <th>Sprite</th>
                  <th>Transparency</th>
                  <th>Output</th>
                  <th>Filename</th>
                </tr>
              </thead>
              <tbody class="md-typescale-body-medium">
                {#each visibleImageAssets as asset}
                  <tr class:selected={selectedImages.includes(asset.key)}>
                    <td class="check-cell">
                      <md-checkbox
                        checked={selectedImages.includes(asset.key)}
                        disabled={converting || !asset.available}
                        onchange={(event) =>
                          setImageSelected(asset.key, event.currentTarget.checked)}
                        aria-label={`Select ${asset.name}`}
                      ></md-checkbox>
                    </td>
                    <td class="asset-label">{asset.name}</td>
                    <td>{asset.target}</td>
                    <td>
                      {asset.transparent === null
                        ? "Checking..."
                        : asset.transparent
                          ? "Transparent"
                          : "Opaque"}
                    </td>
                    <td>
                      <md-outlined-select
                        class="image-format"
                        menu-positioning="popover"
                        value={imageFormats[asset.key] ?? "png"}
                        disabled={converting || asset.transparent !== false}
                        aria-label={`Output format for ${asset.name}`}
                        onchange={(event) => {
                          imageFormats[asset.key] = event.currentTarget.value;
                          clearConvertedDownload();
                        }}
                      >
                        <md-select-option
                          value="png"
                          selected={(imageFormats[asset.key] ?? "png") === "png"}
                        >
                          <div slot="headline">Optimized PNG</div>
                        </md-select-option>
                        {#if asset.transparent === false}
                          <md-select-option
                            value="jpg"
                            selected={imageFormats[asset.key] === "jpg"}
                          >
                            <div slot="headline">JPG</div>
                          </md-select-option>
                        {/if}
                      </md-outlined-select>
                    </td>
                    <td class:missing={!asset.available} class="asset-name">
                      {asset.available ? asset.filename : "Missing from project, somehow"}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          <div class="conversion-footer">
            <span class="image-note md-typescale-body-medium">
              Transparent pixels are kept when optimizing PNGs, but not when converting to JPG.
            </span>
          </div>
        {:else}
          <div class="empty-asset-panel md-typescale-body-large">
            <md-icon>image</md-icon>
            <span>This project has no PNG costume images.</span>
          </div>
        {/if}
      </md-outlined-card>
    {/if}

    {#if project && !loading}
      <md-filled-card class="convert-card">
        <div class="convert-copy">
          <h2 class="md-typescale-title-large">Optimized project goes here...</h2>
          <p class="md-typescale-body-medium">
            Pick the optimizations you want to apply, then convert and package the optimized version!
          </p>
        </div>
        {#if packagedUrl}
          <md-filled-button href={packagedUrl} download={packagedName}>
            <md-icon slot="icon">download</md-icon>Download converted project
          </md-filled-button>
        {:else}
          <md-filled-button
            disabled={!project.hasArchive ||
              (!selectedAssets.length && !selectedImages.length) ||
              converting}
            onclick={convertSelectedAssets}
          >
            {#if converting}Converting and packaging...{:else}<md-icon slot="icon">auto_fix_high</md-icon>Optimize{/if}
          </md-filled-button>
        {/if}
        {#if converting}
          <div class="convert-progress">
            <p class="md-typescale-body-medium">{conversionStatus}</p>
            <div class="progress-row">
              <md-linear-progress
                value={conversionProgress / 100}
                aria-label="Asset conversion progress"
              ></md-linear-progress>
              <strong class="progress-label md-typescale-label-large">
                {Math.round(conversionProgress)}%
              </strong>
            </div>
          </div>
        {/if}
        {#if conversionResults}
          <div class="results">
            <div class="results-overall">
              <span class="md-typescale-label-large">Project size</span>
              <strong
                class="md-typescale-headline-small"
                class:win-loss={conversionResults.overall < 0}
              >
                {formatSavings(conversionResults.overall)}
                {conversionResults.overall >= 0 ? "smaller" : "larger"}
              </strong>
              <small class="md-typescale-body-small">
                {formatBytes(conversionResults.before)} to {formatBytes(conversionResults.after)}
              </small>
            </div>
            <md-list class="results-assets">
              {#each conversionResults.assets as item}
                <md-list-item>
                  <div slot="headline" class="ellipsis">{item.name}</div>
                  <strong
                    slot="trailing-supporting-text"
                    class="md-typescale-label-large"
                    class:win-loss={item.savings < 0}
                  >
                    {formatSavings(item.savings)} {item.savings >= 0 ? "smaller" : "larger"}
                  </strong>
                </md-list-item>
              {/each}
            </md-list>
          </div>
        {/if}
      </md-filled-card>
    {/if}

    {#if error}
      <div class="error-message md-typescale-body-medium" role="alert">
        <md-icon>error</md-icon>
        <span class="error-text">{error}</span>
        <md-icon-button aria-label="Dismiss message" onclick={() => (error = "")}>
          <md-icon>close</md-icon>
        </md-icon-button>
      </div>
    {/if}
    <footer class="md-typescale-body-small">
      <md-divider></md-divider>
      <p>
        Made with ❤️ by <a
          href="https://gen1xlol.github.io/"
          target="_blank"
          rel="noopener noreferrer"
        >
          Gen1x
        </a>.
      </p>
    </footer>
  </main>

  {#if toast}
    <div class="toast md-typescale-body-medium" role="status">
      <md-icon>check</md-icon>{toast}
    </div>
  {/if}
</div>
{#if pieTooltip}
  <div
    class="pie-tooltip md-typescale-label-large"
    role="status"
    aria-live="polite"
    style={`--tooltip-x:${pieTooltipPosition.x}px;--tooltip-y:${pieTooltipPosition.y}px;--tooltip-color:${pieTooltip.color}`}
  >
    <span></span><strong>{pieTooltip.label}</strong><b class="md-typescale-title-small">
      {formatNumber(pieTooltip.value)}
    </b><small class="md-typescale-label-small">{pieTooltip.percent}%</small>
  </div>
{/if}
