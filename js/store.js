/* ============================================================
   store.js — 本地持久化与导出
   · localStorage：笔迹与偏好设置自动保存
   · 导出 PNG（所见即所得，深色底）
   · 导出 .excalidraw（实验性：可尝试直接拖进 Obsidian）
   ============================================================ */
(function () {
  'use strict';

  window.Flow = window.Flow || {};

  var KEY_SHEETS = 'flow.sheets.v3';     // 当前：多页
  var KEY_SCENE = 'flow.scene.v2';       // 旧：单页
  var KEY_SCENE_OLD = 'flow.board.v1';   // 更旧：只有笔迹
  var KEY_PREFS = 'flow.prefs.v1';
  var SOFT_LIMIT = 4 * 1024 * 1024;   // localStorage 通常 5MB，留点余量

  function safeGet(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }

  function safeSet(key, value) {
    try { window.localStorage.setItem(key, value); return true; }
    catch (e) { return false; }
  }

  function safeDel(key) {
    try { window.localStorage.removeItem(key); } catch (e) {}
  }

  /* ── 笔迹 ───────────────────────────────────────────────── */

  // 压缩存储：坐标保留一位小数，字段名缩短
  function packStrokes(strokes) {
    var out = [];
    for (var i = 0; i < strokes.length; i++) {
      var s = strokes[i];
      var pts = [];
      for (var j = 0; j < s.p.length; j++) {
        var p = s.p[j];
        pts.push([
          Math.round(p[0] * 10) / 10,
          Math.round(p[1] * 10) / 10,
          Math.round((p[2] || 0.5) * 100) / 100
        ]);
      }
      out.push({ c: s.c, w: Math.round(s.w * 100) / 100, e: s.e ? 1 : 0, p: pts });
    }
    return out;
  }

  function unpackStrokes(raw) {
    if (!raw || !raw.length) return [];
    return raw.map(function (s) {
      return {
        c: s.c || '#eaf2ff',
        w: s.w || 2,
        e: !!s.e,
        p: (s.p || []).map(function (p) { return [p[0], p[1], p[2] == null ? 1 : p[2]]; })
      };
    });
  }

  function loadScene() {
    var raw = safeGet(KEY_SCENE);
    if (raw) {
      try {
        var obj = JSON.parse(raw);
        return {
          strokes: unpackStrokes(obj && obj.strokes),
          blocks: (obj && obj.blocks) || [],
          edges: (obj && obj.edges) || []
        };
      } catch (e) { /* 落到下面的迁移分支 */ }
    }
    // 迁移上一版（只有笔迹）
    var old = safeGet(KEY_SCENE_OLD);
    if (old) {
      try {
        var legacy = JSON.parse(old);
        return { strokes: unpackStrokes(legacy && legacy.strokes), blocks: [], edges: [] };
      } catch (e) {}
    }
    return { strokes: [], blocks: [], edges: [] };
  }

  function sanitizeBlocks(list) {
    if (!list || !list.length) return [];
    return list.filter(function (b) {
      return b && typeof b.id === 'string' && isFinite(b.x) && isFinite(b.y);
    }).map(function (b) {
      return {
        id: b.id,
        x: Number(b.x),
        y: Number(b.y),
        text: String(b.text == null ? '' : b.text),
        color: b.color | 0,
        strike: b.strike ? 1 : 0
      };
    });
  }

  function sanitizeEdges(list, blocks) {
    if (!list || !list.length) return [];
    var ids = {};
    blocks.forEach(function (b) { ids[b.id] = 1; });
    return list.filter(function (e) {
      return e && typeof e.id === 'string' && ids[e.from] && ids[e.to] && e.from !== e.to;
    }).map(function (e) {
      return { id: e.id, from: e.from, to: e.to };
    });
  }

  function saveScene(scene) {
    var payload = {
      v: 2,
      t: Date.now(),
      strokes: packStrokes(scene.strokes || []),
      blocks: sanitizeBlocks(scene.blocks),
      edges: sanitizeEdges(scene.edges, sanitizeBlocks(scene.blocks))
    };
    var json = JSON.stringify(payload);
    if (json.length > SOFT_LIMIT) return { ok: false, reason: 'too-large', bytes: json.length };
    var ok = safeSet(KEY_SCENE, json);
    return { ok: ok, reason: ok ? '' : 'blocked', bytes: json.length };
  }

  function clearScene() {
    safeDel(KEY_SCENE);
    safeDel(KEY_SCENE_OLD);
  }

  /* ── 多页（sheet） ───────────────────────────────────────
     一页 = { id, name, strokes, blocks, edges }。
     v3 存档把多页存在一起；读到旧版本（v2 单页 / v1 只有笔迹）
     会自动迁移成"一页"，不会丢内容。
     ──────────────────────────────────────────────────────── */

  var SHEET_NAME_MAX = 24;

  function newSheetId() {
    return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function sanitizeSheet(s) {
    s = s || {};
    var blocks = sanitizeBlocks(s.blocks);
    var name = (typeof s.name === 'string' ? s.name : '').replace(/\s+/g, ' ').trim();
    return {
      id: (typeof s.id === 'string' && s.id) ? s.id : newSheetId(),
      name: name.slice(0, SHEET_NAME_MAX) || '页',
      strokes: unpackStrokes(s.strokes),
      blocks: blocks,
      edges: sanitizeEdges(s.edges, blocks)
    };
  }

  function clampIndex(i, len) {
    i = i | 0;
    if (!len) return 0;
    return i < 0 ? 0 : (i > len - 1 ? len - 1 : i);
  }

  // 存档与导出共用同一份序列化，保证"导出的文件一定能再导入"
  function serializeSheets(sheets, active) {
    return {
      v: 3,
      t: Date.now(),
      active: active | 0,
      sheets: (sheets || []).map(function (s) {
        var blocks = sanitizeBlocks(s.blocks);
        return {
          id: s.id,
          name: (typeof s.name === 'string' ? s.name : '').slice(0, SHEET_NAME_MAX) || '页',
          strokes: packStrokes(s.strokes || []),
          blocks: blocks,
          edges: sanitizeEdges(s.edges, blocks)
        };
      })
    };
  }

  function loadSheets() {
    var raw = safeGet(KEY_SHEETS);
    if (raw) {
      try {
        var obj = JSON.parse(raw);
        if (obj && obj.sheets && obj.sheets.length) {
          var list = obj.sheets.map(sanitizeSheet);
          return { sheets: list, active: clampIndex(obj.active, list.length) };
        }
      } catch (e) { /* 落到迁移分支 */ }
    }

    // v2：单页存在 flow.scene.v2
    var v2 = safeGet(KEY_SCENE);
    if (v2) {
      try {
        var o = JSON.parse(v2);
        return {
          sheets: [sanitizeSheet({ name: '页 1', strokes: o && o.strokes, blocks: o && o.blocks, edges: o && o.edges })],
          active: 0
        };
      } catch (e) {}
    }

    // v1：只有笔迹
    var v1 = safeGet(KEY_SCENE_OLD);
    if (v1) {
      try {
        var o1 = JSON.parse(v1);
        return { sheets: [sanitizeSheet({ name: '页 1', strokes: o1 && o1.strokes })], active: 0 };
      } catch (e) {}
    }

    return { sheets: [], active: 0 };   // 空 → 由 app 建第一页
  }

  function saveSheets(sheets, active) {
    var json = JSON.stringify(serializeSheets(sheets, active));
    if (json.length > SOFT_LIMIT) return { ok: false, reason: 'too-large', bytes: json.length };
    var ok = safeSet(KEY_SHEETS, json);
    return { ok: ok, reason: ok ? '' : 'blocked', bytes: json.length };
  }

  function clearSheets() {
    safeDel(KEY_SHEETS);
    safeDel(KEY_SCENE);
    safeDel(KEY_SCENE_OLD);
  }

  /* 工程文件导出/导入。接受三种形态：
     v3 多页 / v2 单页 / 带 strokes+blocks 的任意对象 */
  function toProjectJSON(sheets, active) {
    var doc = serializeSheets(sheets, active);
    doc.app = 'flow';
    doc.savedAt = new Date().toISOString();
    return JSON.stringify(doc, null, 1);
  }

  function parseProject(text) {
    var obj = JSON.parse(text);
    if (!obj || typeof obj !== 'object') throw new Error('不是有效的 JSON');

    if (obj.sheets && obj.sheets.length) {
      var list = obj.sheets.map(sanitizeSheet);
      return { sheets: list, active: clampIndex(obj.active, list.length) };
    }
    if (obj.strokes || obj.blocks || obj.edges) {
      return {
        sheets: [sanitizeSheet({ name: '页 1', strokes: obj.strokes, blocks: obj.blocks, edges: obj.edges })],
        active: 0
      };
    }
    throw new Error('文件里没有笔迹或字块');
  }

  /* ── 偏好 ───────────────────────────────────────────────── */

  function loadPrefs() {
    var raw = safeGet(KEY_PREFS);
    if (!raw) return {};
    try { return JSON.parse(raw) || {}; } catch (e) { return {}; }
  }

  function savePrefs(prefs) {
    try { safeSet(KEY_PREFS, JSON.stringify(prefs)); } catch (e) {}
  }

  /* ── 下载 ───────────────────────────────────────────────── */

  function download(filename, data, mime) {
    var blob = data instanceof Blob ? data : new Blob([data], { type: mime || 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function stamp() {
    var d = new Date();
    var p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
  }

  /* ── PNG：按场景包围盒出图，与当前缩放/平移无关 ───────────── */

  function exportPNG(o) {
    var box = o.box || { x: 0, y: 0, w: o.cssW || 1440, h: o.cssH || 900 };
    var scale = o.scale || 2;
    var w = Math.max(1, Math.round(box.w * scale));
    var h = Math.max(1, Math.round(box.h * scale));

    // 场景坐标 → 出图像素：先平移掉包围盒原点，再乘缩放
    function applyTransform(ctx) {
      ctx.setTransform(scale, 0, 0, scale, -box.x * scale, -box.y * scale);
    }

    // ① 笔迹单独画在透明层上：这样橡皮的 destination-out 能正确擦掉前面的笔迹
    var ink = document.createElement('canvas');
    ink.width = w;
    ink.height = h;
    var ic = ink.getContext('2d');
    ic.lineCap = 'round';
    ic.lineJoin = 'round';
    applyTransform(ic);
    if (o.ink) o.ink(ic);

    // ② 输出层：底色 + 笔迹 + 字块与连线
    var out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    var oc = out.getContext('2d');
    if (o.bg !== 'transparent') {
      var g = oc.createLinearGradient(0, h, 0, 0);
      g.addColorStop(0, '#05080e');
      g.addColorStop(0.55, '#081320');
      g.addColorStop(1, '#0b1a29');
      oc.fillStyle = g;
      oc.fillRect(0, 0, w, h);
    }
    oc.drawImage(ink, 0, 0);
    oc.save();
    applyTransform(oc);
    if (o.content) o.content(oc);
    oc.restore();
    return out;
  }

  /* 由内容算出场景包围盒（含连线端点），供出图与"适应视图"使用 */
  function contentBounds(strokes, sceneData, pad) {
    pad = pad == null ? 40 : pad;
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    function push(x, y) {
      if (!isFinite(x) || !isFinite(y)) return;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }

    (strokes || []).forEach(function (s) {
      var half = (s.w || 2) * (s.e ? 6 : 1) / 2 + 1;
      (s.p || []).forEach(function (p) { push(p[0] - half, p[1] - half); push(p[0] + half, p[1] + half); });
    });

    var rects = (sceneData && sceneData.rects) || [];
    rects.forEach(function (r) { push(r.x, r.y); push(r.x + r.w, r.y + r.h); });

    ((sceneData && sceneData.links) || []).forEach(function (l) { push(l.ax, l.ay); push(l.bx, l.by); });

    if (!isFinite(minX)) return null;
    return {
      x: minX - pad,
      y: minY - pad,
      w: (maxX - minX) + pad * 2,
      h: (maxY - minY) + pad * 2
    };
  }

  /* ── 导入 ───────────────────────────────────────────────── */

  function uid() {
    return 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  /* 我们自己的工程文件（.flow.json） */
  function parseScene(text) {
    var obj = JSON.parse(text);
    if (!obj || typeof obj !== 'object') throw new Error('不是有效的 JSON');
    if (!obj.strokes && !obj.blocks) throw new Error('文件里没有笔迹或字块');

    var strokes = unpackStrokes(obj.strokes);
    var blocks = sanitizeBlocks(obj.blocks).map(function (b) {
      return { id: b.id, x: b.x, y: b.y, text: b.text, color: b.color };
    });
    var edges = sanitizeEdges(obj.edges, blocks);
    return { strokes: strokes, blocks: blocks, edges: edges };
  }

  /* Excalidraw 文件（.excalidraw）
     支持：freedraw → 笔迹；rectangle / ellipse / diamond / 独立 text → 字块；
           text 若绑定了容器则填回该字块；arrow / line → 连线。
     连线的两端优先用 startBinding / endBinding 解析；没有绑定信息时
     （手画箭头、或别的工具导出的）退回几何就近匹配。 */
  function parseExcalidraw(text) {
    var doc = JSON.parse(text);
    if (!doc || doc.type !== 'excalidraw' || !Array.isArray(doc.elements)) {
      throw new Error('不是 .excalidraw 文件');
    }

    var els = doc.elements.filter(function (e) { return e && !e.isDeleted; });
    var strokes = [];
    var blocks = [];
    var edges = [];
    var byElement = {};                 // excalidraw 元素 id → 字块 id
    var skippedTexts = 0;

    /* ① 自由笔迹 */
    els.forEach(function (e) {
      if (e.type !== 'freedraw' || !e.points || e.points.length < 2) return;
      var pts = [];
      for (var i = 0; i < e.points.length; i++) {
        var p = e.points[i];
        pts.push([e.x + (p[0] || 0), e.y + (p[1] || 0), 1]);
      }
      strokes.push({
        c: e.strokeColor || '#eaf2ff',
        w: e.strokeWidth >= 4 ? 5 : (e.strokeWidth >= 1.5 ? 3 : 1.8),
        e: false,
        p: pts
      });
    });

    /* ② 形状与独立文字 → 字块 */
    els.forEach(function (e) {
      var isShape = e.type === 'rectangle' || e.type === 'ellipse' || e.type === 'diamond';
      var isFreeText = e.type === 'text' && !e.containerId;
      if (!isShape && !isFreeText) return;

      var w = Math.abs(e.width || 0);
      var h = Math.abs(e.height || 0);
      var b = {
        id: uid(),
        x: (e.x || 0) + w / 2,
        y: (e.y || 0) + h / 2,
        text: isFreeText ? String(e.text || '') : '',
        color: 0
      };
      // 导入时把原始矩形记下来，供箭头做几何就近匹配（不会写进存档）
      if (isShape && w > 0 && h > 0) {
        b._box = { x: e.x || 0, y: e.y || 0, w: w, h: h };
      }
      blocks.push(b);
      byElement[e.id] = b.id;
    });

    /* ③ 绑定在容器里的文字，填回对应字块 */
    els.forEach(function (e) {
      if (e.type !== 'text' || !e.containerId) return;
      var bid = byElement[e.containerId];
      if (!bid) { skippedTexts++; return; }
      for (var i = 0; i < blocks.length; i++) {
        if (blocks[i].id === bid) { blocks[i].text = String(e.text || ''); break; }
      }
    });

    /* 几何就近匹配：给没有绑定信息的箭头找两端的块 */
    function blockBox(b) {
      // 从 Excalidraw 导入的块有原始矩形，直接用它最准
      if (b._box) return b._box;
      // 否则按文字长度粗估一个框（中文 15px、其他 8.2px）
      var lines = String(b.text || '').split('\n');
      var longest = 0;
      lines.forEach(function (l) {
        var wpx = 0;
        for (var i = 0; i < l.length; i++) {
          wpx += l.charCodeAt(i) > 0x2e80 ? 15 : 8.2;
        }
        if (wpx > longest) longest = wpx;
      });
      var w = Math.max(76, Math.min(320, longest + 26));
      var h = Math.max(40, lines.length * 22.5 + 18);
      return { x: b.x - w / 2, y: b.y - h / 2, w: w, h: h };
    }

    function contains(box, x, y, slack) {
      slack = slack || 24;
      return x >= box.x - slack && x <= box.x + box.w + slack &&
             y >= box.y - slack && y <= box.y + box.h + slack;
    }

    function nearestBlock(x, y) {
      var best = null, bestD = Infinity;
      for (var i = 0; i < blocks.length; i++) {
        var box = blockBox(blocks[i]);
        if (contains(box, x, y)) return blocks[i].id;
        var dx = Math.max(box.x - x, 0, x - (box.x + box.w));
        var dy = Math.max(box.y - y, 0, y - (box.y + box.h));
        var d = Math.sqrt(dx * dx + dy * dy);
        if (d < bestD) { bestD = d; best = blocks[i].id; }
      }
      return bestD <= 60 ? best : null;
    }

    var skippedArrows = 0;

    els.forEach(function (e) {
      if (e.type !== 'arrow' && e.type !== 'line') return;
      if (e.type === 'line') return;                     // 普通直线不算关系，跳过

      var pts = e.points || [];
      if (!pts.length) { skippedArrows++; return; }
      var first = pts[0], last = pts[pts.length - 1];
      var ax = (e.x || 0) + (first[0] || 0), ay = (e.y || 0) + (first[1] || 0);
      var bx = (e.x || 0) + (last[0] || 0), by = (e.y || 0) + (last[1] || 0);

      // Excalidraw 里箭头的 points 可能是反向存储的，用绑定信息校正
      if (e.startBinding && e.endBinding) {
        var sb = byElement[e.startBinding.elementId];
        var eb = byElement[e.endBinding.elementId];
        if (sb && eb && sb !== eb) {
          edges.push({ id: uid(), from: sb, to: eb });
          return;
        }
      }

      var a = nearestBlock(ax, ay);
      var b = nearestBlock(bx, by);
      if (a && b && a !== b) {
        edges.push({ id: uid(), from: a, to: b });
      } else {
        skippedArrows++;
      }
    });

    return {
      strokes: strokes,
      blocks: blocks,
      edges: edges,
      stats: { skippedArrows: skippedArrows, skippedTexts: skippedTexts }
    };
  }

  /* ── .excalidraw 导出（实验性） ──────────────────────────────
     笔迹 → freedraw；字块 → rectangle + text（容器绑定）；连线 → arrow。
     说明：Excalidraw 的数据模型里没有"橡皮擦笔迹"这个概念
     （擦除体现为元素被删改），所以橡皮擦的结果不会体现在导出文件里。
     箭头没有写 startBinding / endBinding，因此拖动形状时箭头不会自动重排。
     ──────────────────────────────────────────────────────── */

  function rid() {
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    var s = '';
    for (var i = 0; i < 20; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }

  var FONT_SIZE = 15;
  var LINE_H = 1.25;

  function baseElement(type, extra) {
    var el = {
      id: rid(),
      type: type,
      x: 0, y: 0, width: 0, height: 0, angle: 0,
      strokeColor: '#bcd6ff',
      backgroundColor: 'transparent',
      fillStyle: 'solid',
      strokeWidth: 1,
      strokeStyle: 'solid',
      roughness: 1,
      opacity: 100,
      groupIds: [],
      frameId: null,
      roundness: null,
      seed: Math.floor(Math.random() * 2000000000),
      version: 1,
      versionNonce: Math.floor(Math.random() * 2000000000),
      isDeleted: false,
      boundElements: null,
      updated: Date.now(),
      link: null,
      locked: false
    };
    for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) el[k] = extra[k];
    return el;
  }

  function toExcalidraw(strokes, scene, opts) {
    opts = opts || {};
    scene = scene || {};
    var pad = opts.pad || 8;
    var elements = [];

    /* ① 自由笔迹 */
    for (var i = 0; i < strokes.length; i++) {
      var s = strokes[i];
      if (s.e) continue;                       // 跳过橡皮擦笔迹
      if (!s.p || s.p.length < 2) continue;

      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (var j = 0; j < s.p.length; j++) {
        var p = s.p[j];
        if (p[0] < minX) minX = p[0];
        if (p[0] > maxX) maxX = p[0];
        if (p[1] < minY) minY = p[1];
        if (p[1] > maxY) maxY = p[1];
      }
      var ox = minX - pad, oy = minY - pad;
      var points = [], pressures = [];
      for (var k = 0; k < s.p.length; k++) {
        points.push([s.p[k][0] - ox, s.p[k][1] - oy]);
        pressures.push(0.5);
      }

      elements.push(baseElement('freedraw', {
        x: ox, y: oy,
        width: Math.max(1, maxX - minX + pad * 2),
        height: Math.max(1, maxY - minY + pad * 2),
        strokeColor: s.c,
        strokeWidth: s.w >= 3.2 ? 4 : 2,
        points: points,
        pressures: pressures,
        simulatePressure: false,
        lastCommittedPoint: null
      }));
    }

    /* ② 字块：矩形 + 绑定文字；同时记下矩形，供箭头写绑定 */
    var rects = scene.rects || [];
    var PAD_X = 13, PAD_Y = 9;
    var rectByBlock = {};

    for (var r = 0; r < rects.length; r++) {
      var b = rects[r];
      var rectId = rid();
      var textId = rid();
      var innerW = Math.max(10, b.w - PAD_X * 2);
      var lineCount = String(b.text).split('\n').length || 1;

      var rectEl = baseElement('rectangle', {
        id: rectId,
        x: b.x, y: b.y, width: b.w, height: b.h,
        strokeColor: b.borderColor || '#bcd6ff',
        roundness: { type: 3 },
        boundElements: [{ type: 'text', id: textId }]
      });
      elements.push(rectEl);
      rectByBlock[b.id] = rectEl;

      elements.push(baseElement('text', {
        id: textId,
        x: b.x + PAD_X,
        y: b.y + PAD_Y,
        width: innerW,
        height: Math.max(FONT_SIZE, b.h - PAD_Y * 2),
        strokeColor: b.textColor || '#eaf2ff',
        text: String(b.text),
        fontSize: FONT_SIZE,
        fontFamily: 2,
        textAlign: 'left',
        verticalAlign: 'top',
        containerId: rectId,
        originalText: String(b.text),
        lineHeight: LINE_H,
        baseline: PAD_Y + lineCount * FONT_SIZE * LINE_H - 4
      }));
    }

    /* ③ 连线：箭头（写上两端绑定，这样在 Excalidraw 里拖动形状箭头会跟着走，
          我们自己的文件也能无损round-trip回来） */
    var links = scene.links || [];
    for (var n = 0; n < links.length; n++) {
      var e = links[n];
      var dx = e.bx - e.ax, dy = e.by - e.ay;
      var arrowId = rid();
      var fromRect = rectByBlock[e.from];
      var toRect = rectByBlock[e.to];

      elements.push(baseElement('arrow', {
        id: arrowId,
        x: e.ax, y: e.ay,
        width: Math.abs(dx), height: Math.abs(dy),
        strokeColor: opts.arrowColor || '#bcd6ff',
        roundness: { type: 2 },
        points: [[0, 0], [dx, dy]],
        lastCommittedPoint: null,
        startBinding: fromRect ? { elementId: fromRect.id, focus: 0, gap: 8 } : null,
        endBinding: toRect ? { elementId: toRect.id, focus: 0, gap: 8 } : null,
        startArrowhead: null,
        endArrowhead: 'arrow'
      }));

      if (fromRect) (fromRect.boundElements || (fromRect.boundElements = []))
        .push({ type: 'arrow', id: arrowId });
      if (toRect) (toRect.boundElements || (toRect.boundElements = []))
        .push({ type: 'arrow', id: arrowId });
    }

    return JSON.stringify({
      type: 'excalidraw',
      version: 2,
      source: opts.source || 'flow',
      elements: elements,
      appState: {
        gridSize: null,
        viewBackgroundColor: opts.background || '#0b1018'
      },
      files: {}
    }, null, 2);
  }

  window.Flow.Store = {
    // 多页（当前）
    loadSheets: loadSheets,
    saveSheets: saveSheets,
    clearSheets: clearSheets,
    sanitizeSheet: sanitizeSheet,
    serializeSheets: serializeSheets,
    toProjectJSON: toProjectJSON,
    parseProject: parseProject,
    newSheetId: newSheetId,
    SHEET_NAME_MAX: SHEET_NAME_MAX,

    // 单页（旧接口，保留兼容）
    loadScene: loadScene,
    saveScene: saveScene,
    clearScene: clearScene,

    loadPrefs: loadPrefs,
    savePrefs: savePrefs,
    download: download,
    stamp: stamp,
    exportPNG: exportPNG,
    contentBounds: contentBounds,
    parseScene: parseScene,
    parseExcalidraw: parseExcalidraw,
    toExcalidraw: toExcalidraw,
    packStrokes: packStrokes,
    unpackStrokes: unpackStrokes,
    sanitizeBlocks: sanitizeBlocks,
    sanitizeEdges: sanitizeEdges
  };
})();
