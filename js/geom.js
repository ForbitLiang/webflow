/* ============================================================
   geom.js — 纯几何工具
   框选、命中测试都要用到这些；单独成模块是为了能被 selftest 直接断言，
   不必开浏览器、也不必构造 DOM。
   ============================================================ */
(function () {
  'use strict';

  window.Flow = window.Flow || {};

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  /* 一组点 → 轴对齐包围盒。没有有效点则返回 null。 */
  function rectOfPoints(points) {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    if (!points) return null;
    for (var i = 0; i < points.length; i++) {
      var p = points[i];
      if (!p || !isFinite(p[0]) || !isFinite(p[1])) continue;
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
    }
    if (!isFinite(minX)) return null;
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  /* 两个角点 → 规范化矩形（宽高恒为正） */
  function rectFromCorners(ax, ay, bx, by) {
    return {
      x: Math.min(ax, bx),
      y: Math.min(ay, by),
      w: Math.abs(ax - bx),
      h: Math.abs(ay - by)
    };
  }

  function expand(r, m) {
    return { x: r.x - m, y: r.y - m, w: r.w + m * 2, h: r.h + m * 2 };
  }

  function rectsIntersect(a, b) {
    if (!a || !b) return false;
    return !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y);
  }

  function rectContainsRect(outer, inner) {
    if (!outer || !inner) return false;
    return inner.x >= outer.x && inner.y >= outer.y &&
           inner.x + inner.w <= outer.x + outer.w &&
           inner.y + inner.h <= outer.y + outer.h;
  }

  function pointInRect(r, x, y) {
    if (!r) return false;
    return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
  }

  function unionRect(a, b) {
    if (!a) return b;
    if (!b) return a;
    var x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y);
    var x1 = Math.max(a.x + a.w, b.x + b.w), y1 = Math.max(a.y + a.h, b.y + b.h);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  /* 点到线段距离的平方 —— 笔迹与连线的精确命中用 */
  function distToSegmentSq(px, py, ax, ay, bx, by) {
    var dx = bx - ax, dy = by - ay;
    var len2 = dx * dx + dy * dy;
    var t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = clamp(t, 0, 1);
    var cx = ax + dx * t, cy = ay + dy * t;
    var ex = px - cx, ey = py - cy;
    return ex * ex + ey * ey;
  }

  /* 折线（笔迹）到某点的最短距离平方 */
  function distToPolylineSq(px, py, points) {
    if (!points || points.length === 0) return Infinity;
    if (points.length === 1) {
      var ex = px - points[0][0], ey = py - points[0][1];
      return ex * ex + ey * ey;
    }
    var best = Infinity;
    for (var i = 1; i < points.length; i++) {
      var d = distToSegmentSq(px, py,
        points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]);
      if (d < best) best = d;
    }
    return best;
  }

  /* 三次贝塞尔上取一点（连线命中用） */
  function cubicAt(a, c1, c2, b, t) {
    var mt = 1 - t;
    var w0 = mt * mt * mt, w1 = 3 * mt * mt * t, w2 = 3 * mt * t * t, w3 = t * t * t;
    return {
      x: w0 * a.x + w1 * c1.x + w2 * c2.x + w3 * b.x,
      y: w0 * a.y + w1 * c1.y + w2 * c2.y + w3 * b.y
    };
  }

  /* 把一条三次贝塞尔近似成折线，再算到点的距离平方 */
  function distToCubicSq(px, py, a, c1, c2, b, steps) {
    steps = steps || 18;
    var prev = a, best = Infinity;
    for (var i = 1; i <= steps; i++) {
      var cur = cubicAt(a, c1, c2, b, i / steps);
      var d = distToSegmentSq(px, py, prev.x, prev.y, cur.x, cur.y);
      if (d < best) best = d;
      prev = cur;
    }
    return best;
  }

  /* 把共享位移限制住，使一组起点平移后仍全部落在范围内。
     返回可用的 dx（或 dy）区间，避免"抓着最上面那个块拖，其余块飞出屏幕"。
     fits=false 表示这组对象本身就装不进给定范围——调用方应当据此**放弃夹取**，
     否则位移会被固定成一个与鼠标无关的定值，拖起来不跟手。 */
  function clampSharedDelta(starts, lo, hi) {
    var dMin = -Infinity, dMax = Infinity;
    for (var i = 0; i < starts.length; i++) {
      var v = starts[i];
      if (!isFinite(v)) continue;
      if (lo - v > dMin) dMin = lo - v;
      if (hi - v < dMax) dMax = hi - v;
    }
    var fits = dMin <= dMax;
    if (!fits) { var mid = (dMin + dMax) / 2; dMin = dMax = mid; }
    return { min: dMin, max: dMax, fits: fits };
  }

  window.Flow.Geom = {
    rectOfPoints: rectOfPoints,
    rectFromCorners: rectFromCorners,
    expand: expand,
    rectsIntersect: rectsIntersect,
    rectContainsRect: rectContainsRect,
    pointInRect: pointInRect,
    unionRect: unionRect,
    distToSegmentSq: distToSegmentSq,
    distToPolylineSq: distToPolylineSq,
    cubicAt: cubicAt,
    distToCubicSq: distToCubicSq,
    clampSharedDelta: clampSharedDelta
  };
})();
