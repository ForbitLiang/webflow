/* ============================================================
   selftest.js — 纯逻辑自检（无需浏览器）
   运行： node tools/selftest.js
   覆盖：笔迹打包/解包、场景持久化与旧数据迁移、数据清洗、
         .excalidraw 序列化（笔迹 + 字块 + 连线）、PNG 合成流程。
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');

/* ── 最小 DOM 桩 ─────────────────────────────────────────── */

const store = new Map();
const noop = () => {};
function makeCtx() {
  return {
    setTransform: noop, save: noop, restore: noop, clearRect: noop,
    beginPath: noop, moveTo: noop, lineTo: noop, quadraticCurveTo: noop,
    bezierCurveTo: noop, closePath: noop, arc: noop, fill: noop, stroke: noop,
    fillRect: noop, drawImage: noop, fillText: noop, translate: noop, scale: noop,
    measureText: () => ({ width: 10 }),
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    lineCap: '', lineJoin: '', lineWidth: 0, strokeStyle: '', fillStyle: '',
    font: '', textBaseline: '', globalCompositeOperation: ''
  };
}

const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  Blob: class { constructor(p) { this.parts = p; } },
  URL: { createObjectURL: () => 'blob:x', revokeObjectURL: noop },
  document: {
    createElement(tag) {
      if (tag !== 'canvas') return { style: {} };
      return {
        width: 0, height: 0, style: {},
        getContext() { return makeCtx(); },
        toBlob(cb) { cb({ size: 1 }); }
      };
    },
    body: { appendChild: noop, removeChild: noop }
  }
};
sandbox.window = {
  localStorage: {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k)
  }
};

vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'js/store.js'), 'utf8'), sandbox, { filename: 'store.js' });
vm.runInContext(fs.readFileSync(path.join(root, 'js/camera.js'), 'utf8'), sandbox, { filename: 'camera.js' });

const S = sandbox.window.Flow.Store;
const Cam = sandbox.window.Flow.Camera;

/* ── 断言 ────────────────────────────────────────────────── */

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra ? '  \u2192 ' + extra : '')); }
}

/* ── 1. 笔迹打包 / 解包往返 ──────────────────────────────── */

console.log('\n[1] 笔迹打包 · 解包往返');
const strokes = [
  { c: '#eaf2ff', w: 3.0, e: false, p: [[10.234, 20.987, 1.13], [11.5, 22.25, 0.88], [40, 60, 1.0]] },
  { c: '#ffd9a0', w: 5.0, e: false, p: [[5, 5, 0.7], [6, 9, 0.9]] },
  { c: '#eaf2ff', w: 3.0, e: true, p: [[0, 0, 1], [100, 100, 1]] }
];
const packed = S.packStrokes(strokes);
ok('条数一致', packed.length === 3, packed.length);
ok('坐标保留一位小数', packed[0].p[0][0] === 10.2, packed[0].p[0][0]);
ok('橡皮标记保留', packed[2].e === 1, packed[2].e);
const round = S.unpackStrokes(packed);
ok('往返后坐标接近', Math.abs(round[0].p[0][0] - 10.2) < 1e-9, round[0].p[0][0]);
ok('往返后橡皮标记正确', round[2].e === true);
ok('缺失宽度倍数时回落到 1', S.unpackStrokes([{ c: '#fff', w: 2, e: 0, p: [[1, 2]] }])[0].p[0][2] === 1);

/* ── 2. 场景持久化（笔迹 + 字块 + 连线） ─────────────────── */

console.log('\n[2] 场景持久化');
const blocks = [
  { id: 'a', x: 300.4, y: 200.6, text: '第一个念头', color: 1 },
  { id: 'b', x: 700, y: 150, text: '第二个\n换行', color: 0 }
];
const edges = [{ id: 'e1', from: 'a', to: 'b' }];

let res = S.saveScene({ strokes: strokes, blocks: blocks, edges: edges });
ok('保存成功', res.ok === true, JSON.stringify(res));
ok('体积在限制内', res.bytes < 4 * 1024 * 1024, res.bytes + ' bytes');

const scene = S.loadScene();
ok('笔迹条数一致', scene.strokes.length === 3, scene.strokes.length);
ok('字块条数一致', scene.blocks.length === 2, scene.blocks.length);
ok('连线条数一致', scene.edges.length === 1, scene.edges.length);
ok('字块文字保留（含换行）', scene.blocks[1].text === '第二个\n换行', JSON.stringify(scene.blocks[1].text));
ok('字块颜色保留', scene.blocks[0].color === 1, scene.blocks[0].color);
ok('坐标四舍五入到 1 位小数', Math.abs(scene.blocks[0].x - 300.4) < 1e-9, scene.blocks[0].x);

/* ── 3. 数据清洗 ────────────────────────────────────────── */

console.log('\n[3] 脏数据清洗');
const dirty = S.saveScene({
  strokes: [],
  blocks: [
    { id: 'ok', x: 10, y: 20, text: 'x' },
    { id: 'bad', x: 'NaN', y: 20, text: 'y' },
    { id: 'bad2', y: 20 }
  ],
  edges: [
    { id: 'e1', from: 'ok', to: 'ok' },        // 自环，丢掉
    { id: 'e2', from: 'ok', to: 'ghost' },     // 指向不存在的块，丢掉
    { id: 'e3', from: 'ok', to: 'ok2' }
  ]
});
ok('保存不抛异常', dirty.ok === true);
const clean = S.loadScene();
ok('非有限坐标的块被丢掉', clean.blocks.length === 1, clean.blocks.length);
ok('自环与悬空连线被丢掉', clean.edges.length === 0, clean.edges.length);

/* ── 4. 旧版本（只有笔迹）自动迁移 ───────────────────────── */

console.log('\n[4] 旧数据迁移');
store.clear();
store.set('flow.board.v1', JSON.stringify({ v: 1, strokes: S.packStrokes(strokes) }));
const migrated = S.loadScene();
ok('从 flow.board.v1 读到笔迹', migrated.strokes.length === 3, migrated.strokes.length);
ok('迁移后字块为空数组', Array.isArray(migrated.blocks) && migrated.blocks.length === 0);
ok('迁移后连线为空数组', Array.isArray(migrated.edges) && migrated.edges.length === 0);

console.log('\n[5] 损坏数据不致命');
store.clear();
store.set('flow.scene.v2', '{ 这不是 JSON');
let survived = true;
try { S.loadScene(); } catch (e) { survived = false; }
ok('损坏 JSON 不抛异常', survived);

/* ── 5b. 多页（sheet）存档 ──────────────────────────────── */

console.log('\n[5b] 多页存档');
store.clear();
const threeSheets = [
  { id: 'p1', name: '想法', strokes: strokes, blocks: blocks, edges: edges },
  { id: 'p2', name: '第二页', strokes: [], blocks: [{ id: 'x', x: 10, y: 20, text: '别的页', color: 2 }], edges: [] },
  { id: 'p3', name: '空页' }
];
let saveRes3 = S.saveSheets(threeSheets, 1);
ok('多页保存成功', saveRes3.ok === true, JSON.stringify(saveRes3));
let loaded3 = S.loadSheets();
ok('页数正确', loaded3.sheets.length === 3, loaded3.sheets.length);
ok('记住当前页', loaded3.active === 1, loaded3.active);
ok('页名保留', loaded3.sheets[0].name === '想法' && loaded3.sheets[2].name === '空页');
ok('第 1 页笔迹保留', loaded3.sheets[0].strokes.length === 3, loaded3.sheets[0].strokes.length);
ok('第 1 页字块与连线保留',
  loaded3.sheets[0].blocks.length === 2 && loaded3.sheets[0].edges.length === 1);
ok('第 2 页内容是独立的', loaded3.sheets[1].blocks.length === 1 &&
  loaded3.sheets[1].blocks[0].text === '别的页', JSON.stringify(loaded3.sheets[1].blocks));
ok('第 3 页为空', loaded3.sheets[2].strokes.length === 0 && loaded3.sheets[2].blocks.length === 0);
ok('越界的 active 被夹回范围', S.loadSheets.call(null) && (function () {
  S.saveSheets(threeSheets, 99);
  return S.loadSheets().active === 2;
})(), S.loadSheets().active);
ok('页名过长会被截断', (function () {
  S.saveSheets([{ name: 'x'.repeat(80), strokes: [], blocks: [], edges: [] }], 0);
  return S.loadSheets().sheets[0].name.length === S.SHEET_NAME_MAX;
})());
ok('空页名回落到默认', (function () {
  S.saveSheets([{ name: '   ', strokes: [], blocks: [], edges: [] }], 0);
  return S.loadSheets().sheets[0].name === '页';
})());

console.log('\n[5c] 多页的旧版本迁移');
store.clear();
store.set('flow.scene.v2', JSON.stringify({ v: 2, strokes: S.packStrokes(strokes), blocks: blocks, edges: edges }));
const migA = S.loadSheets();
ok('v2 单页 → 一页', migA.sheets.length === 1, migA.sheets.length);
ok('v2 的笔迹被带过来', migA.sheets[0].strokes.length === 3, migA.sheets[0].strokes.length);
ok('v2 的连线被带过来', migA.sheets[0].edges.length === 1, migA.sheets[0].edges.length);

store.clear();
store.set('flow.board.v1', JSON.stringify({ v: 1, strokes: S.packStrokes(strokes) }));
const migB = S.loadSheets();
ok('v1 只有笔迹 → 一页', migB.sheets.length === 1 && migB.sheets[0].strokes.length === 3);
ok('v1 迁移后没有字块', migB.sheets[0].blocks.length === 0);

store.clear();
ok('全空时返回零页（由 app 建第一页）', S.loadSheets().sheets.length === 0);

console.log('\n[5d] 工程文件往返（多页）');
const projText = S.toProjectJSON(threeSheets, 2);
let proj = null, projErr = '';
try { proj = S.parseProject(projText); } catch (e) { projErr = e.message; }
ok('导出的是合法 JSON', !!proj, projErr);
if (proj) {
  ok('往返后页数一致', proj.sheets.length === 3, proj.sheets.length);
  ok('往返后 active 一致', proj.active === 2, proj.active);
  ok('往返后页名一致', proj.sheets[1].name === '第二页', proj.sheets[1].name);
  ok('往返后第 1 页内容一致',
    proj.sheets[0].strokes.length === 3 && proj.sheets[0].blocks.length === 2 && proj.sheets[0].edges.length === 1);
  ok('往返后第 2 页仍是独立的', proj.sheets[1].blocks[0].text === '别的页');
}
ok('也能解析 v2 单页工程文件', S.parseProject(JSON.stringify({ v: 2, strokes: strokes, blocks: blocks })).sheets.length === 1);
let badProj = false;
try { S.parseProject(JSON.stringify({ app: 'flow' })); } catch (e) { badProj = true; }
ok('没有内容的工程文件被拒绝', badProj);

/* ── 6. .excalidraw 导出 ────────────────────────────────── */

console.log('\n[6] .excalidraw 导出');
const data = {
  rects: [
    { id: 'a', x: 100, y: 200, w: 160, h: 44, text: '第一个念头', color: 1, textColor: '#ffd9a0', borderColor: '#ffd9a0' },
    { id: 'b', x: 400, y: 120, w: 120, h: 44, text: '第二个', color: 0, textColor: '#eaf2ff', borderColor: '#bcd6ff' }
  ],
  links: [{ id: 'e1', ax: 262, ay: 222, bx: 398, by: 142 }]
};
const txt = S.toExcalidraw(strokes, data, { source: 'flow-test' });
let doc = null, parseErr = '';
try { doc = JSON.parse(txt); } catch (e) { parseErr = e.message; }
ok('是合法 JSON', !!doc, parseErr);

if (doc) {
  ok('顶层 type 正确', doc.type === 'excalidraw', doc.type);
  ok('顶层 version 为 2', doc.version === 2, doc.version);
  ok('files 字段存在', typeof doc.files === 'object');
  ok('appState 存在', !!doc.appState);

  const freedraw = doc.elements.filter(e => e.type === 'freedraw');
  const rects = doc.elements.filter(e => e.type === 'rectangle');
  const texts = doc.elements.filter(e => e.type === 'text');
  const arrows = doc.elements.filter(e => e.type === 'arrow');

  ok('橡皮擦笔迹被跳过（3 → 2）', freedraw.length === 2, freedraw.length);
  ok('字块导出为 2 个矩形', rects.length === 2, rects.length);
  ok('字块导出为 2 个文字', texts.length === 2, texts.length);
  ok('连线导出为 1 个箭头', arrows.length === 1, arrows.length);

  const rect = rects[0], text = texts[0];
  ok('矩形绑定了文字', Array.isArray(rect.boundElements) &&
    rect.boundElements.length === 1 && rect.boundElements[0].id === text.id);
  ok('文字回指容器', text.containerId === rect.id, text.containerId);
  ok('文字内容一致', text.text === '第一个念头', text.text);
  ok('originalText 也写入', text.originalText === text.text);
  ok('文字颜色沿用字块颜色', text.strokeColor === '#ffd9a0', text.strokeColor);
  ok('矩形圆角已设置', rect.roundness && rect.roundness.type === 3);

  const arrow = arrows[0];
  ok('箭头 points 为 [起点, 终点]', arrow.points.length === 2 &&
    arrow.points[0][0] === 0 && arrow.points[0][1] === 0);
  ok('箭头终点偏移正确', arrow.points[1][0] === 136 && arrow.points[1][1] === -80,
    JSON.stringify(arrow.points[1]));
  ok('箭头宽高为非负', arrow.width >= 0 && arrow.height >= 0, arrow.width + 'x' + arrow.height);
  ok('箭头有箭头头部', arrow.endArrowhead === 'arrow');

  const need = ['id', 'type', 'x', 'y', 'width', 'height', 'angle', 'strokeColor',
    'backgroundColor', 'fillStyle', 'strokeWidth', 'strokeStyle', 'roughness',
    'opacity', 'groupIds', 'seed', 'version', 'versionNonce', 'isDeleted', 'updated'];
  const missing = [];
  doc.elements.forEach(el => need.forEach(k => { if (!(k in el) && missing.indexOf(k) < 0) missing.push(k); }));
  ok('所有元素的公共必需字段齐全', missing.length === 0, '缺少: ' + missing.join(','));
  ok('元素 id 全局唯一', new Set(doc.elements.map(e => e.id)).size === doc.elements.length);
}

/* ── 7. PNG 合成（未给包围盒时的退化路径） ──────────────── */

console.log('\n[7] PNG 合成 · 退化路径');
let pngOk = true, pngErr = '';
let inkCalled = false, contentCalled = false;
try {
  const c = S.exportPNG({
    cssW: 800, cssH: 600, scale: 2, bg: 'dark',
    ink: function () { inkCalled = true; },
    content: function () { contentCalled = true; }
  });
  pngOk = !!c && c.width === 1600 && c.height === 1200;
} catch (e) { pngOk = false; pngErr = e.message; }
ok('没有内容时按视口尺寸出图', pngOk, pngErr || '尺寸不符');
ok('笔迹层被绘制', inkCalled);
ok('内容层被绘制（在底色与笔迹之后）', contentCalled);

/* ── 8. 相机（缩放 / 平移） ─────────────────────────────── */

console.log('\n[8] 相机');
const cam = Cam.create();
ok('初始为 100% 且无偏移', cam.scale === 1 && cam.x === 0 && cam.y === 0);

cam.zoomAt(400, 300, 2);
ok('缩放生效', Math.abs(cam.scale - 2) < 1e-9, cam.scale);
// 锚点下的场景坐标在缩放前后必须一致，否则滚轮会"漂"
ok('锚点下的场景坐标保持不动', Math.abs(cam.toSceneX(400) - 400) < 1e-9, cam.toSceneX(400));
ok('锚点下的场景坐标保持不动 (y)', Math.abs(cam.toSceneY(300) - 300) < 1e-9, cam.toSceneY(300));

cam.set(0, 0, 1);
cam.panBy(50, -30);
ok('平移生效', cam.toScreenX(0) === 50 && cam.toScreenY(0) === -30);
ok('坐标换算可逆', Math.abs(cam.toSceneX(cam.toScreenX(123.5)) - 123.5) < 1e-9);

cam.set(0, 0, 1);
cam.zoomAt(0, 0, 999);
ok('缩放不超过上限', cam.scale === Cam.MAX, cam.scale);
cam.zoomAt(0, 0, 0.0001);
ok('缩放不低于下限', cam.scale === Cam.MIN, cam.scale);

cam.reset();
ok('重置回 100%', cam.scale === 1 && cam.x === 0 && cam.y === 0);

cam.fit({ x: 100, y: 200, w: 400, h: 200 }, 1000, 800, 90);
const fittedLeft = cam.toScreenX(100);
const fittedRight = cam.toScreenX(500);
ok('fit 后内容水平居中', Math.abs((fittedLeft + fittedRight) / 2 - 500) < 1e-6,
  (fittedLeft + fittedRight) / 2);
ok('fit 后内容完整可见', fittedLeft >= 0 && fittedRight <= 1000, fittedLeft + '..' + fittedRight);
ok('fit 只缩小不放大到离谱', cam.scale <= Cam.MAX && cam.scale > 0, cam.scale);

cam.fit(null, 1000, 800);
ok('空内容时 fit 退化为重置', cam.scale === 1 && cam.x === 0);

let camNotified = 0;
cam.onChange = function () { camNotified++; };
cam.panBy(1, 1);
cam.set(0, 0, 1.5);
ok('变更会通知订阅者', camNotified === 2, camNotified);
ok('cssTransform 输出可直接用', /^translate\(0px,0px\) scale\(1\.5\)$/.test(cam.cssTransform()), cam.cssTransform());

/* ── 9. 工程文件往返（导出 → 导入） ─────────────────────── */

console.log('\n[9] 工程文件往返');
const project = {
  app: 'flow', version: 2,
  strokes: strokes,
  blocks: blocks,
  edges: edges
};
const roundTrip = S.parseScene(JSON.stringify(project));
ok('笔迹往返一致', roundTrip.strokes.length === 3, roundTrip.strokes.length);
ok('字块往返一致', roundTrip.blocks.length === 2, roundTrip.blocks.length);
ok('连线往返一致', roundTrip.edges.length === 1, roundTrip.edges.length);
ok('文字往返一致', roundTrip.blocks[1].text === '第二个\n换行', JSON.stringify(roundTrip.blocks[1].text));
ok('颜色往返一致', roundTrip.blocks[0].color === 1, roundTrip.blocks[0].color);

let badJson = false;
try { S.parseScene('{ 坏文件'); } catch (e) { badJson = true; }
ok('坏 JSON 会抛错（供上层提示）', badJson);
let emptyRejected = false;
try { S.parseScene(JSON.stringify({ app: 'x' })); } catch (e) { emptyRejected = true; }
ok('没有内容的文件被拒绝', emptyRejected);

/* ── 10. .excalidraw 导入 ───────────────────────────────── */

console.log('\n[10] .excalidraw 导入');
const xdoc = {
  type: 'excalidraw',
  version: 2,
  source: 'test',
  elements: [
    { id: 'f1', type: 'freedraw', x: 10, y: 20, strokeColor: '#ff0000', strokeWidth: 2,
      points: [[0, 0], [5, 5], [10, 0]] },
    { id: 'f2', type: 'freedraw', x: 0, y: 0, points: [[0, 0]] },              // 点太少 → 跳过
    { id: 'r1', type: 'rectangle', x: 100, y: 100, width: 160, height: 44 },
    { id: 't1', type: 'text', x: 113, y: 109, width: 140, height: 22, text: '方块里的字', containerId: 'r1' },
    { id: 'r2', type: 'rectangle', x: 400, y: 300, width: 120, height: 44 },
    { id: 't2', type: 'text', x: 413, y: 309, width: 100, height: 22, text: '第二个', containerId: 'r2' },
    { id: 't3', type: 'text', x: 700, y: 500, width: 80, height: 22, text: '独立文字' },
    { id: 'a1', type: 'arrow', x: 260, y: 122, width: 140, height: 178,
      points: [[0, 0], [140, 178]],
      startBinding: { elementId: 'r1' }, endBinding: { elementId: 'r2' } },
    { id: 'a2', type: 'arrow', x: 2000, y: 2000, width: 100, height: 0,
      points: [[0, 0], [100, 0]], startBinding: null, endBinding: null },       // 离所有块太远 → 跳过
    { id: 'a3', type: 'arrow', x: 150, y: 120, width: 300, height: 200,
      points: [[0, 0], [300, 200]], startBinding: null, endBinding: null },     // 靠几何就近匹配
    { id: 'x1', type: 'rectangle', x: 0, y: 0, width: 10, height: 10, isDeleted: true }
  ]
};

const xr = S.parseExcalidraw(JSON.stringify(xdoc));
ok('freedraw → 笔迹（点数不足的跳过）', xr.strokes.length === 1, xr.strokes.length);
ok('笔迹坐标已还原为绝对坐标', xr.strokes[0].p[1][0] === 15 && xr.strokes[0].p[1][1] === 25,
  JSON.stringify(xr.strokes[0].p[1]));
ok('笔迹颜色沿用', xr.strokes[0].c === '#ff0000', xr.strokes[0].c);
ok('形状 + 独立文字 → 3 个字块', xr.blocks.length === 3, xr.blocks.length);
ok('已删除元素被忽略', xr.blocks.every(b => b.text !== undefined) && xr.blocks.length === 3);
ok('绑定文字填回容器', xr.blocks[0].text === '方块里的字', xr.blocks[0].text);
ok('第二个容器的文字也对', xr.blocks[1].text === '第二个', xr.blocks[1].text);
ok('独立文字成为字块', xr.blocks[2].text === '独立文字', xr.blocks[2].text);
ok('字块中心由矩形算出', xr.blocks[0].x === 180 && xr.blocks[0].y === 122,
  xr.blocks[0].x + ',' + xr.blocks[0].y);
ok('绑定箭头 → 1 条连线', xr.edges.length === 2, xr.edges.length);
ok('无绑定的箭头靠几何就近匹配上了', xr.edges.length === 2);
ok('落单的箭头被跳过并计数', xr.stats.skippedArrows === 1, xr.stats.skippedArrows);
ok('连线的两端都指向真实字块', xr.edges.every(e =>
  xr.blocks.some(b => b.id === e.from) && xr.blocks.some(b => b.id === e.to)));
ok('导入的字块能通过存档清洗', S.sanitizeBlocks(xr.blocks).length === 3);
ok('导入的连线能通过存档清洗', S.sanitizeEdges(xr.edges, xr.blocks).length === 2);

let notExcalidraw = false;
try { S.parseExcalidraw(JSON.stringify({ type: 'other' })); } catch (e) { notExcalidraw = true; }
ok('非 .excalidraw 文件被拒绝', notExcalidraw);

/* ── 11. 内容包围盒（决定出图范围与"适应视图"） ─────────── */

console.log('\n[11] 内容包围盒');
const narrow = { rects: [], links: [] };
const b1 = S.contentBounds([{ c: '#fff', w: 3, e: false, p: [[100, 100, 1], [200, 150, 1]] }], narrow, 0);
ok('只有笔迹时框住笔迹', b1.x <= 100 && b1.y <= 100 && b1.x + b1.w >= 200 && b1.y + b1.h >= 150,
  JSON.stringify(b1));
ok('包围盒含线宽余量', b1.x < 100 && b1.y < 100);

const withBlocks = {
  rects: [{ id: 'a', x: 500, y: 600, w: 100, h: 40, text: 'x', color: 0, textColor: '#fff', borderColor: '#fff' }],
  links: []
};
const b2 = S.contentBounds([], withBlocks, 0);
ok('只有字块时框住字块', b2.x === 500 && b2.y === 600 && b2.w === 100 && b2.h === 40, JSON.stringify(b2));

const b3 = S.contentBounds(
  [{ c: '#fff', w: 3, e: false, p: [[0, 0, 1], [50, 50, 1]] }],
  { rects: [], links: [{ id: 'e', from: 'a', to: 'b', ax: 0, ay: 0, bx: 900, by: 700 }] },
  10
);
ok('连线端点也算进包围盒', b3.x + b3.w >= 900 && b3.y + b3.h >= 700, JSON.stringify(b3));
const b3NoPad = S.contentBounds(
  [{ c: '#fff', w: 3, e: false, p: [[0, 0, 1], [50, 50, 1]] }],
  { rects: [], links: [{ id: 'e', from: 'a', to: 'b', ax: 0, ay: 0, bx: 900, by: 700 }] },
  0
);
ok('留白参数按边各加 10',
  Math.abs((b3NoPad.x - b3.x) - 10) < 1e-9 && Math.abs((b3NoPad.y - b3.y) - 10) < 1e-9 &&
  Math.abs((b3.w - b3NoPad.w) - 20) < 1e-9 && Math.abs((b3.h - b3NoPad.h) - 20) < 1e-9,
  JSON.stringify(b3) + ' vs ' + JSON.stringify(b3NoPad));
ok('空场景返回 null', S.contentBounds([], { rects: [], links: [] }, 0) === null);

/* ── 12. PNG 合成流程 ───────────────────────────────────── */

console.log('\n[12] PNG 合成 · 按包围盒');
let boxOk = true, boxErr = '', inkCalled2 = false, contentCalled2 = false;
try {
  const c = S.exportPNG({
    box: { x: 100, y: 200, w: 400, h: 300 },
    scale: 2, bg: 'dark',
    ink: function () { inkCalled2 = true; },
    content: function () { contentCalled2 = true; }
  });
  boxOk = !!c && c.width === 800 && c.height === 600;
} catch (e) { boxOk = false; boxErr = e.message; }
ok('按包围盒出图（400x300 → 800x600）', boxOk, boxErr || '尺寸不符');
ok('笔迹层被绘制', inkCalled2);
ok('内容层被绘制', contentCalled2);

/* ── 结果 ────────────────────────────────────────────────── */

console.log('\n' + (fail === 0 ? '全部通过' : '有失败项') + '：' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail === 0 ? 0 : 1);
