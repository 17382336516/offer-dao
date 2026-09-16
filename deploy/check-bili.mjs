// 验证 B站 cookie 是否生效（用 Node 读取 .env，避免 bash source 解析特殊字符出错）
// 用法： node deploy/check-bili.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '..');
const envPath = path.join(APP_DIR, '.env');

if (!fs.existsSync(envPath)) {
  console.log('[ERR] .env 不存在');
  process.exit(1);
}

// 与 server/rag.mjs loadDotEnv 一致的解析方式：按行取 key=value，去掉首尾引号
let cookie = '';
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*BILI_COOKIE\s*=\s*(.*)$/);
  if (m) cookie = m[1].trim().replace(/^["']|["']$/g, '');
}

console.log('BILI_COOKIE 长度:', cookie.length);
if (!cookie || cookie.length < 50) {
  console.log('[ERR] cookie 缺失或过短，请检查 .env 中的 BILI_COOKIE 行');
  process.exit(1);
}
console.log('包含 SESSDATA:', /SESSDATA=/.test(cookie));
console.log('包含 bili_jct:', /bili_jct=/.test(cookie));

const test = async (bvid, cid) => {
  try {
    const r = await fetch(`https://api.bilibili.com/x/player/v2?bvid=${bvid}&cid=${cid}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', Cookie: cookie },
      signal: AbortSignal.timeout(15000),
    });
    const j = await r.json();
    const d = (j && j.data && j.data.subtitle) || {};
    const pub = (d.subtitles || []).length;
    const need = (d.need_login_subtitle || []).length;
    console.log(`  ${bvid} -> code=${j.code} 公开字幕=${pub} 需登录字幕=${need}`);
    return pub + need;
  } catch (e) {
    console.log(`  ${bvid} -> 请求失败: ${e.message}`);
    return 0;
  }
};

console.log('\n测试字幕接口:');
const ok1 = await test('BV1nWGX6DEy9', 38670894143);
const ok2 = await test('BV11NNAz5EKn', 36524392845);
const ok3 = await test('BV14jNRzZEFL', 30640767135);

console.log('\n有字幕的视频数:', [ok1, ok2, ok3].filter((n) => n > 0).length, '/ 3');
if (ok1 + ok2 + ok3 > 0) {
  console.log('\n[OK] cookie 生效，字幕可获取，视频可以正常进入学习计划');
} else {
  console.log('\n[WARN] 仍未取到字幕。可能原因：cookie 已过期/不完整，或这几个视频本身无字幕。');
}
process.exit(0);
