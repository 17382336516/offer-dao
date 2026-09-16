// 导入 B站视频种子库到服务器数据库（真实视频，来自本地历史抓取结果）
// 说明：不修改任何搜索逻辑，只是把「搜索结果缓存」与「视频评分缓存」预置进库，
//       这样线上生成计划时命中缓存、直接用这些真实视频，避免服务器 IP 被风控导致搜不到。
//       缓存过期后仍会走原来的实时搜索策略（逻辑保留、未删除）。
// 用法： node deploy/import-bili-cache.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '..');
const SEED = path.join(APP_DIR, 'bili_cache_seed.json');

if (!fs.existsSync(SEED)) {
  console.error('[ERR] 未找到种子文件:', SEED);
  console.error('请先在能联网的机器执行 node deploy/export-bili-cache.mjs，再把 bili_cache_seed.json 上传到项目根目录');
  process.exit(1);
}

const seed = JSON.parse(fs.readFileSync(SEED, 'utf8'));
const searches = Array.isArray(seed.searches) ? seed.searches : [];
const videos = Array.isArray(seed.videos) ? seed.videos : [];
console.log('种子数据: 关键词=' + searches.length + ' 视频=' + videos.length);

const dbMod = await import(pathToFileURL(path.join(APP_DIR, 'server', 'db.mjs')).href);
const plan = await import(pathToFileURL(path.join(APP_DIR, 'server', 'plan.mjs')).href);
const db = dbMod.db;

let sOk = 0; let sFail = 0;
for (const s of searches) {
  try {
    plan.putBiliSearchCacheRow(db, s.keyword, s.results);
    sOk += 1;
  } catch (e) {
    sFail += 1;
    if (sFail <= 3) console.warn('  搜索缓存写入失败:', s.keyword, e.message);
  }
}

let vOk = 0; let vFail = 0;
for (const v of videos) {
  try {
    plan.putBiliResourceCacheRow(db, v);
    vOk += 1;
  } catch (e) {
    vFail += 1;
    if (vFail <= 3) console.warn('  评分缓存写入失败:', v.bvid, e.message);
  }
}

const T = db.state.tables;
console.log('\n===== 导入完成 =====');
console.log(`搜索缓存: 成功 ${sOk} / 失败 ${sFail}  (库内现有 ${(T.bilibili_search_cache || []).length} 条)`);
console.log(`评分缓存: 成功 ${vOk} / 失败 ${vFail}  (库内现有 ${(T.bilibili_resource_cache || []).length} 条)`);

const bySkill = {};
for (const v of (T.bilibili_resource_cache || [])) {
  (bySkill[v.skill] = bySkill[v.skill] || []).push(v.bvid);
}
console.log('覆盖技能数:', Object.keys(bySkill).length);
Object.entries(bySkill).forEach(([k, arr]) => console.log(`  ${k}: ${arr.length}`));
console.log(sOk || vOk ? '\n[OK] 视频库已预置' : '\n[WARN] 未写入任何数据');
process.exit(0);
