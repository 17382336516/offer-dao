// 前端与后端 API 交互的封装：统一处理 token 与会话。
const TOKEN_KEY = 'offerToToken';
// 兜底默认值：云端若漏配 VITE_API_BASE_URL，回退到 Render 后端，避免前端所有 /api 请求打到 Vercel 自身导致 404。
const API_BASE_URL = String(import.meta.env.VITE_API_BASE_URL || 'https://offer-dao.onrender.com').replace(/\/$/, '');

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}
export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

async function apiFetch(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  // 前端统一超时：避免耗时请求无响应时界面一直转圈。
  // 默认 300s；生成学习计划（小红书抓取 + 大模型多次调用）耗时较长，调用方可传入更高 timeout。
  const timeoutMs = Number(options.timeout) || 300000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${API_BASE_URL}/api${path}`, { ...options, headers, signal: controller.signal });
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new Error(`请求超时（>${Math.round(timeoutMs / 1000)}s），生成学习计划耗时过长，可能是模型加载或网络异常，请稍后重试`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try { data = await res.json(); } catch { /* 无响应体 */ }
  if (!res.ok) {
    const msg = (data && data.error) || `请求失败 (${res.status})`;
    const err = new Error(msg);
    // 附带状态码与业务错误码，便于调用方区分处理（如 409 PLAN_EXISTS 需弹出覆盖确认框）
    err.status = res.status;
    err.code = data && data.code;
    err.data = data;
    throw err;
  }
  return data;
}

// 会员状态持久化：登录/注册后写入 localStorage，刷新页面后由 Navbar/弹窗直接读取，避免丢失。
// 后端 user 含 isVip（由 users.tier 映射），此处只做前端存储，不改动用户系统。
export function setVipState(isVip) {
  try { localStorage.setItem('offerToVip', isVip ? '1' : '0'); } catch {}
}
export function getVipState() {
  try { return localStorage.getItem('offerToVip') === '1'; } catch { return false; }
}
export function clearVipState() {
  try { localStorage.removeItem('offerToVip'); } catch {}
}

export async function register(username, password) {
  const data = await apiFetch('/register', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
  setToken(data.token);
  if (data.user && typeof data.user.isVip === 'boolean') setVipState(data.user.isVip);
  else if (data.user && data.user.tier) setVipState(data.user.tier === 'member');
  return data.user;
}

export async function login(username, password) {
  const data = await apiFetch('/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
  setToken(data.token);
  if (data.user && typeof data.user.isVip === 'boolean') setVipState(data.user.isVip);
  else if (data.user && data.user.tier) setVipState(data.user.tier === 'member');
  return data.user;
}

export async function logout() {
  setToken('');
  clearVipState();
}

// 阶段一：将小红书多路线帖子 -> 结构化岗位学习路线 JSON
export async function analyzeLearningRoute(job, posts) {
  return apiFetch('/learning-route/analyze', {
    method: 'POST',
    body: JSON.stringify({ job, posts }),
  });
}

// 阶段二：将岗位学习路线 JSON -> 标准技能树（标准化同义技能）
export async function normalizeSkills(route, job) {
  return apiFetch('/skills/normalize', {
    method: 'POST',
    body: JSON.stringify({ route, job }),
  });
}

export async function getProfile() {
  try {
    const data = await apiFetch('/profile', { method: 'GET' });
    return data.profile;
  } catch (e) {
    if (e.message.includes('401') || e.message.includes('404')) return null;
    throw e;
  }
}

export async function saveProfile(profile) {
  const data = await apiFetch('/profile', {
    method: 'PUT',
    body: JSON.stringify(profile),
  });
  return data.profile;
}

// 由目标日推导「剩余天数」（倒计时语义，与后端 daysFromTarget 保持一致）
export function daysFromTarget(targetDate) {
  if (!targetDate) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(targetDate);
  target.setHours(0, 0, 0, 0);
  return Math.max(0, Math.ceil((target - today) / 86400000));
}

// 统一「总学习天数」真源（含首尾）：与后端 deriveDays 一致。
// 优先 目标日-开始日（含两端），缺开始日时回退 剩余天数+1（至少 1 天）。
export function totalDaysFromDates(startDate, targetDate) {
  if (startDate && targetDate) {
    const s = new Date(startDate); s.setHours(0, 0, 0, 0);
    const t = new Date(targetDate); t.setHours(0, 0, 0, 0);
    const d = Math.round((t - s) / 86400000) + 1;
    if (d >= 1) return d;
  }
  const rem = daysFromTarget(targetDate);
  return rem == null ? null : Math.max(1, rem + 1);
}

// 唯一入口：修改「目标日/学习天数」。
// 三处（注册日历 / 调整计划 / 今日计划）都只调用它，
// 负责：写后端 profiles.target_date（真源）+ 同步 localStorage 派生 days（含首尾，与后端一致）。
export async function saveTargetDate(targetDate) {
  const profile = await getProfile().catch(() => null);
  const startDate = profile && profile.startDate;
  const days = totalDaysFromDates(startDate, targetDate);
  await saveProfile({ targetDate });
  const raw = localStorage.getItem('offerToJobInfo');
  let jobInfo = {};
  try { jobInfo = raw ? JSON.parse(raw) : {}; } catch { jobInfo = {}; }
  jobInfo.targetDate = targetDate;
  jobInfo.days = days;
  localStorage.setItem('offerToJobInfo', JSON.stringify(jobInfo));
  return { targetDate, days };
}

// 修改「学习开始日」：写入后端 profiles.start_date（真源）。
export async function saveStartDate(startDate) {
  await saveProfile({ startDate });
  const raw = localStorage.getItem('offerToJobInfo');
  let jobInfo = {};
  try { jobInfo = raw ? JSON.parse(raw) : {}; } catch { jobInfo = {}; }
  jobInfo.startDate = startDate;
  localStorage.setItem('offerToJobInfo', JSON.stringify(jobInfo));
  return { startDate };
}

// 触发后端生成每日学习计划（targetDays 缺省时由 target_date 自动推导）
export async function generateDailyPlan(payload = {}) {
  const data = await apiFetch('/daily-plan/generate', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return data;
}

// 动态计划调整系统：风险探测（剩余任务量 / 剩余天数 → 每日负荷）
export async function getPlanRisk() {
  const data = await apiFetch('/learning-plan/risk', { method: 'GET' });
  return data;
}

// 动态计划调整系统：按目标日重新规划剩余每日任务（仅调整执行层，不重排路线/不重匹配资源）
// strategy: 'keep_daily_load'（保持每日学习强度，日期顺延）
export async function reschedulePlan(targetDate, reason, strategy) {
  const data = await apiFetch('/learning-plan/reschedule', {
    method: 'POST',
    body: JSON.stringify({ targetDate, reason, strategy }),
  });
  return data;
}

// 当前板块内：按剩余规划日自动重排（日期自然跳转 / 测试下一天触发）
// fromDate：切换前的日期，其未完成任务将并入当前板块剩余一起重新规划
export async function rescheduleWithinStage(fromDate) {
  const data = await apiFetch('/learning-plan/reschedule-within-stage', {
    method: 'POST',
    body: JSON.stringify({ fromDate }),
  });
  return data;
}

// ============ AI 面经整理模块 ============
// 实时搜索小红书 + RAG 历史检索 + 一次 LLM 整理，返回三类结构化问题
export async function searchInterviewExperience({ company, role, round, useLocalOnly }) {
  const body = { company, role, round };
  if (useLocalOnly === true) body.useLocalOnly = true;
  const data = await apiFetch('/interview-experience/search', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return data;
}
// 历史面经会话列表（不调 LLM，仅读已存结果）
export async function getInterviewHistory() {
  const data = await apiFetch('/interview-experience/history', { method: 'GET' });
  return data;
}
// 某次面经整理详情（不调 LLM）
export async function getInterviewDetail(sessionId) {
  const data = await apiFetch(`/interview-experience/detail?sessionId=${encodeURIComponent(sessionId)}`, { method: 'GET' });
  return data;
}


// 动态计划调整系统：每日结算（不自动改计划，返回是否需要调整/风险/阶段保护）
export async function getDailySettlement() {
  const data = await apiFetch('/learning-plan/daily-settlement', { method: 'GET' });
  return data;
}

// 动态计划调整系统：用户确认风险调整
// action: 'reschedule' | 'keep'；strategy 仅 reschedule 时生效
export async function confirmAdjustPlan(action, reason, strategy) {
  const data = await apiFetch('/learning-plan/confirm-adjust', {
    method: 'POST',
    body: JSON.stringify({ action, reason, strategy }),
  });
  return data;
}

// 单资源打卡：完成当天某一个独立学习任务（视频分P / PDF 章节），可多次对不同资源打卡
// resource 为任务回传的资源指纹（url/part/docId/section/title），用于后端在「原行数组」精确匹配，
// 避免今日任务经重排预览展开后数量/顺序与数据库原行不一致导致按 index 定位越界。
export async function checkinDailyTask(taskId, resource) {
  const data = await apiFetch('/daily-task/checkin', {
    method: 'POST',
    body: JSON.stringify(resource ? { taskId, resource } : { taskId }),
  });
  return data;
}

// 取消完成：撤销单个资源（视频分P / PDF 章节）的当日打卡完成态
export async function uncheckinDailyTask(taskId, resource) {
  const data = await apiFetch('/daily-task/uncheckin', {
    method: 'POST',
    body: JSON.stringify(resource ? { taskId, resource } : { taskId }),
  });
  return data;
}

// 获取今日学习任务状态（含每个独立子任务完成状态、完成数、笔记可生成信息）
export async function getTodayDailyTask() {
  const data = await apiFetch('/daily-task/today', { method: 'GET' });
  return data;
}

// 生成「今日」学习笔记：仅基于当天已完成资源，每天最多 2 次，第2次覆盖第1次
export async function generateLearningNote(date) {
  const data = await apiFetch('/learning-note/generate', {
    method: 'POST',
    body: JSON.stringify(date ? { date } : {}),
  });
  return data;
}

// 查询笔记生成实时进度（轮询用，展示进度条 + 各模块耗时）
export async function getNoteProgress(date) {
  const data = await apiFetch(`/learning-note/progress${date ? `?date=${encodeURIComponent(date)}` : ''}`, {
    method: 'GET',
  });
  return data;
}

// 查询某天已生成的学习笔记（按 note_date）
export async function getLearningNote(date) {
  const data = await apiFetch(`/learning-note/${date}`, { method: 'GET' });
  return data;
}

// 查询全部学习笔记，按「月份 → 日期」两层分组（用于笔记归档列表）
export async function getLearningNoteHistory() {
  const data = await apiFetch('/learning-notes', { method: 'GET' });
  return data;
}

// 测试模式：获取测试状态（testMode / testDate / 是否 mock 笔记）
export async function getTestMode() {
  const data = await apiFetch('/test-mode', { method: 'GET' });
  return data;
}

// 测试模式：设置模拟日期（testDate 为 'YYYY-MM-DD'；传 null 清除，恢复真实日期）
export async function setTestDate(testDate) {
  const data = await apiFetch('/test-mode', {
    method: 'POST',
    body: JSON.stringify({ testDate }),
  });
  return data;
}

// 常驻：日历「模拟提交」——把指定日期的计划任务标记完成并写入打卡记录（模拟那天真实学习并提交）
export async function simulateDay(date) {
  return apiFetch('/simulate-day', {
    method: 'POST',
    body: JSON.stringify({ date }),
  });
}

// 常驻：获取/调整网站认为的「当前日期」（独立于测试模式，任何环境可用）
export async function getCurrentDate() {
  return apiFetch('/current-date', { method: 'GET' });
}
// currentDate 为 'YYYY-MM-DD' 或 null（null 表示清除，恢复真实日期）
export async function setCurrentDate(currentDate) {
  return apiFetch('/current-date', {
    method: 'POST',
    body: JSON.stringify({ currentDate }),
  });
}

// —— 动态学习计划调整 ——
// 应用重新安排：
//   mode='reschedule' → 整体重排剩余计划（未完成内容 + 剩余任务按目标日重新规划）
//   默认 → 顺延补做（前序未完成内容并入今日）
export async function applyDailyPlanAdjust(today, mode) {
  const body = today ? { today } : {};
  if (mode) body.mode = mode;
  return apiFetch('/daily-plan/adjust', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// —— NovaForge 阶段知识沉淀 ——
// 各阶段完成进度：是否已完成、是否可生成阶段总结、是否已生成
export async function getStageProgress() {
  return apiFetch('/stage/progress', { method: 'GET' });
}

// 生成阶段知识总结（输入为该阶段的每日笔记，不读取原始 PDF / 视频）
export async function generateStageNote(stageId) {
  return apiFetch('/stage-note/generate', {
    method: 'POST',
    body: JSON.stringify({ stageId }),
  });
}

// 查询已生成的阶段总结
export async function getStageNote(stageId) {
  return apiFetch(`/stage-note/${encodeURIComponent(stageId)}`, { method: 'GET' });
}

export async function getBossRequirements(keyword, city) {
  const qs = new URLSearchParams();
  if (keyword) qs.set('keyword', keyword);
  if (city) qs.set('city', city);
  return apiFetch('/boss/requirements?' + qs.toString(), { method: 'GET' });
}

// 固定技能树：阶段(一级) → 技能(二级) → 搜索词(三级)。job 缺省 AI产品经理。
export async function getAiPmSkillTree(job) {
  const qs = new URLSearchParams();
  if (job) qs.set('job', job);
  return apiFetch('/skill-tree?' + qs.toString(), { method: 'GET' });
}

export async function getBossSession() {
  return apiFetch('/boss/session', { method: 'GET' });
}

export async function saveBossSession(cookie) {
  return apiFetch('/boss/session', {
    method: 'PUT',
    body: JSON.stringify({ cookie }),
  });
}

export async function refreshBossLibrary() {
  return apiFetch('/admin/boss/refresh', { method: 'POST' });
}

export async function getBossLibraryStatus() {
  return apiFetch('/admin/boss/snapshots', { method: 'GET' });
}

export async function getAdminUsers() {
  return apiFetch('/admin/users', { method: 'GET' });
}

export async function updateAdminUser(userId, role, tier) {
  return apiFetch('/admin/users', {
    method: 'PATCH',
    body: JSON.stringify({ userId, role, tier }),
  });
}

export async function getDirectionConfigs() {
  return apiFetch('/admin/directions', { method: 'GET' });
}

export async function updateDirectionConfig(payload) {
  return apiFetch('/admin/directions', {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export async function getMailboxAccount() {
  const data = await apiFetch('/mailbox/account', { method: 'GET' });
  return { account: data.account, accounts: data.accounts || [] };
}

export async function saveMailboxAccount(payload) {
  const data = await apiFetch('/mailbox/account', {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
  return { account: data.account, accounts: data.accounts || [] };
}

export async function deleteMailboxAccount(email) {
  const data = await apiFetch('/mailbox/account', {
    method: 'DELETE',
    body: JSON.stringify({ email }),
  });
  return data.accounts || [];
}

export async function testMailboxAccount(email) {
  return apiFetch('/mailbox/test', {
    method: 'POST',
    body: JSON.stringify(email ? { email } : {}),
  });
}

export async function getMailboxInvites(limit = 10) {
  const qs = new URLSearchParams();
  qs.set('limit', String(limit));
  return apiFetch('/mailbox/invites?' + qs.toString(), { method: 'GET' });
}

export async function getInterviewEvents() {
  const data = await apiFetch('/interviews', { method: 'GET' });
  return data.items || [];
}

export async function confirmInterviewEvent(id) {
  const data = await apiFetch('/interviews/confirm', {
    method: 'POST',
    body: JSON.stringify({ id }),
  });
  return data;
}

export async function getInterviewSchedules() {
  const data = await apiFetch('/interviews/schedules', { method: 'GET' });
  return data.items || [];
}

export async function getLearningPlan(jobName, days) {
  const qs = new URLSearchParams();
  if (jobName) qs.set('keyword', jobName);
  if (days) qs.set('days', days);
  return apiFetch('/plan?' + qs.toString(), { method: 'GET' });
}

// 小红书扫码登录入口
export async function getXhsQrcode() {
  return apiFetch('/xhs/qrcode', { method: 'GET' });
}
export async function getXhsStatus(opts = {}) {
  // 返回当前用户的小红书绑定态 { bound, cookieValid }（用户级隔离，不把本机/他人 cookie 当作已登录）
  const params = new URLSearchParams();
  if (opts.bind) params.set('bind', '1');
  if (opts.check) params.set('check', '1');
  const qs = params.toString() ? `?${params.toString()}` : '';
  return apiFetch(`/xhs/status${qs}`, { method: 'GET' });
}
export async function bindXhs() {
  return apiFetch('/xhs/bind', { method: 'POST' });
}
export async function unbindXhs() {
  return apiFetch('/xhs/unbind', { method: 'POST' });
}

// 搜索小红书帖子：返回最多 20 条热门帖（含链接），正文按需懒加载
export async function getXhsPosts(keyword, page = 1, pageSize = 20) {
  const qs = new URLSearchParams();
  qs.set('keyword', keyword || '');
  qs.set('page', page);
  qs.set('pageSize', pageSize);
  return apiFetch('/xhs/posts?' + qs.toString(), { method: 'GET' });
}

// 懒加载单篇帖子正文
export async function getXhsPostDetail(feedId, xsecToken) {
  const qs = new URLSearchParams();
  qs.set('feedId', feedId || '');
  qs.set('xsecToken', xsecToken || '');
  return apiFetch('/xhs/post?' + qs.toString(), { method: 'GET' });
}

// 在已登录的小红书客户端（服务端 Playwright 浏览器）中打开笔记
export async function openXhsPost(feedId, xsecToken) {
  return apiFetch('/xhs/open', {
    method: 'POST',
    body: JSON.stringify({ feedId, xsecToken }),
  });
}

// 把 3 篇帖子的正文+图片文字保存到后端（profiles.xhs_post_contents）
export async function saveXhsPostContents(posts) {
  return apiFetch('/xhs/save-contents', {
    method: 'POST',
    body: JSON.stringify({ posts }),
  });
}

// 生成整合学习路线：基于帖子素材（自动抓取或已保存）+ 目标岗位通用知识，由大模型整合。
// opts.autoFetch=true 时后端自动搜索并抓取 count 篇帖子的正文与图片转文字。
export async function getIntegratedPlan(jobName, days, opts = {}) {
  const qs = new URLSearchParams();
  if (jobName) qs.set('keyword', jobName);
  if (days) qs.set('days', days);
  if (opts.autoFetch) qs.set('autoFetch', '1');
  if (opts.skipXhs) qs.set('skipXhs', '1');
  if (opts.count) qs.set('count', String(opts.count));
  if (opts.force) qs.set('force', '1');
  return apiFetch('/plan/integrated?' + qs.toString(), { method: 'POST', timeout: 300000 });
}

// 读取已持久化的学习计划（若无则返回 null），用于登录/刷新后自动渲染
export async function getSavedIntegratedPlan() {
  try {
    const data = await apiFetch('/plan/integrated', { method: 'GET' });
    return { plan: data.plan || null, createdAt: data.created_at || null, days: data.days || null };
  } catch {
    return { plan: null, createdAt: null, days: null };
  }
}

// 清除已保存的学习计划（更改目标岗位时使用：旧计划不被保留）
export async function deleteIntegratedPlan() {
  return apiFetch('/plan/integrated', { method: 'DELETE' });
}

// 更新已保存的学习计划内容（新增/删除部分等），不重新生成
export async function saveIntegratedPlan(data, days) {
  return apiFetch('/plan/integrated', {
    method: 'PATCH',
    body: JSON.stringify({ data, days }),
  });
}

// 热门项目：读取全局 GitHub Trending 每日快照。opts.force=true 时绕过当天缓存重新抓取。
export async function getTrendingInsights() {
  // 仅从数据库读取全局每日快照，不触发抓取（抓取由系统零点定时任务负责）
  const data = await apiFetch('/plan/trending', { method: 'GET' });
  return data; // 返回 { date, updatedAt, insights }
}

// ---------- RAG 知识库 ----------
export async function listRagDocs() {
  const data = await apiFetch('/rag/docs', { method: 'GET' });
  return data.docs || [];
}
export async function ingestRagDoc({ title, content, source, ref, meta }) {
  return apiFetch('/rag/ingest', {
    method: 'POST',
    body: JSON.stringify({ title, content, source, ref, meta }),
  });
}
export async function reindexRagXhs() {
  return apiFetch('/rag/reindex-xhs', { method: 'POST' });
}
export async function importRagSources(force = false) {
  return apiFetch('/rag/import-sources', {
    method: 'POST',
    body: JSON.stringify({ force }),
  });
}
export async function reindexRagSources() {
  return apiFetch('/rag/reindex', { method: 'POST' });
}
export async function deleteRagDoc(docId) {
  return apiFetch('/rag/doc?docId=' + encodeURIComponent(docId), { method: 'DELETE' });
}
export async function queryRag({ query, topK, source }) {
  return apiFetch('/rag/query', {
    method: 'POST',
    body: JSON.stringify({ query, topK, source }),
  });
}

// 阶段终：将「岗位技能树 + 技能依赖 + PDF 匹配 + B站课程」融合生成最终学习计划
// force=true 表示用户已确认覆盖旧计划；否则后端在已有计划时返回 409 PLAN_EXISTS
// generationMode: 'xhs_rag'（小红书数据 + 本地 RAG）| 'rag_only'（仅本地 RAG）
//   xhsPosts 仅在 xhs_rag 模式下由前端抓取并注入，rag_only 模式不传。
export async function generateLearningPlan({ job, skillTree, pdfResources, videoResources, force = false, generationMode = 'rag_only', xhsPosts = [] }) {
  return apiFetch('/learning-plan/generate', {
    method: 'POST',
    body: JSON.stringify({ job, skillTree, pdfResources, videoResources, force, generationMode, xhsPosts }),
  });
}

// MVP 主链路：只传岗位，后端跑完 小红书->技能树->标准化->PDF/B站匹配->总体阶段计划
// 返回的计划只有 stages（阶段级），不含每日任务；资源均为后端回填的真实数据。
export async function generateMvpPlan({ job, xhsPosts = [], force = false }) {
  return apiFetch('/mvp/plan', {
    method: 'POST',
    body: JSON.stringify({ job, xhsPosts, force }),
  });
}

// 读取当前用户已保存的学习计划（用于进入页面时回显、判断是否首次生成）
export async function getSavedLearningPlan() {
  return apiFetch('/learning-plan', { method: 'GET' });
}

// 删除当前用户的学习计划与学习进度
export async function deleteLearningPlan() {
  return apiFetch('/learning-plan', { method: 'DELETE' });
}

// 保存学习进度
export async function saveLearningProgress(progress) {
  return apiFetch('/learning-plan/progress', {
    method: 'PATCH',
    body: JSON.stringify({ progress }),
  });
}

// ---------- 每日任务 ----------
// 生成当天（或指定 planIndex）的每日任务，从学习计划派生并持久化
export async function generateDailyTasks({ planIndex } = {}) {
  const body = {};
  if (planIndex !== undefined && planIndex !== null) body.planIndex = planIndex;
  return apiFetch('/daily-tasks', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// 读取某天（默认今天）的每日任务
export async function getDailyTasks(date) {
  const qs = new URLSearchParams();
  if (date) qs.set('date', date);
  return apiFetch('/daily-tasks?' + qs.toString(), { method: 'GET' });
}

// 勾选/取消勾选某条任务（打卡）
export async function checkDailyTask({ date, taskId, done }) {
  return apiFetch('/daily-tasks/check', {
    method: 'POST',
    body: JSON.stringify({ date, taskId, done }),
  });
}

// 提交今日打卡（无论任务是否全部完成，提交即记为当天打卡成功）
// date 为前端当前查看日期（含测试/日期覆盖），不传则后端按 todayDateStr 兜底。
export async function submitCheckIn(date) {
  return apiFetch('/checkin', {
    method: 'POST',
    body: JSON.stringify(date ? { date } : {}),
  });
}

// 获取打卡统计：连续打卡天数 + 累计学习天数（学习开始日→今天，含两端）
export async function getCheckinStats() {
  return apiFetch('/checkin/stats', { method: 'GET' });
}

// ---------- 学习笔记 ----------
// 基于技能树 + RAG 公用库生成结构化学习笔记
export async function generateStudyNote({ topic, skill, category, level }) {
  return apiFetch('/study-notes/generate', {
    method: 'POST',
    body: JSON.stringify({ topic: topic || skill, skill, category, level }),
  });
}

// 保存学习笔记
export async function saveStudyNote({ title, content, skill, category, level, source }) {
  return apiFetch('/study-notes', {
    method: 'POST',
    body: JSON.stringify({ title, content, skill, category, level, source }),
  });
}

// 读取学习笔记列表或单条
export async function getStudyNotes(id) {
  const qs = new URLSearchParams();
  if (id) qs.set('id', String(id));
  return apiFetch('/study-notes?' + qs.toString(), { method: 'GET' });
}

// 删除学习笔记
export async function deleteStudyNote(id) {
  return apiFetch('/study-notes?id=' + encodeURIComponent(id), { method: 'DELETE' });
}

// 读取「我的学习笔记」（每日学习笔记，按月份/日期归档）
export async function getLearningNotes(id) {
  const qs = new URLSearchParams();
  if (id) qs.set('id', String(id));
  return apiFetch('/learning-notes?' + qs.toString(), { method: 'GET' });
}

// 删除「我的学习笔记」中的一条每日笔记
export async function deleteLearningNote(id) {
  return apiFetch('/learning-notes?id=' + encodeURIComponent(id), { method: 'DELETE' });
}

// 编辑/保存「我的学习笔记」中的一条每日笔记（覆盖当天最终笔记，需求十二）
export async function saveLearningNote(payload) {
  return apiFetch('/learning-notes', {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

// 测试模式：模拟 24 点结算（自动补全未提交打卡 + 自动生成当天笔记，需求十四）
export async function testSettle24() {
  return apiFetch('/test/settle-24', { method: 'POST', body: JSON.stringify({}) });
}

// 测试模式：模拟每日结算（分析当天完成 + 当前 stage 内重排，需求十五/十六）
export async function testDailySettle(fromDay) {
  return apiFetch('/test/daily-settle', {
    method: 'POST',
    body: JSON.stringify({ fromDay: fromDay || null }),
  });
}

