#!/usr/bin/env node
/**
 * 检查 WXML 里的事件绑定，在对应的 JS 里是否真的定义了处理方法。
 *
 * 为什么需要：小程序编译期不校验「事件绑定名 <-> Page 方法」的对应关系。
 * WXML 写 bindtap="foo" 而 JS 里没有 foo，编译照样通过，只有用户点了才报错。
 *
 * 用法：
 *   node tools/check-bindings.js [miniprogram-root]
 *   miniprogram-root 是含 app.json 的那一层目录，省略则用当前目录。
 *
 * 退出码：
 *   0  全部绑定都有对应方法
 *   1  发现缺失
 *   2  用法 / 配置错误
 *
 * 依赖：无。只用 Node 内置模块。
 *
 * ---------------------------------------------------------------------------
 * 局限（用之前请看，这个脚本不是零误报的）：
 *
 * 1. 方法名用缩进启发式识别，不是 AST 解析。只扫描 Page({...}) 起始位置之后
 *    的内容，以避开文件上方的辅助函数；但写法非常规时仍可能误报或漏报。
 *    需要零误报请用 @babel/parser 解析 Page 对象的顶层 key。
 * 2. 主要面向 Page。自定义组件用 Component({ methods: {...} })，结构多一层，
 *    本脚本会顺带扫描但不保证准确。
 * 3. 动态绑定（bindtap="{{handler}}"）会被跳过，无法静态判断。
 * 4. 不校验 app.json 本身是否合法，不校验页面文件是否齐全。
 *
 * 结论只作为提示，不替代人工确认。抓到问题时先看一眼代码再改。
 * ---------------------------------------------------------------------------
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(process.argv[2] || process.cwd());
const APP_JSON = path.join(ROOT, 'app.json');

if (!fs.existsSync(APP_JSON)) {
  console.error('[ERROR] 找不到 app.json：' + APP_JSON);
  console.error('请把含 app.json 的那一层目录作为参数传进来。');
  process.exit(2);
}

let app;
try {
  app = JSON.parse(fs.readFileSync(APP_JSON, 'utf8'));
} catch (e) {
  console.error('[ERROR] app.json 解析失败：' + e.message);
  process.exit(2);
}

// 收集页面路径：主包 + 分包
function collectPages(app) {
  const out = [];
  for (const p of app.pages || []) out.push(p);
  for (const sub of app.subpackages || app.subPackages || []) {
    for (const p of sub.pages || []) {
      out.push((sub.root.replace(/\/$/, '') + '/' + p).replace(/^\//, ''));
    }
  }
  return out;
}

// 不是方法名的语言关键字
const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return',
  'const', 'let', 'var', 'else', 'try', 'new', 'typeof', 'do',
  'async', 'await', 'class', 'this', 'super', 'delete', 'in', 'of'
]);

/**
 * 从 JS 里提取方法名。
 * 只扫 Page({ / Component({ 起始位置之后的内容，避开文件上方的辅助函数。
 */
function methodsOf(file) {
  const src = fs.readFileSync(file, 'utf8');
  const start = src.search(/\b(?:Page|Component)\s*\(\s*\{/);
  if (start < 0) return null;   // 不是页面 / 组件文件

  const body = src.slice(start);
  const out = new Set();
  // 不要求行首：AI 生成短代码时常把多个方法挤在一行，行首约束会整片漏检。
  // 用「空白 / 逗号 / 花括号 / 分号」作为前导边界。
  const re = /(?:^|[\s,{;])(?:async\s+)?([A-Za-z_$][\w$]*)\s*(?:\(|:\s*(?:async\s*)?(?:function\b|\())/g;
  let m;
  while ((m = re.exec(body))) {
    if (!KEYWORDS.has(m[1])) out.add(m[1]);
  }
  return out;
}

/** 从 WXML 里提取事件绑定名，跳过动态绑定 */
function bindingsOf(file) {
  const src = fs.readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const out = new Set();
  const re = /\b(?:bind|catch|capture-bind|capture-catch)[:]?([a-zA-Z]+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(src))) {
    const name = m[2].trim();
    if (!name || name.includes('{{')) continue;
    out.add(name);
  }
  return out;
}

const pages = collectPages(app);
let missing = 0;
let skipped = 0;

for (const page of pages) {
  const wxml = path.join(ROOT, page + '.wxml');
  const js = path.join(ROOT, page + '.js');

  if (!fs.existsSync(wxml) || !fs.existsSync(js)) {
    console.log('[SKIP] ' + page + '（文件不全）');
    skipped++;
    continue;
  }

  const defined = methodsOf(js);
  if (defined === null) {
    console.log('[SKIP] ' + page + '.js（未找到 Page / Component 定义）');
    skipped++;
    continue;
  }

  for (const name of bindingsOf(wxml)) {
    if (!defined.has(name)) {
      console.log('[MISSING] ' + page + '.wxml -> ' + name);
      missing++;
    }
  }
}

console.log('');
console.log('扫描 ' + pages.length + ' 个页面，跳过 ' + skipped + ' 个，发现 ' + missing + ' 处未定义');
if (missing) {
  console.log('提示：本脚本是启发式检查，请先打开对应 JS 确认，再决定是否修改。');
}
process.exit(missing ? 1 : 0);
