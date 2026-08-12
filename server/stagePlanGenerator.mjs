// 总体（阶段级）学习计划生成服务（stagePlanGenerator） —— MVP
//
// 职责边界：
//   LLM 负责：阶段划分 / 学习顺序 / 阶段目标 / 每阶段覆盖哪些技能 / 引用哪些资源 id
//   代码负责：PDF 与视频的 title / link / docId 全部按 id 回填为真实值
//
// 【硬约束】不生成每日计划、不做每日任务拆分，只输出 stages。
// 【硬约束】模型返回的 link / title 一律不采信，只用它返回的 id 去真实资源池里查。
import { callQwen as _realCallQwen } from './plan.mjs';
import { isAiProductManagerJob } from './skillNormalizer.mjs';

let _callQwen = _realCallQwen;
export function __setLLMForTest(fn) { _callQwen = fn; }

const SYSTEM_PROMPT = `你是一名资深学习路径规划师。输入包含：
1) 目标岗位
2) 标准技能列表（standard_name / category / level）
3) 技能依赖 skill_dependencies（from -> to 表示 to 依赖 from，from 必须先学）
4) 真实 PDF 资源池 pdfResources（每条含 id / title / skills）
5) 真实 B站视频资源池 videoResources（每条含 id / title / skills）

请把技能按依赖关系拓扑分层，划分为若干【学习阶段】，输出总体学习计划。

【必须遵循的硬约束】
1. 只做阶段级规划。严禁输出每日计划、第N天、daily、每日任务之类的内容。
2. 学习顺序必须满足 skill_dependencies：前置技能所在阶段必须早于后继技能所在阶段。
3. 引用资源时**只能填 id**，且该 id 必须真实出现在输入的 pdfResources / videoResources 中。
4. 严禁编造 PDF 标题、文件名、docId、B站链接。title 字段可留空，系统会用真实数据回填。
5. 若某阶段的技能在资源池中找不到对应资料，在 resource_gap 里如实写明缺什么，不要伪造。
6. 阶段数量建议 3-6 个，每个阶段给出建议时长（如 "2周"）。

【输出格式】只输出如下 JSON（不要任何解释、不要 markdown 代码块）：
{
  "job": "岗位名称",
  "overview": "总体学习路线概述（2-4 句）",
  "duration": "总周期，如 12周",
  "stages": [
    {
      "stage": "阶段名",
      "duration": "2周",
      "skills": ["标准技能名"],
      "goals": "本阶段学习目标",
      "resources": {
        "pdf": [{ "id": "资源池里的pdf id" }],
        "videos": [{ "id": "资源池里的video id" }]
      },
      "resource_gap": ""
    }
  ]
}`;

function buildUserPrompt({ job, skills, deps, pdfResources, videoResources }) {
  // 只把 LLM 决策所需的最小字段喂进去，避免 PDF 正文把 token 撑爆
  const pdfView = pdfResources.map((p) => ({ id: p.id, title: p.title, skills: p.skills }));
  const videoView = videoResources.map((v) => ({ id: v.id, title: v.title, skills: v.skills }));
  return [
    `目标岗位：${job || '未指定'}`,
    '',
    '【标准技能列表】',
    JSON.stringify(skills.map((s) => ({ standard_name: s.name, category: s.category, level: s.level })), null, 2),
    '',
    '【技能依赖 skill_dependencies】',
    JSON.stringify(deps, null, 2),
    '',
    `【真实 PDF 资源池】共 ${pdfView.length} 条（只能引用这些 id）：`,
    JSON.stringify(pdfView, null, 2),
    '',
    `【真实 B站视频资源池】共 ${videoView.length} 条（只能引用这些 id）：`,
    JSON.stringify(videoView, null, 2),
    '',
    '请严格按系统指令输出阶段级学习计划 JSON。只填资源 id，不要写 link。不要生成每日计划。',
  ].join('\n');
}

function parseJsonLoose(text) {
  if (!text) throw new Error('模型返回为空');
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  if (s === -1 || e === -1 || e < s) throw new Error('未找到 JSON 对象');
  return JSON.parse(t.slice(s, e + 1));
}

// 从技能树里取依赖关系（优先用标准化后的）
function extractDeps(skillTree) {
  const nd = skillTree?.normalized_skill_dependencies;
  if (Array.isArray(nd) && nd.length) {
    return nd.map((d) => ({ from: d.from_std || d.from, to: d.to_std || d.to, confidence: d.confidence || '' }));
  }
  const raw = skillTree?.raw_route?.skill_dependencies;
  if (Array.isArray(raw)) return raw.map((d) => ({ from: d.from, to: d.to, confidence: d.confidence || '' }));
  return [];
}

// 兜底：LLM 不可用时按 level 分层生成阶段，保证链路不中断
function buildFallback({ job, skills, pdfResources, videoResources }) {
  const order = ['beginner', 'intermediate', 'advanced'];
  const labels = { beginner: '入门基础', intermediate: '进阶提升', advanced: '高阶实战' };
  const stages = [];
  for (const lv of order) {
    const group = skills.filter((s) => (s.level || 'beginner') === lv);
    if (!group.length) continue;
    const names = group.map((s) => s.name);
    stages.push({
      stage: labels[lv],
      duration: '待定',
      skills: names,
      goals: `掌握 ${names.join('、')}`,
      resources: {
        pdf: pdfResources.filter((p) => p.skills.some((k) => names.includes(k))).map((p) => ({ id: p.id })),
        videos: videoResources.filter((v) => v.skills.some((k) => names.includes(k))).map((v) => ({ id: v.id })),
      },
      resource_gap: '',
    });
  }
  return { job, overview: '（大模型暂不可用，已按技能难度层级生成兜底阶段划分）', duration: '待定', stages, _fallback: true };
}

function buildAiProductManagerPlan({ job, skills, pdfResources, videoResources }) {
  const groups = [
    ['AI与大模型基础', ['LLM基础概念', '大模型能力边界', 'Prompt工程', 'AI产品基础认知'], '建立 AI 产品经理必须具备的大模型认知与 Prompt 基础。'],
    ['AI产品设计', ['AI需求分析', 'AI产品设计方法', '用户场景分析', 'AI功能拆解'], '把用户场景转化为可落地的 AI 产品功能。'],
    ['数据与模型效果评估', ['Prompt效果评估', 'RAG评估', '模型效果指标', '用户反馈闭环'], '建立从模型指标到用户反馈的效果评估闭环。'],
    ['AI应用架构', ['RAG', 'Agent', 'Workflow', 'AI应用架构'], '理解 RAG、Agent、Workflow 的产品架构与选型边界。'],
    ['AI产品项目落地', ['AI PRD设计', 'AI项目管理', '技术团队协作', '商业化应用'], '完成 AI PRD、研发协作与业务落地的完整闭环。'],
  ];
  return {
    job,
    overview: '围绕 AI 产品经理岗位，按大模型基础、产品设计、效果评估、应用架构和项目落地五个阶段递进学习。',
    duration: '10周',
    stages: groups.map(([stage, names, goals]) => ({
      stage,
      duration: '2周',
      skills: names.filter((name) => skills.some((s) => s.name === name)),
      goals,
      resources: {
        pdf: pdfResources.filter((p) => (p.skills || []).some((s) => names.includes(s))).slice(0, 4).map((p) => ({ id: p.id })),
        videos: videoResources.filter((v) => (v.skills || []).some((s) => names.includes(s))).slice(0, 2).map((v) => ({ id: v.id })),
      },
      resource_gap: '',
    })),
  };
}

// ---------- 主入口 ----------
// 输入：{ job, skillTree, pdfResources, videoResources, coverage }
// 输出：阶段级总体学习计划，资源字段均为代码回填的真实数据
export async function generateStagePlan({ job, skillTree, skills, pdfResources = [], videoResources = [], coverage } = {}) {
  const skillList = Array.isArray(skills) ? skills : [];
  if (!skillList.length) {
    const err = new Error('标准技能列表为空，无法生成学习计划');
    err.code = 'EMPTY_SKILLS';
    throw err;
  }
  const effectiveJob = job || skillTree?.job || '';
  const deps = extractDeps(skillTree);

  // 真实资源索引：id -> 资源对象。回填时只认这里的数据。
  const pdfById = new Map(pdfResources.map((p) => [String(p.id), p]));
  const videoById = new Map(videoResources.map((v) => [String(v.id), v]));

  let plan;
  if (isAiProductManagerJob(effectiveJob)) {
    // 该岗位的阶段边界是产品规则，不交给模型自由改写，避免普通产品/工程主题漂移。
    plan = buildAiProductManagerPlan({ job: effectiveJob, skills: skillList, pdfResources, videoResources });
  } else {
    try {
      const raw = await _callQwen(SYSTEM_PROMPT, buildUserPrompt({ job: effectiveJob, skills: skillList, deps, pdfResources, videoResources }));
      plan = parseJsonLoose(raw);
    } catch (e) {
      console.warn('[stagePlanGenerator] LLM 失败，使用兜底阶段划分:', e.message);
      plan = buildFallback({ job: effectiveJob, skills: skillList, pdfResources, videoResources });
      plan._llmError = e.message;
    }
  }

  plan.job = plan.job || effectiveJob;
  plan.overview = plan.overview || '';
  plan.duration = plan.duration || '';
  if (!Array.isArray(plan.stages)) plan.stages = [];
  // MVP 只交付阶段级计划：模型若擅自返回顶层每日结构，一律剔除
  for (const k of ['daily_plan', 'daily', 'dailyPlan', 'daily_tasks', 'days', 'schedule']) delete plan[k];

  // ---- 关键：用真实资源回填，彻底丢弃模型可能编造的 title / link / docId ----
  // 跨阶段全局 PDF 占用：同一本 PDF 只分配给一个阶段，杜绝不同模块共用同一 PDF。
  const usedPdfGlobal = new Set();
  for (const stage of plan.stages) {
    stage.stage = stage.stage || '未命名阶段';
    stage.duration = stage.duration || '';
    stage.goals = stage.goals || stage.goal || '';
    // 统一阶段技能字段：LLM 可能返回 skillNames 而非 skills，两者都要认，
    // 否则兜底资源匹配（按技能名找视频/PDF）会全部落空，导致「暂未匹配到视频」。
    stage.skills = Array.isArray(stage.skills) ? stage.skills
      : (Array.isArray(stage.skillNames) ? stage.skillNames
      : (Array.isArray(stage.skill_names) ? stage.skill_names : []));

    const r = stage.resources && typeof stage.resources === 'object' ? stage.resources : {};
    const rawPdf = Array.isArray(r.pdf) ? r.pdf : [];
    const rawVideos = Array.isArray(r.videos) ? r.videos : [];

    const seenPdf = new Set();
    const pdf = [];
    for (const item of rawPdf) {
      const src = pdfById.get(String(item?.id ?? ''));
      // id 不在真实池中 / 已被本阶段或全局占用 -> 直接丢弃
      if (!src || seenPdf.has(src.id) || usedPdfGlobal.has(src.id)) continue;
      seenPdf.add(src.id);
      usedPdfGlobal.add(src.id);
      pdf.push({ id: src.id, title: src.title, docId: src.docId, file: src.file, link: src.link, chapters: src.chapters || [], relevance_score: src.relevance_score || 0, relevance: src.relevance || null, reason: src.reason || '' });
    }

    const seenVideo = new Set();
    const videos = [];
    for (const item of rawVideos) {
      const src = videoById.get(String(item?.id ?? ''));
      if (!src || seenVideo.has(src.id)) continue;
      seenVideo.add(src.id);
      videos.push({ id: src.id, title: src.title, url: src.link, link: src.link, platform: src.platform, author: src.author, durationSec: src.durationSec, publishDate: src.publishDate, relevance_score: src.relevance_score || 0, relevance: src.relevance || null, reason: src.reason || '' });
    }

    // 模型没引用资源时，按技能名兜底匹配一次，避免阶段资源整段为空（遵守全局唯一）
    if (!pdf.length) {
      for (const p of pdfResources) {
        if (p.skills.some((k) => stage.skills.includes(k)) && !seenPdf.has(p.id) && !usedPdfGlobal.has(p.id)) {
          seenPdf.add(p.id);
          usedPdfGlobal.add(p.id);
          pdf.push({ id: p.id, title: p.title, docId: p.docId, file: p.file, link: p.link, chapters: p.chapters || [], relevance_score: p.relevance_score || 0, relevance: p.relevance || null, reason: p.reason || '' });
        }
      }
    }
    // 全局去重不能让后续阶段没有真实资料；若本阶段存在相关文档，允许复用一份。
    if (!pdf.length) {
      const reusable = pdfResources.find((p) => (p.skills || []).some((k) => stage.skills.includes(k)));
      if (reusable) {
        pdf.push({ id: reusable.id, title: reusable.title, docId: reusable.docId, file: reusable.file, link: reusable.link, chapters: reusable.chapters || [], relevance_score: reusable.relevance_score || 0, relevance: reusable.relevance || null, reason: reusable.reason || '' });
      }
    }
    if (!videos.length) {
      for (const v of videoResources) {
        if (v.skills.some((k) => stage.skills.includes(k)) && !seenVideo.has(v.id)) {
          seenVideo.add(v.id);
          videos.push({ id: v.id, title: v.title, url: v.link, link: v.link, platform: v.platform, author: v.author, durationSec: v.durationSec, publishDate: v.publishDate, relevance_score: v.relevance_score || 0, relevance: v.relevance || null, reason: v.reason || '' });
        }
      }
    }

    stage.resources = { pdf, videos };

    // 资源缺口以代码实际匹配结果为准，不完全依赖模型自述
    const missingInStage = stage.skills.filter((n) => (coverage?.missing || []).includes(n));
    if (missingInStage.length) {
      stage.resource_gap = `缺少以下技能的 PDF/视频资料：${missingInStage.join('、')}`;
    } else if (!pdf.length && !videos.length) {
      stage.resource_gap = stage.resource_gap || '本阶段暂未匹配到知识库 PDF 与 B站视频资源';
    } else {
      stage.resource_gap = stage.resource_gap || '';
    }
    // MVP 明确不产出每日计划，清掉模型可能自作主张加的字段
    delete stage.daily;
    delete stage.daily_tasks;
    delete stage.tasks;
  }

  return plan;
}
