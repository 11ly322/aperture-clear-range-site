(function () {
  "use strict";

  const Optics = window.Optics;
  if (!Optics) {
    return;
  }

  const APERTURES = Optics.APERTURE_STOPS;
  const DEFAULTS = {
    apertureIndex: 3,
    focusM: 2.8,
    subjectIndex: 0,
  };
  const SUBJECTS = Object.freeze([
    { name: "近处", depthM: 2.0, color: "#ff9b7a" },
    { name: "主体", depthM: 2.8, color: "#eef2df" },
    { name: "远处", depthM: 4.5, color: "#7fc7ff" },
  ]);
  const SCENE_MIN = Optics.DEFAULTS.sceneMinM;
  const SCENE_MAX = Optics.DEFAULTS.sceneMaxM;
  const FOCUS_MIN = Optics.DEFAULTS.focusMinM;
  const FOCUS_MAX = Optics.DEFAULTS.focusMaxM;
  const COC_LIMIT = Optics.DEFAULTS.cocLimitMm;

  const C = {
    accent: "#d9ff73",
    ink: "#f2f4e9",
    inkSoft: "#cdd3c5",
    muted: "#929c8f",
    faint: "#7f8a7b",
    grid: "rgba(232, 242, 222, 0.055)",
    line: "rgba(232, 242, 222, 0.14)",
    lineSoft: "rgba(232, 242, 222, 0.08)",
    background: "#090d0a",
    sensor: "#a7e6cb",
  };

  const FONT_SANS =
    '"Aptos", "Segoe UI", "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif';
  const FONT_MONO =
    '"Cascadia Mono", "SFMono-Regular", "Consolas", "Liberation Mono", monospace';

  const byId = (id) => document.getElementById(id);
  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
  const canvas = byId("rayCanvas");
  const ctx = canvas ? canvas.getContext("2d") : null;

  const el = {
    apertureRange: byId("apertureRange"),
    focusRange: byId("focusRange"),
    fStopOutput: byId("fStopOutput"),
    focusOutput: byId("focusOutput"),
    dofTotal: byId("dofTotal"),
    nearLimit: byId("nearLimit"),
    farLimit: byId("farLimit"),
    dofState: byId("dofState"),
    blurPanel: byId("blurPanel"),
    blurState: byId("blurState"),
    blurValue: byId("blurValue"),
    blurExplainer: byId("blurExplainer"),
    fValue: document.querySelector(".f-value"),
    dofHero: document.querySelector(".dof-hero"),
    techDiameter: byId("techDiameter"),
    techImage: byId("techImage"),
    techFocusImage: byId("techFocusImage"),
    techHyperfocal: byId("techHyperfocal"),
    trackedName: byId("trackedName"),
    canvasSummary: byId("canvasSummary"),
    resetButton: byId("resetButton"),
    subjectButtons: Array.from(document.querySelectorAll("[data-subject]")),
    presetButtons: Array.from(document.querySelectorAll("[data-aperture-index]")),
  };

  const state = {
    apertureIndex: DEFAULTS.apertureIndex,
    focusM: DEFAULTS.focusM,
    subjectIndex: DEFAULTS.subjectIndex,
    hoverSubject: -1,
    draggingRail: false,
    pointerId: null,
  };

  const view = { width: 0, height: 0, dpr: 1 };
  let layout = null;
  let queuedFrame = 0;
  let announceTimer = 0;
  let uiReady = false;
  const lastUi = { f: null, dofTotal: null };
  const pulseTimers = new WeakMap();
  const pulseQueues = new WeakMap();

  const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  let prefersReducedMotion = motionQuery.matches;
  let motionTime = 0;
  let animationFrame = 0;
  let lastAnimationDraw = 0;
  let stageVisible = true;

  const liveRegion = document.createElement("p");
  liveRegion.className = "sr-only";
  liveRegion.setAttribute("aria-live", "polite");
  document.body.appendChild(liveRegion);

  /* ————————————————————————————————
     Formatting
  ———————————————————————————————— */

  function formatFStop(fNumber) {
    return String(fNumber);
  }

  function formatMeters(value, digits = 2) {
    if (!Number.isFinite(value)) return "∞";
    if (value >= 100) return value.toFixed(0);
    if (value >= 10) return value.toFixed(1);
    return value.toFixed(digits);
  }

  function formatFocus(value) {
    return `${value.toFixed(1)} m`;
  }

  function formatBlur(value) {
    if (!Number.isFinite(value)) return "∞";
    return value < 0.005 ? "0.00" : value.toFixed(2);
  }

  function formatRatio(value) {
    if (!Number.isFinite(value)) return "∞";
    return value < 10 ? value.toFixed(1) : Math.round(value).toString();
  }

  function pulseElement(element) {
    if (!element || prefersReducedMotion) return;
    window.clearTimeout(pulseQueues.get(element));
    const queueTimer = window.setTimeout(() => {
      window.clearTimeout(pulseTimers.get(element));
      element.classList.remove("value-pulse");
      void element.offsetWidth;
      element.classList.add("value-pulse");
      const removeTimer = window.setTimeout(() => {
        element.classList.remove("value-pulse");
      }, 420);
      pulseTimers.set(element, removeTimer);
    }, 120);
    pulseQueues.set(element, queueTimer);
  }

  function dofStateLabel(dof) {
    if (!Number.isFinite(dof.totalM)) return "∞";
    if (dof.totalM < 0.25) return "很窄";
    if (dof.totalM < 0.6) return "窄";
    if (dof.totalM < 1.5) return "适中";
    if (dof.totalM < 4) return "宽";
    return "很宽";
  }

  function setRangeFill(input, percent) {
    input.style.setProperty("--fill", `${clamp(percent, 0, 100)}%`);
  }

  /* ————————————————————————————————
     UI sync
  ———————————————————————————————— */

  function syncUI() {
    const fNumber = APERTURES[state.apertureIndex];
    const subject = SUBJECTS[state.subjectIndex];
    const analysis = Optics.analyze(fNumber, state.focusM, subject.depthM);
    const dof = analysis;
    const isClear = analysis.blurMm <= COC_LIMIT;
    const isAtFocus = analysis.blurMm < 0.004;
    const imageMm = Optics.imageDistanceMm(subject.depthM);
    const focusImageMm = Optics.imageDistanceMm(state.focusM);

    el.fStopOutput.textContent = formatFStop(fNumber);
    el.focusOutput.textContent = formatFocus(state.focusM);
    el.dofTotal.textContent = Number.isFinite(dof.totalM)
      ? formatMeters(dof.totalM)
      : "∞";
    el.nearLimit.textContent = Number.isFinite(dof.nearM)
      ? `${formatMeters(dof.nearM)} m`
      : "∞";
    el.farLimit.textContent = Number.isFinite(dof.farM)
      ? `${formatMeters(dof.farM)} m`
      : "∞";
    el.dofState.textContent = dofStateLabel(dof);

    el.techDiameter.textContent = analysis.apertureDiameterMm.toFixed(1);
    el.techImage.textContent = imageMm.toFixed(2);
    el.techFocusImage.textContent = focusImageMm.toFixed(2);
    el.techHyperfocal.textContent = formatMeters(analysis.hyperfocalM);

    el.trackedName.textContent = subject.name;
    el.blurValue.textContent = formatBlur(analysis.blurMm);
    el.blurState.textContent = isClear ? "清晰" : "模糊";
    el.blurPanel.dataset.state = isClear ? "in" : "out";

    if (isAtFocus) {
      el.blurExplainer.textContent = "c ≈ 0：像点正好落在传感器上。";
    } else if (isClear) {
      el.blurExplainer.textContent = `c / c₀ = ${formatRatio(
        analysis.blurRatio
      )}，满足 c ≤ c₀。`;
    } else {
      el.blurExplainer.textContent = `c / c₀ = ${formatRatio(
        analysis.blurRatio
      )}，已经超出允许弥散圆。`;
    }

    if (uiReady) {
      if (lastUi.f !== fNumber) pulseElement(el.fValue);
      if (lastUi.dofTotal !== dof.totalM) pulseElement(el.dofHero);
    }
    lastUi.f = fNumber;
    lastUi.dofTotal = dof.totalM;

    const blurStrength = clamp(
      Number.isFinite(analysis.blurRatio) ? analysis.blurRatio : 20,
      0,
      20
    );
    const discSize = 8 + Math.sqrt(blurStrength) * 8;
    const discSoftness = clamp(analysis.blurRatio * 0.72, 0, 8);
    el.blurPanel.style.setProperty("--blur-color", subject.color);
    el.blurPanel.style.setProperty("--blur-size", `${discSize.toFixed(1)}px`);
    el.blurPanel.style.setProperty(
      "--blur-softness",
      `${discSoftness.toFixed(1)}px`
    );

    el.apertureRange.value = String(state.apertureIndex);
    el.focusRange.value = state.focusM.toFixed(1);
    setRangeFill(el.apertureRange, (state.apertureIndex / (APERTURES.length - 1)) * 100);
    setRangeFill(
      el.focusRange,
      ((state.focusM - FOCUS_MIN) / (FOCUS_MAX - FOCUS_MIN)) * 100
    );
    el.apertureRange.setAttribute(
      "aria-valuetext",
      `f/${formatFStop(fNumber)}，f 值越小，光圈开得越大`
    );
    el.focusRange.setAttribute(
      "aria-valuetext",
      `对焦距离 ${state.focusM.toFixed(1)} 米`
    );

    el.subjectButtons.forEach((button) => {
      const index = Number(button.dataset.subject);
      button.setAttribute("aria-pressed", String(index === state.subjectIndex));
    });

    el.presetButtons.forEach((button) => {
      button.classList.toggle(
        "is-active",
        Number(button.dataset.apertureIndex) === state.apertureIndex
      );
    });

    const bounds = Number.isFinite(analysis.farM)
      ? `${formatMeters(analysis.nearM)} 到 ${formatMeters(analysis.farM)} 米`
      : `${formatMeters(analysis.nearM)} 米到无限远`;
    const summary =
      `侧视光路示意图：50 毫米镜头把光会聚到传感器，允许弥散圆 0.03 毫米。现在光圈 f/${formatFStop(fNumber)}，` +
      `对焦 ${state.focusM.toFixed(1)} 米，景深从 ${bounds}。` +
      `正在观察${subject.name}，距离 ${subject.depthM.toFixed(1)} 米，` +
      `物理孔径 ${analysis.apertureDiameterMm.toFixed(1)} 毫米，弥散圆 ${formatBlur(analysis.blurMm)} 毫米，` +
      `约为允许值的 ${formatRatio(analysis.blurRatio)} 倍，${isClear ? "看起来清晰" : "看起来模糊"}。`;

    el.canvasSummary.textContent = summary;
    if (canvas) canvas.setAttribute("aria-label", summary);
  }

  function scheduleAnnouncement(delay = 260) {
    window.clearTimeout(announceTimer);
    announceTimer = window.setTimeout(() => {
      const fNumber = APERTURES[state.apertureIndex];
      const subject = SUBJECTS[state.subjectIndex];
      const analysis = Optics.analyze(fNumber, state.focusM, subject.depthM);
      const far = Number.isFinite(analysis.farM)
        ? `${formatMeters(analysis.farM)} 米`
        : "无限远";
      liveRegion.textContent =
        `光圈 f/${formatFStop(fNumber)}，对焦 ${state.focusM.toFixed(1)} 米。` +
        `景深 ${formatMeters(analysis.nearM)} 米到 ${far}。` +
        `${subject.name}的弥散圆 ${formatBlur(analysis.blurMm)} 毫米，` +
        `是允许值的 ${formatRatio(analysis.blurRatio)} 倍，` +
        `${analysis.blurMm <= COC_LIMIT ? "看起来清晰" : "看起来模糊"}。`;
    }, delay);
  }

  function refresh(announce = false) {
    syncUI();
    requestDraw();
    if (announce) scheduleAnnouncement(0);
  }

  /* ————————————————————————————————
     Canvas sizing and drawing
  ———————————————————————————————— */

  function requestDraw() {
    if (queuedFrame) return;
    queuedFrame = window.requestAnimationFrame(() => {
      queuedFrame = 0;
      draw();
    });
  }

  function resizeCanvas() {
    if (!canvas || !ctx) return;
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(280, Math.round(rect.width));
    const height = Math.max(320, Math.round(rect.height));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const pixelWidth = Math.round(width * dpr);
    const pixelHeight = Math.round(height * dpr);

    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    view.width = width;
    view.height = height;
    view.dpr = dpr;
    draw();
  }

  function initScrollProgress() {
    const progress = byId("scrollProgress");
    if (!progress) return;
    let ticking = false;

    const update = () => {
      ticking = false;
      const scrollable =
        document.documentElement.scrollHeight - window.innerHeight;
      const ratio =
        scrollable > 0
          ? Math.min(Math.max(window.scrollY / scrollable, 0), 1)
          : 0;
      progress.style.transform = `scaleX(${ratio.toFixed(4)})`;
    };

    const schedule = () => {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(update);
    };

    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule, { passive: true });
  }

  function initReveal() {
    if (prefersReducedMotion || !("IntersectionObserver" in window)) return;
    const selectors = [
      ".knowledge-heading",
      ".knowledge-card",
      ".conclusion-card",
      ".advanced-heading",
      ".adv-card",
      ".terms-board",
      ".derivation",
      ".advanced-note",
    ].join(",");

    const targets = Array.from(document.querySelectorAll(selectors)).filter(
      (element) => element.getBoundingClientRect().top > window.innerHeight * 0.86
    );
    if (!targets.length) return;

    targets.forEach((element, index) => {
      element.classList.add("reveal-target");
      element.style.setProperty(
        "--reveal-delay",
        `${Math.min((index % 4) * 80, 240)}ms`
      );
    });

    const observer = new IntersectionObserver(
      (entries, currentObserver) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("is-inview");
          currentObserver.unobserve(entry.target);
        });
      },
      { threshold: 0.05, rootMargin: "0px 0px -6% 0px" }
    );

    targets.forEach((element) => observer.observe(element));
  }

  function stopCanvasMotion() {
    if (animationFrame) {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = 0;
    }
  }

  function ensureCanvasMotion() {
    if (
      prefersReducedMotion ||
      !stageVisible ||
      document.hidden ||
      !canvas ||
      !ctx ||
      animationFrame
    ) {
      return;
    }
    animationFrame = window.requestAnimationFrame(runCanvasMotion);
  }

  function runCanvasMotion(timestamp) {
    animationFrame = 0;
    if (prefersReducedMotion || !stageVisible || document.hidden) {
      return;
    }
    if (timestamp - lastAnimationDraw >= 1000 / 30) {
      lastAnimationDraw = timestamp;
      motionTime = timestamp / 1000;
      draw();
    }
    animationFrame = window.requestAnimationFrame(runCanvasMotion);
  }

  function initCanvasMotion() {
    if (!canvas) return;

    if ("IntersectionObserver" in window) {
      const observer = new IntersectionObserver(
        (entries) => {
          stageVisible = entries[0]?.isIntersecting ?? true;
          if (stageVisible) {
            ensureCanvasMotion();
          } else {
            stopCanvasMotion();
          }
        },
        { threshold: 0.02 }
      );
      observer.observe(canvas.parentElement);
    }

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        stopCanvasMotion();
      } else {
        ensureCanvasMotion();
      }
    });

    const updateMotionPreference = (event) => {
      prefersReducedMotion = event.matches;
      if (prefersReducedMotion) {
        stopCanvasMotion();
        draw();
      } else {
        ensureCanvasMotion();
      }
    };

    if (typeof motionQuery.addEventListener === "function") {
      motionQuery.addEventListener("change", updateMotionPreference);
    } else if (typeof motionQuery.addListener === "function") {
      motionQuery.addListener(updateMotionPreference);
    }

    ensureCanvasMotion();
  }

  function computeLayout(width, height) {
    const compact = width < 620;
    const railHeight = compact ? 94 : 108;
    const railTop = height - railHeight;
    const mainTop = compact ? 14 : 24;
    const mainBottom = railTop - (compact ? 8 : 12);
    const axisY = mainTop + (mainBottom - mainTop) * 0.55;
    const lensX = width * (compact ? 0.665 : 0.645);
    const sensorX = lensX + (width - lensX) * 0.56;
    const sceneLeft = compact ? 22 : 42;
    const sceneRight = lensX - (compact ? 76 : 108);
    const span = mainBottom - mainTop;
    const sensorHalf = Math.min(compact ? 105 : 148, span * 0.4);
    const lensHalf = Math.min(compact ? 86 : 122, span * 0.34);
    const objectY = axisY - Math.min(compact ? 60 : 85, (axisY - mainTop) * 0.5);
    const railLeft = compact ? 20 : 42;
    const railRight = width - (compact ? 20 : 42);
    const railY = height - (compact ? 27 : 34);

    return {
      width,
      height,
      compact,
      mainTop,
      mainBottom,
      axisY,
      lensX,
      lensHalf,
      sensorX,
      sensorHalf,
      sceneLeft,
      sceneRight,
      objectY,
      railTop,
      railHeight,
      railLeft,
      railRight,
      railY,
      railHitTop: railTop + 26,
      subjectHits: [],
    };
  }

  function sceneDepthToX(depthM, l) {
    const depth = clamp(depthM, SCENE_MIN, SCENE_MAX);
    const t =
      (Math.log(SCENE_MAX) - Math.log(depth)) /
      (Math.log(SCENE_MAX) - Math.log(SCENE_MIN));
    return l.sceneLeft + t * (l.sceneRight - l.sceneLeft);
  }

  function railDepthToX(depthM, l) {
    const depth = clamp(depthM, SCENE_MIN, SCENE_MAX);
    const t =
      (Math.log(depth) - Math.log(SCENE_MIN)) /
      (Math.log(SCENE_MAX) - Math.log(SCENE_MIN));
    return l.railLeft + t * (l.railRight - l.railLeft);
  }

  function railXToDepth(x, l) {
    const t = clamp((x - l.railLeft) / (l.railRight - l.railLeft), 0, 1);
    return Math.exp(
      Math.log(SCENE_MIN) +
        t * (Math.log(SCENE_MAX) - Math.log(SCENE_MIN))
    );
  }

  function apertureHalfFor(fNumber, lensHalf) {
    const normalized = clamp(
      (1 / fNumber - 1 / 22) / (1 / 1.4 - 1 / 22),
      0,
      1
    );
    const minHalf = Math.max(4.5, lensHalf * 0.055);
    const maxHalf = lensHalf * 0.78;
    return minHalf + normalized * (maxHalf - minHalf);
  }

  function hexToRgba(hex, alpha) {
    let value = hex.replace("#", "");
    if (value.length === 3) {
      value = value
        .split("")
        .map((character) => character + character)
        .join("");
    }
    const number = Number.parseInt(value, 16);
    return `rgba(${(number >> 16) & 255}, ${(number >> 8) & 255}, ${number & 255}, ${alpha})`;
  }

  function drawChip(text, x, top, options = {}) {
    if (!ctx || !layout) return null;
    const font = options.font || `500 9.5px ${FONT_SANS}`;
    ctx.save();
    ctx.font = font;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const padX = options.padX ?? 7;
    const height = options.height ?? 21;
    const width = ctx.measureText(text).width + padX * 2;
    let left =
      options.align === "right"
        ? x - width
        : options.align === "center"
          ? x - width / 2
          : x;
    left = clamp(left, 4, layout.width - width - 4);
    const topClamped = clamp(top, 4, layout.height - height - 4);

    ctx.beginPath();
    ctx.roundRect(left, topClamped, width, height, 2);
    ctx.fillStyle = options.background || "rgba(8, 12, 9, 0.9)";
    ctx.fill();
    ctx.strokeStyle = options.border || "rgba(217, 255, 115, 0.18)";
    ctx.stroke();
    ctx.fillStyle = options.color || C.accent;
    ctx.fillText(text, left + width / 2, topClamped + height / 2 + 0.5);
    ctx.restore();

    return {
      left,
      right: left + width,
      top: topClamped,
      bottom: topClamped + height,
      width,
      height,
    };
  }

  function draw() {
    if (!ctx) return;
    if (!view.width || !view.height) {
      resizeCanvas();
      if (!view.width) return;
    }

    const l = computeLayout(view.width, view.height);
    layout = l;
    const fNumber = APERTURES[state.apertureIndex];
    const dof = Optics.depthOfFieldM(fNumber, state.focusM);
    const subject = SUBJECTS[state.subjectIndex];
    const current = Optics.analyze(
      fNumber,
      state.focusM,
      subject.depthM
    );
    const analyses = SUBJECTS.map((subject) =>
      Optics.analyze(fNumber, state.focusM, subject.depthM)
    );

    ctx.clearRect(0, 0, view.width, view.height);
    drawBackdrop(l);
    drawDepthOfField(l, dof);
    drawAxis(l);
    drawCamera(l, fNumber);
    drawRays(l, current, subject);
    drawSubjects(l, analyses);
    drawCameraLabels(l, fNumber);
    drawDepthAnnotation(l, dof);
    drawRail(l, dof);
  }

  function drawBackdrop(l) {
    ctx.save();
    const glow = ctx.createRadialGradient(
      l.lensX,
      l.axisY - l.sensorHalf * 0.15,
      12,
      l.lensX,
      l.axisY,
      l.width * 0.62
    );
    glow.addColorStop(0, "rgba(177, 217, 139, 0.08)");
    glow.addColorStop(0.48, "rgba(120, 150, 100, 0.025)");
    glow.addColorStop(1, "rgba(9, 13, 10, 0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, l.width, l.height);

    const gridStep = l.compact ? 27 : 32;
    ctx.fillStyle = C.grid;
    for (let x = 14; x < l.width; x += gridStep) {
      for (let y = l.mainTop + 12; y < l.mainBottom; y += gridStep) {
        ctx.fillRect(x, y, 1, 1);
      }
    }

    const topFade = ctx.createLinearGradient(0, 0, 0, l.mainTop + 46);
    topFade.addColorStop(0, "rgba(255, 255, 255, 0.018)");
    topFade.addColorStop(1, "rgba(255, 255, 255, 0)");
    ctx.fillStyle = topFade;
    ctx.fillRect(0, 0, l.width, l.mainTop + 46);
    ctx.restore();
  }

  function drawDepthOfField(l, dof) {
    const farX = sceneDepthToX(
      Number.isFinite(dof.farM) ? dof.farM : SCENE_MAX,
      l
    );
    const nearX = sceneDepthToX(Math.max(dof.nearM, SCENE_MIN), l);
    const left = Math.min(farX, nearX);
    const right = Math.max(farX, nearX);
    const top = l.mainTop + 38;
    const bottom = l.mainBottom - 3;
    const width = Math.max(1.5, right - left);

    ctx.save();
    const band = ctx.createLinearGradient(0, top, 0, bottom);
    band.addColorStop(0, "rgba(217, 255, 115, 0.135)");
    band.addColorStop(0.5, "rgba(217, 255, 115, 0.055)");
    band.addColorStop(1, "rgba(217, 255, 115, 0.015)");
    ctx.fillStyle = band;
    ctx.fillRect(left, top, width, bottom - top);

    ctx.beginPath();
    ctx.rect(left, top, width, bottom - top);
    ctx.clip();
    ctx.strokeStyle = "rgba(217, 255, 115, 0.055)";
    ctx.lineWidth = 1;
    for (let x = left - (bottom - top); x < right; x += 17) {
      ctx.beginPath();
      ctx.moveTo(x, bottom);
      ctx.lineTo(x + (bottom - top), top);
      ctx.stroke();
    }
    ctx.restore();

    ctx.save();
    ctx.setLineDash([3, 6]);
    ctx.strokeStyle = "rgba(217, 255, 115, 0.24)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(left, top);
    ctx.lineTo(left, bottom);
    ctx.moveTo(right, top);
    ctx.lineTo(right, bottom);
    ctx.stroke();
    ctx.restore();

    const focusX = sceneDepthToX(state.focusM, l);
    ctx.save();
    ctx.setLineDash([5, 6]);
    ctx.lineDashOffset = prefersReducedMotion ? 0 : -motionTime * 18;
    ctx.strokeStyle = "rgba(217, 255, 115, 0.55)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(focusX, top - 14);
    ctx.lineTo(focusX, bottom);
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.fillStyle = "rgba(217, 255, 115, 0.7)";
    ctx.beginPath();
    ctx.moveTo(focusX, top - 7);
    ctx.lineTo(focusX - 3.5, top - 13);
    ctx.lineTo(focusX + 3.5, top - 13);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function drawAxis(l) {
    ctx.save();
    ctx.strokeStyle = C.lineSoft;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(14, l.axisY);
    ctx.lineTo(l.width - 14, l.axisY);
    ctx.stroke();

    ctx.font = `500 9.5px ${FONT_SANS}`;
    ctx.fillStyle = C.faint;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText("光轴", 16, l.axisY - 10);
    ctx.restore();
  }

  function drawCamera(l, fNumber) {
    const lensTop = l.axisY - l.lensHalf;
    const lensBottom = l.axisY + l.lensHalf;
    const sensorTop = l.axisY - l.sensorHalf;
    const sensorBottom = l.axisY + l.sensorHalf;
    const apertureHalf = apertureHalfFor(fNumber, l.lensHalf);

    ctx.save();
    ctx.strokeStyle = "rgba(232, 242, 222, 0.07)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(l.lensX, lensTop - 8);
    ctx.lineTo(l.sensorX + 18, lensTop - 8);
    ctx.moveTo(l.lensX, lensBottom + 8);
    ctx.lineTo(l.sensorX + 18, lensBottom + 8);
    ctx.moveTo(l.sensorX + 18, lensTop - 8);
    ctx.lineTo(l.sensorX + 18, lensBottom + 8);
    ctx.stroke();
    ctx.restore();

    // Sensor
    ctx.save();
    ctx.fillStyle = "rgba(127, 199, 255, 0.045)";
    ctx.fillRect(l.sensorX - 5, sensorTop, 10, sensorBottom - sensorTop);
    ctx.strokeStyle = "rgba(167, 230, 203, 0.36)";
    ctx.lineWidth = 1;
    ctx.strokeRect(l.sensorX - 5, sensorTop, 10, sensorBottom - sensorTop);

    ctx.fillStyle = "rgba(167, 230, 203, 0.76)";
    ctx.fillRect(l.sensorX - 1, sensorTop + 7, 2, sensorBottom - sensorTop - 14);

    ctx.strokeStyle = "rgba(167, 230, 203, 0.34)";
    for (let y = sensorTop + 13; y < sensorBottom - 8; y += 13) {
      ctx.beginPath();
      ctx.moveTo(l.sensorX + 5, y);
      ctx.lineTo(l.sensorX + 8, y);
      ctx.stroke();
    }
    ctx.restore();

    // Lens body
    ctx.save();
    const body = ctx.createLinearGradient(
      l.lensX - 14,
      0,
      l.lensX + 14,
      0
    );
    body.addColorStop(0, "rgba(218, 233, 210, 0.06)");
    body.addColorStop(0.5, "rgba(218, 233, 210, 0.16)");
    body.addColorStop(1, "rgba(218, 233, 210, 0.06)");
    ctx.beginPath();
    ctx.roundRect(l.lensX - 12, lensTop, 24, lensBottom - lensTop, 12);
    ctx.fillStyle = body;
    ctx.fill();
    ctx.strokeStyle = "rgba(218, 233, 210, 0.38)";
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.beginPath();
    ctx.roundRect(l.lensX - 8, lensTop + 5, 16, lensBottom - lensTop - 10, 8);
    ctx.strokeStyle = "rgba(232, 242, 222, 0.13)";
    ctx.stroke();

    // Small rim glints make the barrel read as an optical element.
    ctx.strokeStyle = "rgba(232, 242, 222, 0.28)";
    ctx.beginPath();
    ctx.moveTo(l.lensX - 8, lensTop + 10);
    ctx.lineTo(l.lensX + 8, lensTop + 10);
    ctx.moveTo(l.lensX - 8, lensBottom - 10);
    ctx.lineTo(l.lensX + 8, lensBottom - 10);
    ctx.stroke();

    const glass = ctx.createLinearGradient(
      l.lensX - 8,
      l.axisY,
      l.lensX + 8,
      l.axisY
    );
    glass.addColorStop(0, "rgba(217, 255, 115, 0.02)");
    glass.addColorStop(0.5, "rgba(217, 255, 115, 0.055)");
    glass.addColorStop(1, "rgba(217, 255, 115, 0.02)");
    ctx.beginPath();
    ctx.ellipse(
      l.lensX,
      l.axisY,
      8,
      Math.max(16, l.lensHalf - 10),
      0,
      0,
      Math.PI * 2
    );
    ctx.fillStyle = glass;
    ctx.fill();
    ctx.restore();

    // Aperture blades, above and below a clear opening.
    const bladeTop = lensTop + 3;
    const bladeBottom = lensBottom - 3;
    const openingTop = l.axisY - apertureHalf;
    const openingBottom = l.axisY + apertureHalf;

    ctx.save();
    const blade = ctx.createLinearGradient(
      l.lensX - 11,
      0,
      l.lensX + 11,
      0
    );
    blade.addColorStop(0, "rgba(77, 88, 75, 0.56)");
    blade.addColorStop(0.4, "rgba(29, 37, 30, 0.82)");
    blade.addColorStop(0.68, "rgba(49, 60, 49, 0.72)");
    blade.addColorStop(1, "rgba(87, 99, 84, 0.48)");
    ctx.fillStyle = blade;
    ctx.strokeStyle = "rgba(215, 230, 207, 0.28)";

    const drawBlade = (fromY, toY, direction) => {
      if (toY <= fromY) return;
      ctx.beginPath();
      if (direction === "top") {
        ctx.moveTo(l.lensX - 11, fromY);
        ctx.lineTo(l.lensX + 11, fromY);
        ctx.lineTo(l.lensX + 11, toY);
        ctx.quadraticCurveTo(l.lensX, toY - 7, l.lensX - 11, toY);
      } else {
        ctx.moveTo(l.lensX - 11, fromY);
        ctx.lineTo(l.lensX + 11, fromY);
        ctx.lineTo(l.lensX + 11, toY);
        ctx.quadraticCurveTo(l.lensX, toY + 7, l.lensX - 11, toY);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      ctx.strokeStyle = "rgba(220, 236, 210, 0.16)";
      ctx.lineWidth = 0.75;
      const directionSign = direction === "top" ? 1 : -1;
      for (let i = 1; i <= 3; i += 1) {
        const y = fromY + ((toY - fromY) * i) / 4 + directionSign * 2;
        ctx.beginPath();
        ctx.moveTo(l.lensX - 10, y);
        ctx.lineTo(l.lensX + 10, y - directionSign * 4.5);
        ctx.stroke();
      }
    };

    drawBlade(bladeTop, openingTop, "top");
    drawBlade(openingBottom, bladeBottom, "bottom");

    // The visible opening.
    const opening = ctx.createLinearGradient(
      0,
      openingTop,
      0,
      openingBottom
    );
    opening.addColorStop(0, "rgba(217, 255, 115, 0.13)");
    opening.addColorStop(0.5, "rgba(6, 10, 7, 0.34)");
    opening.addColorStop(1, "rgba(217, 255, 115, 0.13)");
    ctx.fillStyle = "rgba(4, 7, 5, 0.4)";
    ctx.fillRect(l.lensX - 9, openingTop, 18, openingBottom - openingTop);
    ctx.fillStyle = opening;
    ctx.fillRect(l.lensX - 9, openingTop, 18, openingBottom - openingTop);

    ctx.strokeStyle = "rgba(217, 255, 115, 0.8)";
    ctx.lineWidth = 1.15;
    ctx.shadowColor = "rgba(217, 255, 115, 0.5)";
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.moveTo(l.lensX - 9.5, openingTop);
    ctx.lineTo(l.lensX + 9.5, openingTop);
    ctx.moveTo(l.lensX - 9.5, openingBottom);
    ctx.lineTo(l.lensX + 9.5, openingBottom);
    ctx.stroke();
    ctx.shadowBlur = 0;

    ctx.fillStyle = "rgba(217, 255, 115, 0.9)";
    ctx.beginPath();
    ctx.arc(l.lensX, openingTop, 1.7, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(l.lensX, openingBottom, 1.7, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawRays(l, current, subject) {
    const fNumber = current.fNumber;
    const xObject = sceneDepthToX(subject.depthM, l);
    const yObject = l.objectY;
    const apertureHalf = apertureHalfFor(fNumber, l.lensHalf);
    const lensTopY = l.axisY - apertureHalf;
    const lensBottomY = l.axisY + apertureHalf;
    const imageDistance = Optics.imageDistanceMm(subject.depthM);
    const focusDistance = Optics.imageDistanceMm(state.focusM);
    const deltaV = imageDistance - focusDistance;
    const displacement =
      deltaV * (l.width * (l.compact ? 0.25 : 0.235));
    const xImage = clamp(
      l.sensorX +
        clamp(displacement, -l.width * 0.13, l.width * 0.095),
      l.lensX + 42,
      l.width - 16
    );
    const chiefSlope = (l.axisY - yObject) / (l.lensX - xObject);
    const yImage = l.axisY + chiefSlope * (xImage - l.lensX);

    const lineYAtX = (x1, y1, x2, y2, x) =>
      y1 + ((y2 - y1) * (x - x1)) / (x2 - x1);
    const sensorYFor = (apertureY) =>
      lineYAtX(l.lensX, apertureY, xImage, yImage, l.sensorX);

    const topCross = sensorYFor(lensTopY);
    const bottomCross = sensorYFor(lensBottomY);
    const spotTop = Math.min(topCross, bottomCross);
    const spotBottom = Math.max(topCross, bottomCross);
    const spotCenter = (spotTop + spotBottom) / 2;
    const isAtFocus = current.blurMm < 0.004;
    const isWithinDof = current.blurMm <= COC_LIMIT;
    const spotColor = isWithinDof ? C.accent : subject.color;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, l.mainTop, l.width, l.mainBottom - l.mainTop);
    ctx.clip();

    // Object-space light fan.
    const fanGradient = ctx.createLinearGradient(xObject, 0, l.lensX, 0);
    fanGradient.addColorStop(0, hexToRgba(subject.color, 0.008));
    fanGradient.addColorStop(1, hexToRgba(subject.color, 0.055));
    ctx.beginPath();
    ctx.moveTo(xObject, yObject);
    ctx.lineTo(l.lensX, lensTopY);
    ctx.lineTo(l.lensX, lensBottomY);
    ctx.closePath();
    ctx.fillStyle = fanGradient;
    ctx.fill();

    // Image-space light bundle, cut off at the sensor plane.
    const imageGradient = ctx.createLinearGradient(l.lensX, 0, l.sensorX, 0);
    imageGradient.addColorStop(0, hexToRgba(subject.color, 0.065));
    imageGradient.addColorStop(1, hexToRgba(subject.color, 0.018));
    ctx.beginPath();
    ctx.moveTo(l.lensX, lensTopY);
    ctx.lineTo(l.sensorX, topCross);
    ctx.lineTo(l.sensorX, bottomCross);
    ctx.lineTo(l.lensX, lensBottomY);
    ctx.closePath();
    ctx.fillStyle = imageGradient;
    ctx.fill();

    // The visible bundle ends at the sensor plane; its width there is the
    // blur spot that the depth-of-field limit is defined against.
    const rayCount = l.compact ? 7 : 11;
    for (let i = 0; i < rayCount; i += 1) {
      const t = i / (rayCount - 1);
      const apertureY = lensTopY + t * (lensBottomY - lensTopY);
      const boundary = i === 0 || i === rayCount - 1;
      const crossY = sensorYFor(apertureY);
      ctx.strokeStyle = hexToRgba(
        subject.color,
        boundary ? (l.compact ? 0.46 : 0.58) : 0.16
      );
      ctx.lineWidth = boundary ? 1.05 : 0.65;

      ctx.beginPath();
      ctx.moveTo(xObject, yObject);
      ctx.lineTo(l.lensX, apertureY);
      ctx.lineTo(l.sensorX, crossY);
      ctx.stroke();
    }

    // Chief ray, a little brighter than the fill lines.
    ctx.strokeStyle = hexToRgba(subject.color, 0.26);
    ctx.lineWidth = 0.9;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(xObject, yObject);
    ctx.lineTo(l.lensX, l.axisY);
    ctx.lineTo(l.sensorX, sensorYFor(l.axisY));
    ctx.stroke();
    ctx.setLineDash([]);

    if (!prefersReducedMotion) {
      // Small packets of light travel along the bundle. They are decorative:
      // the static ray geometry and numeric readouts remain authoritative.
      const photonCount = l.compact ? 2 : 4;
      const points = [];
      for (let i = 0; i < photonCount; i += 1) {
        const edgeT = (i + 0.5) / photonCount;
        const apertureY = lensTopY + edgeT * (lensBottomY - lensTopY);
        const crossY = sensorYFor(apertureY);
        const d1 = Math.hypot(l.lensX - xObject, apertureY - yObject);
        const d2 = Math.hypot(l.sensorX - l.lensX, crossY - apertureY);
        const total = d1 + d2;
        points.push({ d1, d2, total, apertureY, crossY });
      }

      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      for (let i = 0; i < points.length; i += 1) {
        const path = points[i];
        const cycle = (motionTime * 0.16 + i / points.length) % 1;
        const fade = Math.sin(Math.PI * cycle);
        if (fade < 0.02) continue;

        const pointAt = (progress) => {
          const distance = progress * path.total;
          if (distance <= path.d1) {
            const t = path.d1 > 0 ? distance / path.d1 : 0;
            return {
              x: xObject + (l.lensX - xObject) * t,
              y: yObject + (path.apertureY - yObject) * t,
            };
          }
          const t = path.d2 > 0 ? (distance - path.d1) / path.d2 : 0;
          return {
            x: l.lensX + (l.sensorX - l.lensX) * t,
            y: path.apertureY + (path.crossY - path.apertureY) * t,
          };
        };

        const head = pointAt(cycle);
        const tail = pointAt(Math.max(0, cycle - 0.025));
        ctx.strokeStyle = hexToRgba(subject.color, 0.45 * fade);
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(tail.x, tail.y);
        ctx.lineTo(head.x, head.y);
        ctx.stroke();

        ctx.shadowColor = hexToRgba(subject.color, 0.9 * fade);
        ctx.shadowBlur = 8 + fade * 5;
        ctx.fillStyle = `rgba(255, 252, 239, ${0.55 + 0.4 * fade})`;
        ctx.beginPath();
        ctx.arc(head.x, head.y, l.compact ? 1.6 : 2.1, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
      }
      ctx.restore();
    }
    ctx.restore();

    // The blur spot where the cone crosses the sensor plane.
    const spotPulse = prefersReducedMotion
      ? 0.5
      : Math.sin(motionTime * 2.4) * 0.5 + 0.5;
    ctx.save();
    ctx.shadowColor = hexToRgba(spotColor, 0.55);
    ctx.shadowBlur = 9 + spotPulse * 5;
    ctx.strokeStyle = hexToRgba(spotColor, 0.95);
    ctx.lineWidth = Math.max(2, Math.min(5, 7 - l.width / 300));
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(l.sensorX, spotTop);
    ctx.lineTo(l.sensorX, spotBottom);
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.strokeStyle = hexToRgba(spotColor, 0.55);
    ctx.lineWidth = 1;
    for (const y of [spotTop, spotBottom]) {
      ctx.beginPath();
      ctx.moveTo(l.sensorX + 5, y);
      ctx.lineTo(l.sensorX + 10, y);
      ctx.stroke();
    }
    ctx.restore();

    if (!l.compact) {
      const clampedCenter = clamp(
        spotCenter,
        l.mainTop + 24,
        l.mainBottom - 26
      );
      drawChip(
        isAtFocus
          ? "c ≈ 0"
          : `c ${formatBlur(current.blurMm)} mm`,
        l.sensorX - 14,
        clampedCenter - 11,
        {
          align: "right",
          border: hexToRgba(spotColor, 0.28),
          color: spotColor,
          background: "rgba(8, 12, 9, 0.9)",
          font: `500 10.5px ${FONT_MONO}`,
          height: 22,
        }
      );
    }
  }

  function drawSubjects(l, analyses) {
    const hitRadius = l.compact ? 24 : 25;
    l.subjectHits = SUBJECTS.map((subject, index) => {
      const x = sceneDepthToX(subject.depthM, l);
      return { x, y: l.objectY, index, radius: hitRadius };
    });

    SUBJECTS.forEach((subject, index) => {
      const x = sceneDepthToX(subject.depthM, l);
      const y = l.objectY;
      const analysis = analyses[index];
      const isSelected = index === state.subjectIndex;
      const isHovered = index === state.hoverSubject;
      const sharp = analysis.blurMm <= COC_LIMIT;
      const ratio = Number.isFinite(analysis.blurRatio)
        ? analysis.blurRatio
        : 20;
      const breathing = prefersReducedMotion
        ? 0
        : (Math.sin(motionTime * 2 + index * 1.7) * 0.5 + 0.5) * 1.6;
      const haloRadius =
        10 + Math.min(23, Math.log1p(ratio) * 5.2) + (isSelected ? breathing : 0);
      const opacity = isSelected ? 1 : isHovered ? 0.92 : 0.58;

      ctx.save();
      const halo = ctx.createRadialGradient(x, y, 0, x, y, haloRadius);
      halo.addColorStop(
        0,
        hexToRgba(subject.color, sharp ? 0.25 : 0.12 * opacity + 0.05)
      );
      halo.addColorStop(
        1,
        hexToRgba(subject.color, 0)
      );
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(x, y, haloRadius, 0, Math.PI * 2);
      ctx.fill();

      if (isSelected || isHovered) {
        ctx.strokeStyle = hexToRgba(
          subject.color,
          isSelected ? 0.7 : 0.42
        );
        ctx.lineWidth = 1;
        ctx.setLineDash(isSelected ? [3, 3] : []);
        ctx.lineDashOffset = isSelected && !prefersReducedMotion
          ? -motionTime * 12
          : 0;
        ctx.beginPath();
        ctx.arc(x, y, isSelected ? 13.5 : 10.5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      ctx.beginPath();
      ctx.arc(x, y, isSelected ? 6.2 : 5.2, 0, Math.PI * 2);
      ctx.fillStyle = hexToRgba(subject.color, 0.92);
      ctx.fill();
      ctx.strokeStyle = sharp
        ? hexToRgba(C.accent, isSelected ? 0.8 : 0.42)
        : "rgba(8, 12, 9, 0.72)";
      ctx.lineWidth = 1.5;
      ctx.stroke();

      if (sharp) {
        ctx.beginPath();
        ctx.arc(x, y, isSelected ? 9 : 7.6, 0, Math.PI * 2);
        ctx.strokeStyle = hexToRgba(C.accent, isSelected ? 0.35 : 0.2);
        ctx.lineWidth = 0.8;
        ctx.stroke();
      }

      // Small object marker and label above.
      ctx.strokeStyle = hexToRgba(
        subject.color,
        isSelected ? 0.38 : 0.18
      );
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, y - 9);
      ctx.lineTo(x, y - 26);
      ctx.stroke();

      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      if (l.compact) {
        const labelY = y - (28 + index * 22);
        ctx.strokeStyle = hexToRgba(
          subject.color,
          isSelected ? 0.3 : 0.14
        );
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, labelY + 7);
        ctx.lineTo(x, y - 10);
        ctx.stroke();

        const label = `${subject.name} ${subject.depthM.toFixed(1)} m`;
        ctx.font = `500 10.5px ${FONT_SANS}`;
        const textWidth = ctx.measureText(label).width;
        ctx.fillStyle = isSelected
          ? subject.color
          : isHovered
            ? hexToRgba(subject.color, 0.82)
            : "rgba(224, 230, 218, 0.84)";
        ctx.fillText(label, x, labelY);

        ctx.beginPath();
        ctx.arc(x - textWidth / 2 - 7, labelY, 2.3, 0, Math.PI * 2);
        ctx.fillStyle = sharp
          ? hexToRgba(C.accent, isSelected ? 0.9 : 0.55)
          : hexToRgba(subject.color, 0.58);
        ctx.fill();
      } else {
        ctx.font = `500 13px ${FONT_SANS}`;
        ctx.fillStyle = isSelected
          ? subject.color
          : isHovered
            ? hexToRgba(subject.color, 0.82)
            : C.inkSoft;
        ctx.fillText(subject.name, x, y - 48);
        ctx.font = `400 10.5px ${FONT_SANS}`;
        ctx.fillStyle = sharp
          ? hexToRgba(C.accent, isSelected ? 0.95 : 0.75)
          : C.muted;
        ctx.fillText(
          `${subject.depthM.toFixed(1)} m · ${sharp ? "清晰" : "模糊"}`,
          x,
          y - 31
        );
      }
      ctx.restore();
    });
  }

  function drawCameraLabels(l, fNumber) {
    const lensBottom = l.axisY + l.lensHalf;
    const sensorTop = l.axisY - l.sensorHalf;
    ctx.save();
    ctx.textBaseline = "middle";

    ctx.textAlign = "center";
    ctx.font = `500 10.5px ${FONT_SANS}`;
    ctx.fillStyle = C.muted;
    ctx.fillText(`镜头 · f/${formatFStop(fNumber)}`, l.lensX, lensBottom + 19);

    ctx.textAlign = "center";
    ctx.font = `500 10.5px ${FONT_SANS}`;
    ctx.fillStyle = "rgba(167, 230, 203, 0.82)";
    ctx.fillText("传感器", l.sensorX, sensorTop - 13);

    if (!l.compact) {
      ctx.strokeStyle = "rgba(167, 230, 203, 0.2)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(l.sensorX - 20, sensorTop - 4);
      ctx.lineTo(l.sensorX + 20, sensorTop - 4);
      ctx.stroke();

      const apertureHalf = apertureHalfFor(fNumber, l.lensHalf);
      const bracketX = l.lensX + 21;
      const diameter = Optics.apertureDiameterMm(fNumber);
      ctx.strokeStyle = "rgba(232, 242, 222, 0.26)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(bracketX, l.axisY - apertureHalf);
      ctx.lineTo(bracketX, l.axisY + apertureHalf);
      ctx.moveTo(bracketX - 3, l.axisY - apertureHalf);
      ctx.lineTo(bracketX + 3, l.axisY - apertureHalf);
      ctx.moveTo(bracketX - 3, l.axisY + apertureHalf);
      ctx.lineTo(bracketX + 3, l.axisY + apertureHalf);
      ctx.stroke();
      drawChip(`D ${diameter.toFixed(1)} mm`, bracketX + 7, l.axisY - 10, {
        align: "left",
        font: `400 9.5px ${FONT_MONO}`,
        color: C.inkSoft,
        border: "rgba(232, 242, 222, 0.15)",
        background: "rgba(8, 12, 9, 0.88)",
        height: 20,
        padX: 6,
      });
    }
    ctx.restore();
  }

  function drawDepthAnnotation(l, dof) {
    const farX = sceneDepthToX(
      Number.isFinite(dof.farM) ? dof.farM : SCENE_MAX,
      l
    );
    const nearX = sceneDepthToX(Math.max(dof.nearM, SCENE_MIN), l);
    const left = Math.min(farX, nearX);
    const right = Math.max(farX, nearX);
    const bracketY = l.mainTop + 22;
    const label = `景深 ${formatMeters(dof.totalM)} m`;
    const labelX = clamp(
      (left + right) / 2,
      l.sceneLeft + 46,
      l.width - 74
    );

    ctx.save();
    ctx.strokeStyle = "rgba(217, 255, 115, 0.42)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(left, bracketY);
    ctx.lineTo(right, bracketY);
    ctx.moveTo(left, bracketY);
    ctx.lineTo(left, bracketY + 6);
    ctx.moveTo(right, bracketY);
    ctx.lineTo(right, bracketY + 6);
    ctx.stroke();

    ctx.font = `500 11.5px ${FONT_SANS}`;
    ctx.fillStyle = "rgba(217, 255, 115, 0.9)";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, labelX, bracketY - 13);

    if (left < l.sceneLeft + 1 && Number.isFinite(dof.farM) === false) {
      ctx.font = `500 10px ${FONT_SANS}`;
      ctx.fillStyle = C.faint;
      ctx.textAlign = "left";
      ctx.fillText("∞", Math.max(4, left - 12), bracketY + 1);
    }
    ctx.restore();
  }

  function drawRail(l, dof) {
    ctx.save();
    const railFade = ctx.createLinearGradient(0, l.railTop, 0, l.height);
    railFade.addColorStop(0, "rgba(255, 255, 255, 0.013)");
    railFade.addColorStop(1, "rgba(255, 255, 255, 0)");
    ctx.fillStyle = railFade;
    ctx.fillRect(0, l.railTop, l.width, l.height - l.railTop);

    ctx.strokeStyle = C.lineSoft;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, l.railTop);
    ctx.lineTo(l.width, l.railTop);
    ctx.stroke();

    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.font = `600 11px ${FONT_SANS}`;
    ctx.fillStyle = C.muted;
    ctx.fillText("景深 / 清晰范围", l.railLeft, l.railTop + 18);
    if (!l.compact) {
      ctx.textAlign = "right";
      ctx.font = `400 9.5px ${FONT_SANS}`;
      ctx.fillStyle = C.faint;
      ctx.fillText("拖动调整对焦 →", l.railRight, l.railTop + 18);
    }

    ctx.strokeStyle = "rgba(232, 242, 222, 0.18)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(l.railLeft, l.railY);
    ctx.lineTo(l.railRight, l.railY);
    ctx.stroke();

    const tickValues = l.compact
      ? [1, 2, 3, 4, 6, 8]
      : [0.8, 1, 1.5, 2, 3, 4, 6, 8];
    ctx.textAlign = "center";
    ctx.font = `400 9.5px ${FONT_SANS}`;
    for (const value of tickValues) {
      const x = railDepthToX(value, l);
      ctx.strokeStyle = "rgba(232, 242, 222, 0.17)";
      ctx.beginPath();
      ctx.moveTo(x, l.railY - 3);
      ctx.lineTo(x, l.railY + 4);
      ctx.stroke();
      ctx.fillStyle = C.faint;
      ctx.fillText(
        `${value === 8 ? "8 m" : value}`,
        x,
        l.railY + 19
      );
    }

    const nearX = railDepthToX(Math.max(dof.nearM, SCENE_MIN), l);
    const farX = railDepthToX(
      Number.isFinite(dof.farM) ? dof.farM : SCENE_MAX,
      l
    );
    const bandLeft = Math.min(nearX, farX);
    const bandRight = Math.max(nearX, farX);

    ctx.save();
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(217, 255, 115, 0.18)";
    ctx.lineWidth = 9;
    ctx.beginPath();
    ctx.moveTo(bandLeft, l.railY);
    ctx.lineTo(Math.max(bandLeft + 0.5, bandRight), l.railY);
    ctx.stroke();

    ctx.strokeStyle = "rgba(217, 255, 115, 0.82)";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(bandLeft, l.railY);
    ctx.lineTo(Math.max(bandLeft + 0.5, bandRight), l.railY);
    ctx.stroke();

    ctx.strokeStyle = "rgba(217, 255, 115, 0.45)";
    ctx.lineWidth = 1;
    for (const x of [bandLeft, bandRight]) {
      ctx.beginPath();
      ctx.moveTo(x, l.railY - 8);
      ctx.lineTo(x, l.railY + 8);
      ctx.stroke();
    }
    ctx.restore();

    if (Number.isFinite(dof.farM) === false || dof.farM > SCENE_MAX) {
      ctx.save();
      ctx.fillStyle = "rgba(217, 255, 115, 0.62)";
      ctx.font = `400 10px ${FONT_MONO}`;
      ctx.textAlign = "right";
      ctx.fillText("∞", l.railRight, l.railY - 15);
      ctx.restore();
    }

    const focusX = railDepthToX(state.focusM, l);
    ctx.save();
    ctx.strokeStyle = state.draggingRail
      ? C.accent
      : "rgba(217, 255, 115, 0.58)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(focusX, l.railY - 23);
    ctx.lineTo(focusX, l.railY + 6);
    ctx.stroke();

    ctx.translate(focusX, l.railY);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = C.accent;
    ctx.fillRect(-3.7, -3.7, 7.4, 7.4);
    ctx.restore();

    if (!prefersReducedMotion) {
      const phase = (motionTime * 0.55) % 1;
      ctx.save();
      ctx.strokeStyle = `rgba(217, 255, 115, ${0.22 * (1 - phase)})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(focusX, l.railY, 8 + phase * 14, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    const chipX = offsetChipX(focusX, 68, l);
    drawChip(`对焦 ${formatFocus(state.focusM)}`, chipX, l.railY - 47, {
      align: "center",
      border: "rgba(217, 255, 115, 0.3)",
      color: C.accent,
      font: `500 10.5px ${FONT_SANS}`,
      height: 22,
      padX: 9,
    });

    if (l.compact) {
      ctx.save();
      ctx.font = `400 9.5px ${FONT_SANS}`;
      ctx.fillStyle = C.faint;
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.fillText("拖动对焦", l.railRight, l.railTop + 18);
      ctx.restore();
    }
    ctx.restore();
  }

  function offsetChipX(centerX, width, l) {
    const margin = 12;
    if (centerX - width / 2 < margin) {
      return margin + width / 2;
    }
    if (centerX + width / 2 > l.width - margin) {
      return l.width - margin - width / 2;
    }
    return centerX;
  }

  /* ————————————————————————————————
     Pointer interaction
  ———————————————————————————————— */

  function canvasPoint(event) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
  }

  function findSubject(point) {
    if (!layout) return -1;
    let nearest = -1;
    let nearestDistance = Infinity;
    for (const hit of layout.subjectHits) {
      const dx = point.x - hit.x;
      const dy = point.y - hit.y;
      const distance = Math.hypot(dx, dy);
      if (distance <= hit.radius && distance < nearestDistance) {
        nearest = hit.index;
        nearestDistance = distance;
      }
    }
    return nearest;
  }

  function setFocusFromRailX(x) {
    if (!layout) return;
    const rawDepth = railXToDepth(x, layout);
    const focus = clamp(
      Math.round(rawDepth * 10) / 10,
      FOCUS_MIN,
      FOCUS_MAX
    );
    if (focus === state.focusM) return;
    state.focusM = focus;
    syncUI();
    requestDraw();
  }

  function updateHoverCursor(point) {
    if (!layout) return;
    if (state.draggingRail) {
      canvas.style.cursor = "grabbing";
      return;
    }
    const subject = findSubject(point);
    if (subject !== state.hoverSubject) {
      state.hoverSubject = subject;
      requestDraw();
    }
    if (subject !== -1) {
      canvas.style.cursor = "pointer";
    } else if (
      point.y >= layout.railHitTop &&
      point.x >= layout.railLeft - 8 &&
      point.x <= layout.railRight + 8
    ) {
      canvas.style.cursor = "ew-resize";
    } else {
      canvas.style.cursor = "default";
    }
  }

  if (canvas) {
    canvas.addEventListener("pointerdown", (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      if (!layout) return;
      const point = canvasPoint(event);

      if (
        point.y >= layout.railHitTop &&
        point.x >= layout.railLeft - 12 &&
        point.x <= layout.railRight + 12
      ) {
        event.preventDefault();
        state.draggingRail = true;
        state.pointerId = event.pointerId;
        canvas.setPointerCapture?.(event.pointerId);
        canvas.style.cursor = "grabbing";
        setFocusFromRailX(point.x);
        return;
      }

      const subject = findSubject(point);
      if (subject !== -1) {
        state.subjectIndex = subject;
        refresh(true);
      }
    });

    canvas.addEventListener("pointermove", (event) => {
      if (!layout) return;
      const point = canvasPoint(event);
      if (state.draggingRail && event.pointerId === state.pointerId) {
        event.preventDefault();
        setFocusFromRailX(point.x);
        return;
      }
      updateHoverCursor(point);
    });

    const finishPointer = (event) => {
      if (!state.draggingRail) return;
      if (state.pointerId !== null && event.pointerId !== state.pointerId) {
        return;
      }
      state.draggingRail = false;
      if (canvas.hasPointerCapture?.(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }
      state.pointerId = null;
      canvas.style.cursor =
        event.pointerType === "mouse" ? "ew-resize" : "default";
      scheduleAnnouncement(0);
      requestDraw();
    };

    canvas.addEventListener("pointerup", finishPointer);
    canvas.addEventListener("pointercancel", finishPointer);
    canvas.addEventListener("pointerleave", () => {
      if (state.draggingRail) return;
      state.hoverSubject = -1;
      canvas.style.cursor = "default";
      requestDraw();
    });
  }

  /* ————————————————————————————————
     Controls
  ———————————————————————————————— */

  el.apertureRange?.addEventListener("input", (event) => {
    state.apertureIndex = clamp(
      Number.parseInt(event.currentTarget.value, 10) || 0,
      0,
      APERTURES.length - 1
    );
    refresh();
  });
  el.apertureRange?.addEventListener("change", () => {
    scheduleAnnouncement(0);
  });

  el.focusRange?.addEventListener("input", (event) => {
    state.focusM = clamp(
      Number.parseFloat(event.currentTarget.value) || FOCUS_MIN,
      FOCUS_MIN,
      FOCUS_MAX
    );
    refresh();
  });
  el.focusRange?.addEventListener("change", () => {
    scheduleAnnouncement(0);
  });

  el.subjectButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.subjectIndex = clamp(
        Number.parseInt(button.dataset.subject, 10) || 0,
        0,
        SUBJECTS.length - 1
      );
      refresh(true);
    });
  });

  el.presetButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.apertureIndex = clamp(
        Number.parseInt(button.dataset.apertureIndex, 10) || 0,
        0,
        APERTURES.length - 1
      );
      refresh(true);
    });
  });

  el.resetButton?.addEventListener("click", () => {
    state.apertureIndex = DEFAULTS.apertureIndex;
    state.focusM = DEFAULTS.focusM;
    state.subjectIndex = DEFAULTS.subjectIndex;
    state.hoverSubject = -1;
    refresh(true);
  });

  /* ————————————————————————————————
     Bootstrap
  ———————————————————————————————— */

  if (canvas && ctx) {
    const resizeObserver = new ResizeObserver(() => {
      resizeCanvas();
    });
    resizeObserver.observe(canvas.parentElement);
    window.addEventListener("resize", resizeCanvas, { passive: true });
    if (document.fonts?.ready) {
      document.fonts.ready.then(() => {
        requestDraw();
      });
    }
  }

  syncUI();
  uiReady = true;
  requestDraw();
  initScrollProgress();
  initReveal();
  window.requestAnimationFrame(() => {
    if (!layout) resizeCanvas();
    draw();
    initCanvasMotion();
  });
})();
