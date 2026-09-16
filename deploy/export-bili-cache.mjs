// 导出本地已缓存的真实 B站视频（历史真实搜索结果）为种子文件
// 用途：服务器（阿里云 IP）被 B站风控无法实时搜索，用本地已抓取的真实视频作为固定视频库。
// 用法： node deploy/export-bili-cache.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '..');
const mod = await import(pathToFileURL(path.join(APP_DIR, 'server', 'db.mjs')).href);
const T = mod.db.state.tables;

const resCache = Array.isArray(T.bilibili_resource_cache) ? T.bilibili_resource_cache : [];
const searchCache = Array.isArray(T.bilibili_search_cache) ? T.bilibili_search_cache : [];

console.log('评分缓存:', resCache.length, '条');
console.log('搜索缓存:', searchCache.length, '条');

// 搜索缓存：保留 results，导入时会刷新时间戳（规避 24h TTL 过期）
const searches = searchCache.map((s) => {
  let results = [];
  try { results = JSON.parse(s.results || '[]'); } catch { results = []; }
  return { keyword: s.keyword, results };
}).filter((s) => s.keyword && Array.isArray(s.results) && s.results.length);

// 评分缓存：按 (bvid, skill) 去重
const seen = new Set();
const videos = [];
for (const r of resCache) {
  if (!r || !r.bvid || !r.skill) continue;
  const key = r.bvid + '::' + r.skill;
  if (seen.has(key)) continue;
  seen.add(key);
  videos.push({
    bvid: r.bvid,
    title: r.title || '',
    url: r.url || '',
    author: r.author || '',
    skill: r.skill,
    search_keyword: r.search_keyword || '',
    score_json: r.score_json || null,
    score_version: r.score_version || null,
    subtitle_status: r.subtitle_status || null,
    duration: r.duration ?? null,
  });
}

const bySkill = {};
for (const v of videos) (bySkill[v.skill] = bySkill[v.skill] || []).push(v.bvid);

const outFile = path.join(APP_DIR, 'bili_cache_seed.json');
fs.writeFileSync(outFile, JSON.stringify({ searches, videos }, null, 2), 'utf8');

console.log('\n导出完成:');
console.log('  搜索关键词:', searches.length);
console.log('  视频条目  :', videos.length);
console.log('  覆盖技能  :', Object.keys(bySkill).length);
Object.entries(bySkill).forEach(([k, v]) => console.log(`    ${k}: ${v.length}`));
console.log('\n输出文件:', outFile, (fs.statSync(outFile).size / 1024).toFixed(1) + ' KB');
process.exit(0);
