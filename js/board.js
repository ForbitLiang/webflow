/* ============================================================
   board.js — 自写白板
   双层画布：base 存放已完成的笔迹，live 只画正在画的那一笔。
   这样实时预览可以用完整平滑重绘，落笔后又与最终结果完全一致。
   支持：画笔（随速度/压感变粗细）、橡皮、撤销、清空、持久化、导出。
   ============================================================ */
(function () {
  'use strict';

  window.Flow = window.Flow || {};

  var INKS = [
    { name: '水光白', c: '#eaf2ff' },
    { name: '暖月黄', c: '#ffd9a0' },
    { name: '冷青', c: '#9fe8e0' }
  ];
  var WIDTHS = [1.8, 3.0, 5.0];
  var ERASER_SCALE = 6;

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function create(opts) {
    var base = opts.base;
    var live = opts.live;
    var bctx = base.getContext('2d');
    var lctx = live.getContext('2d');

    var strokes = (opts.strokes || []).slice();
    var camera = opts.camera || null;
    var current = null;
    var enabled = false;
    var tool = 'pen';
    var inkIndex = 0;
    var widthIndex = 1;
    var dpr = 1;
    var cssW = 1, cssH = 1;
    var highlight = [];                  // 被选中的笔迹（虚线框高亮）
    var drawEnabled = true;              // 选择工具下要关掉落笔
    var undoStack = [];                  // 动作栈：add / del / move
    var UNDO_MAX = 40;

    var api = {
      get strokes() { return strokes; },
      get enabled() { return enabled; },
      onStroke: null,          // (x01, strength, kind) —— 用于联动水面涟漪
      onChange: null           // 笔迹变化 → 由 app.js 统一持久化
    };

    /* 把相机变换应用到某个 2D 上下文 */
    function applyTransform(ctx) {
      var s = camera ? camera.scale : 1;
      var tx = camera ? camera.x : 0;
      var ty = camera ? camera.y : 0;
      ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * tx, dpr * ty);
    }

    /* 屏幕坐标 → 场景坐标 */
    function screenToScene(sx, sy) {
      if (!camera) return [sx, sy];
      return [camera.toSceneX(sx), camera.toSceneY(sy)];
    }

    /* ── 尺寸 ─────────────────────────────────────────────── */

    function resize() {
      var rect = base.getBoundingClientRect();
      cssW = Math.max(1, Math.round(rect.width || window.innerWidth));
      cssH = Math.max(1, Math.round(rect.height || window.innerHeight));
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      [base, live].forEach(function (c) {
        c.width = Math.round(cssW * dpr);
        c.height = Math.round(cssH * dpr);
      });
      bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      redraw();
    }

    /* ── 绘制 ─────────────────────────────────────────────── */

    function paintStroke(ctx, s) {
      var p = s.p;
      if (!p || p.length === 0) return;
      ctx.save();
      ctx.globalCompositeOperation = s.e ? 'destination-out' : 'source-over';
      ctx.strokeStyle = s.e ? '#000' : s.c;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      var sw = s.w * (s.e ? ERASER_SCALE : 1);

      if (p.length === 1) {
        ctx.beginPath();
        ctx.arc(p[0][0], p[0][1], Math.max(0.6, sw * 0.5), 0, Math.PI * 2);
        ctx.fillStyle = s.e ? '#000' : s.c;
        ctx.fill();
        ctx.restore();
        return;
      }

      // 中点二次曲线平滑，逐段宽度
      var i, prevMid = [p[0][0], p[0][1]];
      for (i = 1; i < p.length; i++) {
        var cur = p[i];
        var mid = i < p.length - 1 ? [(cur[0] + p[i + 1][0]) * 0.5, (cur[1] + p[i + 1][1]) * 0.5] : cur;
        ctx.beginPath();
        ctx.moveTo(prevMid[0], prevMid[1]);
        ctx.quadraticCurveTo(cur[0], cur[1], mid[0], mid[1]);
        ctx.lineWidth = Math.max(0.5, sw * (cur[2] == null ? 1 : cur[2]));
        ctx.stroke();
        prevMid = mid;
      }
      ctx.restore();
    }

    function clearLayer(ctx) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, base.width, base.height);
      ctx.restore();
    }

    function redraw() {
      clearLayer(bctx);
      applyTransform(bctx);
      for (var i = 0; i < strokes.length; i++) paintStroke(bctx, strokes[i]);
      clearLayer(lctx);
      applyTransform(lctx);
      if (current) paintStroke(lctx, current);
      drawHighlights(lctx);
    }

    /* 视图（缩放 / 平移）变化后重画 */
    api.viewChanged = function () { redraw(); };

    /* ── 变更通知（持久化交给 app.js） ─────────────────────── */

    function markDirty() {
      if (api.onChange) api.onChange();
    }

    /* ── 选择与整组平移（笔迹这一层） ─────────────────────── */

    // 笔迹的包围盒（含线宽），世界坐标
    function strokeRect(s) {
      var G = window.Flow.Geom;
      var r = G.rectOfPoints(s.p);
      if (!r) return null;
      var half = (s.w || 2) * (s.e ? 6 : 1) * 0.5 + 1;
      return G.expand(r, half);
    }

    api.strokeRect = strokeRect;

    /* 与框选矩形相交的笔迹 */
    api.strokesInRect = function (rect) {
      var G = window.Flow.Geom, out = [];
      for (var i = 0; i < strokes.length; i++) {
        var r = strokeRect(strokes[i]);
        if (r && G.rectsIntersect(r, rect)) out.push(strokes[i]);
      }
      return out;
    };

    /* 某点落在哪条笔迹上（从后往前，后画的在上层） */
    api.strokeAt = function (x, y, tol) {
      var G = window.Flow.Geom;
      tol = tol == null ? 6 : tol;
      for (var i = strokes.length - 1; i >= 0; i--) {
        var s = strokes[i];
        if (s.e) continue;
        var r = strokeRect(s);
        if (!r || !G.pointInRect(G.expand(r, tol), x, y)) continue;
        var reach = tol + (s.w || 2) * 0.5;
        if (G.distToPolylineSq(x, y, s.p) <= reach * reach) return s;
      }
      return null;
    };

    /* 选中高亮：在 live 层画虚线框（那一层在 select 模式下是空闲的） */
    api.setHighlight = function (list) {
      highlight = list || [];
      redraw();
    };

    /* 整组平移：以快照为基准做绝对偏移，避免逐帧累加产生漂移 */
    api.snapshotStrokes = function (list) {
      return (list || []).map(function (s) {
        return {
          s: s,
          p: s.p.map(function (q) { return [q[0], q[1], q[2]]; })
        };
      });
    };

    api.applyStrokesOffset = function (snap, dx, dy) {
      for (var i = 0; i < snap.length; i++) {
        var rec = snap[i], src = rec.p, dst = rec.s.p;
        for (var k = 0; k < dst.length; k++) {
          dst[k][0] = src[k][0] + dx;
          dst[k][1] = src[k][1] + dy;
        }
      }
      redraw();
    };

    api.commitStrokes = function () { markDirty(); };

    /* 画选中虚线框（世界坐标，跟着相机缩放） */
    function drawHighlights(ctx) {
      if (!highlight.length) return;
      ctx.save();
      ctx.setLineDash([7, 6]);
      ctx.lineWidth = 1.3;
      ctx.strokeStyle = 'rgba(159, 196, 255, .9)';
      for (var i = 0; i < highlight.length; i++) {
        var r = strokeRect(highlight[i]);
        if (!r) continue;
        ctx.strokeRect(r.x, r.y, r.w, r.h);
      }
      ctx.restore();
    }

    api.paintInk = function (ctx) {
      for (var i = 0; i < strokes.length; i++) paintStroke(ctx, strokes[i]);
    };

    api.getStrokes = function () { return strokes; };

    /* ── 输入 ─────────────────────────────────────────────── */

    function pos(e) {
      var r = base.getBoundingClientRect();
      return screenToScene(e.clientX - r.left, e.clientY - r.top);
    }

    // 速度越快越细，压感设备再叠加一次压力
    function widthFactor(dist, pressure) {
      var f = clamp(1.12 - dist / 80, 0.62, 1.18);
      if (pressure && pressure > 0 && pressure < 1) f *= 0.62 + pressure * 0.8;
      return clamp(f, 0.4, 1.4);
    }

    function beginStroke(x, y, pressure) {
      current = {
        c: INKS[inkIndex].c,
        w: WIDTHS[widthIndex],
        e: tool === 'eraser',
        p: [[x, y, clamp(0.62 + (pressure || 0.5) * 0.6, 0.5, 1.2)]]
      };
    }

    function extendStroke(x, y, pressure) {
      if (!current) return;
      var last = current.p[current.p.length - 1];
      var dx = x - last[0], dy = y - last[1];
      var dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 0.6) return;                      // 过滤抖动
      current.p.push([x, y, widthFactor(dist, pressure)]);

      if (current.e) {
        // 橡皮：直接作用在已完成的图层上，无需平滑
        applyTransform(bctx);
        paintStroke(bctx, { c: current.c, w: current.w, e: true, p: [last, [x, y, current.p[current.p.length - 1][2]]] });
      } else {
        clearLayer(lctx);
        applyTransform(lctx);
        paintStroke(lctx, current);
      }

      if (api.onStroke) {
        api.onStroke(x / cssW, clamp(dist / 22, 0.15, 1), current.e ? 'erase' : 'ink');
      }
    }

    function endStroke() {
      if (!current) return;
      if (current.p.length === 1) {
        // 点一下也要留下一个点
        var p = current.p[0];
        current.p.push([p[0] + 0.01, p[1] + 0.01, p[2]]);
      }
      strokes.push(current);
      if (!current.e) {
        applyTransform(bctx);
        paintStroke(bctx, current);
      }
      // 登记一次可撤销的"新增"
      pushUndoAction({ type: 'add', s: current });
      current = null;
      clearLayer(lctx);
      markDirty();
    }

    var drawing = false;
    var activeId = null;

    function onDown(e) {
      if (!enabled || !drawEnabled || e.button > 1) return;
      if (e.pointerType === 'touch' && e.isPrimary === false) return;
      activeId = e.pointerId;
      drawing = true;
      if (live.setPointerCapture) { try { live.setPointerCapture(e.pointerId); } catch (err) {} }
      var q = pos(e);
      beginStroke(q[0], q[1], e.pressure);
      e.preventDefault();
    }

    function onMove(e) {
      if (!enabled || !drawEnabled) return;
      if (!drawing || e.pointerId !== activeId) return;
      // getCoalescedEvents 对合成事件会返回空数组，这里必须兜底
      var coalesced = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
      var batch = (coalesced && coalesced.length) ? coalesced : [e];
      for (var i = 0; i < batch.length; i++) {
        var q = pos(batch[i]);
        extendStroke(q[0], q[1], batch[i].pressure);
      }
      e.preventDefault();
    }

    function onUp(e) {
      if (!drawing || (activeId !== null && e.pointerId !== activeId)) return;
      drawing = false;
      activeId = null;
      endStroke();
      e.preventDefault();
    }

    live.addEventListener('pointerdown', onDown);
    live.addEventListener('pointermove', onMove);
    live.addEventListener('pointerup', onUp);
    live.addEventListener('pointercancel', onUp);
    live.addEventListener('pointerleave', function (e) {
      if (drawing && e.pointerId === activeId) { drawing = false; activeId = null; endStroke(); }
    });
    live.addEventListener('contextmenu', function (e) { if (enabled) e.preventDefault(); });

    /* ── 工具与开关 ───────────────────────────────────────── */

    api.setEnabled = function (v) {
      enabled = !!v;
      if (!enabled) {
        if (drawing) { drawing = false; endStroke(); }
        if (current) { current = null; clearLayer(lctx); }
      }
      return enabled;
    };

    api.setTool = function (t) { tool = t === 'eraser' ? 'eraser' : 'pen'; return tool; };
    api.getTool = function () { return tool; };

    /* 选择工具下关掉落笔：画布仍然接收事件（用于框选），但不再画线 */
    api.setDrawEnabled = function (v) {
      drawEnabled = !!v;
      if (!drawEnabled) {
        if (drawing) { drawing = false; activeId = null; endStroke(); }
        if (current) { current = null; clearLayer(lctx); }
      }
      return drawEnabled;
    };
    api.isDrawEnabled = function () { return drawEnabled; };

    api.setInk = function (i) { inkIndex = clamp(i | 0, 0, INKS.length - 1); return inkIndex; };
    api.getInk = function () { return inkIndex; };

    api.cycleWidth = function () {
      widthIndex = (widthIndex + 1) % WIDTHS.length;
      return { index: widthIndex, width: WIDTHS[widthIndex] };
    };
    api.getWidth = function () { return WIDTHS[widthIndex]; };

    /* ── 撤销：动作栈 ─────────────────────────────────────────
       原来是"弹出最后一笔"，只能撤销画笔；一旦支持多选删除和整组平移，
       那种做法就撤不了任意位置的删除、也撤不了移动。
       改成记录动作：add / del / move，各自带足够的信息回滚。
       换页、导入、清空会清栈（跨页撤销没有意义）。
       ──────────────────────────────────────────────────────── */

    function pushUndoAction(a) {
      undoStack.push(a);
      if (undoStack.length > UNDO_MAX) undoStack.shift();
    }

    api.undo = function () {
      var a = undoStack.pop();
      if (!a) return false;
      if (a.type === 'add') {
        var i = strokes.indexOf(a.s);
        if (i >= 0) strokes.splice(i, 1);
      } else if (a.type === 'del') {
        // 按原下标插回，保持层次顺序
        a.items.slice().sort(function (x, y) { return x.i - y.i; }).forEach(function (it) {
          strokes.splice(Math.min(it.i, strokes.length), 0, it.s);
        });
      } else if (a.type === 'move') {
        a.items.forEach(function (it) {
          for (var k = 0; k < it.s.p.length; k++) {
            it.s.p[k][0] = it.p[k][0];
            it.s.p[k][1] = it.p[k][1];
          }
        });
      }
      redraw();
      markDirty();
      return true;
    };

    api.undoDepth = function () { return undoStack.length; };

    /* 整组平移结束后登记一次可撤销的移动 */
    api.pushMoveUndo = function (snap) {
      if (!snap || !snap.length) return;
      pushUndoAction({
        type: 'move',
        items: snap.map(function (r) { return { s: r.s, p: r.p }; })
      });
    };

    /* 删除指定的若干笔迹（可撤销） */
    api.removeStrokes = function (list) {
      if (!list || !list.length) return 0;
      var items = [];
      for (var i = strokes.length - 1; i >= 0; i--) {
        var idx = list.indexOf(strokes[i]);
        if (idx >= 0) { items.push({ s: strokes[i], i: i }); strokes.splice(i, 1); }
      }
      if (!items.length) return 0;
      pushUndoAction({ type: 'del', items: items });
      highlight = highlight.filter(function (s) { return list.indexOf(s) < 0; });
      redraw();
      markDirty();
      return items.length;
    };

    api.clear = function () {
      if (!strokes.length) return false;
      strokes.length = 0;
      undoStack.length = 0;      // 清空是"不可撤销"的（界面上也这么提示）
      highlight = [];
      redraw();
      markDirty();
      return true;
    };

    /* 整体替换笔迹（换页 / 导入用）。跨页撤销没有意义，直接清栈。 */
    api.replaceStrokes = function (list) {
      strokes.length = 0;
      (list || []).forEach(function (s) { strokes.push(s); });
      current = null;
      undoStack.length = 0;
      highlight = [];
      redraw();
      markDirty();
    };

    api.count = function () { return strokes.length; };

    api.redraw = redraw;
    api.resize = resize;

    api.inks = INKS;
    api.widths = WIDTHS;
    api.getSize = function () { return { w: cssW, h: cssH }; };

    window.addEventListener('resize', resize);
    resize();
    return api;
  }

  window.Flow.Board = { create: create, INKS: INKS, WIDTHS: WIDTHS };
})();
