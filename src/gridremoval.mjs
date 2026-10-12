/* Removing graph-paper grid lines from a thresholded picture.

   Grid lines are many parallel, regularly spaced, nearly straight lines that run across most of
   the picture, possibly slightly tilted.  For each direction (horizontal, then vertical) we find the
   tilt at which the lines line up best, find the rows that are mostly ink at that tilt, and if they
   look like a grid (several, regularly spaced) we erase them, except where ink continues on both
   sides of the line, which is where a pen stroke crosses it. */

const MAX_TILT = 0.06; // about 3.5 degrees
const COVERAGE = 0.35; // fraction of a row that must be ink for it to count as a grid line

export function remove_grid_lines(gdata, width, height) {
  /* gdata is a thresholded image, 0 for ink and 255 for background; modified in place.
     Returns the number of grid lines removed. */
  let removed = 0;
  for (let vertical of [false, true]) {
    // (u, v): u runs along the lines, v across them.
    let U = vertical ? height : width, V = vertical ? width : height;
    let idx = vertical ? (u, v) => u * width + v : (u, v) => v * width + u;
    let ink = (u, v) => v >= 0 && v < V && gdata[idx(u, v)] === 0;
    let cu = U / 2;

    let profile = slope => {
      let prof = new Float64Array(V);
      for (let u = 0; u < U; u++) {
        let shift = slope * (u - cu);
        for (let v = 0; v < V; v++) {
          if (gdata[idx(u, v)] === 0) {
            let w = Math.round(v - shift);
            if (w >= 0 && w < V) prof[w]++;
          }
        }
      }
      return prof;
    };
    let inside = slope => {
      /* For each tilted row, how much of it lies inside the picture. */
      let len = new Float64Array(V);
      for (let u = 0; u < U; u++) {
        let shift = slope * (u - cu);
        for (let w = 0; w < V; w++) {
          let v = Math.round(w + shift);
          if (v >= 0 && v < V) len[w]++;
        }
      }
      return len;
    };
    // The tilt at which the ink lines up best: the profile is then most sharply peaked.
    let best_slope = 0, best_score = -1, best_prof = null;
    for (let slope = -MAX_TILT; slope <= MAX_TILT + 1e-9; slope += 0.0025) {
      let prof = profile(slope);
      let score = 0;
      for (let v = 0; v < V; v++) score += prof[v] * prof[v];
      if (score > best_score) { best_score = score; best_slope = slope; best_prof = prof; }
    }
    for (let h = 0.00125; h > 0.0002; h /= 2) {
      for (let slope of [best_slope - h, best_slope + h]) {
        let prof = profile(slope);
        let score = 0;
        for (let v = 0; v < V; v++) score += prof[v] * prof[v];
        if (score > best_score) { best_score = score; best_slope = slope; best_prof = prof; }
      }
    }

    // Rows that are mostly ink, grouped into lines.  (Tilted rows near the edges are partly
    // outside the picture, so coverage is measured against the part inside.)
    let len = inside(best_slope);
    let lines = [];
    for (let v = 0; v < V; v++) {
      if (len[v] < 0.2 * U || best_prof[v] < COVERAGE * len[v]) continue;
      let last = lines[lines.length - 1];
      if (last && v <= last.v1 + 1) last.v1 = v;
      else lines.push({v0: v, v1: v});
    }
    if (lines.length < 3) continue;
    // Grid lines are regularly spaced (allowing for missing lines).
    let centers = lines.map(l => (l.v0 + l.v1) / 2);
    let gaps = [];
    for (let i = 1; i < centers.length; i++) gaps.push(centers[i] - centers[i - 1]);
    let sorted = gaps.slice().sort((a, b) => a - b);
    let spacing = sorted[Math.floor(sorted.length / 2)];
    let regular = gaps.filter(g => {
      let k = Math.max(1, Math.round(g / spacing));
      return Math.abs(g - k * spacing) <= 0.2 * spacing + 1;
    }).length;
    if (regular < 0.7 * gaps.length || spacing < 4) continue;

    // A pen stroke running right along a grid line merges with it in the profile and makes it look
    // thick, so judge thickness by a typical grid line instead.
    let thicknesses = lines.map(l => l.v1 - l.v0).sort((a, b) => a - b);
    let typical = thicknesses[Math.floor(thicknesses.length / 2)];
    const SECTION = 32;
    for (let line of lines) {
      let thick = Math.min(line.v1 - line.v0, 2 * typical + 1);
      let mid = (line.v0 + line.v1) / 2;
      line = {v0: Math.round(mid - thick / 2), v1: Math.round(mid + thick / 2)};
      // Real grid lines wander by a pixel or two (scanning, camera lenses, compression), so find
      // where the line actually is in each short section along it.
      let offsets = [];
      for (let s0 = 0; s0 < U; s0 += SECTION) {
        let best = 0, best_count = -1;
        for (let d = -3; d <= 3; d++) {
          let count = 0;
          for (let u = s0; u < Math.min(U, s0 + SECTION); u++) {
            let shift = best_slope * (u - cu);
            for (let v = Math.round(line.v0 + shift) + d; v <= Math.round(line.v1 + shift) + d; v++) {
              if (ink(u, v)) count++;
            }
          }
          if (count > best_count || (count === best_count && Math.abs(d) < Math.abs(best))) { best_count = count; best = d; }
        }
        offsets.push(best);
      }
      for (let u = 0; u < U; u++) {
        let shift = best_slope * (u - cu) + offsets[Math.floor(u / SECTION)];
        let a = Math.max(0, Math.round(line.v0 + shift) - 2), b = Math.min(V - 1, Math.round(line.v1 + shift) + 2);
        // Erase a run of ink across the line only if it is no thicker than the grid line itself.
        // A pen stroke crossing or running along the line makes a longer run, so it is kept.
        for (let v = a; v <= b; v++) {
          if (!ink(u, v)) continue;
          let r0 = v, r1 = v;
          while (ink(u, r0 - 1)) r0--;
          while (ink(u, r1 + 1)) r1++;
          if (r1 - r0 <= thick + 3) {
            for (let w = r0; w <= r1; w++) gdata[idx(u, w)] = 255;
          }
          v = r1;
        }
      }
      removed++;
    }
  }
  return removed;
}
