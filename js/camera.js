/* ============================================================
   camera.js — 白板视图相机（缩放 + 平移）
   场景坐标 → 屏幕坐标：  screen = scene * scale + offset
   笔迹画布、字块 DOM、连线 SVG 三层共用同一个相机，
   所以三者永远对得齐。
   ============================================================ */
(function () {
  'use strict';

  window.Flow = window.Flow || {};

  var MIN_SCALE = 0.25;
  var MAX_SCALE = 5;

  function create() {
    var api = {
      x: 0,
      y: 0,
      scale: 1,
      min: MIN_SCALE,
      max: MAX_SCALE,
      onChange: null
    };

    function notify() { if (api.onChange) api.onChange(); }

    function clampScale(s) {
      return Math.max(api.min, Math.min(api.max, s));
    }

    /* 坐标换算 */
    api.toSceneX = function (sx) { return (sx - api.x) / api.scale; };
    api.toSceneY = function (sy) { return (sy - api.y) / api.scale; };
    api.toScreenX = function (x) { return x * api.scale + api.x; };
    api.toScreenY = function (y) { return y * api.scale + api.y; };

    /* 以屏幕上某个点为锚点缩放：锚点下的内容保持不动。
       滚轮缩放时锚点就是鼠标位置。 */
    api.zoomAt = function (sx, sy, factor) {
      var next = clampScale(api.scale * factor);
      if (next === api.scale) return false;
      var k = next / api.scale;
      api.x = sx - (sx - api.x) * k;
      api.y = sy - (sy - api.y) * k;
      api.scale = next;
      notify();
      return true;
    };

    /* 以屏幕中心为锚点缩放（工具栏按钮用） */
    api.zoomCenter = function (factor, vw, vh) {
      return api.zoomAt(vw / 2, vh / 2, factor);
    };

    api.panBy = function (dx, dy) {
      if (!dx && !dy) return;
      api.x += dx;
      api.y += dy;
      notify();
    };

    api.reset = function () {
      api.x = 0;
      api.y = 0;
      api.scale = 1;
      notify();
    };

    /* 缩放到刚好装下某个场景包围盒 */
    api.fit = function (box, vw, vh, pad) {
      pad = pad == null ? 90 : pad;
      if (!box || box.w <= 0 || box.h <= 0) { api.reset(); return; }
      var s = clampScale(Math.min((vw - pad * 2) / box.w, (vh - pad * 2) / box.h));
      api.scale = s;
      api.x = (vw - box.w * s) / 2 - box.x * s;
      api.y = (vh - box.h * s) / 2 - box.y * s;
      notify();
    };

    api.set = function (x, y, scale) {
      api.x = x;
      api.y = y;
      api.scale = clampScale(scale);
      notify();
    };

    /* 供 DOM / SVG 层直接套用 */
    api.cssTransform = function () {
      return 'translate(' + api.x + 'px,' + api.y + 'px) scale(' + api.scale + ')';
    };

    return api;
  }

  window.Flow.Camera = { create: create, MIN: MIN_SCALE, MAX: MAX_SCALE };
})();
