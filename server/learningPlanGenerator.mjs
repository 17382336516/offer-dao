// 最终学习计划生成服务（learningPlanGenerator）
// 阶段目标：将「岗位技能树 + 技能依赖 + PDF 匹配结果 + B站课程推荐结果」交给大模型，
// 融合生成用户最终学习计划（learning_plan）。
//
// 资源使用约束（来自需求）：
//  - 必须优先使用已有 PDF
//  - 必须使用已有视频资源
//  - 禁止创造不存在的 PDF
//  - 禁止创造不存在的视频链接
//  - 资源不足时明确标记（stage 级 resource_gap 字段）
//  - 按 skill_dependencies 决定学习顺序
// 不重新设计 RAG、不优化 B站推荐（沿用上游已产出结果）。
import { callQwen as _realCallQwen } from './plan.mjs';

// 内部 LLM 调用引用（默认真实千问；测试时可覆盖，对生产无影响）
let _callQwen = _realCallQwen;
export function __setLLMForTest(fn) { _callQwen = fn; }

// ---------- 提示词 ----------
const SYSTEM_PROMPT = `你是一名资深学习路径规划师。输入包含：
1) 岗位技能树（skills + 技能依赖 skill_dependencies）
2) PDF 知识库匹配结果（pdfResources，每个含 id / title / file / link / chapters[真实章节，可能为空]）
3) B站课程推荐结果（videoResources，每个含 id / biliTitle / link / platform）

请根据以上真实材料，为用户生成一份可执行的最终学习计划。

【必须遵循的硬约束】
1. 学习顺序：必须依据 skill_dependencies（from -> to 表示 to 依赖 from，from 应先学）组织阶段，前置技能不得排在后置技能之后。
2. 优先使用 PDF：每个阶段涉及到的技能，应优先从 pdfResources 中挑选匹配的 PDF 作为学习资料。
3. 必须使用视频：每个阶段都必须引用 videoResources 中真实存在的视频（不得整段缺失）。
4. 严禁编造：pdf_resources 与 video_resources 里出现的每一条，其 id 必须来自输入中的 pdfResources / videoResources，严禁创造输入里不存在的 PDF 标题或视频链接。
5. 章节必须真实：pdf_resources 中的 chapters 数组，只能从输入 pdfResources 里该 PDF 已标注的真实章节中选取（输入已按 PDF 聚合好章节），严禁编造章节名/章节号。
6. 无章节即整本学习：若某 PDF 没有 chapters（输入未提供章节），则 chapters 填 []，并直接将该 PDF 视为「全书/全部内容学习」，不要写“第几月几章”之类，也不要另起知识点小节去替代章节；前端会按“整本学习”展示。
7. 资源不足标记：若某个技能在 pdfResources / videoResources 中找不到对应资料，必须在该阶段的 resource_gap 中写明缺少 XXX 的 PDF/视频资料，不得伪造。

【阶段划分建议】
- 将技能树按依赖关系拓扑分层，每一层（或紧耦合的一组）作为一个 stage。
- 每个 stage 给出：阶段名、建议时长、学习目标、覆盖技能、PDF 资料、B站课程、实践任务、资源缺口。

【输出格式】只输出如下 JSON（不要任何解释、不要 markdown 代码块）：
{
  "job": "岗位名称",
  "duration": "总学习周期，如 12周",
  "learning_plan": [
    {
      "stage": "阶段名",
      "duration": "建议时长，如 3周",
      "goal": "本阶段学习目标",
      "skills": ["技能名"],
      "pdf_resources": [
        { "id": "pdf的id", "title": "PDF标题", "file": "文件名或链接", "chapters": ["第X章 标题", "第Y章 标题"], "link": "PDF链接(如有)" }
      ],
      "video_resources": [
        { "id": "video的id", "title": "视频标题", "link": "视频链接", "platform": "bilibili" }
      ],
      "tasks": ["可执行的实践任务1", "实践任务2"],
      "resource_gap": "若资源充足填\"\"，否则写明缺什么"
    }
  ]
}`;

// 从 skillTree 提取结构化技能与依赖
function extractSkillsAndDeps(skillTree) {
  const skills = Array.isArray(skillTree?.skills) ? skillTree.skills : [];
  let deps = Array.isArray(skillTree?.normalized_skill_dependencies)
    ? skillTree.normalized_skill_dependencies
    : [];
  if (!deps.length && skillTree?.raw_route?.skill_dependencies) {
    deps = skillTree.raw_route.skill_dependencies.map((d) => ({
      from: d.from,
      to: d.to,
      from_std: d.from,
      to_std: d.to,
      confidence: d.confidence,
    }));
  }
  return { skills, deps };
}

// 规整 PDF 资源列表：统一为 { id, title, file, link, chapters }
// chapters：把同一 PDF（按 file/title 归并）在知识库检索中命中的真实章节聚合去重，仅如实引用。
// 没有章节的 PDF 则 chapters=[]，视为「全书学习」。
function normalizePdfResources(pdfResources) {
  const list = Array.isArray(pdfResources) ? pdfResources : [];
  // 先按 file（无 file 时用 title）归并，聚合章节
  const groups = new Map();
  list.forEach((p, i) => {
    const file = p?.file || p?.meta?.file || p?.fileName || p?.ref || '';
    const title = p?.title || p?.meta?.title || file || `PDF资料${i + 1}`;
    const key = file || title; // 同 file/title 视为同一本 PDF
    const chapter = (p?.chapter || p?.meta?.chapter || '').trim();
    const docId = p?.docId || p?.doc_id || p?.meta?.docId || p?.id || '';
    if (!groups.has(key)) {
      groups.set(key, {
        id: p?.id ?? `pdf_${i}`,
        title,
        file,
        link: p?.link || p?.url || (p?.meta?.file ? '' : ''),
        chapters: [],
        docId, // 真实知识库文档 id，前端据此拉取 /api/rag/file 打开原始 PDF
      });
    }
    const g = groups.get(key);
    if (!g.docId && docId) g.docId = docId;
    if (chapter && !g.chapters.includes(chapter)) {
      g.chapters.push(chapter);
    }
  });
  return [...groups.values()];
}

// 规整视频资源列表：统一为 { id, title, link, platform }
function normalizeVideoResources(videoResources) {
  const list = Array.isArray(videoResources) ? videoResources : [];
  return list.map((v, i) => ({
    id: v?.id ?? `video_${i}`,
    title: v?.biliTitle || v?.title || `视频资料${i + 1}`,
    link: v?.link || v?.url || '',
    platform: v?.platform || 'bilibili',
  }));
}

function buildUserPrompt({ job, skillTree, pdfResources, videoResources }) {
  const { skills, deps } = extractSkillsAndDeps(skillTree);
  const pdfs = normalizePdfResources(pdfResources);
  const videos = normalizeVideoResources(videoResources);

  const parts = [];
  parts.push(`目标岗位：${job || skillTree?.job || '未指定'}`);
  parts.push('');
  parts.push('【岗位技能树 skills】');
  parts.push(JSON.stringify(skills, null, 2));
  parts.push('');
  parts.push('【技能依赖 skill_dependencies】（from 应先于 to 学习）');
  parts.push(JSON.stringify(deps, null, 2));
  parts.push('');
  parts.push(`【PDF 知识库匹配结果 pdfResources】共 ${pdfs.length} 条（你只能引用这些 id；chapters 只能用下方已标注的真实章节，无 chapters 的 PDF 视为全书学习）：`);
  const pdfView = pdfs.map((p) => ({
    id: p.id,
    title: p.title,
    file: p.file,
    link: p.link,
    chapters: p.chapters, // 该 PDF 在知识库中命中的真实章节（为空=全书学习）
  }));
  parts.push(JSON.stringify(pdfView, null, 2));
  parts.push('');
  parts.push(`【B站课程推荐结果 videoResources】共 ${videos.length} 条（你只能引用这些 id）：`);
  parts.push(JSON.stringify(videos, null, 2));
  parts.push('');
  parts.push('请严格按系统指令，基于以上真实材料生成学习计划 JSON。不得编造任何 PDF 标题或视频链接，资源不足请在 resource_gap 说明。');
  return parts.join('\n');
}

// 容错解析：剥离 ```json 包裹并截取首个 { 到最后一个 }
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

// 兜底：当 LLM 不可用时，按依赖层数做最小结构化学习计划
function buildFallback({ job, skillTree, pdfResources, videoResources }) {
  const { skills, deps } = extractSkillsAndDeps(skillTree);
  const pdfs = normalizePdfResources(pdfResources);
  const videos = normalizeVideoResources(videoResources);
  const skillNames = (skills || []).map((s) => s.standard_name || s.name || s).filter(Boolean);
  if (skillNames.length === 0) skillNames.push('(未在技能树中发现具体技能)');
  return {
    job: job || skillTree?.job || '',
    duration: '未评估',
    learning_plan: [
      {
        stage: '全部技能总览（兜底）',
        duration: '待定',
        goal: '因大模型不可用，未能按依赖切分阶段，请参考技能树自行排期。',
        skills: skillNames,
        pdf_resources: pdfs.map((p) => ({ id: p.id, title: p.title, file: p.file, chapters: p.chapters || [], link: p.link || '', docId: p.docId || '' })),
        video_resources: videos.map((v) => ({ id: v.id, title: v.title, link: v.link, platform: v.platform })),
        tasks: ['结合技能树与资料自学'],
        resource_gap: pdfs.length || videos.length ? '' : '无可用 PDF / 视频资源',
      },
    ],
    _fallback: true,
  };
}

// ---------- 主入口 ----------
export async function generateLearningPlan({ job, skillTree, pdfResources, videoResources } = {}) {
  if (!skillTree || typeof skillTree !== 'object') {
    const err = new Error('skillTree 为空或格式错误');
    err.code = 'EMPTY_SKILL_TREE';
    throw err;
  }

  const effectiveJob = job || skillTree?.job || '';
  const user = buildUserPrompt({ job: effectiveJob, skillTree, pdfResources, videoResources });

  // 建立 id/title/file -> 真实资源 的索引，用于回填 docId、link 等模型不该编造的字段
  const normalizedPdfs = normalizePdfResources(pdfResources);
  const pdfIndex = new Map();
  for (const p of normalizedPdfs) {
    [p.id, p.title, p.file].forEach((k) => {
      if (k && !pdfIndex.has(String(k))) pdfIndex.set(String(k), p);
    });
  }
  const lookupPdf = (p) =>
    pdfIndex.get(String(p?.id ?? '')) ||
    pdfIndex.get(String(p?.title ?? '')) ||
    pdfIndex.get(String(p?.file ?? '')) ||
    null;

  let raw;
  try {
    raw = await _callQwen(SYSTEM_PROMPT, user);
  } catch (e) {
    // LLM 失败时使用兜底结构，保证链路不中断
    console.warn('[learningPlanGenerator] 大模型调用失败，使用兜底计划:', e.message);
    const fb = buildFallback({ job: effectiveJob, skillTree, pdfResources, videoResources });
    fb._llmError = e.message;
    return fb;
  }

  let plan;
  try {
    plan = parseJsonLoose(raw);
  } catch (e) {
    console.warn('[learningPlanGenerator] JSON 解析失败，使用兜底计划:', e.message);
    const fb = buildFallback({ job: effectiveJob, skillTree, pdfResources, videoResources });
    fb._parseError = e.message;
    return fb;
  }

  // 字段补全
  plan.job = plan.job || effectiveJob;
  if (!Array.isArray(plan.learning_plan)) plan.learning_plan = [];
  for (const stage of plan.learning_plan) {
    stage.stage = stage.stage || '未命名阶段';
    stage.duration = stage.duration || '';
    stage.goal = stage.goal || '';
    stage.skills = Array.isArray(stage.skills) ? stage.skills : [];
    stage.pdf_resources = Array.isArray(stage.pdf_resources) ? stage.pdf_resources : [];
    stage.pdf_resources = stage.pdf_resources.map((p) => {
      const src = lookupPdf(p);
      return {
        id: p.id,
        title: p.title || src?.title || '',
        file: p.file || src?.file || '',
        chapters: Array.isArray(p.chapters) ? p.chapters : [],
        link: p.link || src?.link || '',
        // docId 只能来自真实知识库检索结果，不采用模型输出，避免编造
        docId: src?.docId || '',
      };
    });
    stage.video_resources = Array.isArray(stage.video_resources) ? stage.video_resources : [];
    stage.tasks = Array.isArray(stage.tasks) ? stage.tasks : [];
    stage.resource_gap = stage.resource_gap || '';
  }
  return plan;
}
