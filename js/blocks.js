/* ============================================================
   blocks.js — 文字块与连线（节点图）
   字块是 DOM 元素（自动随文字伸缩、可直接打字），连线是 SVG 贝塞尔曲线。
   交互：在空白处点击新建 · 拖动移动 · 双击改字 · 从块右侧小圆点拖到
         另一个块建立带箭头的连线 · 选中后 Delete 删除。
   ============================================================ */
(function () {
  'use strict';

  window.Flow = window.Flow || {};

  var NS = 'http://www.w3.org/2000/svg';

  // 与白板笔迹共用同一组颜色；hex 供 .excalidraw 导出使用
  var COLORS = [
    { line: 'rgba(190,215,255,.50)', text: '#eaf2ff', hex: '#bcd6ff' },
    { line: 'rgba(255,217,160,.50)', text: '#ffd9a0', hex: '#ffd9a0' },
    { line: 'rgba(159,232,224,.50)', text: '#9fe8e0', hex: '#9fe8e0' }
  ];
  var EDGE_STROKE = 'rgba(190,215,255,.55)';
  var ARROW_FILL = 'rgba(190,215,255,.75)';
  var FONT_SIZE = 15;
  var LINE_H = 1.5;
  var PAD_X = 13;
  var PAD_Y = 9;
  var RADIUS = 13;
  var FONT_STACK = '-apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';

  function uid() {
    return 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function create(opts) {
    var layer = opts.layer;            // #nodes（跟着相机缩放）
    var catchLayer = opts.catchLayer;  // #text-catch（不带变换的整屏接收层）
    var svg = opts.svg;                // #edges
    var edgeLayer = opts.edgeLayer;    // #edge-layer
    var preview = opts.preview;        // #edge-preview
    var camera = opts.camera || null;

    var blocks = (opts.blocks || []).slice();
    var edges = (opts.edges || []).slice();
    var els = {};                      // id -> node 元素
    var edgeEls = {};                  // id -> {g, hit, vis}

    var enabled = false;
    var tool = 'pen';
    var colorIndex = 0;
    var sel = { blocks: {}, edges: {} };   // 多选集合：id -> true
    var editingId = null;
    var drag = null;                   // {id, ox, oy, moved, before}
    var linking = null;                // {from, x, y}

    var undoStack = [];
    var UNDO_MAX = 60;

    var api = { onChange: null, onGroupMove: null };

    /* ── 撤销（结构级：字块与连线） ───────────────────────────
       笔迹的撤销由 board.js 自己管；这里只管结构变更。
       ──────────────────────────────────────────────────────── */

    function snapshot() {
      try {
        return JSON.stringify({ b: blocks, e: edges });
      } catch (err) { return null; }
    }

    function pushUndo(str) {
      if (!str) return;
      undoStack.push(str);
      if (undoStack.length > UNDO_MAX) undoStack.shift();
    }

    function restore(str) {
      var obj;
      try { obj = JSON.parse(str); } catch (e) { return false; }
      blocks = obj.b || [];
      edges = obj.e || [];
      selClear();
      editingId = null;
      render();
      changed();
      return true;
    }

    api.undo = function () {
      if (!undoStack.length) return false;
      return restore(undoStack.pop());
    };

    api.undoDepth = function () { return undoStack.length; };

    /* ── 查询 ─────────────────────────────────────────────── */

    function byId(id) {
      for (var i = 0; i < blocks.length; i++) if (blocks[i].id === id) return blocks[i];
      return null;
    }

    // 块的几何：x/y 是中心点，宽高从 DOM 实测（因为随文字自动伸缩）
    function rectOf(b) {
      var el = els[b.id];
      return {
        cx: b.x,
        cy: b.y,
        w: el ? el.offsetWidth : 120,
        h: el ? el.offsetHeight : 40
      };
    }

    // 从矩形中心朝 (tx,ty) 方向射出，落在矩形边界上的点
    function anchor(rect, tx, ty) {
      var dx = tx - rect.cx, dy = ty - rect.cy;
      if (dx === 0 && dy === 0) return { x: rect.cx, y: rect.cy };
      var hw = rect.w / 2 + 1, hh = rect.h / 2 + 1;
      var sx = dx === 0 ? Infinity : hw / Math.abs(dx);
      var sy = dy === 0 ? Infinity : hh / Math.abs(dy);
      var s = Math.min(sx, sy);
      return { x: rect.cx + dx * s, y: rect.cy + dy * s };
    }

    // 两锚点之间的三次贝塞尔：主方向决定控制点偏移，看起来更"顺"
    function curve(a, b) {
      var dx = b.x - a.x, dy = b.y - a.y;
      var dist = Math.sqrt(dx * dx + dy * dy) || 1;
      var k = Math.min(150, dist * 0.42);
      var c1, c2;
      if (Math.abs(dx) >= Math.abs(dy)) {
        c1 = { x: a.x + (dx >= 0 ? k : -k), y: a.y };
        c2 = { x: b.x - (dx >= 0 ? k : -k), y: b.y };
      } else {
        c1 = { x: a.x, y: a.y + (dy >= 0 ? k : -k) };
        c2 = { x: b.x, y: b.y - (dy >= 0 ? k : -k) };
      }
      return {
        a: a, b: b, c1: c1, c2: c2,
        d: 'M' + a.x + ',' + a.y + ' C' + c1.x + ',' + c1.y + ' ' + c2.x + ',' + c2.y + ' ' + b.x + ',' + b.y
      };
    }

    function edgeCurve(e) {
      var from = byId(e.from), to = byId(e.to);
      if (!from || !to) return null;
      var ra = rectOf(from), rb = rectOf(to);
      return curve(anchor(ra, rb.cx, rb.cy), anchor(rb, ra.cx, ra.cy));
    }

    /* ── 相机 ─────────────────────────────────────────────── */

    function screenX(e) { return camera ? camera.toSceneX(e.clientX) : e.clientX; }
    function screenY(e) { return camera ? camera.toSceneY(e.clientY) : e.clientY; }

    /* 把视口可见范围换算成场景坐标，再给一点边距：
       字块始终能被拖回"看得见的地方"，不会丢到屏幕外找不回来 */
    function visibleRange() {
      var s = camera ? camera.scale : 1;
      var m = 70 / s;
      var my = 50 / s;
      var x0 = (camera ? camera.toSceneX(0) : 0) + m;
      var x1 = (camera ? camera.toSceneX(window.innerWidth) : window.innerWidth) - m;
      var y0 = (camera ? camera.toSceneY(0) : 0) + my;
      var y1 = (camera ? camera.toSceneY(window.innerHeight) : window.innerHeight) - my;
      if (x1 < x0) { var cx = (x0 + x1) / 2; x0 = x1 = cx; }
      if (y1 < y0) { var cy = (y0 + y1) / 2; y0 = y1 = cy; }
      return { x0: x0, x1: x1, y0: y0, y1: y1 };
    }

    function applyTransform() {
      var t = camera ? camera.cssTransform() : 'none';
      layer.style.transform = t;
      layer.style.transformOrigin = '0 0';
      if (svg) {
        svg.style.transform = t;
        svg.style.transformOrigin = '0 0';
      }
    }

    api.viewChanged = function () { applyTransform(); };

    /* ── 渲染 ─────────────────────────────────────────────── */

    function bindNode(el, b) {
      var t = el.querySelector('.node-text');
      var handle = el.querySelector('.node-handle');

      el.addEventListener('pointerdown', function (e) {
        if (!enabled) return;
        if (editingId === b.id) return;                       // 编辑中：正常选文字
        if (e.target === handle) { startLink(e, b); return; }
        if (e.pointerType === 'mouse' && e.button !== 0) return;

        if (e.shiftKey) {
          // Shift 点击：加入 / 移出选区。移出时不启动拖动，避免误移
          var wasSelected = selHas('block', b.id);
          selAddOrToggle('block', b.id);
          render();
          if (wasSelected) { e.preventDefault(); e.stopPropagation(); return; }
        } else if (!selHas('block', b.id)) {
          // 点未选中的块：单选它（替换选区）
          select('block', b.id);
        }
        // 点已选中的块：保持整个选区，开始整组拖动
        // 注意：beginMove/moveBy/clampMove/endMove 只挂在 api 上，必须走 api. 调用
        api.beginMove();
        drag = {
          id: b.id,
          ox: b.x - screenX(e),
          oy: b.y - screenY(e),
          moved: false,
          before: snapshot()
        };
        el.classList.add('dragging');
        if (api.onGroupMove) api.onGroupMove('start', 0, 0);
        try { el.setPointerCapture(e.pointerId); } catch (err) {}
        e.preventDefault();
        e.stopPropagation();
      });

      el.addEventListener('dblclick', function (e) {
        if (!enabled) return;
        if (e.target === handle) return;
        startEdit(b);
        e.preventDefault();
        e.stopPropagation();
      });

      // 打字期间把按键拦在块内，别触发 B / H / T / S 这些全局快捷键
      t.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { e.preventDefault(); t.blur(); }
        e.stopPropagation();
      });
      t.addEventListener('blur', function () {
        if (editingId === b.id) stopEdit();
      });
      t.addEventListener('input', function () { renderEdges(); });
      // 输入法组字结束 / 粘贴后，尺寸可能变了
      t.addEventListener('compositionend', function () { renderEdges(); });
      t.addEventListener('paste', function (e) {
        e.preventDefault();
        var text = (e.clipboardData || window.clipboardData).getData('text');
        if (text && document.execCommand) document.execCommand('insertText', false, text);
      });
    }

    function ensureEl(b) {
      var el = els[b.id];
      if (el) return el;
      el = document.createElement('div');
      el.className = 'node';
      el.setAttribute('data-id', b.id);

      var t = document.createElement('div');
      t.className = 'node-text';
      t.setAttribute('spellcheck', 'false');
      el.appendChild(t);

      var h = document.createElement('button');
      h.type = 'button';
      h.className = 'node-handle';
      h.title = '拖到另一个块上建立连线';
      h.setAttribute('aria-label', '连线');
      el.appendChild(h);

      layer.appendChild(el);
      els[b.id] = el;
      bindNode(el, b);
      return el;
    }

    function render() {
      var seen = {};
      for (var i = 0; i < blocks.length; i++) {
        var b = blocks[i];
        seen[b.id] = 1;
        var el = ensureEl(b);
        el.style.left = b.x + 'px';
        el.style.top = b.y + 'px';
        var c = COLORS[b.color || 0] || COLORS[0];
        el.style.setProperty('--nb', c.line);
        el.style.setProperty('--nt', c.text);
        if (editingId !== b.id) {
          var t = el.querySelector('.node-text');
          if (t.textContent !== b.text) t.textContent = b.text;
        }
        el.classList.toggle('sel', !!sel.blocks[b.id]);
      }
      Object.keys(els).forEach(function (id) {
        if (!seen[id]) {
          if (els[id].parentNode) els[id].parentNode.removeChild(els[id]);
          delete els[id];
        }
      });
      renderEdges();
    }

    function renderEdges() {
      var seen = {};
      for (var i = 0; i < edges.length; i++) {
        var e = edges[i];
        var geo = edgeCurve(e);
        if (!geo) continue;
        seen[e.id] = 1;
        var g = edgeEls[e.id];
        if (!g) {
          g = { g: document.createElementNS(NS, 'g') };
          g.hit = document.createElementNS(NS, 'path');
          g.hit.setAttribute('class', 'hit');
          g.vis = document.createElementNS(NS, 'path');
          g.vis.setAttribute('marker-end', 'url(#arrow)');
          g.g.appendChild(g.hit);
          g.g.appendChild(g.vis);
          (function (id) {
            g.hit.addEventListener('pointerdown', function (ev) {
              if (!enabled) return;
              if (ev.shiftKey) selAddOrToggle('edge', id);
              else select('edge', id);
              render();
              ev.stopPropagation();
              ev.preventDefault();
            });
          })(e.id);
          edgeLayer.appendChild(g.g);
          edgeEls[e.id] = g;
        }
        g.hit.setAttribute('d', geo.d);
        g.vis.setAttribute('d', geo.d);
        g.vis.setAttribute('class', sel.edges[e.id] ? 'sel' : '');
      }
      Object.keys(edgeEls).forEach(function (id) {
        if (!seen[id]) {
          var g = edgeEls[id].g;
          if (g.parentNode) g.parentNode.removeChild(g);
          delete edgeEls[id];
        }
      });
    }

    function changed() {
      if (api.onChange) api.onChange();
    }

    /* ── 选中（多选：用对象当集合，id -> true） ─────────────── */

    function selCount() {
      return Object.keys(sel.blocks).length + Object.keys(sel.edges).length;
    }
    function selHas(type, id) {
      return !!(type === 'block' ? sel.blocks[id] : sel.edges[id]);
    }
    function selAdd(type, id) {
      if (!id) return;
      if (type === 'block') sel.blocks[id] = true; else sel.edges[id] = true;
    }
    function selRemove(type, id) {
      if (type === 'block') delete sel.blocks[id]; else delete sel.edges[id];
    }
    function selClear() {
      sel.blocks = {};
      sel.edges = {};
    }
    function selIds(type) {
      return Object.keys(type === 'block' ? sel.blocks : sel.edges);
    }

    // Shift 点击用：已选则移出，未选则加入
    function selAddOrToggle(type, id) {
      if (selHas(type, id)) selRemove(type, id); else selAdd(type, id);
    }

    function select(type, id) {          // 单选（替换）
      selClear();
      selAdd(type, id);
      render();
    }

    api.clearSelection = function () {
      if (!selCount()) return false;
      selClear();
      render();
      return true;
    };

    api.hasSelection = function () { return selCount() > 0; };
    api.selectionCount = function () { return selCount(); };
    api.selectedBlockIds = function () { return selIds('block'); };
    api.selectedEdgeIds = function () { return selIds('edge'); };
    api.isSelected = function (type, id) { return selHas(type, id); };

    api.toggleSelection = function (type, id) {
      if (selHas(type, id)) selRemove(type, id); else selAdd(type, id);
      render();
    };

    /* 框选：返回与该矩形相交的字块与连线（连线用曲线包围盒近似） */
    api.hitTestRect = function (rect) {
      var G = window.Flow.Geom;
      var out = { blocks: [], edges: [] };
      blocks.forEach(function (b) {
        var r = rectOf(b);
        var box = { x: r.cx - r.w / 2, y: r.cy - r.h / 2, w: r.w, h: r.h };
        if (G.rectsIntersect(box, rect)) out.blocks.push(b.id);
      });
      edges.forEach(function (e) {
        var geo = edgeCurve(e);
        if (!geo) return;
        var box = G.rectOfPoints([[geo.a.x, geo.a.y], [geo.c1.x, geo.c1.y],
                                  [geo.c2.x, geo.c2.y], [geo.b.x, geo.b.y]]);
        if (box && G.rectsIntersect(G.expand(box, 2), rect)) out.edges.push(e.id);
      });
      return out;
    };

    /* 某点是否落在某条连线上（框选层挡住了 SVG，所以要在几何上自己判） */
    api.edgeAt = function (x, y, tol) {
      var G = window.Flow.Geom;
      tol = tol == null ? 8 : tol;
      for (var i = edges.length - 1; i >= 0; i--) {
        var geo = edgeCurve(edges[i]);
        if (!geo) continue;
        if (G.distToCubicSq(x, y, geo.a, geo.c1, geo.c2, geo.b) <= tol * tol) return edges[i].id;
      }
      return null;
    };

    api.selectAll = function () {
      selClear();
      blocks.forEach(function (b) { sel.blocks[b.id] = true; });
      edges.forEach(function (e) { sel.edges[e.id] = true; });
      render();
      return selCount();
    };

    /* ── 整组平移 ─────────────────────────────────────────────
       拖动开始记下所有选中块的起点，之后按"起点 + 同一位移"设置绝对位置。
       这样多块之间的相对关系不会因为逐帧累加而漂移。
       ──────────────────────────────────────────────────────── */

    var moveStart = null;      // {id: {x, y}}

    api.beginMove = function () {
      moveStart = {};
      selIds('block').forEach(function (id) {
        var b = byId(id);
        if (b) moveStart[id] = { x: b.x, y: b.y };
      });
      return Object.keys(moveStart).length;
    };

    /* 把位移夹在"所有选中块都还在可视范围内"的区间里 */
    api.clampMove = function (dx, dy) {
      if (!moveStart) return { dx: dx, dy: dy };
      var G = window.Flow.Geom;
      var rng = visibleRange();
      var xs = [], ys = [];
      Object.keys(moveStart).forEach(function (id) {
        xs.push(moveStart[id].x);
        ys.push(moveStart[id].y);
      });
      var rx = G.clampSharedDelta(xs, rng.x0, rng.x1);
      var ry = G.clampSharedDelta(ys, rng.y0, rng.y1);
      return {
        dx: clamp(dx, rx.min, rx.max),
        dy: clamp(dy, ry.min, ry.max)
      };
    };

    api.moveBy = function (dx, dy) {
      if (!moveStart) return 0;
      var n = 0;
      Object.keys(moveStart).forEach(function (id) {
        var b = byId(id);
        if (!b) return;
        b.x = moveStart[id].x + dx;
        b.y = moveStart[id].y + dy;
        var el = els[id];
        if (el) { el.style.left = b.x + 'px'; el.style.top = b.y + 'px'; }
        n++;
      });
      renderEdges();
      return n;
    };

    api.endMove = function () {
      moveStart = null;
    };

    /* ── 增删改 ───────────────────────────────────────────── */

    function addBlock(x, y, text) {
      pushUndo(snapshot());
      var rng = visibleRange();
      var b = {
        id: uid(),
        x: clamp(x, rng.x0, rng.x1),
        y: clamp(y, rng.y0, rng.y1),
        text: text || '',
        color: colorIndex
      };
      blocks.push(b);
      render();
      return b;
    }

    // skipUndo 用于「点了空白处又没打字」的块：它从未真正存在过，
    // 不该占用一次撤销，否则撤销栈会被误点填满
    function removeBlock(id, skipUndo) {
      if (!skipUndo) pushUndo(snapshot());
      blocks = blocks.filter(function (b) { return b.id !== id; });
      // 连着这个块的连线一起删，并从选中集合里清掉
      var dropped = [];
      edges.forEach(function (e) { if (e.from === id || e.to === id) dropped.push(e.id); });
      edges = edges.filter(function (e) { return e.from !== id && e.to !== id; });
      dropped.forEach(function (eid) { selRemove('edge', eid); });
      selRemove('block', id);
      if (editingId === id) editingId = null;
      render();
      changed();
    }

    function startEdit(b) {
      if (editingId && editingId !== b.id) stopEdit();
      if (!els[b.id]) render();
      var el = els[b.id];
      if (!el) return;
      editingId = b.id;
      el.classList.add('editing');
      var t = el.querySelector('.node-text');
      t.contentEditable = 'true';
      t.focus();
      try {
        var r = document.createRange();
        r.selectNodeContents(t);
        var s = window.getSelection();
        s.removeAllRanges();
        s.addRange(r);
      } catch (e) {}
    }

    function stopEdit() {
      if (!editingId) return;
      var id = editingId;
      editingId = null;
      var b = byId(id), el = els[id];
      if (!b || !el) return;
      var t = el.querySelector('.node-text');
      var text = (t.innerText || '').replace(/[\s\u00a0]+$/, '');
      var old = b.text;
      t.contentEditable = 'false';
      el.classList.remove('editing');
      if (!text.trim()) {
        removeBlock(id, true);                // 空块不留下，也不占撤销
        return;
      }
      if (text === old) return;               // 没改动就不占一次撤销
      // 此刻模型里还是旧文字，snapshot() 拿到的正是"改动前"
      pushUndo(snapshot());
      b.text = text;
      t.textContent = text;
      renderEdges();
      changed();
    }

    api.addBlockAtCenter = function () {
      var cx = camera ? camera.toSceneX(window.innerWidth / 2) : window.innerWidth / 2;
      var cy = camera ? camera.toSceneY(window.innerHeight / 2) : window.innerHeight / 2;
      var b = addBlock(cx + (Math.random() * 60 - 30), cy + (Math.random() * 60 - 30), '');
      startEdit(b);
      return b;
    };

    /* ── 连线 ─────────────────────────────────────────────── */

    function startLink(e, b) {
      var px = screenX(e), py = screenY(e);
      linking = { from: b.id, x: px, y: py };
      var r = rectOf(b);
      var a = anchor(r, px, py);
      preview.setAttribute('d', 'M' + a.x + ',' + a.y + ' L' + px + ',' + py);
      preview.classList.add('on');
      e.preventDefault();
      e.stopPropagation();
    }

    function nodeUnder(x, y) {
      var el = document.elementFromPoint(x, y);
      var n = el && el.closest ? el.closest('.node') : null;
      return n ? n.getAttribute('data-id') : null;
    }

    function addEdge(from, to) {
      if (!from || !to || from === to) return false;
      for (var i = 0; i < edges.length; i++) {
        if (edges[i].from === from && edges[i].to === to) return false;
      }
      pushUndo(snapshot());
      edges.push({ id: uid(), from: from, to: to });
      renderEdges();
      changed();
      return true;
    }

    api.addBlock = addBlock;
    api.addEdge = addEdge;

    /* ── 手势（挂在 window 上，指针移出块也能继续） ────────── */

    function onMove(e) {
      if (drag) {
        var b = byId(drag.id);
        if (!b) { drag = null; return; }
        // 目标位置 → 位移 → 夹在"整组都还在可视范围内"的区间 → 整组应用
        var wantX = screenX(e) + drag.ox - moveStart[drag.id].x;
        var wantY = screenY(e) + drag.oy - moveStart[drag.id].y;
        var d = api.clampMove(wantX, wantY);
        api.moveBy(d.dx, d.dy);
        drag.moved = true;
        if (api.onGroupMove) api.onGroupMove('move', d.dx, d.dy);
        return;
      }
      if (linking) {
        var from = byId(linking.from);
        if (!from) { linking = null; return; }
        var r = rectOf(from);
        var px = screenX(e), py = screenY(e);
        var a = anchor(r, px, py);
        preview.setAttribute('d', 'M' + a.x + ',' + a.y + ' L' + px + ',' + py);
      }
    }

    function onUp(e) {
      if (drag) {
        var el = els[drag.id];
        if (el) el.classList.remove('dragging');
        var moved = drag.moved;
        var before = drag.before;
        drag = null;
        api.endMove();
        if (api.onGroupMove) api.onGroupMove('end', 0, 0);
        if (moved) { pushUndo(before); changed(); }
      }
      if (linking) {
        var from = linking.from;
        linking = null;
        preview.classList.remove('on');
        preview.setAttribute('d', '');
        addEdge(from, nodeUnder(e.clientX, e.clientY));
      }
    }

    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);

    /* 「文字」工具下，点空白处即新建。
       挂在 catchLayer 上而不是 nodes 层：catchLayer 不带相机变换，
       命中区域恒等于视口，所以缩放到任何比例都不会有边缘失效区。 */
    if (catchLayer) {
      catchLayer.addEventListener('pointerdown', function (e) {
        if (!enabled || tool !== 'text') return;
        var b = addBlock(screenX(e), screenY(e), '');
        startEdit(b);
        changed();
        e.preventDefault();
      });
    }

    /* ── 对外 ─────────────────────────────────────────────── */

    api.setEnabled = function (v) {
      enabled = !!v;
      if (!enabled) {
        if (editingId) stopEdit();
        if (selCount()) { selClear(); render(); }
        drag = null;
        moveStart = null;
        linking = null;
        preview.classList.remove('on');
        preview.setAttribute('d', '');
      }
      return enabled;
    };

    api.setTool = function (t) { tool = t; };
    api.setColor = function (i) {
      colorIndex = clamp(i | 0, 0, COLORS.length - 1);
      var ids = selIds('block');
      if (ids.length) {
        var changedAny = false;
        pushUndo(snapshot());
        ids.forEach(function (id) {
          var b = byId(id);
          if (b && b.color !== colorIndex) { b.color = colorIndex; changedAny = true; }
        });
        if (changedAny) { render(); changed(); }
      }
      return colorIndex;
    };
    api.getColor = function () { return colorIndex; };

    /* 删除全部选中（多选） */
    api.deleteSelected = function () {
      if (!selCount()) return 0;
      pushUndo(snapshot());
      var blockIds = selIds('block');
      var edgeIds = selIds('edge');
      if (blockIds.length) {
        var kill = {};
        blockIds.forEach(function (id) { kill[id] = true; });
        blocks = blocks.filter(function (b) { return !kill[b.id]; });
        // 连着被删块的连线也一起清掉
        edges = edges.filter(function (e) { return !kill[e.from] && !kill[e.to]; });
      }
      if (edgeIds.length) {
        var ke = {};
        edgeIds.forEach(function (id) { ke[id] = true; });
        edges = edges.filter(function (e) { return !ke[e.id]; });
      }
      var n = blockIds.length + edgeIds.length;
      selClear();
      editingId = null;
      render();
      changed();
      return n;
    };

    api.clearAll = function () {
      if (!blocks.length && !edges.length) return false;
      pushUndo(snapshot());
      blocks = [];
      edges = [];
      selClear();
      editingId = null;
      render();
      changed();
      return true;
    };

    /* 整体替换（换页 / 导入用）。
       这里**不再**自动清空撤销栈：换页时调用方会把目标页自己的栈
       importUndo 回来；导入时调用方显式传空数组。
       否则目标页的栈会指向别的页的内容，撤销就会把别人的字块搬进来。 */
    api.replaceAll = function (bs, es) {
      blocks = (bs || []).slice();
      edges = (es || []).slice();
      selClear();
      editingId = null;
      drag = null;
      moveStart = null;
      linking = null;
      render();
      changed();
    };

    /* 撤销栈随页存取 */
    api.exportUndo = function () { return undoStack.slice(); };
    api.importUndo = function (arr) { undoStack = (arr || []).slice(0, UNDO_MAX); };

    api.blockCount = function () { return blocks.length; };
    api.edgeCount = function () { return edges.length; };
    api.getBlocks = function () { return blocks; };
    api.getEdges = function () { return edges; };
    api.isEditing = function () { return !!editingId; };
    api.render = render;

    // 用坐标反查是不是点在字块上（app.js 用来决定要不要画线）
    api.hitTest = function (x, y) { return !!nodeUnder(x, y); };

    /* ── 导出 ─────────────────────────────────────────────── */

    function wrapText(ctx, text, maxW) {
      var out = [];
      String(text).split('\n').forEach(function (para) {
        if (!para) { out.push(''); return; }
        var line = '';
        for (var i = 0; i < para.length; i++) {
          var test = line + para[i];
          if (line && ctx.measureText(test).width > maxW) {
            out.push(line);
            line = para[i];
          } else {
            line = test;
          }
        }
        out.push(line);
      });
      return out;
    }

    function roundRect(ctx, x, y, w, h, r) {
      r = Math.min(r, w / 2, h / 2);
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + w - r, y);
      ctx.quadraticCurveTo(x + w, y, x + w, y + r);
      ctx.lineTo(x + w, y + h - r);
      ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      ctx.lineTo(x + r, y + h);
      ctx.quadraticCurveTo(x, y + h, x, y + h - r);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.closePath();
    }

    function arrowHead(ctx, from, tip) {
      var ang = Math.atan2(tip.y - from.y, tip.x - from.x);
      var len = 9, wid = 4.5;
      ctx.beginPath();
      ctx.moveTo(tip.x, tip.y);
      ctx.lineTo(tip.x - len * Math.cos(ang) + wid * Math.sin(ang),
                 tip.y - len * Math.sin(ang) - wid * Math.cos(ang));
      ctx.lineTo(tip.x - len * Math.cos(ang) - wid * Math.sin(ang),
                 tip.y - len * Math.sin(ang) + wid * Math.cos(ang));
      ctx.closePath();
      ctx.fillStyle = ARROW_FILL;
      ctx.fill();
    }

    /* 把字块与连线画进任意 2D 上下文（PNG 导出用） */
    api.paint = function (ctx) {
      ctx.save();
      ctx.strokeStyle = EDGE_STROKE;
      ctx.lineWidth = 1.6;
      ctx.lineCap = 'round';
      for (var i = 0; i < edges.length; i++) {
        var geo = edgeCurve(edges[i]);
        if (!geo) continue;
        ctx.beginPath();
        ctx.moveTo(geo.a.x, geo.a.y);
        ctx.bezierCurveTo(geo.c1.x, geo.c1.y, geo.c2.x, geo.c2.y, geo.b.x, geo.b.y);
        ctx.stroke();
        arrowHead(ctx, geo.c2, geo.b);
      }
      ctx.restore();

      ctx.save();
      ctx.font = FONT_SIZE + 'px ' + FONT_STACK;
      ctx.textBaseline = 'top';
      for (var j = 0; j < blocks.length; j++) {
        var b = blocks[j];
        var r = rectOf(b);
        var x = r.cx - r.w / 2, y = r.cy - r.h / 2;
        var c = COLORS[b.color || 0] || COLORS[0];
        ctx.save();
        roundRect(ctx, x, y, r.w, r.h, RADIUS);
        ctx.fillStyle = 'rgba(9,16,26,.72)';
        ctx.fill();
        ctx.strokeStyle = c.line;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();

        ctx.fillStyle = c.text;
        var lines = wrapText(ctx, b.text, r.w - PAD_X * 2);
        for (var k = 0; k < lines.length; k++) {
          ctx.fillText(lines[k], x + PAD_X, y + PAD_Y + k * FONT_SIZE * LINE_H);
        }
      }
      ctx.restore();
    };

    /* 供 .excalidraw 导出使用：矩形 + 文字 + 箭头 */
    api.exportData = function () {
      return {
        rects: blocks.map(function (b) {
          var r = rectOf(b);
          return {
            id: b.id,
            x: r.cx - r.w / 2, y: r.cy - r.h / 2,
            w: r.w, h: r.h,
            text: b.text,
            color: b.color || 0,
            textColor: (COLORS[b.color || 0] || COLORS[0]).text,
            borderColor: (COLORS[b.color || 0] || COLORS[0]).hex
          };
        }),
        links: edges.map(function (e) {
          var geo = edgeCurve(e);
          if (!geo) return null;
          return { id: e.id, from: e.from, to: e.to, ax: geo.a.x, ay: geo.a.y, bx: geo.b.x, by: geo.b.y };
        }).filter(Boolean)
      };
    };

    api.serialize = function () {
      return {
        blocks: blocks.map(function (b) {
          return { id: b.id, x: Math.round(b.x), y: Math.round(b.y), text: b.text, color: b.color || 0 };
        }),
        edges: edges.map(function (e) { return { id: e.id, from: e.from, to: e.to }; })
      };
    };

    /* 窗口或视图变化后把跑到视野外的块拉回来 */
    function reclamp() {
      var rng = visibleRange();
      var moved = false;
      blocks.forEach(function (b) {
        var nx = clamp(b.x, rng.x0, rng.x1), ny = clamp(b.y, rng.y0, rng.y1);
        if (nx !== b.x || ny !== b.y) { b.x = nx; b.y = ny; moved = true; }
      });
      if (moved) changed();
    }

    window.addEventListener('resize', function () {
      reclamp();
      render();
    });

    applyTransform();
    render();
    return api;
  }

  window.Flow.Blocks = { create: create, COLORS: COLORS };
})();
