/* Export a knot diagram as a publication-quality vector graphic (SVG or TikZ).
   The diagram keeps the projection it was drawn in: the strands are resampled and then
   relaxed by minimizing a bending energy plus a fidelity term (a smoothing spline on the
   diagram graph), optionally with each crossing pulled to be perpendicular.  The result is fit
   with cubic Bezier curves.  Smoothing is reduced if it would ever introduce a new intersection. */

import {X, Virtual} from "./pd.mjs";
import {palette} from "./constants.mjs";

const SAMPLE_SPACING = 2.5; // spacing (in diagram pixels) of the resampled strands
const FIT_TOLERANCE = 0.05; // maximum Bezier fitting error, as a fraction of the line width
const CROSSING_RADIUS = 18; // radius (in diagram pixels) of the straightened part of a strand at a crossing
const CROSSING_WEIGHT = 30; // strength of the pull toward perpendicular crossings

export function smoothing_length(smoothing) {
  /* The wavelength (in diagram pixels) below which wiggles are removed, for slider value 0..10. */
  return smoothing <= 0 ? 0 : 5 * Math.pow(1.5, smoothing - 1);
}

/* Smoothed geometry shared by all renderings of a diagram at a given smoothing level. */
export class SmoothedDiagram {
  constructor(diag, smoothing, perpendicular=false) {
    /* smoothing is in 0..10; 0 means just resample the drawn curve. */
    this.pos = []; // flat [x0, y0, x1, y1, ...] of global nodes
    this.strands = []; // [{color, nodes: [global node ids, cyclic], kinds: ["over"|"under"|"virtual"|"", ...]}]
    this.virtuals = []; // global node ids of virtual crossings
    this.build(diag);
    this.limited = false; // whether smoothing was reduced to preserve the diagram
    this.relax(smoothing_length(smoothing), perpendicular);
  }

  new_node(x, y) {
    this.pos.push(x, y);
    return this.pos.length / 2 - 1;
  }

  build(diag) {
    let seen = new Set;
    let crossing_nodes = new Map; // diagram vertex id -> global node id
    diag.edges.forEach((edge, eid) => {
      if (seen.has(eid)) return;
      let circuit = diag.dart_circuit(eid + 1);
      circuit.forEach(d => seen.add(Math.abs(d) - 1));

      let vids = circuit.map(d => diag.dart_start(d));
      let kinds = circuit.map(d => {
        let adj = diag.dart_adj(d);
        if (adj instanceof X) return diag.dart_is_over(d) ? "over" : "under";
        if (adj instanceof Virtual) return "virtual";
        return "";
      });

      let anchors = [];
      kinds.forEach((k, i) => { if (k) anchors.push(i); });

      let nodes = [], node_kinds = [];
      let anchor_node = (i) => {
        let vid = vids[i];
        if (!crossing_nodes.has(vid)) {
          let p = diag.verts[vid];
          crossing_nodes.set(vid, this.new_node(p.x, p.y));
          if (kinds[i] === "virtual") this.virtuals.push(crossing_nodes.get(vid));
        }
        return crossing_nodes.get(vid);
      };

      let resample = (pts, closed) => {
        /* Uniformly resample the polyline pts (excluding its last point) by arc length. */
        let lens = [0];
        for (let i = 1; i < pts.length; i++) {
          lens.push(lens[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
        }
        let total = lens[lens.length - 1];
        let n = Math.max(closed ? 8 : 2, Math.round(total / SAMPLE_SPACING));
        let out = [];
        let j = 0;
        for (let k = 0; k < n; k++) {
          let s = total * k / n;
          while (j < pts.length - 2 && lens[j + 1] < s) j++;
          let seg = lens[j + 1] - lens[j];
          let t = seg > 0 ? (s - lens[j]) / seg : 0;
          out.push([pts[j].x + t * (pts[j + 1].x - pts[j].x), pts[j].y + t * (pts[j + 1].y - pts[j].y)]);
        }
        return out;
      };

      if (anchors.length === 0) {
        // An unknotted loop with no crossings.
        let pts = vids.map(v => diag.verts[v]);
        pts.push(pts[0]);
        resample(pts, true).forEach(([x, y]) => {
          nodes.push(this.new_node(x, y));
          node_kinds.push("");
        });
      } else {
        anchors.forEach((a, ai) => {
          let b = anchors[(ai + 1) % anchors.length];
          let pts = [];
          for (let i = a; ; i = (i + 1) % vids.length) {
            pts.push(diag.verts[vids[i]]);
            if (pts.length > 1 && i === b) break;
          }
          let samples = resample(pts, false);
          nodes.push(anchor_node(a));
          node_kinds.push(kinds[a]);
          samples.slice(1).forEach(([x, y]) => {
            nodes.push(this.new_node(x, y));
            node_kinds.push("");
          });
        });
      }
      this.strands.push({color: edge[2], nodes: nodes, kinds: node_kinds});
    });
  }

  crossing_occurrences() {
    /* Map from crossing node to its occurrences [strand index, position in strand]. */
    let occ = new Map;
    this.strands.forEach(({nodes, kinds}, si) => {
      kinds.forEach((k, i) => {
        if (!k) return;
        if (!occ.has(nodes[i])) occ.set(nodes[i], []);
        occ.get(nodes[i]).push([si, i]);
      });
    });
    return occ;
  }

  crossing_angles() {
    /* The (unsigned, at most 90 degree) angle between the strands at each crossing, in degrees. */
    let pos = this.pos, angles = [];
    this.crossing_occurrences().forEach(occs => {
      if (occs.length !== 2) return;
      let [t1, t2] = occs.map(([si, i]) => {
        let nodes = this.strands[si].nodes, m = nodes.length;
        let a = nodes[(i - 2 + m) % m], b = nodes[(i + 2) % m];
        return [pos[2 * b] - pos[2 * a], pos[2 * b + 1] - pos[2 * a + 1]];
      });
      let cos = Math.abs(t1[0] * t2[0] + t1[1] * t2[1]) / (Math.hypot(...t1) * Math.hypot(...t2) || 1);
      angles.push(Math.acos(Math.min(1, cos)) * 180 / Math.PI);
    });
    return angles;
  }

  relax(length, perpendicular) {
    /* Replace the positions with the minimizer of
         sum_v W_v |x_v - T_v|^2 + alpha * sum_strands sum_i |x_{i-1} - 2 x_i + x_{i+1}|^2,
       which damps wiggles with wavelength below `length` while keeping the larger shape.  The targets
       T are the drawn positions, except near crossings when `perpendicular` is set, where they are
       straight perpendicular strands through the crossing (recomputed over a few rounds). */
    if (length <= 0 && !perpendicular) return;
    let x0 = this.pos.slice();
    let baseline = this.count_intersections();
    let alpha0 = Math.pow(Math.max(length, 2 * SAMPLE_SPACING) / (2 * Math.PI * SAMPLE_SPACING), 4);
    let attempts = [];
    (perpendicular ? [true, false] : [false]).forEach(perp => {
      [1, 1/4, 1/16, 1/64].forEach(f => attempts.push([alpha0 * f, perp]));
    });
    for (let k = 0; k < attempts.length; k++) {
      let [alpha, perp] = attempts[k];
      let pos = x0.slice();
      for (let round = 0; round < (perp ? 3 : 1); round++) {
        let {T, W} = this.targets(pos, x0, perp, alpha, length);
        pos = this.solve(alpha, T, W, pos);
      }
      this.pos = pos;
      if (this.count_intersections() <= baseline) {
        this.limited = k > 0;
        return;
      }
    }
    this.pos = x0;
    this.limited = true;
  }

  targets(pos, x0, perpendicular, alpha, length) {
    let n = x0.length / 2;
    let T = Float64Array.from(x0), W = new Float64Array(n).fill(1);
    if (!perpendicular) return {T, W};
    let acc = new Float64Array(2 * n), wacc = new Float64Array(n);
    let K_max = Math.max(1, Math.round(Math.max(CROSSING_RADIUS, length / 8) / SAMPLE_SPACING));
    // The pull has to keep up with the bending stiffness, which grows with the smoothing length.
    let strength = CROSSING_WEIGHT * (1 + Math.sqrt(alpha) / 4);
    this.crossing_occurrences().forEach((occs, c) => {
      if (occs.length !== 2) return;
      let info = occs.map(([si, i]) => {
        let {nodes, kinds} = this.strands[si];
        let m = nodes.length;
        // Stay within half the distance to the neighboring crossings along the strand.
        let gap = m;
        for (let d = 1; d < m; d++) {
          if (kinds[(i + d) % m] || kinds[(i - d + m) % m]) { gap = d; break; }
        }
        let K = Math.max(1, Math.min(K_max, Math.floor(gap / 2)));
        let a = nodes[(i - K + m) % m], b = nodes[(i + K) % m];
        let tx = pos[2 * b] - pos[2 * a], ty = pos[2 * b + 1] - pos[2 * a + 1];
        let len = Math.hypot(tx, ty) || 1;
        return {si, i, K, t: [tx / len, ty / len], h: len / (2 * K)};
      });
      let [o1, o2] = info;
      let sgn = (o1.t[0] * o2.t[0] + o1.t[1] * o2.t[1]) < 0 ? -1 : 1;
      let bx = o1.t[0] + sgn * o2.t[0], by = o1.t[1] + sgn * o2.t[1];
      let bl = Math.hypot(bx, by) || 1;
      bx /= bl; by /= bl;
      let nx = -by, ny = bx;
      let side = (bx * o1.t[1] - by * o1.t[0]) >= 0 ? 1 : -1;
      // Rotate each strand to 45 degrees on its own side of the bisector, keeping its orientation.
      o1.d = [(bx + side * nx) / Math.SQRT2, (by + side * ny) / Math.SQRT2];
      o2.d = [sgn * (bx - side * nx) / Math.SQRT2, sgn * (by - side * ny) / Math.SQRT2];
      let cx = pos[2 * c], cy = pos[2 * c + 1];
      info.forEach(({si, i, K, d, h}) => {
        let nodes = this.strands[si].nodes, m = nodes.length;
        for (let j = -K; j <= K; j++) {
          if (j === 0) continue;
          let v = nodes[(i + j + m) % m];
          let w = strength * Math.pow(1 - Math.abs(j) / (K + 1), 2);
          acc[2 * v] += w * (cx + j * h * d[0]);
          acc[2 * v + 1] += w * (cy + j * h * d[1]);
          wacc[v] += w;
        }
      });
    });
    for (let v = 0; v < n; v++) {
      if (wacc[v] === 0) continue;
      T[2 * v] = (x0[2 * v] + acc[2 * v]) / (1 + wacc[v]);
      T[2 * v + 1] = (x0[2 * v + 1] + acc[2 * v + 1]) / (1 + wacc[v]);
      W[v] = 1 + wacc[v];
    }
    return {T, W};
  }

  strand_preconditioner(alpha, W) {
    /* Additive Schwarz preconditioner: the system restricted to each strand (cut open at one
       point, so it is pentadiagonal) is factored exactly with a banded Cholesky decomposition,
       and the strand solutions are summed.  Shared crossing nodes split their weight. */
    let count = new Float64Array(W.length);
    this.strands.forEach(({nodes}) => nodes.forEach(v => count[v]++));
    let factors = this.strands.map(({nodes}) => {
      let m = nodes.length;
      let d0 = new Float64Array(m), d1 = new Float64Array(m), d2 = new Float64Array(m);
      nodes.forEach((v, i) => { d0[i] = W[v] / count[v]; });
      for (let j = 1; j < m - 1; j++) {
        d0[j - 1] += alpha; d0[j] += 4 * alpha; d0[j + 1] += alpha;
        d1[j] -= 2 * alpha; d1[j + 1] -= 2 * alpha;
        d2[j + 1] += alpha;
      }
      // In place: d0 = L[i][i], d1 = L[i][i-1], d2 = L[i][i-2].
      for (let i = 0; i < m; i++) {
        if (i >= 2) d2[i] /= d0[i - 2]; else d2[i] = 0;
        if (i >= 1) d1[i] = (d1[i] - d2[i] * (i >= 2 ? d1[i - 1] : 0)) / d0[i - 1]; else d1[i] = 0;
        d0[i] = Math.sqrt(d0[i] - d2[i] * d2[i] - d1[i] * d1[i]);
      }
      return {nodes, d0, d1, d2, y: new Float64Array(m)};
    });
    return (r, z) => {
      z.fill(0);
      factors.forEach(({nodes, d0, d1, d2, y}) => {
        let m = nodes.length;
        for (let c = 0; c < 2; c++) {
          for (let i = 0; i < m; i++) {
            y[i] = (r[2 * nodes[i] + c] - (i >= 1 ? d1[i] * y[i - 1] : 0) - (i >= 2 ? d2[i] * y[i - 2] : 0)) / d0[i];
          }
          for (let i = m - 1; i >= 0; i--) {
            y[i] = (y[i] - (i + 1 < m ? d1[i + 1] * y[i + 1] : 0) - (i + 2 < m ? d2[i + 2] * y[i + 2] : 0)) / d0[i];
          }
          for (let i = 0; i < m; i++) z[2 * nodes[i] + c] += y[i];
        }
      });
    };
  }

  solve(alpha, T, W, init) {
    /* Solve (diag(W) + alpha D^T D) x = W T by Jacobi-preconditioned conjugate gradients,
       where D takes second differences along each strand.  x and y share the matrix. */
    let n = W.length;
    let triples = [];
    this.strands.forEach(({nodes}) => {
      let m = nodes.length;
      if (m < 3) return;
      for (let i = 0; i < m; i++) triples.push(nodes[(i + m - 1) % m], nodes[i], nodes[(i + 1) % m]);
    });
    let precondition = this.strand_preconditioner(alpha, W);
    let apply = (x, out) => {
      for (let v = 0; v < n; v++) { out[2 * v] = W[v] * x[2 * v]; out[2 * v + 1] = W[v] * x[2 * v + 1]; }
      for (let k = 0; k < triples.length; k += 3) {
        let a = triples[k], b = triples[k + 1], c = triples[k + 2];
        let rx = alpha * (x[2 * a] - 2 * x[2 * b] + x[2 * c]);
        let ry = alpha * (x[2 * a + 1] - 2 * x[2 * b + 1] + x[2 * c + 1]);
        out[2 * a] += rx; out[2 * b] -= 2 * rx; out[2 * c] += rx;
        out[2 * a + 1] += ry; out[2 * b + 1] -= 2 * ry; out[2 * c + 1] += ry;
      }
    };
    let x = Float64Array.from(init);
    let rhs = new Float64Array(2 * n);
    for (let v = 0; v < n; v++) { rhs[2 * v] = W[v] * T[2 * v]; rhs[2 * v + 1] = W[v] * T[2 * v + 1]; }
    let r = new Float64Array(2 * n), z = new Float64Array(2 * n), p = new Float64Array(2 * n), Ap = new Float64Array(2 * n);
    apply(x, Ap);
    for (let k = 0; k < 2 * n; k++) r[k] = rhs[k] - Ap[k];
    precondition(r, z);
    for (let k = 0; k < 2 * n; k++) p[k] = z[k];
    let rz = 0, bnorm = 0;
    for (let k = 0; k < 2 * n; k++) { rz += r[k] * z[k]; bnorm += rhs[k] * rhs[k]; }
    let tol2 = 1e-12 * bnorm; // relative residual 1e-6, i.e. well under 0.01 pixel
    for (let it = 0; it < 5000; it++) {
      let rr = 0;
      for (let k = 0; k < 2 * n; k++) rr += r[k] * r[k];
      if (rr <= tol2) break;
      apply(p, Ap);
      let pAp = 0;
      for (let k = 0; k < 2 * n; k++) pAp += p[k] * Ap[k];
      if (pAp <= 0) break;
      let step = rz / pAp;
      for (let k = 0; k < 2 * n; k++) { x[k] += step * p[k]; r[k] -= step * Ap[k]; }
      let rz2 = 0;
      precondition(r, z);
      for (let k = 0; k < 2 * n; k++) rz2 += r[k] * z[k];
      let beta = rz2 / rz;
      rz = rz2;
      for (let k = 0; k < 2 * n; k++) p[k] = z[k] + beta * p[k];
    }
    return Array.from(x);
  }

  count_intersections() {
    /* Count proper intersections between strand segments that do not share an endpoint. */
    let pos = this.pos;
    let segs = [];
    this.strands.forEach(({nodes}) => {
      for (let i = 0; i < nodes.length; i++) segs.push([nodes[i], nodes[(i + 1) % nodes.length]]);
    });
    let cell = 4 * SAMPLE_SPACING;
    segs.forEach(([a, b]) => {
      cell = Math.max(cell, Math.hypot(pos[2 * a] - pos[2 * b], pos[2 * a + 1] - pos[2 * b + 1]));
    });
    let grid = new Map;
    segs.forEach(([a, b], si) => {
      let x0 = Math.floor(Math.min(pos[2 * a], pos[2 * b]) / cell), x1 = Math.floor(Math.max(pos[2 * a], pos[2 * b]) / cell);
      let y0 = Math.floor(Math.min(pos[2 * a + 1], pos[2 * b + 1]) / cell), y1 = Math.floor(Math.max(pos[2 * a + 1], pos[2 * b + 1]) / cell);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
        let key = x + "," + y;
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(si);
      }
    });
    let orient = (a, b, c) => (pos[2 * b] - pos[2 * a]) * (pos[2 * c + 1] - pos[2 * a + 1])
        - (pos[2 * b + 1] - pos[2 * a + 1]) * (pos[2 * c] - pos[2 * a]);
    let found = new Set;
    grid.forEach(list => {
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
        let [a, b] = segs[list[i]], [c, d] = segs[list[j]];
        if (a === c || a === d || b === c || b === d) continue;
        if (orient(a, b, c) * orient(a, b, d) < 0 && orient(c, d, a) * orient(c, d, b) < 0) {
          found.add(Math.min(list[i], list[j]) * segs.length + Math.max(list[i], list[j]));
        }
      }
    });
    return found.size;
  }
}

/* Lay out the smoothed diagram in output units (points), cutting gaps at under-crossings.
   Returns {width, height, paths: [{color, closed, pts: [[x,y],...]}], arrows, virtuals}. */
function layout(sd, opts) {
  let {width, line_width, gap, margin} = opts;
  let pos = sd.pos;
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  sd.strands.forEach(({nodes}) => nodes.forEach(v => {
    minx = Math.min(minx, pos[2 * v]); maxx = Math.max(maxx, pos[2 * v]);
    miny = Math.min(miny, pos[2 * v + 1]); maxy = Math.max(maxy, pos[2 * v + 1]);
  }));
  let pad = margin + line_width;
  let scale = (width - 2 * pad) / Math.max(maxx - minx, 1e-9);
  let P = v => [(pos[2 * v] - minx) * scale + pad, (pos[2 * v + 1] - miny) * scale + pad];
  let height = (maxy - miny) * scale + 2 * pad;

  let trim = (pts, center, r) => {
    /* Remove the initial part of pts lying within distance r of center. */
    let d = p => Math.hypot(p[0] - center[0], p[1] - center[1]);
    let i = 0;
    while (i < pts.length - 1 && d(pts[i + 1]) < r) i++;
    if (i >= pts.length - 1) return [];
    let p = pts[i], q = pts[i + 1];
    let dp = d(p), dq = d(q);
    let t = dq > dp ? Math.min(1, Math.max(0, (r - dp) / (dq - dp))) : 0;
    return [[p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]].concat(pts.slice(i + 1));
  };

  let paths = [];
  let arrows = [];
  sd.strands.forEach(({color, nodes, kinds}) => {
    let m = nodes.length;
    let unders = [];
    kinds.forEach((k, i) => { if (k === "under") unders.push(i); });
    let arcs = [];
    if (unders.length === 0) {
      arcs.push({closed: true, pts: nodes.map(P)});
    } else {
      unders.forEach((a, ui) => {
        let b = unders[(ui + 1) % unders.length];
        let pts = [];
        for (let i = a; ; i = (i + 1) % m) {
          pts.push(P(nodes[i]));
          if (pts.length > 1 && i === b) break;
        }
        let ca = pts[0], cb = pts[pts.length - 1];
        pts = trim(pts, ca, gap);
        pts = trim(pts.reverse(), cb, gap).reverse();
        if (pts.length >= 2) arcs.push({closed: false, pts: pts});
      });
    }
    arcs.forEach(arc => paths.push({color: color, closed: arc.closed, pts: uniform(arc.pts, arc.closed)}));

    if (opts.arrows && arcs.length > 0) {
      // Put an arrowhead at the middle of the longest arc of the component.
      let arc_len = pts => {
        let l = 0;
        for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
        return l;
      };
      let best = arcs.reduce((x, y) => arc_len(y.pts) > arc_len(x.pts) ? y : x);
      let pts = best.pts, half = arc_len(pts) / 2, acc = 0;
      for (let i = 1; i < pts.length; i++) {
        let l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
        if (acc + l >= half) {
          let t = l > 0 ? (half - acc) / l : 0;
          let tip = [pts[i - 1][0] + t * (pts[i][0] - pts[i - 1][0]), pts[i - 1][1] + t * (pts[i][1] - pts[i - 1][1])];
          let j0 = Math.max(0, i - 3), j1 = Math.min(pts.length - 1, i + 2);
          let dx = pts[j1][0] - pts[j0][0], dy = pts[j1][1] - pts[j0][1], dn = Math.hypot(dx, dy) || 1;
          arrows.push({color: color, tip: tip, dir: [dx / dn, dy / dn]});
          break;
        }
        acc += l;
      }
    }
  });

  return {
    width: width, height: height, paths: paths, arrows: arrows,
    virtuals: sd.virtuals.map(P)
  };
}

function uniform(pts, closed) {
  /* Resample a polyline at (nearly) its current mean spacing so that samples are evenly spaced,
     which the Bezier fitting relies on.  Trimming at crossing gaps leaves uneven end samples. */
  let src = closed ? pts.concat([pts[0]]) : pts;
  let lens = [0];
  for (let i = 1; i < src.length; i++) {
    lens.push(lens[i - 1] + Math.hypot(src[i][0] - src[i - 1][0], src[i][1] - src[i - 1][1]));
  }
  let total = lens[lens.length - 1];
  let n = Math.max(closed ? 8 : 2, src.length - 1);
  let out = [];
  let j = 0;
  for (let k = 0; k < (closed ? n : n + 1); k++) {
    let s = total * k / n;
    while (j < src.length - 2 && lens[j + 1] < s) j++;
    let seg = lens[j + 1] - lens[j];
    let t = seg > 0 ? Math.min(1, (s - lens[j]) / seg) : 0;
    out.push([src[j][0] + t * (src[j + 1][0] - src[j][0]), src[j][1] + t * (src[j + 1][1] - src[j][1])]);
  }
  return out;
}

function bezier_segments(pts, closed, tolerance) {
  /* Convert densely sampled points to cubic Bezier segments [p0, c1, c2, p1].  Each segment
     is a Hermite curve between two key samples, with tangents estimated from the dense samples;
     key samples are added adaptively until every dense sample is within tolerance of the curve. */
  let n = pts.length;
  let at = i => closed ? pts[((i % n) + n) % n] : pts[Math.max(0, Math.min(n - 1, i))];
  let tangent = i => {
    // Central difference over a few samples (one-sided at the ends of open arcs).
    let a = closed ? i - 2 : Math.max(0, i - 2), b = closed ? i + 2 : Math.min(n - 1, i + 2);
    let p = at(a), q = at(b);
    return [(q[0] - p[0]) / (b - a), (q[1] - p[1]) / (b - a)];
  };
  let segment = (i, j) => {
    let p = at(i), q = at(j), tp = tangent(i), tq = tangent(j), h = (j - i) / 3;
    return [p, [p[0] + h * tp[0], p[1] + h * tp[1]], [q[0] - h * tq[0], q[1] - h * tq[1]], q];
  };
  let error = (i, j) => {
    let [p0, c1, c2, p1] = segment(i, j);
    let worst = 0;
    for (let k = i + 1; k < j; k++) {
      let t = (k - i) / (j - i), s = 1 - t;
      let x = s*s*s*p0[0] + 3*s*s*t*c1[0] + 3*s*t*t*c2[0] + t*t*t*p1[0];
      let y = s*s*s*p0[1] + 3*s*s*t*c1[1] + 3*s*t*t*c2[1] + t*t*t*p1[1];
      let d = at(k);
      worst = Math.max(worst, Math.hypot(x - d[0], y - d[1]));
    }
    return worst;
  };
  let fit = (i, j, out) => {
    if (j - i > 1 && (j - i > 64 || error(i, j) > tolerance)) {
      let m = Math.floor((i + j) / 2);
      fit(i, m, out);
      fit(m, j, out);
    } else {
      out.push(segment(i, j));
    }
  };
  let segs = [];
  if (closed) {
    let quarter = Math.max(1, Math.floor(n / 4));
    for (let k = 0; k < 4; k++) fit(k * quarter, k === 3 ? n : (k + 1) * quarter, segs);
  } else {
    fit(0, n - 1, segs);
  }
  return segs;
}

function hex(color_index, use_colors) {
  let c = use_colors ? palette[color_index - 1] : 0;
  return "#" + c.toString(16).padStart(6, "0");
}

function fmt(x) {
  return (Math.round(x * 100) / 100).toString();
}

function arrow_points(a, line_width) {
  let len = 4 * line_width, half = 1.8 * line_width;
  let [dx, dy] = a.dir, [x, y] = a.tip;
  // Shift the tip forward so the arrowhead is centered on the curve point.
  x += dx * len / 2; y += dy * len / 2;
  return [[x, y],
          [x - dx * len - dy * half, y - dy * len + dx * half],
          [x - dx * len * 0.7, y - dy * len * 0.7],
          [x - dx * len + dy * half, y - dy * len - dx * half]];
}

export function to_svg(sd, opts) {
  let L = layout(sd, opts);
  let out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(L.width)}pt" height="${fmt(L.height)}pt" viewBox="0 0 ${fmt(L.width)} ${fmt(L.height)}">`);
  out.push(`<g fill="none" stroke-width="${fmt(opts.line_width)}" stroke-linecap="round" stroke-linejoin="round">`);
  L.paths.forEach(path => {
    let segs = bezier_segments(path.pts, path.closed, FIT_TOLERANCE * opts.line_width);
    let d = `M${fmt(segs[0][0][0])},${fmt(segs[0][0][1])}`;
    segs.forEach(([p0, c1, c2, p1]) => {
      d += ` C${fmt(c1[0])},${fmt(c1[1])} ${fmt(c2[0])},${fmt(c2[1])} ${fmt(p1[0])},${fmt(p1[1])}`;
    });
    if (path.closed) d += "Z";
    out.push(`<path stroke="${hex(path.color, opts.colors)}" d="${d}"/>`);
  });
  L.virtuals.forEach(([x, y]) => {
    out.push(`<circle stroke="#000000" stroke-width="${fmt(opts.line_width / 2)}" cx="${fmt(x)}" cy="${fmt(y)}" r="${fmt(opts.gap)}"/>`);
  });
  out.push(`</g>`);
  L.arrows.forEach(a => {
    let pts = arrow_points(a, opts.line_width);
    out.push(`<path fill="${hex(a.color, opts.colors)}" d="M${pts.map(p => fmt(p[0]) + "," + fmt(p[1])).join(" L")}Z"/>`);
  });
  out.push(`</svg>`);
  return out.join("\n") + "\n";
}

export function to_tikz(sd, opts) {
  let L = layout(sd, opts);
  let pt = p => `(${fmt(p[0])},${fmt(L.height - p[1])})`;
  let colors = new Map;
  let color_name = c => {
    let h = hex(c, opts.colors);
    if (h === "#000000") return "black";
    if (!colors.has(h)) colors.set(h, "kfcolor" + (colors.size + 1));
    return colors.get(h);
  };
  let body = [];
  L.paths.forEach(path => {
    let segs = bezier_segments(path.pts, path.closed, FIT_TOLERANCE * opts.line_width);
    let s = `\\draw[${color_name(path.color)}] ${pt(segs[0][0])}`;
    segs.forEach(([p0, c1, c2, p1], i) => {
      let end = (path.closed && i === segs.length - 1) ? "cycle" : pt(p1);
      s += `\n  .. controls ${pt(c1)} and ${pt(c2)} .. ${end}`;
    });
    body.push(s + ";");
  });
  L.virtuals.forEach(p => {
    body.push(`\\draw[black, line width=${fmt(opts.line_width / 2)}pt] ${pt(p)} circle (${fmt(opts.gap)});`);
  });
  L.arrows.forEach(a => {
    let pts = arrow_points(a, opts.line_width);
    body.push(`\\fill[${color_name(a.color)}] ${pts.map(pt).join(" -- ")} -- cycle;`);
  });
  let out = [];
  out.push(`% Generated by KnotFolio. Requires \\usepackage{tikz}${colors.size ? " (and xcolor)" : ""}.`);
  colors.forEach((name, h) => out.push(`\\definecolor{${name}}{HTML}{${h.slice(1).toUpperCase()}}`));
  out.push(`\\begin{tikzpicture}[x=1pt, y=1pt, line width=${fmt(opts.line_width)}pt, line cap=round, line join=round]`);
  out.push(...body);
  out.push(`\\end{tikzpicture}`);
  return out.join("\n") + "\n";
}

function download(filename, text, mime) {
  let a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], {type: mime}));
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* Show a modal dialog with a live preview and export controls. */
export function show_export_dialog(diag) {
  let overlay = document.createElement("div");
  overlay.className = "vector-export-overlay";
  overlay.innerHTML = `
    <div class="vector-export">
      <div class="vector-export-preview"></div>
      <div class="vector-export-controls">
        <h1>Export vector graphic</h1>
        <label>Smoothing <input type="range" name="smoothing" min="0" max="10" step="1" value="7"> <span class="smoothing-value"></span></label>
        <label>Width (pt) <input type="number" name="width" min="20" step="10" value="150"></label>
        <label>Line width (pt) <input type="number" name="line_width" min="0.1" step="0.1" value="1.2"></label>
        <label>Crossing gap (pt) <input type="number" name="gap" min="0" step="0.5" value="4"></label>
        <label><input type="checkbox" name="perpendicular" checked> Perpendicular crossings</label>
        <label><input type="checkbox" name="colors" checked> Component colors</label>
        <label><input type="checkbox" name="arrows"> Orientation arrows</label>
        <p class="vector-export-status"></p>
        <div class="vector-export-buttons">
          <input type="button" name="svg" value="Download SVG">
          <input type="button" name="tikz" value="Download TikZ">
          <input type="button" name="copy" value="Copy TikZ">
          <input type="button" name="close" value="Close">
        </div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  let $ = name => overlay.querySelector(`[name="${name}"]`);
  let preview = overlay.querySelector(".vector-export-preview");
  let status = overlay.querySelector(".vector-export-status");

  let cache = new Map;
  let smoothed = () => {
    let s = +$("smoothing").value, perp = $("perpendicular").checked;
    let key = s + "," + perp;
    if (!cache.has(key)) cache.set(key, new SmoothedDiagram(diag, s, perp));
    return cache.get(key);
  };
  let opts = () => ({
    width: Math.max(1, +$("width").value || 150),
    line_width: Math.max(0.01, +$("line_width").value || 1.2),
    gap: Math.max(0, +$("gap").value || 0),
    margin: 2,
    colors: $("colors").checked,
    arrows: $("arrows").checked
  });
  let update = () => {
    overlay.querySelector(".smoothing-value").textContent = $("smoothing").value;
    let sd = smoothed();
    preview.innerHTML = to_svg(sd, opts());
    let angles = sd.crossing_angles();
    let msg = angles.length ? `Crossing angles: ${Math.round(Math.min(...angles))}\u00b0\u2013${Math.round(Math.max(...angles))}\u00b0. ` : "";
    if (sd.limited) msg += "Smoothing was reduced so that no new crossings are introduced.";
    status.textContent = msg;
  };
  overlay.querySelectorAll("input").forEach(el => el.addEventListener("input", update));
  $("svg").addEventListener("click", () => download("knot.svg", to_svg(smoothed(), opts()), "image/svg+xml"));
  $("tikz").addEventListener("click", () => download("knot.tikz", to_tikz(smoothed(), opts()), "text/x-tex"));
  $("copy").addEventListener("click", () => {
    navigator.clipboard.writeText(to_tikz(smoothed(), opts())).then(
      () => { status.textContent = "TikZ code copied to clipboard."; },
      () => { status.textContent = "Could not access the clipboard; use Download TikZ instead."; });
  });
  let close = () => { overlay.remove(); document.removeEventListener("keydown", onkey); };
  let onkey = e => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onkey);
  $("close").addEventListener("click", close);
  overlay.addEventListener("click", e => { if (e.target === overlay) close(); });
  update();
}
