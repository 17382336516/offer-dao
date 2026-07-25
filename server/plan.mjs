// 学习计划生成：先通过小红书 MCP（search_feeds）搜索真实「学习路线」，
// 再把素材交给千问(qwen-turbo) 整合规划成结构化周计划。
// 容错：小红书未登录/超时 → 仍用千问基于通用知识生成；千问不可用 → 回退规则模板。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const TYPE_ICON = { read: '📖', video: '▶️', code: '💻', homework: '✏️' };

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

// ---------- 千问调用（qwen-turbo） ----------
async function callQwen(system, user, model) {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) throw new Error('未配置 DASHSCOPE_API_KEY，已回退规则模板');
  const m = model || process.env.QWEN_MODEL || 'qwen-turbo';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    const res = await fetch(QWEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: m,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.4,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`千问接口 ${res.status}: ${t.slice(0, 200)}`);
    }
    const json = await res.json();
    return json?.choices?.[0]?.message?.content || '';
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 小红书 MCP 调用 ----------
async function mcpPost(payload, timeoutMs = 90000) {
  const res = await fetch(XHS_MCP, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
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
  if (/未登录|扫码|请使用.*登录|二维码/.test(text)) {
    return { posts: [], raw: text, needLogin: true };
  }
  const posts = tryExtractFeeds(text);
  return { posts, raw: text || raw, needLogin: false };
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
    `共${weeks}周，每周7天，任务要具体可执行、循序渐进。`;

  const user =
    `目标岗位：${keyword}\n学习总周数：${weeks} 周\n\n` +
    `小红书搜到的真实学习路线素材：\n${xhsText}\n\n` +
    `请据此为「${keyword}」制定 ${weeks} 周学习计划，每阶段循序渐进，任务细化到每天并可执行。`;

  const content = await callQwen(system, user);
  const parsed = safeJson((content.match(/\{[\s\S]*\}/) || [content])[0]) || {};
  const plan = Array.isArray(parsed.plan)
    ? parsed.plan.map(normalizeWeek).slice(0, weeks)
    : [];
  while (plan.length < weeks) plan.push(defaultWeek(plan.length));

  return {
    summary: parsed.summary || `已结合小红书学习路线，为「${keyword}」制定 ${weeks} 周学习计划。`,
    plan,
  };
}

// ---------- 整合学习路线：真实帖子素材（答案A）+ 通用知识（答案B）→ 整合（答案C） ----------
async function buildPlanFromText(keyword, weeks, sourceLabel, postsText) {
  const system =
    '你是资深求职规划教练。请基于提供的学习素材，为目标岗位求职者制定结构化周学习计划。' +
    '只输出 JSON，结构为：{"summary":"整体规划思路(2-4句)","plan":[{"week":1,"topic":"阶段主题","goal":"本周目标",' +
    '"tasks":[{"day":1,"tasks":[{"name":"任务名","duration":"分钟数+min","type":"read|video|code|homework"}]}]}]}。' +
    `共${weeks}周，每周7天，任务要具体可执行、循序渐进。`;
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
    `共${weeks}周，每周7天。`;
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
export async function generateIntegratedPlan(keyword, days, storedPosts) {
  const weeks = Math.max(1, Math.min(26, Math.ceil((Number(days) || 60) / 7)));
  const posts = Array.isArray(storedPosts) ? storedPosts.slice(0, 6) : [];
  if (!posts.length) {
    throw new Error('尚未保存帖子内容，请先在「小红书学习帖子」区点击「保存帖子正文与图片文字」');
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

  const result = await buildCombinedPlan(keyword, weeks, postsText).catch((e) => ({
    summary: '',
    sections: [],
    error: e.message,
  }));
  if (result.error) throw new Error(result.error);

  return {
    source: 'integrated',
    summary: result.summary,
    sections: result.sections,
    xhsPosts: posts.map((p) => ({ title: p.title, link: p.link })),
  };
}

// 把「正文 + 图片转文字」整合后的一段素材，连同通用知识，一次交由大模型整理为带链接的学习板块
async function buildCombinedPlan(keyword, weeks, postsText) {
  const system =
    '你是资深求职规划教练，擅长把真实的学习路线素材整理成可执行的学习资源清单。' +
    '请基于用户提供的「目标岗位学习路线」素材（小红书帖子正文与图片转文字已整合为一段），' +
    '结合你对该岗位的通用专业知识，输出若干学习板块（section）。' +
    '只输出 JSON，结构为：{"summary":"整体规划思路(2-4句)","sections":[{"part":1,"title":"板块名称",' +
    '"platform":"bilibili 或 github","link":"该板块对应的 B站 或 GitHub 可用链接","content":"本板块的学习主要内容(2-4句)"}]}。' +
    '每个板块必须是真实、可用、与板块主题强相关的 B站(bilibili.com) 视频 或 GitHub(github.com) 仓库/项目链接；' +
    '链接要具体可访问，禁止使用占位或示例链接。板块数量建议 4-8 个，循序渐进。';
  const user =
    `目标岗位：${keyword}\n\n` +
    `【目标岗位学习路线】\n` +
    `以上是「${keyword}」的学习路线需求，请围绕该目标岗位规划学习资源。\n\n` +
    `【整合路线主要内容】（小红书帖子正文 + 图片转文字，已整合为一段真实素材）\n${postsText}\n\n` +
    `请综合以上「目标岗位学习路线」与「整合路线主要内容」，结合你对「${keyword}」的通用专业知识，` +
    `输出若干学习板块，每个板块给出一个 B站 或 GitHub 的可用链接，并附上该板块的学习主要内容。`;
  const content = await callQwen(system, user);
  const parsed = safeJson((content.match(/\{[\s\S]*\}/) || [content])[0]) || {};
  const sections = Array.isArray(parsed.sections) ? parsed.sections : [];
  const normalized = sections.map((s, i) => {
    const link = String(s.link || '');
    const platform = /github/i.test(s.platform || '') || /github\.com/i.test(link) ? 'github' : 'bilibili';
    return {
      part: Number(s.part) || i + 1,
      title: String(s.title || `板块${i + 1}`),
      platform,
      link,
      content: String(s.content || ''),
    };
  });
  return {
    summary: parsed.summary || `已结合小红书真实素材与通用知识，为「${keyword}」整理学习资源板块。`,
    sections: normalized,
  };
}

// 仅搜索小红书学习路线，返回真实帖子链接（供选岗保存后自动触发）
export async function searchXhsPosts(keyword) {
  const xhs = await xhsSearch(`${keyword} 学习路线 学习计划`);
  return { posts: xhs.posts, needLogin: xhs.needLogin, raw: xhs.raw };
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
  if (cached && Date.now() - cached.t < XHS_FEED_CACHE_TTL) {
    feeds = cached.feeds;
  }
  if (!feeds) {
    const r = await xhsSearch(`${kw} 学习路线 学习计划`);
    needLogin = r.needLogin;
    feeds = r.posts;
    xhsFeedCache.set(kw, { t: Date.now(), feeds });
  }
  if (!feeds || !feeds.length) {
    // 搜索无结果时，用真实 session cookie 判断是否需要先登录（搜索接口本身不报 needLogin）
    const needLoginFallback = needLogin || !hasLoginCookie();
    return { posts: [], page: 1, pageSize, total: 0, totalPages: 0, keyword: kw, needLogin: needLoginFallback };
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
  return { posts, page: p, pageSize, total, totalPages, keyword: kw, needLogin };
}

// 懒加载单篇笔记正文（get_feed_detail），结果按 id 缓存
export async function getXhsPostDetail(feedId, xsecToken) {
  if (!feedId) return { content: '', images: [], error: '缺少 feedId' };
  const hit = xhsDetailCache.get(feedId);
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
  xhsDetailCache.set(feedId, result);
  return result;
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

// ---------- 对外接口 ----------
export async function getLearningPlan(keyword, days) {
  const weeks = Math.max(1, Math.min(26, Math.ceil((Number(days) || 60) / 7)));
  const key = `${keyword}__${weeks}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < CACHE_TTL) return { ...hit.v, cached: true };

  let xhs = { posts: [], raw: '', needLogin: false };
  try {
    xhs = await xhsSearch(`${keyword} 学习路线 学习计划`);
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
  if (!image) throw new Error('未获取到二维码图片（请确认小红书 MCP 服务已启动）');
  return { image: `data:image/png;base64,${image}`, text };
}

// 检查小红书登录态，返回 { loggedIn, raw }
export async function checkXhsLogin() {
  const id = () => Math.floor(Math.random() * 1e9);
  await mcpPost({
    jsonrpc: '2.0', id: id(), method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'offerdao', version: '1.0' } },
  }).catch(() => {});
  const raw = await mcpPost({
    jsonrpc: '2.0', id: id(), method: 'tools/call',
    params: { name: 'check_login_status', arguments: {} },
  }, 30000);
  const text = extractText(raw);
  return { loggedIn: /✅|已登录/.test(text), raw: text };
}
