/* ============================================================
   audio.js — 程序化音景
   零音频素材：全部由 Web Audio 实时合成（噪声整形 + 滤波 + LFO）
   ＝ 无版权风险、无加载体积。
   ============================================================ */
(function () {
  'use strict';

  window.Flow = window.Flow || {};

  var PRESETS = {
    lake: {
      waveType: 'lowpass', waveFreq: 380, waveQ: 0.6, waveGain: 0.30,
      lapFreq: 1350, lapQ: 0.9, lapGain: 0.055, lapRate: 0.055,
      hissFreq: 4200, hissGain: 0.0,
      events: null, duck: 0.72
    },
    rain: {
      waveType: 'lowpass', waveFreq: 620, waveQ: 0.5, waveGain: 0.24,
      lapFreq: 1900, lapQ: 0.7, lapGain: 0.040, lapRate: 0.09,
      hissFreq: 3200, hissGain: 0.055,
      events: 'droplets', duck: 0.72
    },
    birds: {
      // 鸟鸣：底噪更轻更亮（像树梢的风），上面稀疏地落几声鸟叫
      waveType: 'lowpass', waveFreq: 760, waveQ: 0.5, waveGain: 0.13,
      lapFreq: 2600, lapQ: 0.6, lapGain: 0.026, lapRate: 0.07,
      hissFreq: 5400, hissGain: 0.014,
      events: 'chirps', duck: 0.72
    }
  };

  function create() {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    var api = {
      isFallback: false,
      lastError: '',
      ready: false,
      preset: 'lake',
      volume: 0.7,
      muted: false
    };

    if (!Ctx) {
      api.isFallback = true;
      api.lastError = 'Web Audio unavailable';
      // 给出空实现，调用方无需到处判断
      api.unlock = api.setVolume = api.setMuted = function () {};
      api.setPreset = api.ripple = api.suspend = api.resume = api.setDuck = function () {};
      api.dispose = function () {};
      return api;
    }

    var ctx = null;
    var master, duckGain, out;
    var buffers = {};
    var nodes = {};
    var duckLevel = 1;

    function noiseBuffer(kind, seconds) {
      var len = Math.floor(ctx.sampleRate * seconds);
      var buf = ctx.createBuffer(1, len, ctx.sampleRate);
      var d = buf.getChannelData(0);
      var i, last = 0;
      if (kind === 'brown') {
        for (i = 0; i < len; i++) {
          var w = Math.random() * 2 - 1;
          last = (last + 0.02 * w) / 1.02;
          d[i] = last * 3.2;
        }
      } else {
        for (i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      }
      return buf;
    }

    function source(buf) {
      var s = ctx.createBufferSource();
      s.buffer = buf;
      s.loop = true;
      return s;
    }

    // 慢速 LFO 调制某个 AudioParam，制造"一波一波"的呼吸感
    function lfo(rate, depth, param, base) {
      var o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = rate;
      var g = ctx.createGain();
      g.gain.value = depth;
      param.value = base;
      o.connect(g);
      g.connect(param);
      o.start();
      return o;
    }

    function pan(node, x) {
      if (ctx.createStereoPanner) {
        var p = ctx.createStereoPanner();
        p.pan.value = x;
        node.connect(p);
        return p;
      }
      return node;
    }

    function build() {
      buffers.white = noiseBuffer('white', 4);
      buffers.brown = noiseBuffer('brown', 6);

      master = ctx.createGain();
      master.gain.value = 0;              // 淡入
      duckGain = ctx.createGain();
      duckGain.gain.value = 1;
      out = ctx.createGain();
      out.gain.value = 1;

      master.connect(duckGain);
      duckGain.connect(out);
      out.connect(ctx.destination);

      // ① 涌浪：布朗噪声 → 低通 → 缓慢起伏
      var waveSrc = source(buffers.brown);
      var waveLp = ctx.createBiquadFilter();
      waveLp.type = 'lowpass';
      waveLp.frequency.value = 380;
      waveLp.Q.value = 0.6;
      var waveGain = ctx.createGain();
      waveSrc.connect(waveLp);
      var wavePan = pan(waveLp, 0);
      wavePan.connect(waveGain);
      waveGain.connect(master);
      waveSrc.start();
      var waveLfo = lfo(0.037, 0.10, waveGain.gain, 0.30);

      // ② 拍岸细响：白噪声 → 带通，左右两路反相 LFO → 立体声宽度
      var lapL = source(buffers.white);
      var lapLbp = ctx.createBiquadFilter();
      lapLbp.type = 'bandpass'; lapLbp.frequency.value = 1350; lapLbp.Q.value = 0.9;
      var lapLgain = ctx.createGain();
      lapL.connect(lapLbp);
      pan(lapLbp, -0.72).connect(lapLgain);
      lapLgain.connect(master);
      lapL.start();
      var lapLlfo = lfo(0.055, 0.035, lapLgain.gain, 0.055);

      var lapR = source(buffers.white);
      var lapRbp = ctx.createBiquadFilter();
      lapRbp.type = 'bandpass'; lapRbp.frequency.value = 1180; lapRbp.Q.value = 0.9;
      var lapRgain = ctx.createGain();
      lapR.connect(lapRbp);
      pan(lapRbp, 0.72).connect(lapRgain);
      lapRgain.connect(master);
      lapR.start();
      var lapRlfo = lfo(0.071, 0.035, lapRgain.gain, 0.055);

      // ③ 雨丝：白噪声 → 高通（只在"细雨"预设里出声）
      var hissSrc = source(buffers.white);
      var hissHp = ctx.createBiquadFilter();
      hissHp.type = 'highpass';
      hissHp.frequency.value = 3200;
      var hissGain = ctx.createGain();
      hissGain.gain.value = 0;
      hissSrc.connect(hissHp);
      hissHp.connect(hissGain);
      hissGain.connect(master);
      hissSrc.start();

      nodes = {
        waveLp: waveLp, waveGain: waveGain, waveLfo: waveLfo,
        lapLbp: lapLbp, lapLgain: lapLgain, lapLlfo: lapLlfo,
        lapRbp: lapRbp, lapRgain: lapRgain, lapRlfo: lapRlfo,
        hissHp: hissHp, hissGain: hissGain,
        sources: [waveSrc, lapL, lapR, hissSrc],
        lfos: [waveLfo, lapLlfo, lapRlfo]
      };
    }

    function smooth(param, value) {
      if (param.setTargetAtTime) param.setTargetAtTime(value, ctx.currentTime, 0.8);
      else param.value = value;
    }

    function applyPreset(name) {
      var p = PRESETS[name] || PRESETS.lake;
      api.preset = name;
      if (!nodes.waveLp) return;
      smooth(nodes.waveLp.frequency, p.waveFreq);
      smooth(nodes.waveLp.Q, p.waveQ);
      smooth(nodes.waveGain.gain, p.waveGain);
      smooth(nodes.lapLbp.frequency, p.lapFreq);
      smooth(nodes.lapRbp.frequency, p.lapFreq * 0.88);
      smooth(nodes.lapLgain.gain, p.lapGain);
      smooth(nodes.lapRgain.gain, p.lapGain);
      smooth(nodes.hissHp.frequency, p.hissFreq);
      smooth(nodes.hissGain.gain, p.hissGain);

      startEvents(p.events);
    }

    /* ── 稀疏事件：雨滴 / 鸟叫 共用一套调度 ─────────────── */

    var eventTimer = 0;
    var eventKind = null;

    function startEvents(kind) {
      stopEvents();
      if (!kind) return;
      eventKind = kind;

      var tick = function () {
        if (eventKind !== kind) return;          // 已被切换掉，自然退出
        if (!api.muted && nodes.waveLp) {
          if (kind === 'droplets') droplet();
          else chirp();
        }
        var delay = kind === 'droplets'
          ? 90 + Math.random() * 320
          : 700 + Math.random() * 4200;          // 鸟叫要稀疏，密了就成噪音
        eventTimer = window.setTimeout(tick, delay);
      };
      eventTimer = window.setTimeout(tick, kind === 'chirps' ? 500 : 200);
    }

    function stopEvents() {
      if (eventTimer) { clearTimeout(eventTimer); eventTimer = 0; }
      eventKind = null;
    }

    function droplet() {
      var t0 = ctx.currentTime;
      var src = ctx.createBufferSource();
      src.buffer = buffers.white;
      var off = Math.random() * 3;
      var bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1600 + Math.random() * 3600;
      bp.Q.value = 2.2 + Math.random() * 4;
      var g = ctx.createGain();
      var peak = 0.010 + Math.random() * 0.022;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(peak, t0 + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.05 + Math.random() * 0.05);
      src.connect(bp); bp.connect(g);
      pan(g, Math.random() * 2 - 1).connect(master);
      src.start(t0, off, 0.2);
      src.stop(t0 + 0.2);
    }

    /* 鸟叫：2~4 声短促的上滑音；偶尔来一串快速的颤音（trill）
       音高按「每只鸟」整组随机，避免所有叫声都一个调 */
    function chirp() {
      var t0 = ctx.currentTime + 0.01;
      var trill = Math.random() < 0.24;
      var notes = trill ? 5 + Math.floor(Math.random() * 4) : 2 + Math.floor(Math.random() * 3);
      var base = 2000 + Math.random() * 1600;
      var gap = trill ? 0.042 + Math.random() * 0.018 : 0.10 + Math.random() * 0.10;

      var bus = ctx.createGain();
      bus.gain.value = 1;
      pan(bus, Math.random() * 1.5 - 0.75).connect(master);

      for (var i = 0; i < notes; i++) {
        var t = t0 + i * gap;
        var dur = trill ? 0.032 : 0.048 + Math.random() * 0.036;
        var f0 = base * (0.94 + Math.random() * 0.14);
        var f1 = f0 * (1.20 + Math.random() * 0.34);
        var f2 = f0 * (0.80 + Math.random() * 0.18);

        var osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(f0, t);
        osc.frequency.exponentialRampToValueAtTime(f1, t + dur * 0.45);
        osc.frequency.exponentialRampToValueAtTime(f2, t + dur);

        var g = ctx.createGain();
        var peak = (trill ? 0.014 : 0.026) * (0.7 + Math.random() * 0.6);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(peak, t + dur * 0.28);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

        osc.connect(g);
        g.connect(bus);
        osc.start(t);
        osc.stop(t + dur + 0.02);
      }
    }

    /* 涟漪声：一个快速下滑的正弦 + 一小撮噪声瞬态 */
    api.ripple = function (x01, strength) {
      if (!ctx || api.muted) return;
      strength = Math.max(0.05, Math.min(1, strength == null ? 0.5 : strength));
      var t0 = ctx.currentTime;
      var pan0 = Math.max(-0.85, Math.min(0.85, (x01 == null ? 0.5 : x01) * 2 - 1));

      var osc = ctx.createOscillator();
      osc.type = 'sine';
      var f0 = 430 + Math.random() * 240;
      osc.frequency.setValueAtTime(f0, t0);
      osc.frequency.exponentialRampToValueAtTime(150 + Math.random() * 70, t0 + 0.17);

      var g = ctx.createGain();
      var peak = 0.020 + strength * 0.055;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(peak, t0 + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.26 + strength * 0.18);

      var lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 2600;

      osc.connect(g); g.connect(lp);
      pan(lp, pan0).connect(master);
      osc.start(t0);
      osc.stop(t0 + 0.5);
    };

    api.unlock = function () {
      if (ctx) {
        if (ctx.state === 'suspended') ctx.resume();
        return Promise.resolve(true);
      }
      try {
        ctx = new Ctx();
        build();
        applyPreset(api.preset);
        api.ready = true;
        var target = api.muted ? 0 : api.volume * 0.9;
        master.gain.cancelScheduledValues(ctx.currentTime);
        master.gain.setValueAtTime(0, ctx.currentTime);
        master.gain.linearRampToValueAtTime(target, ctx.currentTime + 2.2);
        if (ctx.state === 'suspended') return ctx.resume().then(function () { return true; });
        return Promise.resolve(true);
      } catch (e) {
        api.isFallback = true;
        api.lastError = String(e && e.message || e);
        return Promise.resolve(false);
      }
    };

    api.setVolume = function (v) {
      api.volume = Math.max(0, Math.min(1, v));
      if (!ctx || !master) return;
      var target = api.muted ? 0 : api.volume * 0.9;
      smooth(master.gain, target);
    };

    api.setMuted = function (m) {
      api.muted = !!m;
      if (!ctx || !master) return;
      smooth(master.gain, api.muted ? 0 : api.volume * 0.9);
    };

    api.setPreset = function (name) {
      if (!PRESETS[name]) return;
      if (!ctx) { api.preset = name; return; }
      applyPreset(name);
    };

    // 进入白板时轻微退让，给思考让出空间
    api.setDuck = function (v) {
      duckLevel = Math.max(0, Math.min(1, v));
      if (!ctx || !duckGain) return;
      smooth(duckGain.gain, duckLevel);
    };

    api.suspend = function () { if (ctx && ctx.state === 'running') ctx.suspend(); };
    api.resume = function () { if (ctx && ctx.state === 'suspended') ctx.resume(); };

    api.dispose = function () {
      stopEvents();
      if (!ctx) return;
      try { ctx.close(); } catch (e) {}
      ctx = null;
    };

    return api;
  }

  window.Flow.Audio = { create: create, PRESETS: PRESETS };
})();
