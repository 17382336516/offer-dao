// 学习计划生成：先通过小红书 MCP（search_feeds）搜索真实「学习路线」，
// 再把素材交给千问(qwen-turbo) 整合规划成结构化周计划。
// 容错：小红书未登录/超时 → 仍用千问基于通用知识生成；千问不可用 → 回退规则模板。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as rag from './rag.mjs';
import * as skillNormalizer from './skillNormalizer.mjs';
import * as skillResourceMatcher from './skillResourceMatcher.mjs';
import { normalizeXhsSearchJob } from './skillResourceMatcher.mjs';
import { computeLearningBudget, selectResourcesByBudget } from './learningBudget.mjs';

// 防抖/单飞缓存：前端会高频轮询 checkXhsLogin（每次都打一次 30s 的 MCP 调用），
// 并发几十次会瞬间淹没事件循环导致后端对所有请求无响应。这里用「按 userId+forBind
// 维度的单飞 + 3s 结果缓存」收敛，保证高频轮询只真正触发一次 MCP 调用。
const _loginCheckCache = new Map();
let _loginCheckInFlight = new Map();
function loginCheckKey(userId, forBind) { return String(userId) + ':' + (forBind ? 1 : 0); }

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 判断本地是否已有真实登录 session cookie（避免 check_login_status 在仅游客 cookie 时误判已登录）
function hasLoginCookie() {
  try {
    const p = process.env.COOKIES_PATH || path.join(__dirname, '..', 'xhs-cookies.json');
    if (!fs.existsSync(p)) return false;
    const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(arr) && arr.some((c) => /web_session|xhs-session|xuser|gid/.test(c.name || ''));
  } catch {
    return false;
  }
}

// ===== B站全局登录态（管理员/系统级，非用户隔离） =====
// B站字幕提取（官方/CC/需登录/AI 自动）在游客态下 player/v2 不返回字幕列表，
// 必须带一个登录 cookie 才能看到。该 cookie 是「系统级」共享的，所有 offer dao 用户
// 生成 B站笔记/匹配视频时共用同一个 B站账号，无需每个用户各自登录 B站。
// 读取优先级：环境变量 BILI_COOKIE / BILI_SESSDATA > data/bili/cookie.json
// 文件格式兼容：{ "cookie": "SESSDATA=...; bili_jct=..." } 或 { "SESSDATA": "..." }
// 缺失时返回 null（调用方自动退回游客态，不影响其他功能）。
let _biliCookieCache = undefined; // undefined=未加载, null=无 cookie, string=有
// 【必须 export】index.mjs 的 extractBiliSubtitles 通过 plan.getBiliCookie() 取登录态注入
// bilinote 子进程的 BILI_COOKIE。曾因这里漏写 export 导致 plan.getBiliCookie 恒为 undefined，
// 子进程始终游客态 → player/v2 返回 need_login_subtitle:true & subtitles:[] → 字幕提取永远为空。
export function getBiliCookie() {
  if (_biliCookieCache !== undefined) return _biliCookieCache;
  try {
    // 1) 环境变量优先
    const envCookie = process.env.BILI_COOKIE || process.env.BILI_SESSDATA;
    if (envCookie && envCookie.trim()) {
      _biliCookieCache = envCookie.trim();
      return _biliCookieCache;
    }
    // 2) 读配置文件
    const p = path.join(__dirname, '..', 'data', 'bili', 'cookie.json');
    if (fs.existsSync(p)) {
      const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
      let cookie = '';
      if (typeof cfg.cookie === 'string' && cfg.cookie.trim()) cookie = cfg.cookie.trim();
      else if (typeof cfg.SESSDATA === 'string' && cfg.SESSDATA.trim())
        cookie = `SESSDATA=${cfg.SESSDATA.trim()}`;
      // 过滤占位值，避免把 REPLACE_WITH_REAL_VALUE 当成真 cookie
      if (cookie && !/REPLACE_WITH_REAL_VALUE/.test(cookie)) {
        _biliCookieCache = cookie;
        return _biliCookieCache;
      }
    }
    _biliCookieCache = null;
  } catch {
    _biliCookieCache = null;
  }
  return _biliCookieCache;
}

// ===== 小红书用户级隔离 =====
// 当前活跃小红书用户（由调用方在发起 xhs 操作前 setXhsActiveUser 设置）。
// 切换式隔离：每次 xhs 操作前把对应隔离 cookie 切到 MCP 全局文件，保证只用该用户自己的账号。
let activeXhsUserId = null;
export function setXhsActiveUser(userId) {
  activeXhsUserId = userId;
}

// 隔离 cookie 文件：data/xhs/user_<id>.json（与 mcp-http-server.mjs 约定一致）
function userCookieFile(userId) {
  return path.join(__dirname, '..', 'data', 'xhs', `user_${userId}.json`);
}

// 判断指定用户是否拥有有效的小红书登录 cookie（仅看该用户自己的隔离文件，不碰全局/他人文件）
export function hasUserLoginCookie(userId) {
  if (!userId) return false;
  try {
    const p = userCookieFile(userId);
    if (!fs.existsSync(p)) return false;
    const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(arr) && arr.some((c) => /web_session|xhs-session|xuser|gid/.test(c.name || ''));
  } catch {
    return false;
  }
}

// 操作前切换 MCP 全局 cookie 到当前活跃用户；未设置 activeUser 时跳过（兼容未迁移的调用路径）。
async function ensureUserCookie() {
  if (!activeXhsUserId) return;
  const id = () => Math.floor(Math.random() * 1e9);
  await mcpPost({
    jsonrpc: '2.0', id: id(), method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'offerdao', version: '1.0' } },
  }).catch(() => {});
  const p = userCookieFile(activeXhsUserId);
  if (fs.existsSync(p)) {
    // 该用户已绑定：切到他自己的隔离 cookie
    await mcpPost({
      jsonrpc: '2.0', id: id(), method: 'tools/call',
      params: { name: 'switch_user_cookie', arguments: { userId: String(activeXhsUserId) } },
    }).catch(() => {});
  } else {
    // 该用户尚未绑定：清空全局残留 cookie，防止误用前任用户的账号（旧 cookie 不自动归属）
    await mcpPost({
      jsonrpc: '2.0', id: id(), method: 'tools/call',
      params: { name: 'prepare_bind', arguments: { userId: String(activeXhsUserId) } },
    }).catch(() => {});
  }
}

// 查询用户在 xhs_accounts 表的绑定状态（用户级隔离，与全局/他人 cookie 无关）
export function getXhsAccount(db, userId) {
  if (!db || !userId) return null;
  try {
    const row = db.prepare('SELECT * FROM xhs_accounts WHERE user_id = ?').get(userId);
    if (!row) return null;
    return {
      userId: row.user_id,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  } catch {
    return null;
  }
}

// 写入/更新用户在 xhs_accounts 表的绑定记录（仅标记该用户已绑定自己的小红书账号）
export function upsertXhsAccount(db, userId, status = 'active') {
  if (!db || !userId) return;
  const now = Date.now();
  try {
    const existing = db.prepare('SELECT id FROM xhs_accounts WHERE user_id = ?').get(userId);
    if (existing) {
      db.prepare('UPDATE xhs_accounts SET status = ?, updated_at = ? WHERE user_id = ?')
        .run(status, now, userId);
    } else {
      db.prepare('INSERT INTO xhs_accounts (user_id, status, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run(userId, status, now, now);
    }
  } catch { /* 表可能尚未创建（JSON 模式由 db.mjs 保证存在） */ }
}

// 解除绑定：删除该用户隔离 cookie 文件 + 清除 xhs_accounts 记录（仅影响当前用户）
export function deleteXhsAccount(db, userId) {
  if (!userId) return;
  try {
    const p = userCookieFile(userId);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch { /* ignore */ }
  if (db) {
    try { db.prepare('DELETE FROM xhs_accounts WHERE user_id = ?').run(userId); } catch { /* ignore */ }
  }
}

// 绑定前清空 MCP 全局 cookie（让出码干净，不残留前任用户登录态）
export async function prepareBind(userId) {
  const id = () => Math.floor(Math.random() * 1e9);
  await mcpPost({
    jsonrpc: '2.0', id: id(), method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'offerdao', version: '1.0' } },
  }).catch(() => {});
  const raw = await mcpPost({
    jsonrpc: '2.0', id: id(), method: 'tools/call',
    params: { name: 'prepare_bind', arguments: { userId: String(userId) } },
  });
  return extractText(raw);
}

// 扫码成功后，把 MCP 全局 cookie 落盘到当前用户隔离文件
export async function commitUserCookie(userId) {
  const id = () => Math.floor(Math.random() * 1e9);
  await mcpPost({
    jsonrpc: '2.0', id: id(), method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'offerdao', version: '1.0' } },
  }).catch(() => {});
  const raw = await mcpPost({
    jsonrpc: '2.0', id: id(), method: 'tools/call',
    params: { name: 'commit_user_cookie', arguments: { userId: String(userId) } },
  });
  return extractText(raw);
}

// 读取项目根 .env（幂等，确保 DASHSCOPE_API_KEY 就绪）
function loadDotEnv() {
  const p = path.resolve(__dirname, '../.env');
  if (!fs.existsSync(p)) return;
  try {
    const txt = fs.readFileSync(p, 'utf8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch { /* ignore */ }
}
loadDotEnv();

// 使用 127.0.0.1 而非 localhost：Node fetch 会把 localhost 优先解析为 IPv6(::1)，
// 而 MCP 服务仅监听 IPv4(0.0.0.0)，导致连接被拒、搜索静默返回空。
const XHS_MCP = process.env.XHS_MCP_URL || 'http://127.0.0.1:18060/mcp';
const QWEN_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';

// 1 小时内存缓存，避免重复消耗 token
const cache = new Map();
const CACHE_TTL = 60 * 60 * 1000;

// 小红书搜索结果（feed 列表）与笔记详情的内存缓存，避免重复爬取
const xhsFeedCache = new Map();
const xhsDetailCache = new Map();
const XHS_FEED_CACHE_TTL = 30 * 60 * 1000;

// GitHub Trending 抓取结果缓存（10 分钟，避免频繁请求被限流）
const trendingCache = new Map();
const TRENDING_CACHE_TTL = 10 * 60 * 1000;

const TYPE_ICON = { read: '📖', video: '▶️', code: '💻', homework: '✏️' };

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

// ---------- 千问调用（qwen-turbo） ----------
// timeoutMs：单次调用超时（毫秒）。调用方可按需传入更大值以拿到真实 LLM 返回，
// 而非被快速 abort 降级到规则路线。默认读取 QWEN_TIMEOUT_MS，兜底 15s。
export async function callQwen(system, user, model, timeoutMs) {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) throw new Error('未配置 DASHSCOPE_API_KEY，已回退规则模板');
  const m = model || process.env.QWEN_MODEL || 'qwen-turbo';
  // qwen-flash 等模型在 response_format=json_object 时，会强制校验 messages 中必须包含 "json" 字样，
  // 否则返回 400（'messages' must contain the word 'json'）。这里统一兜底，确保通过校验。
  let userContent = user || '';
  if (!/json/i.test(`${system}\n${userContent}`)) {
    userContent = `${userContent}\n请以 JSON 格式输出。`.trim();
  }
  // 整体预算控制在 5 分钟内：单次调用限时（默认 15s，可由调用方按需放大到 60s），
  // 不重试（避免单步耗时翻倍拖垮总时长），超时即抛错由调用方降级（规则模板）。
  const MAX_RETRY = 1;
  const CALL_TIMEOUT = Number(timeoutMs || process.env.QWEN_TIMEOUT_MS || 15000);
  let lastErr;
  for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT);
    try {
      const res = await fetch(QWEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: m,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: userContent },
          ],
          temperature: 0.4,
          response_format: { type: 'json_object' },
        }),
        signal: controller.signal,
      });
      if (res.status === 429) {
        // 限流：指数退避后重试（3s / 6s / 12s）
        clearTimeout(timer);
        const wait = (attempt + 1) * 3000;
        console.warn(`[callQwen] 429 限流，第 ${attempt + 1} 次重试，等待 ${wait}ms（model=${m}）`);
        await new Promise((r) => setTimeout(r, wait));
        lastErr = new Error('千问接口 429: 请求频率超限');
        continue;
      }
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`千问接口 ${res.status}: ${t.slice(0, 200)}`);
      }
      const json = await res.json();
      return json?.choices?.[0]?.message?.content || '';
    } catch (e) {
      clearTimeout(timer);
      // 超时（AbortError）也重试，其余（含已抛出的非429错误）不再重试
      if (e.name === 'AbortError' && attempt < MAX_RETRY - 1) {
        console.warn(`[callQwen] 请求超时，第 ${attempt + 1} 次重试（model=${m}）`);
        lastErr = e;
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error('千问接口调用失败');
}

// ---------- 小红书 MCP 调用 ----------
async function mcpPost(payload, timeoutMs = 90000) {
  // 用 Promise.race + setTimeout 做硬超时兜底：Node 22 的 AbortSignal.timeout 在某些
  // MCP(fetch SSE) 场景下不会真正中断挂起的 fetch，导致调用永久 pending、事件循环被占满。
  const controller = new AbortController();
  const fetchPromise = fetch(XHS_MCP, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify(payload),
    signal: controller.signal,
  });
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => {
      controller.abort();
      reject(new Error('MCP_TIMEOUT after ' + timeoutMs + 'ms'));
    }, timeoutMs);
  });
  const res = await Promise.race([fetchPromise, timeoutPromise]);
  return res.text();
}

function extractText(raw) {
  let text = '';
  if (raw.includes('data:')) {
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const j = safeJson(t.slice(5).trim());
      const c = j?.result?.content;
      if (Array.isArray(c)) text += c.map((x) => x.text || '').join('\n');
    }
  } else {
    const j = safeJson(raw);
    const c = j?.result?.content;
    if (Array.isArray(c)) text = c.map((x) => x.text || '').join('\n');
  }
  return text || raw;
}

// 针对「AI 产品经理」等岗位，注入明确的防混淆约束：聚焦 AI 产品方向核心能力，
// 排除平面/视觉设计软件（如 Adobe Illustrator）作为学习内容，并厘清岗位边界。
function buildGuard(keyword) {
  const kw = String(keyword || '');
  const isAiPm =
    /ai\s*产品|人工智能\s*产品|大模型\s*产品|产品\s*经理.*ai|产品\s*经理.*大模型/.test(kw.toLowerCase()) ||
    (/ai/.test(kw.toLowerCase()) && /产品/.test(kw));
  if (!isAiPm) return '';
  return (
    '【重要约束·AI 产品经理方向】' +
    '1) 学习内容必须聚焦「AI/大模型产品经理」的核心能力：AI 与大模型基础认知、需求分析与场景挖掘、' +
    '产品设计与 PRD、数据指标与 AB 实验、项目管理与跨团队协作、AI 产品落地与评测等。' +
    '2) 严禁把平面/视觉设计软件（如 Adobe Illustrator、Photoshop 等）当作本路线的学习教程或必学工具。' +
    '3) 不要混淆概念：AI 产品经理 ≠ 视觉/UI 设计师（不要求精通设计软件），≠ 算法工程师（不要求手写模型/调参）。' +
    '本路线以「懂 AI、会定义产品、能落地」为目标，工具层面以文档协作、原型、数据分析类工具为主。'
  );
}

// 将 MCP 搜索返回的 feeds 文本解析为统一结构（含 id/xsecToken 以便抓详情）
function parseFeeds(text) {
  const tryParse = (s) => {
    if (!s) return null;
    const j = safeJson(s);
    if (Array.isArray(j)) return j;
    if (j && Array.isArray(j.feeds)) return j.feeds;
    if (j && j.data && Array.isArray(j.data.feeds)) return j.data.feeds;
    return null;
  };
  let arr = tryParse(text.trim());
  if (!arr) {
    const arrMatch = text.match(/\[[\s\S]*\]/);
    if (arrMatch) arr = tryParse(arrMatch[0]);
  }
  if (!arr) {
    const objMatch = text.match(/\{[\s\S]*\}/);
    if (objMatch) arr = tryParse(objMatch[0]);
  }
  if (!arr) return [];

  const posts = [];
  for (const f of arr) {
    const id = f.id || f.noteId || '';
    if (!id) continue;
    const xsecToken = f.xsecToken || f.xsec_token || '';
    const title = f.title || f.displayTitle || '(无标题)';
    const author =
      (f.user && (f.user.nickname || f.user.userName)) || f.author || f.userName || '';
    const link =
      `https://www.xiaohongshu.com/explore/${id}` +
      (xsecToken ? `?xsec_token=${encodeURIComponent(xsecToken)}&xsec_source=pc_search` : '');
    posts.push({
      id,
      xsecToken,
      title,
      summary: f.desc || f.description || f.content || '',
      author,
      link,
      engagement: f.likeCount || f.likedCount || f.engagement || '',
      cover: f.cover || '',
      tags: [],
    });
  }
  return posts.slice(0, 20);
}

function tryExtractFeeds(text) {
  return parseFeeds(text);
}

export async function xhsSearch(keyword) {
  const id = () => Math.floor(Math.random() * 1e9);
  // 切换式隔离：操作前切到当前活跃用户自己的 cookie，保证只用该账号搜索
  await ensureUserCookie();
  // 无状态 Streamable HTTP：先 initialize（忽略结果），再 tools/call
  await mcpPost({
    jsonrpc: '2.0', id: id(), method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'offerdao', version: '1.0' } },
  }).catch(() => {});

  let raw = '';
  try {
    raw = await mcpPost({
      jsonrpc: '2.0', id: id(), method: 'tools/call',
      params: { name: 'search_feeds', arguments: { keyword, sortBy: 'hot' } },
    });
  } catch (e) {
    return { posts: [], raw: `小红书搜索失败：${e.message}`, needLogin: false };
  }

  const text = extractText(raw);
  // 优先解析结构化返回（MCP 直接给出 needLogin 信号），避免靠正则误判
  const structured = safeJson(text);
  if (structured && typeof structured === 'object' && 'needLogin' in structured) {
    const posts = Array.isArray(structured.posts) ? tryExtractFeeds(JSON.stringify(structured.posts)) : [];
    const searchStatus = (posts && posts.length) ? 'success' : (structured.needLogin ? 'blocked' : 'empty');
    console.log('[XHS SEARCH]', JSON.stringify({ keyword, resultCount: posts.length, status: searchStatus, needLogin: !!structured.needLogin }));
    return { posts, raw: text || raw, needLogin: !!structured.needLogin, searchStatus };
  }
  if (/未登录|扫码|请使用.*登录|二维码/.test(text)) {
    return { posts: [], raw: text, needLogin: true };
  }
  if (/\u672a\u767b\u5f55|\u767b\u5f55\u5c0f\u7ea2\u4e66|\u626b\u7801\u767b\u5f55|\u4e8c\u7ef4\u7801/.test(text)) {
    return { posts: [], raw: text, needLogin: true };
  }
  const posts = tryExtractFeeds(text);
  const searchStatus = posts.length ? 'success' : 'empty';
  console.log('[XHS SEARCH]', JSON.stringify({ keyword, resultCount: posts.length, status: searchStatus, loginStatus: true }));
  return { posts, raw: text || raw, needLogin: false, searchStatus };
}

// ---------- 千问规划 ----------
function normalizeTask(t) {
  return {
    name: String(t.name || '学习任务'),
    duration: t.duration ? String(t.duration) : '30min',
    type: TYPE_ICON[t.type] ? t.type : 'read',
  };
}

function normalizeWeek(w, idx) {
  const week = idx + 1;
  const tasks = Array.isArray(w.tasks) ? w.tasks : [];
  const days = [];
  for (let d = 1; d <= 7; d++) {
    const found = tasks.find((t) => Number(t.day) === d);
    days.push({
      day: d,
      tasks: found && Array.isArray(found.tasks) ? found.tasks.map(normalizeTask) : [],
    });
  }
  return {
    week,
    topic: w.topic || `第${week}周`,
    goal: w.goal || '完成本周学习任务',
    status: 'pending',
    progress: 0,
    tasks: days,
  };
}

function defaultWeek(idx) {
  return {
    week: idx + 1,
    topic: `第${idx + 1}周`,
    goal: '自主安排学习任务',
    status: 'pending',
    progress: 0,
    tasks: Array.from({ length: 7 }, (_, i) => ({ day: i + 1, tasks: [] })),
  };
}

async function buildPlanWithLLM(keyword, weeks, xhs) {
  const xhsText = xhs.posts.length
    ? xhs.posts.map((p, i) => `${i + 1}. ${p.title} — ${p.summary || ''}`).join('\n')
    : (xhs.raw ? `（小红书返回内容：${xhs.raw.slice(0, 1000)}）` : '（未获取到小红书内容）');

  const system =
    '你是资深求职规划教练。请基于真实学习路线素材，为目标岗位求职者制定结构化周学习计划。' +
    '只输出 JSON，结构为：{"summary":"整体规划思路(2-4句)","plan":[{"week":1,"topic":"阶段主题","goal":"本周目标",' +
    '"tasks":[{"day":1,"tasks":[{"name":"任务名","duration":"分钟数+min","type":"read|video|code|homework"}]}]}]}。' +
    `共${weeks}周，每周7天，任务要具体可执行、循序渐进。` +
    (buildGuard(keyword) ? '\n' + buildGuard(keyword) : '');

  const user =
    `目标岗位：${keyword}\n学习总周数：${weeks} 周\n\n` +
    `小红书搜到的真实学习路线素材：\n${xhsText}\n\n` +
    `请据此为「${keyword}」制定 ${weeks} 周学习计划，每阶段循序渐进，任务细化到每天并可执行。`;

  let content = '';
  try {
    content = await callQwen(system, user, undefined, 60000);
  } catch (e) {
    // LLM 网络异常时继续走后面的规则兜底，保证整合学习计划仍可生成。
    console.warn('[plan/integrated] LLM 调用失败，使用规则路线:', e.message);
  }
  const parsed = safeJson((content.match(/\{[\s\S]*\}/) || [content])[0]) || {};
  const plan = Array.isArray(parsed.plan)
    ? parsed.plan.map(normalizeWeek).slice(0, weeks)
    : [];
  while (plan.length < weeks) plan.push(defaultWeek(plan.length));

  // 注意：buildPlanFromText 用于「仅 RAG / 无真实小红书素材」分支，绝不可谎称「已结合小红书」。
  // summary 必须如实反映来源，杜绝静默冒充。
  const summaryFallback =
    sourceLabel && /小红书/.test(sourceLabel)
      ? `已结合小红书学习路线，为「${keyword}」制定 ${weeks} 周学习计划。`
      : `已基于本地 RAG 知识库 + 大模型预测，为「${keyword}」制定 ${weeks} 周学习计划（未连接小红书）。`;
  return {
    summary: parsed.summary || summaryFallback,
    plan,
  };
}

// ---------- 整合学习路线：真实帖子素材（答案A）+ 通用知识（答案B）→ 整合（答案C） ----------
async function buildPlanFromText(keyword, weeks, sourceLabel, postsText) {
  const system =
    '你是资深求职规划教练。请基于提供的学习素材，为目标岗位求职者制定结构化周学习计划。' +
    '只输出 JSON，结构为：{"summary":"整体规划思路(2-4句)","plan":[{"week":1,"topic":"阶段主题","goal":"本周目标",' +
    '"tasks":[{"day":1,"tasks":[{"name":"任务名","duration":"分钟数+min","type":"read|video|code|homework"}]}]}]}。' +
    `共${weeks}周，每周7天，任务要具体可执行、循序渐进。` +
    (buildGuard(keyword) ? '\n' + buildGuard(keyword) : '');
  const user =
    `目标岗位：${keyword}\n学习总周数：${weeks} 周\n\n` +
    `${sourceLabel}\n${postsText}\n\n` +
    `请据此为「${keyword}」制定 ${weeks} 周学习计划，每阶段循序渐进，任务细化到每天并可执行。`;
  const content = await callQwen(system, user);
  const parsed = safeJson((content.match(/\{[\s\S]*\}/) || [content])[0]) || {};
  const plan = Array.isArray(parsed.plan)
    ? parsed.plan.map(normalizeWeek).slice(0, weeks)
    : [];
  while (plan.length < weeks) plan.push(defaultWeek(plan.length));
  return { summary: parsed.summary || '', plan };
}

async function integratePlans(keyword, weeks, answerA, answerB) {
  const system =
    '你是资深求职规划教练。请将两份学习计划整合成一份最优、去重、互补、循序渐进的周学习计划。' +
    '只输出 JSON，结构为：{"summary":"整合思路(2-4句)","plan":[{"week":1,"topic":"阶段主题","goal":"本周目标",' +
    '"tasks":[{"day":1,"tasks":[{"name":"任务名","duration":"分钟数+min","type":"read|video|code|homework"}]}]}]}。' +
    `共${weeks}周，每周7天。` +
    (buildGuard(keyword) ? '\n' + buildGuard(keyword) : '');
  const user =
    `目标岗位：${keyword}\n\n` +
    `方案A（基于用户保存的真实帖子素材）：\n${JSON.stringify(answerA)}\n\n` +
    `方案B（基于通用专业知识）：\n${JSON.stringify(answerB)}\n\n` +
    `请整合以上两份方案，去重互补，输出一份完整、可执行的学习路线。`;
  const content = await callQwen(system, user);
  const parsed = safeJson((content.match(/\{[\s\S]*\}/) || [content])[0]) || {};
  const plan = Array.isArray(parsed.plan)
    ? parsed.plan.map(normalizeWeek).slice(0, weeks)
    : [];
  while (plan.length < weeks) plan.push(defaultWeek(plan.length));
  return { summary: parsed.summary || '已结合真实帖子素材与通用知识整合为一份学习路线。', plan };
}

// 整合学习路线：把用户保存的帖子「正文 + 图片转文字」整合为一段，再交给大模型（结合通用知识）生成周计划
function formatPlanDate(startDateStr, offsetDays) {
  const base = /^\d{4}-\d{2}-\d{2}$/.test(String(startDateStr || ''))
    ? new Date(`${startDateStr}T00:00:00`)
    : new Date();
  if (Number.isNaN(base.getTime())) return '';
  base.setDate(base.getDate() + offsetDays);
  const y = base.getFullYear();
  const m = String(base.getMonth() + 1).padStart(2, '0');
  const d = String(base.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function cleanTaskText(value, fallback = '') {
  return String(value || fallback).replace(/\s+/g, ' ').trim();
}

// 秒 -> "H:MM:SS" / "M:SS"，用于无分P视频的时间段定位
function clockLabel(sec) {
  const total = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// B站带定位参数的播放链接：
//   分P    -> https://www.bilibili.com/video/BVxxx?p=3
//   时间点 -> https://www.bilibili.com/video/BVxxx?t=1200
function biliLinkAt(link, { page, startSec } = {}) {
  const base = String(link || '');
  if (!base) return '';
  const params = [];
  if (page && Number(page) > 1) params.push(`p=${Number(page)}`);
  if (startSec && Number(startSec) > 0) params.push(`t=${Math.floor(Number(startSec))}`);
  if (!params.length) return base;
  return base + (base.includes('?') ? '&' : '?') + params.join('&');
}

// 把一个板块的视频按「分配到的天数」切成 N 份可执行的观看单元。
// 优先级：真实分P（贪心按时长均衡合并连续P） > 按总时长平均切时间段 > 整段兜底。
// 返回：[{ chapters: string[], link: string, minutes: number }]，长度恰为 slots。
function sliceSectionVideo(section, slots) {
  const n = Math.max(1, Number(slots) || 1);
  const link = section.link || '';
  const parts = Array.isArray(section.parts) ? section.parts.filter((p) => p && Number(p.page) > 0) : [];
  const totalSec = Number(section.durationSec) || 0;

  // 情况一：有真实分P —— 按累计时长均衡地把连续 P 分到每一天
  if (parts.length) {
    // 双重均衡：既看时长，也看 P 数量，避免「某天 2 个 P、另一天 29 个 P」。
    // 给每个 P 一个综合权重 = 时长占比 与 个数占比 的平均，再按累计权重顺序切成 n 份。
    const durTotal = parts.reduce((s, p) => s + (Number(p.durationSec) || 0), 0);
    const weights = parts.map((p) => {
      const wDur = durTotal > 0 ? (Number(p.durationSec) || 0) / durTotal : 1 / parts.length;
      const wCnt = 1 / parts.length;
      return (wDur + wCnt) / 2;
    });
    const perSlot = 1 / n;
    const buckets = Array.from({ length: n }, () => []);
    let acc = 0;
    parts.forEach((p, i) => {
      // 用「区间中点」判定归属，避免边界 P 全被挤到同一天
      const mid = acc + weights[i] / 2;
      const idx = Math.min(n - 1, Math.floor(mid / perSlot));
      buckets[idx].push(p);
      acc += weights[i];
    });
    // 兜底：若某天为空（P 数少于天数），从 P 最多的一天借一个，避免出现空任务
    for (let i = 0; i < n; i++) {
      if (buckets[i].length) continue;
      const donor = buckets.reduce((best, b, j) => (b.length > buckets[best].length ? j : best), 0);
      if (buckets[donor].length > 1) buckets[i].push(buckets[donor].pop());
    }
    return buckets.map((bucket) => {
      if (!bucket.length) {
        return { chapters: ['复习本板块已看分P，补齐笔记'], link, minutes: 45 };
      }
      const minutes = Math.max(
        20,
        Math.round(bucket.reduce((s, p) => s + (Number(p.durationSec) || 0), 0) / 60) || 45
      );
      const chapters = bucket.slice(0, 3).map((p) => `P${p.page}${p.part ? ' ' + p.part : ''}`);
      if (bucket.length > 3) chapters.push(`…共 ${bucket.length} 个分P（P${bucket[0].page}-P${bucket[bucket.length - 1].page}）`);
      return { chapters, link: biliLinkAt(link, { page: bucket[0].page }), minutes };
    });
  }

  // 情况二：无分P但有总时长 —— 按时间段平均切
  if (totalSec > 0) {
    const seg = Math.ceil(totalSec / n);
    return Array.from({ length: n }, (_, i) => {
      const start = i * seg;
      const end = Math.min(totalSec, (i + 1) * seg);
      return {
        chapters: [`观看 ${clockLabel(start)} - ${clockLabel(end)} 片段`],
        link: biliLinkAt(link, { startSec: start }),
        minutes: Math.max(20, Math.round((end - start) / 60) || 45),
      };
    });
  }

  // 情况三：既无分P也无时长
  return Array.from({ length: n }, () => ({
    chapters: [cleanTaskText(section.content, '完成本板块核心资料学习')],
    link,
    minutes: 60,
  }));
}

// ---------- 学习预算裁剪接入层（仅排期层，不动 B站/小红书/评分/PDF/技能体系） ----------
// 目标：让 Learning Budget 真正约束最终学习计划。
// 链路：resources →（按 skillBudget 调用 selectResourcesByBudget）→ buildSystemDailyTasks → dailyPlan
//
// 规则：
//  1. 每个技能的资源总分钟数不超过 skillBudget.minutes。
//  2. selectResourcesByBudget 内部已按 resourcePriority 降序贪心保留（高优先级优先）。
//  3. 资源不足时只记录缺口（budgetGaps），不补充额外任务。
//  4. 一个资源若被多个技能命中，只要任一技能预算保留它，就保留（并集，避免共享资源被误删）。
function applyLearningBudgetToResources(matched, learningBudget) {
  if (!matched || !learningBudget) {
    return { matched, budgetGaps: [] };
  }
  // skillBudget 既可能是数组（[{skill,minutes,...}]）也可能是对象（{skill:{minutes,...}}），统一归一化。
  const skillMap = new Map(); // skillName -> { minutes }
  const raw = learningBudget.skillBudget;
  if (Array.isArray(raw)) {
    for (const sb of raw) {
      if (sb && sb.skill && typeof sb.minutes === 'number') skillMap.set(sb.skill, sb);
    }
  } else if (raw && typeof raw === 'object') {
    for (const [skillName, sb] of Object.entries(raw)) {
      if (sb && typeof sb.minutes === 'number') skillMap.set(skillName, { skill: skillName, ...sb });
    }
  }
  if (!skillMap.size) return { matched, budgetGaps: [] };

  const videoResources = Array.isArray(matched.videoResources) ? matched.videoResources : [];
  const pdfResources = Array.isArray(matched.pdfResources) ? matched.pdfResources : [];

  // ---- 视频：参与分钟预算裁剪（有 durationSec，可折算学习时间）----
  const videoAll = videoResources.filter((r) => r && Array.isArray(r.skills) && r.skills.length);
  const videoSkillOf = new Map();
  for (const r of videoAll) {
    if (!videoSkillOf.has(r)) videoSkillOf.set(r, new Set());
    for (const s of r.skills) if (skillMap.has(s)) videoSkillOf.get(r).add(s);
  }

  const videoKeepBySkill = new Map();
  const usedBySkill = new Map();
  for (const [skillName, sb] of skillMap) {
    const perSkill = videoAll.filter((r) => (videoSkillOf.get(r) || new Set()).has(skillName));
    const picked = selectResourcesByBudget(perSkill, sb.minutes);
    videoKeepBySkill.set(skillName, new Set(picked));
    const PER_ITEM_CAP = 120;
    const used = picked.reduce((sum, r) => {
      const raw = Math.round((Number(r.durationSec) || Number(r.minutes) || 0) / 60) || 0;
      return sum + Math.min(PER_ITEM_CAP, raw);
    }, 0);
    usedBySkill.set(skillName, used);
  }
  const videoKeepSet = new Set();
  for (const set of videoKeepBySkill.values()) for (const r of set) videoKeepSet.add(r);
  const trimmedVideo = videoResources.filter(
    (r) => videoKeepSet.has(r) || !(videoSkillOf.get(r) && videoSkillOf.get(r).size)
  );

  // ---- PDF：不参与分钟预算（无 durationSec/minutes，无法折算学习时间）----
  // 仅做数量控制：按 relevance 降序，每个 skill 最多保留 10 个。
  const PDF_PER_SKILL_CAP = 10;
  const pdfAll = pdfResources.filter((r) => r && Array.isArray(r.skills) && r.skills.length);
  const pdfBySkill = new Map(); // skillName -> [pdf]
  for (const r of pdfAll) {
    const rel = Number(r.relevance_score || r.relevance || 0);
    for (const s of r.skills) {
      if (!skillMap.has(s)) continue;
      if (!pdfBySkill.has(s)) pdfBySkill.set(s, []);
      pdfBySkill.get(s).push(r);
    }
  }
  const selectedPdfs = new Set();
  for (const [skillName, list] of pdfBySkill) {
    const sorted = list.sort(
      (a, b) => Number(b.relevance_score || b.relevance || 0) - Number(a.relevance_score || a.relevance || 0)
    );
    for (const r of sorted.slice(0, PDF_PER_SKILL_CAP)) selectedPdfs.add(r);
  }
  // 未被任何 skill 命中的 PDF（如跨技能文档）也直接保留，避免误删。
  const trimmedPdf = pdfResources.filter((r) => selectedPdfs.has(r) || !(r && Array.isArray(r.skills) && r.skills.length));

  // 缺口记录：仅记录，不补充。
  const budgetGaps = [];
  for (const [skillName, sb] of skillMap) {
    const used = usedBySkill.get(skillName) || 0;
    const gap = Math.max(0, sb.minutes - used);
    budgetGaps.push({ skill: skillName, budgetMinutes: sb.minutes, usedMinutes: used, gapMinutes: gap });
  }

  return {
    matched: { ...matched, videoResources: trimmedVideo, pdfResources: trimmedPdf },
    budgetGaps,
  };
}

function buildSystemDailyTasks(sections, totalDays, startDateStr) {
  const usableSections = Array.isArray(sections)
    ? sections.filter((s) => s && cleanTaskText(s.title))
    : [];
  if (!usableSections.length) return [];

  const daysCount = Math.max(1, Number(totalDays) || 1);

  // 1) 天数在板块间连续分配：板块 i 拿到 [start, end) 这段连续的天，保证学习顺序。
  // P1：若板块带 weight（来自技能权重分配），按权重比例分配天数，让 Agent/RAG 等高权重技能
  //     获得更多学习时间；无 weight 时回退为均分（保持旧行为）。
  const hasWeight = usableSections.some((s) => typeof s.weight === 'number' && s.weight > 0);
  let allocation;
  if (hasWeight) {
    const weights = usableSections.map((s) => (typeof s.weight === 'number' && s.weight > 0 ? s.weight : 0.01));
    const wSum = weights.reduce((a, b) => a + b, 0);
    // 先按权重比例得整数基数，余数（1天）优先补给权重最高的板块
    const raw = weights.map((w) => (w / wSum) * daysCount);
    const floorAlloc = raw.map((r) => Math.floor(r));
    let remain = daysCount - floorAlloc.reduce((a, b) => a + b, 0);
    const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac);
    allocation = floorAlloc.slice();
    let oi = 0;
    while (remain > 0 && oi < order.length) { allocation[order[oi].i] += 1; remain--; oi++; }
    if (remain > 0) { // 极端情况（权重全为0）兜底均分
      const base = Math.floor(daysCount / usableSections.length);
      const extra = daysCount % usableSections.length;
      allocation = usableSections.map((_, i) => base + (i < extra ? 1 : 0));
    }
  } else {
    const base = Math.floor(daysCount / usableSections.length);
    const extra = daysCount % usableSections.length;
    allocation = usableSections.map((_, i) => base + (i < extra ? 1 : 0));
  }

  // 2) 每个板块内部：先按分P/时间段切出「看视频」单元，最后一天留给整理+验收。
  const dayPlans = [];
  usableSections.forEach((section, sIdx) => {
    const slots = allocation[sIdx];
    if (slots <= 0) return;
    // 板块天数 >= 3 时，留最后 1 天做「整理 + 验收」，其余天看视频
    const reviewDays = slots >= 3 ? 1 : 0;
    const watchDays = Math.max(1, slots - reviewDays);
    const units = sliceSectionVideo(section, watchDays);

    for (let i = 0; i < watchDays; i++) {
      const u = units[i] || units[units.length - 1];
      dayPlans.push({
        section,
        type: 'learn',
        title: `学习「${section.title}」${u.chapters[0] ? '·' + String(u.chapters[0]).slice(0, 24) : '核心资料'}`,
        chapters: u.chapters,
        link: u.link,
        // 每日学习时长统一为 240~300 分钟（目标 270），与 dailyPlanGenerator 的每日学习时间约束保持一致，
        // 避免「集成预览每天1小时 / 生产计划每天4小时」的展示冲突。
        minutes: Math.max(240, Math.min(300, u.minutes)),
      });
    }
    for (let i = 0; i < reviewDays; i++) {
      dayPlans.push({
        section,
        type: 'check',
        title: `整理并验收「${section.title}」`,
        chapters: [
          '把本板块分P笔记整合成一张知识框架图',
          '围绕本板块做一个可展示的小练习',
          '用 3 条标准自查掌握情况，补齐薄弱点',
        ],
        link: section.link || '',
        minutes: 270,
      });
    }
  });

  // 3) 落到具体日期
  return Array.from({ length: daysCount }, (_, dayIndex) => {
    const p = dayPlans[dayIndex] || dayPlans[dayPlans.length - 1];
    const section = p ? p.section : usableSections[dayIndex % usableSections.length];
    return {
      day: dayIndex + 1,
      date: formatPlanDate(startDateStr, dayIndex),
      tasks: [
        {
          id: `day-${dayIndex + 1}-section-${section.part || dayIndex + 1}-${p ? p.type : 'learn'}`,
          title: p ? p.title : `学习「${section.title}」核心资料`,
          sectionPart: Number(section.part) || null,
          link: p ? p.link : (section.link || ''),
          chapters: (p ? p.chapters : [cleanTaskText(section.content, '完成核心资料学习')]).slice(0, 4),
          estimatedMinutes: p ? p.minutes : 60,
          type: p ? p.type : 'learn',
          status: 'pending',
          carryOverCount: 0,
          source: 'system',
        },
      ],
    };
  });
}

export async function generateIntegratedPlan(keyword, days, storedPosts, opts = {}) {
  const t0 = Date.now();
  const stage = (s) => console.log(`[integrated] ${s} +${Date.now() - t0}ms`);
  stage('start');
  const db = opts.db || null;
  const weeks = Math.max(1, Math.min(26, Math.ceil((Number(days) || 60) / 7)));
  const totalDays = Math.max(1, Number(days) || weeks * 7);
  let posts = [];
  let fetchedPosts = [];
  let xhsNeedLogin = false;
  let xhsSearchStatus = 'empty';
  // 重新生成（autoFetch）时：不预填旧帖，强制实时抓取最新帖子；若抓取失败则明确降级为 RAG 模式，
  // 绝不沿用旧的 xhs_post_contents 冒充「本次更新」，避免用户看到「参考资料没更新」的误导。
  // 仅在用户显式不重新抓取（非 autoFetch 且未跳过）时，才回退使用已保存帖子。
  if (!opts.autoFetch && !opts.skipXhs) {
    posts = Array.isArray(storedPosts) ? storedPosts.slice(0, 6) : [];
  }

  // 未保存帖子时，自动按「目标岗位 + 学习路线」去小红书搜索 3 篇帖子并抓取到本地。
  // 以下任一情况则不抓取、直接走「仅 RAG + 大模型预测」模式：
  //   - opts.skipXhs（用户选择不登录小红书）
  //   - 用户已点击登录但仍未成功（前端会先确保登录，这里作为兜底）
  let xhsSkipped = false;
  if ((!posts.length || opts.autoFetch) && !opts.skipXhs) {
    try {
      // 岗位搜索词转换层（小红书）已在 searchXhsPosts 内部完成，此处传入纯岗位名即可
      stage('xhs search begin');
      const search = await searchXhsPosts(keyword);
      stage('xhs search done');
      const feeds = Array.isArray(search.posts) ? search.posts : [];
      xhsSearchStatus = search.searchStatus || (feeds.length ? 'success' : 'empty');
      // 未真正抓到帖子（未登录 / 接口无结果）：明确降级为 RAG 模式，杜绝「冒充已结合小红书」的误导来源说明
      if (!feeds.length || search.needLogin) {
        xhsSkipped = true;
        xhsNeedLogin = !!search.needLogin;
      } else {
        const want = Math.min(opts.count || 3, feeds.length);
        stage(`xhs detail x${want} parallel begin`);
        // 并行抓取多篇详情（单篇失败/超时不影响其他），每篇最多 45s，尽量拿到真实正文/图片文字，
        // 超时（如帖子需登录、限流）才兜底为空，不阻塞整体
        const DETAIL_TIMEOUT = Number(process.env.XHS_DETAIL_TIMEOUT_MS || 45000);
        const details = await Promise.all(feeds.slice(0, want).map((feed) =>
          Promise.race([
            getXhsPostDetail(feed.id, feed.xsecToken || ''),
            new Promise((res) => setTimeout(() => res({ content: '', ocrText: '' }), DETAIL_TIMEOUT)),
          ]).catch(() => ({ content: '', ocrText: '' }))
        ));
        stage(`xhs detail x${want} parallel done`);
        details.forEach((detail, i) => {
          const feed = feeds[i];
          fetchedPosts.push({
            id: feed.id || undefined,
            xsecToken: feed.xsecToken || undefined,
            title: feed.title || (detail.content ? detail.content.slice(0, 30) : `帖子${i + 1}`),
            link: feed.link || feed.url || '',
            author: feed.author || '',
            engagement: feed.engagement || '',
            cover: feed.cover || '',
            content: detail.content || '',
            ocrText: detail.ocrText || '',
          });
        });
        if (!posts.length) xhsSkipped = true;
        // 合并「手动已存帖子(storedPosts)」与「本次自动抓取(fetchedPosts)」，去重后上限 6 篇。
        // 这样用户手动搜的 + 计划自动搜的都会进入学习计划、技能树与 RAG，而非互相覆盖。
        if (fetchedPosts.length) {
          // 本次真实抓取成功后，学习计划只使用本次返回的帖子，替换旧缓存参考资料。
          // 抓取失败时才保留 storedPosts，避免旧资料冒充本次实时结果。
          posts = fetchedPosts.slice(0, 6);
        }
        // 整体截断到 6 篇（手动存的可能已满 6，合并后仍需保证上限）
        if (posts.length > 6) posts = posts.slice(0, 6);
      }
    } catch (e) {
      // 抓取失败（如未登录 / 接口异常）时，降级为仅 RAG 模式，而不是整体报错
      console.warn('[plan] 小红书自动抓取失败，降级为仅 RAG 模式:', e.message);
      xhsSkipped = true;
      posts = posts.length ? posts : [];
    }
  } else if (opts.skipXhs) {
    xhsSkipped = true;
  }

  // 无任何小红书素材时（跳过 / 抓取失败 / 无已存帖子）：以「RAG 知识库 + 大模型预测」方式规划
  if (!posts.length) {
    xhsSkipped = true;
  }
  // 将每篇帖子的「正文」与「图片转文字」整合为一段连续文本
  const postsText = posts
    .map((p, i) => {
      const parts = [];
      if (p.content) parts.push(p.content);
      if (p.ocrText) parts.push('（图片中的文字）\n' + p.ocrText);
      const body = parts.filter(Boolean).join('\n\n');
      return `【帖子${i + 1}】${p.title || '(无标题)'}\n${body}`;
    })
    .join('\n\n');

  // 把本次抓取的小红书帖子灌进本地 RAG（source=xhs），使后续 RAG 检索能同时覆盖
  // 「产品经理知识库」与「本次经验贴」。索引失败不影响主流程（catch 兜底）。
  const toIngest = (fetchedPosts && fetchedPosts.length ? fetchedPosts : posts).map((p) => {
    // 用帖子正文+链接生成稳定 docId（同一帖子每次生成 hash 一致，配合 force 覆盖，避免 RAG 无限累积）
    const idSeed = (p.link || '') + '::' + (p.title || '') + '::' + (p.content || '').slice(0, 80);
    const docId = 'xhs:' + Buffer.from(idSeed, 'utf8').toString('hex').slice(0, 40);
    return {
      docId,
      title: p.title || '(无标题)',
      content: [p.content || '', p.ocrText ? '（图片文字）\n' + p.ocrText : ''].filter(Boolean).join('\n\n'),
      source: 'xhs',
      ref: p.link || '',
      // 关键：打上目标岗位标签，保证 RAG 检索时按岗位隔离，避免不同岗位的路线串味
      meta: { link: p.link || '', title: p.title || '(无标题)', jobName: keyword },
    };
  }).filter((d) => d.content.trim());
  if (toIngest.length) {
    // 累积保留历史小红书帖子：不再清空 source=xhs，docId 由 链接+标题+正文前80字 稳定哈希生成，
    // 同一帖子每次生成 hash 一致，配合 force 覆盖更新，不同帖子自然累积多篇。
    // ingestDocument 单篇写入（需 docId），逐篇灌入本次小红书帖子
    for (const doc of toIngest) {
      try {
        await rag.ingestDocument(doc, { source: 'xhs', force: true });
      } catch (e) {
        console.error('[plan] 灌入单篇 RAG 帖子失败:', doc.docId, e.message);
      }
    }
  }

  // 去本地匹配 RAG：围绕「产品经理学习内容」+ 目标岗位 + 小红书素材要点，整体检索一次，
  // 得到真实知识库文档片段（ragContext），作为大模型阶段规划的参考资料（不编造内容）。
  stage('rag retrieve begin');
  const ragContext = await retrieveRagContext(keyword, postsText, posts).catch(() => []);
  stage('rag retrieve done');

  // ---------- 技能标准化主链路 ----------
  // 步骤 A：抽取技能树（含 category/level）
  //   - AI产品经理岗：直接返回固定目录 AI_PM_SKILL_MAP（零 LLM、零小红书，100% 可复现）。
  //     小红书 postsText 在此步骤【不参与】技能生成，仅作为步骤 C 的趋势感知层。
  //   - 其他岗位：LLM 兜底（已移除原「小红书正则补技能」越界逻辑）。
  let rawSkills = [];
  try {
    stage('skill-tree begin');
    rawSkills = await extractIntegratedSkillTree(keyword, postsText, ragContext);
    stage('skill-tree done');
  } catch (e) {
    console.warn('[plan] 整合链路技能抽取失败，降级为空技能树:', e.message);
    rawSkills = [];
  }
  // 步骤 B：技能标准化（统一叫法，保留 aliases，不跨技能合并）
  const skillTree = skillNormalizer.normalizeSkills({ job: keyword, skills: rawSkills });

  // 步骤 C：用 standard_name 检索真实资源（PDF 走 RAG 过滤，B站走 job+技能+类目场景）
  // 小红书趋势扩展：从已抓取的小红书帖子提取新工具/新表达，匹配到固定技能，
  // 仅【补充】B站搜索词（固定词在前、不可被覆盖）。同时注入评分缓存 store 降低重复计算。
  let xhsTrends = [];
  try {
    const allSkills = skillResourceMatcher.extractStandardSkills(skillTree);
    // 读取历史累计趋势（xhs_trend_keywords），与本次实时帖子合并，避免「本次没抓到→趋势消失」
    const history = opts.db ? loadXhsTrends(opts.db) : [];
    xhsTrends = skillResourceMatcher.extractTrendKeywordsFromXhs(posts || [], allSkills, history);
    if (xhsTrends.length) {
      console.log('[plan] 小红书趋势词(累计):', xhsTrends.map((t) => `${t.keyword}(${t.skill},tot=${t.totalCount},rec=${t.recentCount},ts=${t.trendScore})`).join(' '));
      upsertXhsTrendKeywords(opts.db, xhsTrends); // 累计持久化到 xhs_trend_keywords 表
      // P1：小红书趋势微调技能权重（仅上调，单个技能最多 +20%，避免热点完全改变学习路线）
      applyTrendWeightBoost(skillTree, xhsTrends);
    }
  } catch (e) {
    console.warn('[plan] 提取小红书趋势词失败，按纯固定词搜索:', e.message);
  }
  // ---------- Learning Budget Manager（新增计算层，不修改资源匹配逻辑）----------
  // 在「已微调权重」的 skillTree 基础上，计算 days × dailyMinutes 的总预算及阶段/技能分配。
  // 预算仅用于后续「按预算裁剪资源数量」，不改变匹配/评分/趋势任何逻辑。
  let learningBudget = null;
  try {
    const budgetDays = Math.max(1, Number(opts.days) || Number(days) || totalDays);
    learningBudget = computeLearningBudget({
      days: budgetDays,
      dailyStudyTime: opts.dailyStudyTime,
      skillTree,
      trends: xhsTrends,
    });
    console.log('[plan] 学习预算:', JSON.stringify({
      days: learningBudget.days,
      dailyMinutes: learningBudget.dailyMinutes,
      totalMinutes: learningBudget.totalMinutes,
      stageMinutes: Object.fromEntries(Object.entries(learningBudget.stageBudget).map(([k, v]) => [k, v.minutes])),
    }));
    if (opts.db) {
      upsertLearningBudget(opts.db, {
        userId: opts.userId || null,
        planId: opts.planId || null,
        budget: learningBudget,
      });
    }
  } catch (e) {
    console.warn('[plan] 学习预算计算失败（不影响资源匹配）:', e.message);
  }

  const biliCacheStore = makeBiliCacheStore(opts.db);
  const biliSearchCacheStore = makeBiliSearchCacheStore(opts.db);
  stage('matchResources begin');
  let matched = await skillResourceMatcher.matchResources(
    skillTree,
    { job: keyword, trends: xhsTrends, cacheStore: biliCacheStore, searchCacheStore: biliSearchCacheStore }
  ).catch(() => ({
    skills: [], pdfResources: [], videoResources: [], coverage: { missing: [] },
  }));
  stage('matchResources done');

  // 预算裁剪接入：让 Learning Budget 真正约束最终学习计划（仅排期层，不动匹配逻辑）。
  let budgetGaps = [];
  if (learningBudget) {
    const trimmed = applyLearningBudgetToResources(matched, learningBudget);
    matched = trimmed.matched;
    budgetGaps = trimmed.budgetGaps || [];
    console.log('[plan] 预算裁剪完成，技能预算缺口:', JSON.stringify(budgetGaps.filter((g) => g.gapMinutes > 0).map((g) => ({ skill: g.skill, gap: g.gapMinutes }))));
  }

  const startDate = new Date();
  const startDateStr = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, '0')}-${String(startDate.getDate()).padStart(2, '0')}`;
  stage('buildCombinedPlan begin');
  const result = await buildCombinedPlan(
    keyword, skillTree, matched.pdfResources, matched.videoResources, ragContext
  ).catch((e) => ({
    summary: '',
    sections: [],
    error: e.message,
  }));
  stage('buildCombinedPlan done');
  if (result.error) throw new Error(result.error);

  const final = {
    source: 'integrated',
    llmFallback: !!result.llmFallback,
    summary: result.summary,
    sections: result.sections,
    skillTree, // 标准化后的技能树（含 standard_name / aliases / category / level / weight）
    learningBudget, // 【新增】Learning Budget Manager 计算结果（days×dailyMinutes 及阶段/技能预算分配）
    budgetGaps, // 【新增】技能预算缺口（仅记录，不补充）：每个技能 预算/已用/缺口 分钟数
    resourceCoverage: matched.coverage || { matched: [], missing: [] },
    dailyTasks: buildSystemDailyTasks(
      attachSectionWeights(result.sections, skillTree),
      totalDays,
      startDateStr
    ),
    xhsPosts: posts.map((p) => ({
      id: p.id || undefined,
      xsecToken: p.xsecToken || undefined,
      title: p.title || '(无标题)',
      link: p.link || '',
      content: (p.content || p.summary || '').toString(),
      author: p.author || '',
      engagement: p.engagement || '',
      cover: p.cover || '',
      images: Array.isArray(p.imageUrls) && p.imageUrls.length ? p.imageUrls : (p.cover ? [p.cover] : []),
      tags: Array.isArray(p.tags) ? p.tags : [],
    })).filter((p) => p.title && p.link),
    fetchedPosts,
    xhsSkipped: !!xhsSkipped,
    xhsNeedLogin,
    xhsSearchStatus,
    sourceNote: xhsSkipped
      ? (xhsNeedLogin
        ? '小红书登录不可用，已基于本地 RAG 知识库 + 大模型预测分析规划学习路线'
        : '小红书账号已登录，但本次未获取到相关帖子，已基于本地 RAG 知识库 + 大模型预测分析规划学习路线')
      : '已结合小红书真实帖子（正文 + 图片文字）与本地 RAG 知识库规划',
  };

  stage('done, returning');
  // 铁律兜底：凡真实可引用的小红书帖子数为 0，一律视为「未结合」，绝不谎报。
  // 防止任何路径（autoFetch 失败 / 旧 stored 数据 / 逻辑遗漏）导致 xhsSkipped 被错误置 false。
  if (final.xhsPosts.length === 0) {
    final.xhsSkipped = true;
    final.sourceNote = '未连接小红书，已基于本地 RAG 知识库 + 大模型预测分析规划学习路线（无真实小红书帖子）';
  }

  // 步骤 5.5：把已匹配的真实资源持久化到 matched_resources（资源缓存层），
  // 后续每日计划直接读缓存，不再重复调 B站搜索。此前 integrated 链路漏掉这一步，
  // 导致 matched_resources 始终为空（B站/PDF 资源未落库到缓存层）。
  if (db) {
    try {
      const persisted = skillResourceMatcher.persistMatchedResources(db, {
        planId: 'u' + (typeof keyword === 'string' ? keyword : 'x'),
        pdfResources: matched.pdfResources,
        videoResources: matched.videoResources,
      });
      final.cachedResources = persisted.saved;
    } catch (e) {
      console.warn('[plan/integrated] 资源缓存写入失败（不影响计划生成）:', e.message);
    }
  }

  return final;
}

// 围绕「产品经理学习内容」+ 目标岗位 + 小红书素材要点，整体检索本地 RAG 一次，
// 合并多个子查询的结果并去重，得到真实知识库文档片段集合（ragContext）。
// 这些片段随后与小红书素材一起作为大模型的参考资料，杜绝模型编造文档内容。
async function retrieveRagContext(keyword, postsText, posts) {
  // 用目标岗位 + 产品经理学习主题构造若干检索问句
  const queries = [
    `${keyword} 产品经理 学习路线`,
    '产品经理 核心能力 学习方法',
    '产品经理 入门 必学知识',
  ];
  // 从小红书素材里提取若干关键词（取每篇正文前若干字作为检索补充）
  const postHints = (Array.isArray(posts) ? posts : [])
    .map((p) => String(p.content || p.title || '').slice(0, 80))
    .filter(Boolean)
    .slice(0, 3);
  for (const h of postHints) queries.push(`${keyword} 产品经理 ${h}`);

  const seen = new Set();
  const merged = [];
  for (const q of queries) {
    const chunks = await rag.retrieve(q, { topK: 4, job: keyword }).catch(() => []);
    for (const c of chunks) {
      const key = String(c.content || '').slice(0, 60);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push({ content: String(c.content || ''), source: c.source || '', ref: c.ref || '', title: c.title || '', docId: c.docId || '', file: c.file || '' });
    }
  }
  // 截断总量，避免 prompt 过长
  return merged.slice(0, 24);
}

// 真实调用 B站搜索接口，返回指定岗位相关的「近四年内长视频」。
// 规则：仅保留近四年内发布的视频（pubdate 经 view 接口核验），并优先选择
// 满足学习时长要求的最高「播放量+收藏量」视频；若高时长档无近四年视频，
// 则逐级放宽时长（5h→1h→30min→10min）继续找近四年内的；全部缺失才如实返回空，绝不回退到超期视频。
// 硬性条件：视频必须含字幕（官方 / AI 自动 / UP主 CC 任意类型皆可，简介/章节信息作辅助），无字幕一律剔除。
// 链接全部来自 B站真实返回，绝不编造。
const BILI_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  Referer: 'https://www.bilibili.com/',
  Accept: 'application/json',
};

async function fetchBiliMeta(bvid) {
  try {
    const r = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
      headers: BILI_HEADERS,
      signal: AbortSignal.timeout(6000),
    });
    const j = await r.json();
    if (!j?.data) return { pubdate: 0, favorite: 0, parts: [] };
    // view 接口同时返回分P列表 data.pages[]：{ page, cid, part, duration }
    // 抽出来供「每日任务精确到第几P」使用；单P视频这里长度为 1，视为无分P。
    const rawPages = Array.isArray(j.data.pages) ? j.data.pages : [];
    const parts = rawPages.length > 1
      ? rawPages.map((p, i) => ({
          page: Number(p.page) || i + 1,
          cid: Number(p.cid) || 0,
          part: String(p.part || '').replace(/\s+/g, ' ').trim(),
          durationSec: Number(p.duration) || 0,
        }))
      : [];
    // 关键修复：无论单P/多P，都要取「主 cid」用于字幕核查与播放。
    // 之前只在多P时填 parts，导致单P视频 cid 恒为 0 → hasBiliPublicSubtitle 直接 return false → 全部被误判无字幕。
    const mainCid = Number(j.data.cid) || (rawPages[0] && Number(rawPages[0].cid)) || 0;
    return {
      pubdate: Number(j.data.pubdate) || 0,
      favorite: Number(j.data.stat?.favorite) || 0,
      parts,
      mainCid,
    };
  } catch {
    return { pubdate: 0, favorite: 0, parts: [] };
  }
}

// ===== B站字幕「可用性」校验（轻量模式：只判断「有没有能用的字幕」） =====
// 【职责下沉】自 2026-08 起，资源匹配阶段不再做「字幕内容相关性 / 关键词密度 / 跨P串号 /
// 合格率」等重分析。理由：
//   1) 真实教程的字幕不一定高频出现技能名（如标题《RAG企业知识库完整教程》字幕满是
//      「文档切片/向量检索/Embedding」却很少出现「RAG」），相关性命中率判断会误杀大量好视频。
//   2) 资源匹配阶段的唯一职责是「找到值得学习的视频并确认后续能生成笔记」，【不下载分P正文】、
//      不做深度内容分析，避免搜索耗时与计划生成时间被拖垮。
//   3) 真正的「哪一P 真正讲当前技能」筛查已下沉到【笔记生成阶段】（用户完成学习、点击生成笔记
//      时，按当前技能匹配 P 标题、取对应字幕、生成笔记），资源匹配阶段不该承担这部分职责。
// 因此本层只做两件事：① 真的下载一次主 cid 字幕正文确认非空（避免「字幕列表有、正文是占位」的
// 脏数据）；② 拦掉纯音乐/≈空占位（这种确实无法生成笔记）。不判断相关性、不判断密度、不逐P校验。

// 拉取单个 cid 的字幕正文（返回纯文本；失败返回 ''）
async function fetchSubtitleText(bvid, cid, timeoutMs = 6000) {
  try {
    const cookie = getBiliCookie();
    const headers = { ...BILI_HEADERS };
    if (cookie) headers.Cookie = cookie;
    const r = await fetch(`https://api.bilibili.com/x/player/v2?bvid=${bvid}&cid=${cid}`, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const j = await r.json();
    const sub = j?.data?.subtitle || {};
    const list = sub.subtitles || sub.list || [];
    const loginList = Array.isArray(sub.need_login_subtitle) ? sub.need_login_subtitle : [];
    const merged = list.concat(loginList).filter((s) => s && (s.subtitle_url || s.url));
    if (!merged.length) return '';
    // 优先取非 AI 的官方/CC 字幕（质量更高、几乎不串号），没有再退回 AI 字幕
    merged.sort((a, b) => {
      const ai = (s) => (/^ai/i.test(s.lan || '') ? 1 : 0);
      return ai(a) - ai(b);
    });
    // 【C 修复】某字幕条目的 url 可能失效/格式异常（实测 bad-url 导致正常视频被误杀为空）。
    // 不再只用 merged[0]，而是按优先级逐个尝试下载，取第一个能成功解析出正文的。
    for (const s of merged) {
      let u = s.subtitle_url || s.url || '';
      if (u.startsWith('//')) u = 'https:' + u;
      if (!/^https?:/i.test(u)) continue; // 跳过坏 url，尝试下一个候选
      try {
        const sr = await fetch(u, { headers, signal: AbortSignal.timeout(timeoutMs) });
        if (!sr.ok) continue;
        const sj = await sr.json();
        const body = Array.isArray(sj?.body) ? sj.body : [];
        const text = body.map((x) => String(x.content || '').trim()).filter(Boolean).join('\n');
        if (text) return text; // 拿到非空正文即返回
      } catch {
        continue; // 该条目失败，尝试下一候选
      }
    }
    return '';
  } catch {
    return '';
  }
}

// 判断一段字幕正文本身是否「像有效讲解内容」（不依赖标题，纯自证）
// 返回 { ok, reason }
// 策略：仅当「完全无内容 / 纯音乐占位」才否决；字幕偏短仍视为可用（短字幕也是真实讲解片段）。
// 注意：自 2026-08 起，资源匹配阶段只做「可用性」判断，不再做相关性/串号校验
// （那些已下沉到笔记生成阶段 filterRelevantParts）。无字幕由上层调用方剔除。
function isSubtitleTextUsable(text, durationSec = 0) {
  const t = String(text || '').trim();
  if (!t) return { ok: false, reason: 'empty' };
  // 1) 纯音乐/占位符占比过高（实测存在整段全是「♪ 音乐 ♪」的分P）
  const lines = t.split('\n').map((s) => s.trim()).filter(Boolean);
  const musicLines = lines.filter((s) => /^[♪♫\s]*(音乐|掌声|BGM|Music)?[♪♫\s]*$/i.test(s)).length;
  if (lines.length && musicLines / lines.length > 0.5) return { ok: false, reason: 'mostly-music-placeholder' };
  // 2) 仅挡接近空的字幕（真正的无字幕已由 no-subtitle 处理，这里只防占位/残缺到无意义）
  const chars = t.replace(/\s/g, '').length;
  if (chars < 30) return { ok: false, reason: `too-short(${chars}字)` };
  // 3) 语速密度校验：仅当「时长很长（>20分钟）但字幕极少（近乎无）」才否决（如 100 分钟只 10 字）。
  //    正常讲解约 2-4 字/分，阈值设为 2 字/分，避免误杀真实但语速偏慢的讲解。
  if (durationSec > 1200) {
    const perMin = chars / (durationSec / 60);
    if (perMin < 2) return { ok: false, reason: `density-too-low(${perMin.toFixed(0)}字/分)` };
  }
  return { ok: true, reason: '' };
}

// 轻量判断：仅确认「主 cid 是否有可用的字幕正文」（非空、非纯音乐占位）。
// 不判断相关性 / 关键词密度 / 跨P串号 / 合格率——这些重分析已下沉到笔记生成阶段。
// 返回 true 即表示该视频「有字幕、后续能生成笔记」，资源匹配阶段据此放行。
async function hasBiliPublicSubtitle(bvid, cid, meta = {}) {
  if (!bvid) return false;
  const c = cid || meta.mainCid;
  if (!c) return false; // 拿不到 cid 无法确认字幕 → 视为无字幕
  const text = await fetchSubtitleText(bvid, c);
  if (!text) return false;
  const usable = isSubtitleTextUsable(text, meta.durationSec || 0);
  return usable.ok;
}

// 综合热度：播放量 + 收藏量（收藏权重更高，更能反映学习价值）
const heat = (v) => (v.play || 0) + (v.favorite || 0) * 5;

// =====================================================================
// B站视频评分缓存（bilibili_resource_cache）读写辅助
// ---------------------------------------------------------------------
// 用途：避免每次生成学习计划都重复「搜索→字幕检查→质量评分」同一视频。
// 注意：缓存【不】替代 B站实时搜索——视频仍是本次实时搜回的，只是评分可复用。
// 有效期 30 天（由 skillResourceMatcher.isCacheFresh 判断），过期重新评分。
// =====================================================================
export function getBiliResourceCacheRow(db, bvid, skill) {
  if (!db || !bvid || !skill) return null;
  try {
    const row = db.prepare(
      'SELECT * FROM bilibili_resource_cache WHERE bvid = ? AND skill = ? ORDER BY checked_time DESC LIMIT 1'
    ).get(bvid, skill);
    if (!row) return null;
    let score = {};
    try { score = JSON.parse(row.score_json || '{}'); } catch { /* 容错 */ }
    return {
      bvid: row.bvid,
      skill: row.skill,
      title: row.title,
      url: row.url,
      author: row.author,
      searchKeyword: row.search_keyword,
      score,
      scoreVersion: row.score_version || 'v1', // 缺省视为旧版，触发重新评分
      subtitleStatus: row.subtitle_status,
      duration: row.duration,
      checkedTime: row.checked_time,
    };
  } catch (e) {
    console.warn('[plan] 读 B站评分缓存失败:', e.message);
    return null;
  }
}

// 注意：运行态可能走 JsonDatabaseSync（DB 为 JSON 格式时的兼容层），该层按 SQL 字面量精确分发，
// 因此此处统一使用 ? 占位符的两步式（SELECT → UPDATE / INSERT），便于兼容层识别。
export function putBiliResourceCacheRow(db, row) {
  if (!db || !row || !row.bvid || !row.skill) return;
  try {
    const exists = db.prepare('SELECT id FROM bilibili_resource_cache WHERE bvid = ? AND skill = ? LIMIT 1').get(row.bvid, row.skill);
    if (exists) {
      db.prepare(`
        UPDATE bilibili_resource_cache SET
          title=?, url=?, author=?, search_keyword=?, score_json=?, score_version=?, subtitle_status=?, duration=?, checked_time=?
        WHERE bvid=? AND skill=?
      `).run(
        row.title || '', row.url || '', row.author || '', row.searchKeyword || '',
        JSON.stringify(row.score || {}), row.scoreVersion || 'v1', row.subtitleStatus || 'none',
        Number(row.duration || 0), Number(row.checkedTime || Date.now()),
        row.bvid, row.skill
      );
    } else {
      db.prepare(`
        INSERT INTO bilibili_resource_cache
          (bvid, title, url, author, skill, search_keyword, score_json, score_version, subtitle_status, duration, checked_time)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        row.bvid, row.title || '', row.url || '', row.author || '', row.skill, row.searchKeyword || '',
        JSON.stringify(row.score || {}), row.scoreVersion || 'v1', row.subtitleStatus || 'none',
        Number(row.duration || 0), Number(row.checkedTime || Date.now())
      );
    }
  } catch (e) {
    console.warn('[plan] 写 B站评分缓存失败 bvid=%s skill=%s: %s', row.bvid, row.skill, e.message);
  }
}

// 基于 DB 构造 cacheStore，注入给 skillResourceMatcher.matchVideoResources。
function makeBiliCacheStore(db) {
  if (!db) return null;
  return {
    get: (bvid, skill) => getBiliResourceCacheRow(db, bvid, skill),
    put: (row) => putBiliResourceCacheRow(db, row),
  };
}

// 基于 DB 构造 B站搜索结果短缓存 store，注入给 searchBilibiliVideos。
// 职责分离：本 store 只负责「相同关键词 24h 内跳过 B站搜索 HTTP」，不判断视频质量。
function makeBiliSearchCacheStore(db) {
  if (!db) return null;
  return {
    get: (keyword) => getBiliSearchCacheRow(db, keyword),
    put: (keyword, results) => putBiliSearchCacheRow(db, keyword, results),
  };
}

// 读取历史 xhs_trend_keywords 全部行（供 extractTrendKeywordsFromXhs 做累计合并）。
export function loadXhsTrends(db) {
  if (!db) return [];
  try {
    const rows = db.prepare(
      'SELECT keyword, skill, total_count, recent_count, last_seen, relevance_score, source FROM xhs_trend_keywords'
    ).all();
    return rows;
  } catch (e) {
    console.warn('[plan] 读 xhs_trend_keywords 失败:', e.message);
    return [];
  }
}

// 把小红书趋势词（extractTrendKeywordsFromXhs 输出，已含累计 totalCount/recentCount）持久化到
// xhs_trend_keywords 表，采用 upsert（按 keyword+skill）。注意 extractTrendKeywordsFromXhs 已经
// 与历史合并，所以这里【直接写入合并后的累计值】，不做二次累加（避免重复计数）。
export function upsertXhsTrendKeywords(db, trends = []) {
  if (!db || !trends.length) return;
  try {
    const now = Date.now();
    const selStmt = db.prepare('SELECT id FROM xhs_trend_keywords WHERE keyword = ? AND skill = ? LIMIT 1');
    const insStmt = db.prepare(`
      INSERT INTO xhs_trend_keywords
        (keyword, skill, total_count, recent_count, last_seen, relevance_score, trend_score, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const updStmt = db.prepare(`
      UPDATE xhs_trend_keywords SET
        total_count=?, recent_count=?, last_seen=?, relevance_score=?, trend_score=?, source=?
      WHERE keyword=? AND skill=?
    `);
    const tx = db.transaction((rows) => {
      for (const t of rows) {
        const args = [
          t.keyword, t.skill,
          Number(t.totalCount || 0), Number(t.recentCount || 0),
          t.lastSeen || new Date().toISOString().slice(0, 10),
          Number(t.relevanceScore || 0), Number(t.trendScore || 0), t.source || 'xhs', now,
        ];
        // 两步式 upsert（兼容 JsonDatabaseSync 字面量分发）
        if (selStmt.get(t.keyword, t.skill)) updStmt.run(args.slice(2).concat([t.keyword, t.skill]));
        else insStmt.run(args);
      }
    });
    tx(trends);
  } catch (e) {
    console.warn('[plan] 写 xhs_trend_keywords 失败:', e.message);
  }
}

// P1：小红书趋势微调技能权重。规则（避免热点完全改变学习路线）：
//   - 固定技能体系与基准权重不变，仅【上调】权重；
//   - 单个技能最多提升 20%（基于其原始固定权重）；
//   - 提升幅度与趋势强度正相关（trendScore 越高，越接近 +20% 上限）。
// 实现：每个技能记忆 _baseWeight（首次进入时的原始权重），避免多次调用叠加。
export function applyTrendWeightBoost(skillTree, trends = []) {
  if (!skillTree || !Array.isArray(skillTree.skills)) return;
  const byName = new Map();
  for (const s of skillTree.skills) {
    if (typeof s._baseWeight !== 'number') s._baseWeight = typeof s.weight === 'number' ? s.weight : 0.1;
    byName.set(String(s.standard_name || s.name || ''), s);
  }
  for (const t of (trends || [])) {
    const s = byName.get(String(t.skill || ''));
    if (!s) continue;
    const base = s._baseWeight;
    // 趋势越强（trendScore 0~1）越接近 +20%；封顶 +20%
    const boostRatio = Math.min(0.2, Math.max(0, Number(t.trendScore) || 0) * 0.2);
    s.weight = Number((base * (1 + boostRatio)).toFixed(4));
    if (s.weight > base) {
      console.log(`[plan] 趋势微调权重 ${s.standard_name || s.name}: ${base} -> ${s.weight} (趋势${t.keyword}, ts=${t.trendScore})`);
    }
  }
}

// P1：把技能权重汇总到板块（stage）。某板块的 weight = 其覆盖技能权重之和，
// 供 dailyPlanGenerator 按权重比例分配学习时间（Agent/RAG 等高权重板块获得更多天）。
// 不修改原 sections，返回带 weight 的新数组（缺权重时回落为 1，等价于均分）。
export function attachSectionWeights(sections = [], skillTree = null) {
  const weightByName = new Map();
  if (skillTree && Array.isArray(skillTree.skills)) {
    for (const s of skillTree.skills) {
      const w = typeof s.weight === 'number' ? s.weight : 0.1;
      weightByName.set(String(s.standard_name || s.name || '').trim().toLowerCase(), w);
    }
  }
  return (Array.isArray(sections) ? sections : []).map((sec) => {
    const names = Array.isArray(sec.skillNames) ? sec.skillNames : [];
    let w = 0;
    for (const nm of names) {
      const k = String(nm || '').trim().toLowerCase();
      if (weightByName.has(k)) w += weightByName.get(k);
    }
    return { ...sec, weight: w > 0 ? Number(w.toFixed(4)) : 1 };
  });
}

// Learning Budget Manager 预算快照持久化（新增模块，仅记录计算结果，不碰资源匹配逻辑）
export function upsertLearningBudget(db, { userId, planId, budget }) {
  if (!db || !budget) return;
  try {
    // node:sqlite 不支持 ON CONFLICT(col) DO UPDATE 列名列表语法，改用两步式。
    const exists = db.prepare('SELECT id FROM learning_budget WHERE user_id = ? AND plan_id = ? LIMIT 1').get(userId || null, planId || null);
    if (exists) {
      db.prepare(`
        UPDATE learning_budget SET
          days=?, daily_minutes=?, total_minutes=?, budget_json=?, created_at=?
        WHERE user_id=? AND plan_id=?
      `).run(
        Number(budget.days || 0), Number(budget.dailyMinutes || 0), Number(budget.totalMinutes || 0),
        JSON.stringify(budget), Date.now(), userId || null, planId || null
      );
    } else {
      db.prepare(`
        INSERT INTO learning_budget (user_id, plan_id, days, daily_minutes, total_minutes, budget_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        userId || null, planId || null, Number(budget.days || 0), Number(budget.dailyMinutes || 0),
        Number(budget.totalMinutes || 0), JSON.stringify(budget), Date.now()
      );
    }
  } catch (e) {
    console.warn('[plan] 写 learning_budget 失败:', e.message);
  }
}

export function loadLearningBudget(db, { userId, planId } = {}) {
  if (!db) return null;
  try {
    let row = null;
    if (planId) row = db.prepare('SELECT * FROM learning_budget WHERE plan_id = ? LIMIT 1').get(planId);
    else if (userId) row = db.prepare('SELECT * FROM learning_budget WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(userId);
    if (!row) return null;
    let budget = null;
    try { budget = JSON.parse(row.budget_json || 'null'); } catch { budget = null; }
    return budget;
  } catch (e) {
    console.warn('[plan] 读 learning_budget 失败:', e.message);
    return null;
  }
}

// =====================================================================
// B站搜索结果短缓存（bilibili_search_cache）读写辅助
// 职责：减少【相同关键词重复调用 B站搜索接口】（HTTP 请求开销）。
// 与 bilibili_resource_cache 严格分离：本层只缓存「搜索结果列表」，不判断视频质量；
// 不替代实时搜索——超过 24h(TTL) 必须重新搜索刷新。
// =====================================================================
const BILI_SEARCH_CACHE_TTL_MS = 24 * 3600 * 1000;

export function getBiliSearchCacheRow(db, keyword) {
  if (!db || !keyword) return null;
  try {
    const row = db.prepare(
      'SELECT keyword, results, checked_time FROM bilibili_search_cache WHERE keyword = ? LIMIT 1'
    ).get(keyword);
    if (!row) return null;
    if (Date.now() - Number(row.checked_time || 0) > BILI_SEARCH_CACHE_TTL_MS) return null; // 超 TTL 视为无缓存
    let results = [];
    try { results = JSON.parse(row.results || '[]'); } catch { results = []; }
    return { keyword: row.keyword, results, checkedTime: row.checked_time };
  } catch (e) {
    console.warn('[plan] 读 B站搜索缓存失败:', e.message);
    return null;
  }
}

export function putBiliSearchCacheRow(db, keyword, results) {
  if (!db || !keyword) return;
  try {
    // node:sqlite 不支持 ON CONFLICT(keyword) DO UPDATE 列名列表语法，改用两步式。
    const exists = db.prepare('SELECT id FROM bilibili_search_cache WHERE keyword = ? LIMIT 1').get(keyword);
    const params = {
      keyword,
      results: JSON.stringify(Array.isArray(results) ? results : []),
      checkedTime: Date.now(),
    };
    if (exists) {
      db.prepare('UPDATE bilibili_search_cache SET results=?, checked_time=? WHERE keyword=?').run(JSON.stringify(Array.isArray(results) ? results : []), Date.now(), keyword);
    } else {
      db.prepare('INSERT INTO bilibili_search_cache (keyword, results, checked_time) VALUES (?, ?, ?)').run(keyword, JSON.stringify(Array.isArray(results) ? results : []), Date.now());
    }
  } catch (e) {
    console.warn('[plan] 写 B站搜索缓存失败 keyword=%s: %s', keyword, e.message);
  }
}

// durationMin 默认 10 分钟（600s）：优先选超长深度教程，逐级向上偏好更长，
// 最低档 10 分钟——过短碎片（<10min）不进候选。年份默认 6 年，覆盖更多系统课。
// searchCacheStore：搜索结果短缓存（bilibili_search_cache）注入，命中且 TTL 内则跳过 B站搜索 HTTP；
//   仅减少重复 HTTP 请求，不替代字幕检查/评分（后续 meta+字幕流程照常实时进行）。
export async function searchBilibiliVideos(keyword, { durationMin = 600, topN = 1, timeoutMs = 8000, maxAgeYears = 6, skill = '', cacheStore = null, searchCacheStore = null } = {}) {
  console.log(`[bili-search] keyword="${keyword}" durationMin=${durationMin} maxAgeYears=${maxAgeYears}`);
  const toSec = (d) => {
    if (typeof d === 'number') return d;
    const parts = String(d || '0').split(':').map(Number);
    return parts.reduce((acc, n) => acc * 60 + (isNaN(n) ? 0 : n), 0);
  };
  let mapped = [];
  // —— 搜索缓存短路：24h 内相同关键词直接复用，省一次 B站搜索 HTTP ——
  const cached = searchCacheStore ? searchCacheStore.get(keyword) : null;
  if (cached && Array.isArray(cached.results) && cached.results.length) {
    console.log(`[bili-search] 命中搜索缓存 keyword="${keyword}" 条数=${cached.results.length}`);
    mapped = cached.results.map((r) => ({
      title: String(r.title || ''),
      bvid: r.bvid,
      link: r.url || (r.bvid ? `https://www.bilibili.com/video/${r.bvid}` : ''),
      durationSec: Number(r.duration || 0),
      author: r.author || '',
      play: 0,
      favorite: 0,
    })).filter((v) => v.bvid && v.link);
  } else {
    const url = 'https://api.bilibili.com/x/web-interface/search/all/v2?keyword=' + encodeURIComponent(keyword);
    let j;
    try {
      const res = await fetch(url, { headers: BILI_HEADERS, signal: AbortSignal.timeout(timeoutMs) });
      j = await res.json();
    } catch {
      return [];
    }
    const groups = Array.isArray(j?.data?.result) ? j.data.result : [];
    const videoGroup = groups.find((g) => g.result_type === 'video');
    const vids = Array.isArray(videoGroup?.data) ? videoGroup.data : [];
    mapped = vids
      .map((v) => ({
        title: String(v.title || '').replace(/<[^>]+>/g, ''),
        bvid: v.bvid,
        link: v.bvid ? `https://www.bilibili.com/video/${v.bvid}` : '',
        durationSec: toSec(v.duration),
        author: v.author || '',
        play: v.play || 0,
        favorite: 0,
      }))
      .filter((v) => v.bvid && v.link);
    // 写回搜索缓存（仅当本次确实发起了搜索）
    if (searchCacheStore) {
      const cacheResults = mapped.map((v) => ({
        bvid: v.bvid, title: v.title, url: v.link, duration: v.durationSec, author: v.author,
      }));
      searchCacheStore.put(keyword, cacheResults);
    }
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const maxAgeSec = maxAgeYears * 365 * 24 * 3600;

  // 限并发映射（避免对 B站 view/subtitle 接口瞬时打满触发 429）。
  const mapWithConcurrency = async (items, limit, fn) => {
    const out = new Array(items.length);
    let idx = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (idx < items.length) {
        const cur = idx++;
        try { out[cur] = await fn(items[cur], cur); } catch { out[cur] = null; }
      }
    });
    await Promise.all(workers);
    return out;
  };

  // 逐级向上偏好更长时长（从 caller 指定的 durationMin 起，最低 10 分钟），
  // 优先选更长的系统课/深度教程，但不再一刀切拒绝中等长度的真实讲解视频。
  // 同时记录每级最热候选（无论是否近四年、是否有字幕），供最后回退使用。
  const tiers = [durationMin, 1800, 3000, 6000, 10800].filter((m) => m >= 600);
  let bestFallback = null; // 全局最热视频（可能超期），用于兜底
  const globalEnriched = []; // 跨档位累积所有「近年内+有干净字幕」视频，取全局 topN
  for (const minDur of tiers) {
    // 候选池放大到 20，提高「有干净字幕且不串号」视频的命中概率（B站 部分 AI 词热门结果普遍无字幕）
    const tierCandidates = mapped
      .filter((v) => v.durationSec >= minDur)
      .sort((a, b) => heat(b) - heat(a))
      .slice(0, 20);
    // 并发获取候选视频的 meta + 字幕状态（限并发 5，避免瞬时打满 B站 view/subtitle 接口触发 429）。
    const enriched = await mapWithConcurrency(tierCandidates, 5, async (v) => {
      const meta = await fetchBiliMeta(v.bvid);
      const withMeta = { ...v, pubdate: meta.pubdate || 0, favorite: meta.favorite || 0, parts: meta.parts || [] };
      if (heat(withMeta) > heat(bestFallback || { play: 0, favorite: 0 })) bestFallback = withMeta;
      if (!(meta.pubdate && nowSec - meta.pubdate <= maxAgeSec)) return null; // 仅保留近年内
      // 【必须有字幕】只收录「有公开可用字幕」的视频（AI 字幕或作者上传均可）。
      // 注意：此处【只判断字幕是否存在且非占位】，不做内容相关性/串号/密度校验
      // （那些重分析已下沉到笔记生成阶段）。无字幕 → 不录入（缺字幕无法生成笔记）。
      const cid = meta.mainCid || (meta.parts && meta.parts[0] && meta.parts[0].cid) || 0;
      // 缓存短路：若该 (bvid, skill) 在评分缓存中存在且新鲜，说明之前已确认过有字幕，
      // 直接跳过 hasBiliPublicSubtitle（字幕下载是最大耗时来源），大幅提速。
      let hasSub = false;
      const cached = cacheStore && skill ? cacheStore.get(v.bvid, skill) : null;
      if (cached && (cached.subtitleStatus === 'available' || cached.subtitleStatus === 'none')) {
        hasSub = cached.subtitleStatus === 'available';
      } else {
        hasSub = await hasBiliPublicSubtitle(v.bvid, cid, {
          ...meta,
          title: v.title,
          durationSec: v.durationSec,
        });
      }
      return hasSub ? { ...withMeta, hasSubtitle: true } : null;
    });
    for (const e of enriched) {
      if (e && !globalEnriched.some((g) => g.bvid === e.bvid)) globalEnriched.push(e);
    }
  }
  // 跨所有档位取热度最高的 topN 个「近年内+有字幕」视频（不局限于某一档，最大化命中带字幕的好视频）
  if (globalEnriched.length) {
    globalEnriched.sort((a, b) => heat(b) - heat(a));
    return globalEnriched.slice(0, Math.max(1, topN)).map((v) => ({
      ...v,
      recent: true,
      overTwoYears: false,
    }));
  }
  // 所有时长档都没有「近年内且有可用字幕」的视频：如实返回空（绝不收录无字幕视频，
  // 否则后续笔记生成会失败）。前端将显示「该板块暂无匹配长视频」。
  return [];
}

// 把「小红书真实素材 + 本地 RAG 真实文档片段」一起作为参考，交给大模型只做「结构规划」：
// 每个板块只产出标题 / 用于 B站搜索的关键词 / 引用哪几条 RAG 片段（ragRefs）。
// 真实的 B站长视频链接 与 RAG 知识库内容 全部来自前面的真实检索结果，杜绝模型编造。
// 大模型从「真实素材 + 岗位」抽取技能树（含标准技能名/类目/等级）
// 素材来源优先级：
//   1) 已接入小红书 -> 小红书真实帖子（正文+图片文字）
//   2) 未接入小红书 -> 公用 RAG 知识库里「别人沉淀的真实经验贴(file/xhs)」作为真实经验来源
//   3) 都没有 -> 仅按岗位名预测（兜底）
// 输出：[{ name, category, level }]，category/level 使用固定枚举，缺失则给兜底值。
// =====================================================================
// 技能树抽取：AI产品经理岗走固定目录（AI_PM_SKILL_MAP），零 LLM / 零小红书。
// ---------------------------------------------------------------------
// 产品边界（来自需求）：
//   - AI产品经理岗：技能体系由固定 AI_PM_SKILL_MAP 决定，结果 100% 可复现，
//     小红书(postsText)不进入技能树生成，仅作为趋势感知层（见下方趋势机制）。
//   - 其他岗位：保留原 LLM 抽取作为兜底，但移除「小红书正则补技能」越界逻辑。
// 返回值：[{ name, category, level, weight }]，name 即标准技能名。
// =====================================================================
async function extractIntegratedSkillTree(keyword, postsText, ragContext = []) {
  const isAiJob = skillNormalizer.isAiProductManagerJob(keyword);

  // —— AI产品经理：直接返回固定能力模型，不调用 LLM、不读 postsText ——
  if (isAiJob) {
    return skillNormalizer.aiPmFixedSkills();
  }

  // —— 其他岗位：LLM 兜底（保留原逻辑，但不再用小红书正则补技能）——
  const CATEGORIES = ['programming','math','ml','dl','data','nlp','cv','rag','agent','product','tool','soft','other'];
  const LEVELS = ['beginner','intermediate','advanced'];
  const ragBlock = Array.isArray(ragContext) && ragContext.length
    ? ragContext
        .map((c, i) => `〔经验-${i + 1}〕${String(c.content || '').slice(0, 600)}${c.ref ? '（出处：' + c.ref + '）' : ''}`)
        .join('\n\n')
    : '';

  const system =
    '你是岗位技能分析专家。请基于「目标岗位」与「本地知识库经验」提取该岗位真正需要的 6-10 个核心技能。' +
    '只输出 JSON：' +
    '{"skills":[{"name":"标准技能名(如 Python / Prompt工程 / 数据分析)","category":"' + CATEGORIES.join('/') + '","level":"' + LEVELS.join('/') + '"}]}。' +
    '规则：1) name 用最通用的标准叫法，不要带「基础/入门/教程」等冗余词；' +
    '2) category 从枚举中选最贴切的一个；3) level 表示该技能对岗位的掌握要求；4) 不要把不同技能合并。';
  const userParts = [`目标岗位：${keyword}`];
  if (ragBlock) {
    userParts.push(`【真实素材：由其他用户导入沉淀的本地知识库经验（小红书经验贴 + 文档，公用库）】\n${ragBlock}`);
  } else {
    userParts.push('（无真实素材，仅按岗位名预测，请基于通用岗位认知给出）');
  }
  userParts.push(`请为「${keyword}」抽取技能树（name/category/level）。`);
  const user = userParts.join('\n\n');

  const content = await callQwen(system, user, undefined, 60000);
  const parsed = safeJson((content.match(/\{[\s\S]*\}/) || [content])[0]) || {};
  const arr = Array.isArray(parsed.skills) ? parsed.skills : [];
  return arr
    .map((s) => ({
      name: String(s.name || '').trim(),
      category: CATEGORIES.includes(String(s.category || '').toLowerCase()) ? s.category.toLowerCase() : 'other',
      level: LEVELS.includes(String(s.level || '').toLowerCase()) ? s.level.toLowerCase() : 'beginner',
    }))
    .filter((s) => s.name)
    .slice(0, 10);
}

// 用「标准技能树 + 真实资源池（PDF/B站）」生成阶段学习规划。
// LLM 只负责：阶段划分、学习顺序、学习目标；PDF/B站资源全部由代码从真实系统回填，杜绝编造。
async function buildCombinedPlan(keyword, skillTree, pdfResources, videoResources, ragContext = []) {
  let llmFallback = false;
  const skills = Array.isArray(skillTree?.skills) ? skillTree.skills : [];
  const skillSum = skills
    .map((s, i) => `${i + 1}. ${s.standard_name}（类目:${s.category}，等级:${s.level}，原叫法:${Array.isArray(s.aliases) ? s.aliases.join('/') : ''}）`)
    .join('\n');
  const pdfBlock = pdfResources.length
    ? pdfResources.map((p, i) => `〔PDF-${i + 1}〕${p.title}（docId:${p.docId}）`).join('\n')
    : '（知识库暂无匹配 PDF）';
  const videoBlock = videoResources.length
    ? videoResources.map((v, i) => `〔BILI-${i + 1}〕${v.title}（${v.link}）`).join('\n')
    : '（B站暂无匹配视频）';
  const ragBlock = ragContext.length
    ? ragContext.map((c, i) => `〔RAG-${i + 1}〕${String(c.content || '').slice(0, 400)}`).join('\n\n')
    : '（本地知识库暂无匹配内容）';

  const system =
    '你是资深求职规划教练。请基于「标准技能树」与「真实资源池」规划循序渐进的学习板块。' +
    '只输出 JSON：{"summary":"整体规划思路(2-4句)","sections":[{"part":1,"title":"板块名称",' +
    '"skillNames":["标准技能名数组，须来自下面技能树，如 [\"Python\"]"],' +
    '"goal":"本板块学习目标(1-2句)",' +
    '"ragRefs":[PDF编号数组，如 [1,3]，须来自下面 PDF 片段编号；无则空数组],' +
    '"biliRefs":[B站编号数组，如 [2]，须来自下面 B站片段编号；无则空数组]}]}。' +
    '严禁输出任何链接或文档内容正文（link/url 字段），资源由系统从真实资源池回填。' +
    '必须输出 4-6 个板块；每个板块至少覆盖 1 个标准技能，skillNames 不能为空；若资源池不足，相关引用数组为空即可。';
  const user =
    `目标岗位：${keyword}\n\n` +
    `【标准技能树】\n${skillSum || '（无）'}\n\n` +
    `【真实 PDF 资源池（编号 PDF-N 供引用）】\n${pdfBlock}\n\n` +
    `【真实 B站 视频池（编号 BILI-N 供引用）】\n${videoBlock}\n\n` +
    `【参考资料：本地知识库（RAG）真实文档片段，编号 RAG-N】\n${ragBlock}\n\n` +
    `请为「${keyword}」规划学习板块：给出板块标题、覆盖哪些标准技能(skillNames)、学习目标(goal)，` +
    `以及每个板块应引用的 PDF 编号(ragRefs)与 B站 编号(biliRefs)。`;
  let content = '';
  try {
    content = await callQwen(system, user, undefined, 60000);
  } catch (e) {
    llmFallback = true;
    console.warn('[plan/integrated] LLM调用失败，使用规则路线:', e.message);
  }
  const parsed = safeJson((content.match(/\{[\s\S]*\}/) || [content])[0]) || {};
  const rawSections = Array.isArray(parsed.sections) ? parsed.sections : [];

  // 归一化键：用于技能名对齐（标准名/别名/LLM 自由叫法统一小写去空格）
  const normKey = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, '');
  // 按「标准技能名 + 全部别名」多键聚合真实资源，供板块引用。
  // 关键修复：LLM 返回的 skillNames 常为变体（如「SQL基础」「Python编程」），
  // 视频池 key 是 standard_name（如「SQL」「Python」），直接精确查会全部落空，
  // 导致整块显示「暂未匹配到视频」。多键索引 + 归一化 + 模糊兜底可根治此问题。
  const pdfBySkill = new Map();
  const addPdf = (key, p) => {
    const k = normKey(key);
    if (!k) return;
    if (!pdfBySkill.has(k)) pdfBySkill.set(k, []);
    if (!pdfBySkill.get(k).some((x) => x.docId === p.docId)) pdfBySkill.get(k).push(p);
  };
  for (const p of pdfResources) {
    for (const sk of (p.skills || [])) addPdf(sk, p);
  }
  const videoBySkill = new Map();
  const addVideo = (key, v) => {
    const k = normKey(key);
    if (!k) return;
    if (!videoBySkill.has(k)) videoBySkill.set(k, []);
    if (!videoBySkill.get(k).some((x) => x.link === v.link)) videoBySkill.get(k).push(v);
  };
  for (const v of videoResources) {
    for (const sk of (v.skills || [])) addVideo(sk, v);
  }
  const allDocMap = new Map();
  for (const p of pdfResources) {
    if (p.docId && !allDocMap.has(p.docId)) {
      allDocMap.set(p.docId, { docId: p.docId, title: p.title || '知识库文档', file: p.file || '' });
    }
  }

  // 按板块标题/技能名模糊挑选最匹配的视频；没有相关视频时保持为空，禁止拿第一个视频冒充相关资源。
  const pickFallbackVideo = (skillNames, title, fallbackIndex = 0) => {
    if (!videoResources.length) return null;
    const hay = [title, ...skillNames].map(normKey).filter(Boolean);
    // 1) 标题或技能名包含某视频标题关键词
    for (const v of videoResources) {
      const vt = normKey(v.title || '');
      if (hay.some((h) => vt.includes(h) || h.includes(vt.slice(0, 4)))) return v;
    }
    // 技能未精确命中时，使用本次真实搜索池中的视频轮换回填，避免某个板块因 LLM 命名差异为空。
    // 不生成、不编造链接；视频仍然必须来自 searchBilibiliVideos 的结果。
    return videoResources[fallbackIndex % videoResources.length] || null;
  };

  const skillKey = (s) => normKey(s);
  const canonicalSkill = (name) => {
    const k = skillKey(name);
    return skills.find((s) => skillKey(s.standard_name) === k || (s.aliases || []).some((a) => skillKey(a) === k));
  };
  const fallbackSections = () => {
    const usable = skills.filter((s) => s.standard_name);
    if (!usable.length) return [];
    const count = Math.min(6, Math.max(4, Math.ceil(usable.length / 2)));
    const size = Math.ceil(usable.length / count);
    const titles = ['AI与产品基础', '需求与产品设计', '数据与效果评测', '大模型与AI应用', '项目落地与协作', '进阶实践'];
    const sections = [];
    for (let i = 0; i < usable.length; i += size) {
      const group = usable.slice(i, i + size);
      const names = group.map((s) => s.standard_name);
      const ragRefs = pdfResources
        .map((p, index) => ({ p, index }))
        .filter(({ p }) => (p.skills || []).some((s) => names.some((n) => skillKey(s) === skillKey(n))))
        .slice(0, 2)
        .map(({ index }) => index + 1);
      const biliRefs = videoResources
        .map((v, index) => ({ v, index }))
        .filter(({ v }) => (v.skills || []).some((s) => names.some((n) => skillKey(s) === skillKey(n))))
        .slice(0, 1)
        .map(({ index }) => index + 1);
      sections.push({
        part: sections.length + 1,
        title: titles[sections.length] || `${names[0]}实践`,
        skillNames: names,
        goal: `掌握${names.join('、')}，并完成对应的真实资料学习与应用练习。`,
        ragRefs,
        biliRefs,
      });
    }
    return sections;
  };
  const modelSections = rawSections.map((s) => ({
    ...s,
    skillNames: (Array.isArray(s.skillNames) ? s.skillNames : [])
      .map((name) => canonicalSkill(name)?.standard_name)
      .filter(Boolean),
  })).filter((s) => s.skillNames.length);
  const aiPmSections = () => {
    // 阶段与技能池直接来自 AI_PM_STAGE_MAP（已在 skillNormalizer 中按岗位约束定义），
    // 保证 5 个固定阶段名称、技能均为 AI 产品经理能力，杜绝普通产品技能偏移。
    return skillNormalizer.AI_PM_STAGE_MAP.map(({ stage, skills: wanted, searchIntent }, i) => {
      const names = wanted.filter((name) => skills.some((sk) => skillKey(sk.standard_name) === skillKey(name)));
      const ragRefs = pdfResources.map((p, index) => ({ p, index }))
        .filter(({ p }) => (p.skills || []).some((sk) => names.some((name) => skillKey(sk) === skillKey(name))))
        .slice(0, 2).map(({ index }) => index + 1);
      const biliRefs = videoResources.map((v, index) => ({ v, index }))
        .filter(({ v }) => (v.skills || []).some((sk) => names.some((name) => skillKey(sk) === skillKey(name))))
        .slice(0, 1).map(({ index }) => index + 1);
      return {
        part: i + 1,
        title: stage,
        skillNames: names,
        goal: `${searchIntent || `掌握${names.join('、')}`}，完成与 AI 产品经理岗位相关的资料学习和应用练习。`,
        ragRefs,
        biliRefs,
      };
    }).filter((s) => s.skillNames.length);
  };
  // AI 产品经理使用固定五阶段，LLM 不再改变岗位能力边界或阶段归属。
  const sectionSource = skillNormalizer.isAiProductManagerJob(keyword)
    ? aiPmSections()
    : (modelSections.length >= 4 ? modelSections.slice(0, 6) : fallbackSections());

  // 全局 PDF 占用表：保证同一本 PDF（docId）只被分配给一个板块，杜绝跨板块重复。
  // 方案：一本 PDF 命中多个技能时，谁先引用（板块顺序靠前）就归谁；后续板块不再引用该 PDF，
  // 仅用视频 / 小红书资源支撑（符合「不允许不同模块使用同一 PDF」的约束）。
  const globalUsedPdf = new Set();
  const enriched = sectionSource.map((s, i) => {
    const title = String(s.title || `板块${i + 1}`);
    const skillNames = Array.isArray(s.skillNames) ? s.skillNames.map(String) : [];
    const goal = String(s.goal || '');
    // 代码回填：收集本板块覆盖技能对应的真实 PDF / 视频（板块内去重，且 PDF 全局唯一）
    const pdfSet = new Map();
    const videoSet = new Map();
    const resolveVideo = (nm) => {
      const k = normKey(nm);
      // 精确（归一化）命中
      for (const v of videoBySkill.get(k) || []) if (!videoSet.has(v.link)) videoSet.set(v.link, v);
      // 模糊：某视频的任一技能键包含本名 / 被本名包含
      for (const [key, list] of videoBySkill) {
        if (key.includes(k) || k.includes(key)) for (const v of list) if (!videoSet.has(v.link)) videoSet.set(v.link, v);
      }
    };
    const resolvePdf = (nm) => {
      const k = normKey(nm);
      // 精确（归一化）命中：仅纳入未被其他板块占用的 PDF，并标记全局占用
      for (const p of pdfBySkill.get(k) || []) {
        if (!pdfSet.has(p.docId) && !globalUsedPdf.has(p.docId)) {
          pdfSet.set(p.docId, p);
          globalUsedPdf.add(p.docId);
        }
      }
      // 模糊：某 PDF 的任一技能键包含本名 / 被本名包含（同样遵守全局唯一）
      for (const [key, list] of pdfBySkill) {
        if (key.includes(k) || k.includes(key)) {
          for (const p of list) {
            if (!pdfSet.has(p.docId) && !globalUsedPdf.has(p.docId)) {
              pdfSet.set(p.docId, p);
              globalUsedPdf.add(p.docId);
            }
          }
        }
      }
    };
    for (const nm of skillNames) { resolveVideo(nm); resolvePdf(nm); }
    // 也允许 LLM 直接指定编号（兜底，遵守全局唯一）
    const ragRefs = Array.isArray(s.ragRefs) ? s.ragRefs.map(Number).filter((n) => n >= 1 && n <= pdfResources.length) : [];
    for (const n of ragRefs) {
      const p = pdfResources[n - 1];
      if (p && p.docId && !pdfSet.has(p.docId) && !globalUsedPdf.has(p.docId)) {
        pdfSet.set(p.docId, p);
        globalUsedPdf.add(p.docId);
      }
    }
    // 前面板块占用共享 PDF 后，后续板块仍有真实匹配但会被全局去重清空。
    // 此时允许复用一份最相关 PDF，避免有资料的板块显示为空。
    if (!pdfSet.size && pdfResources.length) {
      const fallbackPdf = pdfResources.find((p) =>
        (p.skills || []).some((s) => skillNames.some((n) => normKey(s) === normKey(n)))
      );
      if (fallbackPdf?.docId) pdfSet.set(fallbackPdf.docId, fallbackPdf);
    }
    const biliRefs = Array.isArray(s.biliRefs) ? s.biliRefs.map(Number).filter((n) => n >= 1 && n <= videoResources.length) : [];
    for (const n of biliRefs) { const v = videoResources[n - 1]; if (v && v.link && !videoSet.has(v.link)) videoSet.set(v.link, v); }
    // 兜底：板块技能未命中任何视频，但全局视频池非空 → 按标题/技能模糊补一个，杜绝「整块无视频」
    if (!videoSet.size && videoResources.length) {
      const fb = pickFallbackVideo(skillNames, title, i);
      if (fb) videoSet.set(fb.link, fb);
    }

    const pdfs = [...pdfSet.values()].map((p) => ({
      title: p.title || '知识库文档',
      docId: p.docId,
      file: p.file || '',
      link: p.docId ? `/api/rag/file?docId=${encodeURIComponent(p.docId)}` : '',
      skill: p.skills?.[0] || skillNames[0] || '',
      relevance_score: p.relevance_score || 0,
      relevance: p.relevance || null,
      reason: p.reason || `覆盖${skillNames.join('、')}，来自本地知识库真实文档`,
    }));
    const primaryVideo = [...videoSet.values()][0];
    const video = primaryVideo;

    const content2 = video
      ? `【B站长视频】${video.title}（${Math.round((video.durationSec || 0) / 60)}分钟，UP主 ${video.author || ''}${video.publishDate ? '，发布于 ' + video.publishDate : ''}）\n链接：${video.link}`
      : '【B站长视频】暂未匹配到视频';

    return {
      part: Number(s.part) || i + 1,
      title,
      goal,
      skillNames,
      platform: 'bilibili',
      link: video ? video.link : '',
      biliTitle: video ? video.title : '',
      durationSec: video ? (video.durationSec || 0) : 0,
      author: video ? video.author || '' : '',
      videoResource: video ? {
        title: video.title,
        link: video.link,
        skill: video.skills?.[0] || skillNames[0] || '',
        relevance_score: video.relevance_score || 0,
        relevance: video.relevance || null,
        reason: video.reason || `覆盖${skillNames.join('、')}，来自 B 站真实检索结果`,
      } : null,
      // 真实分P列表：[{page, cid, part, durationSec}]，单P视频为空数组
      parts: video && Array.isArray(video.parts) ? video.parts : [],
      pdfs,
      isLongEnough: video ? (video.durationSec || 0) >= 300 * 60 : false,
      content: content2,
    };
  });

  return {
    summary: parsed.summary || `已结合标准技能树与本地知识库，为「${keyword}」规划学习板块（B站长视频 + RAG 文档）。`,
    sections: enriched,
    ragDocs: [...allDocMap.values()],
    llmFallback,
  };
}

// 仅搜索小红书学习路线，返回真实帖子链接（供选岗保存后自动触发）
// 内置「岗位搜索词转换层」：仅搜索阶段把岗位名映射为小红书友好的搜索词，
// 避免如「C端」被误判为「C语言」。用户岗位名、学习计划、RAG 隔离标签均不变。
export async function searchXhsPosts(keyword) {
  const xhsJob = normalizeXhsSearchJob(keyword);
  const xhs = await xhsSearch(`${xhsJob} 学习路线 学习计划`);
  return { posts: xhs.posts, needLogin: xhs.needLogin, searchStatus: xhs.searchStatus || (xhs.posts?.length ? 'success' : 'empty'), raw: xhs.raw };
}

// ---------- 小红书笔记详情 + 分页搜索 ----------
// 抓取单篇笔记正文（get_feed_detail），结果按 id 缓存
async function xhsFeedDetail(feed) {
  if (!feed || !feed.id) return { content: '', images: [] };
  const hit = xhsDetailCache.get(feed.id);
  if (hit) return hit;

  const id = () => Math.floor(Math.random() * 1e9);
  await mcpPost({
    jsonrpc: '2.0', id: id(), method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'offerdao', version: '1.0' } },
  }).catch(() => {});

  let raw = '';
  try {
    raw = await mcpPost({
      jsonrpc: '2.0', id: id(), method: 'tools/call',
      params: { name: 'get_feed_detail', arguments: { feedId: feed.id, xsecToken: feed.xsecToken || '', loadAllComments: false } },
    }, 30000);
  } catch (e) {
    const fallback = { content: '', images: [] };
    xhsDetailCache.set(feed.id, fallback);
    return fallback;
  }

  const text = extractText(raw);
  let content = '';
  let images = [];
  const whole = safeJson(text.trim());
  const j = (whole && typeof whole === 'object' && !Array.isArray(whole))
    ? whole
    : (() => { const m = text.match(/\{[\s\S]*\}/); return m ? safeJson(m[0]) : null; })();
  if (j) {
    content = j.desc || j.description || j.content || '';
    if (Array.isArray(j.images)) images = j.images;
  }
  if (!content && text) content = text.slice(0, 800);
  const result = { content: String(content).trim(), images };
  xhsDetailCache.set(feed.id, result);
  return result;
}

// 搜索最多 20 条热门帖，直接返回含链接的元数据（不抓正文，秒回）。
// 正文通过 getXhsPostDetail 在用户点击「查看详情」时按需懒加载。
export async function searchXhsPostsPaginated(keyword, page = 1, pageSize = 20) {
  const kw = (keyword || '学习路线').trim();
  let feeds = null;
  let needLogin = false;
  const cached = xhsFeedCache.get(kw);
  // 缓存命中但当前用户已无登录 cookie 时，视为失效：不让「曾登录抓到的旧帖」在断开后冒充新抓取结果。
  // 优先用当前活跃用户的隔离 cookie 判断；未设置活跃用户时回退全局判断（兼容未迁移路径）。
  const userLoggedIn = activeXhsUserId
    ? hasUserLoginCookie(activeXhsUserId)
    : hasLoginCookie();
  if (cached && Date.now() - cached.t < XHS_FEED_CACHE_TTL && userLoggedIn) {
    feeds = cached.feeds;
  }
  if (!feeds) {
    // 岗位搜索词转换层（小红书）：把岗位名映射为小红书友好的搜索词
    const xhsJob = normalizeXhsSearchJob(kw);
    const r = await xhsSearch(`${xhsJob} 学习路线 学习计划`);
    needLogin = r.needLogin;
    feeds = r.posts;
    xhsFeedCache.set(kw, { t: Date.now(), feeds });
  }
  if (!feeds || !feeds.length) {
    // 搜索无结果时，用真实 session cookie 判断是否需要先登录（搜索接口本身不报 needLogin）
    const needLoginFallback = needLogin || !userLoggedIn;
    return { posts: [], page: 1, pageSize, total: 0, totalPages: 0, keyword: kw, needLogin: needLoginFallback, searchStatus: needLoginFallback ? 'blocked' : 'empty' };
  }

  const total = feeds.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const p = Math.min(Math.max(1, Number(page) || 1), totalPages);
  const slice = feeds.slice((p - 1) * pageSize, p * pageSize);

  // 只返回元数据（含链接与 xsecToken），正文按需懒加载
  const posts = slice.map((f) => ({
    id: f.id,
    xsecToken: f.xsecToken,
    title: f.title,
    link: f.link,
    author: f.author,
    engagement: f.engagement,
    cover: f.cover,
    summary: f.summary || '',
  }));
  return { posts, page: p, pageSize, total, totalPages, keyword: kw, needLogin, searchStatus: 'success' };
}

// 面经实时搜索：直接以「公司 岗位 轮次 面经」为关键词，不走岗位学习路线转换层。
// 返回含链接的帖子元数据（正文按 id 懒加载），每次调用都实时请求小红书（除非命中有效缓存）。
export async function searchXhsInterview({ company, role, round, page = 1, pageSize = 10 } = {}) {
  const kw = `${company || ''} ${role || ''} ${round || ''} 面经`.replace(/\s+/g, ' ').trim();
  const cached = xhsFeedCache.get(kw);
  const userLoggedIn = activeXhsUserId ? hasUserLoginCookie(activeXhsUserId) : hasLoginCookie();
  let feeds = null;
  let needLogin = false;
  if (cached && Date.now() - cached.t < XHS_FEED_CACHE_TTL && userLoggedIn) {
    feeds = cached.feeds;
  }
  if (!feeds) {
    const r = await xhsSearch(kw); // 直接搜索面经词，不经过 normalizeXhsSearchJob 改写
    needLogin = r.needLogin;
    feeds = r.posts;
    xhsFeedCache.set(kw, { t: Date.now(), feeds });
  }
  if (!feeds || !feeds.length) {
    return { posts: [], page: 1, pageSize, total: 0, totalPages: 0, keyword: kw, needLogin: needLogin || !userLoggedIn };
  }
  const total = feeds.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const p = Math.min(Math.max(1, Number(page) || 1), totalPages);
  const slice = feeds.slice((p - 1) * pageSize, p * pageSize);
  const posts = slice.map((f) => ({
    id: f.id,
    xsecToken: f.xsecToken,
    title: f.title,
    link: f.link,
    author: f.author,
    engagement: f.engagement,
    cover: f.cover,
    summary: f.summary || '',
  }));
  return { posts, page: p, pageSize, total, totalPages, keyword: kw, needLogin };
}

// 懒加载单篇笔记正文（get_feed_detail），结果按 id 缓存
export async function getXhsPostDetail(feedId, xsecToken) {
  if (!feedId) return { content: '', images: [], error: '缺少 feedId' };
  const hit = xhsDetailCache.get(feedId);
  if (hit) return hit;

  // 切换式隔离：详情页也使用当前活跃用户自己的 cookie
  await ensureUserCookie();
  const id = () => Math.floor(Math.random() * 1e9);
  await mcpPost({
    jsonrpc: '2.0', id: id(), method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'offerdao', version: '1.0' } },
  }).catch(() => {});

  let raw = '';
  try {
    raw = await mcpPost({
      jsonrpc: '2.0', id: id(), method: 'tools/call',
      params: { name: 'get_feed_detail', arguments: { feedId, xsecToken } },
    }, 60000);
  } catch (e) {
    return { content: '', images: [], error: `获取详情失败：${e.message}` };
  }

  const text = extractText(raw);
  let content = '';
  let images = [];
  let ocrText = '';
  let ocrMissingKey = false;
  try {
    const j = safeJson(text);
    content = j?.desc || j?.description || j?.content || '';
    if (Array.isArray(j?.images)) images = j.images;
    ocrText = j?.ocrText || '';
    ocrMissingKey = !!j?.ocrMissingKey;
  } catch { /* 尝试原始文本 */ }
  if (!content && text) content = text.slice(0, 1000);
  const result = { content: String(content).trim(), images, ocrText: String(ocrText).trim(), ocrMissingKey };
  // 基于正文（含图片文字）生成简短中文概要（2-4 句），供前端「查看详情」直接展示，避免铺开冗长全文
  try {
    result.summary = await summarizePost(String(content).trim(), String(ocrText).trim());
  } catch (e) {
    console.warn('[plan] 帖子概要生成失败:', e.message);
    result.summary = '';
  }
  xhsDetailCache.set(feedId, result);
  return result;
}

// 把单篇笔记正文（可含图片文字）浓缩为 2-4 句中文概要；失败回退为原文前若干字
async function summarizePost(content, ocrText) {
  const body = [content, ocrText ? '（图片中的文字）\n' + ocrText : ''].filter(Boolean).join('\n\n').trim();
  if (!body) return '';
  if (body.length <= 120) return body; // 本身已很短，无需调用模型
  const system =
    '你是内容编辑。请把用户的小红书学习笔记浓缩为一段简洁的中文概要，' +
    '只输出 2-4 句、不超过 120 字，突出核心学习要点，不要标题、不要列表、不要解释。';
  try {
    const out = await callQwen(system, `笔记内容：\n${body.slice(0, 4000)}`);
    const text = (out || '').replace(/^["'「]|["'」]$/g, '').trim();
    return text ? text.slice(0, 200) : body.slice(0, 120);
  } catch (e) {
    return body.slice(0, 120);
  }
}

// 在已登录的小红书客户端（Playwright 有头浏览器）中打开笔记，供前端"在小红书查看"调用
export async function openXhsPost(feedId, xsecToken) {
  if (!feedId) return { ok: false, error: '缺少 feedId' };
  const id = () => Math.floor(Math.random() * 1e9);
  await mcpPost({
    jsonrpc: '2.0', id: id(), method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'offerdao', version: '1.0' } },
  }).catch(() => {});
  const raw = await mcpPost({
    jsonrpc: '2.0', id: id(), method: 'tools/call',
    params: { name: 'open_feed', arguments: { feedId, xsecToken } },
  }, 60000);
  const text = extractText(raw);
  return { ok: true, message: text || '已打开' };
}

// ---------- GitHub Trending 真实抓取 ----------
// 直接请求 github.com/trending 拿当日热门仓库列表，再对每个仓库调用 GitHub REST API
// 获取真实 description（项目在干什么/解决什么问题）。全程不调用 LLM。
// 结果写入全局表 github_trending（所有用户共享一份，不按用户隔离），每日自然日刷新一次。
export async function getTrendingInsights(opts = {}) {
  const noCache = !!opts.noCache;
  const CACHE_KEY = 'github_trending';
  if (!noCache) {
    const hit = trendingCache.get(CACHE_KEY);
    if (hit && Date.now() - hit.t < TRENDING_CACHE_TTL) return { ok: true, insights: hit.v };
  }

  const slug = (opts.lang || '').trim();
  const since = (opts.since || 'daily').trim();
  const url = slug
    ? `https://github.com/trending/${encodeURIComponent(slug)}?since=${since}`
    : `https://github.com/trending?since=${since}`;

  const html = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  }).then((r) => {
    if (!r.ok) throw new Error(`GitHub 返回 ${r.status}`);
    return r.text();
  });

  // 解析仓库路径列表（取 GitHub Trending 当页上限条数，约 18~25 条）
  const paths = [];
  const rowRe = /<article class="Box-row">([\s\S]*?)<\/article>/g;
  let m;
  while ((m = rowRe.exec(html)) && paths.length < 25) {
    const block = m[1];
    const hrefMatch = block.match(/<h2[^>]*>\s*<a[^>]*href="(\/[^"]+)"[^>]*>/i);
    const path = hrefMatch ? hrefMatch[1] : '';
    if (path && /^\/[^/]+\/[^/]+$/.test(path)) paths.push(path);
  }

  // 对每个仓库调用 GitHub REST API 拿真实 description（稳定、权威、不调 LLM）
  const repos = [];
  for (const path of paths) {
    const [owner, repo] = path.replace(/^\//, '').split('/');
    const title = `${owner} / ${repo}`;
    let stars = 0;
    let desc = '';
    try {
      const api = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/vnd.github+json' },
      }).then((r) => (r.ok ? r.json() : null));
      if (api) {
        desc = (api.description || '').trim();
        stars = Number(api.stargazers_count || 0);
      }
    } catch {
      // 单条失败不影响整体，desc 留空
    }
    repos.push({
      owner,
      repo,
      title,
      url: `https://github.com${path}`,
      desc: desc || '暂无项目描述',
      stars,
    });
    // 轻微限流保护：避免瞬间高频打 GitHub API
    await new Promise((r) => setTimeout(r, 120));
  }

  trendingCache.set(CACHE_KEY, { t: Date.now(), v: repos });
  return { ok: true, insights: repos };
}

// ---------- 对外接口 ----------
export async function getLearningPlan(keyword, days) {
  const weeks = Math.max(1, Math.min(26, Math.ceil((Number(days) || 60) / 7)));
  const key = `${keyword}__${weeks}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < CACHE_TTL) return { ...hit.v, cached: true };

  let xhs = { posts: [], raw: '', needLogin: false };
  try {
    xhs = await searchXhsPosts(keyword);
  } catch (e) {
    xhs = { posts: [], raw: `搜索失败：${e.message}`, needLogin: false };
  }

  let result;
  try {
    const built = await buildPlanWithLLM(keyword, weeks, xhs);
    result = {
      source: 'llm',
      summary: built.summary,
      plan: built.plan,
      xhsPosts: xhs.posts,
      xhsNeedLogin: xhs.needLogin,
    };
  } catch (e) {
    // 千问不可用 → 回退规则模板
    const { generateLearningPlan } = await import('../src/data/xhsData.js');
    result = {
      source: 'mock',
      summary: `（千问暂不可用，已使用通用模板计划）${e.message ? '原因：' + e.message : ''}`,
      plan: generateLearningPlan(keyword, weeks * 7),
      xhsPosts: xhs.posts,
      xhsNeedLogin: xhs.needLogin,
    };
  }

  cache.set(key, { t: Date.now(), v: result });
  return result;
}

// ---------- 小红书扫码登录（供前端设置入口） ----------
// 获取登录二维码，返回 { image: 'data:image/png;base64,...', text }
export async function getXhsQrcode() {
  const id = () => Math.floor(Math.random() * 1e9);
  await mcpPost({
    jsonrpc: '2.0', id: id(), method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'offerdao', version: '1.0' } },
  }).catch(() => {});
  // 拉码前无条件清空 MCP 全局 cookie（含关闭重建浏览器上下文），
  // 避免残留登录态让 get_login_qrcode 直接返回「已处于登录状态」而不出二维码。
  await mcpPost({
    jsonrpc: '2.0', id: id(), method: 'tools/call',
    params: { name: 'prepare_bind', arguments: {} },
  }, 60000).catch(() => {});
  const raw = await mcpPost({
    jsonrpc: '2.0', id: id(), method: 'tools/call',
    params: { name: 'get_login_qrcode', arguments: {} },
  }, 130000);

  const result = (() => {
    if (raw.includes('"result"')) {
      try { return JSON.parse(raw).result; } catch { /* fallthrough */ }
    }
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (t.startsWith('data:')) {
        try { const j = JSON.parse(t.slice(5).trim()); if (j.result) return j.result; } catch { /* ignore */ }
      }
    }
    return null;
  })();
  if (!result || !Array.isArray(result.content)) throw new Error('MCP 未返回二维码内容');

  let image = '';
  let text = '';
  for (const c of result.content) {
    if (c.type === 'image') image = c.data || '';
    else if (c.type === 'text') text = c.text || '';
  }
  // MCP 在已登录时会直接返回「你当前已处于登录状态」文本、无图片：
  // 视为已登录，向上返回明确信号，避免前端误报「获取二维码失败」。
  if (/已处于登录状态|已登录/.test(text) && !image) {
    return { image: '', loggedIn: true, text };
  }
  // 小红书会不定期阻止二维码图片回传；MCP 此时已打开有头登录窗口。
  // 统一进入窗口扫码模式，不能再把"无图片"误报成"MCP 未启动"。
  if (!image) return { image: '', browserLogin: true, text };
  return { image: `data:image/png;base64,${image}`, text };
}

// 供「绑定当前用户」流程调用的拉码接口：只返回二维码图片，
// 即使本机 xhs-cookies.json 已有他人遗留登录态也绝不返回 loggedIn（避免误判当前用户已授权）。
// 真正的绑定只能发生在用户扫码后、轮询 getXhsStatus 确认登录成功时。
export async function getXhsQrcodeForBind() {
  const data = await getXhsQrcode();
  // 剥离误导性的「本机已登录」信号（绝向用户展示 loggedIn）
  if (data && data.loggedIn) {
    // 绑定场景下，若底层 get_login_qrcode 因「全局已处于登录状态」而未出码，
    // 说明本机已有一个待绑定的登录会话（通常是用户刚扫的码）。此时不报错，
    // 而是返回 alreadyLoggedIn，让前端直接走 bindXhs() 把该全局会话绑定到当前用户，
    // 避免「未获取到登录二维码」的死胡同，也符合「扫码后自动绑定」的预期。
    return { image: '', browserLogin: true, loggedIn: false, text: data.text || '请在登录页完成本次登录后等待系统确认' };
  }
  return { image: data.image, text: data.text, loggedIn: false };
}

// 检查小红书登录态，返回 { loggedIn, notBound, raw, canBind? }
// 每个 offer dao 用户独立授权：
//  - forBind=false（页面初始探测）：未绑定则直接视为未授权，避免误用他人遗留的全局 cookie 误判已登录。
//  - forBind=true（用户正在扫码轮询）：即便尚未绑定，也要向本机小红书查询真实扫码登录态。
//      这样扫码成功后后端能返回 loggedIn:true，前端据此 bindXhs() 完成绑定，避免「未绑定→永远 notBound→永远不 bind」的死锁。
export async function checkXhsLogin(db, userId, opts = {}) {
  const forBind = !!opts.forBind;
  let bound = false;
  if (db && userId) {
    // 绑定状态以 users.xhs_bound 为准（db.mjs 的 JSON 存储仅对此字段做了持久化支持，
    // xhs_accounts 表的 upsert 在自定义 DB 下会被静默吞掉，故统一用 users.xhs_bound）。
    const row = db.prepare('SELECT xhs_bound FROM users WHERE id = ?').get(userId);
    bound = !!(row && row.xhs_bound === 1);
    // 非扫码探测场景下，未绑定直接视为未授权（防止误用他人 cookie 误判）
    if (!bound && !forBind) {
      return { loggedIn: false, notBound: true, raw: '该用户尚未绑定小红书账号' };
    }
  }
  // 本地 cookie 硬证据：登录成功时 MCP 的 waitForLoginBackground 已把含 web_session 的
  // 有效登录 cookie 落盘到 xhs-cookies.json。这个文件存在且含登录态关键 cookie，比「再用
  // 无头浏览器重访小红书」更可靠、更快（后者常因网络策略慢/超时而误判未登录，
  // 导致「手机已登录成功、电脑却一直没反应、永不绑定」的死锁）。
  // 该判定仅在 forBind 扫码轮询场景启用：未绑定用户的 page 初始探测仍靠 MCP 文本，不受影响。
  // 本地 cookie 文件作为「快速失败反向判断」：仅当 COOKIES_PATH 不存在时才直接判未登录，
  // 避免未登录时反复拉起无头浏览器（极慢/易卡）。但 cookie 文件存在 ≠ 登录有效
  // （服务端可能已让 session 失效），所以「存在」不再直接判已登录，而交由下方 MCP 真实
  // 校验（check_login_status 已改为无头真实验证），保证与 search_feeds 结果一致，杜绝假阳性。
  let noLocalCookie = false;
  if (forBind) {
    try {
      const cpath = process.env.COOKIES_PATH || path.join(__dirname, '..', 'xhs-cookies.json');
      if (!fs.existsSync(cpath)) noLocalCookie = true;
    } catch {
      noLocalCookie = true;
    }
  }
  // ---------- 单飞 + 短缓存：收敛高频轮询对 MCP 的并发 30s 调用 ----------
  const key = loginCheckKey(userId, forBind);
  const cached = _loginCheckCache.get(key);
  if (cached && Date.now() - cached.t < 3000) return cached.v;
  if (_loginCheckInFlight.has(key)) return _loginCheckInFlight.get(key);
  const inFlight = (async () => {
    try {
      const id = () => Math.floor(Math.random() * 1e9);
      await mcpPost({
        jsonrpc: '2.0', id: id(), method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'offerdao', version: '1.0' } },
      }).catch(() => {});
      const raw = await mcpPost({
        jsonrpc: '2.0', id: id(), method: 'tools/call',
        params: { name: 'check_login_status', arguments: {} },
      }, 30000);
      const v = _finishLoginCheck(raw, forBind, bound, noLocalCookie);
      _loginCheckCache.set(key, { t: Date.now(), v });
      return v;
    } finally {
      _loginCheckInFlight.delete(key);
    }
  })();
  _loginCheckInFlight.set(key, inFlight);
  return inFlight;
}

// 抽离：根据 MCP 返回文本计算登录态结果（与缓存/单飞解耦）
function _finishLoginCheck(text, forBind, bound, noLocalCookie) {
  // 结构化优先：MCP 在「已扫码待确认」时会返回 JSON {status:'scanned',message:...}，
  // 让前端能在手机扫码后立刻反馈并锁定二维码防重复扫码。
  let scanned = false;
  let scannedMessage = '';
  const sj = safeJson(text);
  if (sj && sj.status === 'scanned') {
    scanned = true;
    scannedMessage = sj.message || '已扫描，请在手机上确认登录';
  }
  // MCP 不同版本返回的登录提示文本不完全一致，兼容英文状态和既有中文状态。
  const mcpLoggedIn = /\u2705|\u5df2\u767b\u5f55|\u5f53\u524d\u5df2\u5904\u4e8e\u767b\u5f55\u72b6\u6001|\u767b\u5f55\u6210\u529f|logged\s*in|login\s*(success|ok)|already\s*logged/i.test(text);
  // forBind 扫码轮询场景：若本地全局 COOKIES_PATH 不存在，直接判未登录（快速失败，
  // 避免反复拉起无头浏览器）；存在则交由下方 MCP 真实无头校验，杜绝失效 cookie 假阳性。
  if (forBind && noLocalCookie) {
    return { loggedIn: false, notBound: !bound, scanned: false, raw: text };
  }
  // 登录态以 MCP 真实校验（mcpLoggedIn）为准。已绑定用户的有效登录证据应是「全局 xhs-cookies.json
  // 已落盘（手机登录成功后由 MCP 写入）+ MCP 真实校验通过」，不再强制要求 data/xhs/user_<id>.json
  // 这个历史上从未被维护的隔离 cookie 文件（否则会导致「手机已登录、MCP 返回已登录、却因隔离文件缺失
  // 而被判未登录」的死锁，前端永远卡在二维码）。隔离文件仅作为快速失败反向判断（不存在则直接未登录，
  // 见上方 forBind noLocalCookie 分支），存在与否不再阻断已登录判定。
  const globalCookieOk = !forBind || !noLocalCookie;
  const loggedIn = mcpLoggedIn && globalCookieOk;
  // 扫码轮询场景：若本机真实已登录但当前用户尚未绑定，标记 canBind 供前端完成绑定
  if (forBind && loggedIn && !bound) {
    return { loggedIn: true, notBound: true, canBind: true, scanned, scannedMessage, raw: text };
  }
  return { loggedIn, notBound: !bound, scanned, scannedMessage, raw: text };
}

// 注意：本项目不提供「退出小红书登录 / 切换账号」能力，以避免清除用户在本机的小红书登录态。
// 小红书登录态由 xhs-cookies.json + MCP 内存 cookie 维护，仅通过扫码登录新增/复用，绝不主动登出。
