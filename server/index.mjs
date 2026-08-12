// 零依赖后端：Node 内置 http + node:sqlite（真正的 SQLite 数据库）
// 提供用户注册、登录（token 会话）与目标岗位资料的持久化存储。
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { DatabaseSync, db } from './db.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import * as boss from './boss.mjs';
import * as plan from './plan.mjs';
import * as rag from './rag.mjs';
import * as mailbox from './mailbox.mjs';
import * as learningRouteAnalyzer from './learningRouteAnalyzer.mjs';
import * as skillNormalizer from './skillNormalizer.mjs';
import * as learningPlanGenerator from './learningPlanGenerator.mjs';
import * as skillResourceMatcher from './skillResourceMatcher.mjs';
import * as stagePlanGenerator from './stagePlanGenerator.mjs';
import * as dailyPlanGenerator from './dailyPlanGenerator.mjs';
import * as noteGenerator from './noteGenerator.mjs';
import * as novaforge from './novaforge.mjs';
import * as dailyPlanAdjuster from './dailyPlanAdjuster.mjs';
import * as dailyPlanScheduler from './dailyPlanScheduler.mjs';
import * as questionCache from './questionCache.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const DB_PATH = path.join(__dirname, 'offerdao.db');
const TOKEN_TTL = 7 * 24 * 60 * 60 * 1000; // 7 天

// ---------- 数据库初始化（db 为 db.mjs 导出的单例，全进程共享）----------
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    tier TEXT NOT NULL DEFAULT 'normal',
    created_at INTEGER NOT NULL,
    xhs_bound INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS profiles (
    user_id INTEGER PRIMARY KEY,
    job_name TEXT,
    company TEXT,
    direction TEXT,
    subfield TEXT,
    target_date TEXT,
    jd_text TEXT,
    directions TEXT,
    boss_cookie TEXT,
    xhs_posts TEXT,
    updated_at INTEGER,
    last_reschedule_date TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS learning_plans (
    user_id INTEGER PRIMARY KEY,
    job TEXT,
    data TEXT NOT NULL,
    progress TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS boss_snapshots (
    keyword TEXT PRIMARY KEY,
    direction_id TEXT,
    total INTEGER NOT NULL DEFAULT 0,
    big_tech_count INTEGER NOT NULL DEFAULT 0,
    campus_count INTEGER NOT NULL DEFAULT 0,
    jobs_json TEXT NOT NULL,
    requirements TEXT,
    summary TEXT,
    source TEXT,
    warning TEXT,
    fetched_at INTEGER NOT NULL,
    fetched_date TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS direction_configs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    keyword TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    fetch_count INTEGER NOT NULL DEFAULT 10,
    sample_count INTEGER NOT NULL DEFAULT 5,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS email_accounts (
    account_id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    provider TEXT NOT NULL,
    email TEXT NOT NULL,
    auth_code TEXT,
    imap_host TEXT,
    imap_port INTEGER,
    smtp_host TEXT,
    smtp_port INTEGER,
    enabled INTEGER NOT NULL DEFAULT 0,
    polling_minutes INTEGER NOT NULL DEFAULT 10,
    updated_at INTEGER NOT NULL,
    UNIQUE(user_id, email),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS interview_events (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    company TEXT,
    role TEXT,
    sender TEXT,
    subject TEXT,
    event_date TEXT,
    period TEXT,
    event_time TEXT,
    preview TEXT,
    source TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS interview_schedules (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    event_id TEXT,
    company TEXT,
    role TEXT,
    event_date TEXT,
    period TEXT,
    event_time TEXT,
    status TEXT NOT NULL DEFAULT 'confirmed',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS daily_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    task_date TEXT NOT NULL,
    plan_index INTEGER NOT NULL DEFAULT 0,
    keyword TEXT,
    tasks TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(user_id, task_date),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS study_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    skill TEXT,
    category TEXT,
    level TEXT,
    content TEXT NOT NULL,
    source TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS daily_learning_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    plan_id TEXT NOT NULL DEFAULT '',
    day_number INTEGER NOT NULL,
    stage TEXT,
    skill_id TEXT,
    skill_name TEXT,
    skill_category TEXT,
    skill_level TEXT,
    focus TEXT,
    video_info TEXT,
    pdf_info TEXT,
    estimated_time TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    task_date TEXT,
    UNIQUE(user_id, plan_id, day_number)
  );
  CREATE TABLE IF NOT EXISTS learning_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    task_id INTEGER NOT NULL,
    stage TEXT,
    skill_id TEXT,
    skill_name TEXT,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(user_id, task_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (task_id) REFERENCES daily_learning_tasks(id) ON DELETE CASCADE
  );
  -- 用户真实学习行为日志：每个独立完成的资源（视频分P / PDF 章节）一条记录。
  -- 与 daily_learning_tasks（计划）解耦：计划是"要学什么"，completions 是"实际学了什么"。
  CREATE TABLE IF NOT EXISTS daily_task_completions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    task_id INTEGER NOT NULL,            -- 对应的每日计划行（day 行）id
    date TEXT NOT NULL,                  -- 学习发生的日期 YYYY-MM-DD
    resource_type TEXT NOT NULL,         -- 'video' | 'pdf'
    resource_key TEXT NOT NULL,          -- 同一天同一资源去重键（如 video:url+part / pdf:docId+section）
    resource_info TEXT NOT NULL,         -- 该资源的元数据 JSON（url/part/docId/title/section...）
    completed_at INTEGER NOT NULL,
    UNIQUE(user_id, task_id, resource_key),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (task_id) REFERENCES daily_learning_tasks(id) ON DELETE CASCADE
  );
  -- 每日学习笔记生成次数限制表：每天最多生成 2 次（第2次覆盖第1次）。
  CREATE TABLE IF NOT EXISTS note_generation_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    note_date TEXT NOT NULL,             -- YYYY-MM-DD
    generation_index INTEGER NOT NULL,   -- 第几次生成（1 或 2）
    created_at INTEGER NOT NULL,
    UNIQUE(user_id, note_date, generation_index)
  );
  -- NovaForge 阶段知识沉淀：一个 stage 对应一份总结。
  -- 【重要】输入只来自该阶段的 learning_notes（每日笔记），绝不读取原始 PDF / 视频字幕。
  CREATE TABLE IF NOT EXISTS stage_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    plan_id TEXT,
    stage_id TEXT NOT NULL,              -- 阶段标识（取自 stagePlan 的 stage 名/序号）
    stage_title TEXT,
    title TEXT,
    content TEXT,                        -- NovaForge 输出的完整 JSON
    knowledge_tree TEXT,                 -- 知识树 JSON（便于前端单独渲染）
    source_notes TEXT,                   -- 参与聚合的每日笔记来源 JSON（note_date 列表）
    created_at INTEGER NOT NULL,
    updated_at INTEGER,
    UNIQUE(user_id, stage_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  -- 资源缓存层：把已匹配的真实资源（B站/PDF等）持久化，后续每日计划直接读缓存，不再重复调用外部搜索。
  -- 注意：PDF 正文/向量检索永远走独立的 rag.sqlite3（rag.mjs），业务库只存资源元数据索引。
  CREATE TABLE IF NOT EXISTS matched_resources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id TEXT NOT NULL,
    skill_id TEXT,
    resource_type TEXT,
    title TEXT,
    url TEXT,
    doc_id TEXT,
    duration TEXT,
    author TEXT,
    parts TEXT,
    metadata TEXT,
    created_at INTEGER,
    UNIQUE(plan_id, skill_id, resource_type, doc_id, url)
  );
  -- 视频字幕缓存层：把已抓取并校验过的 B站字幕正文按 (cache_key) 持久化，
  -- 笔记生成（generateNoteIncremental）与后续重复生成直接读缓存，避免重复联网抓字幕（串行慢点）。
  -- cache_key = bvid或url + '|' + part或'all'，便于跨任务/跨天复用。
  CREATE TABLE IF NOT EXISTS video_subtitle_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cache_key TEXT NOT NULL,
    bvid TEXT,
    part TEXT,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(cache_key)
  );
  -- B站视频评分缓存层：复用「已评分视频」的历史结果，避免每次生成计划都重做
  -- 「搜索→字幕检查→质量评分」。注意：缓存【不】替代实时搜索，B站搜索每次仍实时进行，
  -- 仅评分结果在 30 天内直接复用。key = (bvid, skill)，同一视频对不同技能分别评分存储。
  CREATE TABLE IF NOT EXISTS bilibili_resource_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bvid TEXT NOT NULL,
    title TEXT,
    url TEXT,
    author TEXT,
    skill TEXT NOT NULL,
    search_keyword TEXT,
    score_json TEXT NOT NULL,
    score_version TEXT,       -- 评分模型版本（v1/v2...），版本不符则视为失效、重新评分
    subtitle_status TEXT,
    duration INTEGER,
    checked_time INTEGER NOT NULL,
    UNIQUE(bvid, skill)
  );
  -- 小红书趋势关键词表：沉淀从帖子提取的「新工具/新表达」，并匹配到固定技能。
  -- 仅【补充】B站搜索词，不改动固定技能体系、不生成新学习阶段。
  -- 采用历史累计机制避免「本次没抓到帖子→趋势消失」：
  --   total_count  = 历史累计出现次数（保留全部历史）
  --   recent_count = 最近时间窗口（30天）出现次数（每次更新前按 last_seen 衰减重算）
  -- trend_score = 历史频次50% + 近期频次30% + 技能匹配度20%
  CREATE TABLE IF NOT EXISTS xhs_trend_keywords (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    keyword TEXT NOT NULL,
    skill TEXT NOT NULL,
    total_count INTEGER NOT NULL DEFAULT 0,
    recent_count INTEGER NOT NULL DEFAULT 0,
    last_seen TEXT,
    relevance_score REAL,
    trend_score REAL,
    source TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE(keyword, skill)
  );
  -- B站搜索结果短缓存层：减少相同关键词重复调用 B站搜索接口（HTTP 请求开销）。
  -- 与 bilibili_resource_cache（视频评分缓存）职责严格分离：
  --   本表只负责「搜索结果列表」的短缓存（24h TTL），不判断视频质量；
  --   视频评分缓存负责「已评分视频」复用，不替代搜索。
  -- 缓存【不】替代实时搜索：超过 24h 仍必须重新搜索并刷新。
  -- results 存 JSON 数组：[{bvid,title,url,duration}]
  CREATE TABLE IF NOT EXISTS bilibili_search_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    keyword TEXT NOT NULL UNIQUE,
    results TEXT NOT NULL,
    checked_time INTEGER NOT NULL
  );
  -- 学习预算快照表：记录某次计划生成的「时间预算分配」（由 Learning Budget Manager 计算）。
  -- 仅存计算结果的 JSON，不存资源本身（资源仍在各匹配表）。用于校验/回溯「天数×每日时长」分配。
  --   budget_json 存 computeLearningBudget 的完整输出（days/dailyMinutes/totalMinutes/stageBudget/skillBudget）
  CREATE TABLE IF NOT EXISTS learning_budget (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    plan_id TEXT,
    days INTEGER NOT NULL,
    daily_minutes INTEGER NOT NULL,
    total_minutes INTEGER NOT NULL,
    budget_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(user_id, plan_id)
  );
  -- 小红书账号绑定表：用户级隔离。每个 offer dao 用户对应一个独立小红书账号（cookie 隔离存储于 data/xhs/user_<id>.json）。
  -- 不同用户绝不共享小红书登录态；本机是否有旧全局 cookie 不会自动归属给任何用户。
  CREATE TABLE IF NOT EXISTS xhs_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    status TEXT,
    created_at INTEGER,
    updated_at INTEGER,
    UNIQUE(user_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  -- ============ AI 面经整理模块 ============
  -- 一次面经整理会话（公司+岗位+轮次）
  CREATE TABLE IF NOT EXISTS interview_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    company TEXT NOT NULL,
    role TEXT NOT NULL,
    round TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  -- 来源：实时小红书帖子 或 历史 RAG chunk（原始内容，第一版不调 LLM，原样入库）
  CREATE TABLE IF NOT EXISTS interview_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    source_type TEXT NOT NULL, -- 'xiaohongshu' | 'rag'
    content TEXT NOT NULL,
    metadata TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (session_id) REFERENCES interview_sessions(id) ON DELETE CASCADE
  );
  -- 整理后的结构化问题（基础/产品/项目三类）
  CREATE TABLE IF NOT EXISTS interview_questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    question TEXT NOT NULL,
    type TEXT NOT NULL, -- 'basic' | 'product' | 'project'
    answer TEXT, -- 基础问题的一句话简答
    answer_framework TEXT, -- 产品设计问题的回答框架
    prepare_direction TEXT, -- 项目经历问题的准备方向（不生成答案）
    created_at INTEGER NOT NULL,
    FOREIGN KEY (session_id) REFERENCES interview_sessions(id) ON DELETE CASCADE
  );
  -- 增量去重：记录某 session 已消费过的小红书 post_id / rag 问题文本，避免重复追加
  CREATE TABLE IF NOT EXISTS interview_source_ids (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    source_type TEXT NOT NULL, -- 'xiaohongshu' | 'rag'
    ref_id TEXT NOT NULL, -- 小红书 post_id 或 rag chunk 唯一标识
    created_at INTEGER NOT NULL,
    FOREIGN KEY (session_id) REFERENCES interview_sessions(id) ON DELETE CASCADE
  );
  -- 性能索引（仅未来 SQLite 模式生效，JSON 模式下被模拟器忽略，不影响查询结果与功能）。
  CREATE INDEX IF NOT EXISTS idx_dlt_user_id ON daily_learning_tasks(user_id);
  CREATE INDEX IF NOT EXISTS idx_dlt_status ON daily_learning_tasks(status);
  CREATE INDEX IF NOT EXISTS idx_dlt_plan_id ON daily_learning_tasks(plan_id);
  CREATE INDEX IF NOT EXISTS idx_ln_user_id ON learning_notes(user_id);
  CREATE INDEX IF NOT EXISTS idx_ln_task_id ON learning_notes(task_id);
  CREATE INDEX IF NOT EXISTS idx_mr_plan_id ON matched_resources(plan_id);
  CREATE INDEX IF NOT EXISTS idx_mr_skill_id ON matched_resources(skill_id);
`);

// SQLite 生产环境执行迁移；JSON 兼容数据库会安全忽略该语句。
try { db.exec('ALTER TABLE learning_notes ADD COLUMN stage TEXT'); } catch { /* 列已存在则忽略 */ }

// 兼容旧库：新增列（以 JSON 数组形式存储多选方向 / 小红书帖子）
try { db.exec('ALTER TABLE profiles ADD COLUMN directions TEXT'); } catch { /* 列已存在则忽略 */ }
try { db.exec('ALTER TABLE profiles ADD COLUMN boss_cookie TEXT'); } catch { /* 列已存在则忽略 */ }
try { db.exec('ALTER TABLE profiles ADD COLUMN xhs_posts TEXT'); } catch { /* 列已存在则忽略 */ }
try { db.exec('ALTER TABLE profiles ADD COLUMN xhs_post_contents TEXT'); } catch { /* 列已存在则忽略 */ }
try { db.exec('ALTER TABLE profiles ADD COLUMN start_date TEXT'); } catch { /* 列已存在则忽略 */ }
// 兼容旧库：每日学习任务补充 skill 元信息列
try { db.exec('ALTER TABLE daily_learning_tasks ADD COLUMN skill_category TEXT'); } catch { /* 列已存在则忽略 */ }
try { db.exec('ALTER TABLE daily_learning_tasks ADD COLUMN skill_level TEXT'); } catch { /* 列已存在则忽略 */ }
try { db.exec('ALTER TABLE daily_learning_tasks ADD COLUMN focus TEXT'); } catch { /* 列已存在则忽略 */ }
try { db.exec('ALTER TABLE daily_learning_tasks ADD COLUMN task_date TEXT'); } catch { /* 列已存在则忽略 */ }
// 动态计划调整：记录任务原始日与调整后所在日，状态含 rescheduled
try { db.exec('ALTER TABLE daily_learning_tasks ADD COLUMN original_day INTEGER'); } catch { /* 列已存在则忽略 */ }
try { db.exec('ALTER TABLE daily_learning_tasks ADD COLUMN adjusted_day INTEGER'); } catch { /* 列已存在则忽略 */ }
// 动态计划调整系统：每日负荷/重排次数/调整原因
try { db.exec('ALTER TABLE daily_learning_tasks ADD COLUMN estimated_minutes INTEGER NOT NULL DEFAULT 0'); } catch { /* 列已存在则忽略 */ }
try { db.exec('ALTER TABLE daily_learning_tasks ADD COLUMN reschedule_count INTEGER NOT NULL DEFAULT 0'); } catch { /* 列已存在则忽略 */ }
try { db.exec('ALTER TABLE daily_learning_tasks ADD COLUMN adjust_reason TEXT'); } catch { /* 列已存在则忽略 */ }
// 动态计划调整：调整原因类型枚举 + 详情（文档六）
try { db.exec('ALTER TABLE daily_learning_tasks ADD COLUMN adjust_reason_type TEXT'); } catch { /* 列已存在则忽略 */ }
try { db.exec('ALTER TABLE daily_learning_tasks ADD COLUMN adjust_reason_detail TEXT'); } catch { /* 列已存在则忽略 */ }
// 目标日/动态调整原因记录表
try { db.exec(`CREATE TABLE IF NOT EXISTS learning_plan_adjustments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  old_target_date TEXT,
  new_target_date TEXT,
  adjust_type TEXT,
  adjust_reason TEXT,
  created_at INTEGER
)`); } catch { /* 表已存在则忽略 */ }
// 学习笔记升级：改为"每天一份最终笔记"，支持生成次数计数与来源任务记录
try { db.exec('ALTER TABLE learning_notes ADD COLUMN note_date TEXT'); } catch { /* 列已存在则忽略 */ }
try { db.exec('ALTER TABLE learning_notes ADD COLUMN month INTEGER'); } catch { /* 列已存在则忽略 */ }
try { db.exec('ALTER TABLE learning_notes ADD COLUMN day INTEGER'); } catch { /* 列已存在则忽略 */ }
try { db.exec('ALTER TABLE learning_notes ADD COLUMN generation_count INTEGER NOT NULL DEFAULT 1'); } catch { /* 列已存在则忽略 */ }
try { db.exec('ALTER TABLE learning_notes ADD COLUMN source_tasks TEXT'); } catch { /* 列已存在则忽略 */ }
try { db.exec('ALTER TABLE learning_notes ADD COLUMN updated_at INTEGER'); } catch { /* 列已存在则忽略 */ }
// 阶段归属：每日笔记落到哪个 stage，NovaForge 据此聚合
try { db.exec('ALTER TABLE learning_notes ADD COLUMN stage_id TEXT'); } catch { /* 列已存在则忽略 */ }
// B站评分缓存表迁移：加 score_version 列（新评分模型 v2 需版本校验，旧缓存失效重算）
try { db.exec('ALTER TABLE bilibili_resource_cache ADD COLUMN score_version TEXT'); } catch { /* 列已存在则忽略 */ }
// 旧库已有 bilibili_resource_cache 行无 score_version，标记为 v1 使其自然失效（触发重算）
try { db.exec("UPDATE bilibili_resource_cache SET score_version='v1' WHERE score_version IS NULL OR score_version=''"); } catch { /* 忽略 */ }
// 小红书趋势表迁移：新版用 total_count/recent_count 替代旧 mention_count；旧库若存在 mention_count 则迁移
try { db.exec('ALTER TABLE xhs_trend_keywords ADD COLUMN total_count INTEGER NOT NULL DEFAULT 0'); } catch { /* 列已存在则忽略 */ }
try { db.exec('ALTER TABLE xhs_trend_keywords ADD COLUMN recent_count INTEGER NOT NULL DEFAULT 0'); } catch { /* 列已存在则忽略 */ }
try {
  const hasOld = db.prepare("SELECT COUNT(*) AS c FROM pragma_table_info('xhs_trend_keywords') WHERE name='mention_count'").get();
  if (hasOld && hasOld.c > 0) {
    db.exec("UPDATE xhs_trend_keywords SET total_count = mention_count WHERE total_count = 0 AND mention_count > 0");
    db.exec('ALTER TABLE xhs_trend_keywords DROP COLUMN mention_count');
  }
} catch { /* 忽略：旧列不存在或无法删除 */ }

// 初始化 RAG 知识库表（向量存储）
rag.initRag();
try { db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'"); } catch { /* column may already exist */ }
try { db.exec("ALTER TABLE users ADD COLUMN tier TEXT NOT NULL DEFAULT 'normal'"); } catch { /* column may already exist */ }

// ---------- 密码工具 ----------
function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const hash = scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const BOSS_REFRESH_HOUR = Number(process.env.BOSS_REFRESH_HOUR || 6);
const BOSS_REFRESH_MINUTE = Number(process.env.BOSS_REFRESH_MINUTE || 0);
const BOSS_DIRECTION_PRESETS = [
  { id: 'strategy', keyword: '策略产品经理' },
  { id: 'ai', keyword: 'AI产品经理' },
  { id: 'data', keyword: '数据产品经理' },
  { id: 'growth', keyword: '增长产品经理' },
  { id: 'b_end', keyword: 'B端产品经理' },
  { id: 'c_end', keyword: 'C端产品经理' },
];

// —— 学习计划 ID 规则（统一唯一真源）——
// plan_id 全局统一格式为 `plan_${userId}`。
// learning_plans / daily_learning_tasks / matched_resources 三表均通过此规则关联，
// 严禁使用其他拼接方式，否则会导致计划、每日任务、资源缓存三层数据无法对应。
function buildPlanId(userId) {
  return `plan_${userId}`;
}

function ensureAdminUser() {
  const row = db.prepare('SELECT id FROM users WHERE username = ?').get(ADMIN_USERNAME);
  if (row) {
    db.prepare('UPDATE users SET role = ?, tier = ? WHERE username = ?').run('admin', 'member', ADMIN_USERNAME);
    return;
  }
  const { salt, hash } = hashPassword(ADMIN_PASSWORD);
  db.prepare('INSERT INTO users (username, password_hash, password_salt, role, tier, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(ADMIN_USERNAME, hash, salt, 'admin', 'member', Date.now());
}
ensureAdminUser();

const ADMIN_USER_ROLES = new Set(['admin', 'user', 'guest']);
const ADMIN_USER_TIERS = new Set(['normal', 'member']);

function getUserAccount(userId) {
  return db.prepare('SELECT id, username, role, tier FROM users WHERE id = ?').get(userId) || null;
}

function isAdminUserId(userId) {
  return getUserAccount(userId)?.role === 'admin';
}

function getUserDisplayType(user) {
  if (!user) return '普通用户';
  if (user.role === 'admin') return '管理员';
  if (user.tier === 'member') return '会员用户';
  if (user.role === 'guest') return '访客用户';
  return '普通用户';
}

// 取本地时区日期字符串（YYYY-MM-DD），避免 UTC 晚 8 点后比本地慢一天。
function localDateStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function todayDateText() {
  return localDateStr();
}

function mapEmailAccountRow(row) {
  if (!row) return null;
  return {
    accountId: row.account_id,
    provider: row.provider || 'qq',
    email: row.email || '',
    authCode: row.auth_code || '',
    imapHost: row.imap_host || '',
    imapPort: Number(row.imap_port || 0),
    smtpHost: row.smtp_host || '',
    smtpPort: Number(row.smtp_port || 0),
    enabled: !!row.enabled,
    pollingMinutes: Number(row.polling_minutes || 10),
    updatedAt: row.updated_at || null,
  };
}

// 返回该用户的「默认」账号：优先已启用，其次第一个；精确指定 email 时直接定位。
function getMailboxAccount(userId, email) {
  let row;
  if (email) {
    row = db.prepare(`
      SELECT account_id, provider, email, auth_code, imap_host, imap_port, smtp_host, smtp_port, enabled, polling_minutes, updated_at
      FROM email_accounts
      WHERE user_id = ? AND email = ?
    `).get(userId, email);
  } else {
    row = db.prepare(`
      SELECT account_id, provider, email, auth_code, imap_host, imap_port, smtp_host, smtp_port, enabled, polling_minutes, updated_at
      FROM email_accounts
      WHERE user_id = ?
      ORDER BY enabled DESC, updated_at ASC
      LIMIT 1
    `).get(userId);
  }
  const acc = mapEmailAccountRow(row);
  if (!acc) {
    return {
      connected: false,
      provider: 'qq',
      email: '',
      authCode: '',
      imapHost: 'imap.qq.com',
      imapPort: 993,
      smtpHost: 'smtp.qq.com',
      smtpPort: 465,
      enabled: false,
      pollingMinutes: 10,
      updatedAt: null,
    };
  }
  return { ...acc, connected: !!(acc.email && acc.authCode) };
}

function listMailboxAccounts(userId) {
  const rows = db.prepare(`
    SELECT account_id, provider, email, auth_code, imap_host, imap_port, smtp_host, smtp_port, enabled, polling_minutes, updated_at
    FROM email_accounts
    WHERE user_id = ?
    ORDER BY enabled DESC, updated_at ASC
  `).all(userId);
  return rows.map((r) => ({ ...mapEmailAccountRow(r), connected: !!(r.email && r.auth_code) }));
}

function saveInterviewEvents(userId, items = []) {
  const now = Date.now();
  const stmt = db.prepare(`
    INSERT INTO interview_events (
      id, user_id, company, role, sender, subject, event_date, period, event_time, preview, source, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      company=excluded.company,
      role=excluded.role,
      sender=excluded.sender,
      subject=excluded.subject,
      event_date=excluded.event_date,
      period=excluded.period,
      event_time=excluded.event_time,
      preview=excluded.preview,
      source=excluded.source,
      updated_at=excluded.updated_at
  `);
  for (const item of items) {
    const id = `mail_${userId}_${item.id}`;
    stmt.run(
      id,
      userId,
      item.company || '',
      item.role || '',
      item.sender || '',
      item.subject || '',
      item.date || '',
      item.period || '',
      item.time || '',
      item.preview || '',
      'mailbox',
      'pending',
      now,
      now
    );
  }
}

function listInterviewEvents(userId) {
  return db.prepare(`
    SELECT id, company, role, sender, subject, event_date, period, event_time, preview, source, status, created_at, updated_at
    FROM interview_events
    WHERE user_id = ?
    ORDER BY event_date ASC, event_time ASC, created_at DESC
  `).all(userId).map((row) => ({
    id: row.id,
    company: row.company || '',
    role: row.role || '',
    sender: row.sender || '',
    subject: row.subject || '',
    date: row.event_date || '',
    period: row.period || '',
    time: row.event_time || '',
    preview: row.preview || '',
    source: row.source || 'mailbox',
    status: row.status || 'pending',
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  }));
}

function listInterviewSchedules(userId) {
  return db.prepare(`
    SELECT id, event_id, company, role, event_date, period, event_time, status, created_at, updated_at
    FROM interview_schedules
    WHERE user_id = ?
    ORDER BY event_date ASC, event_time ASC, created_at DESC
  `).all(userId).map((row) => ({
    id: row.id,
    eventId: row.event_id || '',
    company: row.company || '',
    role: row.role || '',
    date: row.event_date || '',
    period: row.period || '',
    time: row.event_time || '',
    status: row.status || 'confirmed',
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  }));
}

function createInterviewSchedule(userId, eventId) {
  const event = listInterviewEvents(userId).find((item) => item.id === eventId);
  if (!event) throw new Error('面试邀请不存在');
  const sameHalfDay = listInterviewSchedules(userId).find((item) => item.date === event.date && item.period === event.period);
  if (sameHalfDay) throw new Error('该时间段已有已确认面试');
  const now = Date.now();
  const scheduleId = `schedule_${userId}_${eventId}`;
  db.prepare(`
    INSERT INTO interview_schedules (
      id, user_id, event_id, company, role, event_date, period, event_time, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(scheduleId, userId, eventId, event.company || '', event.role || '', event.date || '', event.period || '', event.time || '', 'confirmed', now, now);
  db.prepare('UPDATE interview_events SET status = ?, updated_at = ? WHERE id = ?').run('confirmed', now, eventId);
}

function ensureDirectionConfigs() {
  const now = Date.now();
  const defaults = [
    { id: 'c端', name: 'C端产品', keyword: 'C端产品经理', enabled: 1, fetchCount: 10, sampleCount: 5, sortOrder: 1 },
    { id: 'b端', name: 'B端产品', keyword: 'B端产品经理', enabled: 1, fetchCount: 10, sampleCount: 5, sortOrder: 2 },
    { id: 'ai', name: 'AI产品', keyword: 'AI产品经理', enabled: 1, fetchCount: 10, sampleCount: 5, sortOrder: 3 },
    { id: 'data', name: '数据产品', keyword: '数据产品经理', enabled: 1, fetchCount: 10, sampleCount: 5, sortOrder: 4 },
    { id: 'strategy', name: '策略产品', keyword: '策略产品经理', enabled: 1, fetchCount: 10, sampleCount: 5, sortOrder: 5 },
    { id: 'growth', name: '增长产品', keyword: '增长产品经理', enabled: 1, fetchCount: 10, sampleCount: 5, sortOrder: 6 },
  ];
  const stmt = db.prepare(`
    INSERT INTO direction_configs (
      id, name, keyword, enabled, fetch_count, sample_count, sort_order, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `);
  for (const item of defaults) {
    stmt.run(item.id, item.name, item.keyword, item.enabled, item.fetchCount, item.sampleCount, item.sortOrder, now, now);
  }
}
ensureDirectionConfigs();

function listDirectionConfigs() {
  return db.prepare(`
    SELECT id, name, keyword, enabled, fetch_count, sample_count, sort_order, created_at, updated_at
    FROM direction_configs
    ORDER BY sort_order ASC, created_at ASC
  `).all().map((row) => ({
    id: row.id,
    name: row.name,
    keyword: row.keyword,
    enabled: !!row.enabled,
    fetchCount: Number(row.fetch_count || 10),
    sampleCount: Number(row.sample_count || 5),
    sortOrder: Number(row.sort_order || 0),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  }));
}

function saveBossSnapshot(directionId, keyword, data) {
  db.prepare(`
    INSERT INTO boss_snapshots (
      keyword, direction_id, total, big_tech_count, campus_count,
      jobs_json, requirements, summary, source, warning, fetched_at, fetched_date
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(keyword) DO UPDATE SET
      direction_id=excluded.direction_id,
      total=excluded.total,
      big_tech_count=excluded.big_tech_count,
      campus_count=excluded.campus_count,
      jobs_json=excluded.jobs_json,
      requirements=excluded.requirements,
      summary=excluded.summary,
      source=excluded.source,
      warning=excluded.warning,
      fetched_at=excluded.fetched_at,
      fetched_date=excluded.fetched_date
  `).run(
    keyword,
    directionId,
    Number(data.total || 0),
    Number(data.bigTechCount || 0),
    Number(data.campusCount || 0),
    JSON.stringify(Array.isArray(data.jobs) ? data.jobs.slice(0, 5) : []),
    data.requirements || '',
    data.summary || '',
    data.source || '',
    data.warning || '',
    Date.now(),
    todayDateText()
  );
}

function getBossSnapshot(keyword) {
  const row = db.prepare('SELECT * FROM boss_snapshots WHERE keyword = ?').get(keyword);
  if (!row) return null;
  let jobs = [];
  try { jobs = JSON.parse(row.jobs_json || '[]'); } catch { jobs = []; }
  return {
    keyword: row.keyword,
    total: row.total,
    bigTechCount: row.big_tech_count,
    campusCount: row.campus_count,
    jobs,
    requirements: row.requirements || '',
    summary: row.summary || '',
    source: row.source || 'snapshot',
    warning: row.warning || '',
    cached: true,
    fetchedAt: row.fetched_at,
    fetchedDate: row.fetched_date,
    directionId: row.direction_id || '',
  };
}

async function refreshBossSnapshotsOnce() {
  const adminRow = db.prepare('SELECT id FROM users WHERE username = ?').get(ADMIN_USERNAME);
  if (!adminRow) return { refreshed: 0, reason: 'admin_missing' };
  const cookieRow = db.prepare('SELECT boss_cookie FROM profiles WHERE user_id = ?').get(adminRow.id);
  const cookie = cookieRow?.boss_cookie || '';
  if (!cookie) return { refreshed: 0, reason: 'boss_cookie_missing' };

  const configs = listDirectionConfigs().filter((item) => item.enabled);
  let refreshed = 0;
  for (const item of configs) {
    const result = await boss.getBossRequirements(item.keyword, '全国', { cookie });
    if (result && result.jobs && result.jobs.length) {
      saveBossSnapshot(item.id, item.keyword, result);
      refreshed += 1;
    }
  }
  return { refreshed, reason: refreshed ? 'ok' : 'no_jobs' };
}

async function syncMailboxForUser(userId, account, limit = 10) {
  if (!account || !account.enabled || !account.email || !account.authCode) {
    return { synced: 0, reason: 'mailbox_not_ready' };
  }
  const result = await mailbox.syncInterviewInvites(account, limit);
  const items = Array.isArray(result.items) ? result.items : [];
  if (items.length) saveInterviewEvents(userId, items);
  return { synced: items.length, scanned: result.scanned || 0 };
}

async function pollMailboxAccountsOnce() {
  const rows = db.prepare(`
    SELECT account_id, user_id, provider, email, auth_code, imap_host, imap_port, smtp_host, smtp_port, enabled, polling_minutes, updated_at
    FROM email_accounts
    WHERE enabled = 1
  `).all();
  let syncedAccounts = 0;
  const now = Date.now();
  for (const row of rows) {
    const intervalMs = Math.max(5, Number(row.polling_minutes || 10)) * 60 * 1000;
    const elapsed = now - Number(row.updated_at || 0);
    if (elapsed < intervalMs) continue;
    const account = mapEmailAccountRow(row);
    try {
      const info = await syncMailboxForUser(row.user_id, account, 10);
      if (info.synced >= 0) syncedAccounts += 1;
      db.prepare(`
        INSERT INTO email_accounts (
          user_id, provider, email, auth_code, imap_host, imap_port, smtp_host, smtp_port, enabled, polling_minutes, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, email) DO UPDATE SET
          updated_at=excluded.updated_at
      `).run(
        row.user_id,
        account.provider,
        account.email,
        account.authCode,
        account.imapHost,
        account.imapPort,
        account.smtpHost,
        account.smtpPort,
        account.enabled ? 1 : 0,
        account.pollingMinutes,
        now
      );
    } catch (e) {
      console.error('[mailbox-poll] account failed:', row.user_id, row.email, e.message);
    }
  }
  return { accounts: rows.length, syncedAccounts };
}

function scheduleMailboxPolling() {
  const run = async () => {
    try {
      const info = await pollMailboxAccountsOnce();
      console.log('[mailbox-poll]', info);
    } catch (e) {
      console.error('[mailbox-poll] failed:', e.message);
    }
    setTimeout(run, 5 * 60 * 1000);
  };
  setTimeout(run, 30 * 1000);
}

function scheduleDailyBossRefresh() {
  const run = async () => {
    try {
      const info = await refreshBossSnapshotsOnce();
      console.log('[boss-refresh]', info);
    } catch (e) {
      console.error('[boss-refresh] failed:', e.message);
    }
    const now = new Date();
    const next = new Date(now);
    next.setHours(BOSS_REFRESH_HOUR, BOSS_REFRESH_MINUTE, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    setTimeout(run, next.getTime() - now.getTime());
  };
  const now = new Date();
  const first = new Date(now);
  first.setHours(BOSS_REFRESH_HOUR, BOSS_REFRESH_MINUTE, 0, 0);
  if (first <= now) first.setDate(first.getDate() + 1);
  setTimeout(run, first.getTime() - now.getTime());
}

// 每日自然日切换时自动抓取 GitHub Trending 上限条项目，写入全局 github_trending 表，
// 所有用户共享同一份数据，不重复抓取。每天 00:00 触发一次。
function scheduleTrendingRefresh() {
  const refreshOnce = async () => {
    try {
      const today = localDateStr();
      const result = await plan.getTrendingInsights({ noCache: true });
      db.state.tables.github_trending = [{ date: today, updatedAt: Date.now(), repos: result.insights || [] }];
      db.save();
      console.log('[trending-refresh] updated', (result.insights || []).length, 'repos for', today);
    } catch (e) {
      console.error('[trending-refresh] failed:', e.message);
    }
  };
  const run = async () => {
    await refreshOnce();
    const now = new Date();
    const next = new Date(now);
    next.setHours(0, 0, 5, 0); // 自然日 00:00:05 触发
    if (next <= now) next.setDate(next.getDate() + 1);
    setTimeout(run, next.getTime() - now.getTime());
  };
  // 启动后立即跑一次（保证有数据），随后每天 00:00 自动刷新
  run();
}
scheduleMailboxPolling();
scheduleTrendingRefresh();

// ---------- 会话工具 ----------
function createSession(userId) {
  const token = randomBytes(32).toString('hex');
  const expiresAt = Date.now() + TOKEN_TTL;
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expiresAt);
  return token;
}
function getUserIdByToken(token) {
  if (!token) return null;
  const row = db.prepare('SELECT user_id, expires_at FROM sessions WHERE token = ?').get(token);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return row.user_id;
}
// 严格鉴权：仅返回已登录（token 有效）的用户 id。
// 无 token / token 失效 / 游客模式下统一返回 null，由调用点强制 401。
// 平台不再支持游客模式，未登录用户必须走账号密码登录。
function getUserId(req) {
  return getUserIdByToken(getBearer(req));
}

// 在接口处理函数内调用：无有效登录则返回 401 并 return false。
// 用法：const userId = requireUserId(req, res); if (!userId) return;
function requireUserId(req, res) {
  const userId = getUserId(req);
  if (!userId) {
    sendJson(res, 401, { error: '请先登录后再使用', code: 'UNAUTHORIZED' });
    return null;
  }
  return userId;
}

// ---------- HTTP 辅助 ----------
function safeParseJSON(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

// 统一资源字段解析层：从 resourceLayer.mjs 统一导入，
// 兼容旧数据（JSON 字符串）与新数据（数组），
// 统一返回 { videos, pdfs }。
import { parseResourceInfo } from './resourceLayer.mjs';
function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('无效的 JSON 请求体')); }
    });
    req.on('error', reject);
  });
}
function getBearer(req) {
  const auth = req.headers['authorization'] || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

// ---------- 业务处理 ----------
async function handleRegister(body, res) {
  const username = (body.username || '').trim();
  const password = body.password || '';
  if (username.length < 2) return sendJson(res, 400, { error: '用户名至少 2 个字符' });
  if (password.length < 3) return sendJson(res, 400, { error: '密码至少 3 个字符' });

  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) return sendJson(res, 409, { error: '该用户名已被注册' });

  const { salt, hash } = hashPassword(password);
  const info = db.prepare('INSERT INTO users (username, password_hash, password_salt, role, tier, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    username, hash, salt, 'user', 'normal', Date.now()
  );
  const userId = Number(info.lastInsertRowid);
  const token = createSession(userId);
  // 前端会员状态：复用 users.tier（normal/member），映射为 isVip 布尔，不新增字段
  sendJson(res, 201, { token, user: { id: userId, username, role: 'user', tier: 'normal', isVip: false } });
}

async function handleLogin(body, res) {
  const username = (body.username || '').trim();
  const password = body.password || '';
  const user = db.prepare('SELECT id, username, password_hash, password_salt, role, tier FROM users WHERE username = ?').get(username);
  if (!user || !verifyPassword(password, user.password_salt, user.password_hash)) {
    return sendJson(res, 401, { error: '用户名或密码错误' });
  }
  const token = createSession(user.id);
  const tier = user.tier || 'normal';
  sendJson(res, 200, { token, user: { id: user.id, username: user.username, role: user.role || 'user', tier, isVip: tier === 'member' } });
}

function getProfile(userId) {
  const row = db.prepare('SELECT job_name, company, direction, subfield, target_date, start_date, jd_text, directions, boss_cookie, xhs_posts, xhs_post_contents FROM profiles WHERE user_id = ?').get(userId);
  const account = getUserAccount(userId);
  if (!row) {
    return {
      role: account?.role || 'user',
      tier: account?.tier || 'normal',
      jobName: '',
      company: '',
      direction: '',
      directions: [],
      subfield: '',
      targetDate: '',
      jdText: '',
      bossCookieBound: false,
      xhsPosts: [],
      xhsPostContents: [],
    };
  }
  let directions = [];
  if (row.directions) {
    try { directions = JSON.parse(row.directions); } catch { directions = []; }
  }
  if (!Array.isArray(directions) || directions.length === 0) {
    directions = row.direction ? [row.direction] : [];
  }
  let xhsPosts = [];
  if (row.xhs_posts) {
    try { xhsPosts = JSON.parse(row.xhs_posts); } catch { xhsPosts = []; }
  }
  if (!Array.isArray(xhsPosts)) xhsPosts = [];
  let xhsPostContents = [];
  if (row.xhs_post_contents) {
    try { xhsPostContents = JSON.parse(row.xhs_post_contents); } catch { xhsPostContents = []; }
  }
  if (!Array.isArray(xhsPostContents)) xhsPostContents = [];
  return {
    role: account?.role || 'user',
    tier: account?.tier || 'normal',
    jobName: row.job_name,
    company: row.company,
    direction: row.direction,
    directions,
    subfield: row.subfield,
    targetDate: row.target_date,
    startDate: row.start_date || null,
    jdText: row.jd_text,
    bossCookieBound: !!(row.boss_cookie && String(row.boss_cookie).trim()),
    xhsPosts,
    xhsPostContents,
  };
  try {
    const lr = db.prepare('SELECT last_reschedule_date FROM profiles WHERE user_id = ?').get(userId);
    profile.last_reschedule_date = lr?.last_reschedule_date || null;
  } catch (e) {
    profile.last_reschedule_date = null;
  }
}
// 由目标日推导剩余天数（唯一真源：profiles.target_date）
function daysFromTarget(targetDate) {
  if (!targetDate) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const target = new Date(targetDate); target.setHours(0, 0, 0, 0);
  const diff = target - today;
  return Math.max(0, Math.ceil(diff / 86400000));
}
// 统一学习天数真源：优先「含首尾」总学习天数（目标日 - 开始日），
// 缺开始日时回退「剩余天数」。所有需要 days 的接口（生成 plan / 切片 daily / 倒计时）都调用本函数，
// 避免 daysFromTarget(剩余) 与 totalStudyDays(含首尾) 不一致导致 ±1~2 天漂移。
function deriveDays(profile) {
  if (!profile) return null;
  if (profile.startDate && profile.targetDate) {
    const d = totalStudyDays(profile.startDate, profile.targetDate);
    if (d && d >= 1) return d;
  }
  return daysFromTarget(profile.targetDate);
}
// 由学习开始日推导已进行天数（profiles.start_date；未设置返回 null）
function daysFromStart(startDate) {
  if (!startDate) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const start = new Date(startDate); start.setHours(0, 0, 0, 0);
  const diff = today - start;
  return Math.max(0, Math.floor(diff / 86400000));
}
// 总学习天数 = 目标日 - 开始日（两端都设置时才有意义）
function totalStudyDays(startDate, targetDate) {
  if (!startDate || !targetDate) return null;
  const start = new Date(startDate); start.setHours(0, 0, 0, 0);
  const target = new Date(targetDate); target.setHours(0, 0, 0, 0);
  const diff = target - start;
  return Math.max(1, Math.round(diff / 86400000) + 1); // 含首尾
}
// 由开始日 + 第几天（day_number，0 为热身）推算真实日期 YYYY-MM-DD
function computeTaskDate(startDate, dayNumber) {
  if (!startDate) return null;
  const start = new Date(startDate + 'T00:00:00'); start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() + (Number(dayNumber) || 0));
  return localDateStr(start);
}
// 把 "2h" / "90m" / "120" / "2min" 等估计时长解析为整数分钟；无法解析返回 0。
function parseMinutes(s) {
  if (s == null) return 0;
  const str = String(s).trim().toLowerCase();
  // 中文格式：X小时Y分 / X小时 / X分钟
  if (/小时|分|分钟/.test(str)) {
    let total = 0;
    let m = str.match(/([\d.]+)\s*小时/);
    if (m) total += Math.round(parseFloat(m[1]) * 60);
    m = str.match(/([\d.]+)\s*分钟?/);
    if (m) total += Math.round(parseFloat(m[1]));
    // 仅含"分"但无"分钟"也能匹配（如"45分"）
    if (total === 0) {
      m = str.match(/([\d.]+)\s*分/);
      if (m) total += Math.round(parseFloat(m[1]));
    }
    return total;
  }
  // 原有格式：2h / 90m / 120
  let m = str.match(/([\d.]+)\s*h/);
  if (m) return Math.round(parseFloat(m[1]) * 60);
  m = str.match(/([\d.]+)\s*m/);
  if (m) return Math.round(parseFloat(m[1]));
  m = str.match(/^([\d.]+)$/);
  if (m) return Math.round(parseFloat(m[1]));
  return 0;
}

function parseInterviewJson(raw) {
  if (raw && typeof raw === 'object') return raw;
  const text = String(raw || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(text); } catch {}
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
  throw new Error('面经结果不是有效 JSON');
}

function normalizeInterviewGroups(value) {
  const group = (key, field) => (Array.isArray(value?.[key]) ? value[key] : [])
    .map((item) => ({
      question: String(item?.question || '').trim(),
      normalized_question: String(item?.normalized_question || item?.normalizedQuestion || '').trim(),
      [field]: String(item?.[field] || '').trim(),
    }))
    .filter((item) => item.question && item[field]);
  return {
    basic: group('basic', 'answer'),
    product: group('product', 'framework'),
    project: group('project', 'direction'),
  };
}
// 用户每日可投入分钟：从 profile.dailyStudyTime 解析，缺省 120 分钟。
function dailyCapacityMinutesOf(prof) {
  const raw = prof?.dailyStudyTime || prof?.daily_study_time;
  if (!raw) return 120;
  const v = parseMinutes(raw);
  return v > 0 ? v : 120;
}

async function handleGetProfile(req, res) {
  const userId = requireUserId(req, res); if (!userId) return;

  const profile = getProfile(userId);
  if (!profile) return sendJson(res, 404, { error: '尚未设置目标岗位' });
  // 派生字段：days 统一用含首尾真源，与生成 plan / 每日切片完全一致，前端无需各自存储
  profile.days = deriveDays(profile);
  profile.daysFromStart = daysFromStart(profile.startDate);
  profile.totalStudyDays = totalStudyDays(profile.startDate, profile.targetDate);
  // 会员状态：复用 users.tier（normal/member），映射为 isVip 布尔，不新增字段、不改用户系统
  const tier = typeof profile.tier === 'string' ? profile.tier : (profile.isVip ? 'member' : 'normal');
  profile.tier = tier;
  profile.isVip = tier === 'member';
  sendJson(res, 200, { profile });
}
async function handlePutProfile(req, res) {
  const userId = requireUserId(req, res); if (!userId) return;

  const b = await readBody(req);
  db.prepare(`
    INSERT INTO profiles (user_id, job_name, company, direction, subfield, target_date, start_date, jd_text, directions, boss_cookie, xhs_posts, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      job_name=excluded.job_name, company=excluded.company, direction=excluded.direction,
      subfield=excluded.subfield, target_date=excluded.target_date, start_date=excluded.start_date,
      jd_text=excluded.jd_text,
      directions=excluded.directions,
      boss_cookie=COALESCE(excluded.boss_cookie, profiles.boss_cookie),
      xhs_posts=excluded.xhs_posts, updated_at=excluded.updated_at
  `).run(
    userId,
    b.jobName ?? null, b.company ?? null, b.direction ?? null, b.subfield ?? null,
    b.targetDate ?? null, todayDateStr(), b.jdText ?? null,
    Array.isArray(b.directions) ? JSON.stringify(b.directions) : null,
    typeof b.bossCookie === 'string' ? b.bossCookie.trim() : null,
    Array.isArray(b.xhsPosts) ? JSON.stringify(b.xhsPosts) : null,
    Date.now()
  );
  const profile = getProfile(userId);

  // 注意：小红书帖子搜索改为「学习计划页手动点击」触发，保存岗位时不再自动搜索。

  sendJson(res, 200, { profile });
}

// ---------- 测试模式（TEST_MODE）----------
// 放在请求回调之外（模块顶层单例），保证 testDateOverride 跨请求持久。
// 开启：环境变量 TEST_MODE=1（可叠加 NOTE_LLM_MOCK / LLM_MOCK / NODE_ENV=test）。
// 效果：不调用真实大模型（笔记走 mock 结构）、支持 testDate 模拟「今天」，
//       但保留真实登录 / 数据库写入 / 动态规划逻辑。生产环境不开启时无任何副作用。
const isTestMode = process.env.NODE_ENV === 'test'
  || process.env.TEST_MODE === '1'
  || process.env.NOTE_LLM_MOCK === '1' || process.env.LLM_MOCK === '1';
// 模拟「今天」的日期覆盖（仅测试模式生效）。null 表示使用服务器真实日期。
let testDateOverride = null;
// 常驻的「网站当前日期」覆盖：独立于测试模式，任何环境都可通过 /api/current-date 设置，
// 用于让网站认为「今天是某一天」（例如跨天联调）。null 表示使用服务器真实日期。
let currentDateOverride = null;
// 生效日期优先级：测试模式 testDate > 常驻 currentDateOverride > 服务器真实日期
// 注意：取【本地时区】日期（而非 UTC），避免 GMT+8 在 UTC 晚 8 点后日期比本地慢一天（如本地 7 号但 UTC 仍 6 号）。
const todayDateStr = () => {
  if (testDateOverride) return testDateOverride;
  if (currentDateOverride) return currentDateOverride;
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

// ---------- 笔记生成进度（内存）：userId:date → {stage,percent,label,startedAt,updatedAt,timings} ----------
// 用于前端轮询 /api/learning-note/progress 展示真实进度条与各模块耗时，便于定位瓶颈。
const noteProgressMap = new Map();

// ---------- 路由 ----------
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    return res.end();
  }

  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  try {
    if (pathname === '/api/register' && req.method === 'POST') {
      return await handleRegister(await readBody(req), res);
    }
    if (pathname === '/api/login' && req.method === 'POST') {
      return await handleLogin(await readBody(req), res);
    }
    if (pathname === '/api/profile' && req.method === 'GET') {
      return await handleGetProfile(req, res);
    }
    if (pathname === '/api/profile' && req.method === 'PUT') {
      return await handlePutProfile(req, res);
    }
    if (pathname === '/api/profile' && req.method === 'POST') {
      return await handlePutProfile(req, res);
    }
    if (pathname === '/api/boss/session' && req.method === 'GET') {
      const userId = requireUserId(req, res); if (!userId) return;
      if (!isAdminUserId(userId)) return sendJson(res, 403, { error: '仅管理员可查看 Boss 登录态' });
      const row = db.prepare('SELECT boss_cookie FROM profiles WHERE user_id = ?').get(userId);
      const cookie = row?.boss_cookie || '';
      return sendJson(res, 200, {
        connected: !!String(cookie).trim(),
        cookiePreview: cookie ? `${String(cookie).slice(0, 18)}...` : '',
      });
    }
    if (pathname === '/api/boss/session' && req.method === 'PUT') {
      const userId = requireUserId(req, res); if (!userId) return;
      if (!isAdminUserId(userId)) return sendJson(res, 403, { error: '仅管理员可绑定 Boss 登录态' });
      const b = await readBody(req);
      const cookie = typeof b.cookie === 'string' ? b.cookie.trim() : '';
      db.prepare(`
        INSERT INTO profiles (user_id, boss_cookie, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          boss_cookie=excluded.boss_cookie,
          updated_at=excluded.updated_at
      `).run(userId, cookie || null, Date.now());
      return sendJson(res, 200, { connected: !!cookie });
    }
    if (pathname === '/api/boss/requirements' && req.method === 'GET') {
      const userId = requireUserId(req, res); if (!userId) return;

      const profile = getProfile(userId);
      const keyword = url.searchParams.get('keyword') || (profile && profile.jobName) || '策略产品经理';
      const city = url.searchParams.get('city') || '全国';
      const snapshot = getBossSnapshot(keyword);
      if (snapshot) return sendJson(res, 200, { ...snapshot, city, library: true });
      // 没有本地快照时，实时抓取真实 Boss 直聘岗位（校招/应届优先、大厂优先），所有用户均可获取
      try {
        const cookieRow = db.prepare('SELECT boss_cookie FROM profiles WHERE user_id = ?').get(userId);
        const data = await boss.getBossRequirements(keyword, city, {
          cookie: cookieRow?.boss_cookie || '',
        });
        if (data && data.jobs && data.jobs.length) saveBossSnapshot('manual', keyword, data);
        return sendJson(res, 200, data);
      } catch (e) {
        return sendJson(res, 502, { error: 'Boss 直聘获取失败: ' + e.message });
      }
    }
    if (pathname === '/api/learning-route/analyze' && req.method === 'POST') {
      // 阶段一：小红书多路线 -> 岗位学习路线结构化 JSON（不接入 RAG / 不读 PDF / 不生成最终计划）
      try {
        const b = await readBody(req);
        const job = typeof b.job === 'string' ? b.job.trim() : '';
        const posts = Array.isArray(b.posts) ? b.posts : [];
        if (!posts.length) {
          return sendJson(res, 400, { error: 'posts 不能为空，请提供至少一篇小红书帖子' });
        }
        if (posts.length > 10) posts.length = 10; // 上限保护
        const data = await learningRouteAnalyzer.analyzeLearningRoutes(posts, job);
        return sendJson(res, 200, data);
      } catch (e) {
        const status = e.code === 'EMPTY_POSTS' ? 400 : 502;
        return sendJson(res, status, { error: e.message, code: e.code || 'ANALYZE_FAILED' });
      }
    }
    if (pathname === '/api/skills/normalize' && req.method === 'POST') {
      // 技能标准化接口：两种输入形态
      //   A) { job, skills:[{name,level,category}] }  —— 标准接口形态（主链路自动调用）
      //   B) { route }                                —— 向后兼容：学习路线 JSON
      try {
        const b = await readBody(req);
        const job = typeof b.job === 'string' ? b.job.trim() : '';

        // 形态 A
        if (Array.isArray(b.skills) && b.skills.length) {
          const data = skillNormalizer.normalizeSkills({ job, skills: b.skills });
          return sendJson(res, 200, data);
        }
        // 形态 B（兼容）
        const route = b.route && typeof b.route === 'object' ? b.route : null;
        if (route) {
          const data = skillNormalizer.normalizeRoute({ ...route, job: route.job || job });
          return sendJson(res, 200, data);
        }
        return sendJson(res, 400, { error: '请提供 skills:[{name,level,category}] 或 route 对象', code: 'EMPTY_INPUT' });
      } catch (e) {
        return sendJson(res, 502, { error: e.message, code: e.code || 'NORMALIZE_FAILED' });
      }
    }

    // ============ MVP 主链路：岗位 -> 技能树 -> 标准化 -> 资源匹配 -> 总体阶段计划 ============
    // 一次调用跑完全链路，只产出【阶段级】总体计划，不做每日拆分。
    // 资源（PDF / B站视频）全部由代码从真实系统检索并回填，LLM 不得编造。
    if (pathname === '/api/mvp/plan' && req.method === 'POST') {
      const userId = requireUserId(req, res); if (!userId) return;
      try {
        const b = await readBody(req);
        const job = String(b.job || '').trim();
        if (!job) return sendJson(res, 400, { error: 'job（目标岗位）不能为空', code: 'EMPTY_JOB' });
        const force = b.force === true || url.searchParams.get('force') === '1';

        // 每次生成都保存为最新版：直接覆盖 learning_plans（不再 409 拦截）

        const trace = [];
        // ---- 步骤 1：小红书素材（前端传入优先；未传则按岗位实时采集）----
        let posts = Array.isArray(b.xhsPosts) ? b.xhsPosts.filter((p) => p && (p.content || p.ocrText)) : [];
        let xhsFallback = false;   // 本次是否因小红书不可用而降级
        let xhsSearchStatus = 'empty';
        let xhsError = '';        // 降级原因（供前端提示）
        let xhsNeedLogin = false;  // 小红书是否需要登录
        if (!posts.length) {
          try {
            // 切换式隔离：生成路线前切到当前用户自己的小红书 cookie
            plan.setXhsActiveUser(userId);
            const searched = await plan.searchXhsPostsPaginated(job, 1, 5);
            xhsSearchStatus = searched?.searchStatus || (searched?.posts?.length ? 'success' : (searched?.needLogin ? 'blocked' : 'empty'));
            console.log('[XHS SEARCH]', JSON.stringify({ keyword: job, resultCount: Array.isArray(searched?.posts) ? searched.posts.length : 0, status: xhsSearchStatus }));
            const metas = (searched?.posts || []).slice(0, 3);
            // 搜索接口只返回元数据，正文/OCR 需逐篇懒加载后才能供技能抽取使用
            const details = await Promise.all(metas.map(async (m) => {
              try {
                const d = await plan.getXhsPostDetail(m.id, m.xsecToken);
                return { id: m.id || '', xsecToken: m.xsecToken || '', title: m.title || '', link: m.link || m.url || '', author: m.author || '', content: d?.content || '', ocrText: d?.ocrText || '', ocrUsed: Boolean(d?.ocrText && String(d.ocrText).trim()) };
              } catch { return null; }
            }));
            posts = details.filter((p) => p && (p.content || p.ocrText));
            if (!posts.length) {
              xhsFallback = true;
              xhsNeedLogin = !!(searched && searched.needLogin);
              xhsError = (searched && searched.needLogin)
                ? '小红书未登录，已使用纯岗位模式生成计划'
                : '未获取到小红书数据（MCP 未连通或搜索无结果），已使用纯岗位模式生成计划';
            }
          } catch (e) {
            console.warn('[mvp/plan] 小红书采集失败，降级为无帖子模式:', e.message);
            xhsFallback = true;
            xhsError = '小红书采集失败（' + e.message + '），已使用纯岗位模式生成计划';
          }
        }
        posts = posts.slice(0, 6);
        trace.push({ step: 'xhs', count: posts.length, fallback: xhsFallback, error: xhsError });

        // ---- 步骤 2：技能树抽取（LLM）----
        let route;
        if (skillNormalizer.isAiProductManagerJob(job)) {
          // AI 产品经理使用岗位能力目录，避免让通用 LLM 抽取漂移到普通产品/工程技能。
          route = {
            _source: 'role_catalog',
            core_skills: skillNormalizer.AI_PM_SKILL_CATALOG.map((s) => ({
              skill: s.name,
              level: s.level,
              category: s.category,
            })),
          };
        } else {
          if (posts.length) route = await learningRouteAnalyzer.analyzeLearningRoutes(posts, job);
          // 小红书未登录/无结果，或抽取结果为空时，降级为「仅凭岗位」抽取技能树，保证链路可跑通
          if (!route || !(route.core_skills || []).length) route = await learningRouteAnalyzer.analyzeRouteByJobOnly(job);
        }
        trace.push({ step: 'skillTree', coreSkills: (route.core_skills || []).length, source: route._source || 'xhs' });

        // ---- 步骤 3：技能标准化（用标准接口形态 {job, skills}）----
        const xhsSources = posts.map((p) => ({
          id: p.id || '', title: p.title || '', link: p.link || '', author: p.author || '',
          contentLength: String(p.content || '').length, ocrLength: String(p.ocrText || '').length,
          ocrUsed: Boolean(p.ocrUsed || String(p.ocrText || '').trim()),
        })).filter((p) => p.id || p.title);
        trace.push({ step: 'xhs', count: xhsSources.length, ocrCount: xhsSources.filter((p) => p.ocrUsed).length });
        // RAG 向量写入不阻塞学习计划主请求；帖子已取得后后台去重写入。
        const xhsRagPosts = posts.map((post) => ({
          post,
          content: [post.title, post.content, post.ocrText].filter(Boolean).join('\n\n').trim(),
        })).filter(({ post, content }) => content && post.id);
        void Promise.all(xhsRagPosts.map(async ({ post, content }) => {
          try { await rag.ingestDocument({ docId: `xhs_${post.id}`, title: post.title || post.id, content }, { source: 'xhs', force: false }); }
          catch (e) { console.warn('[mvp/plan] 小红书 RAG 写入失败:', post.id, e.message); }
        }));
        trace.push({ step: 'xhsRag', queued: xhsRagPosts.length });

        const rawSkillList = (route.core_skills || []).map((c) => ({
          name: c.skill || c.name || c.title || '',
          level: c.level || 'beginner',
          category: c.category || 'other',
        })).filter((s) => s.name);
        const skillTree = skillNormalizer.normalizeSkills({ job, skills: rawSkillList });
        trace.push({ step: 'normalize', skills: (skillTree.skills || []).length });

        // ---- 步骤 4+5：真实资源匹配（纯代码，无 LLM）----
        const matched = await skillResourceMatcher.matchResources(skillTree, { job });
        trace.push({ step: 'resources', pdf: matched.pdfResources.length, video: matched.videoResources.length, missing: matched.coverage.missing.length });

        // ---- 步骤 6：阶段级总体计划（LLM 划分阶段 + 代码回填真实资源）----
        const stagePlan = await stagePlanGenerator.generateStagePlan({
          job,
          skillTree,
          skills: matched.skills,
          pdfResources: matched.pdfResources,
          videoResources: matched.videoResources,
          coverage: matched.coverage,
          xhsSources,
        });
        trace.push({ step: 'stagePlan', stages: (stagePlan.stages || []).length });

        // ---- 步骤 5.5：把已匹配的真实资源持久化到 matched_resources（资源缓存层），后续每日计划直接读缓存，不再调 B站搜索 ----
        // 注意：planId 必须与全系统一致（buildPlanId = `plan_${userId}`），否则资源缓存与计划/每日任务三层对不上。
        const planId = buildPlanId(userId);
        try {
          const persisted = skillResourceMatcher.persistMatchedResources(db, {
            planId,
            pdfResources: matched.pdfResources,
            videoResources: matched.videoResources,
          });
          trace.push({ step: 'persistResources', saved: persisted.saved });
        } catch (e) {
          console.warn('[mvp/plan] 资源缓存写入失败（不影响计划生成）:', e.message);
        }

        const result = {
          ...stagePlan,
          planType: 'stage_only', // 明确标记：不含每日计划
          skillTree: { job: skillTree.job, categories: skillTree.categories, skills: skillTree.skills, normalized_skill_dependencies: skillTree.normalized_skill_dependencies },
          resourcePool: { pdf: matched.pdfResources, videos: matched.videoResources },
          coverage: matched.coverage,
          xhsFallback,          // 本次是否因小红书不可用而降级
          xhsSearchStatus,
          loginStatus: !xhsNeedLogin,
          xhsError,             // 降级原因（前端据此提示用户）
          trace,
        };

        const now = Date.now();
        try {
          db.prepare(`INSERT INTO learning_plans (user_id, job, data, progress, created_at, updated_at)
            VALUES (?,?,?,?,?,?)
            ON CONFLICT(user_id) DO UPDATE SET job=excluded.job, data=excluded.data, progress=excluded.progress, updated_at=excluded.updated_at`)
            .run(userId, job, JSON.stringify(result), null, now, now);
        } catch (e) {
          console.warn('[mvp/plan] 保存学习计划失败:', e.message);
        }
        return sendJson(res, 200, { ...result, saved: true, overwritten: true });
      } catch (e) {
        const status = ['EMPTY_JOB', 'EMPTY_SKILLS', 'EMPTY_ROUTE'].includes(e.code) ? 400 : 502;
        console.error('[mvp/plan] 生成失败:', e);
        return sendJson(res, status, { error: e.message, code: e.code || 'MVP_PLAN_FAILED' });
      }
    }

    // 读取当前用户已保存的学习计划（前端据此判断是否需要弹出「覆盖确认」）
    if (pathname === '/api/learning-plan' && req.method === 'GET') {
      const userId = requireUserId(req, res); if (!userId) return;
      const row = db.prepare('SELECT job, data, progress, created_at, updated_at FROM learning_plans WHERE user_id = ?').get(userId);
      if (!row) return sendJson(res, 200, { exists: false, plan: null });
      let planData = null;
      let progress = null;
      try { planData = JSON.parse(row.data); } catch { planData = null; }
      try { progress = row.progress ? JSON.parse(row.progress) : null; } catch { progress = null; }
      return sendJson(res, 200, {
        exists: true,
        job: row.job || '',
        plan: planData,
        progress,
        created_at: row.created_at,
        updated_at: row.updated_at,
      });
    }
    // 删除当前用户的学习计划（含学习进度）
    if (pathname === '/api/learning-plan' && req.method === 'DELETE') {
      const userId = requireUserId(req, res); if (!userId) return;
      db.prepare('DELETE FROM learning_plans WHERE user_id = ?').run(userId);
      return sendJson(res, 200, { ok: true });
    }
    // 保存学习进度（不动计划本身）
    if (pathname === '/api/learning-plan/progress' && req.method === 'PATCH') {
      const userId = requireUserId(req, res); if (!userId) return;
      const b = await readBody(req);
      const existing = db.prepare('SELECT user_id FROM learning_plans WHERE user_id = ?').get(userId);
      if (!existing) return sendJson(res, 404, { error: '尚未生成学习计划', code: 'NO_PLAN' });
      db.prepare('UPDATE learning_plans SET progress = ?, updated_at = ? WHERE user_id = ?')
        .run(JSON.stringify(b.progress ?? {}), Date.now(), userId);
      return sendJson(res, 200, { ok: true });
    }
    if (pathname === '/api/learning-plan/generate' && req.method === 'POST') {
      const userId = requireUserId(req, res); if (!userId) return;
      try {
        const b = await readBody(req);
        const job = typeof b.job === 'string' ? b.job : (b.job && b.job.job) || '';
        const skillTree = b.skillTree && typeof b.skillTree === 'object' ? b.skillTree : null;
        const pdfResources = Array.isArray(b.pdfResources) ? b.pdfResources : [];
        const videoResources = Array.isArray(b.videoResources) ? b.videoResources : [];
        // generationMode 标识本次生成链路：xhs_rag（小红书+本地RAG）| rag_only（仅本地RAG）
        const generationMode = b.generationMode === 'xhs_rag' ? 'xhs_rag' : 'rag_only';
        const xhsPosts = Array.isArray(b.xhsPosts) ? b.xhsPosts : [];
        // force=true 表示用户已在弹框中确认「覆盖旧计划」
        const force = b.force === true || url.searchParams.get('force') === '1';
        if (!skillTree) {
          return sendJson(res, 400, { error: 'skillTree 不能为空（需包含 skills 与 skill_dependencies）', code: 'EMPTY_SKILL_TREE' });
        }
        // 每次生成都保存为最新版：直接覆盖 learning_plans（不再 409 拦截）
        const data = await learningPlanGenerator.generateLearningPlan({ job, skillTree, pdfResources, videoResources });
        // 每用户仅保留一条最新计划；覆盖时 progress 一并清空（旧进度不保留）
        const now = Date.now();
        // 将本次生成链路（模式 + 小红书素材）并入存储记录，便于审计与回显
        const stored = { ...data, generationMode, xhsPosts };
        try {
          db.prepare(`INSERT INTO learning_plans (user_id, job, data, progress, created_at, updated_at)
            VALUES (?,?,?,?,?,?)
            ON CONFLICT(user_id) DO UPDATE SET job=excluded.job, data=excluded.data, progress=excluded.progress, updated_at=excluded.updated_at`)
            .run(userId, job || (skillTree && skillTree.job) || '', JSON.stringify(stored), null, now, now);
        } catch (e) {
          console.warn('[learning-plan] 保存学习计划失败:', e.message);
        }
        return sendJson(res, 200, { ...stored, saved: true, overwritten: true });
      } catch (e) {
        const status = e.code === 'EMPTY_SKILL_TREE' ? 400 : 502;
        return sendJson(res, status, { error: e.message, code: e.code || 'PLAN_GENERATE_FAILED' });
      }
    }
    if (pathname === '/api/admin/boss/refresh' && req.method === 'POST') {
      const userId = requireUserId(req, res); if (!userId) return;
      if (!isAdminUserId(userId)) return sendJson(res, 403, { error: '仅管理员可执行 Boss 刷新' });
      try {
        const result = await refreshBossSnapshotsOnce();
        return sendJson(res, 200, { ok: true, ...result, keywords: listDirectionConfigs() });
      } catch (e) {
        return sendJson(res, 502, { error: 'Boss 本地岗位库刷新失败: ' + e.message });
      }
    }
    if (pathname === '/api/admin/boss/snapshots' && req.method === 'GET') {
      const userId = requireUserId(req, res); if (!userId) return;
      if (!isAdminUserId(userId)) return sendJson(res, 403, { error: '仅管理员可查看 Boss 本地岗位库' });
      const rows = db.prepare('SELECT keyword, direction_id, total, fetched_at, fetched_date, source FROM boss_snapshots ORDER BY keyword').all();
      return sendJson(res, 200, {
        items: rows,
        schedule: { hour: BOSS_REFRESH_HOUR, minute: BOSS_REFRESH_MINUTE },
        directions: listDirectionConfigs(),
      });
    }
    if (pathname === '/api/admin/directions' && req.method === 'GET') {
      const userId = requireUserId(req, res); if (!userId) return;
      if (!isAdminUserId(userId)) return sendJson(res, 403, { error: '仅管理员可查看岗位方向配置' });
      return sendJson(res, 200, { items: listDirectionConfigs() });
    }
    if (pathname === '/api/admin/directions' && req.method === 'PATCH') {
      const userId = requireUserId(req, res); if (!userId) return;
      if (!isAdminUserId(userId)) return sendJson(res, 403, { error: '仅管理员可修改岗位方向配置' });
      const body = await readBody(req);
      const id = String(body.id || '').trim();
      const name = String(body.name || '').trim();
      const keyword = String(body.keyword || '').trim();
      const enabled = body.enabled ? 1 : 0;
      const fetchCount = Math.max(1, Math.min(30, Number(body.fetchCount) || 10));
      const sampleCount = Math.max(1, Math.min(5, Number(body.sampleCount) || 5));
      const sortOrder = Math.max(0, Number(body.sortOrder) || 0);
      if (!id) return sendJson(res, 400, { error: '缺少方向 id' });
      if (!name) return sendJson(res, 400, { error: '缺少方向名称' });
      if (!keyword) return sendJson(res, 400, { error: '缺少抓取关键词' });
      const exists = db.prepare('SELECT id FROM direction_configs WHERE id = ?').get(id);
      if (!exists) return sendJson(res, 404, { error: '岗位方向不存在' });
      db.prepare(`
        UPDATE direction_configs
        SET name = ?, keyword = ?, enabled = ?, fetch_count = ?, sample_count = ?, sort_order = ?, updated_at = ?
        WHERE id = ?
      `).run(name, keyword, enabled, fetchCount, sampleCount, sortOrder, Date.now(), id);
      return sendJson(res, 200, { ok: true, item: listDirectionConfigs().find((item) => item.id === id) || null });
    }
    if (pathname === '/api/admin/users' && req.method === 'GET') {
      const userId = requireUserId(req, res); if (!userId) return;
      if (!isAdminUserId(userId)) return sendJson(res, 403, { error: '仅管理员可查看用户列表' });
      const rows = db.prepare(`
        SELECT
          u.id, u.username, u.role, u.tier, u.created_at,
          p.job_name, p.company, p.updated_at
        FROM users u
        LEFT JOIN profiles p ON p.user_id = u.id
        ORDER BY
          CASE WHEN u.role = 'admin' THEN 0 ELSE 1 END,
          u.created_at DESC
      `).all();
      const items = rows.map((row) => ({
        id: row.id,
        username: row.username,
        role: row.role || 'user',
        tier: row.tier || 'normal',
        userType: getUserDisplayType(row),
        createdAt: row.created_at || null,
        updatedAt: row.updated_at || null,
        jobName: row.job_name || '',
        company: row.company || '',
      }));
      const summary = {
        total: items.length,
        admins: items.filter((item) => item.role === 'admin').length,
        members: items.filter((item) => item.tier === 'member' && item.role !== 'admin').length,
        normalUsers: items.filter((item) => item.role === 'user' && item.tier !== 'member').length,
      };
      return sendJson(res, 200, { items, summary });
    }
    if (pathname === '/api/admin/users' && req.method === 'PATCH') {
      const userId = requireUserId(req, res); if (!userId) return;
      if (!isAdminUserId(userId)) return sendJson(res, 403, { error: '仅管理员可调整用户分类' });
      const body = await readBody(req);
      const targetUserId = Number(body.userId || 0);
      const role = String(body.role || '').trim();
      const tier = String(body.tier || '').trim();
      if (!targetUserId) return sendJson(res, 400, { error: '缺少 userId' });
      if (!ADMIN_USER_ROLES.has(role)) return sendJson(res, 400, { error: '无效的角色类型' });
      if (!ADMIN_USER_TIERS.has(tier)) return sendJson(res, 400, { error: '无效的会员类型' });
      if (targetUserId === userId && role !== 'admin') {
        return sendJson(res, 400, { error: '不能把当前登录管理员降级' });
      }
      const target = db.prepare('SELECT id, username FROM users WHERE id = ?').get(targetUserId);
      if (!target) return sendJson(res, 404, { error: '用户不存在' });
      db.prepare('UPDATE users SET role = ?, tier = ? WHERE id = ?').run(role, tier, targetUserId);
      return sendJson(res, 200, {
        ok: true,
        user: {
          id: targetUserId,
          username: target.username,
          role,
          tier,
          userType: getUserDisplayType({ role, tier }),
        },
      });
    }
    if (pathname === '/api/boss/search' && req.method === 'GET') {
      const keyword = url.searchParams.get('keyword') || '策略产品经理';
      const city = url.searchParams.get('city') || '全国';
      try {
        const data = await boss.getBossRequirements(keyword, city);
        return sendJson(res, 200, data);
      } catch (e) {
        return sendJson(res, 502, { error: 'Boss 直聘获取失败: ' + e.message });
      }
    }
    // 固定技能树：阶段(一级) → 技能(二级) → 搜索词(三级)。
    // 技能树来自 AI_PM_SKILL_MAP（固定能力模型，不依赖 LLM / 小红书 / 历史快照）；
    // 三级搜索词由 mergeBiliKeywords 生成（固定意图词，趋势词仅在运行时动态追加，不进树结构）。
    if (pathname === '/api/skill-tree' && req.method === 'GET') {
      try {
        const stageMap = skillNormalizer.AI_PM_STAGE_MAP || [];
        const skillMap = skillNormalizer.AI_PM_SKILL_MAP || [];
        const job = url.searchParams.get('job') || 'AI产品经理';
        // 读取已持久化的小红书趋势词，转成 mergeBiliKeywords 期望的 trends 结构，
        // 让前端技能树也能按技能名匹配、显示随小红书变化的橙色趋势词（全阶段通用，不只阶段三）。
        // 注意：db.mjs 在 JSON 模式下 xhs_trend_keywords 是内存数组（非 SQL），故直接读 db.state.tables。
        let xhsTrends = [];
        try {
          let rows = [];
          if (db.state && db.state.tables && Array.isArray(db.state.tables.xhs_trend_keywords)) {
            rows = db.state.tables.xhs_trend_keywords;
          } else {
            rows = plan.loadXhsTrends(db);
          }
          xhsTrends = rows.map((r) => {
            // db.mjs 在 JSON 模式下，xhs_trend_keywords 每行是 { keyword: [数组] }，
            // 数组顺序：[keyword, skill, total_count, recent_count, last_seen, relevance_score, trend_score, source, created_at]；
            // 同时兼容 SQL 模式的对象格式（r.keyword 为字符串）。
            const arr = Array.isArray(r.keyword) ? r.keyword : null;
            return {
              keyword: arr ? arr[0] : r.keyword,
              skill: arr ? arr[1] : r.skill,
              trendScore: Number(arr ? (arr[3] || arr[2] || arr[6] || 0) : (r.recent_count || r.total_count || r.trend_score || 0)),
              source: arr ? arr[7] : r.source,
            };
          });
        } catch (e) {
          console.warn('[skill-tree] 读取小红书趋势词失败，按纯固定词展示:', e.message);
        }
        const stages = stageMap.map((stageItem, idx) => {
          const skills = skillMap
            .filter((s) => s.stage === stageItem.stage)
            .map((s) => {
              const kws = skillResourceMatcher.mergeBiliKeywords(
                { name: s.skillName }, job, xhsTrends, {}
              );
              return {
                skillName: s.skillName,
                category: s.category,
                level: s.level,
                weight: s.weight,
                keywords: kws.map((k) => ({ keyword: k.keyword, intent: k.intent, isTrend: k.isTrend })),
              };
            });
          return {
            stage: stageItem.stage,
            order: idx + 1,
            description: stageItem.searchIntent || '',
            skillCount: skills.length,
            skills,
          };
        });
        const totalSkills = stages.reduce((sum, st) => sum + st.skills.length, 0);
        return sendJson(res, 200, {
          ok: true,
          job,
          generatedAt: Date.now(),
          stageCount: stages.length,
          skillCount: totalSkills,
          stages,
        });
      } catch (e) {
        return sendJson(res, 500, { error: '技能树生成失败: ' + e.message });
      }
    }
    if (pathname === '/api/mailbox/account' && req.method === 'GET') {
      const userId = requireUserId(req, res); if (!userId) return;
      return sendJson(res, 200, { account: getMailboxAccount(userId), accounts: listMailboxAccounts(userId) });
    }
    if (pathname === '/api/mailbox/account' && req.method === 'PUT') {
      const userId = requireUserId(req, res); if (!userId) return;
      const body = await readBody(req);
      const provider = String(body.provider || 'qq').trim() || 'qq';
      const email = String(body.email || '').trim();
      const authCode = String(body.authCode || '').trim();
      const imapHost = String(body.imapHost || '').trim();
      const imapPort = Math.max(1, Number(body.imapPort) || 0);
      const smtpHost = String(body.smtpHost || '').trim();
      const smtpPort = Math.max(1, Number(body.smtpPort) || 0);
      const enabled = body.enabled ? 1 : 0;
      const pollingMinutes = Math.max(5, Math.min(60, Number(body.pollingMinutes) || 10));
      if (!email) return sendJson(res, 400, { error: '请填写邮箱账号' });
      db.prepare(`
        INSERT INTO email_accounts (
          user_id, provider, email, auth_code, imap_host, imap_port, smtp_host, smtp_port, enabled, polling_minutes, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, email) DO UPDATE SET
          provider=excluded.provider,
          email=excluded.email,
          auth_code=excluded.auth_code,
          imap_host=excluded.imap_host,
          imap_port=excluded.imap_port,
          smtp_host=excluded.smtp_host,
          smtp_port=excluded.smtp_port,
          enabled=excluded.enabled,
          polling_minutes=excluded.polling_minutes,
          updated_at=excluded.updated_at
      `).run(userId, provider, email, authCode, imapHost, imapPort, smtpHost, smtpPort, enabled, pollingMinutes, Date.now());
      return sendJson(res, 200, { ok: true, account: getMailboxAccount(userId), accounts: listMailboxAccounts(userId) });
    }
    if (pathname === '/api/mailbox/account' && req.method === 'DELETE') {
      const userId = requireUserId(req, res); if (!userId) return;
      const body = await readBody(req);
      const email = String(body.email || '').trim();
      if (!email) return sendJson(res, 400, { error: '请指定要解绑的邮箱' });
      const info = db.prepare('DELETE FROM email_accounts WHERE user_id = ? AND email = ?').run(userId, email);
      return sendJson(res, 200, { ok: true, deleted: info.changes > 0, accounts: listMailboxAccounts(userId) });
    }
    if (pathname === '/api/mailbox/test' && req.method === 'POST') {
      const userId = requireUserId(req, res); if (!userId) return;
      const body = await readBody(req).catch(() => ({}));
      const email = body && body.email ? String(body.email) : undefined;
      try {
        const result = await mailbox.testMailboxConnection(getMailboxAccount(userId, email));
        return sendJson(res, 200, { ok: true, ...result });
      } catch (e) {
        return sendJson(res, 502, { error: '邮箱连接失败: ' + e.message });
      }
    }
    if (pathname === '/api/mailbox/invites' && req.method === 'GET') {
      const userId = requireUserId(req, res); if (!userId) return;
      const limit = Math.max(1, Math.min(20, Number(url.searchParams.get('limit')) || 10));
      const email = url.searchParams.get('email') || undefined;
      try {
        const result = await mailbox.syncInterviewInvites(getMailboxAccount(userId, email), limit);
        const items = Array.isArray(result.items) ? result.items : [];
        if (items.length) saveInterviewEvents(userId, items);
        return sendJson(res, 200, {
          scanned: result.scanned || 0,
          items: listInterviewEvents(userId).slice(0, limit),
        });
      } catch (e) {
        return sendJson(res, 502, { error: '邮箱同步失败: ' + e.message });
      }
    }
    if (pathname === '/api/interviews' && req.method === 'GET') {
      const userId = requireUserId(req, res); if (!userId) return;
      return sendJson(res, 200, { items: listInterviewEvents(userId) });
    }
    if (pathname === '/api/interviews/schedules' && req.method === 'GET') {
      const userId = requireUserId(req, res); if (!userId) return;
      return sendJson(res, 200, { items: listInterviewSchedules(userId) });
    }
    if (pathname === '/api/interviews/confirm' && req.method === 'POST') {
      const userId = requireUserId(req, res); if (!userId) return;
      const body = await readBody(req);
      const id = String(body.id || '').trim();
      if (!id) return sendJson(res, 400, { error: '缺少面试 id' });
      try {
        createInterviewSchedule(userId, id);
        return sendJson(res, 200, {
          ok: true,
          items: listInterviewEvents(userId),
          schedules: listInterviewSchedules(userId),
        });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }
    // ============ AI 面经整理模块 ============
    // POST /api/interview-experience/search
    // 流程：实时小红书搜索 -> RAG 历史检索 -> 一次 LLM 整理 -> 存库 -> 返回
    // 成本控制：LLM 仅在最终整理阶段调用一次；小红书帖子原样入库（不单独调 LLM）。
    if (pathname === '/api/interview-experience/search' && req.method === 'POST') {
      const userId = requireUserId(req, res); if (!userId) return;
      const b = await readBody(req);
      const company = String(b.company || '').trim();
      const role = String(b.role || '').trim();
      const round = String(b.round || '').trim();
      // useLocalOnly=true：用户选择「不绑定小红书，直接用本地面经库」，跳过小红书实时采集。
      const useLocalOnly = b.useLocalOnly === true;
      if (!company || !role || !round) {
        return sendJson(res, 400, { error: '公司、岗位、轮次均必填' });
      }
      try {
        const now = Date.now();
        // cache 写入统计（提前声明，避免小红书结构化步骤在声明前访问导致 TDZ 报错）
        const cacheWriteStats = { hit: 0, inserted: 0 };
        // 同一用户 + 公司 + 岗位 + 轮次 = 一次岗位面经（增量累加，不复建）
        let session = db.prepare(`
          SELECT id, company, role, round, created_at FROM interview_sessions
          WHERE user_id = ? AND company = ? AND role = ? AND round = ?
          LIMIT 1
        `).get(userId, company, role, round);
        if (!session) {
          const sid = `iv_${userId}_${now}_${Math.random().toString(16).slice(2, 8)}`;
          db.prepare(`INSERT INTO interview_sessions (id, user_id, company, role, round, created_at) VALUES (?,?,?,?,?,?)`)
            .run(sid, userId, company, role, round, now);
          session = { id: sid, company, role, round, created_at: now };
        }
        const sessionId = session.id;
        const cntRow = db.prepare(`SELECT COUNT(*) AS c FROM interview_sources WHERE session_id = ? AND source_type = 'xiaohongshu'`).get(sessionId);
        const searchIndex = ((cntRow && cntRow.c) || 0) + 1;

        // 已消费过的来源（去重，保证增量不重复追加）
        const usedIds = new Set(
          (db.prepare(`SELECT ref_id FROM interview_source_ids WHERE session_id = ?`).all(sessionId) || []).map((r) => r.ref_id)
        );

        // 当前用户是否已绑定自己的小红书（与生成计划一致：以 users.xhs_bound 为准，绝不读本地缓存短路）
        let xhsBound = false;
        try {
          const ub = db.prepare('SELECT xhs_bound FROM users WHERE id = ?').get(userId);
          xhsBound = !!(ub && ub.xhs_bound === 1);
        } catch { xhsBound = false; }

        // ---- 步骤 1：增量小红书 —— 只取 1 篇「新」帖子（跳过已用 post_id）----
        // useLocalOnly=true（用户选择「不绑定小红书，直接用本地面经库」）时直接跳过采集，不弹框不报错。
        const xhs = (useLocalOnly || !xhsBound)
          ? { posts: [], needLogin: !xhsBound, skipped: useLocalOnly }
          : (plan.setXhsActiveUser(userId), await plan.searchXhsInterview({ company, role, round, page: Math.floor((searchIndex - 1) / 10) + 1, pageSize: 10 }));
        const xhsPosts = xhs.posts || [];
        const xhsDetails = [];
        for (const p of xhsPosts) {
          if (xhsDetails.length >= 1) break;
          if (!p.id || usedIds.has(`xhs:${p.id}`)) continue; // 跳过已用帖子
          try {
            const d = await plan.getXhsPostDetail(p.id, p.xsecToken);
            const fullText = [d?.content || '', d?.ocrText || ''].filter(Boolean).join('\n\n（图片文字）\n').trim();
            xhsDetails.push({
              postId: p.id,
              title: p.title || '',
              content: fullText,
              author: p.author || '',
              link: p.link || '',
              source: 'xiaohongshu',
            });
          } catch { /* 单篇失败不影响整体 */ }
        }

        // ---- 步骤 2：增量 RAG —— 只返回「新」的 10 个常考问题（过滤已用）----
        let ragChunks = process.env.INTERVIEW_LLM_MOCK === '1'
          ? [{ id: `mock:${company}:${role}:${round}`, content: `${company}${role}${round}：请结合岗位职责说明你的项目经验、产品分析方法和复盘结果。`, meta: { source: 'mock' } }]
          : [];
        if (process.env.INTERVIEW_LLM_MOCK !== '1') {
          try {
            // 用纯向量检索，不限 source：RAG 库里真实面经素材在 file / xhs / interview 三类，
            // 若限定 source='interview'（retrieveInterview 的硬编码）只会命中空的百度 doc。
            // 这里 query 做语义检索，可命中「AI产品经理面试高频100题」等真实面经正文。
            ragChunks = await rag.retrieve(
              `AI产品经理 高频面试题 常考问题 产品设计 实战经验`,
              { topK: 12, source: null }
            );
          } catch (e) {
            console.warn('[interview-exp] RAG 检索失败，继续使用小红书素材:', e.message);
          }
        }
        // 增量去重：只用稳定的 chunk id 作为 ref（rowid 在 RAG 库内唯一且不变，
        // mock 模式下为 `mock:公司:岗位:轮次` 同样稳定）。
        // 去掉原先 content.slice(0,40) 兜底——模板化高频题前 40 字易相同，会导致
        // 不同 chunk 误判为同一题（漏掉新题）或重复进 LLM（加重 token）。
        const ragRef = (c) => `rag:${c.id ?? c.chunkId ?? c.meta?.id ?? ''}`;
        ragChunks = (ragChunks || [])
          .filter((c) => !!c.id || !!c.chunkId || !!c.meta?.id) // 无稳定 id 的 chunk 不参与去重，避免误并入
          .filter((c) => !usedIds.has(ragRef(c)))
          .slice(0, 10);

        // ---- 步骤 3：本次新增帖子原文入库 RAG（原样保存，不调 LLM）----
        for (let i = 0; i < xhsDetails.length; i++) {
          const d = xhsDetails[i];
          if (!d.content) continue;
          const docId = `xhs_iv_${sessionId}_${now}_${i}`;
          try {
            await rag.ingestDocument({
              docId, source: 'interview', title: d.title, content: d.content,
              meta: { source: 'xiaohongshu', type: 'interview', company, role, round, post_id: d.postId },
            });
          } catch { /* 入库失败不阻断主流程 */ }
        }

        // ---- 步骤 3.5：小红书面经主动结构化（Interview Question Cache 入口1）----
        // 仅对本次新增且判定为面经的帖子做一次性 LLM 结构化，写入 cache（source='xiaohongshu'）。
        // 不修改采集模块；用 usedIds 中已有的 `xhs:${postId}` 防同帖重复结构化。
        const xhsStructuredIds = [];
        if (process.env.INTERVIEW_LLM_MOCK !== '1') {
          for (const d of xhsDetails) {
            if (!d.content) continue;
            if (usedIds.has(`xhs:${d.postId}`) && xhsStructuredIds.includes(d.postId)) continue; // 本帖已结构化
            if (!questionCache.isInterviewPost(d.content)) continue; // 非面经帖只进 RAG，不结构化
            try {
              const sysXhs = `你是面试知识结构化引擎。从单篇小红书面经帖中提取所有面试问题并结构化。
要求：
1. 基础问题(basic)：有标准答案的知识点 → {question, normalized_question, answer(一句话简答)}。
2. 场景设计问题(product)：无唯一答案 → {question, normalized_question, framework(回答框架，分点列出思考步骤)}。
3. 项目经历问题(project)：结合候选人自身经历 → {question, normalized_question, direction(准备方向，分点列出)}。
normalized_question 规则（严格遵守）：
- 必须采用「主题_关系」固定语义标签，仅使用英文、数字与下划线，禁止自然语言句子或问句。
- 严禁 CamelCase / PascalCase 驼峰式（如 TechMaturity、Requirements、ProductDesign 均为错误）；每个词用下划线分隔，约定专有名词（RAG、Agent、MCP、BGE、AI、PM）保留大写，其余小写。
- 禁止 How_RAG_works / Difference_between_RAG_and_FT / What_is_MCP 这类自然语言转写。
- 标准范式：
  * 定义类：主题_definition（什么是MCP → MCP_definition；什么是RAG → RAG_definition；AI产品经理定义 → AI_PM_definition）
  * 对比类：主题A_vs_主题B（RAG和Fine-tuning区别 → RAG_vs_FineTuning）
  * 方法类：主题_方法（Prompt工程 → Prompt_engineering；RAG技术成熟度 → RAG_tech_maturity）
  * 场景类：主题_场景（AI产品需求分析 → AI_product_requirement_analysis）
  * 项目经历类：AI_project_experience（所有"介绍项目"类问题统一用此值）
- 同类问题无论表述变化，normalized_question 必须完全一致。
只输出 JSON：{"basic":[...],"product":[...],"project":[...]}。`;
              const usrXhs = `公司：${company}\n岗位：${role}\n轮次：${round}\n\n【小红书面经帖】\n标题：${d.title}\n正文：${d.content}`;
              const rawX = await plan.callQwen(sysXhs, usrXhs, process.env.QWEN_MODEL || 'qwen-turbo');
              const grp = normalizeInterviewGroups(parseInterviewJson(rawX));
              const TYPE_MAP_X = { basic: '基础问题', product: '场景问题', project: '项目问题' };
              for (const [type, items] of Object.entries(grp)) {
                for (const q of (items || [])) {
                  if (!q.question) continue;
                  const norm = q.normalized_question || q.question;
                  await questionCache.upsertQuestion({
                    question: q.question,
                    normalized_question: norm,
                    question_type: TYPE_MAP_X[type],
                    answer: type === 'basic' ? q.answer : (type === 'product' ? q.framework : q.direction),
                    company, position: role, round,
                    source: 'xiaohongshu',
                    source_chunk_id: [`xhs:${d.postId}`],
                  });
                }
              }
              xhsStructuredIds.push(d.postId);
              cacheWriteStats.inserted += 0; // 仅计数用户流插入，小红书沉淀不计入用户流 cacheStats
              console.log('[interview-exp/xhs-structure]', JSON.stringify({ postId: d.postId, basic: grp.basic.length, product: grp.product.length, project: grp.project.length }));
            } catch (e) {
              console.warn('[interview-exp] 小红书面经结构化失败（不阻断主流程）:', e.message);
            }
          }
        }

        // ---- 步骤 4：LLM 只整理「本次新增」内容（绝不读取历史结果）----
        const xhsText = xhsDetails.map((d, i) =>
          `【本次新增小红书帖子${i + 1}】\n标题：${d.title}\n作者：${d.author}\n正文：${d.content}`
        ).join('\n\n');
        const ragText = ragChunks.map((c, i) =>
          `【检索到的面经素材${i + 1}】\n${c.content}`
        ).join('\n\n');

        let increment = { basic: [], product: [], project: [] };
        let llmUsed = false;
        const llmSkipped = (!xhsText && !ragText);
        console.log('[interview-exp/input]', JSON.stringify({ company, role, round, xhsCount: xhsDetails.length, ragCount: ragChunks.length, xhsTextLength: xhsText.length, ragTextLength: ragText.length }));
        if (!llmSkipped) {
          try {
            const system = `你是面试准备助手。根据【本次新增】的面经素材，整理成三类结构化问题。
要求：
1. 基础问题(basic)：有标准答案的知识点，输出 {question, normalized_question, answer(一句话简答)}。
2. 产品设计问题(product)：没有唯一答案，输出 {question, normalized_question, framework(回答框架，分点列出思考步骤)}。
3. 项目经历问题(project)：必须结合候选人自身经历，不要生成答案，只输出 {question, normalized_question, direction(准备方向，分点列出)}。
normalized_question 规则（严格遵守，否则视为格式错误）：
- 必须采用「主题_关系」固定语义标签，仅使用英文、数字与下划线，禁止任何自然语言句子或问句形式。
- 严禁使用 CamelCase / PascalCase 驼峰式写法（如 TechMaturity、Requirements、ProductDesign、ModelPrinciple 均为错误）；每个词必须用下划线分隔，且除约定技术专有名词（RAG、Agent、MCP、BGE、AI、PM）保留大写外，其余一律小写。
- 禁止类似 How_RAG_works、Difference_between_RAG_and_FT、What_is_MCP 这类自然语言转写；只能用精简的「主题_关系」核心词。
- 标准范式（必须对齐以下词表思路）：
  * 定义类：主题_definition（例：什么是MCP → MCP_definition；什么是RAG → RAG_definition；什么是AI产品经理 → AI_PM_definition）
  * 对比类：主题A_vs_主题B（例：RAG和Fine-tuning区别 → RAG_vs_FineTuning；Agent和Chatbot区别 → Agent_vs_Chatbot）
  * 方法/技术类：主题_方法（例：Prompt工程 → Prompt_engineering；RAG技术成熟度 → RAG_tech_maturity）
  * 场景设计类：主题_场景（例：AI产品需求分析 → AI_product_requirement_analysis；Agent产品设计 → Agent_product_design）
  * 项目经历类：AI_project_experience（固定标签，所有"介绍你的项目"类问题统一用此值）
- 同类问题无论表述如何变化，必须输出完全一致的 normalized_question（例如"RAG是什么""什么是RAG""请解释RAG"统一为 RAG_definition；"AI产品经理技术成熟度要求""AI PM技术成熟度"统一为 AI_PM_tech_maturity）。
只输出 JSON，格式：{"basic":[{question,normalized_question,answer}],"product":[{question,normalized_question,framework}],"project":[{question,normalized_question,direction}]}。`;
            const user = `公司：${company}\n岗位：${role}\n轮次：${round}\n（以下仅为本次新增素材，不要参考任何历史输出）\n\n【本次新增小红书面经】\n${xhsText || '（无）'}\n\n【本次新增常考问题】\n${ragText || '（无）'}`;
            const raw = process.env.INTERVIEW_LLM_MOCK === '1'
              ? { basic: [{ question: `${company}${role}面试中最需要说明什么？`, normalized_question: 'interview_key_points', answer: '围绕目标、方法、结果和复盘，使用具体项目事实回答。' }], product: [{ question: '如何分析一个AI产品需求？', normalized_question: 'AI_product_requirement_analysis', framework: '用户问题→场景优先级→方案取舍→指标验证。' }], project: [{ question: '请介绍一个与你申请岗位相关的项目。', normalized_question: 'AI_project_experience', direction: '准备背景、个人职责、关键决策、结果数据和复盘。' }] }
              : await plan.callQwen(system, user, process.env.QWEN_MODEL || 'qwen-turbo');
            increment = normalizeInterviewGroups(parseInterviewJson(raw));
            console.log('[interview-exp/output]', JSON.stringify({ basic: increment.basic.length, product: increment.product.length, project: increment.project.length }));
            llmUsed = true;
          } catch (e) {
            console.warn('[interview-exp] LLM 增量整理失败，降级为空结构：', e.message);
          }
        }

        // ---- 步骤 4.5：Interview Question Cache 结构化资产层（增量沉淀，命中直出、未命中写回）----
        // 类型映射：basic→基础问题 / product→场景问题 / project→项目问题
        // 缓存 answer 列统一存「可复用内容」：基础=一句话答案、场景=框架、项目=准备方向。
        const TYPE_MAP = { basic: '基础问题', product: '场景问题', project: '项目问题' };
        const cacheHitIds = []; // 实际来自 cache 命中、最终要 +1 hit_count 的 id
        const enrichFromCache = async (arr, type) => {
          for (const q of (arr || [])) {
            if (!q.question) continue;
            const normalized = q.normalized_question || q.question; // 缺省用原问题兜底去重
            // 1) 先查 cache（业务唯一键 + 语义去重已写入时可直接命中）
            const existing = questionCache.getStructured(company, role, round)
              .find((x) => x.normalized_question === normalized && x.question_type === TYPE_MAP[type]);
            if (existing && existing.answer) {
              // 命中：复用 cache 答案，覆盖 LLM 本次产出
              if (type === 'basic') q.answer = existing.answer;
              else if (type === 'product') q.framework = existing.answer;
              else if (type === 'project') q.direction = existing.answer;
              q.fromCache = true;
              q.cacheId = existing.id;
              cacheHitIds.push(existing.id);
              cacheWriteStats.hit++;
              continue;
            }
            // 2) 未命中：把 LLM 本次产出写回 cache（仅新增内容调 LLM，符合增量沉淀）
            try {
              const answerText = type === 'basic' ? q.answer : (type === 'product' ? q.framework : q.direction);
              const res = await questionCache.upsertQuestion({
                question: q.question,
                normalized_question: normalized,
                question_type: TYPE_MAP[type],
                answer: answerText || '',
                company, position: role, round,
                source: 'user_query',
                source_chunk_id: ragChunks.map((c) => `rag:${c.id ?? c.chunkId ?? c.meta?.id ?? ''}`)
                  .concat(xhsDetails.map((d) => `xhs:${d.postId}`)),
              });
              if (res.action === 'inserted') cacheWriteStats.inserted++;
              q.fromCache = false;
            } catch (e) {
              console.warn('[interview-exp] cache upsert 失败（不阻断主流程）:', e.message);
              q.fromCache = false;
            }
          }
        };
        if (llmUsed) {
          await enrichFromCache(increment.basic, 'basic');
          await enrichFromCache(increment.product, 'product');
          await enrichFromCache(increment.project, 'project');
        }

        // ---- 步骤 5：追加写入（旧内容保留，仅新增追加）----
        const srcStmt = db.prepare(`INSERT INTO interview_sources (session_id, source_type, content, metadata, created_at) VALUES (?,?,?,?,?)`);
        const sidStmt = db.prepare(`INSERT INTO interview_source_ids (session_id, source_type, ref_id, created_at) VALUES (?,?,?,?)`);
        xhsDetails.forEach((d) => {
          srcStmt.run(sessionId, 'xiaohongshu', d.content, JSON.stringify({ title: d.title, author: d.author, link: d.link, post_id: d.postId }), now);
          sidStmt.run(sessionId, 'xiaohongshu', `xhs:${d.postId}`, now);
        });
        ragChunks.forEach((c) => {
          const ref = ragRef(c); // 与上面增量过滤使用同一 ref 生成逻辑，保证去重表一致
          srcStmt.run(sessionId, 'rag', c.content, JSON.stringify(c.meta || {}), now);
          sidStmt.run(sessionId, 'rag', ref, now);
        });
        const qStmt = db.prepare(`INSERT INTO interview_questions (session_id, question, type, answer, answer_framework, prepare_direction, created_at) VALUES (?,?,?,?,?,?,?)`);
        const existingQuestions = new Set(db.prepare('SELECT type, question FROM interview_questions WHERE session_id = ?').all(sessionId).map((q) => `${q.type}:${String(q.question || '').trim()}`));
        const insertQ = (arr, type) => (arr || []).forEach((q) => {
          const question = String(q.question || '').trim();
          const key = `${type}:${question}`;
          if (!question || existingQuestions.has(key)) return;
          existingQuestions.add(key);
          qStmt.run(sessionId, question, type, q.answer || null, q.framework || null, q.direction || null, now);
        });
        insertQ(increment.basic, 'basic');
        insertQ(increment.product, 'product');
        insertQ(increment.project, 'project');
        db.prepare(`UPDATE interview_sessions SET updated_at = ? WHERE id = ?`).run(now, sessionId);

        // 合并返回全部问题（历史 + 本次新增），供前端统一展示
        const allQuestions = db.prepare('SELECT id, question, type, answer, answer_framework, prepare_direction, created_at FROM interview_questions WHERE session_id = ? ORDER BY created_at ASC, id ASC').all(sessionId);
        const grouped = { basic: [], product: [], project: [] };
        allQuestions.forEach((q) => {
          const item = { question: q.question };
          if (q.type === 'basic') { item.answer = q.answer; grouped.basic.push(item); }
          else if (q.type === 'product') { item.framework = q.answer_framework; grouped.product.push(item); }
          else if (q.type === 'project') { item.direction = q.prepare_direction; grouped.project.push(item); }
        });
        const sources = db.prepare('SELECT id, source_type, content, metadata, created_at FROM interview_sources WHERE session_id = ? ORDER BY created_at ASC, id ASC').all(sessionId);
        const incSources = sources.filter((s) => (s.created_at || 0) >= now - 5000);

        // cache 命中项最终用于展示 → 增加 hit_count（仅展示才 +1，符合资产沉淀规则）
        if (cacheHitIds.length) {
          try { questionCache.markHit([...new Set(cacheHitIds)]); } catch (e) { console.warn('[interview-exp] markHit 失败:', e.message); }
        }

        return sendJson(res, 200, {
          ok: true,
          sessionId,
          company, role, round,
          searchIndex,
          isIncremental: searchIndex > 1,
          xhsCount: xhsDetails.length,
          ragCount: ragChunks.length,
          llmUsed,
          llmSkipped,
          reason: llmSkipped ? 'NO_INTERVIEW_SOURCE' : (llmUsed ? 'INTEGRATED_XHS_AND_RAG' : 'LLM_PARSE_FAILED'),
          needLogin: !!xhs.needLogin && !useLocalOnly,
          xhsBound, // 当前用户是否已绑定小红书（前端据此决定是否弹绑定提示）
          useLocalOnly, // 回显本次是否为「仅本地库」模式
          questions: grouped, // 合并后的全部问题
          increment, // 本次新增
          incrementSources: incSources, // 本次新增来源（前端展示「第N次新增」）
          cacheStats: cacheWriteStats, // {hit, inserted} 本次命中的 cache 题数 / 新沉淀题数
        });
      } catch (e) {
        console.error('[interview-exp] search error:', e);
        return sendJson(res, 500, { error: e.message });
      }
    }
    // 读取某次面经整理结果（用于「查看历史面经」时直接展示，不调 LLM）
    if (pathname === '/api/interview-experience/history' && req.method === 'GET') {
      const userId = requireUserId(req, res); if (!userId) return;
      const sessions = db.prepare(`
        SELECT id, company, role, round, created_at FROM interview_sessions
        WHERE user_id = ? ORDER BY created_at DESC LIMIT 20
      `).all(userId);
      const withCount = sessions.map((s) => {
        const c = db.prepare(`SELECT COUNT(*) AS c FROM interview_sources WHERE session_id = ? AND source_type = 'xiaohongshu'`).get(s.id);
        return { ...s, searchIndex: (c && c.c) || 0 };
      });
      return sendJson(res, 200, { items: withCount });
    }
    if (pathname === '/api/interview-experience/detail' && req.method === 'GET') {
      const userId = requireUserId(req, res); if (!userId) return;
      const sid = String(url.searchParams.get('sessionId') || '').trim();
      if (!sid) return sendJson(res, 400, { error: '缺少 sessionId' });
      const sess = db.prepare('SELECT id, company, role, round, created_at FROM interview_sessions WHERE id = ? AND user_id = ?').get(sid, userId);
      if (!sess) return sendJson(res, 404, { error: '未找到该面经' });
      const questions = db.prepare('SELECT id, question, type, answer, answer_framework, prepare_direction FROM interview_questions WHERE session_id = ?').all(sid);
      const sources = db.prepare('SELECT id, source_type, content, metadata FROM interview_sources WHERE session_id = ?').all(sid);
      const grouped = { basic: [], product: [], project: [] };
      questions.forEach((q) => {
        const item = { question: q.question };
        if (q.type === 'basic') { item.answer = q.answer; grouped.basic.push(item); }
        else if (q.type === 'product') { item.framework = q.answer_framework; grouped.product.push(item); }
        else if (q.type === 'project') { item.direction = q.prepare_direction; grouped.project.push(item); }
      });
      return sendJson(res, 200, { session: sess, questions: grouped, sources });
    }
    if (pathname === '/api/plan' && req.method === 'GET') {
      const userId = requireUserId(req, res); if (!userId) return;

      const profile = getProfile(userId);
      const keyword = url.searchParams.get('keyword') || (profile && profile.jobName) || '策略产品经理';
      // days 缺省时从统一真源推导（含首尾），四方联动统一。
      let days = Number(url.searchParams.get('days'));
      if (!Number.isInteger(days) || days < 1) {
        const derived = deriveDays(profile);
        if (!derived) days = 60; // 基础计划缺省兜底，不阻断生成
        else days = derived;
      }
      try {
        const data = await plan.getLearningPlan(keyword, days);
        // 把搜到的真实帖子链接持久化，便于学习计划页直接展示
        if (data.xhsPosts && data.xhsPosts.length) {
          const existing = getProfile(userId)?.xhsPosts || [];
          const merged = [...data.xhsPosts, ...existing].slice(0, 8);
          db.prepare('UPDATE profiles SET xhs_posts = ?, updated_at = ? WHERE user_id = ?')
            .run(JSON.stringify(merged), Date.now(), userId);
        }
        return sendJson(res, 200, data);
      } catch (e) {
        return sendJson(res, 502, { error: '学习计划生成失败: ' + e.message });
      }
    }
    if (pathname === '/api/xhs/qrcode' && req.method === 'GET') {
      try {
        const userId = requireUserId(req, res); if (!userId) return;
        plan.deleteXhsAccount(db, userId);
        await plan.prepareBind(userId);
        const data = await plan.getXhsQrcodeForBind();
        return sendJson(res, 200, data);
      } catch (e) {
        // MCP 页面被网络策略拦截时仍提供可用登录兜底，不让用户卡在二维码错误页。
        return sendJson(res, 200, {
          image: '',
          browserLogin: true,
          loginUrl: 'https://www.xiaohongshu.com/login',
          error: '二维码暂时不可用，已切换为浏览器登录',
          detail: e.message,
        });
      }
    }
    if (pathname === '/api/xhs/status' && req.method === 'GET') {
      try {
        const userId = requireUserId(req, res); if (!userId) return;
        // 用户级状态：区分「当前用户是否绑定自己的小红书」与「其 cookie 是否有效」。
        // 绝不把本机/他人的 cookie 存在与否当作当前用户已登录。
        const ub = db.prepare('SELECT xhs_bound FROM users WHERE id = ?').get(userId);
        const bound = !!(ub && ub.xhs_bound === 1);
        // cookieValid 统一以「MCP 真实校验登录态」为准，不再依赖 data/xhs/user_<id>.json 隔离文件
        // （该隔离文件历史上从未被维护，会导致「MCP 已返回已登录、却因隔离文件缺失被判未登录」的死锁）。
        // 后续 mcpLoggedIn 会覆盖此初值。
        let cookieValid = false;
        const statusRes = { bound, cookieValid, loginStatus: false, searchStatus: 'empty' };
        if (url.searchParams.get('check') === '1' && bound) {
          plan.setXhsActiveUser(userId);
          const checked = await plan.checkXhsLogin(db, userId);
          statusRes.mcpLoggedIn = !!checked.loggedIn;
          statusRes.cookieValid = !!checked.loggedIn;
          statusRes.loginStatus = statusRes.bound && statusRes.mcpLoggedIn;
          console.log('[XHS AUTH]', JSON.stringify({ userId, cookieExists: !!statusRes.cookieValid, mcpLogin: !!statusRes.mcpLoggedIn, loginStatus: statusRes.loginStatus }));
        }
        // 绑定扫码轮询场景（?bind=1）：额外查询本机真实扫码登录态，
        // 让用户扫码成功后前端能检测到并触发 bindXhs() 落盘，避免「未绑定→永不 bind」死锁。
        if (url.searchParams.get('bind')) {
          try {
            const r = await plan.checkXhsLogin(db, userId, { forBind: true });
            statusRes.canBind = !!(r && r.loggedIn);
            console.log('[XHS BIND POLL]', JSON.stringify({ userId, canBind: statusRes.canBind, scanned: statusRes.scanned, mcpLoggedIn: r && r.loggedIn }));
            // scanned 必须读取真实「已扫码待确认」中间态，而非沿用 loggedIn（否则没扫也会是 false、扫了又立刻变 true 没过渡）。
            statusRes.scanned = !!(r && r.scanned);
            statusRes.scannedMessage = (r && r.scannedMessage) || '';
          } catch {
            statusRes.canBind = false;
            statusRes.scanned = false;
          }
          // bind 场景也返回真实 loginStatus，作为前端判定"已登录"的唯一黄金标准：
          // 必须 bound && cookie 真实有效 && MCP 确认登录，三者同时成立才为真。
          try {
            const checked = await plan.checkXhsLogin(db, userId, {});
            statusRes.mcpLoggedIn = !!checked.loggedIn;
            statusRes.cookieValid = !!checked.loggedIn;
            statusRes.loginStatus = statusRes.bound && statusRes.mcpLoggedIn;
          } catch {
            statusRes.loginStatus = false;
          }
        }
        return sendJson(res, 200, statusRes);
      } catch (e) {
        return sendJson(res, 502, { error: '检查小红书登录态失败: ' + e.message });
      }
    }
    // 当前用户显式绑定自己的小红书（扫码成功确认后调用）：
    // 把刚扫码得到的全局 cookie 落盘到该用户隔离文件，并写入 xhs_accounts。
    if (pathname === '/api/xhs/bind' && req.method === 'POST') {
      try {
        const userId = requireUserId(req, res); if (!userId) return;
        console.log('[XHS BIND] start userId=' + userId);
        // 将 MCP 全局 cookie 落盘到当前用户隔离文件（data/xhs/user_<id>.json）
        const commitRes = await plan.commitUserCookie(userId);
        console.log('[XHS BIND] commitUserCookie raw=' + String(commitRes).slice(0, 200));
        console.log('[XHS BIND] hasUserLoginCookie=' + plan.hasUserLoginCookie(userId));
        if (!plan.hasUserLoginCookie(userId)) {
          console.log('[XHS BIND] FAIL: cookie not persisted, userCookieFile missing/invalid');
          return sendJson(res, 502, { error: '小红书登录已检测到，但 Cookie 未成功保存，请重新登录后重试', code: 'XHS_COOKIE_NOT_PERSISTED' });
        }
        plan.setXhsActiveUser(userId);
        // 标记本用户已绑定（db.mjs 的 JSON 存储对 users.xhs_bound 做持久化支持）
        db.prepare('UPDATE users SET xhs_bound = 1 WHERE id = ?').run(userId);
        // 兼容写入用户级绑定表（自定义 DB 下可能静默失败，但不影响主流程）
        plan.upsertXhsAccount(db, userId, 'active');
        return sendJson(res, 200, { bound: true });
      } catch (e) {
        return sendJson(res, 502, { error: '绑定小红书失败: ' + e.message });
      }
    }
    // 解除当前用户的小红书绑定：删除该用户隔离 cookie 文件 + 清除 xhs_accounts 记录。
    // 仅影响当前用户，不触碰其他用户、不动 MCP 全局文件（由后续切换逻辑处理）。
    if (pathname === '/api/xhs/unbind' && req.method === 'POST') {
      try {
        const userId = requireUserId(req, res); if (!userId) return;
        plan.deleteXhsAccount(db, userId);
        return sendJson(res, 200, { bound: false });
      } catch (e) {
        return sendJson(res, 502, { error: '解绑小红书失败: ' + e.message });
      }
    }
    if (pathname === '/api/xhs/posts' && req.method === 'GET') {
      const userId = requireUserId(req, res); if (!userId) return;
      // 搜索关键词必须是「目标岗位 + 学习路线」，而不是裸岗位名。
      // 前端已拼好（如「前端 学习路线」），此处再做防御：若前端未传 keyword，
      // 用 profile 的岗位名兜底；若传了但不含「学习路线」，则补上岗位名前缀。
      let keyword = (url.searchParams.get('keyword') || '').trim();
      let jobName = '';
      try {
        const pf = getProfile(userId);
        if (pf && pf.jobName) jobName = pf.jobName;
      } catch {}
      if (!keyword) {
        keyword = jobName ? jobName + ' 学习路线' : '学习路线';
      } else if (!/学习路线|学习路径|规划/.test(keyword) && jobName) {
        // 前端若只传了裸岗位名（意外情况），自动拼成「岗位 学习路线」保证命中
        keyword = jobName + ' ' + keyword;
      }
      const page = Number(url.searchParams.get('page')) || 1;
      const pageSize = Math.min(20, Math.max(1, Number(url.searchParams.get('pageSize')) || 20));
      try {
        // 切换式隔离：搜索前切到当前用户自己的 cookie
        plan.setXhsActiveUser(userId);
        const data = await plan.searchXhsPostsPaginated(keyword, page, pageSize);
        return sendJson(res, 200, data);
      } catch (e) {
        return sendJson(res, 502, { error: '小红书帖子搜索失败: ' + e.message });
      }
    }
    if (pathname === '/api/xhs/post' && req.method === 'GET') {
      const userId = requireUserId(req, res); if (!userId) return;
      const feedId = url.searchParams.get('feedId') || '';
      const xsecToken = url.searchParams.get('xsecToken') || '';
      try {
        // 切换式隔离：详情页使用当前用户自己的 cookie
        plan.setXhsActiveUser(userId);
        const data = await plan.getXhsPostDetail(feedId, xsecToken);
        return sendJson(res, 200, data);
      } catch (e) {
        return sendJson(res, 502, { error: '获取帖子详情失败: ' + e.message });
      }
    }
    if (pathname === '/api/xhs/open' && req.method === 'POST') {
      const b = await readBody(req);
      try {
        const data = await plan.openXhsPost(b.feedId || '', b.xsecToken || '');
        return sendJson(res, 200, data);
      } catch (e) {
        return sendJson(res, 502, { error: '打开笔记失败: ' + e.message });
      }
    }
    if (pathname === '/api/xhs/save-contents' && req.method === 'POST') {
      const userId = requireUserId(req, res); if (!userId) return;

      const b = await readBody(req);
      const posts = Array.isArray(b.posts) ? b.posts.slice(0, 6) : [];
      db.prepare('UPDATE profiles SET xhs_post_contents = ?, updated_at = ? WHERE user_id = ?')
        .run(JSON.stringify(posts), Date.now(), userId);
      // 自动把搜到的帖子增量录入 RAG，供后续笔记检索参考。
      // docId 基于 post_id 幂等：相同帖子重复保存不会重复录入，
      // 相同关键词返回的不同帖子则各自作为新 doc 进入 RAG。
      let ingested = 0;
      let totalChunks = 0;
      const ragResults = [];
      for (const p of posts) {
        const postId = p.id || p.link || Math.random().toString(36).slice(2);
        const text = [p.title, p.content, p.ocrText].filter(Boolean).join('\n');
        if (!text.trim()) continue;
        try {
          const r = await rag.ingestDocument({
            docId: 'xhs:' + postId,
            source: 'xhs',
            title: p.title || '(无标题)',
            content: text,
            ref: p.link || '',
            meta: { author: p.author, likeCount: p.likeCount, url: p.link, keyword: b.keyword || '' },
          });
          ragResults.push(r);
          if (!r.skipped) ingested += 1;
          totalChunks += (r.chunks || 0);
        } catch (e) {
          console.warn('[xhs/save-contents] 录入 RAG 失败:', postId, e.message);
        }
      }
      return sendJson(res, 200, {
        saved: posts.length,
        posts: posts.map((p) => ({ title: p.title })),
        ragIngested: ingested,
        ragSkipped: ragResults.filter((r) => r.skipped).length,
        ragChunks: totalChunks,
      });
    }
    if (pathname === '/api/plan/integrated' && req.method === 'GET') {
      const userId = requireUserId(req, res); if (!userId) return;
      // 单一学习路线表：learning_plans（每用户一条，user_id 主键）
      const row = db.prepare('SELECT data, created_at, job FROM learning_plans WHERE user_id = ?').get(userId);
      let plan = row ? JSON.parse(row.data) : null;

      // 【方案1·资源合并】learning_plans.dailyTasks[].tasks[] 子任务本身不带 video_info/pdf_info，
      // 真实资源数据保存在 daily_learning_tasks 表（video_info/pdf_info 为 JSON 字符串）。
      // 按 day_number 把资源注入到对应每日子任务，前端 parseResourceInfo(sec.videos/sec.pdfs) 即可直接渲染，
      // 无需改动前端。只在确有 daily_learning_tasks 行时合并，避免污染无资源的计划。
      if (plan && Array.isArray(plan.dailyTasks) && plan.dailyTasks.length) {
        try {
          const planId = buildPlanId(userId);
          const dltRows = db.prepare('SELECT day_number, video_info, pdf_info FROM daily_learning_tasks WHERE user_id = ? AND plan_id = ?').all(userId, planId);
          if (dltRows && dltRows.length) {
            const resByDay = new Map();
            for (const r of dltRows) {
              const v = parseResourceInfo(r.video_info).videos;
              const p = parseResourceInfo(r.pdf_info).pdfs;
              if (v.length || p.length) resByDay.set(Number(r.day_number), { videos: v, pdfs: p });
            }
            if (resByDay.size) {
              plan = JSON.parse(JSON.stringify(plan)); // 浅拷贝，避免修改原始缓存对象
              for (const dt of plan.dailyTasks) {
                const d = Number(dt.day ?? dt.dayNumber);
                const res = resByDay.get(d);
                if (!res) continue;
                if (Array.isArray(dt.tasks)) {
                  for (const sub of dt.tasks) {
                    sub.videos = res.videos;
                    sub.pdfs = res.pdfs;
                  }
                }
              }
            }
          }
        } catch (e) {
          console.warn('[plan] 合并 daily_learning_tasks 资源失败（已跳过）:', e.message);
        }
      }

      // days 统一真源：优先 deriveDays（含首尾总学习天数），与生成链路一致，消除 ±1 漂移
      const tdDays = deriveDays(getProfile(userId));
      const days = (Number.isInteger(tdDays) && tdDays >= 1)
        ? tdDays
        : (row ? (JSON.parse(row.data || '{}').days || 60) : null);
      return sendJson(res, 200, {
        plan,
        created_at: row ? row.created_at : null,
        days,
        keyword: row ? row.job : null,
      });
    }
    // 行业洞察「热门项目」：所有用户共享一份全局 GitHub Trending 每日快照（存 github_trending 表）。
    // 抓取只在系统每日 00:00 定时任务发生，用户端只从数据库读入，不触发抓取。
    if (pathname === '/api/plan/trending' && req.method === 'GET') {
      const today = localDateStr();
      let snapshot = db.state.tables.github_trending[0];
      // 仅在完全无快照时兜底抓取一次（避免空库），日常更新交给零点定时任务
      if (!snapshot) {
        try {
          const result = await plan.getTrendingInsights({ noCache: true });
          snapshot = { date: today, updatedAt: Date.now(), repos: result.insights || [] };
          db.state.tables.github_trending = [snapshot];
          db.save();
        } catch (e) {
          snapshot = { date: today, updatedAt: Date.now(), repos: [] };
        }
      }
      return sendJson(res, 200, {
        ok: true,
        date: snapshot.date,
        updatedAt: snapshot.updatedAt,
        insights: snapshot.repos || [],
      });
    }
    if (pathname === '/api/plan/integrated' && req.method === 'DELETE') {
      const userId = requireUserId(req, res); if (!userId) return;
      // 单一学习路线表：learning_plans（每日任务依赖同一张表，删除即清空路线）
      db.prepare('DELETE FROM learning_plans WHERE user_id = ?').run(userId);
      return sendJson(res, 200, { ok: true });
    }
    if (pathname === '/api/plan/integrated' && req.method === 'PATCH') {
      const userId = requireUserId(req, res); if (!userId) return;
      const b = await readBody(req);
      const data = b && b.data ? b.data : null;
      const daysVal = b && b.days != null ? Number(b.days) : null;
      const existing = db.prepare('SELECT user_id FROM learning_plans WHERE user_id = ?').get(userId);
      if (existing) {
        db.prepare('UPDATE learning_plans SET data = ?, job = COALESCE(?, job), updated_at = ? WHERE user_id = ?')
          .run(JSON.stringify(data), (data && data.keyword) || '策略产品经理', Date.now(), userId);
      } else {
        db.prepare('INSERT INTO learning_plans (user_id, job, data, progress, created_at, updated_at) VALUES (?,?,?,?,?,?)')
          .run(userId, (data && data.keyword) || '策略产品经理', JSON.stringify(data), null, Date.now(), Date.now());
      }
      return sendJson(res, 200, { ok: true });
    }
    if (pathname === '/api/plan/integrated' && req.method === 'POST') {
      const userId = requireUserId(req, res); if (!userId) return;

      const profile = getProfile(userId);
      // keyword 校验：若 profile.jobName 已明确，强制以 jobName 为准，杜绝残留多选方向/URL 参数污染匹配资源
      const keyword = (profile && profile.jobName) || url.searchParams.get('keyword') || '策略产品经理';
      // days 统一真源：优先「含首尾」的总学习天数（目标日 - 开始日），
      // 仅当开始日缺失时回退「剩余天数」。与每日计划切片数、倒计时四方联动，
      // 消除 daysFromTarget 与 totalStudyDays 的 ±1 漂移。
      let days = Number(url.searchParams.get('days'));
      if (!Number.isInteger(days) || days < 1) {
        const derived = deriveDays(profile);
        if (!derived) return sendJson(res, 400, { error: '未设置目标日，无法自动推导学习天数；请先设置投递目标日期', code: 'NO_TARGET_DATE' });
        days = derived;
      }
      const autoFetch = url.searchParams.get('autoFetch') === '1';
      const skipXhs = url.searchParams.get('skipXhs') === '1';
      const count = Math.min(6, Math.max(1, Number(url.searchParams.get('count')) || 3));
      const force = url.searchParams.get('force') === '1';
      const stored = profile && profile.xhsPostContents && profile.xhsPostContents.length ? profile.xhsPostContents : [];
      // 每次生成都保存为最新版：直接写入唯一学习路线表 learning_plans（每用户一条，force 参数保留兼容但默认覆盖）
      try {
        // 整体超时保护：避免小红书抓取 + 多次 Qwen 调用 + 资源匹配串行累加超过前端超时，
        // 导致前端已 abort 但后端无限挂起、用户看到一直卡 95%。
        const OVERALL_TIMEOUT = Number(process.env.PLAN_TIMEOUT_MS || 280000);
        const data = await Promise.race([
          plan.generateIntegratedPlan(keyword, days, stored, { autoFetch, skipXhs, count, db }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`生成超时（>${OVERALL_TIMEOUT / 1000}s），已自动终止，请稍后重试`)), OVERALL_TIMEOUT)
          ),
        ]);
        // 将本次进入计划的全部小红书帖子（手动已存的 + 自动抓取的，已合并去重）写回本地存储，
        // 使「小红书学习帖子」区下次打开即可见，实现「返回到本地储存」。
        if (Array.isArray(data.xhsPosts) && data.xhsPosts.length) {
          try {
            db.prepare('UPDATE profiles SET xhs_post_contents = ?, updated_at = ? WHERE user_id = ?')
              .run(JSON.stringify(data.xhsPosts.slice(0, 6)), Date.now(), userId);
          } catch (e) { console.warn('[plan] 写回小红书帖子失败:', e.message); }
          // 自动把进入计划的全部小红书帖子增量录入 RAG（含 autoFetch 新抓的），
          // 供后续学习笔记检索参考。docId 基于 post_id 幂等，重复帖不会重复录入。
          try {
            for (const p of data.xhsPosts.slice(0, 6)) {
              const postId = p.id || p.link || Math.random().toString(36).slice(2);
              const text = [p.title, p.content, p.ocrText].filter(Boolean).join('\n');
              if (!text.trim()) continue;
              await rag.ingestDocument({
                docId: 'xhs:' + postId,
                source: 'xhs',
                title: p.title || '(无标题)',
                content: text,
                ref: p.link || '',
                meta: { author: p.author, likeCount: p.likeCount, url: p.link, keyword: keyword || '' },
              });
            }
          } catch (e) { console.warn('[plan] 小红书帖子录入 RAG 失败:', e.message); }
        }
        // 单一学习路线表：learning_plans（每用户一条，user_id 主键）
        // 同时是每日任务的唯一真源（loadStagePlanForDaily 直接读此表），杜绝双表不一致。
        // 将 days 合并进 data，保证前端 GET 能读回计划天数（原 study_plans 有独立 days 列，统一后并入 data）。
        const savedData = { ...data, days };
        try {
          db.prepare(`INSERT INTO learning_plans (user_id, job, data, progress, created_at, updated_at)
            VALUES (?,?,?,?,?,?)
            ON CONFLICT(user_id) DO UPDATE SET job=excluded.job, data=excluded.data, progress=excluded.progress, updated_at=excluded.updated_at`)
            .run(userId, keyword, JSON.stringify(savedData), null, Date.now(), Date.now());
        } catch (e) { console.warn('[plan] 保存学习计划失败:', e.message); }

        // 刷新学习计划（重新生成路线）后，库内所有学习笔记都应作废清空，
        // 因旧笔记对应的是上一条路线的视频/阶段，路线已变则笔记不再有效。
        // 清：learning_notes / stage_notes / note_generation_records（每用户维度）。
        try {
          for (const tbl of ['learning_notes', 'stage_notes', 'note_generation_records']) {
            const rows = db.state.tables[tbl];
            if (Array.isArray(rows)) {
              db.state.tables[tbl] = rows.filter((r) => r.user_id !== userId);
            }
          }
          db.save();
          console.log('[plan] 已清除用户', userId, '刷新计划前的全部学习笔记');
        } catch (e) { console.warn('[plan] 清除旧笔记失败:', e.message); }

        // C：整体路线变更后，强行以今天为开始日（用户确认项），
        // targetDate 同步顺延 days-1 天，保证「今日倒计时 / 计划天数」四方联动一致。
        // 注意：实际「每日任务切分落库（清空重写）」由前端生成成功后调用的
        // generateDailyPlan（/api/plan/daily）统一完成，此处只更新开始/目标日真源，
        // 避免双写入口字段不一致。
        const startDate = todayDateStr();
        const targetDate = computeTaskDate(startDate, Math.max(0, days - 1));
        // JsonDatabaseSync 仅识别预设 SQL 模板，直接用内存对象更新 start/target_date 真源。
        try {
          const prof = (db.state.tables.profiles || []).find((p) => p.user_id === userId);
          if (prof) {
            prof.start_date = startDate;
            prof.target_date = targetDate;
            prof.updated_at = Date.now();
            db.save();
          }
        } catch (e) { console.warn('[plan] 同步 start/target_date 失败:', e.message); }

        return sendJson(res, 200, data);
      } catch (e) {
        return sendJson(res, 502, { error: '整合学习计划生成失败: ' + e.message });
      }
    }
    if (pathname === '/api/rag/ingest' && req.method === 'POST') {
      const userId = requireUserId(req, res); if (!userId) return;
      const b = await readBody(req);
      const content = (b.content || '').trim();
      if (!content) return sendJson(res, 400, { error: '文档内容不能为空' });
      const docId = 'upload:' + userId + ':' + Date.now() + ':' + Math.random().toString(36).slice(2, 8);
      const source = b.source === 'xhs' ? 'xhs' : 'upload';
      try {
        const r = await rag.ingestDocument({
          docId,
          source,
          title: b.title || '未命名文档',
          content,
          ref: b.ref || '',
          meta: b.meta || { owner: userId },
        });
        return sendJson(res, 200, { docId, ...r });
      } catch (e) {
        return sendJson(res, 502, { error: 'RAG 入库失败: ' + e.message });
      }
    }
    if (pathname === '/api/rag/docs' && req.method === 'GET') {
      try {
        return sendJson(res, 200, { docs: rag.listDocs() });
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }
    if (pathname === '/api/rag/import-sources' && req.method === 'POST') {
      try {
        const b = await readBody(req).catch(() => ({}));
        const result = await rag.importRagSources({ force: !!b.force, onlyFiles: Array.isArray(b.onlyFiles) ? b.onlyFiles : (b.onlyFiles ? [b.onlyFiles] : null) });
        return sendJson(res, 200, result);
      } catch (e) {
        return sendJson(res, 502, { error: 'RAG 批量导入失败: ' + e.message });
      }
    }
    if (pathname === '/api/rag/reindex' && req.method === 'POST') {
      try {
        const result = await rag.importRagSources({ force: true });
        return sendJson(res, 200, result);
      } catch (e) {
        return sendJson(res, 502, { error: 'RAG 重新索引失败: ' + e.message });
      }
    }
    if (pathname === '/api/rag/backfill-metadata' && req.method === 'POST') {
      try {
        const b = await readBody(req).catch(() => ({}));
        const result = await rag.backfillChunkMetadata({ limit: Number(b.limit) || Infinity });
        return sendJson(res, 200, result);
      } catch (e) {
        return sendJson(res, 502, { error: 'RAG metadata 回填失败: ' + e.message });
      }
    }
    if (pathname === '/api/rag/skills' && req.method === 'GET') {
      try {
        const result = await rag.getSkillStats();
        return sendJson(res, 200, result);
      } catch (e) {
        return sendJson(res, 502, { error: 'RAG skills 调试失败: ' + e.message });
      }
    }
    if (pathname === '/api/rag/doc' && req.method === 'DELETE') {
      const docId = url.searchParams.get('docId') || '';
      if (!docId) return sendJson(res, 400, { error: '缺少 docId' });
      try {
        return sendJson(res, 200, rag.deleteDoc(docId));
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }
    if (pathname === '/api/rag/reindex-xhs' && req.method === 'POST') {
      const userId = requireUserId(req, res); if (!userId) return;
      const profile = getProfile(userId);
      const posts = (profile && profile.xhsPostContents) || [];
      if (!posts.length) return sendJson(res, 400, { error: '暂无可索引的小红书帖子，请先保存经验贴' });
      try {
        const results = [];
        for (const p of posts) {
          const text = [p.title, p.content, p.ocrText].filter(Boolean).join('\n');
          results.push(
            await rag.ingestDocument({
              docId: 'xhs:' + (p.id || p.link || Math.random().toString(36).slice(2)),
              source: 'xhs',
              title: p.title || '(无标题)',
              content: text,
              ref: p.link || '',
              meta: { author: p.author, likeCount: p.likeCount, url: p.link },
              force: true,
            })
          );
        }
        const totalChunks = results.reduce((s, r) => s + (r.chunks || 0), 0);
        return sendJson(res, 200, { ingested: results.length, totalChunks });
      } catch (e) {
        return sendJson(res, 502, { error: '重建小红书索引失败: ' + e.message });
      }
    }
    if (pathname === '/api/rag/query' && req.method === 'POST') {
      const b = await readBody(req);
      const query = (b.query || '').trim();
      if (!query) return sendJson(res, 400, { error: '检索内容不能为空' });
      try {
        const hits = await rag.retrieveWithFilters(query, {
          topK: Number(b.topK) || 6,
          source: b.source || null,
          skill: b.skill || '',
          level: b.level || '',
          category: b.category || '',
        });
        return sendJson(res, 200, { query, hits });
      } catch (e) {
        return sendJson(res, 502, { error: 'RAG 检索失败: ' + e.message });
      }
    }
    // 返回某个 RAG 文档对应的真实 PDF 文件（供「知识库补充」板块打开/查看）
    if (pathname === '/api/rag/file' && req.method === 'GET') {
      const docId = (url.searchParams.get('docId') || '').trim();
      if (!docId) return sendJson(res, 400, { error: 'docId 不能为空' });
      try {
        const meta = rag.getFirstChunkMeta(docId) || {};
        const rel = meta.relativePath || meta.ref || meta.file || '';
        if (!rel) return sendJson(res, 404, { error: '未找到该文档的物理文件路径' });
        // 项目根目录（server/ 的上一级）；知识库资料实际存放在 <root>/rag_sources 下，
        // 而 meta.relativePath 是相对 rag_sources 的路径，故优先在 rag_sources 内解析，再回退项目根。
        const root = path.resolve(__dirname, '..');
        const candidates = [
          path.resolve(root, 'rag_sources', rel),
          path.resolve(root, rel),
        ];
        let abs = '';
        for (const c of candidates) {
          // 路径穿越防护：必须落在项目根内
          if (c !== root && !c.startsWith(root + path.sep)) continue;
          if (fs.existsSync(c) && fs.statSync(c).isFile()) { abs = c; break; }
        }
        if (!abs) return sendJson(res, 404, { error: '文件不存在: ' + rel });
        const ext = path.extname(abs).toLowerCase();
        const mime = ext === '.pdf' ? 'application/pdf'
          : ext === '.txt' ? 'text/plain; charset=utf-8'
          : ext === '.md' ? 'text/markdown; charset=utf-8'
          : 'application/octet-stream';
        res.writeHead(200, {
          'Content-Type': mime,
          'Content-Disposition': 'inline; filename=' + encodeURIComponent(path.basename(abs)),
          'Cache-Control': 'no-store',
        });
        fs.createReadStream(abs).pipe(res);
      } catch (e) {
        return sendJson(res, 500, { error: '打开文档失败: ' + e.message });
      }
      return; // 已通过流返回，结束该请求
    }
    // ================= 每日任务 =================
    // 读取已保存的学习计划（单一学习路线表 learning_plans），便于每日任务从中派生
    function loadStudyPlan(userId) {
      const row = db.prepare('SELECT data, created_at, job FROM learning_plans WHERE user_id = ?').get(userId);
      if (!row) return null;
      try {
        const parsed = JSON.parse(row.data || '{}');
        return { keyword: row.job || parsed.keyword, days: parsed.days, data: parsed, createdAt: row.created_at };
      } catch {
        return null;
      }
    }
    // 生成某一天（planIndex）的每日任务：从计划 stages 中抽取对应日的学习项，
    // 并调用大模型拆解为可执行、可勾选的今日任务清单。
    if (pathname === '/api/daily-tasks' && req.method === 'POST') {
      const userId = requireUserId(req, res); if (!userId) return;
      const studyPlan = loadStudyPlan(userId);
      if (!studyPlan) return sendJson(res, 404, { error: '尚未生成学习计划，请先在学习计划页生成', code: 'NO_PLAN' });
      const b = await readBody(req).catch(() => ({}));
      // 目标计划日索引：默认取「已生成天数」对应的一天；支持显式指定
      let planIndex = Number(b.planIndex);
      if (!Number.isFinite(planIndex) || planIndex < 0) {
        const last = db.prepare('SELECT COUNT(*) AS c FROM daily_tasks WHERE user_id = ?').get(userId);
        planIndex = Math.max(0, (last && last.c ? last.c : 1) - 1);
        if (studyPlan.days) planIndex = Math.min(planIndex, studyPlan.days - 1);
      }
      const stages = Array.isArray(studyPlan.data && studyPlan.data.stages) ? studyPlan.data.stages : [];
      const dailyTasks = Array.isArray(studyPlan.data && studyPlan.data.dailyTasks) ? studyPlan.data.dailyTasks : [];
      // 格式兼容：整合格式（含 dailyTasks）直接复用已生成的每日任务，无需再派生
      if (!stages.length && dailyTasks.length) {
        // 生成日期跟随当前生效日期（含 currentDateOverride / testDate），与读取/打卡/笔记一致
        const taskDate = todayDateStr();
        // 优先取与今天 date 匹配的一天；否则按 planIndex 取（dailyTasks[0] 对应第 1 天）
        let pick = dailyTasks.find(d => d.date === taskDate);
        if (!pick && dailyTasks[planIndex]) pick = dailyTasks[planIndex];
        if (!pick && dailyTasks[0]) pick = dailyTasks[0];
        const tasks = (pick.tasks || []).map((t, i) => ({
          id: t.id || ('t' + (i + 1)),
          title: t.title || '',
          detail: t.detail || '',
          skill: t.skill || '',
          est_min: Number(t.estimatedMinutes || t.est_min || 60),
          done: t.status === 'done',
          link: t.link || '',
          chapters: Array.isArray(t.chapters) ? t.chapters : (t.chapters ? [t.chapters] : []),
        }));
        const now = Date.now();
        const existing = db.prepare('SELECT id FROM daily_tasks WHERE user_id = ? AND task_date = ?').get(userId, taskDate);
        if (existing) {
          db.prepare('UPDATE daily_tasks SET plan_index = ?, keyword = ?, tasks = ?, updated_at = ? WHERE id = ?').run(planIndex, studyPlan.keyword || '', JSON.stringify(tasks), now, existing.id);
        } else {
          db.prepare('INSERT INTO daily_tasks (user_id, task_date, plan_index, keyword, tasks, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(userId, taskDate, planIndex, studyPlan.keyword || '', JSON.stringify(tasks), now, now);
        }
        return sendJson(res, 200, { date: taskDate, planIndex, keyword: studyPlan.keyword || '', tasks, totalDays: dailyTasks.length, fromIntegrated: true });
      }
      if (!stages.length) return sendJson(res, 400, { error: '学习计划格式异常，无法派生每日任务' });
      // 将所有阶段的学习项按「计划日」平均分配到 days 天
      const totalDays = studyPlan.days || stages.length;
      const flatItems = [];
      for (const st of stages) {
        const items = Array.isArray(st.items) ? st.items : [];
        for (const it of items) {
          const text = typeof it === 'string' ? it : (it.title || it.task || it.content || '');
          const skill = (it && it.skill) || (st && st.skill) || '';
          if (text) flatItems.push({ text, skill, stage: st.stage || st.title || '' });
        }
      }
      if (!flatItems.length) return sendJson(res, 400, { error: '学习计划没有可拆分的任务项' });
      const perDay = Math.max(1, Math.ceil(flatItems.length / totalDays));
      const start = Math.min(planIndex * perDay, flatItems.length);
      const end = Math.min(start + perDay, flatItems.length);
      const dayItems = flatItems.slice(start, end);
      const user = `目标岗位：${studyPlan.keyword || '未知'}\n计划总天数：${totalDays} 天，今天是第 ${planIndex + 1} 天\n\n请从以下学习计划项中提取属于今天的学习内容，拆解为 3~6 条具体、可执行、可勾选的「今日学习任务」：\n` +
        dayItems.map((d, i) => `${i + 1}. ${d.text}${d.skill ? '（技能：' + d.skill + '）' : ''}`).join('\n');
      const system = `你是一名为求职学习规划者服务的「每日任务拆解助手」。
根据学习者今天对应的学习计划项，拆解出当天可执行的具体任务。
要求：
1. 输出严格 JSON：{ "date_label": "第N天", "tasks": [ { "title": "任务标题", "detail": "具体做法/产出", "skill": "关联技能名(可空)", "est_min": 预估分钟数 } ] }
2. tasks 数量 3~6 条，遵循「最小可执行、可勾选完成」原则，避免过于笼统。
3. est_min 为单个任务预计耗时（分钟），整数。
4. 不要编造学习计划中不存在的技能，可从给定项中自然归纳。`;
      let tasks;
      try {
        const raw = await plan.callQwen(system, user);
        const m = raw.match(/\{[\s\S]*\}/);
        const parsed = m ? JSON.parse(m[0]) : JSON.parse(raw);
        tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
        if (!tasks.length) throw new Error('模型未返回任务');
      } catch (e) {
        // 兜底：直接用切片项作为任务，保证可用
        tasks = dayItems.map((d) => ({ title: d.text, detail: '完成：' + d.text, skill: d.skill, est_min: 60 }));
      }
      // 生成日期跟随当前生效日期（含 currentDateOverride / testDate），与读取/打卡/笔记一致
      const taskDate = todayDateStr();
      const payload = JSON.stringify(tasks.map((t, i) => ({ ...t, id: 't' + (i + 1), done: false })));
      const now = Date.now();
      const existing = db.prepare('SELECT id FROM daily_tasks WHERE user_id = ? AND task_date = ?').get(userId, taskDate);
      if (existing) {
        db.prepare('UPDATE daily_tasks SET plan_index = ?, keyword = ?, tasks = ?, updated_at = ? WHERE id = ?').run(planIndex, studyPlan.keyword || '', payload, now, existing.id);
      } else {
        db.prepare('INSERT INTO daily_tasks (user_id, task_date, plan_index, keyword, tasks, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(userId, taskDate, planIndex, studyPlan.keyword || '', payload, now, now);
      }
      return sendJson(res, 200, { date: taskDate, planIndex, keyword: studyPlan.keyword || '', tasks, totalDays });
    }
    // 读取某天的每日任务（默认今天）
    if (pathname === '/api/daily-tasks' && req.method === 'GET') {
      const userId = requireUserId(req, res); if (!userId) return;
      // 默认日期跟随当前生效日期（含常驻 currentDateOverride / 测试 testDate），
      // 与 /api/checkin、笔记生成口径一致，避免切到 8/12 查看却读不到任务。
      const date = (url.searchParams.get('date') || todayDateStr()).slice(0, 10);
      const row = db.prepare('SELECT plan_index, keyword, tasks, created_at FROM daily_tasks WHERE user_id = ? AND task_date = ?').get(userId, date);
      if (!row) return sendJson(res, 200, { date, tasks: null });
      let tasks = [];
      try { tasks = JSON.parse(row.tasks); } catch { tasks = []; }
      return sendJson(res, 200, { date, planIndex: row.plan_index, keyword: row.keyword, tasks, createdAt: row.created_at });
    }
    // 打卡：更新某个任务的完成状态
    if (pathname === '/api/daily-tasks/check' && req.method === 'POST') {
      const userId = requireUserId(req, res); if (!userId) return;
      const b = await readBody(req);
      // 归属日期：与「今日任务/提交打卡」口径一致，跟随当前生效日期（含常驻 currentDateOverride / 测试 testDate），
      // 避免切日期查看时把勾选记到系统真实今天而读不到。
      const date = (b.date || todayDateStr()).slice(0, 10);
      const taskId = b.taskId;
      const done = b.done === true || b.done === 'true';
      const row = db.prepare('SELECT tasks FROM daily_tasks WHERE user_id = ? AND task_date = ?').get(userId, date);
      if (!row) return sendJson(res, 404, { error: '当天还没有任务，请先生成' });
      let tasks = [];
      try { tasks = JSON.parse(row.tasks); } catch { tasks = []; }
      let found = false;
      for (const t of tasks) {
        if (t.id === taskId) { t.done = done; found = true; }
      }
      if (!found) return sendJson(res, 404, { error: '任务不存在' });
      db.prepare('UPDATE daily_tasks SET tasks = ?, updated_at = ? WHERE user_id = ? AND task_date = ?').run(JSON.stringify(tasks), Date.now(), userId, date);
      const doneCount = tasks.filter((t) => t.done).length;
      return sendJson(res, 200, { date, tasks, doneCount, total: tasks.length });
    }

    // ================= 打卡（提交今日打卡）=================
    // 提交今日打卡：无论当天任务是否全部完成，只要用户提交即记为当天打卡成功。
    // 打卡日期集合存于 profiles.checkin_dates（JSON 数组，复用已有表，避免新增表在 JSON 模式下不支持）。
    if (pathname === '/api/checkin' && req.method === 'POST') {
      const userId = requireUserId(req, res); if (!userId) return;
      const b = await readBody(req).catch(() => ({}));
      // 归属日期：前端可显式传 date（查看的某天）；否则跟随当前生效日期（含常驻 currentDateOverride / 测试 testDate），
      // 保证与「今日任务 / 笔记生成」的日期口径一致（避免切到 8/8 查看却把打卡记到系统真实今天）。
      const date = (b.date || todayDateStr()).slice(0, 10);
      const prof = db.prepare('SELECT checkin_dates FROM profiles WHERE user_id = ?').get(userId) || {};
      let list = [];
      try { list = prof.checkin_dates ? JSON.parse(prof.checkin_dates) : []; } catch { list = []; }
      if (!Array.isArray(list)) list = [];
      if (!list.includes(date)) list.push(date);
      db.prepare('UPDATE profiles SET checkin_dates = ?, updated_at = ? WHERE user_id = ?')
        .run(JSON.stringify(list), Date.now(), userId);
      // 已写入即视为当天已打卡（checkedToday 绑定「写入的归属日期」而非系统真实今天，
      // 避免日期覆盖/测试模式下 date≠真实今天 时误判为未提交）。
      return sendJson(res, 200, { ok: true, date, checkedToday: list.includes(date) });
    }
    // 打卡统计：连续打卡天数 + 累计学习天数（学习开始日 → 今天，含两端）
    if (pathname === '/api/checkin/stats' && req.method === 'GET') {
      const userId = requireUserId(req, res); if (!userId) return;
      // 统计口径跟随当前生效日期（含常驻 currentDateOverride / 测试 testDate）：
      // 切到 8/8 查看时，按 8/8 是否已打卡来返回 checkedToday，而非系统真实今天。
      const today = todayDateStr();
      const prof = db.prepare('SELECT checkin_dates, start_date FROM profiles WHERE user_id = ?').get(userId) || {};
      let list = [];
      try { list = prof.checkin_dates ? JSON.parse(prof.checkin_dates) : []; } catch { list = []; }
      if (!Array.isArray(list)) list = [];
      const set = new Set(list);
      // 连续打卡：从今天往前数，断掉即止（今天未打卡则从昨天起算；昨天也没打卡则 0）
      // 注意：时间戳一律基于 UTC 字符串（与 checkin_dates 的存储基准一致），
      // 避免本地时区下 `new Date().setHours(0,0,0,0)` 再 toISOString 偏移一天导致 streak 算错。
      const addDaysUTC = (str, n) => {
        const d = new Date(str + 'T00:00:00Z');
        d.setUTCDate(d.getUTCDate() + n);
        return d.toISOString().slice(0, 10);
      };
      let streak = 0;
      let cursorDate = today;
      if (!set.has(today)) cursorDate = addDaysUTC(today, -1); // 今天没打卡，从昨天起算
      while (true) {
        if (!set.has(cursorDate)) break;
        streak += 1;
        cursorDate = addDaysUTC(cursorDate, -1);
      }
      // 累计学习：学习开始日 → 今天（含两端）
      const startDate = prof.start_date;
      let totalStudyDays = null;
      if (startDate) {
        const s = new Date(startDate); s.setHours(0, 0, 0, 0);
        const t = new Date(today); t.setHours(0, 0, 0, 0);
        const diff = Math.floor((t - s) / 86400000);
        if (diff >= 0) totalStudyDays = diff + 1; // 含开始日当天
        else totalStudyDays = 0;
      }
      return sendJson(res, 200, {
        streak,
        totalStudyDays,
        checkedToday: set.has(today),
        startDate: startDate || null,
        today,
        checkinDates: list,
      });
    }

    // ================= 学习笔记 =================
    // 基于技能树（来自学习计划的 skillTree）与本地 RAG 知识库，生成结构化学习笔记
    if (pathname === '/api/study-notes/generate' && req.method === 'POST') {
      const userId = requireUserId(req, res); if (!userId) return;
      const b = await readBody(req).catch(() => ({}));
      const topic = (b.topic || b.skill || '').trim();
      if (!topic) return sendJson(res, 400, { error: '请提供笔记主题（skill）' });
      const category = b.category || '';
      const level = b.level || '';
      // 优先从已保存学习计划中拿到 skillTree，用于补充技能背景
      const studyPlan = loadStudyPlan(userId);
      const skillTree = studyPlan && studyPlan.data && Array.isArray(studyPlan.data.skillTree) ? studyPlan.data.skillTree : [];
      // 检索 RAG 公用库中与主题相关的真实材料（含别人沉淀的经验）
      let ragHits = [];
      try {
        ragHits = await rag.retrieveWithFilters(topic, { topK: 4, source: null, skill: topic, level, category });
      } catch { ragHits = []; }
      const ragText = ragHits.length
        ? ragHits.map((h, i) => `【素材${i + 1}】${(h.title || '')}\n${(h.content || h.text || '').slice(0, 1200)}`).join('\n\n')
        : '（暂无相关 RAG 素材，可依据岗位通用知识生成）';
      const skillCtx = skillTree.length
        ? '已规划技能树中与「' + topic + '」相关的技能：' + skillTree
            .filter((s) => s && (s.standard_name || s.name || '').toLowerCase().includes(topic.toLowerCase()))
            .map((s) => s.standard_name || s.name).slice(0, 6).join('、')
        : '';
      const user = `请为「${topic}」生成一份求职向学习笔记。
${category ? '所属类别：' + category + '\n' : ''}${level ? '难度级别：' + level + '\n' : ''}${skillCtx ? skillCtx + '\n' : ''}
可参考的真实素材（来自本地知识库/别人沉淀经验）：
${ragText}`;
      const system = `你是一名「求职学习笔记生成助手」，请基于给定主题与真实素材，撰写结构清晰、可直接阅读与复习的学习笔记。
要求：
1. 输出严格 JSON：{ "title": "笔记标题", "summary": "一句话核心结论", "sections": [ { "heading": "小节标题", "body": "该节要点(可含要点列表)" } ], "keyPoints": [ "核心要点1", "核心要点2" ], "practice": [ "可落手的练习/项目建议" ] }
2. 内容贴合求职准备（面试常考点、项目可展示点），避免空泛。
3. 若素材充足，优先引用真实素材中的经验；否则给出通用但实用的说明。
4. sections 至少 3 节，keyPoints 3~6 条，practice 1~3 条。`;
      let note;
      try {
        const raw = await plan.callQwen(system, user);
        const m = raw.match(/\{[\s\S]*\}/);
        note = m ? JSON.parse(m[0]) : JSON.parse(raw);
      } catch (e) {
        return sendJson(res, 502, { error: '笔记生成失败: ' + e.message });
      }
      return sendJson(res, 200, {
        title: note.title || topic,
        summary: note.summary || '',
        sections: Array.isArray(note.sections) ? note.sections : [],
        keyPoints: Array.isArray(note.keyPoints) ? note.keyPoints : [],
        practice: Array.isArray(note.practice) ? note.practice : [],
        topic, category, level,
      });
    }
    // 保存一条学习笔记
    if (pathname === '/api/study-notes' && req.method === 'POST') {
      const userId = requireUserId(req, res); if (!userId) return;
      const b = await readBody(req);
      const title = (b.title || '').trim();
      const content = (b.content || '').trim();
      if (!title || !content) return sendJson(res, 400, { error: '标题与内容不能为空' });
      const now = Date.now();
      const info = db.prepare('INSERT INTO study_notes (user_id, title, skill, category, level, content, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        userId, title, b.skill || '', b.category || '', b.level || '', content, b.source || 'ai', now, now
      );
      return sendJson(res, 200, { id: Number(info.lastInsertRowid), createdAt: now });
    }
    // 读取学习笔记列表 / 单条
    if (pathname === '/api/study-notes' && req.method === 'GET') {
      const userId = requireUserId(req, res); if (!userId) return;
      const id = url.searchParams.get('id');
      if (id) {
        const row = db.prepare('SELECT id, title, skill, category, level, content, source, created_at FROM study_notes WHERE user_id = ? AND id = ?').get(userId, Number(id));
        if (!row) return sendJson(res, 404, { error: '笔记不存在' });
        return sendJson(res, 200, { note: row });
      }
      const rows = db.prepare('SELECT id, title, skill, category, level, source, created_at FROM study_notes WHERE user_id = ? ORDER BY created_at DESC').all(userId);
      return sendJson(res, 200, { notes: rows });
    }
    // 删除学习笔记
    if (pathname === '/api/study-notes' && req.method === 'DELETE') {
      const userId = requireUserId(req, res); if (!userId) return;
      const id = Number(url.searchParams.get('id'));
      if (!id) return sendJson(res, 400, { error: '缺少 id' });
      db.prepare('DELETE FROM study_notes WHERE user_id = ? AND id = ?').run(userId, id);
      return sendJson(res, 200, { ok: true });
    }
    // 读取「我的学习笔记」（每日学习笔记，按月份/日期归档）
    if (pathname === '/api/learning-notes' && req.method === 'GET') {
      const userId = requireUserId(req, res); if (!userId) return;
      const id = url.searchParams.get('id');
      if (id) {
        const row = db.prepare(
          'SELECT * FROM learning_notes WHERE user_id = ? AND id = ?'
        ).get(userId, Number(id));
        if (!row) return sendJson(res, 404, { error: '笔记不存在' });
        return sendJson(res, 200, { note: row });
      }
      const rows = db.prepare(
        'SELECT * FROM learning_notes WHERE user_id = ? ORDER BY note_date DESC, id DESC'
      ).all(userId).map((r) => ({
        id: r.id, title: r.title, note_date: r.note_date, month: r.month, day: r.day,
        stage_id: r.stage_id, generation_count: r.generation_count, created_at: r.created_at,
        content: r.content,
      }));
      return sendJson(res, 200, { notes: rows });
    }
    // 删除「我的学习笔记」中的一条每日笔记
    if (pathname === '/api/learning-notes' && req.method === 'DELETE') {
      const userId = requireUserId(req, res); if (!userId) return;
      const id = Number(url.searchParams.get('id'));
      if (!id) return sendJson(res, 400, { error: '缺少 id' });
      const table = db.state.tables.learning_notes || [];
      const idx = table.findIndex((r) => r.user_id === userId && r.id === id);
      if (idx === -1) return sendJson(res, 404, { error: '笔记不存在' });
      table.splice(idx, 1);
      db.save();
      return sendJson(res, 200, { ok: true });
    }
    // 编辑/保存「我的学习笔记」中的一条每日笔记（覆盖当天最终笔记，需求十二）
    // 不增加 generated/saved 状态；learning_notes 只有一个状态：最终笔记。
    if (pathname === '/api/learning-notes' && req.method === 'PUT') {
      const userId = requireUserId(req, res); if (!userId) return;
      const b = await readBody(req).catch(() => ({}));
      const table = db.state.tables.learning_notes || (db.state.tables.learning_notes = []);
      const id = b.id != null ? Number(b.id) : null;
      let row = null;
      if (id) {
        row = table.find((r) => r.user_id === userId && Number(r.id) === id);
      } else if (b.date) {
        // 按日期定位当天最新一条笔记
        const cands = table.filter((r) => r.user_id === userId && r.note_date === b.date)
          .sort((a, r) => Number(r.id) - Number(a.id));
        row = cands[cands.length - 1] || null;
      }
      if (!row) return sendJson(res, 400, { error: '未找到可保存的笔记（请先生成当日笔记）' });
      if (b.title != null) row.title = b.title;
      if (b.content != null) row.content = b.content;
      if (b.source_tasks != null) {
        try { JSON.parse(b.source_tasks); row.source_tasks = b.source_tasks; }
        catch { row.source_tasks = JSON.stringify(b.source_tasks); }
      }
      if (b.memory != null) row.memory = (typeof b.memory === 'string') ? b.memory : JSON.stringify(b.memory);
      row.updated_at = Date.now();
      db.save();
      return sendJson(res, 200, { ok: true, note: row });
    }

    // ============ 测试模式：模拟 24 点结算（需求十四） ============
    // ① 把「当天任务里已完成但用户未提交打卡」的子任务自动补写 daily_task_completions
    // ② 自动生成当天学习笔记（仅含当天完成任务，不消耗每日 2 次手动生成额度）
    // ============ 日历「模拟提交」：把指定日期的计划任务标记完成并写入打卡记录（不限测试模式，供模拟真实提交流程） ============
    // 选定模拟日期后点击「模拟提交」调用本接口：把该日期 daily_learning_tasks 行子资源 done 全部置 true、status=completed，
    // 并补写 daily_task_completions（去重）；随后前端自动跳到笔记页用该 date 触发生成（含进度条）。
    if (pathname === '/api/simulate-day' && req.method === 'POST') {
      const userId = requireUserId(req, res); if (!userId) return;
      const b = await readBody(req).catch(() => ({}));
      const date = b.date || b.currentDate;
      if (!date || typeof date !== 'string') return sendJson(res, 400, { error: '缺少 date 参数', code: 'BAD_PARAM' });
      const planId = buildPlanId(userId);
      const rows = db.prepare('SELECT * FROM daily_learning_tasks WHERE user_id = ? AND plan_id = ? ORDER BY day_number ASC').all(userId, planId);
      const row = rows.find((r) => String(r.task_date) === String(date)) || null;
      if (!row) return sendJson(res, 400, { error: '该日期暂无学习计划任务，请选择已生成学习计划的日期（如当前计划已展开的那几天）', code: 'NO_PLAN' });
      const parseArr = (s) => { try { const a = JSON.parse(s || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };
      const markDone = (arr) => arr.map((x) => ({ ...x, done: true }));
      const videoArr = parseArr(row.video_info);
      const pdfArr = parseArr(row.pdf_info);
      const taskArr = parseArr(row.tasks);
      const videoInfo = JSON.stringify(markDone(videoArr));
      const pdfInfo = JSON.stringify(markDone(pdfArr));
      const tasksJson = JSON.stringify(markDone(taskArr));
      db.prepare('UPDATE daily_learning_tasks SET video_info = ?, pdf_info = ?, tasks = ?, status = ?, updated_at = ? WHERE id = ?')
        .run(videoInfo, pdfInfo, tasksJson, 'completed', Date.now(), row.id);
      // 补写打卡记录（去重）
      const allComps = db.state.tables.daily_task_completions || (db.state.tables.daily_task_completions = []);
      const exSet = new Set(allComps.filter((c) => c.user_id === userId && c.date === date).map((x) => x.task_id));
      const allSubs = [
        ...videoArr.map((v) => ({ key: v.key || 'video:' + (v.url || ''), title: v.title || '' })),
        ...pdfArr.map((p) => ({ key: p.key || 'pdf:' + (p.docId || ''), title: p.title || '' })),
      ];
      let added = 0;
      for (const s of allSubs) {
        const taskId = `${row.day_number}__${s.key}`;
        if (exSet.has(taskId)) continue;
        allComps.push({ id: (allComps.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0) + 1), user_id: userId, plan_id: planId, task_id: taskId, date, resource_key: s.key, title: s.title, completed: 1, created_at: Date.now() });
        exSet.add(taskId); added++;
      }
      db.save();
      return sendJson(res, 200, { ok: true, date, addedCheckins: added, dayNumber: row.day_number, message: `已模拟 ${date} 的当日学习提交（任务标记完成 + 写入打卡记录），可前往生成笔记。` });
    }

    if (pathname === '/api/test/settle-24' && req.method === 'POST') {
      const userId = requireUserId(req, res); if (!userId) return;
      if (process.env.TEST_MODE !== '1') return sendJson(res, 403, { error: '仅测试模式可用', code: 'TEST_ONLY' });
      const planId = buildPlanId(userId);
      const date = todayDateStr();
      const rows = db.prepare('SELECT * FROM daily_learning_tasks WHERE user_id = ? AND plan_id = ? ORDER BY day_number ASC').all(userId, planId);
      const formal = rows.filter((r) => (r.day_number ?? 0) >= 1);
      // 定位当天行：优先 task_date 精确匹配（兼容 task_date 缺失，回退到 day_number 最小行）
      const row = formal.find((r) => r.task_date === date) || formal[0] || null;
      if (!row) return sendJson(res, 400, { error: '当天无任务' });
      // 内联展开已完成子任务（status 由 done 决定），不依赖外部工具函数避免作用域问题
      const parseArr = (s) => { try { const a = JSON.parse(s || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };
      const allSubs = [
        ...parseArr(row.video_info).map((v) => ({ key: v.key || 'video:' + (v.url || ''), title: v.title || (v.resource && v.resource.title) || '', done: !!v.done })),
        ...parseArr(row.pdf_info).map((p) => ({ key: p.key || 'pdf:' + (p.docId || ''), title: p.title || (p.resource && p.resource.title) || '', done: !!p.done })),
      ];
      const completedSubs = allSubs.filter((s) => s.done);
      // 第一步：补齐未提交的打卡（去重）
      const allComps = db.state.tables.daily_task_completions || (db.state.tables.daily_task_completions = []);
      const existingRow = allComps.filter((c) => c.user_id === userId && c.date === date);
      const exSet = new Set(existingRow.map((x) => x.task_id));
      let addedCheckins = 0;
      for (const s of completedSubs) {
        const taskId = `${row.day_number}__${s.key}`;
        if (exSet.has(taskId)) continue;
        allComps.push({ id: (allComps.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0) + 1), user_id: userId, plan_id: planId, task_id: taskId, date, resource_key: s.key, title: s.title, completed: 1, created_at: Date.now() });
        exSet.add(taskId); addedCheckins++;
      }
      // 第二步：自动生成当天笔记（mock，不计入每日 2 次上限）
      const completions = allComps.filter((c) => c.user_id === userId && c.date === date);
      if (!completions.length) return sendJson(res, 200, { ok: true, addedCheckins, note: null, message: '当日无已完成任务，未生成笔记' });
      const titles = [...new Set(completions.map((c) => c.title).filter(Boolean))];
      const content = {
        title: '今日学习总结',
        summary: `今日完成学习：${titles.join('、')}`,
        keyPoints: titles.map((t) => `完成${t}学习`),
        concepts: titles.map((t) => ({ term: t, desc: `${t} 核心概念` })),
        productInsights: ['从产品视角理解今日内容'],
        examples: titles.map((t) => ({ title: t, desc: `${t} 应用示例` })),
        practice: ['复习今日完成任务的关键概念'],
        reviewQuestions: titles.map((t) => `简述 ${t} 的要点`),
        memory: { reviewAt: [1, 3, 7] },
      };
      const table = db.state.tables.learning_notes || (db.state.tables.learning_notes = []);
      const existingNote = table
        .filter((r) => r.user_id === userId && String(r.note_date) === String(date))
        .sort((a, b) => Number(b.id) - Number(a.id))[0];
      const now = Date.now();
      let note;
      if (existingNote) {
        existingNote.content = JSON.stringify(content);
        existingNote.title = content.title;
        existingNote.source_tasks = JSON.stringify(completions.map((c) => ({ key: c.resource_key, title: c.title })));
        existingNote.updated_at = now;
        note = existingNote;
      } else {
        note = {
          id: (table.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0) + 1),
          user_id: userId, task_id: `${row.day_number}`, stage: row.stage,
          skill_id: row.skill_id || null, skill_name: row.skill_name || null,
          stage_id: row.stage_id || null,
          title: content.title, content: JSON.stringify(content),
          source_tasks: JSON.stringify(completions.map((c) => ({ key: c.resource_key, title: c.title }))),
          note_date: date, month: date.slice(0, 7), day: date.slice(8, 10),
          generation_count: 1, created_at: now, updated_at: now,
        };
        table.push(note);
      }
      db.save();
      return sendJson(res, 200, { ok: true, addedCheckins, note });
    }

    // ============ 测试模式：模拟每日结算 + 当前 stage 内重排（需求十五/十六） ============
    // 检查当天完成情况；若当天有未完成任务，则按「当前 stage 内部重排」规则重新规划剩余任务：
    // 优先当前 stage、禁止跳章节、视频与 PDF 保持同 stage。
    if (pathname === '/api/test/daily-settle' && req.method === 'POST') {
      const userId = requireUserId(req, res); if (!userId) return;
      if (process.env.TEST_MODE !== '1') return sendJson(res, 403, { error: '仅测试模式可用', code: 'TEST_ONLY' });
      const b = await readBody(req).catch(() => ({}));
      const planId = buildPlanId(userId);
      const date = todayDateStr();
      const rows = db.prepare('SELECT * FROM daily_learning_tasks WHERE user_id = ? AND plan_id = ? ORDER BY day_number ASC').all(userId, planId);
      const prof = getProfile(userId);
      const settlement = await dailyPlanScheduler.runDailySettlement({
        tasks: rows, today: date, dailyCapacityMinutes: dailyCapacityMinutesOf(prof), targetDate: prof?.targetDate || null, startDate: prof?.startDate,
      });
      // 若当天有未完成任务（完成率 < 100%），则在当前 stage 内重排剩余任务
      const sp = settlement.stage || dailyPlanAdjuster.stageProgress({ tasks: rows });
      const currentStage = sp.currentStage;
      const remaining = dailyPlanAdjuster.rescheduleWithinStage({ tasks: rows, fromDate: date, today: date, dailyCapacityMinutes: dailyCapacityMinutesOf(prof) });
      // 应用重排结果到 DB（按 day_number 对齐写回）
      if (remaining && remaining.days && remaining.days.length) {
        const byDay = new Map(remaining.days.map((r) => [r.day_number, r]));
        for (const r of rows) {
          const nr = byDay.get(r.day_number);
          if (nr) {
            // 仅覆盖由重排产生的调度字段，保留 id/plan_id/user_id 等主键
            r.task_date = nr.task_date ?? r.task_date;
            r.status = nr.status ?? r.status;
            r.focus = nr.focus ?? r.focus;
            r.video_info = nr.video_info ?? r.video_info;
            r.pdf_info = nr.pdf_info ?? r.pdf_info;
            r.stage = nr.stage ?? r.stage;
            r.skill_name = nr.skill_name ?? r.skill_name;
            r.adjustedDay = nr.adjustedDay ?? r.adjustedDay;
            r.reschedule_count = (r.reschedule_count ?? 0) + 1;
          }
        }
        db.save();
      }
      return sendJson(res, 200, {
        ok: true,
        currentStage,
        todayDate: date,
        needAdjust: settlement.needAdjust,
        reason: settlement.reason,
        changed: !!(remaining && remaining.tasks && remaining.tasks.length),
        rule: '未完成任务 + 当前 stage 剩余任务，优先当前 stage、禁止跳章节、视频与 PDF 保持同 stage',
      });
    }
    // ================= 每日学习计划生成（DailyPlanGenerator） =================
    // 【硬约束】纯代码拆分，绝不调用 LLM；资源全部来自已有真实阶段计划。
    // 从本地库取回已生成的阶段计划，回填成 DailyPlanGenerator 需要的 {planId, stages} 形状
    // 从 RAG 分块 meta 中聚合某个 PDF 的真实章节列表（按出现顺序去重）。
    // 【RAG 边界】PDF 正文、chunk、向量检索一律走独立的 rag.sqlite3（rag.mjs），
    // 业务库 offerdao.db 只保存业务数据，严禁把业务库 rag_chunks 当作真实来源。
    // 以下数据全部来自已入库文档（rag.sqlite3），不由模型生成。
    // 返回 { chapters, chunkCount }
    //   chapters  : RAG 分块 meta 里真实存在的章节名（去重保序）；没有则为空数组
    //   chunkCount: 该文档的真实分块数，用于在无章节/无页码时把 PDF 切成「第 N 部分」
    // 判断一条 "章节名" 是否来自目录页 / 页眉污染（OCR 扫描书常见）：
    //   - 含连续页码罗列（"…3、…5" / "……104" / "………………"）
    //   - 单条内罗列多个 "第X章"（目录行）
    //   - 长度过长（正常章节名 ≤ ~40 字，目录整行可达数百字）
    function isTocNoise(ch) {
      if (!ch) return true;
      if (ch.length > 40) return true;
      if (/[、，,]\s*第.{1,12}[章节篇]/.test(ch)) return true; // 一行里罗列多个章节
      if (/……|\.\.\.|[、，,]\s*\d+\s*$/.test(ch)) return true; // 行尾带页码/省略号
      if (/\d+\s*[-–—]\s*\d+/.test(ch)) return true; // 页码区间
      if (/\s\d{1,4}\s*$/.test(ch)) return true; // 行尾单个页码（页眉重复打印）
      return false;
    }
    function loadPdfSegments(docId) {
      if (!docId) return { chapters: [], chunkCount: 0 };
      // 统一通过 rag.mjs 访问 rag.sqlite3，避免业务库死表 rag_chunks 干扰。
      const chunks = rag.getChunksByDocId(docId) || [];
      const seen = new Set();
      const raw = [];
      for (const c of chunks) {
        const meta = c.meta && typeof c.meta === 'object' ? c.meta : {};
        const ch = (meta && meta.chapter ? String(meta.chapter) : '').trim();
        if (!ch || seen.has(ch) || isTocNoise(ch)) continue;
        seen.add(ch);
        raw.push(ch);
      }
      // 目录污染严重时（正文章节提取也不可靠），降级为「无章节」：
      // DailyPlanGenerator 会改用按页数切片（显示"阅读 X-Y 页"），避免把整本书目录串展示出来。
      const MAX_CHAPTERS = 24;
      const chapters = raw.length > MAX_CHAPTERS ? [] : raw;
      return { chapters, chunkCount: chunks.length };
    }

    function sanitizeChapterLabel(ch) {
      const s = String(ch || '').trim().replace(/\s+/g, ' ');
      if (!s) return '';
      if (s.length > 40) return '';
      if ((s.match(/第.{1,12}[章节篇讲]/g) || []).length >= 2) return '';
      if (/[、，,]\s*第.{1,12}[章节篇]/.test(s)) return '';
      if (/……|\.\.\.|[、，,]\s*\d+\s*$/.test(s)) return '';
      if (/\d+\s*[-–—]\s*\d+/.test(s)) return '';
      if (/\s\d{1,4}\s*$/.test(s)) return '';
      if (/^(目录|contents?)$/i.test(s)) return '';
      return s;
    }

    // —— 视频文字内容获取（接入 bili-note skill，仅处理当天学习的分P）——
    const BILI_NOTE_DIR = path.join(__dirname, '..', 'skills', 'bili-note', 'scripts');
    const BILI_WORK_ROOT = path.join(__dirname, '..', 'tmp_bili_notes');
    function parseParts(partStr) {
      // partStr 形如 "P1-P4" / "P1,P3" / "P1" / 空
      // bili-note 的 select_pages 仅接受逗号分隔的页码整数列表（如 "1,2,3"），不支持横杠范围
      if (!partStr) return 'all';
      const s = String(partStr).replace(/P/gi, '').trim();
      const range = s.match(/^(\d+)\s*-\s*(\d+)$/);
      if (range) {
        const a = parseInt(range[1], 10), b = parseInt(range[2], 10);
        const lo = Math.min(a, b), hi = Math.max(a, b);
        const pages = [];
        for (let i = lo; i <= hi; i++) pages.push(i);
        return pages.join(',');
      }
      // 已是逗号/空格分隔数字列表则原样返回（清洗非数字分隔符）
      const list = s.split(/[,\s]+/).map((x) => x.trim()).filter((x) => /^\d+$/.test(x));
      return list.length ? list.join(',') : 'all';
    }

    // 解析资源 part 字段，区分三种形态：
    //   - 分P列表："P1-P15" / "3,5" / "P3"  → { kind:'pages', pages:[...] }
    //   - 时间窗口："24:22-48:44" / "1:02:03-1:05:00" → { kind:'range', rangeSec:[start,end] }
    //     用于「一个P拆多天学」：抓整视频字幕后按时间窗裁剪（页面归属由字幕manifest定位）
    //   - 空/其他 → { kind:'all' }
    function parsePartSpec(partStr) {
      const s = String(partStr || '').trim();
      if (!s) return { kind: 'all' };
      // 时间窗口：mm:ss-mm:ss 或 h:mm:ss-h:mm:ss（允许单冒号，如 24:22-48:44）
      const tWin = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*-\s*(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
      if (tWin) {
        const toSec = (h, m, sec) => {
          const H = h ? parseInt(h, 10) : 0;
          const M = parseInt(m, 10);
          const S = sec ? parseInt(sec, 10) : 0;
          return H * 3600 + M * 60 + S;
        };
        const start = toSec(tWin[1], tWin[2], tWin[3]);
        const end = toSec(tWin[4], tWin[5], tWin[6]);
        if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
          return { kind: 'range', rangeSec: [start, end] };
        }
      }
      // 分P 列表
      const pages = String(s).replace(/P/gi, '')
        .split(/[,\s-]+/).map((x) => parseInt(x, 10))
        .filter((n) => Number.isFinite(n) && n > 0);
      if (pages.length) return { kind: 'pages', pages };
      return { kind: 'all' };
    }
    // —— 视频字幕缓存：避免每次生成笔记都重新联网抓字幕（主要性能瓶颈）——
    // 采用进程内 Map 缓存：零依赖、无 SQL 驱动兼容问题，同进程内多次生成复用。
    // （注：早期基于 video_subtitle_cache 表的实现因业务库为 JsonDatabaseSync 不支持
    //  ON CONFLICT/复杂查询而全部失效，故改为内存缓存，重启后失效但抓取一次即缓存。）
    const _subtitleCache = new Map();
    function _subCacheKey(url, part, rangeSec) {
      let bvid = null;
      const m = String(url || '').match(/BV[0-9A-Za-z]+/);
      if (m) bvid = m[0];
      // rangeSec 进 key：同一P不同时间窗（一个P拆多天学）互不串味，各自独立缓存
      const rangeTag = Array.isArray(rangeSec) && rangeSec.length === 2
        ? `#r${rangeSec[0]}-${rangeSec[1]}` : '';
      const key = `${bvid || url || 'unknown'}|${part || 'all'}${rangeTag}`;
      return { key, bvid };
    }
    function _getSubtitleCache(key) {
      return _subtitleCache.get(key) || null;
    }
    function _setSubtitleCache(key, bvid, part, text) {
      if (!text || !text.trim()) return;
      _subtitleCache.set(key, text);
    }
    async function extractBiliSubtitles(url, part, rangeSec, page) {
      if (!url) return '';
      // 测试模式：不走 Python/网络抓取，返回确定性占位字幕，避免外部依赖与耗时。
      if (process.env.NOTE_LLM_MOCK === '1' || process.env.LLM_MOCK === '1') {
        return `[MOCK字幕] 视频 ${url} 分P ${part || 'all'} 的字幕文本。本段用于验证增量链路，不代表真实内容。`;
      }
      // 命中缓存直接返回（零联网，秒回）。rangeSec 已并入 key，
      // 同一P不同时间窗各自独立缓存，互不串味。
      const { key, bvid } = _subCacheKey(url, part, rangeSec);
      const cached = _getSubtitleCache(key);
      if (cached) {
        console.log('[bili-sub] cache hit', key);
        return cached;
      }
      const t0 = Date.now();
      console.log('[bili-sub] start', url, 'part=', part || 'all', rangeSec ? `range=${rangeSec[0]}-${rangeSec[1]}` : '');
      try {
        fs.mkdirSync(BILI_WORK_ROOT, { recursive: true });
        const workDir = path.join(BILI_WORK_ROOT, `task_${Date.now()}`);
        const py = process.env.PYTHON_BIN || 'python';
        const args = [
          path.join(BILI_NOTE_DIR, 'run_bili_note.py'),
          url,
          '--work-dir', workDir,
          '--parts', parseParts(part),
          '--subtitle-mode', 'auto',
          '--no-archive',
        ];
        // 关键：B站字幕（官方/CC/需登录/AI 自动）在游客态下 player/v2 不返回字幕列表，
        // 必须带登录 cookie 才能看到。这里读取系统级 B站登录态（来自 data/bili/cookie.json
        // 或环境变量 BILI_COOKIE/BILI_SESSDATA，见 plan.mjs getBiliCookie），作为
        // BILI_COOKIE 环境变量注入 bilinote 子进程，使其 player/v2 探查/提取带登录态。
        // 无 cookie 时退回游客态，不影响其他功能。
        const env = { ...process.env };
        const biliCookie = plan.getBiliCookie ? plan.getBiliCookie() : null;
        if (biliCookie) env.BILI_COOKIE = biliCookie;
        const { stdout, stderr } = await new Promise((resolve, reject) => {
          const cp = spawn(py, args, { timeout: 45000, env, windowsHide: true });
          let out = '', err = '';
          cp.stdout.on('data', (d) => { out += d; });
          cp.stderr.on('data', (d) => { err += d; });
          cp.on('error', reject);
          cp.on('close', (code) => resolve({ stdout: out, stderr: err, code }));
        });
        console.log('[bili-sub] done', url, 'cost_ms=', Date.now() - t0, 'code=', (stderr || '').includes('error') ? 'see-stderr' : 'ok');
        // 优先按时间窗口裁字幕：从带时间戳的 .subtitle.json（经 manifest 定位）过滤窗口内条目。
        // 这解决「一个P拆多天学」的问题——只把当天应学的时间段喂给大模型。
        let text = '';
        if (Array.isArray(rangeSec) && rangeSec.length === 2) {
          const sliced = _sliceSubtitleByRange(workDir, rangeSec[0], rangeSec[1], page);
          if (sliced) text = sliced;
        }
        // 回退：读取生成的字幕 txt 文件（extract_bilibili 产出 <lang>.txt 纯文本）
        if (!text.trim()) {
          try {
            const files = fs.readdirSync(workDir).filter((f) => f.endsWith('.txt'));
            for (const f of files) text += fs.readFileSync(path.join(workDir, f), 'utf-8') + '\n';
          } catch { /* 忽略 */ }
        }
        if (!text.trim()) {
          console.warn('[note] bili 字幕提取为空（可能无公开字幕或网络受限）：', stderr.slice(0, 200));
        } else {
          _setSubtitleCache(key, bvid, part, text.trim());
        }
        return text.trim();
      } catch (e) {
        console.warn('[note] bili 字幕提取失败（跳过，仅用 PDF 生成笔记）：', e.message);
        return '';
      }
    }

    // 按时间窗口 [startSec, endSec] 从字幕产物中裁剪文本。
    // 读取 subtitle_manifest.json，定位各分P字幕 json（含 from/to 时间戳），
    // 取落在窗口内的条目拼接；优先 ai-zh 轨道，否则取任一轨道。
    // page：若指定，则只在目标分P的字幕内裁剪（避免同一视频不同P的字幕串扰）。
    function _sliceSubtitleByRange(workDir, startSec, endSec, page) {
      let manifest;
      try {
        manifest = JSON.parse(fs.readFileSync(path.join(workDir, 'subtitle_manifest.json'), 'utf-8'));
      } catch (e) { return null; }
      const tracks = Array.isArray(manifest) ? manifest : (manifest.outputs || []);
      if (!tracks.length) return null;
      // 优先 ai-zh，其次任意带 json 的轨道
      const preferred = tracks.filter((t) => (t.lan || '').includes('ai-zh'))
        .concat(tracks.filter((t) => !(t.lan || '').includes('ai-zh')));
      const lines = [];
      let found = false;
      for (const t of preferred) {
        // 限定分P：指定 page 时，仅处理该分P的字幕轨道
        if (page != null && Number(t.page) !== Number(page)) continue;
        const jsonPath = t.json || (t.subtitle_json);
        if (!jsonPath) continue;
        let body;
        try {
          const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
          body = Array.isArray(data?.body) ? data.body : Array.isArray(data) ? data : null;
        } catch (e) { continue; }
        if (!body) continue;
        found = true;
        for (const item of body) {
          const from = Number(item.from ?? item.start ?? item.begin ?? 0);
          const to = Number(item.to ?? item.end ?? item.stop ?? from);
          // 与窗口有重叠即纳入，避免边界丢句
          if (to >= startSec - 1 && from <= endSec + 1) {
            const c = (item.content ?? item.text ?? '').trim();
            if (c) lines.push(c);
          }
        }
        if ((t.lan || '').includes('ai-zh')) break; // 优先轨道已处理则停止
      }
      return found ? lines.join('\n') : null;
    }

    // —— 分P级字幕抓取：只抓单个分P 的字幕（用于逐P 相关性过滤）——
    // 复用 extractBiliSubtitles 的缓存/Python 链路，part 传单个页码字符串（如 "3"）。
    async function extractBiliSubtitlesSinglePart(url, partNo) {
      return extractBiliSubtitles(url, String(partNo));
    }

    // —— 分P 相关性过滤缓存（进程内）——
    // key: `${bvid}|P${partNo}`  value: { relevance_score, keep }
    // 避免每次生成笔记重复计算 embedding / 重复调用判定。
    const _partFilterCache = new Map();
    function _partFilterKey(bvid, partNo) {
      return `${bvid}|P${partNo}`;
    }

    // —— 分P 标题抓取（兜底数据源，不依赖字幕 CDN）——
    // 字幕下载在本机常因 player/字幕 CDN 超时失败（游客态/网络受限），但
    // 分P 标题来自 api.bilibili.com/x/player/pagelist，游客态即可访问，几乎必通。
    // 当字幕为空时，用标题做 embedding 过滤，仍能拦掉明显无关的分P（摄影/铜锣烧等）。
    const _partTitleCache = new Map(); // bvid -> { Pn: '标题' }
    async function extractBiliPartTitles(url) {
      const m = String(url || '').match(/BV[0-9A-Za-z]+/);
      const bvid = m ? m[0] : null;
      if (!bvid) return {};
      if (_partTitleCache.has(bvid)) return _partTitleCache.get(bvid);
      try {
        const https = await import('https');
        const apiUrl = `https://api.bilibili.com/x/player/pagelist?bvid=${bvid}`;
        const data = await new Promise((resolve, reject) => {
          const req = https.get(apiUrl, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.bilibili.com/' } }, (res) => {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
          });
          req.on('error', reject);
          req.setTimeout(15000, () => { req.destroy(); reject(new Error('pagelist timeout')); });
        });
        const map = {};
        if (data && Array.isArray(data.data)) {
          for (const p of data.data) {
            if (p && p.page != null && p.part) map[`P${p.page}`] = String(p.part).trim();
          }
        }
        _partTitleCache.set(bvid, map);
        return map;
      } catch (e) {
        console.warn('[part-filter] 分P标题抓取失败（跳过标题兜底）：', e.message);
        const empty = {};
        _partTitleCache.set(bvid, empty);
        return empty;
      }
    }

    // 余弦相似度（向量已 L2 归一化时等价于点积）
    function _cosine(a, b) {
      if (!a || !b || a.length !== b.length) return 0;
      let s = 0;
      for (let i = 0; i < a.length; i++) s += a[i] * b[i];
      return s;
    }

    // —— 分P 相关性过滤（根治输入污染，不重新猜测用户意图）——
    // 依据：task_title / skill / resource_title（已有真实用户意图）。
    // 实现：task_title embedding vs 每个P 字幕 embedding；
    //   阈值 >=0.6 保留，<=0.4 丢弃，0.4-0.6 边界情况才调 LLM 极短判定（低 token）。
    // 返回：{ keptParts: [{partNo, text}], scored: [{partNo, relevance_score, keep}] }
    async function filterVideoPartsByRelevance({ url, partList, taskTitle, skill, resourceTitle }) {
      const m = String(url || '').match(/BV[0-9A-Za-z]+/);
      const bvid = m ? m[0] : (url || 'unknown');
      const anchor = String(taskTitle || skill || resourceTitle || '').trim();
      const scored = [];
      const keptParts = [];

      if (!anchor || !partList.length) {
        // 无锚定主题（理论上不应发生）→ 全部保留，依赖 Prompt 兜底
        for (const p of partList) {
          const text = await extractBiliSubtitlesSinglePart(url, p);
          scored.push({ partNo: p, relevance_score: 1, keep: true });
          if (text) keptParts.push({ partNo: p, text });
        }
        return { keptParts, scored };
      }

      // 1) 拉取所有 P 字幕（带缓存，避免重复联网） + 分P 标题（兜底数据源）
      const partTitles = await extractBiliPartTitles(url).catch(() => ({}));
      const partTexts = [];
      for (const p of partList) {
        const sub = await extractBiliSubtitlesSinglePart(url, p);
        // 字幕优先；字幕为空时回退到分P标题（标题游客态可访问，几乎必通）
        const title = partTitles[`P${p}`] || '';
        const text = (sub && sub.trim()) ? sub.trim() : title;
        partTexts.push(text || '');
      }

      // 2) embedding 相似度（task 锚定 vs 各 P 文本[字幕或标题]），本地推理不花钱
      let anchorEmb, partEmbs;
      try {
        [anchorEmb] = await rag.embedTexts([anchor]);
        const nonEmpty = partTexts.map((t) => t || anchor);
        partEmbs = await rag.embedTexts(nonEmpty);
      } catch (e) {
        console.warn('[part-filter] embedding 失败，全部保留：', e.message);
        for (let i = 0; i < partList.length; i++) {
          scored.push({ partNo: partList[i], relevance_score: 1, keep: true });
          if (partTexts[i]) keptParts.push({ partNo: partList[i], text: partTexts[i] });
        }
        return { keptParts, scored };
      }

      const KEEP = 0.58, DROP = 0.45;
      for (let i = 0; i < partList.length; i++) {
        const p = partList[i];
        const cacheKey = _partFilterKey(bvid, p);
        if (_partFilterCache.has(cacheKey)) {
          const c = _partFilterCache.get(cacheKey);
          scored.push({ partNo: p, relevance_score: c.relevance_score, keep: c.keep });
          if (c.keep && partTexts[i]) keptParts.push({ partNo: p, text: partTexts[i] });
          continue;
        }
        let score = partTexts[i].trim() ? _cosine(anchorEmb, partEmbs[i]) : 0;
        let keep;
        if (!partTexts[i].trim()) {
          keep = false; score = 0;
        } else {
          // 第一关：关键词预筛（零 token），命中强无关信号直接丢弃
          const kw = _keywordDropCheck(partTexts[i], anchor);
          if (kw.drop) {
            keep = false;
            scored.push({ partNo: p, relevance_score: score, keep: false, droppedBy: 'keyword:' + kw.domain });
            _partFilterCache.set(cacheKey, { relevance_score: score, keep: false });
            if (keep && partTexts[i]) keptParts.push({ partNo: p, text: partTexts[i] });
            continue;
          }
          if (score >= KEEP) {
            keep = true;
          } else if (score <= DROP) {
            keep = false;
          } else {
            // 边界情况：调 LLM 极短判定（仅一次，token 极小，符合"仅边界调用"要求）
            keep = await _llmJudgeRelevance({ anchor, partText: partTexts[i] });
          }
        }
        _partFilterCache.set(cacheKey, { relevance_score: score, keep });
        scored.push({ partNo: p, relevance_score: score, keep });
        if (keep && partTexts[i]) keptParts.push({ partNo: p, text: partTexts[i] });
      }
      console.log('[part-filter]', bvid, 'kept', keptParts.length, '/', partList.length,
        'scores', scored.map((s) => `P${s.partNo}:${s.relevance_score.toFixed(2)}`).join(' '));
      return { keptParts, scored };
    }

    // 边界情况判定：只问"是否相关"，要求模型回复 yes/no（极短，低 token）
    async function _llmJudgeRelevance({ anchor, partText }) {
      try {
        const sys = '你是内容相关性判别器。只回答 yes 或 no，不要解释。';
        const usr = `学习任务主题：${anchor}\n\n待判断的字幕片段：\n${String(partText).slice(0, 800)}\n\n这段字幕是否与上述学习任务主题相关？回答 yes 或 no。`;
        const r = await plan.callQwen(sys, usr, process.env.NOTE_LLM_MOCK === '1' ? 'qwen-turbo' : undefined);
        return /yes/i.test(String(r || ''));
      } catch {
        return true; // 判定失败时保守保留，交给 Prompt 兜底
      }
    }

    // —— 关键词预筛（零 token，第一关）——
    // 依据已有领域信号词库：当分P 字幕命中「与学习主题明显无关的强信号词」且任务领域不包含该领域时，直接 DROP。
    // 信号词库按领域分组；命中某领域信号词时，再检查 anchor 是否本身就在该领域（如用户真学摄影则不误杀）。
    const _IRRELEVANT_SIGNALS = [
      { domain: '摄影', words: ['空镜头', '黄金时刻', '构图', '光圈', '景别', '运镜', '相机', '拍摄技巧', '快门', 'iso', '摄影'] },
      { domain: '影视叙事', words: ['亲子鉴定', '叙事', '剧本', '情感故事', 'instagram事件', '剧情', '人物弧光'] },
      { domain: '食品零售', words: ['配料表', '比利时巧克力', '铜锣烧', '烘焙', '沃尔玛', '烘焙区', '慢熬', '芝士', '奶油'] },
    ];
    function _keywordDropCheck(text, anchor) {
      const lower = String(text).toLowerCase();
      const anchorLower = String(anchor).toLowerCase();
      for (const grp of _IRRELEVANT_SIGNALS) {
        // 若任务本身就在该领域（如用户学摄影），跳过该组，避免误杀
        if (grp.words.some((w) => anchorLower.includes(w.toLowerCase()))) continue;
        const hit = grp.words.filter((w) => lower.includes(w.toLowerCase()));
        if (hit.length >= 2) return { drop: true, domain: grp.domain, hits: hit };
      }
      return { drop: false };
    }

    // —— PDF 内容获取：按 docId 从 RAG 库精确取回该文档 chunk（不发送整本 PDF）——
    // 切片优先级：segment.chunkFrom/chunkTo（计划已精确到片） > 页码范围（meta.page） > 取文档最前若干片。
    // maxChunks: 限制返回的切片数量（第0天热身仅取 2 片以节省 token）
    function getPdfChunks(docId, pdfRange, maxChunks = 40, segment) {
      if (!docId) return '';
      const chunks = rag.getChunksByDocId(docId) || [];
      // 测试模式：RAG 库中无该文档时返回确定性占位 chunk，保证链路可验证。
      if (!chunks.length && (process.env.NOTE_LLM_MOCK === '1' || process.env.LLM_MOCK === '1')) {
        return `[MOCK PDF] 文档 ${docId} 范围 ${pdfRange || '默认'} 的切片文本。本段用于验证增量链路，不代表真实内容。`;
      }
      if (!chunks.length) return '';
      // 1) 计划已带精确片范围（segment.chunkFrom/chunkTo，1-based 闭区间）→ 严格按此切片，避免每天重复读开头
      let selected = chunks;
      if (segment && Number(segment.chunkFrom) && Number(segment.chunkTo)) {
        const lo = Math.max(1, Number(segment.chunkFrom));
        const hi = Math.min(chunks.length, Number(segment.chunkTo));
        if (hi >= lo) {
          const sliced = chunks.slice(lo - 1, hi); // 1-based → 0-based
          if (sliced.length) selected = sliced;
        }
      } else if (pdfRange && /^\d/.test(String(pdfRange))) {
        // 2) 兜底：没有 segment 但给了页码范围，且 chunk 带 meta.page 时按页过滤；否则取最前若干片
        const pageNums = String(pdfRange).match(/\d+/g)?.map(Number) || [];
        const hasPage = chunks.some((c) => c.meta && c.meta.page !== undefined);
        if (hasPage && pageNums.length) {
          const lo = Math.min(...pageNums), hi = Math.max(...pageNums);
          const filtered = chunks.filter((c) => { const p = Number(c.meta.page); return p >= lo && p <= hi; });
          if (filtered.length) selected = filtered;
        }
      }
      const segLabel = segment && Number(segment.chunkFrom)
        ? `第${segment.chunkFrom}-${segment.chunkTo}片`
        : (pdfRange || '默认');
      const header = `（当天阅读范围：${segLabel}）\n`;
      // 仅取 content（不含 embedding），并按 meta 中的章节/页码标注，便于模型理解上下文
      const body = selected
        .map((c) => {
          const meta = c.meta || {};
          const tag = meta.chapter || meta.page ? `[${meta.chapter || meta.page}] ` : '';
          return `${tag}${c.content || ''}`;
        })
        .slice(0, maxChunks)
        .join('\n---\n');
      return header + body;
    }

    function loadStagePlanForDaily(userId, planId) {
      // 读取唯一学习路线表 learning_plans（每用户一条），作为每日任务的单一真源。
      let data = null;
      let row = db.prepare('SELECT data, created_at, days, job FROM learning_plans WHERE user_id = ?').get(userId);
      if (row && row.data) {
        try { data = JSON.parse(row.data || '{}'); } catch { data = null; }
      }
      if (!data) return null;
      let stages = Array.isArray(data.stages) ? data.stages : null;
      // 兜底：integrated 计划没有 stages，但有 sections。
      // sections 是「扁平板块」结构：视频字段直接挂在板块上(link/durationSec/parts)，PDF 在 pdfs[]，
      // 技能名在 skillNames[]。这里映射为标准 stage 结构，务必保留真实 url / docId / link / parts。
      if (!stages) {
        const sections = Array.isArray(data.sections) ? data.sections : [];
        if (sections.length) {
          stages = sections.map((s, i) => {
            const stageName = s.title || `板块${i + 1}`;
            const skillNames = Array.isArray(s.skillNames) && s.skillNames.length
              ? s.skillNames
              : (Array.isArray(s.skills) && s.skills.length ? s.skills : [stageName]);
            const videos = [];
            if (s.link) {
              videos.push({
                id: `sec${i}_v`,
                title: s.biliTitle || s.title || '',
                url: s.link,
                link: s.link,
                platform: s.platform || 'bilibili',
                durationSec: Number(s.durationSec) || 0,
                parts: Array.isArray(s.parts) ? s.parts : [],
                skills: skillNames,
              });
            }
            const pdf = (Array.isArray(s.pdfs) ? s.pdfs : []).map((p, k) => {
              const hasCh = Array.isArray(p.chapters) && p.chapters.length;
              const seg = hasCh ? { chapters: p.chapters, chunkCount: 0 } : loadPdfSegments(p.docId);
              return {
                id: p.id || `sec${i}_p${k}`,
                title: p.title || '',
                docId: p.docId || '',
                link: p.link || '',
                file: p.file || '',
                // 计划里没带章节时，回查 RAG 真实章节（仍是已有资源，非模型生成）
                chapters: seg.chapters,
                totalPages: Number(p.totalPages) || 0,
                chunkCount: seg.chunkCount,
                skills: skillNames,
              };
            });
            return { stage: stageName, skills: skillNames, resources: { pdf, videos } };
          });
        }
      }
      if (!stages || !stages.length) return null;
      // 规范化每层 resources，确保含 pdf / videos 数组
      for (const st of stages) {
        const r = (st.resources && typeof st.resources === 'object') ? st.resources : {};
        st.resources = { pdf: Array.isArray(r.pdf) ? r.pdf : [], videos: Array.isArray(r.videos) ? r.videos : [] };
      }

      // —— 每日计划只负责拆分已生成好的总体计划资源，不做任何 skill 重新匹配 / RAG / B站搜索 ——
      // 阶段计划里已有的 resources.{videos, pdf} 即为全部真实资源，直接使用，不新增、不覆盖、不裁剪。
      for (const st of stages) {
        const r = (st.resources && typeof st.resources === 'object') ? st.resources : {};
        st.resources = {
          pdf: Array.isArray(r.pdf) ? r.pdf : [],
          videos: Array.isArray(r.videos) ? r.videos : [],
        };
      }

      const resolvedPlanId = planId || data.planId || data.id || buildPlanId(userId);
      // 标准化技能列表（skill_id / standard_name / category / level）——
      // DailyPlanGenerator 用它补齐每日任务里的 skill 元信息。
      let skills = [];
      const rawSkills = Array.isArray(data.skills) ? data.skills
        : (Array.isArray(data.skillTree?.skills) ? data.skillTree.skills : []);
      for (const s of rawSkills) {
        if (!s) continue;
        if (typeof s === 'string') { skills.push({ standard_name: s }); continue; }
        if (s.standard_name || s.name) {
          skills.push({
            skill_id: s.skill_id || '',
            standard_name: s.standard_name || s.name,
            category: s.category || '',
            level: s.level || '',
          });
        }
      }
      // learning_plans 表无 keyword 列，作业名优先取 row.job（真源列）/ data.job / data.skillTree.job
      const goal = (row && row.job) || (data && (data.job || (data.skillTree && data.skillTree.job) || data.goal)) || '';
      // totalDays 以「系统真实设定的天数」为唯一真源：优先用整体路线生成时设定的 days
      // （data.days / 表列 row.days，二者应一致），不再用 target_date 重新推导，避免与目标日
      // 边界/日期覆盖差 1~2 天导致每日切分天数与系统设定不符。缺省再回退 target_date 推导。
      const storedDays = Number(data && data.days) || Number(row && row.days) || 0;
      const profTd = getProfile(userId);
      const tdDays = deriveDays(profTd);
      const totalDays = (Number.isInteger(storedDays) && storedDays >= 1) ? storedDays
        : ((Number.isInteger(tdDays) && tdDays >= 1) ? tdDays : 0);
      return { planId: resolvedPlanId, goal, totalDays, stages, skills };
    }
    function safeParseJSON(str, fallback) {
      try { return JSON.parse(str); } catch { return fallback; }
    }

    // 生成每日学习计划（按 targetDays 代码拆分为 Day1..DayN）
    if (pathname === '/api/daily-plan/generate' && req.method === 'POST') {
      const userId = requireUserId(req, res); if (!userId) return;
      const b = await readBody(req).catch(() => ({}));
      // planId 可选：缺省时使用该用户当前生效的学习计划
      const planId = String(b.planId || '').trim() || buildPlanId(userId);
      // 用户每日可投入时长："2h" / "90m" / 120，缺省 2h
      const dailyStudyTime = b.dailyStudyTime ?? b.daily_study_time ?? '2h';

      const prof = getProfile(userId);
      const startDate = prof?.startDate || null;
      const stagePlan = loadStagePlanForDaily(userId, planId);
      if (!stagePlan) return sendJson(res, 404, { error: '未找到对应的阶段计划，请先生成阶段计划', code: 'NO_STAGE_PLAN' });

      // targetDays 缺省时，优先用整体路线「系统真实设定的天数」(stagePlan.totalDays)，
      // 不再用 target_date 重新推导，确保每日切分天数与生成计划时设定的天数一致。
      let days = Number(b.targetDays);
      let targetSource = 'explicit';
      if (!Number.isInteger(days) || days < 1) {
        // 优先用 profile 统一真源（含首尾），与生成 plan 时一致；回退到落库的 plan.totalDays
        const derived = deriveDays(prof);
        if (Number.isInteger(derived) && derived >= 1) {
          days = derived;
          targetSource = 'profile_derived';
        } else if (Number.isInteger(stagePlan.totalDays) && stagePlan.totalDays >= 1) {
          days = stagePlan.totalDays;
          targetSource = 'plan_days';
        } else {
          if (!derived) return sendJson(res, 400, { error: '未设置目标日，无法自动推导学习天数；请先设置投递目标日期', code: 'NO_TARGET_DATE' });
          days = derived;
          targetSource = 'target_date';
        }
      }

      let result;
      try {
        // 关键：纯代码生成，无任何 LLM 调用；只拆分已有资源，不依赖 skill 重新匹配
        result = dailyPlanGenerator.generateDailyPlan({
          stagePlan,
          targetDays: days,
          dailyStudyTime,
        });
      } catch (e) {
        return sendJson(res, 400, { error: e.message || '生成每日计划失败', code: e.code || 'GEN_FAILED' });
      }

      // 清空该用户全部每日任务（「学习路线更新后，将所有每日任务全部清除」），
      // 再根据新计划的阶段天数重新切片规划，避免任何旧计划/旧切片残留。
      db.prepare('DELETE FROM daily_learning_tasks WHERE user_id = ?').run(userId);
      // 同步清空 daily_tasks 旧表残留行：否则旧日期（如早于 startDate）的错位行会残留，
      // 导致 Dashboard「今日任务」天数口径与学习计划（data.days）不统一。
      db.prepare('DELETE FROM daily_tasks WHERE user_id = ?').run(userId);
      const now = Date.now();
      let _dltCount = 0;
      for (const t of result.dailyTasks) {
        try {
        db.prepare(`
          INSERT INTO daily_learning_tasks
            (user_id, plan_id, day_number, stage, skill_id, skill_name, skill_category, skill_level, focus, video_info, pdf_info, estimated_time, status, created_at, task_date, original_day, adjusted_day, estimated_minutes, reschedule_count, adjust_reason)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          userId,
          planId,
          t.day,
          t.stage,
          t.skill?.skill_id || '',
          t.skill?.standard_name || '',
          t.skill?.category || '',
          t.skill?.level || '',
          t.focus || '',
          JSON.stringify(t.resources?.video || []),
          JSON.stringify(t.resources?.pdf || []),
          t.estimatedTime || '',
          'pending',
          now,
          computeTaskDate(startDate, t.day),
          t.day,
          t.day,
          parseMinutes(t.estimatedTime),
          0,
          null
        );
        _dltCount++;
        } catch (e) {
          console.error('[daily-plan/generate] INSERT daily_learning_tasks 失败 day=' + t.day + ':', e?.message || e);
        }
      }
      console.log('[daily-plan/generate] 写入 daily_learning_tasks 行数=' + _dltCount + ' planId=' + planId + ' userId=' + userId);
      // 同步当日任务到 daily_tasks 旧表（Dashboard「今日任务列表」读取源），
      // 让新切分计划的第一天覆盖旧残留记录，保证前端列表与生成计划一致。
      try {
        const todayStr = localDateStr();
        const day1Tasks = result.dailyTasks.filter((t) => t.day === 1);
        const syncedTasks = [];
        let syncIdx = 0;
        for (const t of day1Tasks) {
          // 视频任务
          const vids = Array.isArray(t.resources?.video) ? t.resources.video : [];
          for (const v of vids) {
            const firstPart = Array.isArray(v.parts) && v.parts.length ? v.parts[0] : null;
            const partLabel = firstPart
              ? `${firstPart.part || ''} ${firstPart.partTitle || ''}`.trim()
              : (v.part || '');
            const chapterList = Array.isArray(v.parts)
              ? v.parts.map((p) => `${p.part || ''} ${p.partTitle || ''}`.trim()).filter(Boolean)
              : (v.part ? [v.part] : []);
            syncIdx += 1;
            syncedTasks.push({
              id: `day-1-task-${syncIdx}`,
              type: 'video',
              title: `观看视频「${v.title || '今日视频'}」${partLabel ? ' · ' + partLabel : ''}`,
              detail: t.focus || '',
              skill: t.skill?.standard_name || t.skill_name || '',
              est_min: Number(String(t.estimatedTime || '').replace(/[^0-9]/g, '')) || 60,
              done: false,
              link: v.link || v.url || '',
              chapters: chapterList,
              pdf: null,
            });
          }
          // PDF 任务（关键修复：之前漏边的 PDF 现在也并入今日任务列表）
          const pdfs = Array.isArray(t.resources?.pdf) ? t.resources.pdf : [];
          for (const p of pdfs) {
            syncIdx += 1;
            syncedTasks.push({
              id: `day-1-task-${syncIdx}`,
              type: 'pdf',
              title: `阅读 PDF「${p.title || '今日资料'}」${p.chapter ? ' · ' + p.chapter : ''}`,
              detail: t.focus || '',
              skill: t.skill?.standard_name || t.skill_name || '',
              est_min: Number(String(t.estimatedTime || '').replace(/[^0-9]/g, '')) || 60,
              done: false,
              link: p.link || '',
              chapters: p.chapter ? [p.chapter] : [],
              pdf: { docId: p.docId || '', link: p.link || '', pages: p.pages || '' },
            });
          }
        }
        if (syncedTasks.length) {
          const payload = JSON.stringify(syncedTasks);
          db.prepare(`
            INSERT INTO daily_tasks (user_id, task_date, plan_index, keyword, tasks, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id, task_date) DO UPDATE SET
              plan_index = excluded.plan_index,
              keyword = excluded.keyword,
              tasks = excluded.tasks,
              updated_at = excluded.updated_at
          `).run(userId, todayStr, 0, '', payload, now, now);
        }
      } catch (syncErr) {
        console.warn('[daily-plan/generate] 同步 daily_tasks 失败（不影响主流程）:', syncErr?.message || syncErr);
      }

      return sendJson(res, 200, {
        planId,
        targetDays: days,
        targetSource,
        dailyMinutes: result.dailyMinutes,
        contentTrimmed: result.contentTrimmed,
        totalVideoUnits: result.totalVideoUnits,
        totalPdfUnits: result.totalPdfUnits,
        stageDayAllocation: result.stageDayAllocation,
        dailyTasks: result.dailyTasks,
      });
    }

    // —— 工具：把一天的任务行展开为「独立子任务」列表（每个视频分P / PDF 章节为一个可单独打卡的单位）——
    // 子任务 id 编码为 `${dayTaskId}__${kind}__${index}`，前端打卡时回传此 id，后端解码。
    const decodeTaskId = (taskId) => {
      if (typeof taskId !== 'string' || !taskId.includes('__')) return null;
      const [dayStr, kind, idxStr] = taskId.split('__');
      const dayTaskId = Number(dayStr);
      const index = Number(idxStr);
      if (!Number.isInteger(dayTaskId) || dayTaskId < 1) return null;
      if (kind !== 'video' && kind !== 'pdf') return null;
      if (!Number.isInteger(index) || index < 0) return null;
      return { dayTaskId, kind, index };
    };
    const expandDayRow = (row) => {
      const { videos, pdfs } = parseResourceInfo(row);
      const tasks = [];
      videos.forEach((v, i) => tasks.push({
        id: `${row.id}__video__${i}`,
        title: v.title || (v.url ? `视频 ${v.url}` : `视频 ${i + 1}`),
        type: 'video',
        status: v.done ? 'completed' : 'pending',
        resource: v,
      }));
      pdfs.forEach((p, i) => tasks.push({
        id: `${row.id}__pdf__${i}`,
        title: p.title || (p.docId ? `PDF ${p.docId}` : `PDF ${i + 1}`),
        type: 'pdf',
        status: p.done ? 'completed' : 'pending',
        resource: p,
      }));
      return tasks;
    };
    const resourceKeyOf = (kind, res) => {
      if (!res) return '';
      if (kind === 'video') {
        // 优先用原始链接/标识；真实 B站数据可能同时有 url/link/bvid，放宽匹配
        const key = res.url || res.link || res.bvid || res.cid || '';
        return `video:${key}:${res.part || res.page || res.p || ''}`;
      }
      const doc = res.docId || res.doc_id || res.id || res.cid || res.url || res.link || '';
      const sec = res.section || res.range || res.chapter || res.page || '';
      return `pdf:${doc}:${sec}`;
    };
    const dedupeResourceJson = (raw, kind) => {
      const arr = safeParseJSON(raw, []);
      if (!Array.isArray(arr)) return '[]';
      const seen = new Set();
      return JSON.stringify(arr.filter((item) => {
        const key = resourceKeyOf(kind, item);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      }));
    };

    // 单资源打卡：完成当天的某一个独立学习任务（视频分P / PDF 章节）
    // 仅标记该资源完成，并写入 daily_task_completions（真实学习行为日志）。
    // 不要求完成全部任务即可打卡；可多次对不同资源打卡。
    if (pathname === '/api/daily-task/checkin' && req.method === 'POST') {
      const userId = requireUserId(req, res); if (!userId) return;
      const b = await readBody(req).catch(() => ({}));
      const decoded = decodeTaskId(b.taskId);
      if (!decoded) return sendJson(res, 400, { error: 'taskId 格式无效，应为 dayTaskId__kind__index' });
      const { dayTaskId, kind, index } = decoded;

      const row = db.prepare('SELECT * FROM daily_learning_tasks WHERE id = ? AND user_id = ?').get(dayTaskId, userId);
      if (!row) return sendJson(res, 404, { error: '未找到该每日任务', code: 'TASK_NOT_FOUND' });

      const col = kind === 'video' ? 'video_info' : 'pdf_info';
      const arr = safeParseJSON(row[col], []);
      if (!Array.isArray(arr) || arr.length === 0) return sendJson(res, 400, { error: '该任务暂无子资源' });
      // 定位要标记的子任务：优先用前端回传的资源指纹（url/part/docId/section/title）在「原行数组」中精确匹配，
      // 否则回退到 taskId 携带的 index。原因：今日任务经「重排预览」展开后数量/顺序可能和数据库原行不一致
      // （重排仅 dry-run 未持久化），若直接按 index 取 arr[index] 会越界导致打卡静默失败、任务无法勾选。
      let targetIndex = -1;
      if (b.resource) {
        const want = resourceKeyOf(kind, b.resource);
        targetIndex = arr.findIndex((it) => resourceKeyOf(kind, it) === want);
      }
      if (targetIndex < 0) targetIndex = index < arr.length ? index : -1;
      if (targetIndex < 0) return sendJson(res, 400, { error: '子任务索引越界' });
      const target = arr[targetIndex];
      if (!target.done) {
        target.done = true;
        db.prepare(`UPDATE daily_learning_tasks SET ${col} = ? WHERE id = ?`).run(JSON.stringify(arr), dayTaskId);
      }

      // 写入完成日志（增量式：每次只把「本次打卡的这个资源」追加写入，
      // 不再 DELETE 当天旧记录再整体重写，避免多次单资源提交互相覆盖导致漏写）。
      // 归属日期用 day 行自身的计划日期 task_date，与「生成笔记」按 date 查询严格一致，
      // 不再依赖 todayDateStr()（避免系统时钟/测试模式日期漂移导致打卡写错日期）。
      const date = row.task_date || todayDateStr();
      const insertStmt = db.prepare(`
        INSERT OR IGNORE INTO daily_task_completions (user_id, task_id, date, resource_type, resource_key, resource_info, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      // 重新读取最新行（target.done 已置 true），供 allDone 判断与返回汇总使用
      const refreshedRow = db.prepare('SELECT * FROM daily_learning_tasks WHERE id = ?').get(dayTaskId);
      const { videos: videoArr, pdfs: pdfArr } = parseResourceInfo(refreshedRow);
      // 仅写入本次打卡命中的那一个资源（target.done 已置 true），绝不碰其它已打卡资源
      const rk = resourceKeyOf(kind, target);
      const info = {
        url: target.url || '',
        part: target.part || '',
        page: target.page || '',
        docId: target.docId || '',
        title: target.title || '',
        section: target.section || target.range || target.chapter || '',
        // 计划可能已带精确片范围；存下供笔记生成按 chunkFrom/chunkTo 切片，避免每天重复读开头
        segment: target.segment || null,
      };
      insertStmt.run(userId, dayTaskId, date, kind, rk, JSON.stringify(info), Date.now());

      // 当天所有资源都完成时，把 day 行整体标记 completed（仅作汇总状态，不影响打卡）
      const allDone = [...videoArr, ...pdfArr].every((x) => x && x.done);
      if (videoArr.length + pdfArr.length > 0 && allDone) {
        db.prepare("UPDATE daily_learning_tasks SET status = 'completed' WHERE id = ?").run(dayTaskId);
      }

      // 返回当天汇总（务必用写入 done 之后的最新行，避免返回旧快照导致前端状态不一致）
      const completedTasks = expandDayRow(refreshedRow).map((t) => ({ id: t.id, type: t.type, status: t.status }));
      return sendJson(res, 200, {
        taskId: b.taskId,
        completedCount: completedTasks.filter((t) => t.status === 'completed').length,
        totalCount: completedTasks.length,
        completedTasks,
      });
    }

    // 取消完成：撤销单个资源（视频分P / PDF 章节）的当日打卡完成态
    if (pathname === '/api/daily-task/uncheckin' && req.method === 'POST') {
      const userId = requireUserId(req, res); if (!userId) return;
      const b = await readBody(req).catch(() => ({}));
      const decoded = decodeTaskId(b.taskId);
      if (!decoded) return sendJson(res, 400, { error: 'taskId 格式无效，应为 dayTaskId__kind__index' });
      const { dayTaskId, kind, index } = decoded;

      const row = db.prepare('SELECT * FROM daily_learning_tasks WHERE id = ? AND user_id = ?').get(dayTaskId, userId);
      if (!row) return sendJson(res, 404, { error: '未找到该每日任务', code: 'TASK_NOT_FOUND' });

      const col = kind === 'video' ? 'video_info' : 'pdf_info';
      const arr = safeParseJSON(row[col], []);
      if (!Array.isArray(arr) || arr.length === 0) return sendJson(res, 400, { error: '该任务暂无子资源' });
      // 与 checkin 一致：优先用资源指纹匹配原行元素，回退 index，避免重排预览与原行不一致导致越界。
      let targetIndex = -1;
      if (b.resource) {
        const want = resourceKeyOf(kind, b.resource);
        targetIndex = arr.findIndex((it) => resourceKeyOf(kind, it) === want);
      }
      if (targetIndex < 0) targetIndex = index < arr.length ? index : -1;
      if (targetIndex < 0) return sendJson(res, 400, { error: '子任务索引越界' });
      const target = arr[targetIndex];
      if (target.done) {
        target.done = false;
        db.prepare(`UPDATE daily_learning_tasks SET ${col} = ? WHERE id = ?`).run(JSON.stringify(arr), dayTaskId);
      }

      // 归属日期与 checkin 保持一致（含测试/日期覆盖）。增量撤销：只删除「本次取消的这个资源」
      // 对应的完成日志，不再整体覆盖重写，避免多人/多次打卡互相干扰，也避开 expandDayRow 的 status 映射坑。
      const date = row.task_date || todayDateStr();
      const rk = resourceKeyOf(kind, target);
      db.prepare(
        'DELETE FROM daily_task_completions WHERE user_id = ? AND date = ? AND task_id = ? AND resource_key = ?'
      ).run(userId, date, dayTaskId, rk);

      // 若该行仍有未完成资源，撤销整行的汇总 completed 状态（仅汇总态，不影响其它逻辑）
      const allTasks = expandDayRow(db.prepare('SELECT * FROM daily_learning_tasks WHERE id = ?').get(dayTaskId));
      if (allTasks.length && !allTasks.every((t) => t.status === 'completed')) {
        db.prepare("UPDATE daily_learning_tasks SET status = 'pending' WHERE id = ?").run(dayTaskId);
      }

      const completedTasks = expandDayRow(row).map((t) => ({ id: t.id, type: t.type, status: t.status }));
      return sendJson(res, 200, {
        taskId: b.taskId,
        completedCount: completedTasks.filter((t) => t.status === 'completed').length,
        totalCount: completedTasks.length,
        completedTasks,
      });
    }

    // 清空今日打卡内容 + 重置今日生成笔记（按当天 date，跟随测试模式 testDate）
    if (pathname === '/api/daily-task/reset-today' && req.method === 'POST') {
      const userId = requireUserId(req, res); if (!userId) return;
      const planId = buildPlanId(userId);
      const date = todayDateStr();
      const tables = db.state.tables;

      // 1) 清除今日 daily_learning_tasks 行里所有子任务的 done 标记（即清空打卡内容）
      let resetTaskRows = 0;
      for (const row of tables.daily_learning_tasks) {
        if (row.user_id !== userId || row.plan_id !== planId) continue;
        if (row.task_date !== date) continue;
        const clearDone = (col) => {
          const arr = safeParseJSON(row[col], []);
          if (!Array.isArray(arr)) return;
          let changed = false;
          for (const it of arr) {
            if (it && it.done) { it.done = false; changed = true; }
          }
          if (changed) row[col] = JSON.stringify(arr);
        };
        const before = row.status;
        clearDone('video_info');
        clearDone('pdf_info');
        if (before && before !== 'pending') row.status = 'pending';
        resetTaskRows++;
      }

      // 2) 删除今日完成日志（清空打卡统计）
      const completionsBefore = tables.daily_task_completions.length;
      tables.daily_task_completions = tables.daily_task_completions.filter(
        (r) => !(r.user_id === userId && r.date === date)
      );
      const clearedCompletions = completionsBefore - tables.daily_task_completions.length;

      // 3) 删除今日生成笔记 + 重置生成次数限制（可重新生成）
      const notesBefore = tables.learning_notes.length;
      tables.learning_notes = tables.learning_notes.filter(
        (r) => !(r.user_id === userId && r.note_date === date)
      );
      const clearedNotes = notesBefore - tables.learning_notes.length;

      const genBefore = tables.note_generation_records.length;
      tables.note_generation_records = tables.note_generation_records.filter(
        (r) => !(r.user_id === userId && r.note_date === date)
      );
      const clearedGenerationRecords = genBefore - tables.note_generation_records.length;

      db.save();

      return sendJson(res, 200, {
        ok: true,
        date,
        resetTaskRows,
        clearedCompletions,
        clearedNotes,
        clearedGenerationRecords,
      });
    }

    // 获取「今日」学习任务状态（含每个独立子任务完成状态、完成数、笔记可生成信息）
    if (pathname === '/api/daily-task/today' && req.method === 'GET') {
      const userId = requireUserId(req, res); if (!userId) return;
      const planId = buildPlanId(userId);
      const date = todayDateStr();
      // 今日对应的 day 行：优先取 task_date == 今天；否则取第一个正式日（day>=1）
      // 注：JSON 后端未实现 task_date=? LIMIT 1 查询，这里取全部后按 task_date 过滤（兼容两种存储）
      const rows = db.prepare(
        'SELECT * FROM daily_learning_tasks WHERE user_id = ? AND plan_id = ? ORDER BY day_number ASC'
      ).all(userId, planId);
      const formal = rows.filter((r) => (r.day_number ?? 0) >= 1);
      // 优先精确匹配 task_date（兼容已正确写入 task_date 的存储）
      let row = formal.find((r) => r.task_date === date) || null;
      // 兜底：task_date 缺失/被污染时，按「学习基准日 + 相对 day_number 偏移」定位当天行，
      // 使测试模式切换日期也能正确显示对应某一天的任务（不再一律 fallback 到 day 1）。
      if (!row && formal.length) {
        const prof = getProfile(userId);
        // 基准日优先级：profile.startDate > 首个带 task_date 的行 > 服务器真实今天（视为 day 1 基准）
        const dated = formal.find((r) => r.task_date);
        const baseDate = prof?.startDate || (dated && dated.task_date) || localDateStr();
        const baseDay = (dated && dated.day_number) || formal[0].day_number || 1;
        row = formal.find((r) => computeTaskDate(baseDate, (r.day_number ?? 0) - baseDay) === date) || null;
        // 仍然找不到（如 date 落在计划范围之外）时，退回到 Day1，保证页面有内容
        if (!row) row = formal[0];
      }
      if (!row) return sendJson(res, 200, { date, tasks: [], completedCount: 0, totalCount: 0, noteGenerateCount: 0, canGenerateNote: false });
      let tasks = expandDayRow(row);
      let completedCount = tasks.filter((t) => t.status === 'completed').length;
      let totalCount = tasks.length;
      const genRows = db.prepare('SELECT COUNT(*) AS c FROM note_generation_records WHERE user_id = ? AND note_date = ?').get(userId, date);
      const noteGenerateCount = genRows ? genRows.c : 0;
      const canGenerateNote = completedCount > 0 && noteGenerateCount < 2;

      // 动态计划调整：做「是否需要调整」的探测（dry-run），只用于给前端提示，不改变数据库，
      // 避免每次打开今日页都写回重排结果导致子任务在每日行里反复累积重复。
      const preview = dailyPlanAdjuster.adjustPlan({ tasks: rows, today: date });

      // 风险探测：剩余任务量 / 剩余天数 → 每日负荷是否超承受能力（不改状态）
      const profRisk = getProfile(userId);
      let riskInfo = null;
      let stageInfo = null;
      let settlementInfo = null;
      // settlement（含「连续三天未完成」风险横幅）不依赖 targetDate，始终计算；
      // riskInfo / stageInfo 依赖 targetDate，仅在有目标日期时计算。
      settlementInfo = await dailyPlanScheduler.runDailySettlement({
        tasks: rows, today: date,
        dailyCapacityMinutes: dailyCapacityMinutesOf(profRisk), targetDate: profRisk?.targetDate || null, startDate: profRisk?.startDate,
      });
      if (profRisk?.targetDate) {
        riskInfo = dailyPlanAdjuster.computeRisk({
          tasks: rows, targetDate: profRisk.targetDate,
          dailyCapacityMinutes: dailyCapacityMinutesOf(profRisk), today: date, startDate: profRisk.startDate,
        });
        stageInfo = dailyPlanAdjuster.stageProgress({ tasks: rows });
      }

      // ============ 日期刷新时整体重排（规则八升级） ============
      // 设计：重排只发生在「日期刷新」那一刻（自然跨天 / 测试模式切日期），不在勾选/完成任务的时刻。
      // 进入新的一天时，对「当天及之后」重排：之前所有未完成（欠账）+ 当天及之后未完成任务，
      // 均匀分配到「当天 → 之后」；之前的天数计划冻结不变；已完成任务打标区分、原地保留、不重复累积。
      //
      // 关键守卫：仅在「本次查询日期 相对 上次自动重排日期 发生了变化」时才落库一次，
      // 避免 today 接口被勾选/刷新反复触发导致当天任务越积越多。
      // 用 profiles.last_reschedule_date 记录上次已重排的日期，跨天/切日期即触发一次。
      const reschedFormal = rows.filter((r) => (r.day_number ?? 0) >= 1);
      const reschedFromRow = reschedFormal.find((r) => r.task_date === date)
        || reschedFormal.find((r) => (r.task_date || '') >= date);
      const reschedFromDayNum = reschedFromRow ? reschedFromRow.day_number : (reschedFormal[0]?.day_number || 1);
      // 目标日之前（day_number < fromDayNum）是否存在未完成子任务 = 真实欠账
      const hasPrevOverdue = reschedFormal.some((r) => {
        if ((r.day_number ?? 0) >= reschedFromDayNum) return false;
        return expandDayRow(r).some((t) => t.status !== 'completed');
      });
      // 仅当「非第一天」且「存在真实欠账」且「日期相对上次重排发生变化」才落库重排一次
      const profForResched = getProfile(userId);
      const lastReschedDate = profForResched?.last_reschedule_date || null;
      const dateChanged = lastReschedDate !== date;
      const allowAutoReschedule = reschedFromDayNum > 1 && hasPrevOverdue && dateChanged;
      const resched = allowAutoReschedule
        ? dailyPlanAdjuster.rescheduleWithinStage({ tasks: rows, fromDate: date, today: date, dailyCapacityMinutes: dailyCapacityMinutesOf(profRisk) })
        : { changed: false, reason: (reschedFromDayNum <= 1 ? '第一天，跳过自动重排' : (!dateChanged ? '当日已重排过，跳过' : '非欠账状态，跳过自动重排')), adjustments: [], days: rows };
      if (resched && resched.changed && resched.days && resched.days.length) {
        const byDay = new Map(resched.days.map((r) => [r.day_number, r]));
        for (const r of rows) {
          const nr = byDay.get(r.day_number);
          if (nr) {
            r.task_date = nr.task_date ?? r.task_date;
            r.status = nr.status ?? r.status;
            r.focus = nr.focus ?? r.focus;
            r.video_info = nr.video_info ?? r.video_info;
            r.pdf_info = nr.pdf_info ?? r.pdf_info;
            r.stage = nr.stage ?? r.stage;
            r.skill_name = nr.skill_name ?? r.skill_name;
            r.adjustedDay = nr.adjustedDay ?? r.adjustedDay;
            r.originalDay = nr.originalDay ?? r.originalDay;
            r.reschedule_count = (r.reschedule_count ?? 0) + 1;
            r.adjust_reason = nr.adjust_reason ?? r.adjust_reason;
            // rescheduleWithinStage 返回的是副本；必须把完整资源字段写回数据库，
            // 否则 /today 展示了新资源，但随后 /checkin 仍从旧行读取，导致“任务可见但无法打卡”。
            db.prepare(`
              UPDATE daily_learning_tasks
              SET stage = ?, skill_id = ?, skill_name = ?, skill_category = ?, skill_level = ?, focus = ?,
                  video_info = ?, pdf_info = ?, estimated_time = ?, status = ?, updated_at = ?, original_day = ?,
                  adjusted_day = ?, estimated_minutes = ?, reschedule_count = ?, adjust_reason = ?, adjust_reason_type = ?, adjust_reason_detail = ?
              WHERE user_id = ? AND plan_id = ? AND day_number = ?
            `).run(
              r.stage || '', r.skill_id || '', r.skill_name || '', r.skill_category || '', r.skill_level || '', r.focus || '',
              dedupeResourceJson(r.video_info, 'video'), dedupeResourceJson(r.pdf_info, 'pdf'), r.estimated_time || '2h', r.status || 'pending', Date.now(),
              r.original_day ?? r.day_number, r.adjusted_day ?? r.day_number, r.estimated_minutes || 0, r.reschedule_count || 0,
              r.adjust_reason || null, r.adjust_reason_type || 'missed_task', r.adjust_reason_detail || r.adjust_reason || null,
              userId, planId, r.day_number
            );
            const persisted = (db.state.tables.daily_learning_tasks || []).find((x) => x.user_id === userId && x.plan_id === planId && x.day_number === r.day_number);
            if (persisted) { persisted.task_date = r.task_date || persisted.task_date || null; db.save(); }
          }
        }
        // 记录本次已重排日期，防止当日重复落库（勾选/刷新不再触发）
        try {
          db.prepare('UPDATE profiles SET last_reschedule_date = ? WHERE user_id = ?').run(date, userId);
          profForResched.last_reschedule_date = date;
        } catch (e) { console.warn('[daily-task/today] 记录重排日期失败:', e?.message || e); }
        db.save();
        // 重排后重新定位「今日」行，保证返回最新计划
        // 注意：JSON 数据库的 db.prepare().all() 返回的是深拷贝副本，内存中修改 rows 不会
        // 回写到 save() 的内部 state，因此必须以「重排后的权威结果 resched.days」定位今日行，
        // 而非重新查库（否则重排结果不生效，表现为欠账未顺延/断层）。
        // 今日行即「目标日对应的 day_number」（reschedFromDayNum）在重排结果中的那一行。
        const reDayRows = resched.days.filter((d) => (d.day_number ?? 0) >= 1);
        reDayRows.forEach((d) => {
          d.video_info = dedupeResourceJson(d.video_info, 'video');
          d.pdf_info = dedupeResourceJson(d.pdf_info, 'pdf');
        });
        // 纯函数 buildDayRow 生成的行不带 id，会导致 expandDayRow 把任务编码成 `undefined__video__0`，
        // 前端回传该 id 后后端 WHERE id='undefined' 查不到 → 打卡永远失败、任务无法勾选划掉。
        // 因此按 day_number 把原行的真实 id 回填到重排结果，保证任务 id 可定位到具体行。
        const rowIdByDay = new Map(rows.map((r) => [r.day_number, r.id]));
        reDayRows.forEach((d) => { if (d.id == null) d.id = rowIdByDay.get(d.day_number); });
        const reRow = reDayRows.find((r) => r.day_number === reschedFromDayNum) || reDayRows[0];
        row = reRow;
        tasks = expandDayRow(reRow);
        completedCount = tasks.filter((t) => t.status === 'completed').length;
        totalCount = tasks.length;
      }
      // 原因文案：由于前一天任务未完成，所有当天任务已动态重排（系统自动执行，无需用户确认）
      const autoReason = (resched && resched.changed)
        ? '由于前一天任务未完成，所有当天任务已动态重排'
        : (preview.changed ? preview.reason : '无需调整');

      return sendJson(res, 200, {
        date,
        day: row.day_number,
        skillName: row.skill_name,
        tasks,
        completedCount,
        totalCount,
        noteGenerateCount,
        canGenerateNote,
        adjustment: (resched && resched.changed)
          ? { needed: true, reason: autoReason, adjustments: resched.adjustments, originalDay: resched.adjustments[0]?.originalDay, auto: true }
          : { needed: false, reason: autoReason, auto: true },
        risk: riskInfo,
        stage: stageInfo,
        settlement: settlementInfo,
      });
    }

    // 查询笔记生成实时进度（前端轮询，展示进度条 + 各模块耗时）
    if (pathname === '/api/learning-note/progress' && req.method === 'GET') {
      const userId = requireUserId(req, res);
      if (!userId) return;
      const url = new URL(req.url, 'http://localhost');
      const date = url.searchParams.get('date') || todayDateStr();
      const prog = noteProgressMap.get(`${userId}:${date}`) || null;
      return sendJson(res, 200, { progress: prog });
    }

    // 生成「今日」学习笔记：仅基于当天已完成的资源，每天最多 2 次，第2次覆盖第1次
    if (pathname === '/api/learning-note/generate' && req.method === 'POST') {
      const userId = requireUserId(req, res);
      if (!userId) return;
      // —— 进度/计时埋点：生成期间持续写入 noteProgressMap，前端轮询 /api/learning-note/progress 拿真实进度 ——
      // key = `${userId}:${date}`；timings 记录各模块耗时（毫秒），便于定位瓶颈、指导下一步优化。
      // 先确定 date：优先 body.date，否则回退 todayDateStr()；必须在 progKey 之前声明，避免 TDZ 引用错误。
      const b0 = await readBody(req).catch(() => ({}));
      const date = (b0.date && typeof b0.date === 'string') ? b0.date : todayDateStr();
      const progKey = `${userId}:${date}`;
      const t0 = Date.now();
      const timings = { prepare: 0, videoExtract: 0, pdfExtract: 0, llmGenerate: 0, save: 0 };
      const setProgress = (stage, percent, label) => {
        noteProgressMap.set(progKey, { stage, percent, label, startedAt: t0, updatedAt: Date.now(), timings });
      };
      setProgress('prepare', 5, '准备生成环境…');
      // 整体 DDL 守卫：NOTE_TIMEOUT_MS（默认 600000=10分钟）内若仍未完成，记日志 + 确保进度清理。
      // 不主动中断 await 中的子调用（避免双发响应），仅作超时告警；单步 QWEN_TIMEOUT_MS 已保证不会永久挂起。
      const noteDdl = Number(process.env.NOTE_TIMEOUT_MS) || 600000;
      const ddlTimer = setTimeout(() => {
        console.warn('[learning-note/timeout] 生成超过 DDL', noteDdl, 'ms，key=', progKey, '当前进度:', JSON.stringify(noteProgressMap.get(progKey) || null));
      }, noteDdl);
      ddlTimer.unref?.();
      try {

      // 1) 次数限制：每天最多 2 次
      const genRows = db.prepare('SELECT COUNT(*) AS c FROM note_generation_records WHERE user_id = ? AND note_date = ?').get(userId, date);
      const genCount = genRows ? genRows.c : 0;
      if (genCount >= 2) {
        return sendJson(res, 429, { error: '今日学习笔记生成次数已达到上限（每天最多 2 次）', code: 'NOTE_LIMIT_REACHED' });
      }

      // 2) 取当天已完成资源（来源：daily_task_completions）
      let completions = db.prepare(
        'SELECT * FROM daily_task_completions WHERE user_id = ? AND date = ? ORDER BY completed_at ASC'
      ).all(userId, date);

      // 2.1) 回退：daily_task_completions 可能因为测试模式日期漂移/历史脏数据而缺失，
      //      此时以「当天 daily_learning_tasks 中已完成的资源」作为权威依据，并补记 completion 行，
      //      保证「任务已完成」与「已打卡」语义统一（与 /api/daily-task/today 一致）。
      if (!completions.length) {
        const planId = buildPlanId(userId);
        // 与 /api/daily-task/today 保持一致的当天行定位：
        // 优先 task_date 精确匹配，否则按「基准日 + day_number 偏移」兜底（兼容 task_date 缺失/被污染的历史数据）。
        const allRows = (db.state.tables.daily_learning_tasks || []).filter(
          (r) => r.user_id === userId && r.plan_id === planId
        );
        const formalRows = allRows.filter((r) => (r.day_number ?? 0) >= 1);
        let dayRow = formalRows.find((r) => r.task_date === date) || null;
        if (!dayRow && formalRows.length) {
          const prof = getProfile(userId);
          const dated = formalRows.find((r) => r.task_date);
          const baseDate = prof?.startDate || (dated && dated.task_date) || localDateStr();
          const baseDay = (dated && dated.day_number) || formalRows[0].day_number || 1;
          dayRow = formalRows.find((r) => computeTaskDate(baseDate, (r.day_number ?? 0) - baseDay) === date) || formalRows[0];
        }
        const dayRows = dayRow ? [dayRow] : [];
        const fallback = [];
        const insertStmt = db.prepare(`
          INSERT OR IGNORE INTO daily_task_completions (user_id, task_id, date, resource_type, resource_key, resource_info, completed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        for (const row of dayRows) {
          const dayTasks = expandDayRow(row);
          for (const t of dayTasks) {
            if (t.status !== 'completed') continue;
            const rk = resourceKeyOf(t.type, t.resource);
            if (fallback.some((f) => f.resource_key === rk)) continue;
            const info = {
              url: t.resource.url || '',
              part: t.resource.part || '',
              docId: t.resource.docId || '',
              title: t.resource.title || '',
              section: t.resource.section || t.resource.range || t.resource.chapter || '',
            };
            const record = {
              user_id: userId, task_id: row.id, date,
              resource_type: t.type, resource_key: rk,
              resource_info: JSON.stringify(info), completed_at: Date.now(),
            };
            // 补记到打卡表，保证后续增量比对/统计一致
            insertStmt.run(userId, row.id, date, t.type, rk, JSON.stringify(info), Date.now());
            fallback.push(record);
          }
        }
        if (fallback.length) {
          completions = fallback;
        }
      }

      if (!completions.length) {
        noteProgressMap.delete(progKey);
        return sendJson(res, 400, { error: '今日尚无已完成的学习任务，无法生成笔记', code: 'NO_COMPLETION' });
      }
      timings.prepare = Date.now() - t0;

      // 3) 【增量核心】读取已有笔记，比对 source_tasks，只处理「本次新增完成」的资源。
      //    已经进过笔记的资源不再重新提取字幕 / 不再重新读 PDF chunk / 不再重新送入模型。
      const existing = db.prepare('SELECT * FROM learning_notes WHERE user_id = ? AND note_date = ?').get(userId, date);
      const oldNote = existing ? safeParseJSON(existing.content, null) : null;
      const oldSources = existing ? safeParseJSON(existing.source_tasks, []) : [];
      const processedKeys = new Set((Array.isArray(oldSources) ? oldSources : []).map((s) => s && s.key).filter(Boolean));
      const newCompletions = completions.filter((c) => !processedKeys.has(c.resource_key));

      if (existing && !newCompletions.length) {
        // 没有任何新增内容 → 不消耗任何 token，直接返回旧笔记，也不计入生成次数。
        return sendJson(res, 200, {
          note: {
            id: existing.id,
            title: existing.title,
            content: oldNote,
            generationCount: existing.generation_count || 1,
            noteDate: date,
            sourceTasks: oldSources,
          },
          incremental: true,
          newTaskCount: 0,
          unchanged: true,
          message: '没有发现新增的学习内容，笔记无需更新',
          canGenerateAgain: genCount < 2,
          remaining: Math.max(0, 2 - genCount),
        });
      }

      // 4) 组装本次生成的学习意图锚点（来自真实用户意图，不重新猜测）
      //    taskTitle：当天任务标题（或阶段/技能名兜底）
      //    skill：技能方向（daily_learning_tasks.skill_name）
      //    resourceTitles：本次已完成资源的标题集合
      let noteTaskTitle = '';
      let noteSkill = '';
      const firstTaskId = completions[0] && completions[0].task_id;
      if (firstTaskId) {
        const trow = db.prepare('SELECT * FROM daily_learning_tasks WHERE id = ?').get(firstTaskId);
        if (trow) {
          noteSkill = String(trow.skill_name || trow.skill_category || trow.stage || '').trim();
          // 任务标题优先用 focus（一般是"XX能力提升"之类），否则阶段名兜底
          noteTaskTitle = String(trow.focus || trow.stage || noteSkill || '').trim();
        }
      }
      const noteResourceTitles = newCompletions
        .map((c) => { const i = safeParseJSON(c.resource_info, {}); return i.title || ''; })
        .filter(Boolean);

      // 4.1) 只提取新增资源的内容（视频逐P过滤；PDF 仅取已完成 docId 的对应 chunk）
      const newSources = [];
      let note;
      if (isTestMode) {
        // —— 测试模式：不调用大模型、不提取真实字幕/PDF，直接基于当天已完成任务构造符合验收格式的 mock 笔记 ——
        const taskTitles = newCompletions.map((c) => {
          const info = safeParseJSON(c.resource_info, {});
          return info.title || c.resource_key || '任务';
        });
        note = {
          title: taskTitles[0] || '当天学习任务',
          subtitle: 'AI产品经理学习陪跑',
          summary: `本次学习围绕${taskTitles[0] || '当天学习任务'}展开，以下内容仅基于当天已完成的学习资源整理。\n\n本节掌握：\n${taskTitles.map((t) => `- ${t}`).join('\n')}`,
          key_points: taskTitles.map((t) => ({ name: t, definition: `当天完成的学习资源：${t}`, core作用: ['理解课程中的关键内容'], product_application: ['结合 AI 产品经理场景进行复述和应用'] })),
          mind_map: { root: taskTitles[0] || '当天学习主题', children: taskTitles.map((t) => ({ name: t, children: [] })) },
          user_note: '',
        };
        for (const c of newCompletions) {
          const info = safeParseJSON(c.resource_info, {});
          newSources.push({ type: c.resource_type, title: info.title || '', key: c.resource_key });
        }
      } else {
        let videoNotes = '';
        let pdfChunks = '';
        const videoJobs = newCompletions.filter((c) => c.resource_type === 'video');
        const pdfJobs = newCompletions.filter((c) => c.resource_type === 'pdf');
        const totalJobs = videoJobs.length + pdfJobs.length;
        let doneJobs = 0;
        const videoStart = Date.now();
        setProgress('extract', 15, `正在提取视频字幕（${videoJobs.length} 个视频）…`);
        // 视频资源：先逐P 抓取，再做相关性过滤（根治输入污染），只把相关P 拼进 LLM。
        // 过滤依据取自有真实用户意图的 task_title / skill / resource_title，不重新猜测。
        for (const c of videoJobs) {
          const info = safeParseJSON(c.resource_info, {});
          newSources.push({ type: 'video', title: info.title || '', key: c.resource_key });
          const partStr = info.part || '';
          const partSpec = parsePartSpec(partStr);
          if (partSpec.kind === 'range') {
            // 时间窗口（如 "24:22-48:44"）：一个P拆多天学 → 抓该P字幕后按时间窗裁剪，
            // 只把当天应学的时间段喂给大模型，避免跨天内容串味。
            const t = await extractBiliSubtitles(
              info.url,
              info.page ? String(info.page) : '',
              partSpec.rangeSec
            );
            if (t) videoNotes += `\n【视频 ${info.url || ''} ${partStr}】\n${t}\n`;
            doneJobs++;
            setProgress('extract', 15 + Math.round((doneJobs / Math.max(totalJobs, 1)) * 45), `正在提取视频字幕（${doneJobs}/${totalJobs}）…`);
            continue;
          }
          if (partSpec.kind === 'all') {
            // 未指定分P（整视频）→ 直接抓取整段，不过滤
            const t = await extractBiliSubtitles(info.url, '');
            if (t) videoNotes += `\n【视频 ${info.url || ''} ${partStr || ''}】\n${t}\n`;
            doneJobs++;
            setProgress('extract', 15 + Math.round((doneJobs / Math.max(totalJobs, 1)) * 45), `正在提取视频字幕（${doneJobs}/${totalJobs}）…`);
            continue;
          }
          // 分P 列表：逐P 相关性过滤（内部带缓存，重复生成不重算；边界才调 LLM）
          const partNums = partSpec.pages;
          const { keptParts } = await filterVideoPartsByRelevance({
            url: info.url,
            partList: partNums,
            taskTitle: noteTaskTitle,
            skill: noteSkill,
            resourceTitle: info.title || '',
          });
          for (const kp of keptParts) {
            videoNotes += `\n【视频 ${info.url || ''} P${kp.partNo}】\n${kp.text}\n`;
          }
          doneJobs++;
          setProgress('extract', 15 + Math.round((doneJobs / Math.max(totalJobs, 1)) * 45), `正在提取视频字幕（${doneJobs}/${totalJobs}）…`);
        }
        timings.videoExtract = Date.now() - videoStart;
        const pdfStart = Date.now();
        setProgress('extract', 60, `正在提取 PDF 资料（${pdfJobs.length} 个）…`);
        // PDF 资源：只取该 docId 对应范围的 chunk，禁止整本 PDF 输入。
        const pdfResults = await Promise.all(pdfJobs.map(async (c) => {
          const info = safeParseJSON(c.resource_info, {});
          newSources.push({ type: 'pdf', title: info.title || '', key: c.resource_key });
          const range = info.section || '';
          const c2 = getPdfChunks(info.docId, range, 40, info.segment || null);
          return c2 ? `\n【PDF ${info.docId || info.title || ''} ${range}】\n${c2}\n` : '';
        }));
        for (const r of pdfResults) pdfChunks += r;
        timings.pdfExtract = Date.now() - pdfStart;

        console.log('[learning-note/input]', JSON.stringify({
          userId, date, resourceCount: newCompletions.length,
          resources: newCompletions.map((c) => {
            const i = safeParseJSON(c.resource_info, {});
            return { type: c.resource_type, resourceKey: c.resource_key, docId: i.docId || '', videoId: i.bvid || i.url || '' };
          }), videoTextLength: videoNotes.length, pdfTextLength: pdfChunks.length,
        }));

        if (!videoNotes.trim() && !pdfChunks.trim()) {
          noteProgressMap.delete(progKey);
          return sendJson(res, 200, {
            warning: '新增完成任务的视频/PDF 暂无可提取的文本（可能无公开字幕或 PDF 未导入），本次未更新笔记。',
            note: oldNote ? { id: existing.id, title: existing.title, content: oldNote, generationCount: existing.generation_count || 1, noteDate: date, sourceTasks: oldSources } : null,
            canGenerateAgain: genCount < 2,
          });
        }

        // 5) 增量生成：oldNote 为空即首次全量；否则只把「新增材料 + 旧笔记结构化摘要」送入模型
        const llmStart = Date.now();
        setProgress('compose', 75, '正在调用大模型生成笔记结构…');
        try {
          note = await noteGenerator.generateNoteIncremental({ taskTitle: noteTaskTitle, skill: noteSkill, resourceTitles: noteResourceTitles, oldNote, videoNotes, pdfChunks });
          timings.llmGenerate = Date.now() - llmStart;
          console.log('[learning-note/output]', JSON.stringify({
            date, title: note?.title || '', summaryLength: String(note?.summary || '').length,
            keyPoints: Array.isArray(note?.key_points) ? note.key_points.length : 0,
            mindMapChildren: Array.isArray(note?.mind_map?.children) ? note.mind_map.children.length : 0,
            timings,
          }));
        } catch (e) {
          console.error('[learning-note/generate] note gen error:', e?.stack || e);
          noteProgressMap.delete(progKey);
          return sendJson(res, 500, { error: '笔记生成失败：' + (e.message || '未知错误') });
        }
      }

      // 6) 保存（同一天一份最终笔记；第2次生成覆盖 content，generation_count +1）
      setProgress('save', 92, '正在保存笔记…');
      const saveStart = Date.now();
      const now = Date.now();
      const d = new Date(date + 'T00:00:00');
      const month = d.getMonth() + 1;
      const day = d.getDate();
      const content = JSON.stringify(note);
      // source_tasks 累计：旧的 + 本次新增，作为下次增量比对的依据
      const mergedSources = [...(Array.isArray(oldSources) ? oldSources : []), ...newSources];
      // 阶段归属：取当天 day 行所属 stage，供 NovaForge 聚合
      const dayRow = db.prepare('SELECT * FROM daily_learning_tasks WHERE id = ?').get((completions[0] && completions[0].task_id) || 0);
      const stageId = dayRow ? String(dayRow.stage || '') : '';
      let noteId;
      const newGenCount = genCount + 1;
      if (existing) {
        db.prepare(`
          UPDATE learning_notes
          SET title = ?, content = ?, generation_count = ?, source_tasks = ?, updated_at = ?, month = ?, day = ?, stage_id = ?
          WHERE id = ?
        `).run(note.title, content, newGenCount, JSON.stringify(mergedSources), now, month, day, stageId, existing.id);
        noteId = existing.id;
      } else {
        const ins = db.prepare(`
          INSERT INTO learning_notes (user_id, task_id, stage, skill_id, skill_name, title, content, created_at, updated_at, note_date, month, day, generation_count, source_tasks, stage_id)
          VALUES (?, ?, '', '', '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const info = ins.run(userId, (completions[0] && completions[0].task_id) || 0, note.title, content, now, now, date, month, day, newGenCount, JSON.stringify(mergedSources), stageId);
        noteId = info.lastInsertRowid;
      }
      timings.save = Date.now() - saveStart;

      // 7) 记录本次生成（用于次数限制）
      db.prepare(`
        INSERT OR IGNORE INTO note_generation_records (user_id, note_date, generation_index, created_at)
        VALUES (?, ?, ?, ?)
      `).run(userId, date, newGenCount, now);

      const totalElapsed = Date.now() - t0;
      clearTimeout(ddlTimer);
      noteProgressMap.delete(progKey);
      return sendJson(res, 200, {
        note: { id: noteId, title: note.title, content: note, generationCount: newGenCount, noteDate: date, sourceTasks: mergedSources },
        incremental: Boolean(oldNote),
        newTaskCount: newSources.length,
        canGenerateAgain: newGenCount < 2,
        remaining: Math.max(0, 2 - newGenCount),
        timings,
        totalElapsedMs: totalElapsed,
      });
      } catch (e) {
        clearTimeout(ddlTimer);
        noteProgressMap.delete(progKey);
        console.error('[note gen error] 笔记生成异常:', e?.stack || e?.message || e);
        return sendJson(res, 500, { error: '笔记生成失败：' + (e?.message || '未知错误') });
      }
    }

    // 【仅测试模式】播种学习计划，避免为了测试去调用大模型生成计划。
    // 仅当开启测试模式（TEST_MODE / mock / NODE_ENV=test）时才注册，生产环境不存在。
    if (pathname === '/api/__test__/seed-plan' && req.method === 'POST' && isTestMode) {
      const userId = requireUserId(req, res); if (!userId) return;
      const b = await readBody(req).catch(() => ({}));
      const planId = buildPlanId(userId);
      const ids = [];
      for (const d of (b.days || [])) {
        const info = db.prepare(`
          INSERT INTO daily_learning_tasks
            (user_id, plan_id, day_number, stage, skill_id, skill_name, skill_category, skill_level, focus, video_info, pdf_info, estimated_time, status, created_at, task_date, original_day, adjusted_day, estimated_minutes, reschedule_count, adjust_reason, adjust_reason_type, adjust_reason_detail)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(userId, planId, d.dayNumber, d.stage || '未分组', 's1', d.skillName || '技能', '', '', d.focus || '',
          JSON.stringify(d.videos || []), JSON.stringify(d.pdfs || []), (d.estimatedTime || '2h'), 'pending', Date.now(), d.date, d.dayNumber, d.dayNumber,
          parseMinutes(d.estimatedTime || '2h'), 0, null, null, null);
        ids.push(info.lastInsertRowid);
      }
      return sendJson(res, 200, { ids, planId });
    }

    // ============ 动态学习计划调整 ============
    // 纯代码规则，不调用 LLM / 不搜索 B站 / 不重新匹配 PDF。
    // 触发：前端「今日任务」页「应用重新安排」按钮，或后台定时。
    if (pathname === '/api/daily-plan/adjust' && req.method === 'POST') {
      const userId = requireUserId(req, res); if (!userId) return;
      const planId = buildPlanId(userId);
      const b = await readBody(req).catch(() => ({}));
      const today = b.today || localDateStr();

      const rows = db.prepare(
        'SELECT * FROM daily_learning_tasks WHERE user_id = ? AND plan_id = ? ORDER BY day_number ASC'
      ).all(userId, planId);

      // 应用模式：
      //   mode='reschedule'（整体重排剩余计划）→ 把「未完成部分 + 剩余所有任务」按目标日重新规划
      //   默认/其他（顺延补做）→ 仅把前序未完成内容并入今日
      const mode = b.mode || 'adjumble';
      let result;
      if (mode === 'reschedule') {
        const startDate = getProfile(userId)?.startDate;
        const maxDay = Math.max(...rows.filter((r) => (r.day_number ?? 0) >= 1).map((r) => r.day_number ?? 0));
        const targetDate = computeTaskDate(startDate, maxDay) || today;
        result = dailyPlanAdjuster.rescheduleByTargetDate({
          tasks: rows,
          targetDate,
          today,
          startDate,
          dailyCapacityMinutes: b.dailyCapacityMinutes || 120,
        });
      } else {
        result = dailyPlanAdjuster.adjustPlan({ tasks: rows, today });
      }

      if (!result.changed) {
        return sendJson(res, 200, { changed: false, reason: result.reason, adjustments: [] });
      }

      // 回写发生变化的 day 行（按 day_number 定位；新增的顺延行 upsert）
      const now = Date.now();
      for (const d of result.days) {
        if (!d._changed) continue;
        const existing = db.prepare('SELECT * FROM daily_learning_tasks WHERE user_id = ? AND plan_id = ? AND day_number = ?')
          .get(userId, planId, d.day_number);
        if (existing) {
          db.prepare(`
            UPDATE daily_learning_tasks
              SET stage = ?, skill_id = ?, skill_name = ?, skill_category = ?, skill_level = ?, focus = ?,
                  video_info = ?, pdf_info = ?, estimated_time = ?, status = ?, updated_at = ?, original_day = ?, adjusted_day = ?, estimated_minutes = ?, reschedule_count = ?, adjust_reason = ?, adjust_reason_type = ?, adjust_reason_detail = ?
            WHERE user_id = ? AND plan_id = ? AND day_number = ?
          `).run(
            d.stage, d.skill_id || '', d.skill_name || d.stage, d.skill_category || '', d.skill_level || '', d.focus || '',
            d.video_info, d.pdf_info, d.estimated_time || '2h', d.status || 'rescheduled', now,
            d.original_day ?? d.day_number, d.adjusted_day ?? d.day_number,
            d.estimated_minutes ?? parseMinutes(d.estimated_time), (existing.reschedule_count || 0) + 1, d.adjust_reason || null,
            d.adjust_reason_type || 'missed_task', d.adjust_reason_detail || d.adjust_reason || null,
            userId, planId, d.day_number
          );
        } else {
          db.prepare(`
            INSERT INTO daily_learning_tasks
              (user_id, plan_id, day_number, stage, skill_id, skill_name, skill_category, skill_level, focus, video_info, pdf_info, estimated_time, status, created_at, task_date, original_day, adjusted_day, estimated_minutes, reschedule_count, adjust_reason, adjust_reason_type, adjust_reason_detail)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            userId, planId, d.day_number, d.stage, d.skill_id || '', d.skill_name || d.stage, d.skill_category || '', d.skill_level || '', d.focus || '',
            d.video_info, d.pdf_info, d.estimated_time || '2h', d.status || 'rescheduled', now,
            computeTaskDate(getProfile(userId)?.startDate, d.day_number),
            d.original_day ?? d.day_number, d.adjusted_day ?? d.day_number,
            d.estimated_minutes ?? parseMinutes(d.estimated_time), 1, d.adjust_reason || null, d.adjust_reason_type || 'missed_task', d.adjust_reason_detail || d.adjust_reason || null
          );
        }
      }

      return sendJson(res, 200, {
        changed: true,
        reason: result.reason,
        adjustments: result.adjustments,
        mode,
        note: mode === 'reschedule'
          ? '已完成整体重排（未完成内容 + 剩余任务已重新规划到目标日），未调用大模型、未新增任何资源来源'
          : '已完成顺延补做（前序未完成内容已并入今日），未调用大模型、未新增任何资源来源',
      });
    }

    // 【仅测试模式】强制设置某 day 行的 reschedule_count / status / estimated_minutes，
    // 用于覆盖「连续延期」「超容量负荷」等动态计划调整场景，不污染生产接口。
    if (pathname === '/api/__test__/force-task' && req.method === 'POST' && isTestMode) {
      const userId = requireUserId(req, res); if (!userId) return;
      const planId = buildPlanId(userId);
      const b = await readBody(req).catch(() => ({}));
      const dayNumber = Number(b.dayNumber);
      if (!dayNumber) return sendJson(res, 400, { error: 'dayNumber 必填', code: 'BAD_DAY' });
      const existing = db.prepare('SELECT * FROM daily_learning_tasks WHERE user_id = ? AND plan_id = ? AND day_number = ?')
        .get(userId, planId, dayNumber);
      if (!existing) return sendJson(res, 404, { error: '任务不存在', code: 'NO_TASK' });

      // 修改数值字段（reschedule_count / estimated_minutes）走 db.mjs 已支持的 18 列全量 UPDATE
      if (b.rescheduleCount != null || b.estimatedMinutes != null) {
        const next = { ...existing };
        if (b.rescheduleCount != null) next.reschedule_count = Number(b.rescheduleCount);
        if (b.estimatedMinutes != null) next.estimated_minutes = Number(b.estimatedMinutes);
        db.prepare(`UPDATE daily_learning_tasks SET stage = ?, skill_id = ?, skill_name = ?, skill_category = ?, skill_level = ?, focus = ?, video_info = ?, pdf_info = ?, estimated_time = ?, status = ?, updated_at = ?, original_day = ?, adjusted_day = ?, estimated_minutes = ?, reschedule_count = ?, adjust_reason = ?, adjust_reason_type = ?, adjust_reason_detail = ? WHERE user_id = ? AND plan_id = ? AND day_number = ?`)
          .run(
            next.stage, next.skill_id || '', next.skill_name || next.stage, next.skill_category || '', next.skill_level || '', next.focus || '',
            next.video_info, next.pdf_info, next.estimated_time || '2h', next.status || 'pending', Date.now(),
            next.original_day ?? next.day_number, next.adjusted_day ?? next.day_number,
            next.estimated_minutes ?? 0, next.reschedule_count ?? 0, next.adjust_reason ?? null, next.adjust_reason_type ?? null, next.adjust_reason_detail ?? null,
            userId, planId, dayNumber
          );
      }

      // 若请求 status=completed，标记该行所有子资源完成（与 checkin 一致，仅测试用）
      if (b.status === 'completed') {
        const row = db.prepare('SELECT * FROM daily_learning_tasks WHERE user_id = ? AND plan_id = ? AND day_number = ?')
          .get(userId, planId, dayNumber);
        const subs = expandDayRow(row);
        const doneVideos = subs.filter((s) => s.type === 'video').map((s) => ({ ...s.resource, done: true }));
        const donePdfs = subs.filter((s) => s.type === 'pdf').map((s) => ({ ...s.resource, done: true }));
        db.prepare('UPDATE daily_learning_tasks SET video_info = ? WHERE id = ?').run(JSON.stringify(doneVideos), row.id);
        db.prepare('UPDATE daily_learning_tasks SET pdf_info = ? WHERE id = ?').run(JSON.stringify(donePdfs), row.id);
        db.prepare("UPDATE daily_learning_tasks SET status = 'completed' WHERE id = ?").run(row.id);
        // 记录到 daily_task_completions（模拟历史打卡，供测试10验证不受影响）
        // 打卡日期跟随测试模式 testDate（与今日任务 / 笔记生成保持一致）
        const date = testDateOverride || localDateStr();
        for (const s of subs) {
          const key = s.resource.url || s.resource.docId || s.resource.title || `${s.type}_${s.id}`;
          db.prepare('INSERT OR IGNORE INTO daily_task_completions (user_id, task_id, date, resource_type, resource_key, resource_info, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(userId, String(s.id), date, s.type, key, JSON.stringify(s.resource), Date.now());
        }
      }
      return sendJson(res, 200, { ok: true, dayNumber });
    }

    // ============ 动态计划调整系统：风险探测 ============
    if (pathname === '/api/learning-plan/risk' && req.method === 'GET') {
      const userId = requireUserId(req, res); if (!userId) return;
      const planId = buildPlanId(userId);
      const prof = getProfile(userId);
      const targetDate = prof?.targetDate || null;
      if (!targetDate) return sendJson(res, 200, { risk: false, reason: '未设置目标日', currentLoad: '0', recommendedLoad: '0', suggestedDate: null });
      const dailyCapacityMinutes = dailyCapacityMinutesOf(prof);
      const today = new Date().toISOString().slice(0, 10);
      const rows = db.prepare(
        'SELECT * FROM daily_learning_tasks WHERE user_id = ? AND plan_id = ? ORDER BY day_number ASC'
      ).all(userId, planId);
      const risk = dailyPlanAdjuster.computeRisk({ tasks: rows, targetDate, dailyCapacityMinutes, today, startDate: prof?.startDate });
      return sendJson(res, 200, { targetDate, dailyCapacityMinutes, ...risk });
    }

    // ============ 动态计划调整系统：Stage 阶段进度 ============
    if (pathname === '/api/learning-plan/stage-progress' && req.method === 'GET') {
      const userId = requireUserId(req, res); if (!userId) return;
      const planId = buildPlanId(userId);
      const rows = db.prepare(
        'SELECT * FROM daily_learning_tasks WHERE user_id = ? AND plan_id = ? ORDER BY day_number ASC'
      ).all(userId, planId);
      const sp = dailyPlanAdjuster.stageProgress({ tasks: rows });
      return sendJson(res, 200, {
        currentStage: sp.currentStage,
        currentProgress: sp.currentProgress,
        blockedNextStage: sp.blockedNextStage,
        threshold: sp.stageProtectionThreshold,
        stages: sp.stages,
      });
    }

    // ============ 动态计划调整系统：每日结算（不自动改计划） ============
    if (pathname === '/api/learning-plan/daily-settlement' && req.method === 'GET') {
      const userId = requireUserId(req, res); if (!userId) return;
      const planId = buildPlanId(userId);
      const prof = getProfile(userId);
      const today = todayDateStr(); // 测试模式读取 testDate
      const rows = db.prepare(
        'SELECT * FROM daily_learning_tasks WHERE user_id = ? AND plan_id = ? ORDER BY day_number ASC'
      ).all(userId, planId);
      const formal = rows.filter((r) => (r.day_number ?? 0) >= 1);
      const settlement = await dailyPlanScheduler.runDailySettlement({
        tasks: rows,
        today,
        dailyCapacityMinutes: dailyCapacityMinutesOf(prof),
        targetDate: prof?.targetDate || null,
        startDate: prof?.startDate,
      });
      // 风险横幅统一由 dailySettlement 产出：仅当用户连续三天（含今天）未完成当日「所有」任务时，
      // 提示「建议延长学习日期」。进度落后 / 负荷超能力等类横幅不再展示。
      return sendJson(res, 200, settlement);
    }

    // ============ 动态计划调整系统：用户确认风险调整 ============
    // 前端在看到风险/延期提示后，由用户主动确认是否执行重排（不自动改计划）。
    if (pathname === '/api/learning-plan/confirm-adjust' && req.method === 'POST') {
      const userId = requireUserId(req, res); if (!userId) return;
      const planId = buildPlanId(userId);
      const b = await readBody(req).catch(() => ({}));
      const action = b.action === 'reschedule' ? 'reschedule' : (b.action === 'keep' ? 'keep' : null);
      if (!action) return sendJson(res, 400, { error: 'action 必须为 reschedule 或 keep', code: 'BAD_ACTION' });

      const prof = getProfile(userId);
      const targetDate = prof?.targetDate || null;
      const today = localDateStr();

      if (action === 'keep') {
        // 用户选择「保持现状」：仅记录一次风险确认，不改动任务
        db.prepare(`
          INSERT INTO learning_plan_adjustments
            (user_id, old_target_date, new_target_date, adjust_type, adjust_reason, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(userId, targetDate, targetDate, 'risk_warning',
          b.reason || '用户确认风险但仍保持当前计划', Date.now());
        return sendJson(res, 200, { action: 'keep', changed: false, reason: '已记录风险确认，计划保持不变' });
      }

      // action === 'reschedule'：按当前目标日 + 当前策略重新规划剩余任务（默认保持目标日期、增加每日强度、不顺延）
      const strategy = b.strategy === 'keep_daily_load' ? 'keep_daily_load' : 'keep_target_date';
      const rows = db.prepare(
        'SELECT * FROM daily_learning_tasks WHERE user_id = ? AND plan_id = ? ORDER BY day_number ASC'
      ).all(userId, planId);
      const sp = dailyPlanAdjuster.stageProgress({ tasks: rows });
      let planRows = rows;
      if (sp.blockedNextStage && sp.currentStage) {
        planRows = rows.map((r) => {
          const subs = expandDayRow(r);
          const hasDone = subs.some((s) => s.status === 'completed');
          if (r.stage !== sp.currentStage && !hasDone) return { ...r, _protectSkip: true };
          return r;
        });
      }
      const result = dailyPlanAdjuster.rescheduleByTargetDate({
        tasks: planRows, targetDate, dailyCapacityMinutes: dailyCapacityMinutesOf(prof), today, startDate: prof?.startDate, strategy,
      });
      if (result.changed) {
        const now = Date.now();
        db.prepare('DELETE FROM daily_learning_tasks WHERE user_id = ? AND plan_id = ?').run(userId, planId);
        for (const d of result.days) {
          db.prepare(`
            INSERT INTO daily_learning_tasks
              (user_id, plan_id, day_number, stage, skill_id, skill_name, skill_category, skill_level, focus, video_info, pdf_info, estimated_time, status, created_at, task_date, original_day, adjusted_day, estimated_minutes, reschedule_count, adjust_reason, adjust_reason_type, adjust_reason_detail)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            userId, planId, d.day_number, d.stage, d.skill_id || '', d.skill_name || d.stage, d.skill_category || '', d.skill_level || '', d.focus || '',
            d.video_info, d.pdf_info, d.estimated_time || '2h', d.status || 'rescheduled', now,
            computeTaskDate(prof?.startDate, d.day_number),
            d.original_day ?? d.day_number, d.adjusted_day ?? d.day_number,
            d.estimated_minutes ?? 0, d.reschedule_count ?? 0, d.adjust_reason || null,
            d.adjust_reason_type || 'overload', d.adjust_reason_detail || null
          );
        }
      }
      db.prepare(`
        INSERT INTO learning_plan_adjustments
          (user_id, old_target_date, new_target_date, adjust_type, adjust_reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(userId, targetDate, targetDate, 'auto_reschedule',
        (b.reason || `用户确认风险后重新规划（策略：${strategy}）`), Date.now());
      return sendJson(res, 200, {
        action: 'reschedule',
        changed: result.changed,
        reason: result.reason,
        strategy,
        adjustments: result.adjustments,
        note: '已按用户确认执行重排；未调用大模型、未重排学习路线',
      });
    }

    // ============ 当前板块内：按剩余规划日自动重排（日期自然跳转 / 测试下一天） ============
    if (pathname === '/api/learning-plan/reschedule-within-stage' && req.method === 'POST') {
      const userId = requireUserId(req, res); if (!userId) return;
      const planId = buildPlanId(userId);
      const b = await readBody(req).catch(() => ({}));
      const fromDate = String(b.fromDate || '').trim();
      if (!fromDate) return sendJson(res, 400, { error: '缺少 fromDate', code: 'NO_FROM_DATE' });

      const rows = db.prepare(
        'SELECT * FROM daily_learning_tasks WHERE user_id = ? AND plan_id = ? ORDER BY day_number ASC'
      ).all(userId, planId);

      const today = fromDate < (todayDateStr()) ? todayDateStr() : fromDate;
      const result = dailyPlanAdjuster.rescheduleWithinStage({ tasks: rows, fromDate, today });

      if (!result.changed) {
        return sendJson(res, 200, { changed: false, reason: result.reason, stage: result.stage, remainDays: result.remainDays, adjustments: [] });
      }

      // 回写发生变化的 day 行（按 day_number 定位；新增的顺延行 upsert）
      const now = Date.now();
      for (const d of result.days) {
        if (!d._changed) continue;
        const existing = db.prepare('SELECT * FROM daily_learning_tasks WHERE user_id = ? AND plan_id = ? AND day_number = ?')
          .get(userId, planId, d.day_number);
        if (existing) {
          db.prepare(`
            UPDATE daily_learning_tasks
              SET stage = ?, skill_id = ?, skill_name = ?, skill_category = ?, skill_level = ?, focus = ?,
                  video_info = ?, pdf_info = ?, estimated_time = ?, status = ?, updated_at = ?, original_day = ?, adjusted_day = ?, estimated_minutes = ?, reschedule_count = ?, adjust_reason = ?, adjust_reason_type = ?, adjust_reason_detail = ?
            WHERE user_id = ? AND plan_id = ? AND day_number = ?
          `).run(
            d.stage, d.skill_id || '', d.skill_name || d.stage, d.skill_category || '', d.skill_level || '', d.focus || '',
            d.video_info, d.pdf_info, d.estimated_time || '2h', d.status || 'rescheduled', now,
            d.original_day ?? d.day_number, d.adjusted_day ?? d.day_number,
            d.estimated_minutes ?? parseMinutes(d.estimated_time), (existing.reschedule_count || 0) + 1, d.adjust_reason || null,
            d.adjust_reason_type || 'missed_task', d.adjust_reason_detail || d.adjust_reason || null,
            userId, planId, d.day_number
          );
        } else {
          db.prepare(`
            INSERT INTO daily_learning_tasks
              (user_id, plan_id, day_number, stage, skill_id, skill_name, skill_category, skill_level, focus, video_info, pdf_info, estimated_time, status, created_at, task_date, original_day, adjusted_day, estimated_minutes, reschedule_count, adjust_reason, adjust_reason_type, adjust_reason_detail)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            userId, planId, d.day_number, d.stage, d.skill_id || '', d.skill_name || d.stage, d.skill_category || '', d.skill_level || '', d.focus || '',
            d.video_info, d.pdf_info, d.estimated_time || '2h', d.status || 'rescheduled', now,
            computeTaskDate(getProfile(userId)?.startDate, d.day_number),
            d.original_day ?? d.day_number, d.adjusted_day ?? d.day_number,
            d.estimated_minutes ?? parseMinutes(d.estimated_time), 1, d.adjust_reason || null, d.adjust_reason_type || 'missed_task', d.adjust_reason_detail || d.adjust_reason || null
          );
        }
      }

      return sendJson(res, 200, {
        changed: true,
        reason: result.reason,
        stage: result.stage,
        remainDays: result.remainDays,
        adjustments: result.adjustments,
        note: '已按当前板块剩余规划日重新规划每日计划，未调用大模型、未新增任何资源来源',
      });
    }

    // ============ 动态计划调整系统：按目标日重新规划剩余任务 ============
    if (pathname === '/api/learning-plan/reschedule' && req.method === 'POST') {
      const userId = requireUserId(req, res); if (!userId) return;
      const planId = buildPlanId(userId);
      const b = await readBody(req).catch(() => ({}));
      const newTargetDate = String(b.targetDate || '').trim();
      if (!newTargetDate || !/^\d{4}-\d{2}-\d{2}$/.test(newTargetDate)) {
        return sendJson(res, 400, { error: '请提供合法的目标日期 (YYYY-MM-DD)', code: 'BAD_TARGET_DATE' });
      }
      const strategy = b.strategy === 'keep_target_date' ? 'keep_target_date' : 'keep_daily_load';
      const prof = getProfile(userId);
      const oldTargetDate = prof?.targetDate || null;
      const dailyCapacityMinutes = dailyCapacityMinutesOf(prof);
      const today = localDateStr();

      // 1) 更新 profiles.target_date（唯一真源，距离目标日自动统一）
      db.prepare('UPDATE profiles SET target_date = ?, updated_at = ? WHERE user_id = ?')
        .run(newTargetDate, Date.now(), userId);

      // 2) 读取现有每日任务并重新规划剩余部分（支持双策略 + stage 优先级 + 容量分桶）
      const rows = db.prepare(
        'SELECT * FROM daily_learning_tasks WHERE user_id = ? AND plan_id = ? ORDER BY day_number ASC'
      ).all(userId, planId);

      // Stage 阶段保护（文档三）：当前 stage 完成率 < 90% 时，下一 stage 任务不进入今日/后续重排
      const sp = dailyPlanAdjuster.stageProgress({ tasks: rows });
      let planRows = rows;
      if (sp.blockedNextStage && sp.currentStage) {
        // 仅保留当前 stage 及已完成(有 done)行所属 stage；剔除"下一 stage 尚未开动的待排任务"
        // 简化：reschedule 内部已按 stage 顺序分桶，这里通过过滤"非当前 stage 且全未完成"的待排行来阻止提前进入
        planRows = rows.map((r) => {
          const subs = expandDayRow(r);
          const hasDone = subs.some((s) => s.status === 'completed');
          // 当前 stage 之外的行，若没有任何已完成子资源，则从待重排中移除（不提前进入下一阶段）
          if (r.stage !== sp.currentStage && !hasDone) {
            return { ...r, _protectSkip: true };
          }
          return r;
        });
      }

      const result = dailyPlanAdjuster.rescheduleByTargetDate({
        tasks: planRows, targetDate: newTargetDate, dailyCapacityMinutes, today, startDate: prof?.startDate, strategy,
      });

      // 3) 写回：删除旧每日任务，按新 days 落库（保留已完成行的 done 标记由 kept 保留）
      if (result.changed) {
        const now = Date.now();
        db.prepare('DELETE FROM daily_learning_tasks WHERE user_id = ? AND plan_id = ?').run(userId, planId);
        for (const d of result.days) {
          db.prepare(`
            INSERT INTO daily_learning_tasks
              (user_id, plan_id, day_number, stage, skill_id, skill_name, skill_category, skill_level, focus, video_info, pdf_info, estimated_time, status, created_at, task_date, original_day, adjusted_day, estimated_minutes, reschedule_count, adjust_reason, adjust_reason_type, adjust_reason_detail)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            userId, planId, d.day_number, d.stage, d.skill_id || '', d.skill_name || d.stage, d.skill_category || '', d.skill_level || '', d.focus || '',
            d.video_info, d.pdf_info, d.estimated_time || '2h', d.status || 'rescheduled', now,
            computeTaskDate(prof?.startDate, d.day_number),
            d.original_day ?? d.day_number, d.adjusted_day ?? d.day_number,
            d.estimated_minutes ?? 0, d.reschedule_count ?? 0, d.adjust_reason || null,
            d.adjust_reason_type || 'target_date_changed', d.adjust_reason_detail || null
          );
        }
      }

      // 4) 记录调整原因（不影响 learning_notes / daily_task_completions / 总体路线）
      db.prepare(`
        INSERT INTO learning_plan_adjustments
          (user_id, old_target_date, new_target_date, adjust_type, adjust_reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(userId, oldTargetDate, newTargetDate, 'user_change_date',
        (b.reason || `用户修改目标日期（策略：${strategy}），重新规划剩余每日任务`), Date.now());

      return sendJson(res, 200, {
        changed: result.changed,
        reason: result.reason,
        strategy,
        adjustments: result.adjustments,
        stageProtection: sp.blockedNextStage ? { blockedNextStage: true, currentStage: sp.currentStage, currentProgress: sp.currentProgress } : null,
        oldTargetDate,
        newTargetDate,
        note: '已按新目标日期重新规划执行层每日任务；未调用大模型、未重排学习路线、未重新匹配资源',
      });
    }

    // ============ NovaForge 阶段知识沉淀链路 ============
    // 说明：本链路与每日笔记完全解耦。
    //   · 每日笔记 → noteGenerator（输入原始字幕/PDF chunk，增量）
    //   · 阶段总结 → novaforge  （输入该阶段的 learning_notes，绝不碰原始资料）

    // 阶段进度：返回每个 stage 的天数完成情况、是否已可生成阶段总结、是否已生成
    if (pathname === '/api/stage/progress' && req.method === 'GET') {
      const userId = requireUserId(req, res); if (!userId) return;
      const planId = buildPlanId(userId);
      const rows = db.prepare(
        'SELECT * FROM daily_learning_tasks WHERE user_id = ? AND plan_id = ? ORDER BY day_number ASC'
      ).all(userId, planId);
      const formal = rows.filter((r) => (r.day_number ?? 0) >= 1);
      // 按 stage 名聚合
      const map = new Map();
      for (const r of formal) {
        const sid = String(r.stage || '未分组');
        if (!map.has(sid)) map.set(sid, { stageId: sid, stageTitle: sid, days: [], totalDays: 0, completedDays: 0 });
        const g = map.get(sid);
        g.days.push(r.day_number);
        g.totalDays += 1;
        // day 行「全部子任务完成」才算这天完成
        const subs = expandDayRow(r);
        if (subs.length && subs.every((t) => t.status === 'completed')) g.completedDays += 1;
      }
      const stages = [...map.values()].map((g) => {
        const existing = db.prepare('SELECT * FROM stage_notes WHERE user_id = ? AND stage_id = ?').get(userId, g.stageId);
        const noteRows = db.prepare('SELECT * FROM learning_notes WHERE user_id = ? AND stage_id = ? ORDER BY note_date ASC').all(userId, g.stageId);
        const finished = g.totalDays > 0 && g.completedDays >= g.totalDays;
        return {
          ...g,
          days: undefined,
          dayRange: g.days.length ? [Math.min(...g.days), Math.max(...g.days)] : [],
          finished,
          dailyNoteCount: noteRows.length,
          // 阶段已完成 + 至少有一篇每日笔记，才能生成阶段总结
          canGenerateStageNote: finished && noteRows.length > 0,
          hasStageNote: Boolean(existing),
          stageNoteId: existing ? existing.id : null,
        };
      });
      return sendJson(res, 200, { stages });
    }

    // 生成阶段知识总结（NovaForge）。输入严格来自该阶段的每日笔记。
    if (pathname === '/api/stage-note/generate' && req.method === 'POST') {
      const userId = requireUserId(req, res); if (!userId) return;
      const b = await readBody(req).catch(() => ({}));
      const stageId = String(b.stageId || '').trim();
      if (!stageId) return sendJson(res, 400, { error: '缺少 stageId', code: 'NO_STAGE_ID' });

      const planId = buildPlanId(userId);
      // 1) 校验该阶段确实已完成（防止提前触发浪费 token）
      const rows = db.prepare(
        'SELECT * FROM daily_learning_tasks WHERE user_id = ? AND plan_id = ? ORDER BY day_number ASC'
      ).all(userId, planId);
      const stageRows = rows.filter((r) => (r.day_number ?? 0) >= 1 && String(r.stage || '未分组') === stageId);
      if (!stageRows.length) return sendJson(res, 404, { error: '未找到该阶段', code: 'STAGE_NOT_FOUND' });
      const allDone = stageRows.every((r) => {
        const subs = expandDayRow(r);
        return subs.length && subs.every((t) => t.status === 'completed');
      });
      if (!allDone && !b.force) {
        return sendJson(res, 400, { error: '该阶段尚未全部完成，暂不能生成阶段总结', code: 'STAGE_NOT_FINISHED' });
      }

      // 2) 【关键】只取该阶段的每日笔记作为输入，绝不读取原始 PDF / 视频字幕
      const noteRows = db.prepare(
        'SELECT * FROM learning_notes WHERE user_id = ? AND stage_id = ? ORDER BY note_date ASC'
      ).all(userId, stageId);
      if (!noteRows.length) {
        return sendJson(res, 400, { error: '该阶段还没有任何每日笔记，无法生成阶段总结', code: 'NO_DAILY_NOTES' });
      }
      const dailyNotes = noteRows.map((r) => {
        const c = safeParseJSON(r.content, {}) || {};
        return { ...c, __date: r.note_date };
      });

      // 3) 调用 NovaForge
      let stageNote;
      try {
        stageNote = await novaforge.generateStageSummary({ stageTitle: stageId, dailyNotes });
      } catch (e) {
        console.error('[stage-note/generate] novaforge error:', e?.stack || e);
        return sendJson(res, 500, { error: '阶段总结生成失败：' + (e.message || '未知错误') });
      }

      // 4) 保存（一个 stage 一份，重复生成覆盖）
      const now = Date.now();
      const sourceNotes = noteRows.map((r) => ({ id: r.id, date: r.note_date, title: r.title }));
      const info = db.prepare(`
        INSERT INTO stage_notes (user_id, plan_id, stage_id, stage_title, title, content, knowledge_tree, source_notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(userId, planId, stageId, stageId, stageNote.title, JSON.stringify(stageNote), JSON.stringify(stageNote.knowledgeTree || []), JSON.stringify(sourceNotes), now, now);

      return sendJson(res, 200, {
        stageNote: {
          id: info.lastInsertRowid,
          stageId,
          title: stageNote.title,
          content: stageNote,
          knowledgeTree: stageNote.knowledgeTree || [],
          sourceNotes,
          createdAt: now,
        },
      });
    }

    // 查询已生成的阶段总结
    if (/^\/api\/stage-note\/[^/]+$/.test(pathname) && req.method === 'GET') {
      const userId = requireUserId(req, res); if (!userId) return;
      const stageId = decodeURIComponent(pathname.replace('/api/stage-note/', ''));
      const row = db.prepare('SELECT * FROM stage_notes WHERE user_id = ? AND stage_id = ?').get(userId, stageId);
      if (!row) return sendJson(res, 404, { error: '该阶段尚未生成总结' });
      return sendJson(res, 200, {
        stageNote: {
          id: row.id,
          stageId: row.stage_id,
          title: row.title,
          content: safeParseJSON(row.content, {}),
          knowledgeTree: safeParseJSON(row.knowledge_tree, []),
          sourceNotes: safeParseJSON(row.source_notes, []),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        },
      });
    }

    // 查询某天已生成的学习笔记（按 note_date）
    if (/^\/api\/learning-note\/[^/]+$/.test(pathname) && req.method === 'GET') {
      const userId = requireUserId(req, res); if (!userId) return;
      const date = decodeURIComponent(pathname.split('/').pop());
      const row = db.prepare('SELECT * FROM learning_notes WHERE user_id = ? AND note_date = ?').get(userId, date);
      if (!row) return sendJson(res, 404, { error: '尚未生成笔记' });
      return sendJson(res, 200, {
        note: {
          id: row.id,
          title: row.title,
          content: safeParseJSON(row.content, {}),
          generationCount: row.generation_count,
          noteDate: row.note_date,
          sourceTasks: safeParseJSON(row.source_tasks, []),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        },
      });
    }

    // 兼容老笔记：note_date 缺失时用 created_at 时间戳推导；统一返回紧凑 YYYYMMDD 格式（去掉连字符）
    const resolveNoteDate = (r) => {
      let raw = '';
      if (r.note_date) raw = String(r.note_date);
      else if (r.created_at) {
        const d = new Date(r.created_at);
        if (!Number.isNaN(d.getTime())) {
          const y = d.getFullYear();
          const mo = String(d.getMonth() + 1).padStart(2, '0');
          const da = String(d.getDate()).padStart(2, '0');
          raw = `${y}-${mo}-${da}`;
        }
      }
      raw = raw.replace(/[-/]/g, '').replace(/\s.*$/, '');
      return /^\d{8}$/.test(raw) ? raw : '';
    };

    // ===== 测试模式状态 / 模拟日期接口 =====
    // 仅测试模式（TEST_MODE）可用；生产环境返回 404，不影响任何生产逻辑。
    if (pathname === '/api/test-mode' && req.method === 'GET' && isTestMode) {
      // 测试模式专用：无需登录即可读取开关（仅 TEST_MODE 开启时注册，生产环境返回 404）
      return sendJson(res, 200, {
        testMode: true,
        testDate: testDateOverride,
        realDate: localDateStr(),
        mockNote: true, // 测试模式笔记走 mock 结构，不调 LLM
      });
    }
    if (pathname === '/api/test-mode' && req.method === 'POST' && isTestMode) {
      const userId = requireUserId(req, res); if (!userId) return;
      const b = await readBody(req).catch(() => ({}));
      // 设置模拟日期（testDate=null 或空字符串表示清除，恢复真实日期）
      if ('testDate' in b) {
        const v = b.testDate;
        if (v === null || v === '' || v === undefined) testDateOverride = null;
        else if (/^\d{4}-\d{2}-\d{2}$/.test(String(v))) testDateOverride = String(v);
        else return sendJson(res, 400, { error: 'testDate 格式应为 YYYY-MM-DD', code: 'BAD_TEST_DATE' });
      }
      return sendJson(res, 200, {
        testMode: true,
        testDate: testDateOverride,
        realDate: localDateStr(),
        today: todayDateStr(),
      });
    }

    // 常驻：调整网站认为的「当前日期」（独立于测试模式，任何环境可用）。
    // 用于让网站以某一天为准展示每日任务 / 今日日期（例如跨天联调）。
    // 设置（POST，body: { currentDate?: 'YYYY-MM-DD' | null }），查询（GET）。
    if (pathname === '/api/current-date' && (req.method === 'GET' || req.method === 'POST')) {
      const userId = requireUserId(req, res); if (!userId) return;
      if (req.method === 'POST') {
        const b = await readBody(req).catch(() => ({}));
        if ('currentDate' in b) {
          const v = b.currentDate;
          if (v === null || v === '' || v === undefined) currentDateOverride = null;
          else if (/^\d{4}-\d{2}-\d{2}$/.test(String(v))) currentDateOverride = String(v);
          else return sendJson(res, 400, { error: 'currentDate 格式应为 YYYY-MM-DD', code: 'BAD_CURRENT_DATE' });
        }
      }
      return sendJson(res, 200, {
        currentDate: currentDateOverride,
        realDate: localDateStr(),
        effectiveDate: todayDateStr(),
      });
    }

    // 查询某 plan 的每日学习任务
    if (/^\/api\/daily-plan\/[^/]+$/.test(pathname) && req.method === 'GET') {
      const userId = requireUserId(req, res); if (!userId) return;
      const planId = decodeURIComponent(pathname.replace('/api/daily-plan/', ''));
      const rows = db.prepare('SELECT * FROM daily_learning_tasks WHERE user_id = ? AND plan_id = ? ORDER BY day_number ASC').all(userId, planId);
      const dailyTasks = rows.map((r) => ({
        day: r.day_number,
        taskDate: r.task_date || null,
        stage: r.stage,
        skill: {
          skill_id: r.skill_id,
          standard_name: r.skill_name,
          category: r.skill_category || '',
          level: r.skill_level || '',
        },
        focus: r.focus || '',
        resources: (() => { const { videos, pdfs } = parseResourceInfo(r); return { video: videos, pdf: pdfs }; })(),
        estimatedTime: r.estimated_time,
        status: r.status,
      }));
      return sendJson(res, 200, { planId, targetDays: dailyTasks.length, dailyTasks });
    }

    if (pathname === '/api/health' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true });
    }
    sendJson(res, 404, { error: 'Not Found' });
  } catch (err) {
    console.error('[server] error:', err);
    sendJson(res, 500, { error: err.message || '服务器内部错误' });
  }
});

scheduleDailyBossRefresh();
server.listen(PORT, () => {
  console.log(`[server] API 服务已启动: http://localhost:${PORT}`);
  console.log(`[server] 数据库文件: ${DB_PATH}`);
});

// ============ 每日学习结算定时器（文档一） ============
// 每天 23:59 / 00:00 触发：仅做结算分析（完成率/未完成任务/当前 stage/剩余目标日），
// 产出是否需要调整的结论与风险提醒，但【不自动修改计划】，最终是否重排由用户在前端确认。
function runDailySettlementForAllUsers() {
  try {
    const users = db.prepare('SELECT DISTINCT user_id FROM daily_learning_tasks').all();
    const todayStr = new Date().toISOString().slice(0, 10);
    for (const u of users) {
      try {
        const planId = buildPlanId(u.user_id);
        const rows = db.prepare('SELECT * FROM daily_learning_tasks WHERE user_id = ? AND plan_id = ? ORDER BY day_number ASC').all(u.user_id, planId);
        if (!rows.length) continue;
        const prof = getProfile(u.user_id);
        dailyPlanScheduler.scheduleDailyCheck({
          tasks: rows, today: todayStr,
          dailyCapacityMinutes: dailyCapacityMinutesOf(prof),
          targetDate: prof?.targetDate || null,
        });
        // 仅分析，不写库、不重排；如需持久化风险提示，由前端 confirm-adjust 触发。
      } catch (e) {
        console.error('[settlement] 用户结算失败:', u.user_id, e?.message || e);
      }
    }
    console.log(`[settlement] ${todayStr} 每日结算检查完成，覆盖 ${users.length} 个用户`);
  } catch (e) {
    console.error('[settlement] 定时结算异常:', e?.message || e);
  }
}
// 每 30 分钟检查一次「是否临近 23:59/00:00」：若当前分钟为 59 或 00 则触发一次（避免依赖 cron）
setInterval(() => {
  const m = new Date().getMinutes();
  if (m === 0 || m === 59) runDailySettlementForAllUsers();
}, 60 * 1000);
