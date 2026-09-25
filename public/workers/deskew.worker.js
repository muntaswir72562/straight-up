/* eslint-disable no-undef */
/**
 * Deskew Web Worker
 *
 * Classic worker (not module) that loads OpenCV.js via importScripts.
 * Detects and corrects rotation of scanned book pages.
 *
 * Angle convention: positive = counter-clockwise correction needed.
 *
 * Messages IN:
 *   { type: 'detect', id, imageData, width, height }
 *   { type: 'straighten', id, imageData, width, height, angle, autoCrop }
 *
 * Messages OUT:
 *   { type: 'ready' }
 *   { type: 'result', id, ... }   (detect result: angle, method, confidence)
 *   { type: 'straightened', id, jpeg, thumbnail, croppedWidth, croppedHeight }
 *   { type: 'error', id, message }
 */

// --- Constants (match lib/constants.ts) ---
var DETECT_WIDTH = 1000;
var MAX_ANGLE = 10;
var COARSE_STEP = 0.5;
var FINE_STEP = 0.05;
var SKIP_THRESHOLD = 0.2; // matches lib/constants.ts
var MIN_CONFIDENCE = 1.5;
var MIN_TEXT_PIXEL_RATIO = 0.01;
var JPEG_QUALITY = 0.85;
var THUMBNAIL_WIDTH = 200;

// --- Load OpenCV ---
importScripts('/opencv/opencv.js');

function waitForOpenCV() {
  return new Promise(function (resolve) {
    if (typeof cv !== 'undefined') {
      if (typeof cv.then === 'function') {
        cv.then(function (instance) {
          cv = instance;
          resolve();
        });
      } else if (cv.Mat) {
        resolve();
      } else {
        cv.onRuntimeInitialized = function () {
          resolve();
        };
      }
    }
  });
}

waitForOpenCV().then(function () {
  postMessage({ type: 'ready' });
});

onmessage = function (e) {
  var msg = e.data;

  if (msg.type === 'detect') {
    try {
      var result = detectAngle(msg.imageData, msg.width, msg.height);
      postMessage({
        type: 'result',
        id: msg.id,
        angle: result.angle,
        method: result.method,
        confidence: result.confidence,
      });
    } catch (err) {
      postMessage({ type: 'error', id: msg.id, message: err.message || String(err) });
    }
  } else if (msg.type === 'straighten') {
    straightenPage(msg.id, msg.imageData, msg.width, msg.height, msg.angle, msg.autoCrop);
  }
};

// ============================================================
// STRAIGHTEN (Phase 4)
// ============================================================

function straightenPage(id, imageData, width, height, angle, autoCrop) {
  try {
    // Create Mat from RGBA image data
    var src = cv.matFromImageData({ data: imageData, width: width, height: height });

    // Convert to RGB (drop alpha for JPEG)
    var rgb = new cv.Mat();
    cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
    src.delete();

    // Rotate around centre with white fill
    var center = new cv.Point(width / 2, height / 2);
    var M = cv.getRotationMatrix2D(center, angle, 1.0);
    var rotated = new cv.Mat();
    cv.warpAffine(rgb, rotated, M, new cv.Size(width, height),
      cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(255, 255, 255));
    M.delete();
    rgb.delete();

    var finalMat = rotated;
    var croppedWidth = width;
    var croppedHeight = height;

    // Auto-crop: find page region after rotation and crop
    if (autoCrop) {
      var cropResult = attemptAutoCrop(rotated, width, height);
      if (cropResult) {
        finalMat = cropResult.mat;
        croppedWidth = cropResult.width;
        croppedHeight = cropResult.height;
        rotated.delete();
      } else {
        finalMat = rotated;
      }
    }

    // Encode to JPEG via OffscreenCanvas
    encodeToJpeg(finalMat, croppedWidth, croppedHeight, JPEG_QUALITY).then(function (jpegBytes) {
      // Create thumbnail
      var thumbHeight = Math.round((THUMBNAIL_WIDTH / croppedWidth) * croppedHeight);
      var thumbMat = new cv.Mat();
      cv.resize(finalMat, thumbMat, new cv.Size(THUMBNAIL_WIDTH, thumbHeight), 0, 0, cv.INTER_AREA);
      finalMat.delete();

      encodeToJpeg(thumbMat, THUMBNAIL_WIDTH, thumbHeight, 0.7).then(function (thumbBytes) {
        thumbMat.delete();

        postMessage(
          {
            type: 'straightened',
            id: id,
            jpeg: jpegBytes,
            thumbnail: thumbBytes,
            croppedWidth: croppedWidth,
            croppedHeight: croppedHeight,
          },
          [jpegBytes.buffer, thumbBytes.buffer]
        );
      });
    });
  } catch (err) {
    postMessage({ type: 'error', id: id, message: err.message || String(err) });
  }
}

/**
 * Auto-crop: find the bright page region and crop to its bounding rect.
 * Returns { mat, width, height } or null if crop is unsafe.
 */
function attemptAutoCrop(rotatedMat, imgWidth, imgHeight) {
  var gray = new cv.Mat();
  cv.cvtColor(rotatedMat, gray, cv.COLOR_RGB2GRAY);

  var thresh = new cv.Mat();
  cv.threshold(gray, thresh, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
  gray.delete();

  var contours = new cv.MatVector();
  var hierarchy = new cv.Mat();
  cv.findContours(thresh, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
  thresh.delete();
  hierarchy.delete();

  // Find largest bright contour
  var maxArea = 0;
  var bestIdx = -1;
  for (var i = 0; i < contours.size(); i++) {
    var area = cv.contourArea(contours.get(i));
    if (area > maxArea) {
      maxArea = area;
      bestIdx = i;
    }
  }

  var imageArea = imgWidth * imgHeight;
  var areaRatio = maxArea / imageArea;

  // Safety: skip if area < 50% or > 99%
  if (bestIdx < 0 || areaRatio < 0.5 || areaRatio > 0.99) {
    for (var ci = 0; ci < contours.size(); ci++) contours.get(ci).delete();
    contours.delete();
    return null;
  }

  var rect = cv.boundingRect(contours.get(bestIdx));
  for (var cj = 0; cj < contours.size(); cj++) contours.get(cj).delete();
  contours.delete();

  // Add small margin (1% of dimension)
  var marginX = Math.round(imgWidth * 0.01);
  var marginY = Math.round(imgHeight * 0.01);
  var x = Math.max(0, rect.x - marginX);
  var y = Math.max(0, rect.y - marginY);
  var w = Math.min(imgWidth - x, rect.width + marginX * 2);
  var h = Math.min(imgHeight - y, rect.height + marginY * 2);

  // Safety: check aspect ratio change
  var origAspect = imgWidth / imgHeight;
  var cropAspect = w / h;
  var aspectChange = Math.abs(cropAspect - origAspect) / origAspect;
  if (aspectChange > 0.15) {
    return null;
  }

  // Perform the crop
  var cropRect = new cv.Rect(x, y, w, h);
  var cropped = rotatedMat.roi(cropRect);
  var cloned = cropped.clone();
  cropped.delete();

  return { mat: cloned, width: w, height: h };
}

/**
 * Encode an RGB Mat to JPEG using OffscreenCanvas.
 * Returns a Promise<Uint8Array>.
 */
function encodeToJpeg(mat, w, h, quality) {
  // Convert RGB Mat to RGBA ImageData for canvas
  var rgba = new cv.Mat();
  cv.cvtColor(mat, rgba, cv.COLOR_RGB2RGBA);
  var imgData = new ImageData(new Uint8ClampedArray(rgba.data), w, h);
  rgba.delete();

  var canvas = new OffscreenCanvas(w, h);
  var ctx = canvas.getContext('2d');
  ctx.putImageData(imgData, 0, 0);

  return canvas.convertToBlob({ type: 'image/jpeg', quality: quality }).then(function (blob) {
    return blob.arrayBuffer().then(function (buffer) {
      return new Uint8Array(buffer);
    });
  });
}

// ============================================================
// ANGLE DETECTION
// ============================================================

function detectAngle(imageData, width, height) {
  var src = cv.matFromImageData({ data: imageData, width: width, height: height });

  // Resize for performance
  var scale = DETECT_WIDTH / width;
  var dw = DETECT_WIDTH;
  var dh = Math.round(height * scale);
  var small = new cv.Mat();
  cv.resize(src, small, new cv.Size(dw, dh), 0, 0, cv.INTER_AREA);
  src.delete();

  var gray = new cv.Mat();
  cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY);
  small.delete();

  // Edge detection on page borders
  var edgeResult = detectVerticalEdgeAngle(gray, dw, dh);
  gray.delete();

  if (edgeResult !== null) {
    // Dampen the angle by 0.7 to prevent overcorrection from binding
    // shadow contamination. Edge detection tends to overestimate the
    // rotation angle because binding shadow lines are at a steeper
    // angle than the actual page border.
    var dampedAngle = edgeResult.angle * 0.7;
    dampedAngle = Math.round(dampedAngle * 100) / 100;
    return { angle: dampedAngle, method: 'edge', confidence: edgeResult.confidence };
  }

  return { angle: 0, method: 'none', confidence: 0 };
}

// ============================================================
// Method 1: Hough vertical edge detection
// ============================================================

/**
 * Detect page rotation by finding near-vertical lines (page borders,
 * book binding shadow) via Hough Line Transform.
 *
 * Uses per-zone analysis to avoid binding shadow contamination:
 * 1. Separate lines into left-zone and right-zone candidates
 * 2. Do independent outlier rejection within each zone
 * 3. Cross-validate zones:
 *    - Both agree (within 1.5°): use combined average → high confidence
 *    - Both disagree (>1.5°): skip (binding shadow contamination)
 *    - Single zone only: cap angle at MAX_SINGLE_ZONE_ANGLE
 *
 * Returns { angle, confidence } or null if no reliable edges found.
 */
var MAX_SINGLE_ZONE_ANGLE = 1.0; // max degrees for single-zone detection

function detectVerticalEdgeAngle(gray, width, height) {
  // Slight blur to reduce texture noise while preserving strong edges
  var blurred = new cv.Mat();
  cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 1.5);

  // Canny edge detection - tuned for strong page borders
  var edges = new cv.Mat();
  cv.Canny(blurred, edges, 30, 100);
  blurred.delete();

  // Dilate vertically to connect broken edge segments along the page border
  var kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(1, 5));
  var dilated = new cv.Mat();
  cv.dilate(edges, dilated, kernel);
  kernel.delete();
  edges.delete();

  // Probabilistic Hough Line Transform
  var lines = new cv.Mat();
  var minLineLength = Math.round(height * 0.12);
  var maxLineGap = Math.round(height * 0.04);
  cv.HoughLinesP(dilated, lines, 1, Math.PI / 180, 40, minLineLength, maxLineGap);
  dilated.delete();

  if (lines.rows === 0) {
    lines.delete();
    return null;
  }

  // Separate near-vertical lines into left-zone and right-zone
  var leftCandidates = [];
  var rightCandidates = [];
  var edgeZoneWidth = width * 0.22;

  for (var i = 0; i < lines.rows; i++) {
    var x1 = lines.data32S[i * 4];
    var y1 = lines.data32S[i * 4 + 1];
    var x2 = lines.data32S[i * 4 + 2];
    var y2 = lines.data32S[i * 4 + 3];

    var dx = x2 - x1;
    var dy = y2 - y1;
    var length = Math.sqrt(dx * dx + dy * dy);

    // Normalize direction: ensure dy > 0 (top-to-bottom)
    if (dy < 0) { dx = -dx; dy = -dy; }

    // Must be mostly vertical: vertical component > 70% of length
    if (dy < length * 0.7) continue;

    // Angle from vertical (degrees)
    var angleDeg = Math.atan2(dx, dy) * (180 / Math.PI);

    // Filter: within MAX_ANGLE of vertical
    if (Math.abs(angleDeg) > MAX_ANGLE) continue;

    // Classify by zone
    var midX = (x1 + x2) / 2;
    if (midX < edgeZoneWidth) {
      leftCandidates.push({ angle: angleDeg, weight: length });
    } else if (midX > (width - edgeZoneWidth)) {
      rightCandidates.push({ angle: angleDeg, weight: length });
    }
  }

  lines.delete();

  // Per-zone outlier rejection and averaging
  var leftResult = computeZoneAngle(leftCandidates);
  var rightResult = computeZoneAngle(rightCandidates);

  var hasLeft = leftResult !== null;
  var hasRight = rightResult !== null;

  if (!hasLeft && !hasRight) return null;

  var finalAngle, confidence;

  if (hasLeft && hasRight) {
    // Both zones detected — cross-validate
    var diff = Math.abs(leftResult.avg - rightResult.avg);

    if (diff <= 1.5) {
      // Zones agree — combine with weighted average by line count
      var totalCount = leftResult.count + rightResult.count;
      finalAngle = (leftResult.avg * leftResult.count + rightResult.avg * rightResult.count) / totalCount;
      confidence = Math.min(totalCount, 10);
    } else {
      // Zones disagree significantly — binding shadow contamination.
      // Can't tell which side is correct, so skip entirely.
      return null;
    }
  } else {
    // Single zone only — cap angle to limit binding shadow damage
    var zone = hasLeft ? leftResult : rightResult;
    finalAngle = zone.avg;
    confidence = Math.min(zone.count, 10);

    if (Math.abs(finalAngle) > MAX_SINGLE_ZONE_ANGLE) {
      finalAngle = finalAngle > 0 ? MAX_SINGLE_ZONE_ANGLE : -MAX_SINGLE_ZONE_ANGLE;
    }
  }

  // Round to nearest FINE_STEP
  finalAngle = Math.round(finalAngle / FINE_STEP) * FINE_STEP;
  finalAngle = Math.round(finalAngle * 1000) / 1000;

  // Negate: atan2 measures how edges lean, but correction must rotate
  // the opposite direction to straighten the page.
  return { angle: -finalAngle, confidence: confidence };
}

/**
 * Compute average angle for a single zone's candidates.
 * Does independent outlier rejection (±1.5° from zone median).
 * Returns { avg, count } or null if fewer than 2 lines survive.
 */
function computeZoneAngle(candidates) {
  if (candidates.length < 2) return null;

  candidates.sort(function (a, b) { return a.angle - b.angle; });
  var median = candidates[Math.floor(candidates.length / 2)].angle;

  var filtered = [];
  for (var i = 0; i < candidates.length; i++) {
    if (Math.abs(candidates[i].angle - median) <= 1.5) {
      filtered.push(candidates[i]);
    }
  }

  if (filtered.length < 2) return null;

  var totalWeight = 0;
  var weightedSum = 0;
  for (var j = 0; j < filtered.length; j++) {
    weightedSum += filtered[j].angle * filtered[j].weight;
    totalWeight += filtered[j].weight;
  }

  return { avg: weightedSum / totalWeight, count: filtered.length };
}

// ============================================================
// Projection Profile — Postl's variance of line sums
// (Leptonica/Tesseract/OCRmyPDF gold standard)
// ============================================================

/**
 * Detect rotation via projection profile analysis on a CROPPED content area
 * (caller must exclude borders/binding shadows before calling this).
 *
 * Uses the Leptonica approach:
 * 1. Binarize (Otsu) — text white on black
 * 2. Reduce image for coarse sweep
 * 3. Coarse sweep: -7° to +7° in 1° steps, score = sum((P[y]-P[y-1])^2)
 * 4. Fine search: ±1° around best coarse in 0.1° steps
 * 5. Extra-fine: ±0.1° around best fine in 0.02° steps
 * 6. Confidence = best_score / median_score
 *
 * Returns { angle, confidence } or null if insufficient text content.
 */
function detectProjectionProfile(gray, width, height) {
  // Binarize: adaptive threshold for robust text extraction under uneven lighting
  var textMask = new cv.Mat();
  cv.adaptiveThreshold(gray, textMask, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 15, 10);

  // Check minimum text content
  var textPixels = cv.countNonZero(textMask);
  if (textPixels / (width * height) < MIN_TEXT_PIXEL_RATIO) {
    textMask.delete();
    return null;
  }

  // Reduce by 2x for speed
  var sw = Math.round(width / 2);
  var sh = Math.round(height / 2);
  var reduced = new cv.Mat();
  cv.resize(textMask, reduced, new cv.Size(sw, sh), 0, 0, cv.INTER_NEAREST);
  textMask.delete();

  // --- Coarse sweep: -7° to +7° in 1° steps ---
  var coarseAngles = [];
  for (var a = -7; a <= 7; a += 1.0) {
    coarseAngles.push(a);
  }

  var coarseScores = scoreProjectionAngles(reduced, sw, sh, coarseAngles);
  var bestCoarseIdx = argmax(coarseScores);
  var bestCoarseAngle = coarseAngles[bestCoarseIdx];

  // --- Fine sweep: ±1° around best coarse in 0.1° steps ---
  var fineAngles = [];
  for (var fa = bestCoarseAngle - 1.0; fa <= bestCoarseAngle + 1.0; fa += 0.1) {
    fineAngles.push(Math.round(fa * 100) / 100);
  }

  var fineScores = scoreProjectionAngles(reduced, sw, sh, fineAngles);
  var bestFineIdx = argmax(fineScores);
  var bestFineAngle = fineAngles[bestFineIdx];

  // --- Extra-fine: ±0.1° around best fine in 0.05° steps ---
  var xfineAngles = [];
  for (var xf = bestFineAngle - 0.1; xf <= bestFineAngle + 0.1; xf += 0.05) {
    xfineAngles.push(Math.round(xf * 1000) / 1000);
  }

  var xfineScores = scoreProjectionAngles(reduced, sw, sh, xfineAngles);
  var bestXfIdx = argmax(xfineScores);
  var bestAngle = xfineAngles[bestXfIdx];
  var bestScore = xfineScores[bestXfIdx];

  reduced.delete();

  // Confidence: ratio of best score to median score across all sweeps
  var allScores = coarseScores.concat(fineScores).concat(xfineScores);
  allScores.sort(function (a, b) { return a - b; });
  var medianScore = allScores[Math.floor(allScores.length / 2)];
  var confidence = medianScore > 0 ? bestScore / medianScore : 0;

  // Round to nearest 0.05°
  bestAngle = Math.round(bestAngle * 20) / 20;

  // Negate: the shear angle that maximizes the score corrects the rotation,
  // but getRotationMatrix2D uses the opposite sign convention.
  return { angle: -bestAngle, confidence: confidence };
}

/**
 * Score candidate angles by projection profile sharpness.
 * Uses vertical shearing (faster than rotation) following Leptonica.
 * Score = sum of squared differences between adjacent row sums.
 */
function scoreProjectionAngles(binaryMask, width, height, angles) {
  var scores = [];
  // Skip boundary rows to avoid edge artifacts (5% top/bottom)
  var skip = Math.max(Math.round(height * 0.05), 2);

  for (var i = 0; i < angles.length; i++) {
    var angle = angles[i];
    // Vertical shear: shift each column by (x - width/2) * tan(angle)
    var tanA = Math.tan(angle * Math.PI / 180);
    var halfW = width / 2;

    var rowSums = new Float64Array(height);
    for (var x = 0; x < width; x++) {
      var shift = Math.round((x - halfW) * tanA);
      for (var y = skip; y < height - skip; y++) {
        var srcY = y - shift;
        if (srcY >= 0 && srcY < height) {
          rowSums[y] += binaryMask.ucharAt(srcY, x);
        }
      }
    }

    var score = 0;
    for (var r = skip + 1; r < height - skip; r++) {
      var diff = rowSums[r] - rowSums[r - 1];
      score += diff * diff;
    }
    scores.push(score);
  }

  return scores;
}

function argmax(arr) {
  var maxIdx = 0;
  for (var i = 1; i < arr.length; i++) {
    if (arr[i] > arr[maxIdx]) maxIdx = i;
  }
  return maxIdx;
}
