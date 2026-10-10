/* ============================================================
   preview.js — 水景着色器的 CPU 等价实现（仅用于调参预览）

   用法：
     node tools/preview.js [宽] [高] [时间] [小时] [nodrops]
     node tools/preview.js --strip            # 一天 12 个时刻的联络表
     node tools/preview.js --strip 宽 高 时间

   产物： .preview/cpu.png 或 .preview/strip.png

   ⚠️ 这个文件是 js/water.js 里 GLSL 的逐行移植。
      修改着色器参数时，必须同步修改这里，否则预览会失真。
      GPU 用 fp32、这里用 fp64，噪声纹理会略有差异，
      但频率与对比度一致，足以判断观感。
      光照参数不在这里硬编码，而是和线上一样取自 js/sun.js，
      所以调色板只有一处真源。
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const vm = require('vm');

/* ── 载入 js/sun.js（它挂到 window.Flow 上） ─────────────── */

const sunSandbox = { window: {} };
vm.createContext(sunSandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'sun.js'), 'utf8'),
  sunSandbox, { filename: 'sun.js' });
const Sun = sunSandbox.window.Flow.Sun;

/* ── 命令行 ─────────────────────────────────────────────── */

const argv = process.argv.slice(2);
const STRIP = argv[0] === '--strip';
const nums = argv.filter(a => a !== '--strip' && a !== 'nodrops');

const W = parseInt(STRIP ? (nums[0] || '360') : (nums[0] || '720'), 10);
const H = parseInt(STRIP ? (nums[1] || '225') : (nums[1] || '450'), 10);
const T = parseFloat(nums[2] || '20');
const HOUR = parseFloat(nums[3] != null ? nums[3] : '22');
const MOUSE_DROP = argv.indexOf('nodrops') < 0 && !STRIP;

/* ── 最小 PNG 编码器 ─────────────────────────────────────── */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(w, h, rgb) {
  const stride = w * 3;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ── GLSL 内建函数 ──────────────────────────────────────── */

const fract = x => x - Math.floor(x);
const mix = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/* ── 着色器移植 ─────────────────────────────────────────── */

const MAX_DROPS = 10;
const DROP_LIFE = 4.0;
const ASPECT = W / H;

function hash21(px, py) {
  let x = fract(px * 123.34);
  let y = fract(py * 456.21);
  const d = x * (x + 45.32) + y * (y + 45.32);
  x += d; y += d;
  return fract(x * y);
}

function vnoise(px, py) {
  const ix = Math.floor(px), iy = Math.floor(py);
  const fx = px - ix, fy = py - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash21(ix, iy);
  const b = hash21(ix + 1, iy);
  const c = hash21(ix, iy + 1);
  const d = hash21(ix + 1, iy + 1);
  return mix(mix(a, b, ux), mix(c, d, ux), uy);
}

function fbm(px, py) {
  let s = 0, a = 0.5;
  for (let i = 0; i < 3; i++) {
    s += a * vnoise(px, py);
    px = px * 2.07 + 13.1;
    py = py * 2.07 + 13.1;
    a *= 0.5;
  }
  return s;
}

function waterH(ux, uy, t, drops) {
  const npx = ux * ASPECT, npy = uy;
  let h = 0;
  h += 0.016 * Math.sin(ux * 8.0 - t * 0.45);
  h += 0.011 * Math.sin(uy * 6.0 + t * 0.52 + ux * 3.4);
  h += 0.026 * (fbm(npx * 15.0 + t * 0.09, npy * 15.0 - t * 0.055) - 0.5);
  h += 0.009 * (fbm(npx * 30.0 - t * 0.17, npy * 30.0 + t * 0.12) - 0.5);

  for (let i = 0; i < MAX_DROPS; i++) {
    const d = drops[i];
    if (!d || d.w === 0) continue;
    const age = t - d.z;
    if (age < 0 || age > DROP_LIFE) continue;
    const dx = (ux * W - d.x) / H;
    const dy = (uy * H - d.y) / H;
    const r2 = dx * dx + dy * dy;
    if (r2 > 0.16) continue;
    const r = Math.sqrt(r2);
    const decay = Math.exp(-age * 1.7);
    const fall = Math.exp(-r * 9.0) * smoothstep(0.40, 0.24, r);
    h += d.w * 0.55 * decay * fall * Math.sin(r * 110.0 - age * 48.0);
  }
  return h;
}

function render(t, drops, P, w, h) {
  const buf = Buffer.alloc(w * h * 3);
  const eps = 1.8 / h;
  const aspect = w / h;
  const L = P.dir;                                  // 光源方向由调色板给出
  const deep = P.deep, mid = P.mid, sky = P.sky, lightC = P.light;

  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      // gl_FragCoord 原点在左下
      const ux = (px + 0.5) / w;
      const uy = (h - py - 0.5) / h;

      const hl = waterH(ux - eps, uy, t, drops);
      const hr = waterH(ux + eps, uy, t, drops);
      const hd = waterH(ux, uy - eps, t, drops);
      const hu = waterH(ux, uy + eps, t, drops);
      const hc = (hl + hr + hd + hu) * 0.25;
      const n = norm3((hl - hr) * 90.0, (hd - hu) * 90.0, 1.0);

      const V = norm3((ux - 0.5) * aspect * 0.9, (uy - 0.5) * 0.9, 1.0);

      const horizon = smoothstep(0.05, 1.00, uy);
      const hh = horizon * 0.95;
      let r = mix(deep[0], mid[0], hh);
      let g = mix(deep[1], mid[1], hh);
      let b = mix(deep[2], mid[2], hh);
      const hz3 = Math.pow(horizon, 3) * 0.35;
      r += sky[0] * hz3; g += sky[1] * hz3; b += sky[2] * hz3;
      const band = P.far * Math.exp(-Math.pow((uy - 0.94) * 8.0, 2));
      r += sky[0] * band; g += sky[1] * band; b += sky[2] * band;

      // 大尺度涌浪的明暗
      const swell = hc * 2.5;
      r += sky[0] * swell; g += sky[1] * swell; b += sky[2] * swell;

      const kW = mix(3.0, 8.0, uy) * P.path;
      const pathFactor = Math.exp(-Math.pow((ux - 0.5) * kW, 2));

      const fres = Math.min(1.0,
        Math.pow(1 - clamp(dot3(n, V), 0, 1), 3.5) * 0.62 * P.amb * (0.25 + 0.75 * pathFactor));
      r = mix(r, sky[0] * 1.25, fres);
      g = mix(g, sky[1] * 1.25, fres);
      b = mix(b, sky[2] * 1.25, fres);

      // 水平压扁法线：掠射视角下光斑横向拉长
      const ng = norm3(n[0] * 0.5, n[1], n[2]);
      const ca = 0.012;
      const sR = glintAt(ng, V, norm3(L[0] + ca, L[1], L[2]));
      const sG = glintAt(ng, V, L);
      const sB = glintAt(ng, V, norm3(L[0] - ca, L[1], L[2]));

      const Hh = norm3(L[0] + V[0], L[1] + V[1], L[2] + V[2]);
      const sheen = Math.pow(Math.max(dot3(n, Hh), 0), 26) * P.sheen * (0.25 + 0.75 * pathFactor);

      const crest = Math.max(hc, 0) * 3.0 * pathFactor;

      const gl = P.glint * (0.05 + 0.95 * pathFactor);
      r += lightC[0] * (sheen + crest) + lightC[0] * sR * gl;
      g += lightC[1] * (sheen + crest) + lightC[1] * sG * gl;
      b += lightC[2] * (sheen + crest) + lightC[2] * sB * gl;

      const vigLen = Math.sqrt(Math.pow((ux - 0.5) * aspect, 2) + Math.pow(uy - 0.5, 2));
      const vig = mix(P.vig, 1.0, smoothstep(1.30, 0.28, vigLen));
      r *= vig; g *= vig; b *= vig;

      const o = (py * w + px) * 3;
      buf[o] = Math.round(clamp(r, 0, 1) * 255);
      buf[o + 1] = Math.round(clamp(g, 0, 1) * 255);
      buf[o + 2] = Math.round(clamp(b, 0, 1) * 255);
    }
  }
  return buf;
}

function glintAt(n, v, l) {
  const h = norm3(l[0] + v[0], l[1] + v[1], l[2] + v[2]);
  return Math.pow(Math.max(dot3(n, h), 0), 180);
}

const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function norm3(x, y, z) {
  const m = Math.sqrt(x * x + y * y + z * z) || 1;
  return [x / m, y / m, z / m];
}

/* ── 场景 ───────────────────────────────────────────────── */

function makeDrops(w, h, withMouse) {
  const drops = new Array(MAX_DROPS).fill(null).map(() => ({ x: 0, y: 0, z: -99, w: 0 }));
  if (!withMouse) return drops;
  // 把「真实坐标 → 着色器像素坐标」的换算摆在这里，方便肉眼比对涟漪位置
  const put = (i, ux, uy, age, ww) => { drops[i] = { x: ux * w, y: uy * h, z: T - age, w: ww }; };
  put(0, 0.50, 0.46, 0.30, 0.050);   // 主涟漪
  put(1, 0.28, 0.66, 0.16, 0.038);   // 次涟漪
  put(2, 0.72, 0.74, 0.55, 0.030);   // 扩散中的旧涟漪
  return drops;
}

/* ── 输出 ───────────────────────────────────────────────── */

const outDir = path.join(__dirname, '..', '.preview');
fs.mkdirSync(outDir, { recursive: true });
const t0 = Date.now();

if (STRIP) {
  /* 联络表：一天里 12 个时刻并排看，一次就能判断明暗与色调的走向 */
  const HOURS = [0, 2, 4, 5.8, 7.2, 9.5, 12, 15, 17, 18.5, 20, 22];
  const COLS = 4, ROWS = Math.ceil(HOURS.length / COLS);
  const outW = W * COLS, outH = H * ROWS;
  const big = Buffer.alloc(outW * outH * 3);

  HOURS.forEach((hour, i) => {
    const P = Sun.palette(hour);
    const cell = render(T, makeDrops(W, H, false), P, W, H);
    const cx = (i % COLS) * W, cy = Math.floor(i / COLS) * H;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const src = (y * W + x) * 3;
        const dst = ((cy + y) * outW + (cx + x)) * 3;
        big[dst] = cell[src]; big[dst + 1] = cell[src + 1]; big[dst + 2] = cell[src + 2];
      }
    }
  });

  fs.writeFileSync(path.join(outDir, 'strip.png'), encodePNG(outW, outH, big));
  console.log(`${HOURS.length} 个时刻  ${W}x${H} 每格  ${Date.now() - t0}ms  →  .preview/strip.png`);
  console.log('时刻: ' + HOURS.map(h => `${Sun.formatHour(h)} ${Sun.phaseName(h)}`).join(' | '));
} else {
  const P = Sun.palette(HOUR);
  const buf = render(T, makeDrops(W, H, MOUSE_DROP), P, W, H);
  fs.writeFileSync(path.join(outDir, 'cpu.png'), encodePNG(W, H, buf));
  console.log(`${W}x${H}  t=${T}  ${Sun.formatHour(HOUR)} ${P.name}  ${Date.now() - t0}ms  →  .preview/cpu.png`);
}
