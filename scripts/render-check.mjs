// 用 Edge headless 渲染页面并导出 DOM + 控制台错误
const { execFileSync } = await import('node:child_process');
import fs from 'node:fs';

const edge = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
console.log('Edge:', edge);
const dom = execFileSync(edge, ['--headless=new', '--disable-gpu', '--dump-dom',
  '--virtual-time-budget=8000', 'http://127.0.0.1:30041/'], { maxBuffer: 20 * 1024 * 1024 }).toString();
console.log('DOM 长度:', dom.length);
const m = dom.match(/<div id="app">([\s\S]*?)<\/body>/);
console.log('app 渲染内容长度:', m ? m[1].length : 'N/A');
for (const kw of ['打分', '审查', '相册', '任务', '暂无']) {
  console.log(`包含「${kw}」:`, dom.includes(kw));
}
