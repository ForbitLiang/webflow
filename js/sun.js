/* ============================================================
   sun.js — 一天之内的湖面光照调色板
   把「几点钟」映射成一组完整的光照参数，供水景着色器使用。

   为什么单独成模块：这段是纯函数、纯数据，不碰 DOM 也不碰 WebGL，
   所以能被 tools/selftest.js 直接断言（白天比傍晚亮、傍晚比深夜亮、
   24 小时首尾相接不能跳变……），不需要开浏览器就能验证。

   参数含义：
     deep / mid / sky  水体由深到浅的三档底色（直接写进 gl_FragColor 的显示值）
     light             光源颜色（夜里偏冷白，日出日落偏暖橙）
     elev              光源仰角（0.06 贴地平线 → 0.95 当空），决定光柱的长短宽窄
     glint             镜面碎光强度倍数
     sheen             宽柔光强度倍数
     amb               天光反射（菲涅尔）强度倍数，越大水面越"亮"
     vig               暗角下限，越大四角越亮
     far               远处天光带的强度
     path              光柱宽窄倍数，越大越窄（正午太阳高，光柱短而窄）
   ============================================================ */
(function () {
  'use strict';

  window.Flow = window.Flow || {};

  var KEYS = [
    { h: 0.0,  name: '深夜',
      deep: [0.006, 0.012, 0.024], mid: [0.018, 0.032, 0.052], sky: [0.036, 0.056, 0.092],
      light: [0.80, 0.88, 1.00], elev: 0.46, glint: 1.70, sheen: 0.075,
      amb: 1.00, vig: 0.60, far: 0.22, path: 1.00 },

    { h: 4.0,  name: '夜末',
      deep: [0.007, 0.013, 0.026], mid: [0.020, 0.035, 0.058], sky: [0.040, 0.062, 0.100],
      light: [0.80, 0.87, 1.00], elev: 0.44, glint: 1.62, sheen: 0.075,
      amb: 1.02, vig: 0.62, far: 0.24, path: 1.00 },

    { h: 5.8,  name: '破晓',
      deep: [0.018, 0.024, 0.038], mid: [0.055, 0.062, 0.082], sky: [0.120, 0.110, 0.140],
      light: [1.00, 0.78, 0.62], elev: 0.16, glint: 1.20, sheen: 0.105,
      amb: 1.15, vig: 0.70, far: 0.40, path: 0.80 },

    { h: 7.2,  name: '日出',
      deep: [0.050, 0.055, 0.068], mid: [0.200, 0.196, 0.196], sky: [0.480, 0.400, 0.340],
      light: [1.00, 0.72, 0.50], elev: 0.13, glint: 1.15, sheen: 0.150,
      amb: 1.55, vig: 0.84, far: 0.62, path: 0.70 },

    { h: 9.5,  name: '上午',
      deep: [0.090, 0.120, 0.140], mid: [0.230, 0.270, 0.300], sky: [0.430, 0.500, 0.570],
      light: [1.00, 0.96, 0.90], elev: 0.50, glint: 1.25, sheen: 0.150,
      amb: 1.55, vig: 0.86, far: 0.32, path: 0.95 },

    { h: 12.0, name: '正午',
      deep: [0.140, 0.170, 0.190], mid: [0.270, 0.310, 0.340], sky: [0.520, 0.580, 0.640],
      light: [1.00, 0.99, 0.97], elev: 0.85, glint: 1.35, sheen: 0.150,
      amb: 1.65, vig: 0.92, far: 0.30, path: 1.00 },

    { h: 15.0, name: '午后',
      deep: [0.120, 0.150, 0.170], mid: [0.260, 0.300, 0.330], sky: [0.460, 0.520, 0.580],
      light: [1.00, 0.95, 0.88], elev: 0.58, glint: 1.25, sheen: 0.150,
      amb: 1.55, vig: 0.86, far: 0.32, path: 0.95 },

    { h: 17.0, name: '斜阳',
      deep: [0.085, 0.092, 0.110], mid: [0.200, 0.210, 0.230], sky: [0.400, 0.380, 0.375],
      light: [1.00, 0.86, 0.70], elev: 0.28, glint: 1.20, sheen: 0.145,
      amb: 1.30, vig: 0.82, far: 0.52, path: 0.82 },

    { h: 18.5, name: '傍晚',
      deep: [0.026, 0.028, 0.040], mid: [0.072, 0.068, 0.082], sky: [0.155, 0.125, 0.135],
      light: [1.00, 0.62, 0.42], elev: 0.10, glint: 1.45, sheen: 0.115,
      amb: 1.12, vig: 0.70, far: 0.40, path: 0.68 },

    { h: 20.0, name: '暮色',
      deep: [0.011, 0.017, 0.030], mid: [0.030, 0.042, 0.064], sky: [0.058, 0.072, 0.108],
      light: [0.92, 0.80, 0.92], elev: 0.22, glint: 1.60, sheen: 0.085,
      amb: 1.00, vig: 0.64, far: 0.26, path: 0.90 },

    { h: 21.5, name: '入夜',
      deep: [0.007, 0.013, 0.026], mid: [0.020, 0.034, 0.055], sky: [0.038, 0.058, 0.095],
      light: [0.82, 0.88, 1.00], elev: 0.40, glint: 1.70, sheen: 0.075,
      amb: 1.00, vig: 0.60, far: 0.22, path: 1.00 },

    // 收尾必须与 0 点完全一致，否则跨零点会跳变
    { h: 24.0, name: '深夜',
      deep: [0.006, 0.012, 0.024], mid: [0.018, 0.032, 0.052], sky: [0.036, 0.056, 0.092],
      light: [0.80, 0.88, 1.00], elev: 0.46, glint: 1.70, sheen: 0.075,
      amb: 1.00, vig: 0.60, far: 0.22, path: 1.00 }
  ];

  // 给界面用的时段名（比关键帧更贴合日常说法）
  var PHASES = [
    [0, '深夜'], [4.5, '破晓'], [6.5, '日出'], [8.5, '上午'],
    [11, '正午'], [13.5, '午后'], [16.5, '斜阳'], [18, '傍晚'],
    [19.5, '暮色'], [21, '夜晚']
  ];

  function lerp(a, b, t) { return a + (b - a) * t; }
  function lerp3(a, b, t) {
    return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
  }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function wrapHour(h) {
    if (!isFinite(h)) return 0;
    h = h % 24;
    if (h < 0) h += 24;
    return h;
  }

  function phaseName(hour) {
    var h = wrapHour(hour);
    var name = PHASES[0][1];
    for (var i = 0; i < PHASES.length; i++) {
      if (h >= PHASES[i][0]) name = PHASES[i][1];
    }
    return name;
  }

  // 0..24 的小时 → 一组可直接喂给着色器的光照参数
  function palette(hour) {
    var h = wrapHour(hour);

    var i = 0;
    while (i < KEYS.length - 2 && KEYS[i + 1].h <= h) i++;
    var a = KEYS[i];
    var b = KEYS[i + 1] || KEYS[KEYS.length - 1];
    var span = b.h - a.h;
    var t = span > 0 ? clamp((h - a.h) / span, 0, 1) : 0;

    var elev = lerp(a.elev, b.elev, t);
    // 方位固定在正前方，只改仰角 —— 这样那条竖直光柱始终在画面中央
    var dy = elev;
    var dz = 0.55;
    var m = Math.sqrt(dy * dy + dz * dz) || 1;

    return {
      hour: h,
      name: phaseName(h),
      deep: lerp3(a.deep, b.deep, t),
      mid: lerp3(a.mid, b.mid, t),
      sky: lerp3(a.sky, b.sky, t),
      light: lerp3(a.light, b.light, t),
      dir: [0, dy / m, dz / m],
      elev: elev,
      glint: lerp(a.glint, b.glint, t),
      sheen: lerp(a.sheen, b.sheen, t),
      amb: lerp(a.amb, b.amb, t),
      vig: lerp(a.vig, b.vig, t),
      far: lerp(a.far, b.far, t),
      path: lerp(a.path, b.path, t)
    };
  }

  // 0..24 的小时 → "18:30"
  function formatHour(hour) {
    var h = wrapHour(hour);
    var mins = Math.round(h * 60) % 1440;
    var hh = Math.floor(mins / 60);
    var mm = mins % 60;
    return (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;
  }

  // 水面整体亮度（0..1 量级）——主要给测试和界面判断"亮不亮"用
  function brightness(hour) {
    var p = palette(hour);
    return (p.mid[0] + p.mid[1] + p.mid[2]) / 3 +
           (p.sky[0] + p.sky[1] + p.sky[2]) / 3 * 0.5;
  }

  window.Flow.Sun = {
    KEYS: KEYS,
    PHASES: PHASES,
    palette: palette,
    phaseName: phaseName,
    formatHour: formatHour,
    wrapHour: wrapHour,
    brightness: brightness
  };
})();
