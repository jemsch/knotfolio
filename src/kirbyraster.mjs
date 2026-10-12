/* Separating Kirby diagram decorations from a painted or imported link picture.

   Kirby diagrams decorate link components with framing labels (like "0" or "-1") and mark
   1-handles with a dot drawn on the circle.  The ordinary converter would read these marks as
   parts of the link.  Here we find them in the raster buffer, remove them, and report where
   they were, so that the cleaned-up picture can be converted as usual.

   - Labels are small clusters of strokes that are not attached at both ends to the rest of the
     picture.  (Short link arcs between two crossings are attached at both ends.)
   - Dots are places where the strokes are much thicker than usual (a filled dot) or where the
     thinned picture has a junction (a scribbled dot).  A dot is erased and the curve passing
     through it is redrawn as a plain stroke. */

import {Point} from "./geom2d.mjs";

export function extract_kirby_marks(buf, skel, width, height, second_pass=false) {
  /* buf is the painting and skel is its morphological thinning (from clean_up).  Both are modified
     in place to remove the marks.  Returns {dots: [Point], labels: [Point], unresolved: [Point]}. */
  let N = width * height;
  let ink_count = 0, skel_count = 0;
  for (let i = 0; i < N; i++) {
    if (buf[i] > 0) ink_count++;
    if (skel[i] > 0) skel_count++;
  }
  if (skel_count === 0) return {dots: [], labels: [], unresolved: []};
  let w = Math.max(1, ink_count / skel_count); // typical stroke width

  let neighbors = (i, f) => {
    let x = i % width, y = (i - x) / width;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      let x2 = x + dx, y2 = y + dy;
      if (x2 >= 0 && x2 < width && y2 >= 0 && y2 < height) f(y2 * width + x2);
    }
  };

  // Connected components of the ink.
  let comp = new Int32Array(N).fill(-1);
  let comps = [];
  for (let i = 0; i < N; i++) {
    if (buf[i] <= 0 || comp[i] >= 0) continue;
    let c = {id: comps.length, x0: width, y0: height, x1: 0, y1: 0, pixels: [], endpoints: []};
    comps.push(c);
    let stack = [i];
    comp[i] = c.id;
    while (stack.length) {
      let j = stack.pop();
      c.pixels.push(j);
      let x = j % width, y = (j - x) / width;
      c.x0 = Math.min(c.x0, x); c.x1 = Math.max(c.x1, x);
      c.y0 = Math.min(c.y0, y); c.y1 = Math.max(c.y1, y);
      neighbors(j, k => {
        // pieces are connected strokes of one color
        if (buf[k] === buf[i] && comp[k] < 0) { comp[k] = c.id; stack.push(k); }
      });
    }
  }
  // Skeleton endpoints and junctions.
  let junctions = [];
  for (let i = 0; i < N; i++) {
    if (skel[i] <= 0) continue;
    let x = i % width, y = (i - x) / width;
    if (x === 0 || y === 0 || x === width - 1 || y === height - 1) continue;
    // Number of branches: groups of neighboring skeleton pixels that touch each other.
    let nb = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if ((dx || dy) && skel[(y + dy) * width + x + dx] === skel[i]) nb.push([dx, dy]);
    }
    let count = nb.length;
    let parent = nb.map((_, k) => k);
    let root = k => parent[k] === k ? k : (parent[k] = root(parent[k]));
    for (let a = 0; a < count; a++) for (let b = a + 1; b < count; b++) {
      if (Math.max(Math.abs(nb[a][0] - nb[b][0]), Math.abs(nb[a][1] - nb[b][1])) <= 1) parent[root(a)] = root(b);
    }
    let runs = nb.filter((_, k) => root(k) === k).length;
    if (runs === 1) {
      if (comp[i] >= 0) comps[comp[i]].endpoints.push(i);
    } else if (runs >= 3) {
      junctions.push(i);
    }
  }

  // Distance from each ink pixel to the background (chamfer distance transform).
  let dt = new Float32Array(N);
  for (let i = 0; i < N; i++) dt[i] = buf[i] > 0 ? 1e9 : 0;
  const D = Math.SQRT2;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let i = y * width + x;
    if (dt[i] === 0) continue;
    let v = dt[i];
    if (x > 0) v = Math.min(v, dt[i - 1] + 1);
    if (y > 0) {
      v = Math.min(v, dt[i - width] + 1);
      if (x > 0) v = Math.min(v, dt[i - width - 1] + D);
      if (x < width - 1) v = Math.min(v, dt[i - width + 1] + D);
    }
    if (x === 0 || y === 0 || x === width - 1 || y === height - 1) v = Math.min(v, 1);
    dt[i] = v;
  }
  for (let y = height - 1; y >= 0; y--) for (let x = width - 1; x >= 0; x--) {
    let i = y * width + x;
    if (dt[i] === 0) continue;
    let v = dt[i];
    if (x < width - 1) v = Math.min(v, dt[i + 1] + 1);
    if (y < height - 1) {
      v = Math.min(v, dt[i + width] + 1);
      if (x < width - 1) v = Math.min(v, dt[i + width + 1] + D);
      if (x > 0) v = Math.min(v, dt[i + width - 1] + D);
    }
    dt[i] = v;
  }
  // Typical half-width of a stroke.  (The thinned picture need not run down the middle of each
  // stroke, so measure from all of the ink: across a stroke, the distance to the edge runs from 1
  // up to the half-width, so a high percentile of it is close to the half-width.)
  let half_width = values => {
    if (values.length === 0) return 1;
    values.sort((a, b) => a - b);
    return Math.max(1, values[Math.floor(0.9 * (values.length - 1))]);
  };
  let all_dts = [];
  for (let i = 0; i < N; i++) if (buf[i] > 0) all_dts.push(dt[i]);
  let r0 = half_width(all_dts);
  // Strokes can have quite different widths (different pens, or pressure), so also find the
  // typical half-width of each piece.
  let piece_r0 = comps.map(c => c.pixels.length >= 20 ? half_width(c.pixels.map(p => dt[p])) : r0);

  // --- Labels ---
  const LABEL_MAX = 0.1 * Math.min(width, height);
  const LABEL_GAP = Math.max(3 * w, 15);
  const GAP_MAX = Math.max(14 * w, 80); // the largest distance across an under-crossing gap
  let all_endpoints = [];
  comps.forEach(c => c.endpoints.forEach(e => all_endpoints.push(e)));
  let local_direction = (k, R, f) => {
    /* The main direction (unit vector) of the ink of the piece containing pixel k, near it,
       or with f given, the direction pointing out of the stroke end k. */
    let kx = k % width, ky = (k - kx) / width, piece = comp[k], Ri = Math.ceil(R);
    let n = 0, mx = 0, my = 0, sxx = 0, sxy = 0, syy = 0;
    for (let dy = -Ri; dy <= Ri; dy++) for (let dx = -Ri; dx <= Ri; dx++) {
      let x = kx + dx, y = ky + dy;
      if (x < 0 || y < 0 || x >= width || y >= height || dx * dx + dy * dy > R * R) continue;
      if (skel[y * width + x] > 0 && comp[y * width + x] === piece) {
        n++; mx += dx; my += dy; sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
      }
    }
    if (n < 2) return null;
    if (f) { let l = Math.hypot(mx, my) || 1; return [-mx / l, -my / l]; } // from the stroke toward its end
    mx /= n; my /= n;
    let a = sxx / n - mx * mx, b = sxy / n - mx * my, c = syy / n - my * my;
    let theta = 0.5 * Math.atan2(2 * b, a - c);
    return [Math.cos(theta), Math.sin(theta)];
  };
  let has_partner = e => {
    /* Does this stroke end look like one side of an under-crossing?  That is, is there another
       stroke end nearby, of a different piece, facing it, with a third piece (the over-strand)
       crossing the gap between them?  (The characters of a label like "3-n" are not like this:
       the "-" runs along the gap rather than across it.) */
    let ex = e % width, ey = (e - ex) / width;
    // Directions are measured close to the stroke end, since small circles curve tightly.
    const NEAR = 2 * r0 + 5;
    let de = local_direction(e, NEAR, true);
    return all_endpoints.some(f => {
      if (comp[f] === comp[e]) return false;
      let fx = f % width, fy = (f - fx) / width;
      let d = Math.hypot(fx - ex, fy - ey);
      if (d > GAP_MAX || d < 2) return false;
      let ux = (fx - ex) / d, uy = (fy - ey) / d;
      let df = local_direction(f, NEAR, true);
      if (!de || !df || de[0] * ux + de[1] * uy < 0.3 || -(df[0] * ux + df[1] * uy) < 0.3) return false;
      for (let t = 2; t < d - 2; t += 0.5) {
        let x = Math.round(ex + ux * t), y = Math.round(ey + uy * t);
        let k = y * width + x;
        if (buf[k] > 0 && comp[k] !== comp[e] && comp[k] !== comp[f]) {
          let dk = local_direction(k, 2.5 * w, false);
          return !dk || Math.abs(dk[0] * ux + dk[1] * uy) < 0.87; // crosses at more than 30 degrees
        }
      }
      return false;
    });
  };
  // Specks (noise from photos, scans or compression) are just removed.
  comps.forEach(c => {
    if (c.pixels.length < 2 * r0 * r0) c.pixels.forEach(p => { buf[p] = 0; skel[p] = 0; });
  });
  let small = comps.filter(c => c.pixels.length >= 2 * r0 * r0 && Math.max(c.x1 - c.x0, c.y1 - c.y0) <= LABEL_MAX);
  // Short arcs of the link between two crossings are simple pieces with two ends, both at
  // under-crossings; they are not writing, and must not be grouped with nearby writing.
  small = small.filter(c => !(c.endpoints.length === 2 && c.endpoints.every(e => has_partner(e))));
  // Group small components that are close together (like the "-" and "1" of "-1").
  let group = small.map((c, i) => i);
  let find = i => group[i] === i ? i : (group[i] = find(group[i]));
  for (let a = 0; a < small.length; a++) for (let b = a + 1; b < small.length; b++) {
    let A = small[a], B = small[b];
    let gx = Math.max(0, Math.max(A.x0, B.x0) - Math.min(A.x1, B.x1));
    let gy = Math.max(0, Math.max(A.y0, B.y0) - Math.min(A.y1, B.y1));
    if (Math.max(gx, gy) <= LABEL_GAP) group[find(a)] = find(b);
  }
  let clusters = new Map;
  small.forEach((c, i) => {
    let g = find(i);
    if (!clusters.has(g)) clusters.set(g, []);
    clusters.get(g).push(c);
  });
  let labels = [];
  clusters.forEach(cs => {
    let x0 = Math.min(...cs.map(c => c.x0)), x1 = Math.max(...cs.map(c => c.x1));
    let y0 = Math.min(...cs.map(c => c.y0)), y1 = Math.max(...cs.map(c => c.y1));
    if (Math.max(x1 - x0, y1 - y0) > 1.5 * LABEL_MAX) return;
    // too small to be writing (judged by the label's own pen width)
    if (Math.max(x1 - x0, y1 - y0) < 3 * Math.min(...cs.map(c => piece_r0[c.id]))) return;
    cs.forEach(c => c.pixels.forEach(p => { buf[p] = 0; skel[p] = 0; }));
    labels.push(new Point((x0 + x1) / 2, (y0 + y1) / 2));
  });

  // --- Dots ---
  let candidates = [];
  for (let i = 0; i < N; i++) {
    if (buf[i] <= 0) continue;
    let rc = piece_r0[comp[i]];
    if (dt[i] >= Math.max(1.7 * rc + 1, rc + 2.5)) candidates.push(i);
  }
  junctions.forEach(i => { if (buf[i] > 0) candidates.push(i); });
  // Cluster candidate pixels that are near each other.
  let cell = Math.max(4, Math.ceil(3 * w));
  let buckets = new Map;
  candidates.forEach((p, idx) => {
    let x = p % width, y = (p - x) / width;
    let key = Math.floor(x / cell) + "," + Math.floor(y / cell);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(idx);
  });
  let cgroup = candidates.map((p, i) => i);
  let cfind = i => cgroup[i] === i ? i : (cgroup[i] = cfind(cgroup[i]));
  candidates.forEach((p, idx) => {
    let x = p % width, y = (p - x) / width;
    let bx = Math.floor(x / cell), by = Math.floor(y / cell);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      (buckets.get((bx + dx) + "," + (by + dy)) || []).forEach(j => {
        let q = candidates[j], qx = q % width, qy = (q - qx) / width;
        if (Math.hypot(qx - x, qy - y) <= cell) cgroup[cfind(idx)] = cfind(j);
      });
    }
  });
  let dot_clusters = new Map;
  candidates.forEach((p, i) => {
    let g = cfind(i);
    if (!dot_clusters.has(g)) dot_clusters.set(g, []);
    dot_clusters.get(g).push(p);
  });

  let ring = (cx, cy, R, piece) => {
    /* The runs of ink met when going around the circle of radius R; each run is [angle, length]. */
    let n = Math.max(16, Math.ceil(2 * Math.PI * R * 1.5));
    let s = [];
    for (let k = 0; k < n; k++) {
      let a = 2 * Math.PI * k / n;
      let x = Math.round(cx + R * Math.cos(a)), y = Math.round(cy + R * Math.sin(a));
      s.push(x >= 0 && y >= 0 && x < width && y < height && buf[y * width + x] > 0 && comp[y * width + x] === piece ? 1 : 0);
    }
    if (s.every(v => v)) return null;
    let start = s.indexOf(0);
    let runs = [], cur = null;
    for (let k = 1; k <= n; k++) {
      let j = (start + k) % n;
      if (s[j]) {
        if (!cur) { cur = {first: j, count: 0}; runs.push(cur); }
        cur.count++;
      } else {
        cur = null;
      }
    }
    return runs.map(r => {
      let mid = (r.first + (r.count - 1) / 2) % n;
      return {angle: 2 * Math.PI * mid / n, length: r.count * 2 * Math.PI * R / n};
    });
  };

  let repaired = 0;
  let repair_fused = (cx, cy, r, piece) => {
    /* An under-strand that touches its over-strand makes a T: two branches continue straight
       through (the over-strand) and a third runs into it.  Cut a gap in the third branch, which
       is the "little erasing" that would otherwise have to be done by hand. */
    for (let R = Math.max(r, 2 * w); R <= r + 3 * w; R += 1) {
      let runs = ring(cx, cy, R, piece);
      if (!runs) continue;
      runs = runs.filter(run => run.length > 2);
      if (runs.length !== 3 || !runs.every(run => run.length <= 1.6 * w + 3)) continue;
      // The over-strand is the pair of branches closest to opposite each other.
      let best = null;
      for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) {
        let d = Math.abs(((runs[i].angle - runs[j].angle) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI);
        if (!best || d < best.d) best = {d, i, j, k: 3 - i - j};
      }
      if (best.d > 50 * Math.PI / 180) return false;
      let a = runs[best.i].angle, b = runs[best.j].angle, u = runs[best.k];
      // direction of the over-strand, and of the branch running into it
      let ox = Math.cos(a) - Math.cos(b), oy = Math.sin(a) - Math.sin(b), on = Math.hypot(ox, oy) || 1;
      ox /= on; oy /= on;
      let half = u.length / (2 * R) + 0.35;
      let reach = R + 1.5 * w, Ri = Math.ceil(reach);
      for (let dy = -Ri; dy <= Ri; dy++) for (let dx = -Ri; dx <= Ri; dx++) {
        let x = Math.round(cx) + dx, y = Math.round(cy) + dy;
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        let px = x - cx, py = y - cy, dist = Math.hypot(px, py);
        if (dist > reach) continue;
        let off = Math.abs(px * oy - py * ox); // distance from the over-strand's center line
        if (off < r0 + 1.5) continue;
        let ang = Math.atan2(py, px), da = Math.abs(((ang - u.angle) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI);
        if (da > half) continue;
        let k = y * width + x;
        if (comp[k] === piece) { buf[k] = 0; skel[k] = 0; }
      }
      repaired++;
      return true;
    }
    return false;
  };

  let dots = [], unresolved = [];
  dot_clusters.forEach(pixels => {
    // Only consider the piece of the picture that the dot is part of.
    let piece = comp[pixels[0]];
    pixels = pixels.filter(p => comp[p] === piece);
    let rp = piece_r0[piece];
    let cx = 0, cy = 0;
    pixels.forEach(p => { let x = p % width; cx += x; cy += (p - x) / width; });
    cx /= pixels.length; cy /= pixels.length;
    let r = rp, extent = 0, sxx = 0, sxy = 0, syy = 0;
    pixels.forEach(p => {
      let x = p % width, y = (p - x) / width, d = Math.hypot(x - cx, y - cy);
      r = Math.max(r, d + dt[p]);
      extent = Math.max(extent, d);
      sxx += (x - cx) * (x - cx); sxy += (x - cx) * (y - cy); syy += (y - cy) * (y - cy);
    });
    // A dot (filled or scribbled) is about as wide as it is long; a thick stretch of a stroke
    // is long and narrow, so it is not a dot.
    let tr = (sxx + syy) / pixels.length, det = (sxx * syy - sxy * sxy) / (pixels.length * pixels.length);
    let disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
    let major = tr / 2 + disc, minor = Math.max(1e-9, tr / 2 - disc);
    if (extent > 3 * rp + 3 && major > 9 * minor) return;
    // Nothing much bigger than a few stroke widths is a dot.
    if (r > 6 * rp + 10) return;
    // Grow the radius until the circle only meets ordinary strokes, then see where they leave.
    // (Specks of one or two pixels are ignored.)
    let R = r, runs = null, found = false;
    // Never look further than a few stroke widths, so that a mistake cannot erase a large area.
    for (; R <= r + 3 * w + 4; R += 1) {
      runs = ring(cx, cy, R, piece);
      if (runs) runs = runs.filter(run => run.length > 2);
      if (runs && runs.length === 2 && runs.every(run => run.length <= 1.6 * w + 3)) { found = true; break; }
    }
    if (!found) {
      if (!repair_fused(cx, cy, r, piece)) unresolved.push(new Point(cx, cy));
      return;
    }
    // A dot carries much more ink than a plain stroke passing through the same circle.  (A short
    // stub sticking out of a stroke also makes a junction, but not much extra ink.)
    let mass = 0, Rm = Math.ceil(R);
    for (let dy = -Rm; dy <= Rm; dy++) for (let dx = -Rm; dx <= Rm; dx++) {
      let x = Math.round(cx) + dx, y = Math.round(cy) + dy;
      if (x < 0 || y < 0 || x >= width || y >= height || Math.hypot(x - cx, y - cy) > R) continue;
      let k = y * width + x;
      if (buf[k] > 0 && comp[k] === piece) mass++;
    }
    // Otherwise it is just a stroke with a spur, which is cleaned up the same way but is not a dot.
    let line_width = Math.max(1, 2 * rp - 1); // stroke width from its measured half-thickness
    let is_dot = mass >= 1.5 * 2 * R * line_width;
    // A junction that is not a dot is cleaned up only if it is small (a spur on a stroke).
    if (!is_dot && R > r + 1.5 * w + 2) {
      if (!repair_fused(cx, cy, r, piece)) unresolved.push(new Point(cx, cy));
      return;
    }
    let ends = runs.map(run => [cx + (R + 1) * Math.cos(run.angle), cy + (R + 1) * Math.sin(run.angle)]);
    let color = 0;
    ends.forEach(([x, y]) => {
      let c = buf[Math.round(y) * width + Math.round(x)];
      if (c > 0) color = c;
    });
    if (!color) {
      // the ring sample hit ink, so look around it for the color
      for (let p of pixels) if (buf[p] > 0) { color = buf[p]; break; }
    }
    // Erase the dot and redraw the strand through it as a stroke of typical width.
    let Ri = Math.ceil(R);
    for (let dy = -Ri; dy <= Ri; dy++) for (let dx = -Ri; dx <= Ri; dx++) {
      let x = Math.round(cx) + dx, y = Math.round(cy) + dy;
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      if (Math.hypot(x - cx, y - cy) <= R) buf[y * width + x] = 0;
    }
    let [[x1, y1], [x2, y2]] = ends;
    let len = Math.hypot(x2 - x1, y2 - y1), half = Math.max(0.5, w / 2);
    for (let t = 0; t <= len; t += 0.5) {
      let x = x1 + (x2 - x1) * t / len, y = y1 + (y2 - y1) * t / len;
      let hr = Math.ceil(half);
      for (let dy = -hr; dy <= hr; dy++) for (let dx = -hr; dx <= hr; dx++) {
        let px = Math.round(x) + dx, py = Math.round(y) + dy;
        if (px < 0 || py < 0 || px >= width || py >= height) continue;
        if (Math.hypot(px - x, py - y) <= half) buf[py * width + px] = color;
      }
    }
    // Same edit for the thinned picture: cut out the dot and join the two skeleton ends.
    let skel_ends = ends.map(([ex, ey]) => {
      let best = null, bd = Infinity, Rs = Math.ceil(R + 4 + w);
      for (let dy = -Rs; dy <= Rs; dy++) for (let dx = -Rs; dx <= Rs; dx++) {
        let x = Math.round(cx) + dx, y = Math.round(cy) + dy;
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        let k = y * width + x;
        if (skel[k] <= 0 || comp[k] !== piece || Math.hypot(x - cx, y - cy) <= R) continue;
        let d = Math.hypot(x - ex, y - ey);
        if (d < bd) { bd = d; best = [x, y]; }
      }
      return best;
    });
    for (let dy = -Ri; dy <= Ri; dy++) for (let dx = -Ri; dx <= Ri; dx++) {
      let x = Math.round(cx) + dx, y = Math.round(cy) + dy;
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      if (Math.hypot(x - cx, y - cy) <= R) skel[y * width + x] = 0;
    }
    if (skel_ends[0] && skel_ends[1]) {
      let [[sx1, sy1], [sx2, sy2]] = skel_ends;
      let slen = Math.max(1, Math.hypot(sx2 - sx1, sy2 - sy1));
      for (let t = 0; t <= slen; t += 0.25) {
        let x = Math.round(sx1 + (sx2 - sx1) * t / slen), y = Math.round(sy1 + (sy2 - sy1) * t / slen);
        skel[y * width + x] = color;
      }
    }
    if (is_dot) dots.push(new Point(cx, cy));
  });

  if (repaired > 0 && !second_pass) {
    // Cutting fused crossings can free writing that touched a strand, so look again.
    let again = extract_kirby_marks(buf, skel, width, height, true);
    return {dots: dots.concat(again.dots), labels: labels.concat(again.labels), unresolved: again.unresolved};
  }
  return {dots, labels, unresolved};
}
