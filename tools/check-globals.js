/* ============================================================
   check-globals.js — 源码级检查：裸调用只挂在 api 上的函数

   为什么需要它：
     blocks.js / board.js / app.js 里有一批函数只写成 `api.xxx = function(){}`，
     并没有本地 `function xxx(){}` 声明。此时如果代码里裸写 `xxx(...)`，
     运行到那一行就会 ReferenceError —— 而且只在特定交互路径上才会触发，
     自检如果不走那条路径就发现不了。
     （真实踩过：节点拖动里的 beginMove() 少了 api. 前缀，导致字块拖不动。）

   运行： node tools/check-globals.js
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const files = ['js/board.js', 'js/blocks.js', 'js/app.js', 'js/water.js',
               'js/audio.js', 'js/store.js', 'js/camera.js', 'js/sun.js', 'js/geom.js'];

let problems = 0;
let checked = 0;

files.forEach(function (rel) {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) return;
  const src = fs.readFileSync(full, 'utf8');
  const lines = src.split('\n');
  checked++;

  // 本文件里的本地函数声明
  const declared = new Set();
  src.replace(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g, function (m, name) {
    declared.add(name);
    return m;
  });

  // 本文件里挂到 api（或其它对象）上的成员名
  const apiOnly = new Set();
  src.replace(/\b(?:api|window\.Flow\.\w+)\s*\.\s*([A-Za-z_$][\w$]*)\s*=/g, function (m, name) {
    apiOnly.add(name);
    return m;
  });

  // 裸调用：名字前面不是 . 也不是字母/数字/下划线/$
  const re = /(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g;

  // 先剥掉字符串字面量，否则 'translate(...) scale(...)' 这类会被误报
  function stripStrings(s) {
    return s
      .replace(/'(?:\\.|[^'\\])*'/g, "''")
      .replace(/"(?:\\.|[^"\\])*"/g, '""')
      .replace(/`(?:\\.|[^`\\])*`/g, '``');
  }

  lines.forEach(function (line, i) {
    const noComment = stripStrings(line.replace(/\/\/.*$/, ''));
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(noComment)) !== null) {
      const name = m[2];
      // 关键字与常见内建不算
      if (/^(if|for|while|switch|catch|return|typeof|new|function|do|else|void|delete|in|of|case)$/.test(name)) continue;
      if (declared.has(name)) continue;          // 本地有声明 → 合法
      if (!apiOnly.has(name)) continue;          // 既不是本地函数也不是 api 成员 → 交给浏览器报错
      // 到这里说明：这个名字在本文件里只以 api.xxx 形式出现，却裸调了
      problems++;
      console.log('  ✗ ' + rel + ':' + (i + 1) + '  裸调用了 api-only 的 ' + name + '()');
      console.log('      ' + line.trim());
    }
  });
});

console.log('');
if (problems) {
  console.log('发现 ' + problems + ' 处裸调用（检查了 ' + checked + ' 个文件）');
  process.exit(1);
} else {
  console.log('全部通过：没有裸调用 api-only 函数（检查了 ' + checked + ' 个文件）');
}
