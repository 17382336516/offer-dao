// 数据核验 + 体检脚本（只读，绝不修改任何数据）
// 用法： node deploy/check-data.mjs
// 用途：确认注册账号、学习计划、每日任务是否真实落库，并做演示前的健康巡检。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '..');

const line = (s = '') => console.log(s);
const bar = (t) => { line('\n===== ' + t + ' ====='); };

// ---------- 0. 环境体检 ----------
bar('0. 运行环境');
try {
  const envPath = path.join(APP_DIR, '.env');
  if (fs.existsSync(envPath)) {
    const txt = fs.readFileSync(envPath, 'utf8');
    const hasKey = /^\s*DASHSCOPE_API_KEY\s*=\s*\S+/m.test(txt);
    line('.env 存在: 是');
    line('DASHSCOPE_API_KEY 已配置: ' + (hasKey ? '是' : '否（LLM 将不可用，走内置目录兜底）'));
    const modelCfg = txt.match(/^\s*QWEN_MODEL\s*=\s*(.*)$/m);
    line('QWEN_MODEL 显式配置: ' + (modelCfg ? modelCfg[1].trim() : '未配置（走 12 模型自动降级链）'));
  } else {
    line('.env 不存在！LLM 与部分功能不可用');
  }
  const dbPath = path.join(APP_DIR, 'server', 'offerdao.db');
  if (fs.existsSync(dbPath)) {
    const st = fs.statSync(dbPath);
    line('数据库文件: 存在, 大小 ' + (st.size / 1024).toFixed(1) + ' KB');
  } else {
    line('数据库文件: 不存在！');
  }
} catch (e) {
  line('环境检查出错: ' + e.message);
}

// ---------- 加载数据库 ----------
let db;
try {
  const mod = await import(path.join(APP_DIR, 'server', 'db.mjs'));
  db = mod.db;
} catch (e) {
  line('数据库加载失败: ' + e.message);
  process.exit(1);
}
const T = db.state.tables;
const tableCount = (n) => (Array.isArray(T[n]) ? T[n].length : 0);

// ---------- 1. 注册账号 ----------
bar('1. 注册账号 (users)');
const users = Array.isArray(T.users) ? T.users : [];
line('账号总数: ' + users.length);
for (const u of users) {
  line(`  #${u.id} 用户名="${u.username}" role=${u.role} tier=${u.tier} 小红书绑定=${u.xhs_bound ? '是' : '否'}`);
}

// ---------- 2. 岗位资料 (profiles) ----------
bar('2. 岗位资料 (profiles)');
const profiles = Array.isArray(T.profiles) ? T.profiles : [];
line('资料条数: ' + profiles.length);
for (const p of profiles) {
  const u = users.find((x) => x.id === p.user_id);
  line(`  user_id=${p.user_id} (${u ? u.username : '未知用户'})`);
  line(`    目标岗位=${p.job_name || '-'} | 公司=${p.company || '-'} | 方向=${p.direction || '-'}`);
  line(`    开始日=${p.start_date || '-'} | 目标日=${p.target_date || '-'} | 投递岗位JD=${(p.jd_text || '').length}字`);
  line(`    小红书帖子缓存=${Array.isArray(p.xhs_post_contents) ? p.xhs_post_contents.length : 0} 篇`);
}

// ---------- 3. 学习计划 (learning_plans) ----------
bar('3. 学习计划 (learning_plans)');
const plans = Array.isArray(T.learning_plans) ? T.learning_plans : [];
line('计划条数: ' + plans.length);
for (const pl of plans) {
  const u = users.find((x) => x.id === pl.user_id);
  let d = {};
  try { d = JSON.parse(pl.data || '{}'); } catch { d = {}; }
  const secs = Array.isArray(d.sections) ? d.sections : [];
  const skills = Array.isArray(d.skillTree && d.skillTree.skills) ? d.skillTree.skills.length : 0;
  line(`  user_id=${pl.user_id} (${u ? u.username : '未知'}) job=${pl.job || '-'}`);
  line(`    板块数=${secs.length} | 技能数=${skills} | LLM是否失败(llmFallback)=${d.llmFallback ? '是(走内置兜底)' : '否'}`);
  line(`    天数(days)=${d.days || '-'} | 计划来源=${d.source || '-'}`);
  if (secs.length) {
    const withVideo = secs.filter((s) => s && s.link).length;
    const withPdf = secs.filter((s) => Array.isArray(s.pdfs) && s.pdfs.length).length;
    line(`    板块明细: ${secs.map((s) => `${s.title}(视频${s.link ? 1 : 0}/PDF${Array.isArray(s.pdfs) ? s.pdfs.length : 0})`).join(', ')}`);
    line(`    有视频的板块=${withVideo}/${secs.length} | 有PDF的板块=${withPdf}/${secs.length}`);
  } else {
    line('    ⚠ 板块为空！该计划无法生成每日任务');
  }
}

// ---------- 4. 每日任务 (daily_learning_tasks) ----------
bar('4. 每日学习任务 (daily_learning_tasks)');
const tasks = Array.isArray(T.daily_learning_tasks) ? T.daily_learning_tasks : [];
line('任务总条数: ' + tasks.length);
const byUser = new Map();
for (const t of tasks) {
  if (!byUser.has(t.user_id)) byUser.set(t.user_id, []);
  byUser.get(t.user_id).push(t);
}
for (const [uid, list] of byUser) {
  const u = users.find((x) => x.id === uid);
  // 展开子任务统计完成数
  let total = 0;
  let done = 0;
  for (const row of list) {
    let subs = [];
    try { subs = JSON.parse(row.video_info || '[]'); } catch { subs = []; }
    if (!Array.isArray(subs) || !subs.length) {
      try { subs = JSON.parse(row.pdf_info || '[]'); } catch { subs = []; }
    }
    if (Array.isArray(subs) && subs.length) {
      for (const s of subs) { total++; if (s && (s.status === 'completed' || s.done)) done++; }
    } else {
      total++;
      if (row.status === 'completed') done++;
    }
  }
  const days = list.map((r) => r.day_number).sort((a, b) => a - b);
  line(`  user_id=${uid} (${u ? u.username : '未知'}): 天数=${list.length} [第${days[0]}~第${days[days.length - 1]}天] 子任务完成 ${done}/${total}`);
}

// ---------- 5. 其他业务表 ----------
bar('5. 其他数据表');
for (const n of ['sessions', 'learning_notes', 'interview_sessions', 'xhs_trend_keywords', 'daily_study_records']) {
  line(`  ${n}: ${tableCount(n)} 条`);
}

// ---------- 6. 演示前结论 ----------
bar('6. 演示就绪结论');
const problems = [];
if (!users.length) problems.push('没有任何注册账号');
if (!plans.length) problems.push('没有任何学习计划');
for (const pl of plans) {
  let d = {};
  try { d = JSON.parse(pl.data || '{}'); } catch { d = {}; }
  const secs = Array.isArray(d.sections) ? d.sections : [];
  if (!secs.length) problems.push(`user_id=${pl.user_id} 的计划板块为空，必须重新生成学习路线`);
  else {
    const noRes = secs.filter((s) => !s.link && !(Array.isArray(s.pdfs) && s.pdfs.length)).length;
    if (noRes === secs.length) problems.push(`user_id=${pl.user_id} 的板块全部没有视频/PDF资源`);
  }
}
if (!tasks.length) problems.push('没有任何每日学习任务');
if (problems.length) {
  line('发现以下必须处理的问题：');
  problems.forEach((p, i) => line(`  ${i + 1}. ${p}`));
} else {
  line('✅ 数据完整：账号 / 岗位资料 / 学习计划 / 每日任务 均已落库，可以演示');
}
line('\n提示：本脚本只读数据，未做任何修改。');
process.exit(0);
