// dailyPlanAdjuster.mjs
//
// 动态学习计划调整系统（纯代码规则，默认不调用任何 LLM / 不搜索 B站 / 不重新匹配 RAG）。
//
// 设计原则（与总体学习路线解耦）：
//   · 不改变 stage 顺序、skill 依赖、学习资源（video/pdf 只能复用 daily_learning_tasks 里已有的）
//   · 不重新生成学习路线、不新增计划外内容
//   · 只调整执行层 daily_learning_tasks（original_day / adjusted_day / status / reschedule_count / adjust_reason）
//
// 提供三个能力：
//   1) adjustPlan                —— 打卡后检测：前序日有未完成 → 优先补做（保持 stage 连续性）
//   2) rescheduleByTargetDate    —— 用户修改目标日：把「当前日之后未完成任务」重新分配到新目标日
//   3) computeRisk               —— 风险探测：剩余任务量 / 剩余天数 → 每日负荷是否超过承受能力

// —— 与系统内 expandDayRow 一致的展开逻辑（子任务：type='video'|'pdf'，status 由 done 决定） ——
function expandDayRow(row) {
  let videos = [];
  let pdfs = [];
  try { videos = JSON.parse(row.video_info || '[]'); } catch { videos = []; }
  try { pdfs = JSON.parse(row.pdf_info || '[]'); } catch { pdfs = []; }
  if (!Array.isArray(videos)) videos = [];
  if (!Array.isArray(pdfs)) pdfs = [];
  const tasks = [];
  // 行 id 可能缺失（重排纯函数重建的行不带 id），回退到 day_number 保证任务 id 始终可定位。
  const rowKey = row.id != null ? row.id : row.day_number;
  videos.forEach((v, i) => tasks.push({
    id: `${rowKey}__video__${i}`,
    title: v.title || (v.url ? `视频 ${v.url}` : `视频 ${i + 1}`),
    type: 'video',
    status: v.done ? 'completed' : 'pending',
    resource: v,
  }));
  pdfs.forEach((p, i) => tasks.push({
    id: `${rowKey}__pdf__${i}`,
    title: p.title || (p.docId ? `PDF ${p.docId}` : `PDF ${i + 1}`),
    type: 'pdf',
    status: p.done ? 'completed' : 'pending',
    resource: p,
  }));
  return tasks;
}

function resourceKeyOf(kind, res) {
  if (kind === 'video') return `video:${res.url || ''}:${res.part || ''}`;
  return `pdf:${res.docId || ''}:${res.section || res.range || res.chapter || ''}`;
}

const collectIncomplete = (r) => expandDayRow(r).filter((t) => t.status !== 'completed');
const collectComplete = (r) => expandDayRow(r).filter((t) => t.status === 'completed');

// 解析一行任务的估计分钟：prefer 已知 estimated_minutes 列，否则解析 estimated_time 文本
function estimateMinutesForRow(row) {
  if (row.estimated_minutes && Number(row.estimated_minutes) > 0) return Number(row.estimated_minutes);
  const s = String(row.estimated_time || '');
  const h = s.match(/([\d.]+)\s*h/); if (h) return Math.round(parseFloat(h[1]) * 60);
  const m = s.match(/([\d.]+)\s*m/); if (m) return Math.round(parseFloat(m[1]));
  const n = s.match(/^([\d.]+)$/); if (n) return Math.round(parseFloat(n[1]));
  return 0;
}

// 把子资源重新打包为一个 day 行（保持 video 与 pdf 同 stage）
function buildDayRow({ day_number, stage, subs, status, originalDay, adjustedDay, estimatedMinutes, reason }) {
  const video_info = [];
  const pdf_info = [];
  for (const s of subs) {
    if (s.type === 'video') video_info.push(s.resource);
    else pdf_info.push(s.resource);
  }
  return {
    day_number,
    stage,
    skill_id: '',
    skill_name: stage,
    skill_category: '',
    skill_level: '',
    focus: '',
    video_info: JSON.stringify(video_info),
    pdf_info: JSON.stringify(pdf_info),
    estimated_time: estimatedMinutes ? `${Math.round(estimatedMinutes)}min` : '2h',
    status,
    original_day: originalDay,
    adjusted_day: adjustedDay,
    estimated_minutes: estimatedMinutes || estimateMinutesForRow({ estimated_time: '2h' }),
    adjust_reason: reason || null,
    adjust_reason_type: 'missed_task',
    adjust_reason_detail: reason || null,
    _changed: true,
  };
}

// 计算两个日期之间的整天数（含首尾不算，返回 剩余可排天数）
function daysBetween(startDate, endDate) {
  const s = new Date(startDate); s.setHours(0, 0, 0, 0);
  const e = new Date(endDate); e.setHours(0, 0, 0, 0);
  const diff = Math.round((e - s) / 86400000);
  return diff; // >=0 表示 target 在 start 之后；负数表示已过期
}

// ============ 能力1：打卡后检测补做 ============
export function adjustPlan({ tasks, today }) {
  const formal = (tasks || [])
    .filter((t) => (t.day_number ?? 0) >= 1)
    .sort((a, b) => (a.day_number ?? 0) - (b.day_number ?? 0));

  if (formal.length === 0) {
    return { changed: false, reason: '无正式任务', adjustments: [], days: formal };
  }

  const todayRow = formal.find((r) => r.task_date === today)
    || formal.find((r) => !expandDayRow(r).every((t) => t.status === 'completed'))
    || formal[0];
  const todayDay = todayRow.day_number;

  const prior = formal.filter((r) => (r.day_number ?? 0) < todayDay);
  const sourceRow = [...prior].reverse().find((r) => {
    const subs = expandDayRow(r);
    return subs.length && !subs.every((t) => t.status === 'completed');
  });

  if (!sourceRow) {
    return { changed: false, reason: '前序任务已全部完成，保持原计划', adjustments: [], days: formal };
  }

  const incomplete = collectIncomplete(sourceRow);
  if (incomplete.length === 0) {
    return { changed: false, reason: '前序任务已全部完成，保持原计划', adjustments: [], days: formal };
  }

  const sourceStage = sourceRow.stage;
  const todayStage = todayRow.stage;

  const adjustments = incomplete.map((s) => ({
    originalDay: sourceRow.day_number,
    adjustedDay: todayDay,
    stage: sourceStage,
    type: s.type,
    title: s.title,
    reason: '前序日未完成，顺延补做',
  }));

  const resultDays = formal.map((r) => ({ ...r }));

  const stripIncomplete = (row, subs) => {
    const keys = subs.map((s) => resourceKeyOf(s.type, s.resource));
    let vids = []; let pdfs = [];
    try { vids = JSON.parse(row.video_info || '[]'); } catch { vids = []; }
    try { pdfs = JSON.parse(row.pdf_info || '[]'); } catch { pdfs = []; }
    return {
      vOut: vids.filter((v) => !keys.includes(resourceKeyOf('video', v))),
      pOut: pdfs.filter((p) => !keys.includes(resourceKeyOf('pdf', p))),
    };
  };

  const srcIdx = resultDays.findIndex((r) => r.day_number === sourceRow.day_number);
  const reason = `昨日（Day${sourceRow.day_number}）有 ${incomplete.length} 项未完成，已优先安排到今日补做`;

  if (todayStage === sourceStage) {
    const todayIdx = resultDays.findIndex((r) => r.day_number === todayDay);
    const tRow = resultDays[todayIdx];
    let tVid = []; let tPdf = [];
    try { tVid = JSON.parse(tRow.video_info || '[]'); } catch { tVid = []; }
    try { tPdf = JSON.parse(tRow.pdf_info || '[]'); } catch { tPdf = []; }
    for (const s of incomplete) {
      if (s.type === 'video') tVid.push(s.resource);
      else tPdf.push(s.resource);
    }
    tRow.video_info = JSON.stringify(tVid);
    tRow.pdf_info = JSON.stringify(tPdf);
    tRow.adjusted_day = todayDay;
    tRow.adjust_reason = reason;
    tRow.estimated_minutes = estimateMinutesForRow(tRow);
    tRow._changed = true;

    const { vOut, pOut } = stripIncomplete(sourceRow, incomplete);
    if (vOut.length === 0 && pOut.length === 0) {
      resultDays[srcIdx].video_info = '[]';
      resultDays[srcIdx].pdf_info = '[]';
      resultDays[srcIdx].status = 'completed';
    } else {
      resultDays[srcIdx].video_info = JSON.stringify(vOut);
      resultDays[srcIdx].pdf_info = JSON.stringify(pOut);
    }
    resultDays[srcIdx].adjust_reason = reason;
    resultDays[srcIdx]._changed = true;
  } else {
    const maxDay = Math.max(...resultDays.map((r) => r.day_number));
    const shiftTarget = maxDay + 1;
    const todayIdx = resultDays.findIndex((r) => r.day_number === todayDay);
    const shifted = { ...resultDays[todayIdx] };
    shifted.day_number = shiftTarget;
    shifted.original_day = resultDays[todayIdx].original_day ?? resultDays[todayIdx].day_number;
    shifted.adjusted_day = shiftTarget;
    shifted._changed = true;

    resultDays[todayIdx] = buildDayRow({
      day_number: todayDay,
      stage: sourceStage,
      subs: incomplete,
      status: 'rescheduled',
      originalDay: sourceRow.day_number,
      adjustedDay: todayDay,
      reason,
    });
    resultDays.push(shifted);

    const { vOut, pOut } = stripIncomplete(sourceRow, incomplete);
    if (vOut.length === 0 && pOut.length === 0) {
      resultDays[srcIdx].video_info = '[]';
      resultDays[srcIdx].pdf_info = '[]';
      resultDays[srcIdx].status = 'completed';
    } else {
      resultDays[srcIdx].video_info = JSON.stringify(vOut);
      resultDays[srcIdx].pdf_info = JSON.stringify(pOut);
    }
    resultDays[srcIdx].adjust_reason = reason;
    resultDays[srcIdx]._changed = true;
  }

  return { changed: true, reason, adjustments, days: resultDays };
}

// ============ 能力2：按目标日重新规划剩余任务 ============
// 规则：
//   · 已完成子资源（done=true）及其原始日保持不变
//   · 未完成任务 = 当日未完成（today 及之前未完成）+ 未来全部任务
//   · 所有未完成任务按 行顺序（=stage顺序=章节顺序）平铺，受 dailyCapacityMinutes 约束分桶到 [today, targetDate]
//   · 同一 day 的 video/pdf 必须同 stage；不跳 stage（前 stage 未完成不完结不进下一 stage）
//   · 不新增任何资源来源
export function rescheduleByTargetDate({ tasks, targetDate, dailyCapacityMinutes = 120, today, startDate, strategy = 'keep_daily_load' }) {
  const formal = (tasks || [])
    .filter((t) => (t.day_number ?? 0) >= 1)
    .sort((a, b) => (a.day_number ?? 0) - (b.day_number ?? 0));
  if (formal.length === 0) {
    return { changed: false, reason: '无正式任务', adjustments: [], days: formal };
  }

  const tDay = today || new Date().toISOString().slice(0, 10);
  const remDays = daysBetween(tDay, targetDate); // 含 today 当天到 targetDate 的剩余可排天数
  if (remDays < 1) {
    return { changed: false, reason: '目标日期已过或无效，无法重新规划', adjustments: [], days: formal };
  }

  // 1) 已完成子资源（done=true）保持原位，其余收集为「待重排」
  const kept = [];
  const pending = []; // { type, resource, stage, origDay, est }
  const estOf = (item, rowMinutes) => {
    const s = String(item.resource?.estimated_time || item.resource?.duration || '');
    const h = s.match(/([\d.]+)\s*h/); if (h) return Math.round(parseFloat(h[1]) * 60);
    const m = s.match(/([\d.]+)\s*m/); if (m) return Math.round(parseFloat(m[1]));
    // 子资源未标注时长时，回退到整行的 estimated_minutes（文档四：每天不能超过 daily_capacity）
    return (rowMinutes && Number(rowMinutes) > 0) ? Number(rowMinutes) : 30;
  };
  for (const r of formal) {
    if (r._protectSkip) {
      // Stage 阶段保护（文档三）：被标记的「下一 stage 未完成任务」不进入重排；若含已完成子资源则保留原位
      const subs = expandDayRow(r);
      const doneSubs = subs.filter((t) => t.status === 'completed');
      if (doneSubs.length > 0) kept.push({ row: r, doneSubs });
      continue;
    }
    const subs = expandDayRow(r);
    const doneSubs = subs.filter((t) => t.status === 'completed');
    const todoSubs = subs.filter((t) => t.status !== 'completed');
    if (doneSubs.length > 0) {
      kept.push({ row: r, doneSubs });
    }
    for (const s of todoSubs) {
      const item = { type: s.type, resource: s.resource, stage: r.stage, origDay: r.day_number };
      item.est = estOf(item, r.estimated_minutes);
      pending.push(item);
    }
  }

  // 2) 按 stage 顺序 + 原始 day 顺序（=章节顺序）平铺待排任务（文档四：加入 stage 优先级）
  pending.sort((a, b) => {
    if (a.stage !== b.stage) return a.stage < b.stage ? -1 : 1;
    return (a.origDay ?? 0) - (b.origDay ?? 0);
  });

  // 3) 分桶策略
  //   keep_daily_load：保持每日容量上限，桶数 / 日期自然顺延（超过容量才顺延）
  //   keep_target_date：保持目标日期不变，把待排任务强制塞进 remDays 个桶（单桶可超容量，仅提示）
  const buckets = []; // 每个桶：{ dayOffset, stage, subs:[], min }
  const bucketCount = strategy === 'keep_target_date'
    ? Math.max(remDays, 1)
    : null; // null = 自动按容量分桶

  let cur = null;
  let curMin = 0;
  for (const item of pending) {
    const em = item.est;
    let forceNew = !cur || cur.stage !== item.stage;
    if (strategy === 'keep_daily_load') {
      // 容量约束：换桶条件 = 换 stage 或超容量（空桶也放，不拒绝单任务）
      forceNew = forceNew || curMin + em > dailyCapacityMinutes;
    } else {
      // keep_target_date：保持 stage 连续性即可，容量不强制（顺延到下一桶仅当当前桶满且不为空）
      const idxInStrategy = cur ? cur.dayOffset : -1;
      const bucketFull = bucketCount != null && idxInStrategy + 1 >= bucketCount && cur.subs.length > 0;
      // 不主动换桶，除非换 stage 或容量严重超限（仍允许超，仅防止无限塞）
      forceNew = forceNew || (curMin + em > dailyCapacityMinutes * 3 && cur.subs.length > 0);
      void bucketFull;
    }
    if (forceNew) {
      cur = { dayOffset: buckets.length, stage: item.stage, subs: [], min: 0 };
      curMin = 0;
      buckets.push(cur);
    }
    cur.subs.push(item);
    curMin += em;
    if (cur) cur.min = curMin;
  }

  // keep_target_date：若桶数仍超过目标天数，把后续桶的任务回填到前面的桶（优先填满前 remDays 桶）
  if (strategy === 'keep_target_date' && bucketCount != null && buckets.length > bucketCount) {
    const overflow = buckets.splice(bucketCount); // 超出部分的桶
    for (const ob of overflow) {
      for (const s of ob.subs) {
        // 找到同 stage 的最靠后桶塞入；否则追加到最后一个桶
        let target = buckets[buckets.length - 1];
        const sameStage = buckets.filter((b) => b.stage === s.stage).pop();
        if (sameStage) target = sameStage;
        target.subs.push(s);
        target.min += s.est;
      }
    }
  }

  // 4) 组装最终 days：已完成行保留（按原 day_number），重新排的桶从 today 起逐日填充
  const resultDays = [];
  const adjustments = [];
  for (const k of kept) {
    resultDays.push({ ...k.row, _changed: false });
  }
  // 计算 today 对应的 day_number（用 startDate 推导，缺省取 todayRow.day_number）
  let todayDayNumber = formal.find((r) => r.task_date === tDay)?.day_number
    || formal.find((r) => (r.day_number ?? 0) >= 1)?.day_number || 1;
  const reasonPrefix = strategy === 'keep_target_date'
    ? `保持目标日期（${targetDate}）不变，增加每日任务量`
    : `根据新的目标日期（${targetDate}）重新规划剩余任务`;
  buckets.forEach((b, idx) => {
    const dayNumber = todayDayNumber + idx;
    const reason = idx === 0 ? reasonPrefix : `${reasonPrefix}（顺延）`;
    resultDays.push(buildDayRow({
      day_number: dayNumber,
      stage: b.stage,
      subs: b.subs.map((s) => ({ type: s.type, resource: s.resource })),
      status: 'rescheduled',
      originalDay: null,
      adjustedDay: dayNumber,
      estimatedMinutes: b.min,
      reason,
    }));
    for (const s of b.subs) {
      adjustments.push({
        originalDay: s.origDay,
        adjustedDay: dayNumber,
        stage: b.stage,
        type: s.type,
        title: s.resource.title || (s.type === 'video' ? '视频' : 'PDF'),
        reason,
      });
    }
  });

  resultDays.sort((a, b) => (a.day_number ?? 0) - (b.day_number ?? 0));
  return {
    changed: adjustments.length > 0,
    reason: adjustments.length ? `${reasonPrefix}，共重排 ${adjustments.length} 项剩余任务` : '无需调整',
    strategy,
    adjustments,
    days: resultDays,
  };
}

// ============ 能力3：风险探测 ============
// 统计剩余未完成总分钟 / 剩余天数 → 每日平均负荷；超过 dailyCapacityMinutes 视为风险。
export function computeRisk({ tasks, targetDate, dailyCapacityMinutes = 120, today, startDate }) {
  const formal = (tasks || [])
    .filter((t) => (t.day_number ?? 0) >= 1)
    .sort((a, b) => (a.day_number ?? 0) - (b.day_number ?? 0));
  const tDay = today || new Date().toISOString().slice(0, 10);
  const remDays = daysBetween(tDay, targetDate);

  // 剩余未完成总分钟（today 及之后；已完成行 done 不计）
  let remainingMin = 0;
  for (const r of formal) {
    const subs = expandDayRow(r);
    const todo = subs.filter((t) => t.status !== 'completed');
    if (todo.length === 0) continue;
    remainingMin += estimateMinutesForRow(r) || todo.length * 30;
  }

  const safeRemDays = Math.max(remDays, 1);
  const avgPerDay = Math.round(remainingMin / safeRemDays);
  // 风险阈值：超过每日承受能力的 120%（用户需求：每日任务量超过原计划 120% 才提示）
  const capacityThreshold = Math.round(dailyCapacityMinutes * 1.2);
  const overRatio = dailyCapacityMinutes > 0 ? avgPerDay / dailyCapacityMinutes : 0;
  const risk = avgPerDay > capacityThreshold;

  // 建议日期：若超能力，按容量反推所需天数
  let suggestedDate = null;
  if (risk && dailyCapacityMinutes > 0) {
    const needDays = Math.ceil(remainingMin / dailyCapacityMinutes);
    const d = new Date(tDay); d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + needDays);
    suggestedDate = d.toISOString().slice(0, 10);
  }

  const fmt = (m) => (m >= 60 ? `${(m / 60).toFixed(1)}h/day` : `${m}min/day`);
  return {
    risk,
    reason: risk
      ? `每日任务约需 ${fmt(avgPerDay)}，可能超过你的承受能力（${fmt(dailyCapacityMinutes)}）`
      : '当前负荷在承受范围内',
    currentLoad: fmt(avgPerDay),
    recommendedLoad: fmt(dailyCapacityMinutes),
    remainingMinutes: remainingMin,
    remainingDays: remDays,
    avgPerDay,
    overRatio: Math.round(overRatio * 100) / 100,
    suggestedDate,
  };
}

// 计算每个 stage 的进度（文档三：Stage 阶段保护机制）
export function stageProgress({ tasks }) {
  const formal = (tasks || [])
    .filter((t) => (t.day_number ?? 0) >= 1);
  const map = new Map(); // stage -> { total, completed }
  for (const r of formal) {
    const subs = expandDayRow(r);
    if (!map.has(r.stage)) map.set(r.stage, { total: 0, completed: 0 });
    const e = map.get(r.stage);
    e.total += subs.length;
    e.completed += subs.filter((s) => s.status === 'completed').length;
  }
  const stages = [];
  for (const [stage, v] of [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const completion_rate = v.total > 0 ? Math.round((v.completed / v.total) * 100) : 0;
    stages.push({
      stage,
      totalTasks: v.total,
      completed: v.completed,
      progress: completion_rate,
    });
  }
  // 当前 stage = 第一个未 100% 完成的 stage
  const current = stages.find((s) => s.progress < 100) || stages[stages.length - 1] || null;
  return {
    currentStage: current ? current.stage : '',
    currentProgress: current ? current.progress : 100,
    // 阶段保护阈值（文档三：当前 stage 完成率 < 90% 禁止进入下一 stage）
    stageProtectionThreshold: 90,
    blockedNextStage: current ? current.progress < 90 : false,
    stages,
  };
}

// 每日学习结算（文档一/二）：判断是否需要调整，但「不自动修改计划」
export function dailySettlement({ tasks, today, completions, dailyCapacityMinutes = 120, targetDate, startDate }) {
  const tDay = today || new Date().toISOString().slice(0, 10);
  const formal = (tasks || [])
    .filter((t) => (t.day_number ?? 0) >= 1)
    .sort((a, b) => (a.day_number ?? 0) - (b.day_number ?? 0));

  // 今日任务行（兼容 task_date 缺失：优先精确匹配，失败则按「起始日 + day_number 偏移」定位）
  // baseDate 优先级：显式传入的 startDate（最可靠，来自用户档案）> 首个带 task_date 的行 > 今天
  const datedRow = formal.find((r) => r.task_date);
  const baseDate = startDate || (datedRow ? datedRow.task_date : tDay);
  const baseDay = 1; // day_number=1 对应 baseDate；startDate 即学习第 1 天
  const computeTaskDate = (base, offset) => {
    const d = new Date(base + 'T00:00:00');
    d.setDate(d.getDate() + offset);
    return d.toISOString().slice(0, 10);
  };
  const rowForDate = (dateStr) =>
    formal.find((r) => r.task_date === dateStr) ||
    formal.find((r) => computeTaskDate(baseDate, (r.day_number ?? 0) - baseDay) === dateStr) || null;

  const todayRow = rowForDate(tDay) || formal.find((r) => (r.day_number ?? 0) >= 1);
  const todaySubs = todayRow ? expandDayRow(todayRow) : [];
  const todayDone = todaySubs.filter((s) => s.status === 'completed').length;
  const todayTotal = todaySubs.length;
  const completionRate = todayTotal > 0 ? todayDone / todayTotal : 1; // 无任务视为已完成

  // —— 连续三天（含今天）都有未完成任务 → 提示建议修改目标日期 ——
  // 判定标准：以 tDay 为基准，往前连续 3 天（tDay, 前一天, 前两天）各自都有任务且该天未全部完成。
  // 定位兼容 task_date 缺失（按 day_number 偏移），避免脏数据导致永远匹配不到行而不触发提示。
  const dayCompletion = (dateStr) => {
    const row = rowForDate(dateStr);
    if (!row) return null; // 当天无任务，不计为「未完成」
    const subs = expandDayRow(row);
    if (subs.length === 0) return null;
    const done = subs.filter((s) => s.status === 'completed').length;
    return done < subs.length; // true = 当天有未完成任务
  };
  const dateAt = (offset) => {
    const d = new Date(tDay + 'T00:00:00');
    d.setDate(d.getDate() - offset);
    return d.toISOString().slice(0, 10);
  };
  const result = {
    needAdjust: false,
    reason: '当天任务全部完成，无需调整',
    risk: null,
    stage: null,
    reminders: [],
  };

  // —— 唯一风险横幅：连续三天（不含今天）「未完成当日所有任务」→ 建议延长学习日期 ——
  // 判定：以 tDay 的前一天为基准往前连续计数（off=1 起，不含当天），
  // 当天有任务且完成率 < 100%（有任意未完成任务）即算「未完成当日所有任务」。
  // 不含今天：今天未完成属于正常进行中，不应计入「连续落后」；不足 3 天时不提示。
  let consecutiveIncomplete = 0;
  for (let off = 1; off < 30; off++) {
    const d = dateAt(off);
    const incomplete = dayCompletion(d);
    if (incomplete === null) break; // 当天无任务则停止向前计数
    if (incomplete) consecutiveIncomplete++; else break;
  }
  if (consecutiveIncomplete >= 3) {
    result.risk = {
      risk: true,
      type: 'three_day_incomplete',
      message: `已连续 ${consecutiveIncomplete} 天（不含今天）未能完成当日全部任务，任务压力持续累积，建议延长学习日期`,
      suggestedDate: null,
      consecutiveIncompleteDays: consecutiveIncomplete,
    };
    result.reminders.push(`已连续 ${consecutiveIncomplete} 天（不含今天）未完成当日全部任务，建议延长学习日期`);
  }

  // —— 是否需要调整（仅内部探测标识，不展示压力横幅） ——
  if (todayTotal > 0 && completionRate < 1) {
    result.needAdjust = true;
    result.reason = `当天完成率 ${Math.round(completionRate * 100)}%，存在未完成任务，可在当前 stage 内部重新分配`;
  } else {
    result.needAdjust = false;
    result.reason = '当天任务全部完成，无需调整';
  }

  // —— Stage 阶段保护 ——
  const sp = stageProgress({ tasks });
  result.stage = sp;
  if (sp.blockedNextStage) {
    result.reminders.push(`「${sp.currentStage}」完成度 ${sp.currentProgress}%，低于 ${sp.stageProtectionThreshold}%，下一阶段任务暂不进入今日计划`);
  }

  return result;
}

/**
 * 当前板块内「按剩余规划日」重新规划每日计划。
 * 触发场景：日期自然跳转到新的一天 / 测试模式点击「下一天」。
 * 规则：把「切换前那天（fromDate）未完成的子任务」+「当前板块（stage）内 fromDate 之后剩余未完成的任务」，
 *       收集后按「当前板块的剩余规划日」重新均匀分配到该板块剩余天数中（已完成任务保持原位不动）。
 * 纯函数：仅基于 daily_learning_tasks 的 rows 计算新的 days 数组，由调用方负责读 DB / 写回。
 * @param {{tasks:Array, fromDate?:string, today?:string, dailyCapacityMinutes?:number}} args
 * @returns {{changed:boolean, reason:string, stage?:string, remainDays?:number, adjustments:Array, days:Array}}
 */
export function rescheduleWithinStage({ tasks, fromDate, today, dailyCapacityMinutes = 120 }) {
  const formal = (tasks || [])
    .filter((t) => (t.day_number ?? 0) >= 1)
    .sort((a, b) => (a.day_number ?? 0) - (b.day_number ?? 0));
  if (formal.length === 0) {
    return { changed: false, reason: '无正式任务', adjustments: [], days: formal };
  }

  const fDay = fromDate || today || new Date().toISOString().slice(0, 10);
  // fromDate 对应的 day_number：优先 task_date 精确匹配，否则取 >= fromDate 的首个 day
  const fromRow = formal.find((r) => r.task_date === fDay)
    || formal.find((r) => (r.task_date || '') >= fDay);
  const fromDayNum = fromRow ? fromRow.day_number : (formal[0]?.day_number || 1);

  // 当前自然日对应的 day_number：重排起始日强行以「当前自然日（即用户当前切换到的目标日 / today）」为准，
  // 而非切换前的 fromDate。这样重排结果从用户当前停留的那一天开始往后铺，不留过期欠账日空档。
  const naturalToday = today || fromDate || new Date().toISOString().slice(0, 10);
  const todayRow = formal.find((r) => r.task_date === naturalToday)
    || formal.find((r) => (r.task_date || '') >= naturalToday);
  const todayDayNum = todayRow ? todayRow.day_number : (formal[0]?.day_number || 1);

  // 当前板块：以「目标日 fromDate 所在的 stage」为准（用户手动切到未来某天时，
  // 应按该天所属板块重排，而非全局最早未完成的板块）。回退到 stageProgress 全局当前板块。
  const targetStage = fromRow && fromRow.stage ? fromRow.stage : (stageProgress({ tasks: formal }).currentStage);
  const currentStage = targetStage;
  if (!currentStage) return { changed: false, reason: '无当前板块', adjustments: [], days: formal };
  const stageName = typeof currentStage === 'string' ? currentStage : (currentStage.stage || currentStage.title);

  // 当前板块的 day 范围
  const sameStageRows = formal.filter((r) => r.stage === stageName);
  if (sameStageRows.length === 0) return { changed: false, reason: '当前板块无任务', adjustments: [], days: formal };
  const stageDayNums = sameStageRows.map((r) => r.day_number);
  const stageFirstDay = Math.min(...stageDayNums);
  const stageLastDay = Math.max(...stageDayNums);

  // 当前板块的剩余规划日：起始日强行用「当前自然日对应的 day_number」，
  // 而非 fromDayNum（切换前日期）；即重排从真实今天开始，往后到板块最后一天（含两端）。
  const remainStart = Math.max(todayDayNum, stageFirstDay);
  const remainDays = [];
  for (let d = remainStart; d <= stageLastDay; d++) remainDays.push(d);
  if (!remainDays.length) return { changed: false, reason: '当前板块无剩余规划日', adjustments: [], days: formal };

  // 收集未完成任务（整体重排，对齐「进入新的一天」设计）：
  //  · 之前的天数（day_number < fromDayNum）：冻结不变，其未完成任务视为「欠账」纳入重排，
  //    但行本身原样保留、不重建、不进 resultDays 的重建逻辑。
  //  · 当天及之后（day_number >= fromDayNum）：未完成任务纳入重排。
  // 已完成任务保留在原位（原地打标区分），不参与重排、不重复、不移动。
  // 防累积：moveItems 按资源 key 去重，避免跨轮重排时同一任务被反复收集。
  const moveItems = []; // {type, resource, origDay, overdue}
  const seenKeys = new Set();
  for (const r of sameStageRows) {
    if (r.day_number > stageLastDay) continue;
    const isOverdue = r.day_number < fromDayNum; // 之前的天数 = 欠账
    for (const t of expandDayRow(r)) {
      if (t.status !== 'completed') {
        const k = resourceKeyOf(t.type, t.resource);
        if (seenKeys.has(k)) continue; // 去重：同一资源只排一次
        seenKeys.add(k);
        moveItems.push({ type: t.type, resource: t.resource, origDay: r.day_number, overdue: isOverdue });
      }
    }
  }
  if (moveItems.length === 0) return { changed: false, reason: '当前板块剩余任务均已完成', adjustments: [], days: formal };

  // 组装 resultDays：
  //  · 非当前板块的行：原样保留
  //  · 当前板块中「之前的天数（day_number < fromDayNum）」：冻结不变，原样保留（含已完成/未完成原状）
  //  · 当前板块内 remainStart..stageLastDay：先放各天已完成任务（原地打标保留），再把未完成任务均匀分配
  const resultDays = [];
  const adjustments = [];
  for (const r of formal) {
    if (r.stage !== stageName) {
      // 非当前板块：原样保留
      resultDays.push({ ...r, _changed: false });
    } else if (r.day_number < fromDayNum) {
      // 之前的天数：冻结不变，原样保留（不重建、不丢 done 标记）
      resultDays.push({ ...r, _changed: false });
    }
  }

  const completedByDay = {};
  for (const r of sameStageRows) {
    if (r.day_number < fromDayNum || r.day_number > stageLastDay) continue;
    // 当天及之后：已完成任务原地保留打标（done 标记不变），不参与重排
    completedByDay[r.day_number] = collectComplete(r).map((t) => ({ type: t.type, resource: t.resource }));
  }
  const buckets = {};
  remainDays.forEach((d) => { buckets[d] = [...(completedByDay[d] || [])]; });
  // 欠账优先：先把「过期欠账」紧接填充到最早的 remainDays，再把其余未完成任务轮转铺开，
  // 使历史欠账直接顺延到最近的未来日，而非均匀散落整个 stage。
  const overdueItems = moveItems.filter((it) => it.overdue);
  const normalItems = moveItems.filter((it) => !it.overdue);
  let oi = 0;
  for (const it of overdueItems) {
    const d = remainDays[oi % remainDays.length];
    buckets[d].push({ type: it.type, resource: it.resource });
    oi++;
  }
  normalItems.forEach((it, i) => {
    const d = remainDays[(oi + i) % remainDays.length];
    buckets[d].push({ type: it.type, resource: it.resource });
  });

  remainDays.forEach((d, idx) => {
    const subs = buckets[d];
    // 该天若仅含「已完成的打标任务」且无任何未完成任务，则保持原 completed 状态，不再标为 rescheduled
    const hasIncomplete = subs.some((s) => !s.resource || s.resource.done !== true);
    const reason = idx === 0
      ? `按「${stageName}」剩余 ${remainDays.length} 天重新规划每日计划`
      : `按「${stageName}」剩余规划日顺延重排`;
    resultDays.push(buildDayRow({
      day_number: d,
      stage: stageName,
      subs,
      status: (subs.length && !hasIncomplete) ? 'completed' : 'rescheduled',
      originalDay: null,
      adjustedDay: d,
      estimatedMinutes: 0,
      reason,
    }));
  });

  // 记录调整明细（未完成任务从原 day 重排到哪个 remainDay）
  moveItems.forEach((it, i) => {
    const d = remainDays[i % remainDays.length];
    adjustments.push({
      originalDay: it.origDay,
      adjustedDay: d,
      stage: stageName,
      type: it.type,
      title: it.resource.title || (it.type === 'video' ? '视频' : 'PDF'),
      reason: `按「${stageName}」剩余 ${remainDays.length} 天重新规划`,
    });
  });

  resultDays.sort((a, b) => (a.day_number ?? 0) - (b.day_number ?? 0));
  return {
    changed: adjustments.length > 0,
    reason: adjustments.length
      ? `已按「${stageName}」剩余 ${remainDays.length} 天重新规划每日计划，重排 ${adjustments.length} 项未完成任务`
      : '无需调整',
    stage: stageName,
    remainDays: remainDays.length,
    adjustments,
    days: resultDays,
  };
}

export default { adjustPlan, rescheduleByTargetDate, computeRisk, stageProgress, dailySettlement, rescheduleWithinStage };
