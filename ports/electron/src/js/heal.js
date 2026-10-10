// Spot healing, ported from the macOS app's HealPixels.c. The stroke's coverage is
// the hole; a ring around it anchors a membrane solve (multi-level coarsening plus
// SOR), and Content-Aware / Proximity Match first look for a source patch whose own
// ring matches the hole's ring. Modes index like SpotHealingMode.allCases:
// 0 Content-Aware, 1 Very Smooth (no source, adds fine-grain noise), 2 Proximity Match.

const OUTSIDE = 0;
const RING = 1;
const HOLE = 2;

function healHash(x) {
  x = (x ^ (x >>> 16)) >>> 0;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  return x;
}

function healUnit(key) {
  return (healHash(key) >>> 8) / 16777216.0;
}

function coverageBounds(coverage, width, height) {
  let x0 = width, y0 = height, x1 = 0, y1 = 0;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      if (!coverage[row + x]) continue;
      if (x < x0) x0 = x;
      if (x + 1 > x1) x1 = x + 1;
      if (y < y0) y0 = y;
      if (y + 1 > y1) y1 = y + 1;
    }
  }
  if (x1 <= x0 || y1 <= y0) { x0 = 0; y0 = 0; x1 = 0; y1 = 0; }
  return [x0, y0, x1, y1];
}

// Mean squared difference between the ring around the spot and the ring around the
// patch offset by (dx, dy). Infinite when the patch would overlap the spot or leave
// the image.
function score(data, width, height, role, wx0, wy0, ww, wh, dx, dy) {
  if (Math.abs(dx) < ww && Math.abs(dy) < wh) return Infinity;
  if (wx0 + dx < 0 || wy0 + dy < 0 || wx0 + ww + dx > width || wy0 + wh + dy > height) return Infinity;
  let sum = 0;
  let n = 0;
  for (let y = 0; y < wh; y += 1) {
    for (let x = 0; x < ww; x += 1) {
      if (role[y * ww + x] !== RING) continue;
      const t = ((wy0 + y) * width + (wx0 + x)) * 4;
      const s = ((wy0 + y + dy) * width + (wx0 + x + dx)) * 4;
      for (let c = 0; c < 4; c += 1) {
        const d = data[t + c] - data[s + c];
        sum += d * d;
      }
      n += 1;
    }
  }
  return n ? sum / n : Infinity;
}

// Solves for smooth values over HOLE pixels, fixed to the RING values around them.
// A coarser copy is solved first and used as the starting point, so large spots
// settle in few passes.
function solve(value, role, w, h, depth) {
  let iterations = 300;
  if (w > 32 && h > 32 && depth < 16) {
    const cw = (w + 1) >> 1;
    const ch = (h + 1) >> 1;
    const coarse = new Float32Array(cw * ch * 4);
    const coarseRole = new Uint8Array(cw * ch);
    for (let y = 0; y < ch; y += 1) {
      for (let x = 0; x < cw; x += 1) {
        let known = 0, hole = 0;
        const knownSum = [0, 0, 0, 0];
        const holeSum = [0, 0, 0, 0];
        for (let j = 0; j < 2; j += 1) {
          for (let i = 0; i < 2; i += 1) {
            const fx = x * 2 + i;
            const fy = y * 2 + j;
            if (fx >= w || fy >= h) continue;
            const p = fy * w + fx;
            if (role[p] === RING) {
              known += 1;
              for (let c = 0; c < 4; c += 1) knownSum[c] += value[p * 4 + c];
            } else if (role[p] === HOLE) {
              hole += 1;
              for (let c = 0; c < 4; c += 1) holeSum[c] += value[p * 4 + c];
            }
          }
        }
        const q = y * cw + x;
        if (known) {
          coarseRole[q] = RING;
          for (let c = 0; c < 4; c += 1) coarse[q * 4 + c] = knownSum[c] / known;
        } else if (hole) {
          coarseRole[q] = HOLE;
          for (let c = 0; c < 4; c += 1) coarse[q * 4 + c] = holeSum[c] / hole;
        }
      }
    }
    solve(coarse, coarseRole, cw, ch, depth + 1);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const p = y * w + x;
        const q = ((y / 2) | 0) * cw + ((x / 2) | 0);
        if (role[p] === HOLE && coarseRole[q] === HOLE) {
          for (let c = 0; c < 4; c += 1) value[p * 4 + c] = coarse[q * 4 + c];
        }
      }
    }
    iterations = 40;
  }
  const omega = 1.8;
  for (let it = 0; it < iterations; it += 1) {
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const p = y * w + x;
        if (role[p] !== HOLE) continue;
        const sum = [0, 0, 0, 0];
        let n = 0;
        const neighbors = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]];
        for (let k = 0; k < 4; k += 1) {
          const nx = neighbors[k][0];
          const ny = neighbors[k][1];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const q = ny * w + nx;
          if (role[q] === OUTSIDE) continue;
          for (let c = 0; c < 4; c += 1) sum[c] += value[q * 4 + c];
          n += 1;
        }
        if (!n) continue;
        for (let c = 0; c < 4; c += 1) value[p * 4 + c] += omega * (sum[c] / n - value[p * 4 + c]);
      }
    }
  }
}

// Heals `data` (RGBA bytes, length width*height*4) where `coverage` is nonzero.
// `mode`: 0 Content-Aware, 1 Very Smooth, 2 Proximity Match. Mutates and returns data.
export function spotHeal(data, coverage, width, height, opacity, mode, seed = 0) {
  const [bx0, by0, bx1, by1] = coverageBounds(coverage, width, height);
  if (bx1 <= bx0) return data;
  const bw = bx1 - bx0;
  const bh = by1 - by0;
  const size = Math.max(bw, bh);
  let ring = Math.floor(size / 8);
  if (ring < 2) ring = 2;
  if (ring > 16) ring = 16;
  // Work box: the spot plus its ring, clipped to the image.
  const wx0 = Math.max(0, bx0 - ring);
  const wy0 = Math.max(0, by0 - ring);
  const wx1 = Math.min(width, bx1 + ring);
  const wy1 = Math.min(height, by1 + ring);
  const ww = wx1 - wx0;
  const wh = wy1 - wy0;
  const wn = ww * wh;

  const role = new Uint8Array(wn);
  for (let y = 0; y < wh; y += 1) {
    for (let x = 0; x < ww; x += 1) {
      role[y * ww + x] = coverage[(wy0 + y) * width + (wx0 + x)] ? HOLE : OUTSIDE;
    }
  }
  // The ring: pixels within `ring` of the spot (square dilation, row pass then column pass).
  const prefix = new Int32Array(Math.max(ww, wh) + 1);
  const near = new Uint8Array(wn);
  for (let y = 0; y < wh; y += 1) {
    prefix[0] = 0;
    for (let x = 0; x < ww; x += 1) prefix[x + 1] = prefix[x] + (role[y * ww + x] === HOLE ? 1 : 0);
    for (let x = 0; x < ww; x += 1) {
      const lo = Math.max(0, x - ring);
      const hi = Math.min(ww, x + ring + 1);
      near[y * ww + x] = prefix[hi] - prefix[lo] > 0 ? 1 : 0;
    }
  }
  for (let x = 0; x < ww; x += 1) {
    prefix[0] = 0;
    for (let y = 0; y < wh; y += 1) prefix[y + 1] = prefix[y] + near[y * ww + x];
    for (let y = 0; y < wh; y += 1) {
      const lo = Math.max(0, y - ring);
      const hi = Math.min(wh, y + ring + 1);
      if (role[y * ww + x] === OUTSIDE && prefix[hi] - prefix[lo] > 0) role[y * ww + x] = RING;
    }
  }
  let ringCount = 0;
  for (let p = 0; p < wn; p += 1) ringCount += role[p] === RING ? 1 : 0;
  if (!ringCount) return data;

  // Source patch for Content-Aware and Proximity Match.
  let ox = 0, oy = 0;
  let haveSource = false;
  if (mode !== 1) {
    const factors = [1.05, 1.35, 1.75, 2.25, 2.8];
    const count = mode === 2 ? 2 : 5;
    let best = Infinity;
    for (let f = 0; f < count; f += 1) {
      for (let a = 0; a < 24; a += 1) {
        const angle = (a * Math.PI) / 12.0;
        const dx = Math.round(Math.cos(angle) * factors[f] * ww);
        const dy = Math.round(Math.sin(angle) * factors[f] * wh);
        let s = score(data, width, height, role, wx0, wy0, ww, wh, dx, dy);
        if (!Number.isFinite(s)) continue;
        s *= mode === 2 ? 1.0 + 0.6 * f : 1.0 + 0.1 * f; // nearer patches win ties
        if (s < best) { best = s; ox = dx; oy = dy; }
      }
    }
    if (Number.isFinite(best)) {
      // Fine-tune the alignment so repeating texture lines up.
      const cx = ox, cy = oy;
      let refined = score(data, width, height, role, wx0, wy0, ww, wh, cx, cy);
      for (let j = -3; j <= 3; j += 1) {
        for (let i = -3; i <= 3; i += 1) {
          const s = score(data, width, height, role, wx0, wy0, ww, wh, cx + i, cy + j);
          if (s < refined) { refined = s; ox = cx + i; oy = cy + j; }
        }
      }
      haveSource = true;
    }
  }

  // Membrane: the edge difference between the original and the patch (or the
  // original itself for a smooth fill), spread across the spot.
  const value = new Float32Array(wn * 4);
  const mean = [0, 0, 0, 0];
  const detail = [0, 0, 0];
  for (let y = 0; y < wh; y += 1) {
    for (let x = 0; x < ww; x += 1) {
      const p = y * ww + x;
      if (role[p] !== RING) continue;
      const ix = wx0 + x;
      const iy = wy0 + y;
      const t = (iy * width + ix) * 4;
      const s = haveSource ? ((iy + oy) * width + (ix + ox)) * 4 : -1;
      for (let c = 0; c < 4; c += 1) {
        value[p * 4 + c] = data[t + c] - (s >= 0 ? data[s + c] : 0);
        mean[c] += value[p * 4 + c];
      }
      if (!haveSource) {
        // Fine detail around the spot: each pixel against the average of its neighbours.
        for (let c = 0; c < 3; c += 1) {
          let around = 0;
          let n = 0;
          const offsets = [[ix - 1, iy], [ix + 1, iy], [ix, iy - 1], [ix, iy + 1]];
          for (let k = 0; k < 4; k += 1) {
            const nx = offsets[k][0];
            const ny = offsets[k][1];
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            around += data[(ny * width + nx) * 4 + c];
            n += 1;
          }
          if (n) {
            const d = data[t + c] - around / n;
            detail[c] += d * d;
          }
        }
      }
    }
  }
  for (let c = 0; c < 4; c += 1) mean[c] /= ringCount;
  for (let p = 0; p < wn; p += 1) {
    if (role[p] === HOLE) {
      for (let c = 0; c < 4; c += 1) value[p * 4 + c] = mean[c];
    }
  }
  solve(value, role, ww, wh, 0);
  for (let c = 0; c < 3; c += 1) detail[c] = Math.sqrt(detail[c] / ringCount) * 0.9;

  for (let y = 0; y < wh; y += 1) {
    for (let x = 0; x < ww; x += 1) {
      const p = y * ww + x;
      if (role[p] !== HOLE) continue;
      const ix = wx0 + x;
      const iy = wy0 + y;
      const t = (iy * width + ix) * 4;
      const s = haveSource ? ((iy + oy) * width + (ix + ox)) * 4 : -1;
      const amount = (coverage[iy * width + ix] / 255.0) * opacity;
      let grain = 0;
      if (!haveSource) {
        const key = healHash(seed ^ healHash(iy * width + ix));
        const u1 = healUnit(key);
        const u2 = healUnit(key ^ 0x68e31da4);
        grain = Math.sqrt(-2.0 * Math.log(1.0 - u1)) * Math.cos(2.0 * Math.PI * u2);
      }
      const out = [0, 0, 0, 0];
      for (let c = 0; c < 4; c += 1) {
        const healed = (s >= 0 ? data[s + c] : 0) + value[p * 4 + c] + (c < 3 ? grain * detail[c] : 0);
        out[c] = data[t + c] + (healed - data[t + c]) * amount;
      }
      const alpha = Math.max(0, Math.min(255, out[3]));
      data[t + 3] = Math.round(alpha);
      for (let c = 0; c < 3; c += 1) {
        const v = Math.max(0, Math.min(data[t + 3], out[c]));
        data[t + c] = Math.round(v);
      }
    }
  }
  return data;
}
