/* ============================================================
   water.js — 程序化水景
   零素材：全部由着色器实时生成（涌浪噪声 + 解析涟漪 + 月光高光 + 色散）
   WebGL 不可用时自动降级到 Canvas 2D 版本，公开 API 完全一致。
   ============================================================ */
(function () {
  'use strict';

  window.Flow = window.Flow || {};

  var MAX_DROPS = 10;      // 与着色器里的 DROPS 保持一致
  var DROP_LIFE = 4.0;     // 秒

  /* ── 着色器 ─────────────────────────────────────────────── */

  var VERT = [
    'attribute vec2 aPos;',
    'void main() { gl_Position = vec4(aPos, 0.0, 1.0); }'
  ].join('\n');

  var FRAG = [
    'precision highp float;',
    '',
    'uniform vec2  uRes;       // 内部渲染分辨率',
    'uniform float uTime;',
    'uniform float uAspect;',
    'uniform float uCalm;      // 0 = 水景模式，1 = 白板模式',
    'uniform float uAmp;       // 涟漪总强度',
    'uniform vec3  uMoon;      // 月光方向',
    'uniform vec4  uDrops[' + MAX_DROPS + ']; // xy=位置(渲染像素) z=出生时间 w=强度',
    '',
    '#define DROPS ' + MAX_DROPS,
    '',
    'float hash21(vec2 p) {',
    '  p = fract(p * vec2(123.34, 456.21));',
    '  p += dot(p, p + 45.32);',
    '  return fract(p.x * p.y);',
    '}',
    '',
    'float vnoise(vec2 p) {',
    '  vec2 i = floor(p);',
    '  vec2 f = fract(p);',
    '  vec2 u = f * f * (3.0 - 2.0 * f);',
    '  float a = hash21(i);',
    '  float b = hash21(i + vec2(1.0, 0.0));',
    '  float c = hash21(i + vec2(0.0, 1.0));',
    '  float d = hash21(i + vec2(1.0, 1.0));',
    '  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);',
    '}',
    '',
    'float fbm(vec2 p) {',
    '  float s = 0.0;',
    '  float a = 0.5;',
    '  for (int i = 0; i < 3; i++) {',
    '    s += a * vnoise(p);',
    '    p = p * 2.07 + 13.1;',
    '    a *= 0.5;',
    '  }',
    '  return s;',
    '}',
    '',
    '// 水面高度场：低频涌浪 + 细碎风纹 + 鼠标激起的解析涟漪环',
    '// 尺度约定：uv 为 0..1 的屏幕空间，r 以「屏幕高度」为单位',
    'float waterH(vec2 uv, float t) {',
    '  vec2 np = vec2(uv.x * uAspect, uv.y);',
    '  float h = 0.0;',
    '  // 大尺度涌浪（缓慢的整体起伏）',
    '  h += 0.016 * sin(uv.x * 8.0 - t * 0.45);',
    '  h += 0.011 * sin(uv.y * 6.0 + t * 0.52 + uv.x * 3.4);',
    '  // 中尺度风纹（约 50px 量级）',
    '  h += 0.026 * (fbm(np * 15.0 + vec2(t * 0.09, -t * 0.055)) - 0.5);',
    '  // 细碎纹理（十几 px 量级）',
    '  h += 0.009 * (fbm(np * 30.0 - vec2(t * 0.17, t * 0.12)) - 0.5);',
    '',
    '  for (int i = 0; i < DROPS; i++) {',
    '    vec4 d = uDrops[i];',
    '    if (d.w == 0.0) continue;',
    '    float age = t - d.z;',
    '    if (age < 0.0 || age > ' + DROP_LIFE.toFixed(1) + ') continue;',
    '    vec2 dp = (uv * uRes - d.xy) / uRes.y;',
    '    float r2 = dot(dp, dp);',
    '    if (r2 > 0.16) continue;',            // 影响半径外直接跳过，省算力
    '    float r = sqrt(r2);',
    '    float decay = exp(-age * 1.7);',
    '    // 窗口函数保证在裁剪边界处平滑归零，否则会留下一圈可见的硬边',
    '    float fall  = exp(-r * 9.0) * smoothstep(0.40, 0.24, r);',
    '    h += d.w * uAmp * 0.55 * decay * fall * sin(r * 110.0 - age * 48.0);',
    '  }',
    '  return h;',
    '}',
    '',
    'vec3 waterNormal(vec2 uv, float t, float eps, out float hc) {',
    '  float hl = waterH(uv - vec2(eps, 0.0), t);',
    '  float hr = waterH(uv + vec2(eps, 0.0), t);',
    '  float hd = waterH(uv - vec2(0.0, eps), t);',
    '  float hu = waterH(uv + vec2(0.0, eps), t);',
    '  hc = (hl + hr + hd + hu) * 0.25;',
    '  return normalize(vec3((hl - hr) * 90.0, (hd - hu) * 90.0, 1.0));',
    '}',
    '',
    'float glintAt(vec3 n, vec3 v, vec3 l) {',
    '  vec3 h = normalize(l + v);',
    '  return pow(max(dot(n, h), 0.0), 180.0);',
    '}',
    '',
    'void main() {',
    '  vec2 uv = gl_FragCoord.xy / uRes;',
    '  float t = uTime;',
    '  float eps = 1.8 / uRes.y;',
    '  float hc;',
    '  vec3 n = waterNormal(uv, t, eps, hc);',
    '',
    '  vec3 deepC = vec3(0.014, 0.024, 0.038);',
    '  vec3 midC  = vec3(0.052, 0.086, 0.112);',
    '  vec3 skyC  = vec3(0.105, 0.158, 0.215);',
    '  vec3 moonC = vec3(0.80, 0.87, 1.00);',
    '',
    '  vec3 V = normalize(vec3((uv - 0.5) * vec2(uAspect, 1.0) * 0.9, 1.0));',
    '',
    '  float horizon = smoothstep(0.05, 1.00, uv.y);',
    '  vec3 col = mix(deepC, midC, horizon * 0.95);',
    '  col += skyC * pow(horizon, 3.0) * 0.35;',
    '  // 远处水面映着天光，形成一道柔和亮带',
    '  col += skyC * 0.22 * exp(-pow((uv.y - 0.94) * 8.0, 2.0));',
    '',
    '  // 大尺度涌浪的明暗，让水面有体积感',
    '  float gate = 1.0 - uCalm * 0.45;',
    '  col += skyC * hc * 2.5 * gate;',
    '',
    '  // 月光在水面拉出的那条竖直光路：近处宽、远处窄，才是真实的锥形',
    '  float kW = mix(3.0, 8.0, uv.y);',
    '  float path = exp(-pow((uv.x - 0.5) * kW, 2.0));',
    '  float glow = 1.0 - uCalm * 0.55;',
    '',
    '  // 菲涅尔：掠射角更亮，且优先反射月光柱那一带的天光',
    '  float fres = pow(1.0 - clamp(dot(n, V), 0.0, 1.0), 3.5) * 0.62 * (0.25 + 0.75 * path);',
    '  col = mix(col, skyC * 1.25, fres);',
    '',
    '  // 镜面高光：法线被波纹扰动 → 碎成鳞片；R/B 用略微偏移的光向 → 色散彩边',
    '  // 水平方向压扁法线＝掠射视角下光斑横向拉长，这才是月光带该有的形状',
    '  vec3 ng = normalize(vec3(n.x * 0.5, n.y, n.z));',
    '  vec3 L = normalize(uMoon);',
    '  float ca = 0.012 * glow;',
    '  float sR = glintAt(ng, V, normalize(L + vec3( ca, 0.0, 0.0)));',
    '  float sG = glintAt(ng, V, L);',
    '  float sB = glintAt(ng, V, normalize(L - vec3( ca, 0.0, 0.0)));',
    '  vec3 glint = vec3(sR, sG, sB) * (0.05 + 0.95 * path) * glow;',
    '',
    '  // 宽一点的柔光，避免只有碎点、没有整体亮度',
    '  vec3 H = normalize(L + V);',
    '  float sheen = pow(max(dot(n, H), 0.0), 26.0);',
    '  col += moonC * sheen * 0.075 * (0.25 + 0.75 * path);',
    '',
    '  // 波峰透光（近似次表面散射）',
    '  col += moonC * max(hc, 0.0) * 3.0 * path * glow;',
    '',
    '  col += moonC * glint * 1.70;',
    '',
    '  // 暗角',
    '  float vig = smoothstep(1.30, 0.28, length((uv - 0.5) * vec2(uAspect, 1.0)));',
    '  col *= mix(0.60, 1.0, vig);',
    '',
    '  col *= mix(1.0, 0.52, uCalm);',
    '',
    '  // 抖动，消除暗部色带',
    '  col += (hash21(gl_FragCoord.xy + fract(t) * 137.0) - 0.5) * 0.006;',
    '',
    '  gl_FragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');

  /* ── 尺寸计算 ───────────────────────────────────────────── */

  var MAX_PIXELS = 1400000;   // 内部渲染总像素上限，护住集显

  function fitSize(cssW, cssH, quality) {
    var w = Math.max(2, Math.round(cssW * quality));
    var h = Math.max(2, Math.round(cssH * quality));
    var px = w * h;
    if (px > MAX_PIXELS) {
      var k = Math.sqrt(MAX_PIXELS / px);
      w = Math.max(2, Math.round(w * k));
      h = Math.max(2, Math.round(h * k));
    }
    return { w: w, h: h };
  }

  /* ── 涟漪调度（WebGL 与 2D 降级共用） ───────────────────── */

  function Drops() {
    this.slots = new Array(MAX_DROPS);
    for (var i = 0; i < MAX_DROPS; i++) {
      this.slots[i] = { x: 0, y: 0, t: -99, w: 0 };
    }
    this.cursor = 0;
    this.next = 0;
    this.flat = new Float32Array(MAX_DROPS * 4);
  }

  Drops.prototype.push = function (x, y, t, strength) {
    var d = this.slots[this.cursor];
    d.x = x; d.y = y; d.t = t; d.w = strength;
    this.cursor = (this.cursor + 1) % MAX_DROPS;
  };

  // 输出扁平数组供 uniform4fv 使用
  Drops.prototype.pack = function () {
    var f = this.flat;
    for (var i = 0; i < MAX_DROPS; i++) {
      var d = this.slots[i];
      var o = i * 4;
      f[o] = d.x; f[o + 1] = d.y; f[o + 2] = d.t; f[o + 3] = d.w;
    }
    return f;
  };

  Drops.prototype.active = function (t) {
    var out = [];
    for (var i = 0; i < MAX_DROPS; i++) {
      var d = this.slots[i];
      var age = t - d.t;
      if (d.w !== 0 && age >= 0 && age <= DROP_LIFE) out.push(d);
    }
    return out;
  };

  Drops.prototype.clear = function () {
    for (var i = 0; i < MAX_DROPS; i++) this.slots[i].w = 0;
  };

  /* ── 公共外壳：负责循环、尺寸、状态，渲染器可插拔 ───────── */

  function create(canvas, options) {
    options = options || {};
    var cssW = 1, cssH = 1;
    var quality = options.quality || 0.62;
    var size = { w: 2, h: 2 };
    var drops = new Drops();
    var time = 0;
    var last = 0;
    var running = false;
    var everStarted = false;
    var raf = 0;
    var calm = 0;
    var calmTarget = 0;
    var amp = 1;
    var reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    if (reduce) amp = 0.55;

    var api = {
      isFallback: false,
      lastError: '',
      quality: quality,
      onSeed: null        // 每帧回调，供外部注入涟漪
    };

    /* 挑一个渲染器 */
    var renderer = null;
    try {
      renderer = createGL(canvas);
    } catch (e) {
      api.lastError = String(e && e.message || e);
      renderer = null;
    }
    if (!renderer) {
      api.isFallback = true;
      if (!api.lastError) api.lastError = 'WebGL unavailable';
      renderer = create2D(canvas);
    }

    function resize() {
      var rect = canvas.getBoundingClientRect();
      cssW = Math.max(1, Math.round(rect.width || window.innerWidth));
      cssH = Math.max(1, Math.round(rect.height || window.innerHeight));
      size = fitSize(cssW, cssH, quality);
      renderer.resize(cssW, cssH, size.w, size.h);
    }

    function frame(now) {
      if (!running) return;
      raf = requestAnimationFrame(frame);

      if (!last) last = now;
      var dt = (now - last) / 1000;
      last = now;
      // 后台标签回来时 dt 会很大，钳住避免涟漪瞬间全部老化
      if (dt > 0.05) dt = 0.05;
      if (dt < 0) dt = 0;

      time += dt;
      calm += (calmTarget - calm) * Math.min(1, dt * 2.6);

      if (api.onSeed) api.onSeed(time);
      renderer.render(time, size, drops, calm, amp, cssW, cssH);
      api.perf(dt);
    }

    /* 自适应画质：连续偏慢就降内部分辨率（只降不升，避免抖动） */
    var ema = 16, checks = 0, lastAdjust = 0;
    api.perf = function (dt) {
      var ms = dt * 1000;
      ema += (ms - ema) * 0.06;
      if (time - lastAdjust < 1.5 || checks >= 3) return;
      if (ema > 27 && quality > 0.40) {
        quality = Math.max(0.40, quality * 0.85);
        api.quality = quality;
        checks++;
        lastAdjust = time;
        resize();
      } else if (ema < 15) {
        checks = 3;   // 跑得动，不再调整
      }
    };

    api.start = function () {
      everStarted = true;
      if (running) return;
      running = true;
      last = 0; ema = 16;
      resize();
      raf = requestAnimationFrame(frame);
    };

    api.stop = function () {
      running = false;
      cancelAnimationFrame(raf);
    };

    api.resize = resize;

    api.setCalm = function (v) { calmTarget = Math.max(0, Math.min(1, v)); };

    api.setAmp = function (v) { amp = v; };

    /* 在 CSS 像素坐标处激起一圈涟漪 */
    api.drop = function (cssX, cssY, strength) {
      var x = (cssX / cssW) * size.w;
      var y = (1 - cssY / cssH) * size.h;   // GL 原点在左下
      drops.push(x, y, time, strength);
    };

    api.clearDrops = function () { drops.clear(); };

    api.dispose = function () {
      api.stop();
      renderer.dispose && renderer.dispose();
    };

    window.addEventListener('resize', resize);
    window.addEventListener('orientationchange', resize);
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        api.stop();
      } else if (everStarted) {
        api.start();
      }
    });

    requestAnimationFrame(function () { resize(); });

    return api;
  }

  /* ── WebGL 渲染器 ───────────────────────────────────────── */

  function compile(gl, type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      var log = gl.getShaderInfoLog(sh) || 'shader compile failed';
      gl.deleteShader(sh);
      throw new Error(log.trim().slice(0, 300));
    }
    return sh;
  }

  function createGL(canvas) {
    var attrs = {
      alpha: false, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: false, preserveDrawingBuffer: false,
      powerPreference: 'high-performance'
    };
    var gl = canvas.getContext('webgl', attrs) || canvas.getContext('experimental-webgl', attrs);
    if (!gl) return null;

    var prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error((gl.getProgramInfoLog(prog) || 'link failed').trim().slice(0, 300));
    }
    gl.useProgram(prog);

    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    var aPos = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    var U = {
      res: gl.getUniformLocation(prog, 'uRes'),
      time: gl.getUniformLocation(prog, 'uTime'),
      aspect: gl.getUniformLocation(prog, 'uAspect'),
      calm: gl.getUniformLocation(prog, 'uCalm'),
      amp: gl.getUniformLocation(prog, 'uAmp'),
      moon: gl.getUniformLocation(prog, 'uMoon'),
      drops: gl.getUniformLocation(prog, 'uDrops[0]') || gl.getUniformLocation(prog, 'uDrops')
    };

    gl.clearColor(0.016, 0.027, 0.043, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform3f(U.moon, 0.0, 0.42, 0.55);

    return {
      resize: function (cssW, cssH, w, h) {
        canvas.width = w;
        canvas.height = h;
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        gl.viewport(0, 0, w, h);
      },
      render: function (t, size, drops, calm, amp) {
        gl.uniform2f(U.res, size.w, size.h);
        gl.uniform1f(U.time, t);
        gl.uniform1f(U.aspect, size.w / size.h);
        gl.uniform1f(U.calm, calm);
        gl.uniform1f(U.amp, amp * (1 - calm * 0.45));
        gl.uniform4fv(U.drops, drops.pack());
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      },
      dispose: function () {
        gl.deleteBuffer(buf);
        gl.deleteProgram(prog);
      }
    };
  }

  /* ── Canvas 2D 降级渲染器 ───────────────────────────────── */

  function create2D(canvas) {
    var ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    var sx = 1, sy = 1;

    return {
      resize: function (cssW, cssH, w, h) {
        canvas.width = w;
        canvas.height = h;
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        sx = w / cssW;
        sy = h / cssH;
      },
      render: function (t, size, drops, calm) {
        var w = size.w, h = size.h;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalCompositeOperation = 'source-over';

        var g = ctx.createLinearGradient(0, h, 0, 0);
        g.addColorStop(0, '#05080e');
        g.addColorStop(0.55, '#081320');
        g.addColorStop(1, '#0b1a29');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);

        // 月光柱
        var mg = ctx.createRadialGradient(w * 0.5, -h * 0.15, 0, w * 0.5, -h * 0.15, h * 0.95);
        mg.addColorStop(0, 'rgba(150,185,235,' + (0.30 * (1 - calm * 0.6)) + ')');
        mg.addColorStop(0.45, 'rgba(90,125,180,' + (0.10 * (1 - calm * 0.6)) + ')');
        mg.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = mg;
        ctx.fillRect(0, 0, w, h);

        // 涟漪环
        var list = drops.active(t);
        ctx.lineWidth = Math.max(1, 1.3 * sx);
        for (var i = 0; i < list.length; i++) {
          var d = list[i];
          var age = t - d.t;
          var cx = d.x;
          var cy = h - d.y;          // 2D 原点在左上
          for (var k = 0; k < 3; k++) {
            var r = (age * size.h * 0.34) - k * size.h * 0.035;
            if (r <= 1) continue;
            var a = Math.exp(-age * 1.5) * Math.exp(-r / (size.h * 0.55)) * 0.5 * d.w * 18;
            if (a <= 0.002) continue;
            ctx.strokeStyle = 'rgba(178,206,246,' + a.toFixed(3) + ')';
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.stroke();
          }
        }

        // 暗角
        var v = ctx.createRadialGradient(w * 0.5, h * 0.45, h * 0.15, w * 0.5, h * 0.5, h * 1.05);
        v.addColorStop(0, 'rgba(0,0,0,0)');
        v.addColorStop(1, 'rgba(0,0,0,0.62)');
        ctx.fillStyle = v;
        ctx.fillRect(0, 0, w, h);

        if (calm > 0) {
          ctx.fillStyle = 'rgba(0,0,0,' + (calm * 0.45).toFixed(3) + ')';
          ctx.fillRect(0, 0, w, h);
        }
      },
      dispose: function () {}
    };
  }

  window.Flow.Water = { create: create, MAX_DROPS: MAX_DROPS, DROP_LIFE: DROP_LIFE };
})();
