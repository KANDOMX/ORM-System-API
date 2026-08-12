/**
 * OMR MARKING SYSTEM — OMR ENGINE
 * ----------------------------------
 * No dependencies. Handles:
 *  - orientation detection (portrait vs landscape) + rotation
 *  - perspective correction from 4 tapped corners (homography)
 *  - template-driven bubble grid generation
 *      supports "column-major-blocks" (real ECZ card: Q in columns,
 *      A-D stacked vertically, split into repeating blocks) and
 *      "row-major" (Q in rows, A-D side by side) for other card styles
 *  - darkness sampling + VALID/BLANK/MULTIPLE/UNCERTAIN classification
 */

const OMREngine = (function () {

  const CANON_W = 1000, CANON_H = 1400; // canonical warped portrait size

  // ---------- Orientation ----------

  /**
   * Guess orientation from raw photo dimensions vs the card's expected
   * aspect ratio. Returns { guess: 'none'|'rotate90'|'rotate270', ratio }.
   * expectedAspect = width/height of the card when upright (portrait ECZ
   * sheet ~ 0.707). If the photo's ratio is far from that but close to
   * its inverse, we guess a 90-degree rotation is needed.
   */
  function detectOrientation(img, expectedAspect = 0.707) {
    const ratio = img.width / img.height;
    const diffUpright = Math.abs(ratio - expectedAspect);
    const diffRotated = Math.abs(ratio - (1 / expectedAspect));
    if (diffRotated < diffUpright) {
      // Photo is wider than the card should be -> likely rotated
      return { guess: 'rotate90', ratio };
    }
    return { guess: 'none', ratio };
  }

  /** Returns a new canvas with the image rotated by 90/180/270 degrees clockwise. */
  function rotateImageToCanvas(img, degrees) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const rad = (degrees % 360) * Math.PI / 180;
    if (degrees % 180 === 0) {
      canvas.width = img.width; canvas.height = img.height;
    } else {
      canvas.width = img.height; canvas.height = img.width;
    }
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate(rad);
    ctx.drawImage(img, -img.width / 2, -img.height / 2);
    return canvas;
  }

  // ---------- Perspective correction ----------

  function computeHomography(src, dst) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const { x: sx, y: sy } = src[i];
      const { x: dx, y: dy } = dst[i];
      A.push([sx, sy, 1, 0, 0, 0, -sx * dx, -sy * dx]); b.push(dx);
      A.push([0, 0, 0, sx, sy, 1, -sx * dy, -sy * dy]); b.push(dy);
    }
    const h = solveLinearSystem(A, b);
    return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  }

  function solveLinearSystem(A, b) {
    const n = A.length;
    const M = A.map((row, i) => row.concat([b[i]]));
    for (let col = 0; col < n; col++) {
      let piv = col;
      for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
      [M[col], M[piv]] = [M[piv], M[col]];
      const pv = M[col][col] || 1e-12;
      for (let c = col; c <= n; c++) M[col][c] /= pv;
      for (let r = 0; r < n; r++) {
        if (r === col) continue;
        const f = M[r][col];
        for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
      }
    }
    return M.map(row => row[n]);
  }

  function applyH(H, x, y) {
    const d = H[6] * x + H[7] * y + H[8];
    return { x: (H[0] * x + H[1] * y + H[2]) / d, y: (H[3] * x + H[4] * y + H[5]) / d };
  }

  /**
   * Warps `sourceCanvas` using 4 corner points (in source pixel space,
   * order TL,TR,BR,BL) onto a canonical CANON_W x CANON_H rectangle.
   * Returns { canvas, imageData }.
   */
  function warpToCanonical(sourceCanvas, corners) {
    const dst = [{ x: 0, y: 0 }, { x: CANON_W, y: 0 }, { x: CANON_W, y: CANON_H }, { x: 0, y: CANON_H }];
    const Hd2s = computeHomography(dst, corners); // dst -> src, for sampling

    const srcCtx = sourceCanvas.getContext('2d');
    const srcData = srcCtx.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);

    const outCanvas = document.createElement('canvas');
    outCanvas.width = CANON_W; outCanvas.height = CANON_H;
    const outCtx = outCanvas.getContext('2d');
    const outData = outCtx.createImageData(CANON_W, CANON_H);

    for (let y = 0; y < CANON_H; y++) {
      for (let x = 0; x < CANON_W; x++) {
        const p = applyH(Hd2s, x, y);
        const sx = Math.round(p.x), sy = Math.round(p.y);
        const outIdx = (y * CANON_W + x) * 4;
        if (sx >= 0 && sx < sourceCanvas.width && sy >= 0 && sy < sourceCanvas.height) {
          const inIdx = (sy * sourceCanvas.width + sx) * 4;
          outData.data[outIdx] = srcData.data[inIdx];
          outData.data[outIdx + 1] = srcData.data[inIdx + 1];
          outData.data[outIdx + 2] = srcData.data[inIdx + 2];
          outData.data[outIdx + 3] = 255;
        } else {
          outData.data[outIdx] = 255; outData.data[outIdx + 1] = 255;
          outData.data[outIdx + 2] = 255; outData.data[outIdx + 3] = 255;
        }
      }
    }
    outCtx.putImageData(outData, 0, 0);
    return { canvas: outCanvas, imageData: outData };
  }

  // ---------- Grid templates ----------

  /**
   * Built-in template matching the real ECZ answer sheet:
   * 3 stacked blocks of 20 questions, options stacked vertically per column.
   */
  const TEMPLATES = {
    ECZ_60: {
      name: 'ECZ Standard (60Q, 3 blocks of 20)',
      layout: 'column-major-blocks',
      questionCount: 60,
      optionLabels: ['A', 'B', 'C', 'D'],
      blocks: 3,
      questionsPerBlock: 20,
      topMarginPct: 33,   // header/name area takes a lot of vertical space
      bottomMarginPct: 2,
      leftMarginPct: 4,
      rightMarginPct: 4,
      blockGapPct: 2,
      headerFracOfBlock: 0.12 // space at top of each block reserved for the Q-number row
    },
    GENERIC_ROWS: {
      name: 'Generic row-major (Q in rows, A-D side by side)',
      layout: 'row-major',
      questionCount: 50,
      optionLabels: ['A', 'B', 'C', 'D'],
      columns: 2,
      topMarginPct: 12,
      bottomMarginPct: 4,
      leftMarginPct: 6,
      rightMarginPct: 6
    }
  };

  /** Build bubble coordinate map for a "column-major-blocks" template (the real card). */
  function buildColumnMajorGrid(cfg) {
    const topM = cfg.topMarginPct / 100 * CANON_H;
    const botM = cfg.bottomMarginPct / 100 * CANON_H;
    const leftM = cfg.leftMarginPct / 100 * CANON_W;
    const rightM = cfg.rightMarginPct / 100 * CANON_W;
    const gap = cfg.blockGapPct / 100 * CANON_H;

    const totalBlocksHeight = CANON_H - topM - botM - gap * (cfg.blocks - 1);
    const blockHeight = totalBlocksHeight / cfg.blocks;
    const gridW = CANON_W - leftM - rightM;
    const colW = gridW / cfg.questionsPerBlock;
    const optCount = cfg.optionLabels.length;

    const map = [];
    let qNum = 1;
    for (let b = 0; b < cfg.blocks; b++) {
      const blockTop = topM + b * (blockHeight + gap);
      const headerH = blockHeight * cfg.headerFracOfBlock;
      const rowsAreaTop = blockTop + headerH;
      const rowsAreaH = blockHeight - headerH;
      const rowH = rowsAreaH / optCount;

      for (let c = 0; c < cfg.questionsPerBlock; c++) {
        if (qNum > cfg.questionCount) break;
        const colX = leftM + c * colW + colW / 2;
        const options = cfg.optionLabels.map((opt, r) => ({
          opt, cx: colX, cy: rowsAreaTop + r * rowH + rowH / 2
        }));
        map.push({ q: qNum, options });
        qNum++;
      }
    }
    return map;
  }

  /** Build bubble coordinate map for a "row-major" template (Q in rows, options side by side). */
  function buildRowMajorGrid(cfg) {
    const topM = cfg.topMarginPct / 100 * CANON_H;
    const botM = cfg.bottomMarginPct / 100 * CANON_H;
    const leftM = cfg.leftMarginPct / 100 * CANON_W;
    const rightM = cfg.rightMarginPct / 100 * CANON_W;
    const gridW = CANON_W - leftM - rightM;
    const gridH = CANON_H - topM - botM;
    const qPerCol = Math.ceil(cfg.questionCount / cfg.columns);
    const colW = gridW / cfg.columns;
    const rowH = gridH / qPerCol;
    const optCount = cfg.optionLabels.length;
    const bubbleAreaFrac = 0.65;

    const map = [];
    for (let q = 1; q <= cfg.questionCount; q++) {
      const colIdx = Math.floor((q - 1) / qPerCol);
      const rowIdx = (q - 1) % qPerCol;
      const colX = leftM + colIdx * colW;
      const rowY = topM + rowIdx * rowH + rowH / 2;
      const bubZoneX = colX + colW * (1 - bubbleAreaFrac);
      const spacing = (colW * bubbleAreaFrac) / optCount;
      const options = cfg.optionLabels.map((opt, i) => ({
        opt, cx: bubZoneX + spacing * (i + 0.5), cy: rowY
      }));
      map.push({ q, options });
    }
    return map;
  }

  function buildGrid(cfg) {
    if (cfg.layout === 'column-major-blocks') return buildColumnMajorGrid(cfg);
    if (cfg.layout === 'row-major') return buildRowMajorGrid(cfg);
    throw new Error('Unknown layout: ' + cfg.layout);
  }

  // ---------- Detection ----------

  function sampleDarkness(imageData, cx, cy, radius) {
    let sum = 0, count = 0;
    const r2 = radius * radius;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx * dx + dy * dy > r2) continue;
        const x = Math.round(cx + dx), y = Math.round(cy + dy);
        if (x < 0 || y < 0 || x >= CANON_W || y >= CANON_H) continue;
        const idx = (y * CANON_W + x) * 4;
        const gray = 0.299 * imageData.data[idx] + 0.587 * imageData.data[idx + 1] + 0.114 * imageData.data[idx + 2];
        sum += (255 - gray);
        count++;
      }
    }
    return count ? sum / count : 0;
  }

  /**
   * Runs detection over a bubble map against warped imageData.
   * Returns [{ q, detected, state, confidence, scores }]
   */
  function detectAnswers(imageData, bubbleMap, sensitivity = 55, radius = 12) {
    const threshold = 255 * (sensitivity / 100) * 0.6;
    return bubbleMap.map(row => {
      const scores = {};
      row.options.forEach(o => { scores[o.opt] = sampleDarkness(imageData, o.cx, o.cy, radius); });
      const entries = Object.entries(scores).sort((a, b) => b[1] - a[1]);
      const [topOpt, topVal] = entries[0];
      const secondVal = entries[1] ? entries[1][1] : 0;

      let state, detected, confidence;
      if (topVal < threshold) {
        state = 'BLANK'; detected = null; confidence = 1 - topVal / threshold;
      } else if (secondVal >= threshold && (topVal - secondVal) < threshold * 0.25) {
        state = 'MULTIPLE'; detected = null; confidence = 0;
      } else if ((topVal - secondVal) < threshold * 0.4) {
        state = 'UNCERTAIN'; detected = topOpt; confidence = (topVal - secondVal) / (threshold * 0.4);
      } else {
        state = 'VALID'; detected = topOpt; confidence = Math.min(1, (topVal - secondVal) / topVal);
      }
      return { q: row.q, detected, state, confidence: Math.max(0, Math.min(1, confidence)), scores };
    });
  }

  return {
    CANON_W, CANON_H, TEMPLATES,
    detectOrientation, rotateImageToCanvas,
    warpToCanonical, buildGrid, detectAnswers, sampleDarkness
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = OMREngine;
