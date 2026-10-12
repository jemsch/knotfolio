/* Keeping the colors of an imported drawing.

   Drawings of links and Kirby diagrams often give each component its own color.  KnotFolio's
   converter only matches up the two sides of an under-crossing within one color, and strokes of
   different colors never fuse together, so keeping the colors makes conversion much more reliable.

   The distinct ink colors are found by grouping the hues of the saturated ink pixels; each group is
   given a different palette color (the one with the nearest hue that is not yet taken).  Grey and
   black ink stays black.  At the edges of strokes the color blurs into the background, so each
   pixel finally takes the most common color among the ink pixels around it. */

import {palette} from "./constants.mjs";

function hsv(r, g, b) {
  let max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  return [h, max > 0 ? d / max : 0, max / 255];
}

const hue_distance = (a, b) => { let d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };

// Palette entries (1-based) that can stand for a colored component, with their hues.
// Black (1) is for uncolored ink, and grey (5) is skipped since it looks like pencil.
const COLOR_CHOICES = [2, 3, 4, 6, 7, 8, 9, 10].map(i => {
  let c = palette[i - 1];
  return {index: i, hue: hsv((c >> 16) & 255, (c >> 8) & 255, c & 255)[0]};
});

export function classify_ink_colors(rgba, ink, width, height) {
  /* rgba: the picture's colors; ink: true where there is ink.  Returns palette indices (1-based)
     for each pixel, 0 where there is no ink. */
  let n = width * height;
  let hues = new Float32Array(n).fill(-1); // -1 for uncolored ink
  const SAT = 0.2;
  for (let i = 0; i < n; i++) {
    if (!ink[i]) continue;
    let [h, s, v] = hsv(rgba[4 * i], rgba[4 * i + 1], rgba[4 * i + 2]);
    if (s >= SAT && v >= 0.25) hues[i] = h;
  }
  // Hue histogram with 10-degree bins, smoothed; its peaks are the ink colors.
  let hist = new Float64Array(36), colored = 0;
  for (let i = 0; i < n; i++) if (hues[i] >= 0) { hist[Math.floor(hues[i] / 10) % 36]++; colored++; }
  let smooth = hist.map((_, k) => hist[(k + 35) % 36] + 2 * hist[k] + hist[(k + 1) % 36]);
  let peaks = [];
  for (let k = 0; k < 36; k++) {
    let v = smooth[k];
    if (v > smooth[(k + 35) % 36] && v >= smooth[(k + 1) % 36] && v > 0.015 * colored * 4) peaks.push({hue: k * 10 + 5, weight: v});
  }
  // Merge peaks that are close together, keeping the heavier one.
  peaks.sort((a, b) => b.weight - a.weight);
  let kept = [];
  peaks.forEach(p => { if (kept.every(q => hue_distance(p.hue, q.hue) > 25)) kept.push(p); });
  // A small amount of ink in a very different hue (say one small pink circle) is still its own
  // color, rather than being forced onto the nearest common color.
  for (let k = 0; k < 36; k++) {
    let v = smooth[k], hue = k * 10 + 5;
    if (v > smooth[(k + 35) % 36] && v >= smooth[(k + 1) % 36] && v > 0.002 * colored * 4
        && kept.every(q => hue_distance(hue, q.hue) > 45)) {
      kept.push({hue, weight: v});
    }
  }
  kept = kept.slice(0, COLOR_CHOICES.length);
  // Give each ink color a palette color, heaviest first.
  let used = new Set;
  kept.forEach(p => {
    let best = null;
    COLOR_CHOICES.forEach(c => {
      if (used.has(c.index)) return;
      if (!best || hue_distance(c.hue, p.hue) < hue_distance(best.hue, p.hue)) best = c;
    });
    p.index = best.index;
    used.add(best.index);
  });

  let first = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!ink[i]) continue;
    if (hues[i] < 0 || kept.length === 0) { first[i] = 1; continue; }
    let best = kept[0];
    kept.forEach(p => { if (hue_distance(p.hue, hues[i]) < hue_distance(best.hue, hues[i])) best = p; });
    first[i] = best.index;
  }
  // Majority vote among nearby ink pixels.  Colored pixels count double, since stroke edges and
  // compression make colored ink look grey but not the other way around.
  const R = 2;
  let out = new Uint8Array(n);
  let votes = new Float64Array(11);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let i = y * width + x;
    if (!ink[i]) continue;
    votes.fill(0);
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      let x2 = x + dx, y2 = y + dy;
      if (x2 < 0 || y2 < 0 || x2 >= width || y2 >= height) continue;
      let c = first[y2 * width + x2];
      if (c) votes[c] += c === 1 ? 1 : 2;
    }
    let best = 1;
    for (let c = 2; c <= 10; c++) if (votes[c] > votes[best]) best = c;
    out[i] = best;
  }
  return out;
}
