// Local test helper: draws wobbly "hand-drawn" closed curves on the KnotFolio canvas with gaps
// at alternating under-crossings, converts to a diagram, and opens the export dialog.
// Returns {crossings, tikz}.
export async function run(curve_specs, {seed = 11, color = true} = {}) {
  const canvas = document.querySelector('#editor canvas'); const rect = canvas.getBoundingClientRect();
  let rnd = (() => { let s = seed; return () => ((s = s * 16807 % 2147483647) / 2147483647 - 0.5); })();
  let curves = curve_specs.map(([N, f]) => { let jx = 0, jy = 0, p = []; for (let i = 0; i < N; i++) { let t = 2 * Math.PI * i / N; jx = 0.9 * jx + rnd() * 1.2; jy = 0.9 * jy + rnd() * 1.2; let [x, y] = f(t); p.push([x + jx, y + jy]); } return p; });
  const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const inter = (a, b, c, d) => o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
  let skip = curves.map(c => new Array(c.length).fill(false)); let ev = [];
  for (let A = 0; A < curves.length; A++) for (let B = A; B < curves.length; B++) {
    let a = curves[A], b = curves[B];
    for (let i = 0; i < a.length; i++) for (let j = (A == B ? i + 20 : 0); j < b.length; j++) {
      if (A == B && a.length - j + i < 20) continue;
      if (inter(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length])) ev.push([[A, i], [B, j]]);
    }
  }
  let occ = curves.map(() => []); ev.forEach((e, k) => { occ[e[0][0]].push([e[0][1], k, 0]); occ[e[1][0]].push([e[1][1], k, 1]); });
  let underSide = new Map();
  occ.forEach(o => { o.sort((x, y) => x[0] - y[0]); o.forEach(([i, k, s], idx) => { if (!underSide.has(k)) underSide.set(k, idx % 2 == 1 ? s : 1 - s); }); });
  ev.forEach((e, k) => { let [C, i] = e[underSide.get(k)]; let N = curves[C].length; for (let d = -9; d <= 9; d++) skip[C][(i + d + N) % N] = true; });
  const fire = (type, p) => canvas.dispatchEvent(new MouseEvent(type, {clientX: rect.left + 1 + p[0], clientY: rect.top + 1 + p[1], bubbles: true, button: 0, buttons: 1}));
  curves.forEach((pts, C) => {
    let N = pts.length, sk = skip[C]; let down = false; let start = Math.max(0, sk.findIndex(s => s));
    for (let k = 1; k <= N; k++) { let i = (start + k) % N; if (sk[i]) { if (down) { fire('mouseup', pts[i]); down = false; } continue; }
      if (!down) { fire('mousedown', pts[i]); down = true; } else fire('mousemove', pts[i]); }
    if (down) fire('mouseup', pts[start]);
  });
  const wait = ms => new Promise(r => setTimeout(r, ms));
  [...document.querySelectorAll('#tools input[type=button]')].find(b => b.value == 'Convert to diagram').click();
  await wait(1500);
  if (color) { document.querySelector('input[value="Auto-color"]').click(); await wait(800); }
  document.querySelector('input[value="Export vector graphic"]').click();
  let got; navigator.clipboard.writeText = async t => { got = t; };
  document.querySelector('[name=copy]').click(); await wait(100);
  return {crossings: ev.length, tikz: got};
}
