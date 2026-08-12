// 每日学习计划生成器（DailyPlanGenerator）
//
// 【硬约束】本模块完全由代码完成每日拆分，绝不调用任何 LLM。
//   - 不调用 LLM 分配天数 / 选择 PDF / 选择视频 / 生成章节。
//   - 所有资源必须来自已有真实阶段计划(stage plan)的 resources，禁止凭空生成资源。
//   - 禁止根据 skill 重新搜索 B站、禁止 skillResourceMatcher 参与、禁止重新 RAG 匹配 PDF。
//   - PDF 必须保留 docId 与 link；B站必须保留 url。
//
// 【定位】每日计划只是「资源排期系统」：
//   把总体学习计划里已经确定的 B站视频列表、PDF 列表，按 targetDays 均匀排进每一天，
//   保证「所有视频都被安排、所有 PDF 都被安排、不新增任何计划外资源」。
//
// 输入：
//   stagePlan  : 已生成好的总体学习计划，含 stages[].resources.{videos, pdf}
//   targetDays : 用户设定的目标学习天数（正整数）
//   dailyStudyTime : 用户每日可投入时长，支持 "2h" / "90m" / "1.5h" / 120(分钟)
//
// 输出：
//   { planId, targetDays, dailyMinutes, totalVideoUnits, totalPdfUnits, dailyTasks }

const SEC_PER_MIN = 60;
// 默认每日学习时长：4 小时（AI 产品经理系统学习陪跑定位，比 2h 更贴合「系统学习」强度）
const DEFAULT_DAILY_MINUTES = 240;

// 学习强度档位：轻量/标准/强化。仅作为 dailyStudyTime 的可读别名，不影响用户自定义数值。
// 优先级：用户显式数值（"2h"/240/"90m"）> 档位名（"标准"）> 默认标准(240)。
const STUDY_INTENSITY = {
  light: 120,    // 轻量：2h/天
  standard: 240, // 标准：4h/天（默认）
  intensive: 360,// 强化：6h/天
};
const INTENSITY_ALIAS = {
  轻量: 'light', 轻度: 'light', 轻松: 'light',
  标准: 'standard', 正常: 'standard', 默认: 'standard',
  强化: 'intensive', 高强度: 'intensive',  intensive: 'intensive',
};

// PDF 阅读速度基线：约 1.5 分钟/页（含理解与笔记）
const MINUTES_PER_PAGE = 1.5;
// 无页数信息时，单个 PDF 的默认估算工作量（分钟）
const DEFAULT_PDF_MINUTES = 45;
// 无章节页码时，单章节默认估算页数
const DEFAULT_PAGES_PER_CHAPTER = 12;

// ---------- 通用工具 ----------

// 秒 -> "X小时Y分" / "Y分"
export function formatDuration(sec) {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  if (h && m) return `${h}小时${m}分`;
  if (h) return `${h}小时`;
  if (m) return `${m}分`;
  return '0分';
}

// 秒 -> "mm:ss" 或 "h:mm:ss"
function clock(sec) {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// 解析用户每日学习时长："2h" / "1.5h" / "90m" / "90" / 120 -> 分钟数
export function parseDailyStudyTime(input, fallback = DEFAULT_DAILY_MINUTES) {
  if (input == null || input === '') return fallback;
  if (typeof input === 'number' && Number.isFinite(input)) {
    return input > 0 ? Math.round(input) : fallback;
  }
  const s = String(input).trim().toLowerCase();
  // 学习强度档位名（轻量/标准/强化 及其别名）：优先于数值解析，但不影响显式数值输入
  if (INTENSITY_ALIAS[s] || STUDY_INTENSITY[s] != null) {
    const key = INTENSITY_ALIAS[s] || s;
    return STUDY_INTENSITY[key];
  }
  // 「2小时30分」/「2h30m」这类组合
  const combo = s.match(/^(\d+(?:\.\d+)?)\s*(?:h|小时|hour|hours)\s*(\d+(?:\.\d+)?)\s*(?:m|min|分钟|分)?$/);
  if (combo) {
    const mins = Number(combo[1]) * 60 + Number(combo[2]);
    return mins > 0 ? Math.round(mins) : fallback;
  }
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(h|小时|hour|hours|m|min|mins|分钟|分)?$/);
  if (!m) return fallback;
  const val = Number(m[1]);
  if (!Number.isFinite(val) || val <= 0) return fallback;
  const unit = m[2] || '';
  if (/^(h|小时|hour|hours)$/.test(unit)) return Math.round(val * 60);
  if (/^(m|min|mins|分钟|分)$/.test(unit)) return Math.round(val);
  // 无单位：<= 12 视为小时，否则视为分钟
  return Math.round(val <= 12 ? val * 60 : val);
}

// 章节可能是字符串（RAG 聚合结果）或对象（带页码），统一取展示文本
function chapterLabel(ch) {
  if (ch == null) return '';
  if (typeof ch === 'string') return ch;
  if (typeof ch === 'object') return ch.title || ch.name || ch.chapter || '';
  return String(ch);
}

// 章节页码范围（若章节对象带 pageStart/pageEnd 则用真实页码，否则返回 null）
function chapterPages(ch) {
  if (!ch || typeof ch !== 'object') return null;
  const start = Number(ch.pageStart ?? ch.page_start ?? ch.start);
  const end = Number(ch.pageEnd ?? ch.page_end ?? ch.end);
  if (Number.isFinite(start) && Number.isFinite(end) && end >= start) return { start, end };
  if (Number.isFinite(start)) return { start, end: start };
  return null;
}

// ---------- 视频切片 ----------
// 优先级：B站分P > 时间切割
//
// videos 形状：{ id, title, url, link, durationSec, parts?: [{page, cid, part, durationSec}] }
// 返回「原子学习单元」数组，每个单元含真实 url，估算分钟数。
// 注意：不重新搜索 B站，parts 直接来自总体计划的已有数据。
function buildVideoUnits(videos) {
  const units = [];
  for (const v of videos || []) {
    const url = v.url || v.link || '';
    const base = {
      kind: 'video',
      id: v.id,
      title: v.title || '',
      url,
      link: url,
      platform: v.platform || '',
    };
    const parts = Array.isArray(v.parts) && v.parts.length ? v.parts : null;
    const totalSec = Number(v.durationSec) || 0;

    if (parts) {
      // 有分P：每个分P即一个原子单元；但若单个P过长（超过阈值），
      // 则在该P内再按时间切成多段，实现「一个P拆多天学」（携带 page + 相对 startSec/endSec）。
      const SEG = 25 * SEC_PER_MIN;       // 每段目标时长
      const SPLIT_THRESHOLD = 40 * SEC_PER_MIN; // 单P超过此值才切（避免小幅波动）
      for (const p of parts) {
        const sec = Number(p.durationSec) || 0;
        const page = Number(p.page) || 0;
        if (sec > SPLIT_THRESHOLD) {
          const n = Math.max(2, Math.ceil(sec / SEG));
          const seg = Math.ceil(sec / n);
          for (let i = 0; i < n; i++) {
            const start = i * seg;
            const end = Math.min(sec, (i + 1) * seg);
            units.push({
              ...base,
              page,
              partTitle: p.part || '',
              startSec: start,   // 该P内相对偏移（与字幕 from/to 对齐）
              endSec: end,
              durationSec: end - start,
              minutes: Math.max(1, Math.round((end - start) / SEC_PER_MIN)),
            });
          }
        } else {
          units.push({
            ...base,
            page,
            partTitle: p.part || '',
            durationSec: sec,
            minutes: Math.max(1, Math.round(sec / SEC_PER_MIN)) || 1,
          });
        }
      }
    } else if (totalSec > 0) {
      // 无分P：按时间切割成 ~25 分钟的片段，便于按天分配
      const SEG = 25 * SEC_PER_MIN;
      const n = Math.max(1, Math.ceil(totalSec / SEG));
      const seg = Math.ceil(totalSec / n);
      for (let i = 0; i < n; i++) {
        const start = i * seg;
        const end = Math.min(totalSec, (i + 1) * seg);
        units.push({
          ...base,
          startSec: start,
          endSec: end,
          durationSec: end - start,
          minutes: Math.max(1, Math.round((end - start) / SEC_PER_MIN)),
        });
      }
    } else {
      // 既无分P也无时长：整段 1 个单元
      units.push({ ...base, durationSec: 0, minutes: 30 });
    }
  }
  return units;
}

// 把同一天内、同一视频的连续分P/片段合并成一条展示记录
function mergeVideoUnits(units) {
  const out = [];
  for (const u of units) {
    const prev = out[out.length - 1];
    const sameVideo = prev && prev._id === u.id && prev.url === u.url;
    if (sameVideo && u.page && prev._lastPage && u.page === prev._lastPage + 1) {
      // 连续分P合并：P1 + P2 -> "P1-P2"
      prev._lastPage = u.page;
      prev._sec += u.durationSec;
      prev.part = prev._firstPage === prev._lastPage ? `P${prev._firstPage}` : `P${prev._firstPage}-P${prev._lastPage}`;
      prev.duration = formatDuration(prev._sec);
      prev.durationSec = prev._sec;
      continue;
    }
    if (sameVideo && u.startSec != null && prev._lastEnd != null && u.startSec === prev._lastEnd) {
      // 连续时间片合并
      prev._lastEnd = u.endSec;
      prev._sec += u.durationSec;
      prev.part = `${clock(prev._firstStart)}-${clock(prev._lastEnd)}`;
      prev.duration = formatDuration(prev._sec);
      prev.durationSec = prev._sec;
      // 同一P内子段：链接带 p= 与起始 t=，供前端跳转与字幕定位
      if (prev.page) prev.link = appendQuery(appendQuery(u.url, `p=${prev.page}`), `t=${prev._firstStart}`);
      continue;
    }
    const rec = {
      title: u.title,
      url: u.url,               // 必须保留真实 B站链接
      link: u.url,
      part: '',
      duration: formatDuration(u.durationSec),
      durationSec: u.durationSec,
      _id: u.id,
      _sec: u.durationSec,
    };
    if (u.page) {
      rec.part = `P${u.page}`;
      rec.partTitle = u.partTitle || '';
      rec._firstPage = u.page;
      rec._lastPage = u.page;
      rec.page = u.page;
      // 分P直达链接
      rec.link = appendQuery(u.url, `p=${u.page}`);
    } else if (u.startSec != null) {
      rec.part = `${clock(u.startSec)}-${clock(u.endSec)}`;
      rec._firstStart = u.startSec;
      rec._lastEnd = u.endSec;
      if (u.page) rec.page = u.page; // 单P内切：携带 P 号供笔记侧定位分P字幕
      rec.link = u.startSec > 0 ? appendQuery(u.url, `t=${u.startSec}`) : u.url;
    } else {
      rec.part = '全片';
    }
    out.push(rec);
  }
  // 清理内部字段
  return out.map(({ _id, _sec, _firstPage, _lastPage, _firstStart, _lastEnd, ...rest }) => rest);
}

function appendQuery(url, qs) {
  if (!url) return '';
  return url.includes('?') ? `${url}&${qs}` : `${url}?${qs}`;
}

// ---------- PDF 切片 ----------
// 优先级：章节 > 页码 > chunk
//
// pdf 形状：{ id, title, docId, link, file, chapters?: string[] | object[], totalPages?, chunkCount? }
// 注意：不重新 RAG 匹配，chapters / chunkCount 直接来自总体计划的已有数据。
function buildPdfUnits(pdfs) {
  const units = [];
  for (const p of pdfs || []) {
    const base = {
      kind: 'pdf',
      id: p.id,
      title: p.title || '',
      docId: p.docId || '',      // 必须保留真实 docId
      link: p.link || '',        // 必须保留真实 link
      file: p.file || '',
    };
    const chapters = Array.isArray(p.chapters) && p.chapters.length ? p.chapters : null;
    const totalPages = Number(p.totalPages) || 0;

    if (chapters) {
      // 有章节：一章一个原子单元
      for (const c of chapters) {
        const label = chapterLabel(c);
        if (!label) continue;
        const pg = chapterPages(c);
        const pages = pg ? `${pg.start}-${pg.end}` : '';
        const pageCount = pg ? pg.end - pg.start + 1 : DEFAULT_PAGES_PER_CHAPTER;
        units.push({
          ...base,
          chapter: label,
          pages,
          pageCount,
          minutes: Math.max(5, Math.round(pageCount * MINUTES_PER_PAGE)),
        });
      }
    } else if (totalPages > 0 || Number(p._pageTo) > 0) {
      // 无章节但有页数：按 20 页一段切
      const from = Number(p._pageFrom) || 1;
      const to = Number(p._pageTo) || totalPages;
      const span = Math.max(1, to - from + 1);
      const SEG = 20;
      const n = Math.max(1, Math.ceil(span / SEG));
      const seg = Math.ceil(span / n);
      for (let i = 0; i < n; i++) {
        const start = from + i * seg;
        const end = Math.min(to, from + (i + 1) * seg - 1);
        units.push({
          ...base,
          chapter: '',
          pages: `${start}-${end}`,
          pageCount: end - start + 1,
          minutes: Math.max(5, Math.round((end - start + 1) * MINUTES_PER_PAGE)),
        });
      }
    } else if (Number(p.chunkCount) > 0) {
      // 既无章节也无页数，但有真实分块数：按分块把全书切成「第 N/M 部分」
      const chunks = Number(p.chunkCount);
      const CHUNKS_PER_SEG = 8;              // 约 8 个分块作为一次阅读量
      const n = Math.max(1, Math.min(Math.ceil(chunks / CHUNKS_PER_SEG), 12));
      const per = chunks / n;
      for (let i = 0; i < n; i++) {
        const from = Math.floor(i * per) + 1;
        const to = i === n - 1 ? chunks : Math.floor((i + 1) * per);
        units.push({
          ...base,
          chapter: n > 1 ? `第${i + 1}/${n}部分` : '',
          pages: '',
          segment: { index: i + 1, total: n, chunkFrom: from, chunkTo: to },
          pageCount: 0,
          minutes: Math.max(10, Math.round((to - from + 1) * 3)), // 每个分块约 3 分钟
        });
      }
    } else {
      // 完全没有结构信息：整本作为一个单元（前端按「整本学习」展示）
      units.push({ ...base, chapter: '', pages: '', pageCount: 0, minutes: DEFAULT_PDF_MINUTES });
    }
  }
  return units;
}

function mergePdfUnits(units) {
  const out = [];
  for (const u of units) {
    const prev = out[out.length - 1];
    if (prev && prev.docId === u.docId && prev.docId) {
      // 同一本 PDF 同一天：合并章节与页码展示
      if (u.chapter) prev._chapters.push(u.chapter);
      if (u.pages) prev._pages.push(u.pages);
      prev.chapter = prev._chapters.join('、');
      prev.chapters = [...prev._chapters];
      prev.pages = prev._pages.join(',');
      continue;
    }
    out.push({
      title: u.title,
      docId: u.docId,     // 保留
      link: u.link,       // 保留
      file: u.file,
      chapter: u.chapter || '',
      chapters: u.chapter ? [u.chapter] : [],
      pages: u.pages || '',
      ...(u.segment ? { segment: u.segment } : {}),
      _chapters: u.chapter ? [u.chapter] : [],
      _pages: u.pages ? [u.pages] : [],
    });
  }
  return out.map(({ _chapters, _pages, ...rest }) => rest);
}

// ---------- 全局去重 ----------
// 一个具体的学习单元（某视频的某P / 某PDF的某章节）在整个计划中只出现一次，
// 避免同一份资源在不同阶段重复出现导致重复学习。
function videoUnitKey(u) {
  return `${u.url}|${u.page || ''}|${u.startSec ?? ''}`;
}
function pdfUnitKey(u) {
  return `${u.docId || u.title}|${u.chapter || ''}|${u.pages || ''}`;
}

// ---------- 资源排期（核心）----------
// 把 n 个原子单元「均匀锁步」铺进 dayCount 天：
//   day = floor(k * dayCount / n)
// 保证全部资源都被安排、且均匀散布在每一天（首末天都含资源，同时开始/结束），
// 不裁剪、不丢弃：targetDays 由用户决定，所有资源 100% 排进计划。
function spreadAcrossDays(units, dayCount) {
  const n = units.length;
  const buckets = Array.from({ length: dayCount }, () => []);
  if (!n || !dayCount) return buckets;
  for (let k = 0; k < n; k++) {
    const day = Math.floor((k * dayCount) / n);
    buckets[day].push(units[k]);
  }
  return buckets;
}

// ---------- 主入口 ----------

export function generateDailyPlan({ stagePlan, targetDays, dailyStudyTime } = {}) {
  if (!stagePlan || !Array.isArray(stagePlan.stages) || !stagePlan.stages.length) {
    const err = new Error('缺少有效的阶段计划(stagePlan.stages)');
    err.code = 'INVALID_STAGE_PLAN';
    throw err;
  }
  const days = Math.floor(Number(targetDays));
  if (!Number.isFinite(days) || days < 1) {
    const err = new Error('targetDays 必须为正整数');
    err.code = 'INVALID_TARGET_DAYS';
    throw err;
  }
  const dailyMinutes = parseDailyStudyTime(dailyStudyTime);

  // ===== 第一步：按 stage 顺序收集资源，并统计每个 stage 的学习量 =====
  // 学习量 = 视频总分钟数 + PDF 阅读量（页数 × 阅读速度）
  // 同一 stage 内的视频与 PDF 视为一个整体学习单元，不跨 stage 混合。
  const stageData = [];
  let totalLoad = 0;
  for (const stage of stagePlan.stages) {
    const stageName = stage.stage || stage.title || '';
    const res = (stage.resources && typeof stage.resources === 'object') ? stage.resources : {};
    const videos = Array.isArray(res.videos) ? res.videos : [];
    const pdfs = Array.isArray(res.pdf) ? res.pdf : [];

    // 本 stage 内部去重，避免同资源重复（跨 stage 不去重，资源归属各自 stage）
    const seenV = new Set();
    const seenP = new Set();
    const videoPool = [];
    const pdfPool = [];
    for (const u of buildVideoUnits(videos)) {
      const k = videoUnitKey(u);
      if (seenV.has(k)) continue;
      seenV.add(k);
      videoPool.push(u);
    }
    for (const u of buildPdfUnits(pdfs)) {
      const k = pdfUnitKey(u);
      if (seenP.has(k)) continue;
      seenP.add(k);
      pdfPool.push(u);
    }

    if (!videoPool.length && !pdfPool.length) continue; // 跳过空 stage

    const videoMin = videoPool.reduce((s, u) => s + (u.minutes || 0), 0);
    const pdfMin = pdfPool.reduce((s, u) => s + (u.minutes || 0), 0);
    // 学习量权重取 video 与 pdf 的较大者：保证两类资源都能在该 stage 的天数内铺满，
    // 从而每天同时含 video+pdf（同时开始、同时结束），不会出现某一类早早学完、另一类拖尾。
    const load = Math.max(videoMin, pdfMin === 0 ? videoMin : pdfMin, videoMin === 0 ? pdfMin : videoMin, 1);
    // 携带该 stage 关联的技能名（来自 loadStagePlanForDaily 已注入的 stage.skills），
    // 用于落库 daily_learning_tasks.skill_name，使每日任务可追溯到具体技能。
    const stageSkills = Array.isArray(stage.skills) ? stage.skills.filter(Boolean) : [];
    stageData.push({ stageName, videoPool, pdfPool, videoMin, pdfMin, load, skills: stageSkills });
    totalLoad += load;
  }

  if (!stageData.length) {
    const err = new Error('阶段计划中没有可用的视频或 PDF 资源');
    err.code = 'EMPTY_RESOURCES';
    throw err;
  }

  // ===== 第二步：按学习量比例分配每个 stage 的天数（整数，总和 = targetDays）=====
  // 至少 1 天；用「按占比多者优先补足」的整数分配法，避免浮点误差导致天数错位。
  const totalDays = days;
  const raw = stageData.map((s) => ({ ...s, rawDays: totalLoad > 0 ? (s.load / totalLoad) * totalDays : totalDays / stageData.length }));
  const alloc = raw.map(() => 1); // 每 stage 至少 1 天
  let used = stageData.length;
  // 剩余天数按 rawDays - 1 的余数（即小数部分）从大到小补足
  const remainders = raw
    .map((s, i) => ({ i, rem: s.rawDays - 1 }))
    .sort((a, b) => b.rem - a.rem);
  let idx = 0;
  while (used < totalDays) {
    const target = remainders[idx % remainders.length].i;
    alloc[target] += 1;
    used += 1;
    idx += 1;
  }

  // ===== 第三步：每个 stage 内，video 与 pdf 同进度铺到该 stage 天数（锁步）=====
  // 不裁剪、不丢弃：所有资源 100% 排进计划。
  // video 与 pdf 各自均匀 spread 到同一天桶，进度比例接近 => 同时开始、尽量同时结束。
  const dailyTasks = [];
  let globalDay = 0;
  // 全局去重：同一视频分P（url+page）或 PDF 章节（docId+chapter+pages）在整个计划里只排一次，
  // 避免同一资源被多个 stage / 末日对齐挪动时重复出现（导致「勾完一个又冒出相同任务」）。
  const globalSeen = new Set();
  const unitKey = (u) => (u.url || u.link || '') + '|' + (u.page ?? u.startSec ?? '') + '|' + (u.docId || u.title || '');
  stageData.forEach((s, si) => {
    const d_i = alloc[si];
    const vBuckets = spreadAcrossDays(s.videoPool, d_i);
    const pBuckets = spreadAcrossDays(s.pdfPool, d_i);
    // 末日对齐：保证该 stage 最后一天同时含 video 与 pdf（同时结束）。
    // 若末日缺某一类，从最后一个非空天挪一个单元到末日（不新增、不丢弃资源）。
    const alignLastDay = (buckets) => {
      const last = buckets[d_i - 1];
      if (last && last.length) return; // 末日已有内容
      for (let d = d_i - 2; d >= 0; d--) {
        if (buckets[d] && buckets[d].length) {
          buckets[d_i - 1].push(buckets[d].pop());
          break;
        }
      }
    };
    alignLastDay(vBuckets);
    alignLastDay(pBuckets);
    for (let d = 0; d < d_i; d++) {
      globalDay += 1;
      // 过滤全局已排过的重复单元（同一资源只保留首次出现那天）
      const vUnits = (vBuckets[d] || []).filter((u) => {
        const k = unitKey(u);
        if (globalSeen.has(k)) return false;
        globalSeen.add(k);
        return true;
      });
      const pUnits = (pBuckets[d] || []).filter((u) => {
        const k = unitKey(u);
        if (globalSeen.has(k)) return false;
        globalSeen.add(k);
        return true;
      });
      const video = mergeVideoUnits(vUnits);
      const pdf = mergePdfUnits(pUnits);

      const vMin = vUnits.reduce((s2, u) => s2 + (u.minutes || 0), 0);
      const pMin = pUnits.reduce((s2, u) => s2 + (u.minutes || 0), 0);
      const estMin = vMin + pMin;
      const hasContent = video.length || pdf.length;

      // focus：当天学习主题（取该 stage 首个视频/PDF 标题，纯展示，不新增内容）
      let focus = '';
      if (video.length) focus = `观看视频：${video[0].title}${video[0].part ? ' ' + video[0].part : ''}`;
      else if (pdf.length) focus = `阅读 ${pdf[0].title}${pdf[0].chapter ? '（' + pdf[0].chapter + '）' : ''}`;

      // 该 stage 关联的首个技能（字符串，来自 loadStagePlanForDaily 注入的 stage.skills）；
      // 仅用于 skill_name 回溯，不驱动资源分配，保持纯代码拆分约束。
      const stageSkillName = (s.skills && s.skills[0]) || '';
      dailyTasks.push({
        day: globalDay,
        stage: s.stageName,
        skill: { skill_id: '', standard_name: stageSkillName, category: '', level: '' },
        focus,
        resources: { video, pdf },
        estimatedTime: formatDuration(Math.max(estMin, hasContent ? 20 : Math.round(dailyMinutes * 0.5)) * SEC_PER_MIN),
        estimatedMinutes: hasContent ? Math.max(estMin, 20) : Math.round(dailyMinutes * 0.5),
        ...(hasContent ? {} : { isReview: true }),
        status: 'pending',
      });
    }
  });

  // 兜底：极端情况下没有任何资源被排入（理论上不会发生），至少产出 targetDays 条空复习任务
  if (!dailyTasks.length) {
    for (let d = 0; d < days; d++) {
      dailyTasks.push({
        day: d + 1,
        stage: stagePlan.stages[0]?.stage || stagePlan.stages[0]?.title || '',
        skill: { skill_id: '', standard_name: '', category: '', level: '' },
        focus: '复习巩固：回顾已学资料，整理笔记',
        resources: { video: [], pdf: [] },
        estimatedTime: formatDuration(Math.round(dailyMinutes * 0.5) * SEC_PER_MIN),
        estimatedMinutes: Math.round(dailyMinutes * 0.5),
        isReview: true,
        status: 'pending',
      });
    }
  }

  return {
    planId: stagePlan.planId || '',
    targetDays: days,
    dailyMinutes,
    // 全部资源都已涵盖，不再有任何裁剪
    contentTrimmed: false,
    totalVideoUnits: stageData.reduce((s, x) => s + x.videoPool.length, 0),
    totalPdfUnits: stageData.reduce((s, x) => s + x.pdfPool.length, 0),
    stageDayAllocation: stageData.map((s, i) => ({ stage: s.stageName, days: alloc[i], load: Math.round(s.load) })),
    dailyTasks,
  };
}

export default { generateDailyPlan, formatDuration, parseDailyStudyTime };
