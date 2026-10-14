/* ============================================================
   app.js — 编排层
   状态机（水景 / 白板）、相机（缩放平移）、鼠标涟漪、秒级时钟、
   快捷键、工具切换、统一持久化、导入导出、错误提示。
   ============================================================ */
(function () {
  'use strict';

  var Flow = window.Flow || (window.Flow = {});

  /* ── 错误提示（同时是自动化检查的观察点） ────────────────── */

  var errBox = document.getElementById('err');
  var errors = [];

  function showErr(msg) {
    errors.push(msg);
    Flow.__errors = errors;
    if (!errBox) return;
    errBox.hidden = false;
    errBox.textContent = errors.slice(-4).join('\n');
  }

  window.addEventListener('error', function (e) {
    showErr('[error] ' + (e.message || 'unknown') +
      (e.filename ? ' @ ' + e.filename.split('/').pop() + ':' + e.lineno : ''));
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    showErr('[promise] ' + ((r && r.message) || String(r)));
  });

  /* ── 参数 ────────────────────────────────────────────────── */

  var params = new URLSearchParams(location.search);
  var AUTO = params.get('auto') === '1';
  var START_BOARD = params.get('board') === '1';
  var DEMO = params.get('demo') === '1';
  var DEBUG = params.get('debug') === '1';

  /* ── 元素 ────────────────────────────────────────────────── */

  var $ = function (id) { return document.getElementById(id); };
  var waterCanvas = $('water');
  var boardBase = $('board');
  var boardLive = $('board-live');
  var gate = $('gate');
  var gateBtn = $('gate-btn');
  var clockText = $('clock-text');
  var clockAmpm = $('clock-ampm');
  var statusEl = $('status');
  var volumeInput = $('volume');
  var toolbar = $('toolbar');
  var zoomLabel = $('zoom-label');
  var fileInput = $('file-input');
  var exportBtn = $('export-btn');
  var exportMenu = $('export-menu');
  var sunPanel = $('sun-panel');
  var sunRange = $('sun-range');
  var sunTime = $('sun-time');
  var sunPhase = $('sun-phase');
  var sunAuto = $('sun-auto');

  /* ── 子系统 ─────────────────────────────────────────────── */

  var water = Flow.Water.create(waterCanvas, { quality: 0.62 });
  if (water.isFallback) document.body.classList.add('water-fallback');

  var audio = Flow.Audio.create();
  var camera = Flow.Camera.create();

  var sheetsEl = $('sheets');

  /* ── 分页 ────────────────────────────────────────────────────
     每页 = { id, name, strokes, blocks, edges, undo }。
     实时内容住在 board / blocks 里；sheets[active] 是它的"存档"。
     注意：搬运内容必须深拷贝。board.getStrokes() 返回的是内部数组，
     直接塞进 sheet 会被 replaceStrokes 原地清空，两页就互相污染了。
     ──────────────────────────────────────────────────────────── */

  var sheetData = Flow.Store.loadSheets();
  var sheets = sheetData.sheets;
  var active = sheetData.active;

  if (!sheets.length) {
    sheets = [Flow.Store.sanitizeSheet({ name: '页 1' })];
    active = 0;
  }

  function cloneStrokes(list) {
    return (list || []).map(function (s) {
      return {
        c: s.c, w: s.w, e: !!s.e,
        p: (s.p || []).map(function (p) { return [p[0], p[1], p[2]]; })
      };
    });
  }
  function cloneBlocks(list) {
    return (list || []).map(function (b) {
      return { id: b.id, x: b.x, y: b.y, text: b.text, color: b.color || 0, strike: b.strike ? 1 : 0 };
    });
  }
  function cloneEdges(list) {
    return (list || []).map(function (e) { return { id: e.id, from: e.from, to: e.to }; });
  }

  var board = Flow.Board.create({
    base: boardBase,
    live: boardLive,
    strokes: cloneStrokes(sheets[active].strokes),
    camera: camera
  });

  var blocks = Flow.Blocks.create({
    layer: $('nodes'),
    catchLayer: $('text-catch'),
    svg: $('edges'),
    edgeCamera: $('edge-camera'),
    edgeLayer: $('edge-layer'),
    preview: $('edge-preview'),
    blocks: cloneBlocks(sheets[active].blocks),
    edges: cloneEdges(sheets[active].edges),
    camera: camera
  });

  var state = 'water';
  var tool = 'text';                    // 白板默认是文字，不是画笔
  var prefs = Flow.Store.loadPrefs();

  /* ── 分页：读写与切换 ───────────────────────────────────── */

  // 把实时内容写回当前页的存档
  function syncActiveSheet() {
    var s = sheets[active];
    if (!s) return;
    s.strokes = cloneStrokes(board.getStrokes());
    s.blocks = cloneBlocks(blocks.getBlocks());
    s.edges = cloneEdges(blocks.getEdges());
  }

  // 把某一页的存档灌进实时状态
  function loadSheet(index) {
    active = Math.max(0, Math.min(sheets.length - 1, index));
    var s = sheets[active];
    board.replaceStrokes(cloneStrokes(s.strokes));
    blocks.replaceAll(cloneBlocks(s.blocks), cloneEdges(s.edges));
    blocks.importUndo(s.undo || []);
    renderSheetBar();
  }

  function stashUndo() {
    var s = sheets[active];
    if (s) s.undo = blocks.exportUndo();
  }

  function switchSheet(index) {
    if (index === active || index < 0 || index >= sheets.length) return;
    syncActiveSheet();
    stashUndo();
    loadSheet(index);
    scheduleSave();
    showStatus('「' + sheets[active].name + '」· 第 ' + (active + 1) + ' / ' + sheets.length + ' 页');
  }

  function addSheet() {
    syncActiveSheet();
    stashUndo();
    var s = Flow.Store.sanitizeSheet({
      id: Flow.Store.newSheetId(),
      name: '页 ' + (sheets.length + 1)
    });
    s.undo = [];
    sheets.push(s);
    loadSheet(sheets.length - 1);
    scheduleSave();
    showStatus('新建了「' + s.name + '」');
  }

  function removeSheet(index) {
    if (sheets.length <= 1) {
      showStatus('至少要留一页');
      return;
    }
    var name = sheets[index].name;
    if (!window.confirm('删除「' + name + '」？这一页的笔迹和字块会一起删掉。')) return;

    var wasActive = index === active;
    sheets.splice(index, 1);
    if (index < active) active--;
    if (wasActive || active > sheets.length - 1) active = Math.min(active, sheets.length - 1);
    active = Math.max(0, Math.min(sheets.length - 1, active));

    // 被删的是当前页时要真正换页；否则只需刷新标签
    board.replaceStrokes(cloneStrokes(sheets[active].strokes));
    blocks.replaceAll(cloneBlocks(sheets[active].blocks), cloneEdges(sheets[active].edges));
    blocks.importUndo(sheets[active].undo || []);
    renderSheetBar();
    scheduleSave();
    showStatus('已删除「' + name + '」');
  }

  function renameSheet(index, span) {
    span.contentEditable = 'true';
    span.focus();
    try {
      var r = document.createRange();
      r.selectNodeContents(span);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    } catch (e) {}

    function commit(cancel) {
      span.contentEditable = 'false';
      var v = (span.textContent || '').replace(/\s+/g, ' ').trim();
      if (cancel || !v) v = sheets[index].name;
      sheets[index].name = v.slice(0, Flow.Store.SHEET_NAME_MAX);
      span.textContent = sheets[index].name;
      scheduleSave();
    }

    span.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); span.blur(); }
      if (e.key === 'Escape') { e.preventDefault(); commit(true); span.blur(); }
      e.stopPropagation();
    });
    span.addEventListener('blur', function () { commit(false); }, { once: true });
  }

  function renderSheetBar() {
    if (!sheetsEl) return;
    sheetsEl.textContent = '';
    sheets.forEach(function (s, i) {
      var tab = document.createElement('div');
      tab.className = 'sheet-tab' + (i === active ? ' on' : '');
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', i === active ? 'true' : 'false');
      tab.title = '点击切换 · 双击改名';

      var name = document.createElement('span');
      name.className = 'sheet-name';
      name.textContent = s.name;
      tab.appendChild(name);

      if (sheets.length > 1) {
        var x = document.createElement('button');
        x.type = 'button';
        x.className = 'sheet-x';
        x.textContent = '×';
        x.title = '删除这一页';
        x.setAttribute('aria-label', '删除 ' + s.name);
        x.addEventListener('click', function (e) {
          e.stopPropagation();
          removeSheet(i);
        });
        tab.appendChild(x);
      }

      tab.addEventListener('click', function () { switchSheet(i); });
      tab.addEventListener('dblclick', function (e) {
        e.preventDefault();
        renameSheet(i, name);
      });

      sheetsEl.appendChild(tab);
    });

    var add = document.createElement('button');
    add.type = 'button';
    add.className = 'sheet-add';
    add.textContent = '+';
    add.title = '新建一页 (Ctrl+PageDown 到最后)';
    add.setAttribute('aria-label', '新建一页');
    add.addEventListener('click', function () { addSheet(); });
    sheetsEl.appendChild(add);
  }

  renderSheetBar();

  /* ── 相机 → 三层同步重绘（按帧节流） ────────────────────── */

  var viewRaf = 0;

  function updateZoomLabel() {
    if (zoomLabel) zoomLabel.textContent = Math.round(camera.scale * 100) + '%';
  }

  camera.onChange = function () {
    if (viewRaf) return;
    viewRaf = requestAnimationFrame(function () {
      viewRaf = 0;
      board.viewChanged();
      blocks.viewChanged();
      updateZoomLabel();
    });
  };

  updateZoomLabel();

  /* ── 统一持久化（防抖 600ms） ───────────────────────────── */

  var saveTimer = 0;

  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(function () {
      saveTimer = 0;
      syncActiveSheet();                       // 先把实时内容写回当前页
      var info = Flow.Store.saveSheets(sheets, active);
      if (!info.ok) {
        showStatus(info.reason === 'too-large'
          ? '内容太多，已停止自动保存'
          : '浏览器拒绝本地保存（隐私模式？）', 4000);
      }
    }, 600);
  }

  function flushSave() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = 0; }
    syncActiveSheet();
    return Flow.Store.saveSheets(sheets, active);
  }

  board.onChange = scheduleSave;
  blocks.onChange = scheduleSave;

  /* ── 状态提示 ───────────────────────────────────────────── */

  var statusTimer = 0;
  function showStatus(text, ms) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.classList.add('show');
    clearTimeout(statusTimer);
    statusTimer = setTimeout(function () {
      statusEl.classList.remove('show');
    }, ms || 2200);
  }

  /* ── 湖面时间：自动跟随真实时间，也可用拨码手动指定 ───────
     内部维护一个"当前小时"，每帧朝目标缓动。缓动沿 24 小时圆环
     走最短路径，所以从 23:50 跳到 00:10 只会挪 20 分钟，不会倒着
     扫过一整天。
     ──────────────────────────────────────────────────────── */

  var sun = {
    auto: prefs.sunAuto !== false,                              // 默认跟随真实时间
    manualMin: typeof prefs.sunMin === 'number' ? prefs.sunMin : 720,
    current: 0,
    applied: -999,
    shownMin: -1,
    ready: false
  };

  function realHour() {
    var d = new Date();
    return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
  }

  function sunTargetHour() {
    return sun.auto ? realHour() : sun.manualMin / 60;
  }

  function updateSunUI(force) {
    var minute = Math.round(sun.current * 60) % 1440;
    if (!force && minute === sun.shownMin) return;
    sun.shownMin = minute;

    var P = Flow.Sun.palette(sun.current);
    if (sunRange) sunRange.value = String(minute);
    if (sunTime) sunTime.textContent = Flow.Sun.formatHour(sun.current);
    if (sunPhase) sunPhase.textContent = P.name;
    if (sunAuto) {
      sunAuto.classList.toggle('on', sun.auto);
      sunAuto.setAttribute('aria-pressed', sun.auto ? 'true' : 'false');
    }
    if (sunPanel) {
      sunPanel.title = '湖面时间 ' + Flow.Sun.formatHour(sun.current) + '（' + P.name + '）' +
        (sun.auto ? ' · 跟随当前时间' : ' · 手动锁定');
    }
  }

  // 每帧推进（由 water 的 onFrame 调用，和渲染同一个节拍）
  function tickSun(dt) {
    var target = sunTargetHour();
    if (!sun.ready) {
      sun.current = target;
      sun.ready = true;
    } else {
      var delta = target - sun.current;
      while (delta > 12) delta -= 24;
      while (delta < -12) delta += 24;
      // 指数逼近，和帧率无关
      sun.current += delta * (1 - Math.exp(-dt / 0.30));
      if (sun.current < 0) sun.current += 24;
      if (sun.current >= 24) sun.current -= 24;
    }

    if (Math.abs(sun.current - sun.applied) > 0.0015) {
      sun.applied = sun.current;
      water.setPalette(Flow.Sun.palette(sun.current));
      updateSunUI(false);
    }
  }

  function setSunAuto(on, quiet) {
    sun.auto = !!on;
    prefs.sunAuto = sun.auto;
    Flow.Store.savePrefs(prefs);
    updateSunUI(true);
    if (!quiet) {
      showStatus(sun.auto
        ? '湖面时间跟随当前时间 · ' + Flow.Sun.palette(realHour()).name
        : '湖面时间已锁定 · ' + Flow.Sun.formatHour(sun.manualMin / 60));
    }
  }

  function setSunManual(minute, quiet) {
    sun.manualMin = Math.max(0, Math.min(1439, Math.round(minute)));
    prefs.sunMin = sun.manualMin;
    Flow.Store.savePrefs(prefs);
    if (sun.auto) {
      sun.auto = false;
      prefs.sunAuto = false;
      Flow.Store.savePrefs(prefs);
    }
    updateSunUI(true);
    if (!quiet) {
      showStatus('湖面时间 · ' + Flow.Sun.formatHour(sun.manualMin / 60) +
        '（' + Flow.Sun.palette(sun.manualMin / 60).name + '）');
    }
  }

  if (sunRange) {
    sunRange.addEventListener('input', function () {
      setSunManual(Number(sunRange.value), true);      // 拖动时不要刷状态提示
    });
    sunRange.addEventListener('change', function () {
      showStatus('湖面时间 · ' + Flow.Sun.formatHour(sun.manualMin / 60) +
        '（' + Flow.Sun.palette(sun.manualMin / 60).name + '）');
    });
  }
  if (sunAuto) {
    sunAuto.addEventListener('click', function () { setSunAuto(!sun.auto); });
  }

  /* ── 时钟：精确到秒，可单独开关 ─────────────────────────── */

  var lastClockText = '';

  function tickClock() {
    var d = new Date();
    var h = d.getHours();
    var m = String(d.getMinutes()).padStart(2, '0');
    var s = String(d.getSeconds()).padStart(2, '0');
    var ap = h < 12 ? 'a.m.' : 'p.m.';
    h = h % 12;
    if (h === 0) h = 12;
    var text = h + ':' + m + ':' + s;
    if (text !== lastClockText) {
      lastClockText = text;
      if (clockText) clockText.textContent = text;
    }
    if (clockAmpm) clockAmpm.textContent = ap;
  }

  var clockHidden = !!prefs.clockHidden;
  var clockParam = params.get('clock');
  if (clockParam === '0') clockHidden = true;
  else if (clockParam === '1') clockHidden = false;

  function applyClock() {
    document.body.classList.toggle('clock-hidden', clockHidden);
  }

  function toggleClock() {
    clockHidden = !clockHidden;
    prefs.clockHidden = clockHidden;
    Flow.Store.savePrefs(prefs);
    applyClock();
    showStatus(clockHidden ? '时间已隐藏' : '时间已显示');
  }

  tickClock();
  setInterval(tickClock, 250);
  applyClock();

  /* 湖面光照接进渲染节拍：先算好这一刻的光，再交给水景渲染 */
  water.onFrame = tickSun;
  water.setPalette(Flow.Sun.palette(sun.auto ? realHour() : sun.manualMin / 60));
  updateSunUI(true);

  /* ── 涟漪：鼠标划过水面 ─────────────────────────────────── */

  var lastDropAt = 0;
  var lastPt = { x: -1e9, y: -1e9 };
  var lastSoundAt = 0;

  function rippleAt(x, y, strength, withSound) {
    water.drop(x, y, strength);
    var now = performance.now();
    if (withSound && now - lastSoundAt > 95) {
      lastSoundAt = now;
      audio.ripple(x / Math.max(1, window.innerWidth), strength * 6);
    }
  }

  var lastMoveAt = 0;

  function onWaterMove(e) {
    if (state !== 'water') return;
    var now = performance.now();
    var dx = e.clientX - lastPt.x;
    var dy = e.clientY - lastPt.y;
    var dist = Math.sqrt(dx * dx + dy * dy);
    lastPt.x = e.clientX; lastPt.y = e.clientY;
    if (now - lastDropAt < 50 || dist < 7) return;
    var span = Math.max(1, now - lastMoveAt);
    lastMoveAt = now;
    lastDropAt = now;
    var speed = dist / span;
    var strength = Math.max(0.015, Math.min(0.055, dist / 700 + speed * 0.008));
    rippleAt(e.clientX, e.clientY, strength, true);
    window.__flowMoves = (window.__flowMoves || 0) + 1;
  }

  window.addEventListener('pointermove', onWaterMove, { passive: true });

  /* 空闲时偶尔落一滴，让画面始终活着 */
  var lastUserAt = performance.now();

  var nextAmbient = 3000;
  water.onSeed = function (t) {
    var ms = t * 1000;
    if (ms < nextAmbient) return;
    nextAmbient = ms + 2400 + Math.random() * 4200;
    if (state !== 'water') return;
    if (performance.now() - lastUserAt < 2600) return;
    var x = window.innerWidth * (0.12 + Math.random() * 0.76);
    var y = window.innerHeight * (0.18 + Math.random() * 0.7);
    rippleAt(x, y, 0.012 + Math.random() * 0.018, Math.random() < 0.5);
  };

  /* ── 缩放与平移 ─────────────────────────────────────────── */

  var spaceDown = false;
  var panning = null;

  // 滚轮缩放，锚点是鼠标位置。工具栏自己的横向滚动不要被抢
  window.addEventListener('wheel', function (e) {
    if (state !== 'board') return;
    if (toolbar && toolbar.contains(e.target)) return;
    if (blocks.isEditing()) return;
    e.preventDefault();
    var step = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    var factor = Math.pow(0.999, step);
    factor = Math.max(0.72, Math.min(1.38, factor));
    camera.zoomAt(e.clientX, e.clientY, factor);
  }, { passive: false });

  // 平移：中键拖动，或按住空格拖动。用捕获阶段抢在绘制/拖块之前
  window.addEventListener('pointerdown', function (e) {
    if (state !== 'board') return;
    var want = (e.button === 1) || (spaceDown && e.button === 0);
    if (!want) return;
    if (blocks.isEditing()) return;
    panning = { x: e.clientX, y: e.clientY };
    document.body.classList.add('panning');
    e.preventDefault();
    e.stopPropagation();
  }, true);

  window.addEventListener('pointermove', function (e) {
    if (!panning) return;
    camera.panBy(e.clientX - panning.x, e.clientY - panning.y);
    panning.x = e.clientX;
    panning.y = e.clientY;
  });

  window.addEventListener('pointerup', function () {
    if (!panning) return;
    panning = null;
    document.body.classList.remove('panning');
  });

  window.addEventListener('keyup', function (e) {
    if (e.code === 'Space') {
      spaceDown = false;
      document.body.classList.remove('pan-ready');
    }
  });
  window.addEventListener('blur', function () {
    spaceDown = false;
    document.body.classList.remove('pan-ready');
  });

  function fitView() {
    var box = Flow.Store.contentBounds(board.getStrokes(), blocks.exportData(), 60);
    if (!box) { camera.reset(); showStatus('视图已重置'); return; }
    camera.fit(box, window.innerWidth, window.innerHeight, 90);
    showStatus('已缩放到全部内容');
  }

  /* ── 模式切换 ───────────────────────────────────────────── */

  function setMode(next) {
    if (next === state) return;
    state = next;
    var onBoard = next === 'board';
    document.body.classList.toggle('mode-board', onBoard);
    board.setEnabled(onBoard);
    blocks.setEnabled(onBoard);
    water.setCalm(onBoard ? 1 : 0);
    audio.setDuck(onBoard ? 0.72 : 1);

    if (onBoard) {
      setTool('text', true);            // 每次进白板都以文字工具开场
      showStatus('白板 · 点空白处写想法 / 滚轮缩放 / 空格拖动平移 / Esc 回到水面', 4600);
      updateZoomLabel();
    } else {
      closeExportMenu();                // 回水面时把导出菜单收掉
      var w = window.innerWidth, h = window.innerHeight;
      for (var i = 0; i < 3; i++) {
        water.drop(w * (0.34 + i * 0.16), h * (0.42 + (i % 2) * 0.16), 0.035);
      }
      audio.ripple(0.5, 0.55);
      showStatus('水面');
    }
  }

  function toggleMode() { setMode(state === 'board' ? 'water' : 'board'); }

  /* ── 界面隐藏（挂机模式） ───────────────────────────────── */

  var manualHidden = false;
  var autoHidden = false;
  var idleTimer = 0;

  function applyHidden() {
    document.body.classList.toggle('ui-hidden', manualHidden || autoHidden);
  }

  function bumpIdle() {
    lastUserAt = performance.now();
    if (autoHidden) { autoHidden = false; applyHidden(); }
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () {
      if (manualHidden) return;
      if (state === 'board') return;
      if (blocks.isEditing()) return;
      autoHidden = true;
      applyHidden();
    }, 24000);
  }

  bumpIdle();
  window.addEventListener('pointermove', bumpIdle, { passive: true });
  window.addEventListener('pointerdown', bumpIdle, { passive: true });

  /* ── 声音面板 ───────────────────────────────────────────── */

  var PRESET_ORDER = ['lake', 'rain', 'birds'];
  var PRESET_LABEL = { lake: '夜湖', rain: '细雨', birds: '鸟鸣' };

  function applyVolume(v) {
    audio.setVolume(v);
    volumeInput.value = String(Math.round(v * 100));
    prefs.volume = v;
    Flow.Store.savePrefs(prefs);
  }

  volumeInput.addEventListener('input', function () {
    applyVolume(Number(volumeInput.value) / 100);
  });

  function applyPreset(name, quiet) {
    audio.setPreset(name);
    prefs.preset = name;
    Flow.Store.savePrefs(prefs);
    document.querySelectorAll('.seg button').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-preset') === name);
    });
    if (!quiet) showStatus('音景 · ' + (PRESET_LABEL[name] || name));
  }

  function cyclePreset() {
    var i = PRESET_ORDER.indexOf(audio.preset);
    applyPreset(PRESET_ORDER[(i + 1) % PRESET_ORDER.length]);
  }

  document.querySelectorAll('.seg button').forEach(function (b) {
    b.addEventListener('click', function () { applyPreset(b.getAttribute('data-preset')); });
  });

  function toggleMute() {
    audio.setMuted(!audio.muted);
    prefs.muted = audio.muted;
    Flow.Store.savePrefs(prefs);
    showStatus(audio.muted ? '已静音' : '声音已开');
  }

  /* ── 全屏 ───────────────────────────────────────────────── */

  var fsBtn = $('fs-btn');

  function fsElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }
  function isFullscreen() { return !!fsElement(); }

  function updateFsUI() {
    var on = isFullscreen();
    document.body.classList.toggle('is-fullscreen', on);
    if (fsBtn) {
      fsBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      fsBtn.title = on ? '退出全屏 (F)' : '全屏 (F)';
      fsBtn.setAttribute('aria-label', on ? '退出全屏' : '全屏');
    }
  }

  function toggleFullscreen() {
    var el = document.documentElement;
    if (isFullscreen()) {
      var exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) {
        var pe = exit.call(document);
        if (pe && pe.catch) pe.catch(function () {});
      }
      return;
    }
    var req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (!req) { showStatus('这个浏览器不支持全屏'); return; }
    // 浏览器可能因为不是用户手势而拒绝，这里必须接住，否则控制台会多一条未捕获异常
    var pr = req.call(el);
    if (pr && pr.catch) {
      pr.catch(function () { showStatus('全屏被浏览器拒绝了', 2600); });
    }
  }

  if (fsBtn) fsBtn.addEventListener('click', toggleFullscreen);
  ['fullscreenchange', 'webkitfullscreenchange'].forEach(function (ev) {
    document.addEventListener(ev, updateFsUI);
  });
  updateFsUI();

  /* ── 工具 ───────────────────────────────────────────────── */

  var TOOL_BTNS = '#toolbar [data-tool="select"], #toolbar [data-tool="pen"], ' +
                  '#toolbar [data-tool="eraser"], #toolbar [data-tool="text"]';

  function setTool(t, quiet) {
    tool = t;
    board.setTool(t === 'eraser' ? 'eraser' : 'pen');
    // 选择工具下关掉落笔：画布仍然接收事件（用于框选），但不再画线
    board.setDrawEnabled(t !== 'select');
    blocks.setTool(t);
    document.body.classList.toggle('tool-text', t === 'text');
    document.body.classList.toggle('tool-select', t === 'select');
    if (t !== 'select') hideMarquee();
    document.querySelectorAll(TOOL_BTNS).forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-tool') === t);
    });
    if (quiet) return;
    showStatus(t === 'eraser' ? '橡皮'
      : t === 'text' ? '文字块 · 点空白处新建，拖动可移动，从右侧圆点拖出连线'
      : t === 'select' ? '选择 · 拖拽框选多个，Shift 点选加/减，拖动任一选中项整组移动'
      : '画笔', (t === 'text' || t === 'select') ? 4400 : 2200);
  }

  function setInk(i) {
    board.setInk(i);
    blocks.setColor(i);
    document.querySelectorAll('.swatches .sw').forEach(function (b) {
      b.classList.toggle('on', Number(b.getAttribute('data-ink')) === i);
    });
    prefs.ink = i;
    Flow.Store.savePrefs(prefs);
  }

  /* 删除线：对选中的字块整块划掉 / 取消。
     没选中字块时给提示而不是静默失败 —— 否则按了没反应会以为快捷键坏了。 */
  function toggleStrike() {
    if (state !== 'board') return;
    var r = blocks.toggleStrike();
    if (r.n < 0) {
      showStatus('先选中要划掉的字块（选择工具下可框选多个）', 3600);
      return;
    }
    if (r.n === 0) {
      showStatus(r.on ? '这些块已经划掉了' : '这些块本来就没有删除线', 2400);
      return;
    }
    showStatus((r.on ? '已划掉 ' : '已取消删除线 ') + r.n + ' 个块（可 Ctrl+Z 撤销）');
  }

  function doUndo() {
    if (blocks.undo()) { showStatus('撤销'); return; }
    if (board.undo()) { showStatus('撤销'); return; }
    showStatus('没有可撤销的了');
  }

  /* ── 框选与整组移动（选择工具） ─────────────────────────────
     三类对象的选中状态放在一处：
       · 字块 / 连线 → blocks 内部的 sel 集合
       · 笔迹       → 这里用对象引用列表（笔迹没有 id）
     拖动时两边用同一份"起点快照 + 绝对偏移"，所以不会漂移。
     ──────────────────────────────────────────────────────── */

  var marqueeEl = $('marquee');
  var marquee = null;          // {x0,y0,x1,y1} 场景坐标
  var strokeSel = [];          // 选中的笔迹对象
  var moveSnap = null;         // 笔迹起点快照
  var moveOrigin = null;       // {x,y} 手势起点（场景坐标）

  function sceneX(e) { return camera.toSceneX(e.clientX); }
  function sceneY(e) { return camera.toSceneY(e.clientY); }

  function showMarquee() {
    if (!marqueeEl) return;
    marqueeEl.classList.add('on');
  }
  function hideMarquee() {
    if (!marqueeEl) return;
    marqueeEl.classList.remove('on');
  }

  function updateMarqueeBox() {
    if (!marqueeEl || !marquee) return;
    var x0 = camera.toScreenX(Math.min(marquee.x0, marquee.x1));
    var y0 = camera.toScreenY(Math.min(marquee.y0, marquee.y1));
    var x1 = camera.toScreenX(Math.max(marquee.x0, marquee.x1));
    var y1 = camera.toScreenY(Math.max(marquee.y0, marquee.y1));
    marqueeEl.style.left = Math.round(x0) + 'px';
    marqueeEl.style.top = Math.round(y0) + 'px';
    marqueeEl.style.width = Math.round(x1 - x0) + 'px';
    marqueeEl.style.height = Math.round(y1 - y0) + 'px';
  }

  // 把当前框内的对象同步成选区（拖拽过程中实时预览）
  function applyMarqueeSelection(additive) {
    if (!marquee) return;
    var rect = Flow.Geom.rectFromCorners(marquee.x0, marquee.y0, marquee.x1, marquee.y1);
    var hit = blocks.hitTestRect(rect);
    var strokes = board.strokesInRect(rect);

    if (!additive) {
      blocks.clearSelection();
      strokeSel = [];
    }
    hit.blocks.forEach(function (id) { if (!blocks.isSelected('block', id)) blocks.toggleSelection('block', id); });
    hit.edges.forEach(function (id) { if (!blocks.isSelected('edge', id)) blocks.toggleSelection('edge', id); });
    strokes.forEach(function (s) { if (strokeSel.indexOf(s) < 0) strokeSel.push(s); });

    blocks.render();
    board.setHighlight(strokeSel);
    updateSelectionStatus();
  }

  function clearSelection() {
    blocks.clearSelection();
    strokeSel = [];
    board.setHighlight([]);
  }

  function updateSelectionStatus() {
    var n = blocks.selectionCount() + strokeSel.length;
    if (!n) return;
    showStatus('已选 ' + n + ' 项' +
      (blocks.selectedBlockIds().length ? '（字块 ' + blocks.selectedBlockIds().length + '）' : '') +
      (strokeSel.length ? '（笔迹 ' + strokeSel.length + '）' : ''), 1400);
  }

  /* 拖动开始时记下笔迹的起点 */
  function beginGroupMove() {
    moveSnap = board.snapshotStrokes(strokeSel);
    blocks.beginMove();
    moveOrigin = null;
  }

  function applyGroupMove(dx, dy) {
    if (moveSnap) board.applyStrokesOffset(moveSnap, dx, dy);
    blocks.moveBy(dx, dy);
  }

  function endGroupMove(moved) {
    if (moved) {
      board.pushMoveUndo(moveSnap);     // 整组平移登记成一次可撤销的移动
      board.commitStrokes();
    }
    blocks.endMove();
    moveSnap = null;
    moveOrigin = null;
  }

  function selectAll() {
    if (state !== 'board') return;
    var n = blocks.selectAll();
    strokeSel = board.getStrokes().filter(function (s) { return !s.e; });
    board.setHighlight(strokeSel);
    var total = n + strokeSel.length;
    showStatus(total ? '已全选 ' + total + ' 项' : '这一页是空的');
  }

  /* 字块那边发起的整组拖动 → 这里同步移动笔迹 */
  blocks.onGroupMove = function (phase, dx, dy) {
    if (phase === 'start') beginGroupMove();
    else if (phase === 'move') { if (moveSnap) board.applyStrokesOffset(moveSnap, dx, dy); }
    else endGroupMove(true);
  };

  /* 选择工具下，画布上的按下可能是"框选"也可能是"抓住选中的笔迹拖动" */
  function onCanvasDown(e) {
    if (state !== 'board' || tool !== 'select') return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    var sx = sceneX(e), sy = sceneY(e);

    // 1) 命中已选中的笔迹 → 整组拖动（字块也会跟着走）
    var grabbed = null;
    for (var i = strokeSel.length - 1; i >= 0; i--) {
      var r = board.strokeRect(strokeSel[i]);
      if (r && Flow.Geom.pointInRect(Flow.Geom.expand(r, 6), sx, sy)) { grabbed = strokeSel[i]; break; }
    }
    if (grabbed) {
      moveOrigin = { x: sx, y: sy };
      beginGroupMove();
      marquee = null;
      try { boardLive.setPointerCapture(e.pointerId); } catch (err) {}
      e.preventDefault();
      return;
    }

    // 2) 否则开始框选
    marquee = { x0: sx, y0: sy, x1: sx, y1: sy };
    marquee.additive = !!e.shiftKey;
    if (!e.shiftKey) clearSelection();
    showMarquee();
    updateMarqueeBox();
    try { boardLive.setPointerCapture(e.pointerId); } catch (err) {}
    e.preventDefault();
  }

  function onCanvasMove(e) {
    if (state !== 'board' || tool !== 'select') return;
    if (moveOrigin) {
      var dx = sceneX(e) - moveOrigin.x;
      var dy = sceneY(e) - moveOrigin.y;
      var d = blocks.clampMove(dx, dy);
      applyGroupMove(d.dx, d.dy);
      return;
    }
    if (!marquee) return;
    marquee.x1 = sceneX(e);
    marquee.y1 = sceneY(e);
    updateMarqueeBox();
    applyMarqueeSelection(marquee.additive);
  }

  function onCanvasUp(e) {
    if (moveOrigin) {
      endGroupMove(true);
      updateSelectionStatus();
      return;
    }
    if (!marquee) return;
    var wasTiny = Math.abs(marquee.x1 - marquee.x0) < 3 && Math.abs(marquee.y1 - marquee.y0) < 3;
    marquee = null;
    hideMarquee();
    if (wasTiny) clearSelection();       // 只是点了一下空白 → 取消选中
  }

  boardLive.addEventListener('pointerdown', onCanvasDown);
  window.addEventListener('pointermove', onCanvasMove, { passive: true });
  window.addEventListener('pointerup', onCanvasUp);
  window.addEventListener('pointercancel', onCanvasUp);

  function download(name, data, mime) {
    Flow.Store.download(name, data, mime);
    showStatus('已导出 ' + name, 3000);
  }

  /* ── 导出 ───────────────────────────────────────────────── */

  function viewBox() {
    return {
      x: camera.toSceneX(0),
      y: camera.toSceneY(0),
      w: window.innerWidth / camera.scale,
      h: window.innerHeight / camera.scale
    };
  }

  function exportPNG() {
    var data = blocks.exportData();
    var box = Flow.Store.contentBounds(board.getStrokes(), data, 40) || viewBox();

    // 出图分辨率上限：最长边 6000px、总量 2400 万像素
    var scale = 2;
    var maxSide = Math.max(box.w, box.h) * scale;
    if (maxSide > 6000) scale = 6000 / Math.max(box.w, box.h);
    while (box.w * scale * box.h * scale > 24000000 && scale > 0.5) scale *= 0.85;

    var canvas = Flow.Store.exportPNG({
      box: box,
      scale: scale,
      bg: 'dark',
      ink: function (ctx) { board.paintInk(ctx); },
      content: function (ctx) { blocks.paint(ctx); }
    });

    var name = 'flow-' + Flow.Store.stamp() + '.png';
    if (canvas.toBlob) {
      canvas.toBlob(function (blob) {
        if (blob) download(name, blob, 'image/png');
        else showStatus('导出失败');
      }, 'image/png');
    } else {
      showStatus('导出失败');
    }
  }

  function exportExcalidraw() {
    var text = Flow.Store.toExcalidraw(
      board.getStrokes(),
      blocks.exportData(),
      { background: '#0b1018', source: 'flow' }
    );
    download('flow-' + Flow.Store.stamp() + '.excalidraw', text, 'application/json');
    showStatus('已导出 .excalidraw（实验性：橡皮结果不保留）', 4200);
  }

  function saveProject() {
    syncActiveSheet();
    var text = Flow.Store.toProjectJSON(sheets, active);
    download('flow-' + Flow.Store.stamp() + '.json', text, 'application/json');
    showStatus('已导出工程文件（' + sheets.length + ' 页，可直接再导入）', 3600);
  }

  /* ── 导入 ───────────────────────────────────────────────── */

  function looksLikeExcalidraw(name, text) {
    if (/\.excalidraw$/i.test(name || '')) return true;
    return /"type"\s*:\s*"excalidraw"/.test(text.slice(0, 600));
  }

  /* .excalidraw → 新开一页放进去（不破坏现有内容，也不用弹确认） */
  function importExcalidrawAsSheet(parsed, fileName) {
    var n = (parsed.strokes || []).length;
    var b = (parsed.blocks || []).length;
    var e = (parsed.edges || []).length;
    if (!n && !b) { showStatus('「' + fileName + '」里没有可导入的内容', 3800); return; }

    syncActiveSheet();
    stashUndo();

    var base = String(fileName || '').replace(/\.excalidraw$/i, '').replace(/\s+/g, ' ').trim();
    var s = Flow.Store.sanitizeSheet({
      id: Flow.Store.newSheetId(),
      name: base || ('导入 ' + (sheets.length + 1)),
      strokes: parsed.strokes,
      blocks: parsed.blocks,
      edges: parsed.edges
    });
    s.undo = [];
    sheets.push(s);
    loadSheet(sheets.length - 1);
    flushSave();
    setTimeout(fitView, 80);

    var extra = '';
    if (parsed.stats && parsed.stats.skippedArrows) {
      extra = '，跳过 ' + parsed.stats.skippedArrows + ' 条认不出的连线';
    }
    showStatus('已作为新页导入：' + n + ' 笔 · ' + b + ' 块 · ' + e + ' 连线' + extra, 5600);
  }

  /* 工程文件 → 整体替换所有页 */
  function importProject(parsed, fileName) {
    var list = parsed.sheets || [];
    if (!list.length) { showStatus('「' + fileName + '」里没有可导入的内容', 3800); return; }

    var n = 0, b = 0, e = 0;
    list.forEach(function (s) {
      n += (s.strokes || []).length;
      b += (s.blocks || []).length;
      e += (s.edges || []).length;
    });

    var msg = '导入工程文件「' + fileName + '」会替换当前全部 ' + sheets.length + ' 页内容。\n\n' +
      '将导入：' + list.length + ' 页 · ' + n + ' 笔 · ' + b + ' 块 · ' + e + ' 连线\n\n继续？';
    if (!window.confirm(msg)) return;

    sheets = list.map(function (s) { s.undo = []; return s; });
    active = Math.max(0, Math.min(sheets.length - 1, parsed.active | 0));
    loadSheet(active);
    Flow.Store.clearSheets();          // 清掉旧存档（含 v1/v2 迁移键）
    flushSave();
    setTimeout(fitView, 80);
    showStatus('已导入 ' + sheets.length + ' 页 · ' + n + ' 笔 · ' + b + ' 块 · ' + e + ' 连线', 5200);
  }

  function importFile(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var text = String(reader.result || '');
      try {
        if (looksLikeExcalidraw(file.name, text)) {
          importExcalidrawAsSheet(Flow.Store.parseExcalidraw(text), file.name);
        } else {
          importProject(Flow.Store.parseProject(text), file.name);
        }
      } catch (err) {
        showStatus('导入失败：' + ((err && err.message) || '无法解析这个文件'), 5000);
      }
    };
    reader.onerror = function () { showStatus('读取文件失败', 3600); };
    reader.readAsText(file);
  }

  if (fileInput) {
    fileInput.addEventListener('change', function () {
      if (fileInput.files && fileInput.files[0]) importFile(fileInput.files[0]);
      fileInput.value = '';                 // 允许重复导入同一个文件
    });
  }

  /* ── 导出菜单 ───────────────────────────────────────────── */

  function openExportMenu() {
    if (!exportMenu || !exportBtn) return;
    exportMenu.classList.add('on');
    exportBtn.setAttribute('aria-expanded', 'true');

    // 水平对齐到按钮中心，并夹在视口内，免得靠边时被切掉
    var r = exportBtn.getBoundingClientRect();
    var half = exportMenu.offsetWidth / 2 || 118;
    var cx = Math.max(half + 10, Math.min(window.innerWidth - half - 10, r.left + r.width / 2));
    exportMenu.style.left = Math.round(cx) + 'px';

    // 垂直方向浮在**整个工具条**之上（只对齐按钮的话会压住工具条本身）
    var bar = toolbar ? toolbar.getBoundingClientRect() : r;
    exportMenu.style.bottom = Math.round(window.innerHeight - bar.top + 16) + 'px';
  }

  function closeExportMenu() {
    if (!exportMenu) return;
    exportMenu.classList.remove('on');
    if (exportBtn) exportBtn.setAttribute('aria-expanded', 'false');
  }

  function toggleExportMenu() {
    if (exportMenu && exportMenu.classList.contains('on')) closeExportMenu();
    else openExportMenu();
  }

  function isExportMenuOpen() {
    return !!(exportMenu && exportMenu.classList.contains('on'));
  }

  if (exportMenu) {
    exportMenu.addEventListener('click', function (e) {
      var item = e.target.closest ? e.target.closest('button[data-export]') : null;
      if (!item) return;
      closeExportMenu();
      var kind = item.getAttribute('data-export');
      if (kind === 'png') exportPNG();
      else if (kind === 'excalidraw') exportExcalidraw();
      else if (kind === 'project') saveProject();
    });

    // 点菜单外面就收起来（捕获阶段，免得被下面的画布/字块先吃掉）
    window.addEventListener('pointerdown', function (e) {
      if (!isExportMenuOpen()) return;
      if (exportMenu.contains(e.target)) return;
      if (exportBtn && exportBtn.contains(e.target)) return;
      closeExportMenu();
    }, true);
  }

  var dragDepth = 0;
  window.addEventListener('dragenter', function (e) {
    e.preventDefault();
    dragDepth++;
    if (state === 'board') document.body.classList.add('dropping');
  });
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('dragleave', function (e) {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) document.body.classList.remove('dropping');
  });
  window.addEventListener('drop', function (e) {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dropping');
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    if (state !== 'board') setMode('board');
    importFile(f);
  });

  /* ── 工具条 ─────────────────────────────────────────────── */

  if (toolbar) {
    toolbar.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('button') : null;
      if (!btn) return;
      var act = btn.getAttribute('data-tool');
      var ink = btn.getAttribute('data-ink');
      var vw = window.innerWidth, vh = window.innerHeight;

      if (ink !== null) { setInk(Number(ink)); return; }

      switch (act) {
        case 'select':
          setTool('select');
          break;
        case 'pen':
          if (tool === 'pen') {
            var w = board.cycleWidth();
            showStatus('笔宽 ' + w.width.toFixed(1) + ' px');
          } else {
            setTool('pen');
          }
          break;
        case 'eraser':
          setTool('eraser');
          break;
        case 'text':
          setTool('text');
          blocks.addBlockAtCenter();
          break;
        case 'strike':
          toggleStrike();
          break;
        case 'undo':
          doUndo();
          break;
        case 'clear':
          if (!board.count() && !blocks.blockCount()) { showStatus('本来就是空的'); break; }
          if (window.confirm('清空「' + sheets[active].name + '」这一页的笔迹和字块？\n\n' +
              '（其他页不受影响；此操作不可撤销）')) {
            board.clear();
            blocks.clearAll();
            blocks.importUndo([]);
            camera.reset();
            flushSave();
            showStatus('已清空「' + sheets[active].name + '」');
          }
          break;

        case 'zoom-in': camera.zoomCenter(1.25, vw, vh); break;
        case 'zoom-out': camera.zoomCenter(1 / 1.25, vw, vh); break;
        case 'zoom-reset': camera.reset(); showStatus('视图已重置为 100%'); break;
        case 'zoom-fit': fitView(); break;

        case 'import': if (fileInput) fileInput.click(); break;
        case 'export': toggleExportMenu(); break;

        case 'exit':
          setMode('water');
          break;
      }
    });
  }

  /* ── 快捷键 ─────────────────────────────────────────────── */

  /* 工具与颜色的数字快捷键。
     用 e.code（Digit1…）而不是 e.key：Shift+1 的 e.key 是 "!"，按不出数字。
     Numpad 也一起支持。 */
  var TOOL_BY_CODE = {
    Digit1: 'select', Digit2: 'pen', Digit3: 'eraser', Digit4: 'text',
    Numpad1: 'select', Numpad2: 'pen', Numpad3: 'eraser', Numpad4: 'text'
  };
  var INK_BY_CODE = {
    Digit1: 0, Digit2: 1, Digit3: 2,
    Numpad1: 0, Numpad2: 1, Numpad3: 2
  };

  function isTyping() {
    var el = document.activeElement;
    if (!el) return false;
    var tag = (el.tagName || '').toLowerCase();
    return !!el.isContentEditable || tag === 'input' || tag === 'textarea' || tag === 'select';
  }

  window.addEventListener('keydown', function (e) {
    var k = (e.key || '').toLowerCase();
    var vw = window.innerWidth, vh = window.innerHeight;

    // 正在输入文字：一个快捷键都不抢
    if (isTyping()) {
      if (k === 'escape') {
        e.preventDefault();
        if (document.activeElement.blur) document.activeElement.blur();
      }
      return;
    }

    // 按住空格 = 临时抓手
    if (e.code === 'Space' && state === 'board') {
      if (!spaceDown) {
        spaceDown = true;
        document.body.classList.add('pan-ready');
      }
      e.preventDefault();
      return;
    }

    if (e.ctrlKey || e.metaKey) {
      if (state !== 'board') return;
      if (k === 'z') { doUndo(); e.preventDefault(); return; }
      if (k === 'a') { selectAll(); e.preventDefault(); return; }   // 全选（否则会被浏览器选走文字）
      if (k === '=' || k === '+') { camera.zoomCenter(1.25, vw, vh); e.preventDefault(); return; }
      if (k === '-') { camera.zoomCenter(1 / 1.25, vw, vh); e.preventDefault(); return; }
      if (k === '0') { camera.reset(); e.preventDefault(); return; }
      // 翻页：和 Excel 一致的 Ctrl+PageUp / Ctrl+PageDown
      if (e.key === 'PageDown') {
        if (active < sheets.length - 1) switchSheet(active + 1);
        else addSheet();
        e.preventDefault();
        return;
      }
      if (e.key === 'PageUp') {
        if (active > 0) switchSheet(active - 1);
        e.preventDefault();
        return;
      }
      return;
    }
    if (e.altKey) return;

    // 数字键：1~4 切工具（用 e.code 而不是 e.key —— Shift+1 的 e.key 是 "!"）
    if (state === 'board') {
      var code = e.code || '';
      if (e.shiftKey) {
        var ink = INK_BY_CODE[code];
        if (ink != null) { setInk(ink); e.preventDefault(); return; }
        // Shift+X：删除线（X 是文字工具，同键位加 Shift 就是"划掉"）
        if (code === 'KeyX') { toggleStrike(); e.preventDefault(); return; }
      } else {
        var toolByKey = TOOL_BY_CODE[code];
        if (toolByKey) { setTool(toolByKey); e.preventDefault(); return; }
      }
    }

    switch (k) {
      case 'b': toggleMode(); e.preventDefault(); break;
      case 'escape':
        if (isExportMenuOpen()) { closeExportMenu(); }
        else if (blocks.hasSelection() || strokeSel.length) { clearSelection(); }
        else if (state === 'board') { setMode('water'); }
        e.preventDefault();
        break;
      case 'delete':
      case 'backspace':
        if (state === 'board' && (blocks.hasSelection() || strokeSel.length)) {
          var removed = blocks.deleteSelected();
          var ns = strokeSel.length ? board.removeStrokes(strokeSel) : 0;
          clearSelection();
          showStatus('已删除 ' + (removed + ns) + ' 项（可 Ctrl+Z 撤销）');
          e.preventDefault();
        }
        break;
      case 'm': toggleMute(); e.preventDefault(); break;
      case 'f': toggleFullscreen(); e.preventDefault(); break;
      case 't': toggleClock(); e.preventDefault(); break;
      case 'h':
        manualHidden = !manualHidden;
        autoHidden = false;
        applyHidden();
        e.preventDefault();
        break;
      case 's': cyclePreset(); e.preventDefault(); break;
      case 'v': if (state === 'board') setTool('select'); break;
      case 'p': if (state === 'board') setTool('pen'); break;
      case 'e': if (state === 'board') setTool('eraser'); break;
      case 'x': if (state === 'board') setTool('text'); break;
      case 'u': if (state === 'board') doUndo(); break;
      case 'a':
        if (state === 'board') { selectAll(); e.preventDefault(); }
        break;
      case '0': if (state === 'board') { camera.reset(); showStatus('视图已重置为 100%'); } break;
      case '-': case '_':
        if (state === 'board') { camera.zoomCenter(1 / 1.25, vw, vh); e.preventDefault(); }
        break;
      case '=': case '+':
        if (state === 'board') { camera.zoomCenter(1.25, vw, vh); e.preventDefault(); }
        break;
    }
  });

  /* 界面上的文字按钮 */
  document.querySelectorAll('#ui [data-act]').forEach(function (b) {
    b.addEventListener('click', function () {
      var act = b.getAttribute('data-act');
      if (act === 'board') toggleMode();
      else if (act === 'clock') toggleClock();
      else if (act === 'preset') cyclePreset();
      else if (act === 'mute') toggleMute();
      else if (act === 'hide') { manualHidden = true; autoHidden = false; applyHidden(); }
    });
  });

  /* ── 进入 ───────────────────────────────────────────────── */

  function burst() {
    var w = window.innerWidth, h = window.innerHeight;
    water.drop(w * 0.5, h * 0.52, 0.045);
    setTimeout(function () { water.drop(w * 0.42, h * 0.6, 0.028); }, 260);
  }

  function enter(withSound) {
    if (gate) gate.classList.add('gone');
    water.start();
    burst();
    if (withSound) {
      audio.unlock().then(function (ok) {
        if (!ok) {
          showStatus(audio.lastError === 'Web Audio unavailable'
            ? '这个浏览器不支持 Web Audio' : '音频没能启动', 3600);
        }
      });
    }
  }

  if (gateBtn) gateBtn.addEventListener('click', function () { enter(true); });

  /* 恢复偏好 */
  if (typeof prefs.volume === 'number') {
    audio.volume = prefs.volume;
    volumeInput.value = String(Math.round(prefs.volume * 100));
  }
  if (prefs.muted) audio.muted = true;
  if (prefs.preset) applyPreset(prefs.preset, true);
  if (typeof prefs.ink === 'number') {
    board.setInk(prefs.ink);
    blocks.setColor(prefs.ink);
    document.querySelectorAll('.swatches .sw').forEach(function (b) {
      b.classList.toggle('on', Number(b.getAttribute('data-ink')) === prefs.ink);
    });
  }

  if ('ontouchstart' in window || (navigator.maxTouchPoints || 0) > 0) {
    document.body.classList.add('is-touch');
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) audio.suspend();
    else if (audio.ready) audio.resume();
  });

  /* 启动 */
  setTool(tool, true);                  // 让工具条一开始就正确高亮文字工具
  water.start();

  // 关掉 / 切走页面前把还没到防抖时间的改动落地
  window.addEventListener('pagehide', function () { flushSave(); });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) flushSave();
  });

  if (AUTO) {
    if (gate) { gate.style.transition = 'none'; gate.style.display = 'none'; }
    burst();
  }
  if (START_BOARD) setMode('board');

  /* 深链：?hour=12 或 ?hour=18.5 —— 直接把湖面时间钉在某个时刻（也用于自动化截图） */
  var hourParam = parseFloat(params.get('hour'));
  if (isFinite(hourParam)) {
    setSunManual(((hourParam % 24) + 24) % 24 * 60, true);
  }

  /* 深链缩放：?zoom=1.6 —— 在 demo 之后施加，便于对比同一构图放大后的样子 */
  var zoomParam = parseFloat(params.get('zoom'));
  if (isFinite(zoomParam) && zoomParam > 0) {
    setMode('board');
    setTimeout(function () {
      camera.zoomAt(window.innerWidth / 2, window.innerHeight / 2, zoomParam);
    }, 700);
  }

  /* 多页演示 / 验证：?sheets=3 建三页，?sheet=2 选中第 3 页（0 基） */
  var sheetsParam = parseInt(params.get('sheets'), 10);
  if (isFinite(sheetsParam) && sheetsParam > 1) {
    setMode('board');
    setTimeout(function () {
      syncActiveSheet();
      stashUndo();
      var want = Math.min(sheetsParam, 12);
      while (sheets.length < want) {
        var idx = sheets.length;
        var s = Flow.Store.sanitizeSheet({
          id: Flow.Store.newSheetId(),
          name: '页 ' + (idx + 1),
          blocks: [
            { id: 'd' + idx + 'a', x: 420, y: 240 + idx * 30, text: '第 ' + (idx + 1) + ' 页\n这里是独立内容', color: idx % 3 },
            { id: 'd' + idx + 'b', x: 760, y: 220 + idx * 30, text: '只有这一页才有', color: (idx + 1) % 3 }
          ],
          edges: [{ id: 'de' + idx, from: 'd' + idx + 'a', to: 'd' + idx + 'b' }]
        });
        s.undo = [];
        sheets.push(s);
      }
      var target = parseInt(params.get('sheet'), 10);
      loadSheet(isFinite(target) ? target : 0);
      flushSave();
      setTimeout(fitView, 60);
      showStatus('演示：' + sheets.length + ' 页，当前「' + sheets[active].name + '」', 6000);
    }, 300);
  }

  /* 深链：?select=1 演示框选效果（选中若干字块与笔迹，并画出框选矩形） */
  if (params.get('select') === '1') {
    setMode('board');
    setTool('pen', true);          // 先用画笔把那一笔合成出来（选择工具下是画不了的）
    setTimeout(function () {
      function sev(type, x, y) {
        return new PointerEvent(type, {
          clientX: x, clientY: y, pointerId: 9, isPrimary: true,
          pressure: 0.6, bubbles: true, cancelable: true, pointerType: 'pen'
        });
      }
      var cx = Math.round(window.innerWidth / 2), cy = Math.round(window.innerHeight / 2);
      [[-260, 120], [-170, 60], [-80, 130], [10, 70]].forEach(function (p, i, arr) {
        if (i === 0) boardLive.dispatchEvent(sev('pointerdown', cx + p[0], cy + p[1]));
        else boardLive.dispatchEvent(sev('pointermove', cx + p[0], cy + p[1]));
        if (i === arr.length - 1) boardLive.dispatchEvent(sev('pointerup', cx + p[0], cy + p[1]));
      });

      setTool('select', true);     // 再切到选择工具
      var b1 = blocks.addBlock(cx - 150, cy - 90, '被框选中的块');
      var b2 = blocks.addBlock(cx + 120, cy - 40, '一起移动');
      blocks.addEdge(b1.id, b2.id);
      blocks.selectAll();
      strokeSel = board.getStrokes().slice();
      board.setHighlight(strokeSel);
      blocks.render();

      marquee = { x0: cx - 330, y0: cy - 200, x1: cx + 300, y1: cy + 210 };
      updateMarqueeBox();
      showMarquee();
      showStatus('框选演示：' + (blocks.selectionCount() + strokeSel.length) + ' 项被选中', 8000);
    }, 300);
  }

  /* 深链：?strike=1 演示删除线（划掉一块，用于截图与肉眼确认） */
  if (params.get('strike') === '1') {
    setMode('board');
    setTimeout(function () {
      var cx = Math.round(window.innerWidth / 2), cy = Math.round(window.innerHeight / 2);
      var done = blocks.addBlock(cx - 170, cy - 60, '已经做完的事');
      blocks.addBlock(cx + 170, cy - 60, '还没做的');
      blocks.toggleSelection('block', done.id);
      blocks.setStrike(1);
      blocks.clearSelection();
      showStatus('删除线演示：划掉的那块可 Ctrl+Z 撤销', 6000);
    }, 300);
  }

  /* 深链：?menu=1 直接展开导出菜单（也用于自动化截图） */
  if (params.get('menu') === '1') {
    setMode('board');
    setTimeout(function () {
      openExportMenu();
      showStatus('导出菜单（?menu=1 深链）', 6000);
    }, 400);
  }

  /* 自检用：合成指针事件画几笔 + 建几个字块，走的是真实代码路径 */
  if (DEMO) {
    setMode('board');
    setTimeout(function () {
      function ev(type, x, y) {
        return new PointerEvent(type, {
          clientX: x, clientY: y, pointerId: 1, isPrimary: true,
          pressure: 0.6, bubbles: true, cancelable: true, pointerType: 'pen'
        });
      }
      var cx = Math.round(window.innerWidth / 2);
      var cy = Math.round(window.innerHeight / 2);
      var paths = [
        [[-420, 150], [-330, 70], [-240, 160], [-150, 70], [-60, 160]],
        [[-400, 230], [-290, 300], [-180, 230], [-70, 300]]
      ];
      paths.forEach(function (path) {
        boardLive.dispatchEvent(ev('pointerdown', cx + path[0][0], cy + path[0][1]));
        path.forEach(function (p) { boardLive.dispatchEvent(ev('pointermove', cx + p[0], cy + p[1])); });
        var lastP = path[path.length - 1];
        boardLive.dispatchEvent(ev('pointerup', cx + lastP[0], cy + lastP[1]));
      });

      var b1 = blocks.addBlock(cx - 150, cy - 60, '飘过的念头\n先写下来');
      var b2 = blocks.addBlock(cx + 170, cy - 140, '然后呢？');
      var b3 = blocks.addBlock(cx + 180, cy + 40, '交给明天的自己');
      blocks.addEdge(b1.id, b2.id);
      blocks.addEdge(b1.id, b3.id);
      blocks.render();
      showStatus('demo · 字块 ' + blocks.blockCount() + ' · 连线 ' + blocks.edgeCount(), 6000);
    }, 260);
  }

  if (DEBUG) {
    var frames = 0, t0 = performance.now();
    (function loop() {
      frames++;
      var el = performance.now() - t0;
      if (el > 1000) {
        showStatus('fps ' + Math.round(frames * 1000 / el) + ' · q ' + water.quality.toFixed(2) +
          ' · ' + (water.isFallback ? '2D' : 'GL'), 1200);
        frames = 0; t0 = performance.now();
      }
      requestAnimationFrame(loop);
    })();
  }

  /* 自检模式：?selfcheck=1
     在页面内构造一份 .excalidraw，走完整的「解析 → 替换 → 重绘 → 适应视图」链路，
     把结果写进 document.title，便于用 --dump-dom 读取验证。 */
  if (params.get('selfcheck') === '1') {
    try {
      var doc = {
        type: 'excalidraw', version: 2, source: 'selfcheck',
        elements: [
          { id: 'f1', type: 'freedraw', x: 600, y: 420, strokeColor: '#9fe8e0', strokeWidth: 2,
            points: [[0, 0], [40, 30], [80, 0], [120, 40]] },
          { id: 'r1', type: 'rectangle', x: 400, y: 300, width: 170, height: 46 },
          { id: 't1', type: 'text', x: 413, y: 309, width: 140, height: 22, text: '导入的方块', containerId: 'r1' },
          { id: 'r2', type: 'rectangle', x: 700, y: 520, width: 150, height: 46 },
          { id: 't2', type: 'text', x: 713, y: 529, width: 130, height: 22, text: '另一个', containerId: 'r2' },
          { id: 'a1', type: 'arrow', x: 570, y: 323, width: 130, height: 220,
            points: [[0, 0], [130, 220]],
            startBinding: { elementId: 'r1' }, endBinding: { elementId: 'r2' } },
          { id: 'a2', type: 'arrow', x: 3000, y: 3000, width: 50, height: 0, points: [[0, 0], [50, 0]] }
        ]
      };
      var parsed = Flow.Store.parseExcalidraw(JSON.stringify(doc));
      board.replaceStrokes(parsed.strokes);
      blocks.replaceAll(parsed.blocks, parsed.edges);
      fitView();

      var out = {
        s: parsed.strokes.length,
        b: parsed.blocks.length,
        e: parsed.edges.length,
        skipped: parsed.stats ? parsed.stats.skippedArrows : -1,
        nodes: document.querySelectorAll('#nodes .node').length,
        edgePaths: document.querySelectorAll('#edge-layer path').length,
        text0len: String(parsed.blocks[0] && parsed.blocks[0].text).length,
        blockRows: board.count(),
        zoom: camera.scale.toFixed(2)
      };

      /* 多页自检：验证切换后内容不串页、不丢内容 */
      var sheetsBefore = sheets.length;
      syncActiveSheet();
      stashUndo();
      addSheet();                                   // 新页应为空
      out.afterAddNodes = document.querySelectorAll('#nodes .node').length;
      out.afterAddRows = board.count();
      out.sheetCount = sheets.length;

      blocks.addBlock(500, 400, '第二页的块');
      board.drop && 0;
      switchSheet(0);                               // 切回第一页，内容必须还在
      out.backNodes = document.querySelectorAll('#nodes .node').length;
      out.backRows = board.count();
      out.backText0 = String((blocks.getBlocks()[0] || {}).text).length;
      out.active = active;
      out.page1Name = sheets[0].name;
      out.page2Name = sheets[1].name;
      out.page2Nodes = sheets[1].blocks.length;
      out.before = sheetsBefore;

      // 持久化往返：存下来再读回来，看多页是否都还在
      flushSave();
      var reload = Flow.Store.loadSheets();
      out.reloadSheets = reload.sheets.length;
      out.reloadA0 = reload.sheets[0].blocks.length;
      out.reloadA0Rows = reload.sheets[0].strokes.length;

      /* 数字键切工具自检：1~4 切工具、Shift+1~3 切颜色。
         Shift+1 的 e.key 是 "!"，所以这里故意把 key 传成 "!"，
        用来证明实现读的是 e.code 而不是 e.key。 */
      function kev(code, keyChar, shift) {
        return new KeyboardEvent('keydown', {
          code: code, key: keyChar, shiftKey: !!shift,
          bubbles: true, cancelable: true
        });
      }
      setMode('board');
      window.dispatchEvent(kev('Digit1', '1', false));
      out.key1 = tool;
      window.dispatchEvent(kev('Digit4', '4', false));
      out.key4 = tool;
      window.dispatchEvent(kev('Digit3', '3', false));
      out.key3 = tool;
      window.dispatchEvent(kev('Digit2', '2', false));
      out.key2 = tool;
      window.dispatchEvent(kev('Digit1', '!', true));      // Shift+1 → 颜色，不是工具
      out.shift1Ink = board.getInk();
      out.shift1KeptTool = tool;
      window.dispatchEvent(kev('Digit3', '#', true));
      out.shift3Ink = board.getInk();
      setInk(0);

      /* 删除线自检：Shift+X 走真实快捷键路径，验模型 / DOM 类 / 二次切换 / 撤销。
         注意这里必须选中块之后才按——没选中时会走"提示"分支，什么都不会变。 */
      var sb = blocks.addBlock(640, 320, '划掉我');
      var strikeOf = function (id) {
        var hit = blocks.getBlocks().filter(function (x) { return x.id === id; })[0];
        return hit ? (hit.strike | 0) : -1;
      };
      blocks.toggleSelection('block', sb.id);
      window.dispatchEvent(kev('KeyX', 'X', true));      // Shift+X → 划掉
      var sbEl = document.querySelector('#nodes .node[data-id="' + sb.id + '"]');
      out.strikeOn = strikeOf(sb.id) === 1;
      out.strikeClass = !!(sbEl && sbEl.classList.contains('strike'));
      window.dispatchEvent(kev('KeyX', 'X', true));      // 已全划上 → 再按一次全取消
      out.strikeOff = strikeOf(sb.id) === 0;
      window.dispatchEvent(kev('KeyX', 'X', true));      // 再划上，然后撤销
      doUndo();
      out.strikeUndo = strikeOf(sb.id) === 0;
      blocks.toggleSelection('block', sb.id);            // 取消选中，别影响后面的断言

      /* 窗口尺寸变化不得改动块的场景坐标。
         这里用"相机放大"等价缩小可视范围（visibleRange 同时依赖窗口和相机），
         再派发真实的 resize 事件。
         原 bug：resize 时有个 reclamp() 把超出可视范围的块夹回边界，于是把
         浏览器贴到屏幕半边时，所有落在范围外的块会叠到边上挤成一堆。 */
      var rclBlock = blocks.addBlock(500, 400, '不该被移动');
      var coordOf = function () {
        return blocks.getBlocks().map(function (b) {
          return Math.round(b.x) + ',' + Math.round(b.y);
        }).join('|');
      };
      var coordsBefore = coordOf();
      var zoomWas2 = camera.scale;
      camera.set(camera.x, camera.y, 3);        // 放大 3 倍 → 可视场景范围缩小
      window.dispatchEvent(new Event('resize'));
      var coordsAfter = coordOf();
      out.resizeKeepsCoords = coordsAfter === coordsBefore;
      // 顺带确认这块确实落到了可视范围外（否则这条断言是空转）
      out.resizeBlockOutsideView =
        rclBlock.x < camera.toSceneX(0) || rclBlock.x > camera.toSceneX(window.innerWidth) ||
        rclBlock.y < camera.toSceneY(0) || rclBlock.y > camera.toSceneY(window.innerHeight);
      camera.set(camera.x, camera.y, zoomWas2);

      /* 快捷键提示的位置自检：必须在工具条下方、分页标签上方，三者不重叠。

         这里**不能**用 getBoundingClientRect 比较：工具条是靠 CSS 过渡从屏外
         滑上来的，setMode('board') 之后立刻测量拿到的是过渡起点的旧位置
         （一度算出 -53px 的假重叠）。改用不参与过渡的 bottom 计算值来算，
         全部以「距视口底部」为基准，与过渡和 rAF 都无关。 */
      var hintEl = $('keys-hint');
      var sheetsEl = $('sheets');
      if (hintEl && toolbar && sheetsEl) {
        setMode('board');
        out.hintInBoardMode = document.body.classList.contains('mode-board');
        var hb = parseFloat(getComputedStyle(hintEl).bottom) || 0;   // 提示下边缘距底
        var hh = hintEl.offsetHeight;
        var tb = parseFloat(getComputedStyle(toolbar).bottom) || 0;  // 工具条下边缘距底
        var sb = sheetsEl.offsetHeight;                              // 分页标签高度
        out.hintGapAbove = Math.round(tb - (hb + hh));   // >0 = 提示上边缘在工具条下方
        out.hintGapBelow = Math.round(hb - sb);          // >0 = 提示下边缘在标签上方
        out.hintBelowToolbar = out.hintGapAbove > 0;
        out.hintAboveSheets = out.hintGapBelow > 0;
        out.hintShownInBoard = getComputedStyle(hintEl).visibility === 'visible';
        out.hintPointerNone = getComputedStyle(hintEl).pointerEvents === 'none';
      }

      /* 连线可见性自检：SVG 的裁剪区域必须恒等于窗口。
         如果相机变换打在 <svg> 元素上，元素视口会被一起缩放——
         缩小时裁剪区域小于窗口，连线就只剩中间一段可见（真实踩过，已用最小
         SVG 实验确认：scale(0.3) 时 getBoundingClientRect 变成窗口的 30%）。
         注意：camera.set 触发的重绘是 rAF 节流的，这里必须同步调一次
         viewChanged，否则测到的是"变换还没应用"的旧状态（这个竞态让本断言
         一度两种情况下都通过，等于没测）。 */
      var edgesEl = $('edges');
      if (edgesEl) {
        var zoomSaved = camera.scale;
        camera.set(0, 0, 0.5);                       // 缩小到 50% 最能暴露问题
        board.viewChanged();
        blocks.viewChanged();                        // 同步应用，别等 rAF
        var er = edgesEl.getBoundingClientRect();
        out.svgClipW = Math.round(er.width);
        out.svgClipH = Math.round(er.height);
        out.svgClipCoversWindow =
          er.width >= window.innerWidth - 1 && er.height >= window.innerHeight - 1;
        var ec = $('edge-camera');
        out.edgeCamHasTransform = !!(ec && /scale\(/.test(ec.getAttribute('transform') || ''));
        camera.set(0, 0, zoomSaved);
        board.viewChanged();
        blocks.viewChanged();
      }

      /* 导出菜单自检：能打开、项数对、不压住工具条、且被夹在视口内。
         注意必须先切到白板模式——水面下工具条是隐藏的（位置在屏幕外），
         拿它做基准等于没测。 */
      if (exportBtn && exportMenu) {
        setMode('board');
        exportBtn.click();
        out.menuOpen = isExportMenuOpen();
        out.menuItems = exportMenu.querySelectorAll('button[data-export]').length;
        var mr = exportMenu.getBoundingClientRect();
        var tr = toolbar.getBoundingClientRect();
        out.menuInView = mr.left >= 0 && mr.right <= window.innerWidth &&
          mr.top >= 0 && mr.bottom <= window.innerHeight;
        out.menuGap = Math.round(tr.top - mr.bottom);      // >0 表示没压住工具条
        out.menuOverlapBar = mr.bottom > tr.top;
        out.expanded = exportBtn.getAttribute('aria-expanded');
        closeExportMenu();
        out.menuClosed = !isExportMenuOpen();
        out.expandedAfter = exportBtn.getAttribute('aria-expanded');
        out.toolbarBtns = document.querySelectorAll('#toolbar button').length;
      }

      /* 全屏按钮自检：贴在右下角，且**两种模式下都点得到**。
         这是它被放在 #ui 外面的原因——#ui 的 z-index(6) 低于分页标签(7)，
         而分页标签铺满底部且 pointer-events: auto，放在里面会被拦走点击。
         所以必须用 elementFromPoint 验一遍，光看坐标不算数。 */
      var fsB = $('fs-btn');
      if (fsB) {
        var fr = fsB.getBoundingClientRect();
        var fcx = fr.left + fr.width / 2, fcy = fr.top + fr.height / 2;
        var fsHit = function () {
          var el = document.elementFromPoint(fcx, fcy);
          return !!(el && (el === fsB || fsB.contains(el)));
        };
        setMode('water');
        out.fsHitWater = fsHit();
        setMode('board');
        out.fsHitBoard = fsHit();
        out.fsInView = fr.left >= 0 && fr.top >= 0 &&
          fr.right <= window.innerWidth && fr.bottom <= window.innerHeight;
        out.fsCornerOffset = Math.round(window.innerWidth - fr.right) + 'x' +
          Math.round(window.innerHeight - fr.bottom);   // 距右下角的距离
        out.fsIconExpand = getComputedStyle(fsB.querySelector('.fs-icon-expand')).display !== 'none';
        // 按 F 不应抛出未捕获异常（headless 下 requestFullscreen 可能被拒）
        var fsErrBefore = (window.Flow.__errors || []).length;
        window.dispatchEvent(new KeyboardEvent('keydown',
          { key: 'f', code: 'KeyF', bubbles: true, cancelable: true }));
        out.fsKeyErrors = (window.Flow.__errors || []).length - fsErrBefore;
        setMode('board');
      }

      /* 框选 + 整组移动自检：走真实代码路径（合成指针事件 + 直接调 API 各验一半） */
      setMode('board');
      setTool('select', true);
      var bA = blocks.addBlock(400, 300, 'A');
      var bB = blocks.addBlock(520, 320, 'B');
      var bC = blocks.addBlock(1200, 900, 'C');       // 故意放在框外
      blocks.render();

      // ① 框选：用合成指针事件在画布上拖一个矩形
      function pev(type, x, y) {
        return new PointerEvent(type, {
          clientX: x, clientY: y, pointerId: 7, isPrimary: true, button: 0,
          bubbles: true, cancelable: true, pointerType: 'mouse'
        });
      }
      var m0 = { x: camera.toScreenX(340), y: camera.toScreenY(240) };
      var m1 = { x: camera.toScreenX(600), y: camera.toScreenY(400) };
      boardLive.dispatchEvent(pev('pointerdown', m0.x, m0.y));
      window.dispatchEvent(pev('pointermove', (m0.x + m1.x) / 2, (m0.y + m1.y) / 2));
      window.dispatchEvent(pev('pointermove', m1.x, m1.y));
      out.marqueeVisible = !!(marqueeEl && marqueeEl.classList.contains('on'));
      window.dispatchEvent(pev('pointerup', m1.x, m1.y));
      out.marqueeClosed = !(marqueeEl && marqueeEl.classList.contains('on'));
      out.selBlocks = blocks.selectionCount();
      out.selIds = blocks.selectedBlockIds().sort().join(',');
      out.pickedAB = blocks.isSelected('block', bA.id) && blocks.isSelected('block', bB.id);
      out.excludedC = !blocks.isSelected('block', bC.id);

      // ② 整组移动：直接调 blocks 的移动 API（等价于拖动其中一块）
      var before = { ax: bA.x, ay: bA.y, bx: bB.x, by: bB.y };
      blocks.beginMove();
      var d = blocks.clampMove(60, 40);
      blocks.moveBy(d.dx, d.dy);
      blocks.endMove();
      out.moveDX = Math.round(bA.x - before.ax);
      out.moveDY = Math.round(bA.y - before.ay);
      out.relativeKept = Math.round((bB.x - bA.x) - (before.bx - before.ax)) === 0;

      /* ②b 真实拖动手势：在字块元素上合成 pointerdown/move/up。
         这一段是补的教训——之前只测了「直接调 API」，而节点 pointerdown 里
         少写 api. 前缀导致裸调用 beginMove()，一拖就 ReferenceError，
         字块完全拖不动。API 调用是好的，手势路径却没人走。 */
      var errBefore = (window.Flow.__errors || []).length;
      var nodeEl = document.querySelector('#nodes .node');
      if (nodeEl) {
        var dragId = nodeEl.getAttribute('data-id');
        var selSet = {};
        blocks.selectedBlockIds().forEach(function (id) { selSet[id] = true; });
        // 快照：选中的应该跟着走，没选的一个像素都不该动
        var snap0 = blocks.getBlocks().map(function (b) {
          return { b: b, x: b.x, y: b.y, sel: !!selSet[b.id] };
        });
        var bDrag = null;
        snap0.forEach(function (r) { if (r.b.id === dragId) bDrag = r.b; });
        var rect0 = nodeEl.getBoundingClientRect();
        var pdx = rect0.left + rect0.width / 2, pdy = rect0.top + rect0.height / 2;
        var gx0 = bDrag.x, gy0 = bDrag.y;

        nodeEl.dispatchEvent(pev('pointerdown', pdx, pdy));
        window.dispatchEvent(pev('pointermove', pdx + 80, pdy + 55));
        window.dispatchEvent(pev('pointerup', pdx + 80, pdy + 55));

        out.gestureDX = Math.round(bDrag.x - gx0);
        out.gestureDY = Math.round(bDrag.y - gy0);
        out.gestureMoved = out.gestureDX !== 0 || out.gestureDY !== 0;
        out.gestureDragWasSelected = !!selSet[dragId];
        // 选中的其他块：应与被拖块位移一致
        out.gestureSelectedFollowed = snap0
          .filter(function (r) { return r.sel && r.b.id !== dragId; })
          .every(function (r) {
            return Math.round(r.b.x - r.x) === out.gestureDX &&
                   Math.round(r.b.y - r.y) === out.gestureDY;
          });
        // 没选中的块：必须原地不动
        out.gestureUnselectedStayed = snap0
          .filter(function (r) { return !r.sel; })
          .every(function (r) { return r.b.x === r.x && r.b.y === r.y; });
        out.gestureErrors = (window.Flow.__errors || []).length - errBefore;
      }

      // ③ 笔迹框选与高亮
      strokeSel = board.getStrokes().slice();
      board.setHighlight(strokeSel);
      out.hlStrokes = strokeSel.length;

      // ④ 删除选中（可撤销）
      var undoBefore = board.undoDepth();
      var delCount = board.removeStrokes(strokeSel);
      out.deleted = delCount;
      out.afterDelRows = board.count();
      board.undo();
      out.afterUndoRows = board.count();
      out.undoWorked = board.count() > 0;
      clearSelection();

      /* 时间拨码自检：形状必须是竖的，而且"拖动"要真的改变湖面时间。
         之前出过"HTML 是新的、CSS/JS 是旧的"这种缓存错配，
         表现就是拨码变成原生横条且拖不动——所以这两条必须断言。 */
      if (sunRange) {
        var sr = sunRange.getBoundingClientRect();
        out.sliderW = Math.round(sr.width);
        out.sliderH = Math.round(sr.height);
        out.sliderVertical = sr.height > sr.width * 3;         // 竖的：高远大于宽
        out.sliderStyled = getComputedStyle(sunRange).appearance === 'none' ||
          getComputedStyle(sunRange).webkitAppearance === 'none';

        setMode('water');                                      // 拨码只在水面下可见
        setSunAuto(true, true);
        out.autoBefore = sun.auto;
        // 模拟用户拖动：设值 + 派发 input
        sunRange.value = '360';                                // 06:00
        sunRange.dispatchEvent(new Event('input', { bubbles: true }));
        out.autoAfterDrag = sun.auto;                          // 拖动应切到手动
        out.manualMin = sun.manualMin;
        out.ariaAfterDrag = sunAuto ? sunAuto.getAttribute('aria-pressed') : '?';
      }

      document.title = 'SELFCHECK ' + Object.keys(out).map(function (k) {
        return k + '=' + out[k];
      }).join(' ');

      // 缓动需要时间，稍后再把"拖动后的最终状态"补进标题
      setTimeout(function () {
        var tail = ' dragTime=' + (sunTime ? sunTime.textContent : '?') +
          ' dragPhase=' + (sunPhase ? sunPhase.textContent : '?') +
          ' paletteHour=' + (Math.round(water.getPalette().hour * 100) / 100) +
          ' sunHour=' + (Math.round(sun.current * 100) / 100);
        document.title = document.title + tail;
      }, 1400);
    } catch (err) {
      document.title = 'SELFCHECK_FAIL ' + ((err && err.message) || err);
    }
  }

  /* 诊断：?probe=1
     在视口上打网格，报告每个点最上层接住事件的元素是谁。
     用来定位"文字工具只在中间一块区域有效"这类命中区域问题。 */
  if (params.get('probe')) {
    var probeTool = params.get('probe');
    setMode('board');
    setTool(probeTool === 'pen' || probeTool === 'eraser' ? probeTool : 'text');
    setTimeout(function () {
      function sig(el) {
        if (!el) return 'x';
        if (el.id === 'text-catch') return 'K';     // 文字工具接收层
        if (el.id === 'nodes') return 'N';
        if (el.closest && el.closest('.node')) return 'O';
        if (el.closest && el.closest('#toolbar')) return 'T';
        if (el.closest && el.closest('#ui')) {
          // 把到底是哪个 UI 元素报出来，避免留下看不见的死区
          var u = el.id ? '#' + el.id : (el.className ? '.' + String(el.className).split(' ')[0] : el.tagName);
          return 'U' + u.slice(0, 7);
        }
        if (el.id === 'board-live' || el.id === 'board') return 'C';
        if (el.id === 'edges' || (el.closest && el.closest('#edges'))) return 'E';
        if (el.id === 'water') return 'W';
        return '?' + (el.tagName || '?');
      }
      var cols = 9, rows = 5, lines = [];
      for (var r = 0; r < rows; r++) {
        var line = '';
        for (var c = 0; c < cols; c++) {
          var x = Math.round((c + 0.5) * window.innerWidth / cols);
          var y = Math.round((r + 0.5) * window.innerHeight / rows);
          line += sig(document.elementFromPoint(x, y));
        }
        lines.push(line);
      }
      var panel = document.querySelector('#panel-sound');
      var pv = panel ? getComputedStyle(panel).visibility : 'none';
      var pr = panel ? panel.getBoundingClientRect() : { top: 0, left: 0, right: 0, bottom: 0 };
      document.title = 'PROBE ' + lines.join('/') +
        ' cam=' + camera.x.toFixed(0) + ',' + camera.y.toFixed(0) + ',' + camera.scale.toFixed(2) +
        ' body=' + document.body.className +
        ' pv=' + pv.charAt(0) +
        ' pr=' + Math.round(pr.left) + ',' + Math.round(pr.top) + ',' +
        Math.round(pr.right) + ',' + Math.round(pr.bottom);
    }, 1100);
  }

  document.body.classList.remove('is-loading');

  /* 供自动化检查读取状态 */
  window.Flow.__state = function () {
    return {
      mode: state,
      tool: tool,
      gl: !water.isFallback,
      quality: water.quality,
      errors: errors,
      boardEnabled: board.enabled,
      strokes: board.count(),
      blocks: blocks.blockCount(),
      edges: blocks.edgeCount(),
      zoom: camera.scale,
      camX: camera.x,
      camY: camera.y,
      clockHidden: clockHidden,
      clock: lastClockText,
      sunAuto: sun.auto,
      sunHour: Math.round(sun.current * 100) / 100,
      sunPhase: Flow.Sun.palette(sun.current).name,
      sunBrightness: Math.round(Flow.Sun.brightness(sun.current) * 1000) / 1000,
      paletteHour: Math.round((water.getPalette().hour || 0) * 100) / 100,
      audioReady: audio.ready,
      preset: audio.preset,
      moves: window.__flowMoves || 0
    };
  };
})();
