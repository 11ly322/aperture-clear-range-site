/*
 * Thin-lens optics used by the depth-of-field lab.
 * All internal distances are millimetres unless a name ends in M.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.Optics = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const APERTURE_STOPS = Object.freeze([1.4, 1.8, 2, 2.8, 4, 5.6, 8, 11, 16, 22]);

  const DEFAULTS = Object.freeze({
    focalLengthMm: 50,
    cocLimitMm: 0.03,
    focusMinM: 1,
    focusMaxM: 8,
    sceneMinM: 0.8,
    sceneMaxM: 8,
  });

  const SENSOR = Object.freeze({
    name: "全画幅",
    widthMm: 36,
    heightMm: 24,
    diagonalMm: Math.hypot(36, 24),
  });

  function positive(value, name) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive finite number`);
    }
    return value;
  }

  function apertureDiameterMm(fNumber, focalLengthMm = DEFAULTS.focalLengthMm) {
    positive(fNumber, "fNumber");
    positive(focalLengthMm, "focalLengthMm");
    return focalLengthMm / fNumber;
  }

  function imageDistanceMm(objectM, focalLengthMm = DEFAULTS.focalLengthMm) {
    positive(objectM, "objectM");
    positive(focalLengthMm, "focalLengthMm");
    const objectMm = objectM * 1000;
    if (objectMm <= focalLengthMm) return Infinity;
    return (focalLengthMm * objectMm) / (objectMm - focalLengthMm);
  }

  // Diameter of the blur spot on the sensor for an object away from the focus plane.
  function circleOfConfusionMm(
    fNumber,
    objectM,
    focusM,
    options = {}
  ) {
    const focalLengthMm = options.focalLengthMm ?? DEFAULTS.focalLengthMm;
    const aperture = apertureDiameterMm(fNumber, focalLengthMm);
    const imageMm = imageDistanceMm(objectM, focalLengthMm);
    const focusImageMm = imageDistanceMm(focusM, focalLengthMm);

    if (!Number.isFinite(imageMm) || !Number.isFinite(focusImageMm)) {
      return Infinity;
    }

    return (aperture * Math.abs(imageMm - focusImageMm)) / imageMm;
  }

  // Object-space depth of field for a thin lens focused at focusM.
  function depthOfFieldM(fNumber, focusM, options = {}) {
    const focalLengthMm = options.focalLengthMm ?? DEFAULTS.focalLengthMm;
    const cocLimitMm = options.cocLimitMm ?? DEFAULTS.cocLimitMm;
    positive(fNumber, "fNumber");
    positive(focusM, "focusM");
    positive(focalLengthMm, "focalLengthMm");
    positive(cocLimitMm, "cocLimitMm");

    const focusMm = focusM * 1000;
    const hyperfocalMm =
      (focalLengthMm * focalLengthMm) / (fNumber * cocLimitMm) + focalLengthMm;

    const denominatorNear = hyperfocalMm + focusMm - 2 * focalLengthMm;
    const denominatorFar = hyperfocalMm - focusMm;

    const nearMm = (focusMm * (hyperfocalMm - focalLengthMm)) / denominatorNear;
    const farMm =
      denominatorFar > 0
        ? (focusMm * (hyperfocalMm - focalLengthMm)) / denominatorFar
        : Infinity;

    return {
      nearM: nearMm / 1000,
      farM: Number.isFinite(farMm) ? farMm / 1000 : Infinity,
      totalM: Number.isFinite(farMm) ? (farMm - nearMm) / 1000 : Infinity,
      hyperfocalM: hyperfocalMm / 1000,
      cocLimitMm,
    };
  }

  function analyze(fNumber, focusM, objectM, options = {}) {
    const focalLengthMm = options.focalLengthMm ?? DEFAULTS.focalLengthMm;
    const cocLimitMm = options.cocLimitMm ?? DEFAULTS.cocLimitMm;
    const dof = depthOfFieldM(fNumber, focusM, { focalLengthMm, cocLimitMm });
    const blurMm = circleOfConfusionMm(fNumber, objectM, focusM, {
      focalLengthMm,
    });

    return {
      fNumber,
      focusM,
      objectM,
      apertureDiameterMm: apertureDiameterMm(fNumber, focalLengthMm),
      blurMm,
      blurRatio: blurMm / cocLimitMm,
      inDepthOfField: blurMm <= cocLimitMm,
      ...dof,
    };
  }

  return Object.freeze({
    APERTURE_STOPS,
    DEFAULTS,
    SENSOR,
    apertureDiameterMm,
    imageDistanceMm,
    circleOfConfusionMm,
    depthOfFieldM,
    analyze,
  });
});
