// 学习路线分析服务（learningRouteAnalyzer）
// 阶段目标（仅本阶段）：小红书多路线帖子 -> 结构化岗位学习路线 JSON。
// 不读取 PDF / 不接入 RAG / 不生成最终学习计划。
// 输出为下一阶段「RAG 匹配 PDF + 生成学习计划」准备结构化知识骨架。
import { callQwen as _realCallQwen } from './plan.mjs';

// 内部 LLM 调用引用（默认真实千问；测试时可被覆盖，对生产无影响）
let _callQwen = _realCallQwen;
export function __setLLMForTest(fn) { _callQwen = fn; }

// ---------- 提示词模板 ----------
// 单篇解析 + 多帖融合（高频共识 / 学习顺序共识 / 差异路线）。
const SYSTEM_PROMPT = `你是一名资深学习路径架构师。用户输入「目标岗位」和多篇来自小红书的学习路线笔记（含正文与图片转文字 OCR 内容）。
你的任务：对每篇笔记分别解析，再把多篇路线融合，输出严格 JSON。

【单篇解析】从每篇提取：学习阶段(stages)、技能点(skills)、知识模块(modules)、学习顺序(order)、推荐资源(resources)、时间周期(duration)、项目要求(projects)。

【多帖融合】
1) 高频共识技能 core_skills：统计每篇出现频次 frequency（共 N 篇，最高 N 表示全部共识）；importance 用 high/mid/low。不要只选某一篇作为答案，要跨篇归纳。
2) 学习顺序共识 skill_dependencies：若多篇顺序一致，给出有向依赖 from->to，并给出 confidence（high/mid/low）。
3) 差异路线 alternative_paths：若多篇路线明显不同（如「数学优先」vs「项目优先」），保留为备选路径。

【输出格式】只输出如下 JSON（不要任何解释、不要 markdown 代码块）：
{
  "job": "岗位名称",
  "summary": "跨多篇路线融合后的整体学习路线概述（2-4 句）",
  "core_skills": [
    { "skill": "技能名", "frequency": 3, "importance": "high" }
  ],
  "learning_path": [
    { "phase": 1, "name": "阶段名", "goal": "阶段目标", "skills": ["技能"] }
  ],
  "skill_dependencies": [
    { "from": "前置技能", "to": "后继技能", "confidence": "high" }
  ],
  "resources": [
    { "name": "资源名", "type": "书/课/网站/项目", "note": "说明" }
  ],
  "alternative_paths": [
    { "title": "路线标题", "description": "差异路线描述" }
  ],
  "source_analysis": [
    { "post_index": 1, "stages": ["阶段"], "key_skills": ["技能"], "duration": "周期", "note": "该帖要点" }
  ]
}`;

// 无小红书素材时的兜底提示词：仅凭岗位让 LLM 给出通用技能骨架。
// 注意：这里依然只产出「技能与顺序」，绝不产出 PDF / 视频等资源，资源一律由代码检索。
const JOB_ONLY_SYSTEM_PROMPT = `你是一名资深学习路径架构师。用户只提供「目标岗位」，没有参考笔记。
请基于行业通行认知，输出该岗位的核心技能与学习顺序。

【要求】
1. core_skills 给出 6-10 个该岗位真正必需的技能，importance 用 high/mid/low，frequency 统一填 1。
2. skill_dependencies 给出技能之间的先后依赖（from 必须先于 to）。
3. learning_path 给出 3-5 个阶段。
4. 严禁编造具体书名、课程名、PDF 文件名或网址，resources 一律返回空数组 []。

【输出格式】只输出 JSON（不要解释、不要 markdown 代码块）：
{
  "job": "岗位名称",
  "summary": "整体学习路线概述（2-4 句）",
  "core_skills": [{ "skill": "技能名", "frequency": 1, "importance": "high" }],
  "learning_path": [{ "phase": 1, "name": "阶段名", "goal": "阶段目标", "skills": ["技能"] }],
  "skill_dependencies": [{ "from": "前置技能", "to": "后继技能", "confidence": "high" }],
  "resources": [],
  "alternative_paths": [],
  "source_analysis": []
}`;

// 仅凭岗位抽取技能树（小红书不可用/无结果时的降级入口）
export async function analyzeRouteByJobOnly(job) {
  const target = String(job || '').trim();
  if (!target) {
    const err = new Error('岗位不能为空');
    err.code = 'EMPTY_JOB';
    throw err;
  }
  const raw = await _callQwen(JOB_ONLY_SYSTEM_PROMPT, `目标岗位：${target}\n\n请严格按系统指令输出 JSON。`);
  const route = parseJsonLoose(raw);
  route.job = route.job || target;
  route.core_skills = Array.isArray(route.core_skills) ? route.core_skills : [];
  route.learning_path = Array.isArray(route.learning_path) ? route.learning_path : [];
  route.skill_dependencies = Array.isArray(route.skill_dependencies) ? route.skill_dependencies : [];
  route.resources = [];
  route.alternative_paths = route.alternative_paths || [];
  route.source_analysis = route.source_analysis || [];
  route._source = 'job_only';
  return route;
}

function buildUserPrompt(job, posts) {
  const parts = [];
  parts.push(`目标岗位：${job || '未指定'}`);
  parts.push(`共 ${posts.length} 篇小红书学习路线笔记，逐篇原文如下（正文 + 图片转文字）：\n`);
  posts.forEach((p, i) => {
    const content = (p.content || p.desc || p.description || '').trim();
    const ocr = (p.ocrText || p.ocr || '').trim();
    parts.push(`【笔记 ${i + 1}】`);
    parts.push(`正文：\n${content || '(无)'}`);
    if (ocr) parts.push(`图片转文字：\n${ocr}`);
    parts.push('');
  });
  parts.push('请严格按系统指令输出 JSON。');
  return parts.join('\n');
}

// 容错：从模型输出中剥离可能的 ```json 代码块并解析
function parseJsonLoose(text) {
  if (!text) throw new Error('模型返回为空');
  let t = String(text).trim();
  // 去掉 ```json ... ``` 包裹
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  // 截取首个 { 到末尾最后一个 }
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  if (s === -1 || e === -1 || e < s) throw new Error('未找到 JSON 对象');
  const jsonStr = t.slice(s, e + 1);
  return JSON.parse(jsonStr);
}

// 兜底：当模型调用/解析失败时，基于规则生成一个最小结构，保证接口仍有可用输出
function buildFallback(job, posts) {
  return {
    job: job || '',
    summary: '（模型暂不可用，已基于输入帖子的原始文本生成占位结构，请用正常接口重试）',
    core_skills: [],
    learning_path: posts.map((p, i) => ({
      phase: i + 1,
      name: `笔记${i + 1}路线`,
      goal: '原始帖子路线（未融合）',
      skills: [],
    })),
    skill_dependencies: [],
    resources: [],
    alternative_paths: [],
    source_analysis: posts.map((p, i) => ({
      post_index: i + 1,
      stages: [],
      key_skills: [],
      duration: '',
      note: (p.content || p.desc || '').slice(0, 200),
    })),
    _fallback: true,
  };
}

// ---------- 主入口 ----------
// 输入：posts: [{content, ocrText, ...}]，job: string
// 输出：结构化 JSON 学习路线
export async function analyzeLearningRoutes(posts, job) {
  // 错误处理 1：帖子为空
  if (!Array.isArray(posts) || posts.length === 0) {
    const err = new Error('posts 为空：至少需要一篇小红书帖子');
    err.code = 'EMPTY_POSTS';
    throw err;
  }
  const cleaned = posts.map((p) => ({
    content: (p.content || p.desc || p.description || '').trim(),
    ocrText: (p.ocrText || p.ocr || '').trim(),
  }));

  const user = buildUserPrompt(job, cleaned);
  let raw;
  try {
    raw = await _callQwen(SYSTEM_PROMPT, user); // 复用千问封装（默认 json_object 模式）
  } catch (e) {
    // 错误处理 2：大模型调用失败
    const err = new Error('大模型调用失败: ' + e.message);
    err.code = 'LLM_FAILED';
    throw err;
  }

  let data;
  try {
    data = parseJsonLoose(raw);
  } catch (e) {
    // 错误处理 3：JSON 解析失败 -> 兜底结构（仍可返回，标注 _fallback）
    console.warn('[learningRouteAnalyzer] JSON 解析失败，使用兜底结构:', e.message);
    data = buildFallback(job, cleaned);
    data._parseError = e.message;
  }

  // 字段补全，保证前端/下游拿到稳定结构
  data.job = data.job || job || '';
  data.summary = data.summary || '';
  data.core_skills = Array.isArray(data.core_skills) ? data.core_skills : [];
  data.learning_path = Array.isArray(data.learning_path) ? data.learning_path : [];
  data.skill_dependencies = Array.isArray(data.skill_dependencies) ? data.skill_dependencies : [];
  data.resources = Array.isArray(data.resources) ? data.resources : [];
  data.alternative_paths = Array.isArray(data.alternative_paths) ? data.alternative_paths : [];
  data.source_analysis = Array.isArray(data.source_analysis) ? data.source_analysis : [];
  return data;
}
