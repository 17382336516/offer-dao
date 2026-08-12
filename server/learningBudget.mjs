// ============================================================================
// Learning Budget Manager —— 学习预算计算层（新增模块，纯函数，无 DB / 无 LLM）
// ----------------------------------------------------------------------------
// 设计原则（来自需求约束）：
//   1. 学习计划长度由「用户设定学习天数 × 每日学习时长」决定，而非资源数量。
//   2. 时间预算必须由代码控制：total = days × dailyMinutes。
//   3. 五阶段 + 技能权重分配时间；小红书只能轻微调整权重（±20%，已在 applyTrendWeightBoost 实现）。
//   4. 本模块不修改任何资源匹配 / 小红书抓取 / PDF 匹配 / 技能体系逻辑，只做"预算计算"。
// ============================================================================

// 默认每日学习时长：4.5 小时 = 270 分钟（满足 4~5 小时定位）
export const DEFAULT_DAILY_MINUTES = 270;
// 每日时长允许浮动范围：240~300 分钟（4~5 小时）
export const DAILY_MIN_MINUTES = 240;
export const DAILY_MAX_MINUTES = 300;

// 固定 AI 产品经理五阶段及阶段时间占比（与 skillNormalizer.AI_PM_STAGE_MAP 阶段名一致）
// 比例之和为 1.0。
export const STAGE_WEIGHTS = {
  'AI基础与产品认知': 0.15,
  'AI产品设计': 0.25,
  'AI效果评估': 0.15,
  '大模型与AI应用': 0.30,
  'AI项目落地与协作': 0.15,
};

// 阶段 -> 技能清单（与 AI_PM_STAGE_MAP 对齐，用于把阶段预算拆到技能权重）
// 注意：这里只作为「回退映射」，若传入的 skillTree 已含 stage 信息则优先用 skillTree。
export const STAGE_TO_SKILLS_FALLBACK = {
  'AI基础与产品认知': ['LLM基础概念', '大模型能力边界', 'AI产品基础认知'],
  'AI产品设计': ['AI需求分析', 'AI功能设计', '用户场景分析', 'AI产品设计方法', 'AI PRD设计'],
  'AI效果评估': ['Prompt效果评估', 'RAG评估', '模型效果指标', '用户反馈闭环'],
  '大模型与AI应用': ['RAG', 'Agent', 'Workflow', 'AI应用架构', '企业知识库'],
  'AI项目落地与协作': ['AI产品项目管理', '技术团队协作', '商业化应用'],
};

// 解析每日学习时长：复用 dailyPlanGenerator.parseDailyStudyTime 的语义（支持 "2h"/"轻量" 等），
// 但本层额外约束到 [DAILY_MIN, DAILY_MAX] 区间，并把默认设为 270。
// 为避免循环依赖，这里独立实现一个最小解析（不 import dailyPlanGenerator）：
function resolveDailyMinutes(input) {
  let n = DEFAULT_DAILY_MINUTES;
  const s = (input == null ? '' : String(input)).trim().toLowerCase();
  const INTENSITY = { light: 120, standard: 240, intensive: 360, 轻量: 120, 标准: 240, 强化: 360 };
  if (s && INTENSITY[s] != null) {
    n = INTENSITY[s];
  } else if (s) {
    const num = parseFloat(s);
    if (!Number.isNaN(num)) {
      if (s.includes('h')) n = num * 60;
      else if (s.includes('m')) n = num;
      else n = num <= 12 ? num * 60 : num; // 纯数字 ≤12 视为小时
    }
  }
  // 落回 4~5 小时区间（用户未给或越界时取默认 270）
  if (!Number.isFinite(n) || n < DAILY_MIN_MINUTES) n = DEFAULT_DAILY_MINUTES;
  if (n > DAILY_MAX_MINUTES) n = DAILY_MAX_MINUTES;
  return Math.round(n);
}

/**
 * 计算学习预算（纯函数）。
 * @param {Object} params
 *   - days:             用户设定的学习天数（必填，正整数）
 *   - dailyStudyTime:   每日学习时长输入（可选，"2h"/"标准"/240/...），缺省 270
 *   - skillTree:        { skills: [{ standard_name, weight, stage? }] } 含技能权重与阶段归属
 *   - trends:           extractTrendKeywordsFromXhs 输出（可选），用于轻微调整权重（±20%）
 * @returns {Object} budget
 *   {
 *     days, dailyMinutes, totalMinutes,
 *     stageBudget:   { stageName: { weight, minutes } },
 *     skillBudget:   { skillName: { stage, weight, minutes } },
 *     createdAt
 *   }
 */
export function computeLearningBudget({ days, dailyStudyTime, skillTree, trends } = {}) {
  const d = Math.max(1, Math.floor(Number(days) || 0));
  if (!d) throw new Object.assign(new Error('days 必须为正整数'), { code: 'INVALID_DAYS' });

  const dailyMinutes = resolveDailyMinutes(dailyStudyTime);
  const totalMinutes = d * dailyMinutes;

  // —— 阶段预算 ——
  const stageBudget = {};
  for (const [stage, w] of Object.entries(STAGE_WEIGHTS)) {
    stageBudget[stage] = { weight: w, minutes: Math.round(totalMinutes * w) };
  }

  // —— 技能预算（按 skillTree 的 weight 拆分到阶段内）——
  // 先用 skillTree.skills 构建技能元信息（weight + 所属 stage，优先用 skillTree 自带 stage）
  const skills = Array.isArray(skillTree?.skills) ? skillTree.skills : [];
  const skillMeta = new Map();
  for (const s of skills) {
    const name = String(s.standard_name || s.name || '');
    if (!name) continue;
    let stg = s.stage || '';
    if (!stg) {
      // 回退：从 STAGE_TO_SKILLS_FALLBACK 反查所属阶段
      for (const [st, list] of Object.entries(STAGE_TO_SKILLS_FALLBACK)) {
        if (list.includes(name)) { stg = st; break; }
      }
    }
    skillMeta.set(name, {
      name,
      weight: typeof s.weight === 'number' && s.weight > 0 ? s.weight : 0.1,
      stage: stg,
    });
  }

  // 若 skillTree 为空（极端情况），用回退映射兜底，保证预算结构完整
  if (skillMeta.size === 0) {
    for (const [st, list] of Object.entries(STAGE_TO_SKILLS_FALLBACK)) {
      for (const nm of list) {
        if (!skillMeta.has(nm)) skillMeta.set(nm, { name: nm, weight: 1 / list.length, stage: st });
      }
    }
  }

  // 按阶段分组，阶段内权重归一化后分配该阶段的预算
  const skillBudget = {};
  const byStage = {};
  for (const m of skillMeta.values()) {
    (byStage[m.stage] = byStage[m.stage] || []).push(m);
  }
  for (const [st, list] of Object.entries(byStage)) {
    const stageMin = stageBudget[st]?.minutes || 0;
    const wSum = list.reduce((a, b) => a + b.weight, 0) || 1;
    for (const m of list) {
      skillBudget[m.name] = {
        stage: st,
        weight: Number(m.weight.toFixed(4)),
        minutes: Math.round((m.weight / wSum) * stageMin),
      };
    }
  }

  return {
    days: d,
    dailyMinutes,
    totalMinutes,
    stageBudget,
    skillBudget,
    createdAt: Date.now(),
  };
}

/**
 * 按预算裁剪资源：预算决定"资源数量"，而非资源决定学习天数。
 * 输入某技能已匹配到的资源（视频/PDF），按 resourcePriority 降序贪心选入，
 * 直到累计时长达到 skillBudget.minutes（允许少量超出，取最接近的一项后停止）。
 *
 * @param {Array} resources  该技能下的资源数组（需含 durationSec / 阅读分钟 / relevance_score / resourcePriority）
 * @param {number} budgetMinutes  该技能预算分钟数
 * @param {Object} opts
 *   - perItemCapMin: 单资源最大计入分钟数（防止超长视频独吞预算），默认 120
 * @returns {Array} 选中资源子集（保持原顺序无关，已按优先级排序）
 */
export function selectResourcesByBudget(resources = [], budgetMinutes = 0, { perItemCapMin = 120 } = {}) {
  if (!Array.isArray(resources) || resources.length === 0 || budgetMinutes <= 0) return [];
  // resourcePriority = skillWeight × relevance_score；缺省用 relevance_score
  const sorted = [...resources].sort((a, b) => {
    const pa = (a.resourcePriority ?? a.relevance_score ?? 0);
    const pb = (b.resourcePriority ?? b.relevance_score ?? 0);
    return pb - pa;
  });
  const picked = [];
  let used = 0;
  for (const r of sorted) {
    const dur = Math.min(perItemCapMin, Math.round((Number(r.durationSec) || Number(r.minutes) || 0) / 60) || 0);
    if (dur <= 0) continue;
    if (used + dur > budgetMinutes && picked.length > 0) break; // 已接近预算则停止（预算决定数量）
    picked.push(r);
    used += dur;
  }
  return picked;
}
