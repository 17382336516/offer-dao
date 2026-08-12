// 技能资源匹配服务（skillResourceMatcher）
// 阶段目标：标准技能列表 -> 真实 PDF 资源 + 真实 B站视频资源。
//
// 【核心约束】本模块完全不调用 LLM。
// 所有资源都由代码从真实系统检索得到：
//   - PDF   来自本地 RAG 知识库（rag.retrieveWithFilters，带 skill/category/level 过滤）
//   - 视频  来自 B站搜索接口（plan.mjs 的 searchBilibiliVideos）
// LLM 后续只能"引用"本模块产出的资源 id，不允许编造 title / docId / link。
import * as rag from './rag.mjs';
import { searchBilibiliVideos } from './plan.mjs';

// P0：AI 领域硬过滤正则（模块级，供 matchVideoResources 等函数复用）
const AI_DOMAIN_RE = /(AI|人工智能|大模型|LLM|GPT|AIGC|Agent|智能体|RAG|Prompt|提示词|知识库|Dify|Coze|LangChain|Workflow|工作流|ChatGPT|Claude|GPT-4|文心一言|通义千问|多模态|扩散模型|Transformer|向量数据库|Embedding|微调|MCP)/i;

// P1：AI 产品经理岗位匹配评分（模块级，供 matchPdfResources / matchVideoResources 复用）
const JOB_FIT_PRODUCT_RE = /(产品|产品设计|AI应用|应用落地|业务场景|用户场景|案例|工作流|企业应用|落地|需求|方案设计|PRD|商业化|产品设计方法|产品架构|产品经|需求分析|需求拆解|用户研究|用户洞察|功能设计|项目|协作|产品经理)/i;
const JOB_FIT_ENGINEER_RE = /(源码|代码实现|手撕|手写|从零实现|训练|算法原理|论文|部署|CUDA|PyTorch|TensorFlow|微调|模型训练|底层原理|底层实现|原理推导|推导|公式推导|并发|分布式|后端架构|前端框架|源码解析|debug|调参|GPU|显卡)/i;
const scoreJobFit = (title = '', desc = '') => {
  const text = `${title}\n${desc || ''}`;
  let s = 0.5; // 中性基线
  if (JOB_FIT_PRODUCT_RE.test(text)) s += 0.35; // 产品/应用方向加权
  if (JOB_FIT_ENGINEER_RE.test(text)) s -= 0.35; // 工程/算法方向减权
  return Math.max(0, Math.min(1, s));
};

// 从标准技能树中取出技能列表，统一为 { name, category, level, aliases, weight }
export function extractStandardSkills(skillTree) {
  const skills = Array.isArray(skillTree?.skills) ? skillTree.skills : [];
  return skills
    .map((s) => ({
      name: String(s?.standard_name || s?.name || '').trim(),
      category: String(s?.category || '').trim(),
      level: String(s?.level || '').trim(),
      aliases: Array.isArray(s?.aliases) ? s.aliases.filter(Boolean).map(String) : [],
      weight: typeof s?.weight === 'number' ? s.weight : 0.1,
    }))
    .filter((s) => s.name);
}

// ---------- PDF 匹配 ----------
// 对每个标准技能做一次带过滤的 RAG 检索，把命中的 chunk 按 docId 聚合成「一本 PDF」。
// 返回的每条资源都带真实 docId，前端可直接用 /api/rag/file?docId=xxx 打开原始 PDF。
export async function matchPdfResources(skills, { perSkillTopK = 4, job = '' } = {}) {
  const byDoc = new Map(); // docId -> resource
  const skillHits = {};    // 标准技能名 -> [docId]

  const termMap = {
    'LLM基础概念': ['LLM', '大语言模型', '大模型基础', 'Transformer', 'ChatGPT'],
    '大模型能力边界': ['能力边界', '模型能力', '幻觉', '上下文窗口', '大模型'],
    'Prompt工程': ['Prompt', '提示词', '提示工程'],
    'AI产品基础认知': ['AI产品经理', 'AI产品', '人工智能产品', '产品经理'],
    'AI需求分析': ['AI需求', '需求分析', '需求拆解', '用户需求'],
    'AI产品设计方法': ['AI产品设计', '产品设计', 'AI产品方法'],
    '用户场景分析': ['用户场景', '场景分析', '用户研究', '用户洞察'],
    'AI功能设计': ['AI功能', '功能设计', '产品功能', '功能拆解'],
    'Prompt效果评估': ['Prompt评估', 'Prompt效果', '提示词评测'],
    'RAG评估': ['RAG评估', 'RAG评测', '检索评估', '知识库评估'],
    '模型效果指标': ['模型效果', '模型指标', '效果评估', '准确率', '召回率'],
    '用户反馈闭环': ['用户反馈', '反馈闭环', '效果闭环', 'AB实验'],
    'RAG': ['RAG', '检索增强生成', '企业知识库', '向量数据库'],
    'Agent': ['Agent', '智能体'],
    'Workflow': ['Workflow', '工作流', '智能体工作流'],
    'AI应用架构': ['AI应用架构', '应用架构', 'RAG架构', 'Agent架构'],
    'AI PRD设计': ['AI PRD', 'PRD', '产品需求文档'],
    'AI项目管理': ['AI项目', '项目管理', '项目推进'],
    '技术团队协作': ['研发协作', '跨团队协作', '技术沟通'],
    '商业化应用': ['AI商业化', '业务落地', '产品商业化'],
  };

  // ---------- P0：AI 领域硬过滤 ----------
  // 视频进入评分前，标题/简介必须至少命中一个 AI 领域关键词，否则直接过滤。
  // 目的：杜绝「Windows入门/办公教程/普通电脑教程」等无关普通教程混入 AI 方向。
  // 注意：不依赖「教程/入门/基础」等通用词（它们太泛，会导致普通教程进入）。
  // AI_DOMAIN_RE / JOB_FIT_* / scoreJobFit 已提升为模块级常量（见文件顶部），此处不再重复定义。

  const termsFor = (skill) => [...new Set([skill.name, ...(skill.aliases || []), ...(termMap[skill.name] || [])])];
  const clamp = (n) => Math.max(0, Math.min(1, Number(n) || 0));
  const scorePdf = (hit, skill) => {
    const terms = termsFor(skill).map((x) => String(x).toLowerCase()).filter(Boolean);
    const text = `${hit.title || ''}\n${hit.file || ''}\n${hit.content || ''}`.toLowerCase();
    const metaSkills = Array.isArray(hit?.meta?.skills) ? hit.meta.skills.map((x) => String(x).toLowerCase()) : [];
    const skillMatch = metaSkills.some((x) => terms.some((t) => x === t || x.includes(t) || t.includes(x)))
      ? 1
      : terms.some((t) => text.includes(t)) ? 0.82 : clamp(hit.score) * 0.65;
    const category = String(hit?.meta?.category || '').toLowerCase();
    const categoryMatch = category === String(skill.category || '').toLowerCase()
      || (skill.category === 'pm' && category === 'product')
      || (skill.category === 'llm' && ['ml', 'dl'].includes(category))
      ? 1 : category ? 0.35 : 0.55;
    const level = String(hit?.meta?.level || '').toLowerCase();
    const levelMatch = !level ? 0.65 : level === skill.level ? 1 : (skill.level === 'intermediate' && level === 'beginner' ? 0.82 : 0.55);
    const aiTerms = /(ai|人工智能|大模型|llm|prompt|rag|agent|智能体)/i;
    const productTerms = /(产品经理|产品设计|prd|需求|场景|用户|应用|落地|商业化|企业知识库|知识库)/i;
    // 纯底层/算法论文负向词：纯模型训练、底层优化等偏离 AI 产品经理定位，降权
    const pureAlgoTerms = /(训练代码|反向传播|模型蒸馏|cuda 编程|底层实现|数学推导|论文复现|源码逐行)/i;
    const isAiPmJob = /ai\s*产品|人工智能\s*产品|大模型\s*产品|产品\s*经理.*ai/i.test(job);
    const jobMatch = isAiPmJob
      ? (aiTerms.test(text) && productTerms.test(text)
          ? (pureAlgoTerms.test(text) ? 0.7 : 1) // 含产品应用且非纯算法 -> 满分；含产品但偏底层 -> 降
          : aiTerms.test(text) ? (pureAlgoTerms.test(text) ? 0.4 : 0.78) // 仅 AI 技术，纯算法更低
          : productTerms.test(text) ? 0.62 : 0.2)
      : 0.7;
    const semantic = clamp(Number(hit.score) > 1 ? Number(hit.score) / 1.5 : hit.score);
    const finalScore = 0.4 * skillMatch + 0.2 * categoryMatch + 0.1 * levelMatch + 0.2 * jobMatch + 0.1 * semantic;
    return {
      skill_match: Number(skillMatch.toFixed(3)),
      category_match: Number(categoryMatch.toFixed(3)),
      level_match: Number(levelMatch.toFixed(3)),
      job_match: Number(jobMatch.toFixed(3)),
      final_score: Number(finalScore.toFixed(3)),
    };
  };

  for (const skill of skills) {
    // 查询串【不带岗位名】（岗位只用于排序），优先用「技能 -> 学习意图」product 档（产品应用）
    // 再补技能名/别名，提升与 AI 产品经理学习场景的召回，同时降低纯算法论文权重。
    const intent = AI_PM_SKILL_INTENT[skill.name];
    const productTerms = intent ? (intent.product || []) : [];
    const query = [...productTerms, skill.name, ...(skill.aliases || [])].filter(Boolean).slice(0, 6).join(' ');
    let hits = [];
    try {
      // 不再把 category 当硬过滤条件：历史文档使用 llm/pm/ml 等多套类目，
      // 先召回真实 file 文档，再由统一评分同时判断 skill/category/level/job。
      hits = await rag.retrieveWithFilters(query, { topK: Math.max(12, perSkillTopK * 3), source: 'file', skill: skill.name, level: skill.level });
      if (!hits.length) hits = await rag.retrieve(query, { topK: Math.max(12, perSkillTopK * 3), source: 'file' });
    } catch (e) {
      console.warn('[skillResourceMatcher] RAG 检索失败 skill=%s: %s', skill.name, e.message);
      continue;
    }
    skillHits[skill.name] = [];

    for (const h of hits) {
      const docId = h?.docId || '';
      if (!docId) continue; // 没有真实 docId 的结果一律丢弃，杜绝假资源
      const relevance = scorePdf(h, skill);
      // 资源进入计划的唯一门槛；低于门槛的纯语义近邻不再冒充岗位资源。
      if (relevance.final_score <= 0.7) continue;
      if (!byDoc.has(docId)) {
        // 补一次首块元数据，拿到更可靠的文件名/相对路径
        let meta = {};
        try { meta = rag.getFirstChunkMeta(docId) || {}; } catch { meta = {}; }
        const file = h.file || meta.file || meta.fileName || meta.relativePath || '';
        // 取纯文件名（兼容 Windows/Unix 路径），用于文件类资源的标题展示
        const fileBase = String(file || '').split(/[\\/]/).pop();
        // 文件类资源（PDF/MD 等）一律以文件名作为标题，避免 chunk 的脏标题（如章节目录串）污染展示。
        // 无文件名时才回退到 h.title，再兜底「知识库文档」。
        const isFileRes = h.source === 'file' || /\.(pdf|md|txt|docx?|pptx?|epub)$/i.test(fileBase);
        const titleForRes = isFileRes
          ? (fileBase.replace(/\.[^.]+$/, '') || '知识库文档')
          : String(h.title || fileBase || '知识库文档').replace(/\.[^.]+$/, '');
        byDoc.set(docId, {
          id: docId,                       // 供 LLM 引用的唯一 id，即真实 docId
          docId,
          title: titleForRes,
          file,
          // 真实可访问链接（后端已实现该接口，返回原始 PDF）
          link: `/api/rag/file?docId=${encodeURIComponent(docId)}`,
          chapters: [],
          skills: [],
          category: h?.meta?.category || skill.category || '',
          level: h?.meta?.level || skill.level || '',
          score: Number(h.score) || 0,
          relevance_score: relevance.final_score,
          relevance,
          reason: `覆盖${skill.name}相关内容，类目/难度与${job || '目标岗位'}匹配`,
        });
      }
      const doc = byDoc.get(docId);
      if (Number(h.score) > doc.score) doc.score = Number(h.score);
      if (relevance.final_score > doc.relevance_score) {
        doc.relevance_score = relevance.final_score;
        doc.relevance = relevance;
      }
      const chapter = String(h.chapter || h?.meta?.chapter || '').trim();
      if (chapter && !doc.chapters.includes(chapter)) doc.chapters.push(chapter);
      if (!doc.skills.includes(skill.name)) doc.skills.push(skill.name);
      if (!skillHits[skill.name].includes(docId)) skillHits[skill.name].push(docId);
    }
  }

  const resources = [...byDoc.values()].sort((a, b) => b.score - a.score);
  return { resources, skillHits };
}

// ---------- 岗位搜索词转换层（仅用于 B站搜索，不影响用户展示/学习计划/技能树/PDF） ----------
// 目的：解决岗位名称直接用于 B站搜索产生的歧义，例如「C端产品经理」被 B站误理解为「C语言」。
// 规则：
//   1. 用户看到的岗位名称、学习计划 job 字段、技能树、PDF 匹配、真实 B站搜索接口均不变。
//   2. 仅在「B站搜索关键词生成」阶段对 job 做一次映射替换。
//   3. 不调用任何 LLM。
//   4. 未在表中出现的岗位：原样返回（保持向后兼容）。
const BILI_JOB_KEYWORD_MAP = {
  // 口语名（带「经理」）与系统存储的显示名（如方向字典的「C端产品」）都做映射，确保转换层真正命中
  'AI产品经理': 'AI产品经理',
  'AI产品': 'AI产品经理',
  'B端产品经理': '企业级产品经理 B端产品经理',
  'B端产品': '企业级产品经理 B端产品经理',
  // 关键：避免「C端」被 B站误判为「C语言」
  'C端产品经理': '互联网C端产品经理',
  'C端产品': '互联网C端产品经理',
  '增长产品经理': '用户增长产品经理 增长策略',
  '增长产品': '用户增长产品经理 增长策略',
  '数据产品经理': '数据产品经理 数据分析产品',
  '数据产品': '数据产品经理 数据分析产品',
  '策略产品经理': '策略产品经理 商业策略',
  '策略产品': '策略产品经理 商业策略',
};

// ---------- B站学习场景词（搜索词生成用） ----------
// 真实用户在 B站搜索一个技能时，几乎总会带上「学习场景词」，
// 例如搜的是「RAG教程」而不是「RAG产品设计」。
// 本表是搜索词的构造规则依据：技能核心词 + 学习场景词（见 buildBiliKeywords 回退分支）。
export const BILI_LEARN_SCENE = ['教程', '入门', '实战', '完整教程', '从0到1', '案例', '项目实战', '原理解析'];
// JD / 岗位语言黑名单：这类词是「岗位描述」不是「用户搜索词」，禁止出现在 B站搜索词里。
// 注意：只拦「纯 JD 短语」——若同一条词里已带学习场景词（教程/实战/案例…），
// 说明它是真实课程标题用语（如「AI产品设计教程」），不算 JD 语言。
const JD_STYLE_PATTERN = /(产品认知|产品需求|产品功能|产品场景|产品基础|产品局限|产品边界|产品风险|产品指标|产品运营|产品变现|产品项目管控|产品落地协作|跨团队协作|产品技术对齐|方法论|产品化|智能产品|模型产品)/;
// 判定一条搜索词是否「像真实用户搜索词」：带学习场景词，或本身就是自然口语提问/术语。
const NATURAL_QUERY_PATTERN = /(教程|入门|实战|案例|从0到1|原理|解析|讲解|是什么|怎么写|怎么测|怎么做|搭建|科普|技巧|优化|开发|精通|评测|测试|榜单|复盘|调优|调研|拆解|分析|文档|对比|选型|接口|调用|变现|落地|迭代|实验|工作流|指标|幻觉|边界)/;
// 供测试/自检使用：校验单条 B站搜索词是否合规（不含岗位名、不是纯 JD 语言、像真实搜索）。
export function isNaturalBiliQuery(keyword = '') {
  const kw = String(keyword || '').trim();
  if (!kw) return false;
  if (/产品经理|岗位|招聘|JD/i.test(kw)) return false;      // 岗位词绝不进搜索
  if (JD_STYLE_PATTERN.test(kw) && !NATURAL_QUERY_PATTERN.test(kw)) return false;
  return NATURAL_QUERY_PATTERN.test(kw);
}

// AI 产品经理「技能 -> 学习意图」搜索词表（零 LLM，纯静态）。
// 设计原则：每一条都必须是【一个准备学这个技能的人真的会在 B站输入的词】，
// 而不是「技能名称的翻译」或「岗位 JD 用语」。
//   - basic    : 基础理解 —— 「XX是什么 / XX原理 / XX入门教程」
//   - product  : 产品应用 —— 「XX搭建教程 / XX应用 / 具体工具名教程（Dify/Coze）」
//   - practice : 项目实践 —— 「XX实战 / XX从0到1 / XX项目实战 / 框架名教程」
// 岗位词不进入搜索词，只用于后续排序权重（见 matchVideoResources / scoreJobFit）。
const AI_PM_SKILL_INTENT = {
  'LLM基础概念': {
    basic: ['大模型入门教程', 'LLM原理讲解', '大语言模型是什么'],
    product: ['大模型应用教程', 'ChatGPT使用教程'],
    practice: ['大模型API调用实战', 'OpenAI接口教程'],
  },
  '大模型能力边界': {
    basic: ['大模型原理解析', '大模型幻觉', '大模型能力边界'],
    product: ['大模型对比评测', '大模型选型教程'],
    practice: ['大模型评测实战', '大模型能力测试'],
  },
  'Prompt工程': {
    basic: ['Prompt工程教程', '提示词技巧', 'ChatGPT提示词教程'],
    product: ['提示词工程实战', '提示词案例'],
    practice: ['Prompt优化实战', '提示词从入门到精通'],
  },
  'AI产品基础认知': {
    basic: ['AI产品入门教程', '大模型应用科普', 'AI应用是什么'],
    product: ['AI产品案例解析', 'AI应用案例'],
    practice: ['AI产品从0到1', 'AI应用开发实战'],
  },
  'AI需求分析': {
    basic: ['需求分析教程', 'AI场景分析', '需求拆解方法'],
    product: ['AI应用场景案例', 'AI落地场景解析'],
    practice: ['需求分析实战', 'AI需求调研案例'],
  },
  'AI产品设计方法': {
    basic: ['AI产品设计教程', '大模型应用设计教程', 'AI交互设计入门'],
    product: ['AI产品案例拆解', 'AI应用设计案例'],
    practice: ['AI产品设计实战', 'AI原型设计教程'],
  },
  '用户场景分析': {
    basic: ['用户场景分析教程', '用户研究入门', '用户调研方法'],
    product: ['用户场景案例', 'AI应用场景分析'],
    practice: ['用户研究实战', '场景分析案例'],
  },
  'AI功能设计': {
    basic: ['AI功能设计教程', 'AI功能拆解', 'AI交互设计入门'],
    product: ['AI功能案例解析', 'AI应用功能拆解'],
    practice: ['AI功能开发实战', 'AI功能设计案例'],
  },
  'AI PRD设计': {
    basic: ['PRD编写教程', 'AI PRD怎么写', '产品文档入门'],
    product: ['PRD案例解析', 'AI项目文档案例'],
    practice: ['PRD撰写实战', 'PRD从0到1'],
  },
  'Prompt效果评估': {
    basic: ['Prompt评估教程', '提示词评测', 'Prompt效果分析'],
    product: ['提示词优化案例', 'Prompt调优教程'],
    practice: ['Prompt优化实战', '提示词评测实战'],
  },
  'RAG评估': {
    basic: ['RAG评测教程', 'RAG评估指标', 'RAG效果怎么测'],
    product: ['知识库问答评测', 'RAG调优案例'],
    practice: ['RAG评测实战', 'RAG效果优化实战'],
  },
  '模型效果指标': {
    basic: ['模型评估指标讲解', '大模型评测教程', '准确率召回率讲解'],
    product: ['大模型评测榜单解析', '模型效果对比'],
    practice: ['模型评测实战', '模型指标计算教程'],
  },
  '用户反馈闭环': {
    basic: ['用户反馈分析教程', 'AB测试入门', '数据闭环讲解'],
    product: ['产品迭代案例', 'AB实验案例'],
    practice: ['用户反馈分析实战', 'AB测试实战'],
  },
  'RAG': {
    basic: ['RAG入门教程', 'RAG原理', '检索增强生成讲解'],
    product: ['企业知识库搭建教程', 'Dify知识库教程', 'AI知识库搭建'],
    practice: ['RAG从0到1实战', 'LangChain RAG教程', '向量数据库实战'],
  },
  'Agent': {
    basic: ['AI Agent教程', '智能体入门', 'AI Agent是什么'],
    product: ['Agent工作流', 'Coze智能体教程', '智能助手搭建'],
    practice: ['AI Agent实战', 'LangGraph教程', '智能体开发实战'],
  },
  'Workflow': {
    basic: ['AI工作流教程', '工作流入门', 'Workflow原理解析'],
    product: ['Coze工作流教程', 'Dify工作流教程', 'n8n教程'],
    practice: ['AI工作流实战', 'Agent工作流搭建实战'],
  },
  'AI应用架构': {
    basic: ['AI应用架构讲解', 'RAG架构解析', 'Agent架构原理'],
    product: ['大模型应用架构教程', 'AI系统设计案例'],
    practice: ['RAG系统搭建实战', 'AI应用架构实战'],
  },
  '企业知识库': {
    basic: ['企业知识库教程', '知识库入门', '知识库原理解析'],
    product: ['企业知识库搭建教程', 'Dify知识库教程', 'AI知识库实战'],
    practice: ['知识库项目实战', '知识库从0到1搭建'],
  },
  'AI产品项目管理': {
    basic: ['项目管理入门教程', 'AI项目管理讲解', '敏捷开发入门'],
    product: ['AI项目落地案例', 'AI项目复盘'],
    practice: ['AI项目实战', 'AI产品从0到1'],
  },
  '技术团队协作': {
    basic: ['产品与研发协作教程', '技术沟通入门', '需求评审讲解'],
    product: ['研发协作案例', '产品技术协作复盘'],
    practice: ['敏捷开发实战', '团队协作实战'],
  },
  '商业化应用': {
    basic: ['AI商业化讲解', 'AI变现教程', 'AI创业入门'],
    product: ['AI商业案例解析', 'AI落地案例'],
    practice: ['AI商业化实战', 'AI项目变现实战'],
  },
};

// ---------- B站标题习惯词库（平台语言差异层） ----------
// 不同平台的标题用语不同，不能共用一套词：
//   - 小红书：负责「最近需要学什么」，标题多为 技能要求 / 面试 / 学习路线 / 避坑；
//   - B站  ：负责「这个技能怎么学」，标题多为 教程 / 入门 / 实战 / 从0到1 / 原理解析。
// 本词库【只用于 B站视频排序打分】，不参与搜索词生成，也不影响小红书链路。
export const BILI_TITLE_HABIT = {
  // 系统性教学（最高价值：能撑起一个完整学习任务）
  course: ['完整教程', '系统课', '系列教程', '全套教程', '保姆级', '手把手', '从0到1', '从零到一', '从零开始', '入门到精通'],
  // 教学型（有明确讲授结构）
  teach: ['教程', '入门', '讲解', '原理解析', '解析', '精讲', '详解', '课程', '公开课笔记', '学习'],
  // 实践型（对产品经理理解落地最有用）
  practice: ['实战', '项目实战', '搭建', '落地', '案例', '复现', 'demo', '踩坑实录'],
  // 反向：非学习内容（资讯/营销/碎片）
  negative: ['峰会', '发布会', '大会', '行业论坛', '圆桌', '宣传片', '广告', '招商', '路演', '速览', '新闻', '资讯', '盘点', '吐槽'],
};
const BILI_HABIT_RE = {
  course: new RegExp(BILI_TITLE_HABIT.course.join('|'), 'i'),
  teach: new RegExp(BILI_TITLE_HABIT.teach.join('|'), 'i'),
  practice: new RegExp(BILI_TITLE_HABIT.practice.join('|'), 'i'),
  negative: new RegExp(BILI_TITLE_HABIT.negative.join('|'), 'i'),
};

// ---------- 岗位偏好排序层（岗位词不进搜索，只进排序） ----------
// 同一批搜索结果，不同岗位应该有不同的排序偏好。例如搜「Agent实战」返回：
//   A《AI Agent智能体应用开发》 B《Agent源码解析》 C《AI Agent产品设计案例》
//   -> AI产品经理：C 加分（产品/场景/落地）；算法岗：B 加分（源码/原理/训练）。
const JOB_RANK_PREFERENCE = [
  {
    // AI 产品经理 / 大模型产品：偏好产品设计、场景、落地、商业化
    match: /ai\s*产品|人工智能\s*产品|大模型\s*产品|产品\s*经理.*ai/i,
    prefer: /(产品|需求|场景|设计|应用|落地|业务|商业|案例|方案|prd|体验|用户)/i,
    avoid: /(源码|论文|推导|训练|微调|算子|cuda|部署优化|底层实现|数学)/i,
  },
  {
    // 算法 / 工程岗：偏好源码、原理、训练、部署
    match: /算法|工程师|开发|后端|研发|nlp|机器学习|深度学习/i,
    prefer: /(源码|原理|架构|实现|训练|微调|部署|代码|工程化)/i,
    avoid: /(商业化|运营|变现|职场|求职)/i,
  },
];
// 返回 0~1 的岗位契合度；无匹配偏好时返回中性 0.6，保证不伤害其它岗位。
function scoreJobPreference(title, job = '') {
  const rule = JOB_RANK_PREFERENCE.find((r) => r.match.test(String(job || '')));
  if (!rule) return 0.6;
  const t = String(title || '');
  if (rule.avoid.test(t) && !rule.prefer.test(t)) return 0.3;
  if (rule.prefer.test(t)) return 1;
  return 0.6;
}

// 把用户岗位名转换为 B站搜索友好的岗位词；未命中映射则原样返回。
export function normalizeBiliSearchJob(job = '') {
  const key = String(job || '').trim();
  if (!key) return '';
  return BILI_JOB_KEYWORD_MAP[key] || key;
}

// ---------- 岗位搜索词转换层（仅用于小红书搜索，独立于 B站） ----------
// 目的：与 B站 同样解决岗位名直接搜索产生的歧义（如「C端」被误判为「C语言」）。
// 规则：
//   1. 用户看到的岗位名称、学习计划 job 字段、技能树、PDF 匹配、真实小红书接口均不变。
//   2. 仅在「小红书搜索关键词生成」阶段对 job 做一次映射替换。
//   3. 不调用任何 LLM。
//   4. 未在表中出现的岗位：原样返回（保持向后兼容）。
// 初始值与 B站 映射一致；未来若小红书需要不同口径，可在此表单独调整，不影响 B站。
const XHS_JOB_KEYWORD_MAP = {
  'AI产品经理': 'AI产品经理',
  'AI产品': 'AI产品经理',
  'B端产品经理': '企业级产品经理 B端产品经理',
  'B端产品': '企业级产品经理 B端产品经理',
  // 关键：避免「C端」被小红书误判为「C语言」
  'C端产品经理': '互联网C端产品经理',
  'C端产品': '互联网C端产品经理',
  '增长产品经理': '用户增长产品经理 增长策略',
  '增长产品': '用户增长产品经理 增长策略',
  '数据产品经理': '数据产品经理 数据分析产品',
  '数据产品': '数据产品经理 数据分析产品',
  '策略产品经理': '策略产品经理 商业策略',
  '策略产品': '策略产品经理 商业策略',
};

// 把用户岗位名转换为小红书搜索友好的岗位词；未命中映射则原样返回。
export function normalizeXhsSearchJob(job = '') {
  const key = String(job || '').trim();
  if (!key) return '';
  return XHS_JOB_KEYWORD_MAP[key] || key;
}

// 生成 B站搜索关键词组（统一入口，对外保持 buildBiliKeywords 命名）。
// 输出结构：[{ keyword, intent }]，intent ∈ 'basic' | 'product' | 'practice'。
// 关键改动：搜索词【不含岗位名称】（岗位只用于后续排序），直接来自「技能 -> 学习意图」词表，
// 贴近 B站真实上传/搜索习惯（如「企业知识库搭建」「RAG原理」而非「AI产品经理 RAG产品设计」）。
// 当技能缺失意图表时，回退到技能名本身 + 类目场景（仍不拼岗位词），避免搜空。
export function buildBiliKeywords(skill, job = '') {
  const intent = AI_PM_SKILL_INTENT[skill.name];
  if (intent) {
    const out = [];
    for (const it of ['basic', 'product', 'practice']) {
      for (const kw of (intent[it] || [])) out.push({ keyword: kw, intent: it });
    }
    if (out.length) return out;
  }
  // 回退：技能不在意图表时，用「技能核心词 + B站学习场景词」构造真实搜索词，
  // 而不是「技能名 + 类目场景」这种名称翻译（如「RAG评估 大模型应用」没人会这么搜）。
  const core = String(skill.name || '').trim();
  if (!core) return [];
  return [
    { keyword: `${core}教程`, intent: 'basic' },
    { keyword: `${core}入门`, intent: 'basic' },
    { keyword: `${core}实战`, intent: 'practice' },
  ];
}

// 保留旧单关键词函数用于向后兼容（小红书等其它调用方），新版 B站主流程已不使用。
export function buildBiliKeyword(skill, job = '') {
  const first = buildBiliKeywords(skill, job)[0];
  return first ? first.keyword : String(skill.name || '');
}

// =====================================================================
// 小红书趋势关键词扩展层（纯函数，无 DB / 无 LLM）
// ---------------------------------------------------------------------
// 设计约束（来自产品需求）：
//   1) 小红书【不】改变固定 AI 产品经理技能体系，也【不】生成新学习阶段；
//   2) 小红书只负责「发现最近行业在讨论什么新工具 / 新表达」；
//   3) 趋势词【只】用于【补充】B站搜索词，固定词永远优先、不可被覆盖；
//   4) 第一版不做复杂模型：trendScore = 频次50% + 新鲜度30% + 技能匹配度20%。
// =====================================================================

// 新工具 / 新表达 -> 它们归属的固定技能。只有映射进现有技能的词才纳入，
// 避免出现「小红书发明了新技能」破坏学习体系完整性。
// 工具名覆盖常见中英文写法（含缩写 / 中文译名 / 平台别称）。
export const TOOL_TREND_MAP = {
  // --- 工作流 / 智能体搭建平台 ---
  'Coze': 'Agent', '扣子': 'Agent', 'Coze智能体': 'Agent', '扣子工作流': 'Agent',
  'Dify': 'Agent', 'Dify工作流': 'Agent', 'Dify智能体': 'Agent',
  'n8n': 'Workflow', 'N8N': 'Workflow', 'n8n工作流': 'Workflow',
  'LangChain': 'Agent', 'LangGraph': 'Agent', 'LlamaIndex': 'RAG', 'LlamaIndex': 'RAG',
  'AutoGPT': 'Agent', 'MetaGPT': 'Agent', 'Flowise': 'Workflow',
  'FastGPT': 'Agent', '百炼': 'Agent', '阿里云百炼': 'Agent',
  '飞书多维表': 'Workflow', '飞书工作流': 'Workflow',
  // --- 知识库 / RAG 相关新工具 ---
  'RAGFlow': 'RAG', 'ragflow': 'RAG', 'Dify知识库': '企业知识库', 'FastGPT知识库': '企业知识库',
  'MaxKB': '企业知识库', 'maxkb': '企业知识库', 'AnythingLLM': '企业知识库',
  'Cherry Studio': 'RAG', 'CherryStudio': 'RAG', 'Obsidian Copilot': 'RAG',
  // --- 大模型 / 产品工具 ---
  'DeepSeek': '大模型能力边界', 'deepseek': '大模型能力边界', 'DeepSeek应用': '商业化应用',
  '智谱': '大模型能力边界', 'GLM': '大模型能力边界', 'Kimi': '大模型能力边界',
  'Qwen': '大模型能力边界', '通义千问': '大模型能力边界', '豆包': '大模型能力边界',
  'Claude': '大模型能力边界', 'GPTs': 'AI产品基础认知', 'Coze GPTs': 'Agent',
  'Midjourney': '商业化应用', '可灵': '商业化应用', '即梦': '商业化应用',
  'Suno': '商业化应用', 'Runway': '商业化应用',
  // --- Prompt 工具 ---
  'PromptPerfect': 'Prompt工程', 'PromptHero': 'Prompt工程', '提示词工程工具': 'Prompt工程',
};

// 工具别名归一：同一工具的中英文/大小写写法归并到同一个规范词，避免重复提取
// （如 Coze=扣子、n8n=N8N、Dify=dify）。归一键用于聚合频次与产出 keyword。
const TOOL_ALIAS = {
  'coze': 'Coze', '扣子': 'Coze', 'coze智能体': 'Coze', '扣子工作流': 'Coze',
  'dify': 'Dify', 'dify工作流': 'Dify', 'dify智能体': 'Dify',
  'n8n': 'n8n', 'n8n工作流': 'n8n', 'N8N': 'n8n',
  'ragflow': 'RAGFlow',
  'maxkb': 'MaxKB',
  'deepseek': 'DeepSeek', 'deepseek应用': 'DeepSeek',
  'cherrystudio': 'Cherry Studio',
};
function normalizeTool(tool) {
  const k = String(tool || '').toLowerCase();
  return TOOL_ALIAS[k] || tool;
}

// 从一篇帖子文本里统计 TOOL_TREND_MAP 中每个工具的命中次数（大小写不敏感，
// 中文逐词匹配）。返回 Map<规范tool, count>（已做别名归一）。
function countToolMentions(text = '') {
  const lower = String(text || '').toLowerCase();
  const counts = new Map();
  for (const tool of Object.keys(TOOL_TREND_MAP)) {
    const t = tool.toLowerCase();
    let n = 0;
    if (/^[a-z0-9]/i.test(t)) {
      // 英文/数字工具名：用边界词匹配，避免 "n8n" 误中 "in8n..." 等
      const re = new RegExp(`(^|[^a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i');
      const m = lower.match(new RegExp(re.source, 'gi'));
      n = m ? m.length : 0;
    } else {
      // 中文：直接 includes 计数（出现几次算几次）
      let idx = lower.indexOf(t);
      while (idx !== -1) { n++; idx = lower.indexOf(t, idx + t.length); }
    }
    if (n > 0) {
      const norm = normalizeTool(tool);
      counts.set(norm, (counts.get(norm) || 0) + n);
    }
  }
  return counts;
}

// 小红书趋势词「最近时间窗口」：仅统计最近 30 天内的出现次数（recentCount 窗口）。
const XHS_RECENT_WINDOW_MS = 30 * 24 * 3600 * 1000;
// 趋势词若超过该天数未出现，整体 trendScore 衰减（降低历史沉睡词权重）。
const XHS_STALE_MS = 90 * 24 * 3600 * 1000;

// 从小红书帖子集合提取趋势关键词，并和历史累计结果合并。
//
// 累计规则（避免「本次没抓到帖子→趋势消失」）：
//   - totalCount：历史累计出现次数（只增不减，保留全部历史）
//   - recentCount：最近 30 天窗口出现次数（每次重算：按 lastSeen 是否落在窗口内）
//   - 本次帖子命中的关键词：totalCount += 本次次数，recentCount += 本次次数，lastSeen 刷新为今天
//   - 未命中的历史词：recentCount 按 lastSeen 是否落在 30 天内保留，否则归 0
//
// @param posts    [{ title, content, ocrText, link }]  实时小红书帖子
// @param skills   [{ name, category, aliases? }]        固定技能体系（匹配目标）
// @param history  [{ keyword, skill, total_count, recent_count, last_seen, relevance_score, source }]
//                 历史 xhs_trend_keywords 行（来自 DB），可选
// @returns 数组（含累计字段）：
//   { keyword, skill, totalCount, recentCount, lastSeen, relevanceScore, trendScore, source }
export function extractTrendKeywordsFromXhs(posts = [], skills = [], history = []) {
  const skillNames = new Set(skills.map((s) => String(s.name || '')));
  const now = Date.now();
  let today = new Date(now).toISOString().slice(0, 10);
  // 1）先灌入历史累计（recentCount 按 last_seen 衰减重算）
  const merged = new Map(); // normTool -> { total, recent, lastSeen, relevance }
  for (const h of (history || [])) {
    const normTool = normalizeTool(h.keyword);
    const lastSeenMs = h.last_seen ? new Date(h.last_seen).getTime() : 0;
    const inRecent = lastSeenMs && (now - lastSeenMs) <= XHS_RECENT_WINDOW_MS;
    merged.set(normTool, {
      total: Number(h.total_count) || 0,
      recent: inRecent ? (Number(h.recent_count) || 0) : 0,
      lastSeen: h.last_seen || today,
      relevance: Number(h.relevance_score) || 0.9,
    });
  }
  // 2）叠加本次实时帖子命中
  const todayIdx = 1e9; // 本次命中按「最新」处理
  (posts || []).forEach((p, idx) => {
    const text = [p?.title, p?.content, p?.ocrText].filter(Boolean).join('\n');
    if (!text) return;
    const counts = countToolMentions(text);
    for (const [tool, n] of counts) {
      const normTool = normalizeTool(tool);
      const cur = merged.get(normTool) || { total: 0, recent: 0, lastSeen: today, relevance: 0.9 };
      cur.total += n;
      cur.recent += n;
      cur.lastSeen = today;
      cur.relevance = Math.max(cur.relevance, 0.9);
      merged.set(normTool, cur);
    }
  });
  const out = [];
  for (const [tool, info] of merged) {
    const normTool = normalizeTool(tool);
    const skill = TOOL_TREND_MAP[normTool] || TOOL_TREND_MAP[tool];
    if (!skill || !skillNames.has(skill)) continue; // 未映射进固定体系则丢弃，绝不造新技能
    if (info.total < 1) continue;
    const totalCount = info.total;
    const recentCount = info.recent;
    // 历史频次归一（饱和 5 次）；近期频次归一（饱和 3 次，更看重近期）
    const freqNorm = Math.min(1, totalCount / 5);
    const recentNorm = Math.min(1, recentCount / 3);
    const relevanceScore = info.relevance || 0.9;
    // 沉睡惩罚：超过 90 天未出现，trendScore 线性衰减（最低 0.5 系数）
    const lastSeenMs = info.lastSeen ? new Date(info.lastSeen).getTime() : 0;
    const stale = lastSeenMs ? Math.max(0, (now - lastSeenMs) - XHS_RECENT_WINDOW_MS) : XHS_STALE_MS;
    const staleFactor = lastSeenMs ? Math.max(0.5, 1 - Math.max(0, (now - lastSeenMs) - XHS_STALE_MS) / XHS_STALE_MS) : 0.5;
    // trendScore = 历史频次50% + 近期频次30% + 技能匹配度20%
    const trendScore = Number((staleFactor * (0.5 * freqNorm + 0.3 * recentNorm + 0.2 * relevanceScore)).toFixed(3));
    out.push({
      keyword: normTool,
      skill,
      totalCount,
      recentCount,
      lastSeen: info.lastSeen,
      relevanceScore,
      trendScore,
      source: 'xhs',
    });
  }
  // 同技能内按 trendScore 降序，便于调用方优先取 Top-N
  out.sort((a, b) => b.trendScore - a.trendScore);
  return out;
}

// 把趋势词合并进 B站搜索词：固定词永远在前、不可被覆盖；趋势词补充在尾部（受 maxTrend 限制）。
// @param skill          { name }
// @param job            岗位（仅用于 buildBiliKeywords 排序语义，不进搜索词）
// @param trends         extractTrendKeywordsFromXhs 的输出（可跨技能，本函数按 skill.name 过滤）
// @param opts.maxTrend  每个技能最多补充的趋势词数（默认 3）
// @returns [{ keyword, intent, isTrend }]  intent 固定词沿用原 intent，趋势词记为 'trend'
export function mergeBiliKeywords(skill, job = '', trends = [], { maxTrend = 3, maxFixedPerIntent = 1 } = {}) {
  // 固定词：每档（basic/product/practice）各取前 maxFixedPerIntent 个，控制总量（默认 3 个）。
  // 固定词永远在前、不可被趋势词覆盖。
  const allFixed = buildBiliKeywords(skill, job);
  const fixedByIntent = {};
  const fixed = [];
  for (const k of allFixed) {
    const it = k.intent;
    if (!fixedByIntent[it]) fixedByIntent[it] = 0;
    if (fixedByIntent[it] < maxFixedPerIntent) {
      fixed.push({ keyword: k.keyword, intent: k.intent, isTrend: false });
      fixedByIntent[it]++;
    }
  }
  const skillTrends = (trends || [])
    .filter((t) => t && t.skill === skill.name)
    .sort((a, b) => b.trendScore - a.trendScore)
    .slice(0, maxTrend);
  // 趋势词缀上「教程/实战」等学习场景词，保证它是真实 B站搜索词（而非纯工具名）
  const SCENE_SUFFIX = ['教程', '实战', '工作流'];
  const trendKws = skillTrends.map((t, i) => {
    const suffix = SCENE_SUFFIX[i % SCENE_SUFFIX.length];
    // 工具名本身已是常用搜索词（如「Coze」「Dify」）则补「教程」；已是「X工作流」则原样
    const kw = /工作流|教程|实战$/.test(t.keyword) ? t.keyword : `${t.keyword}${suffix}`;
    return { keyword: kw, intent: 'trend', isTrend: true, trendScore: t.trendScore, trendSource: t.source };
  });
  return [...fixed, ...trendKws];
}

// ---------- B站视频评分缓存：行结构序列化（纯函数，DB 读写在 plan.mjs） ----------
// 把一条视频资源的评分结果打包成可持久化结构（与用户定义的 bilibili_resource_cache 字段对应）。
export function serializeCacheScore({ video, skill, searchKeyword, score, subtitleStatus, duration }) {
  return {
    bvid: String(video?.link || '').match(/BV\w+/)?.[0] || '',
    title: video?.title || '',
    url: video?.link || '',
    author: video?.author || '',
    skill: skill || '',
    searchKeyword: searchKeyword || '',
    score: {
      titleMatch: Number((score?.skill_title_match ?? 0).toFixed(3)),
      trendMatch: Number((score?.trend_match ?? 0).toFixed(3)),
      learningQuality: Number((score?.learning_quality ?? 0).toFixed(3)),
      durationScore: Number((score?.duration_score ?? 0).toFixed(3)),
      finalScore: Number((score?.final_score ?? 0).toFixed(3)),
    },
    scoreVersion: SCORE_VERSION,
    subtitleStatus: subtitleStatus ?? (video?.hasSubtitle ? 'available' : 'none'),
    duration: Number(duration || video?.durationSec || 0),
    checkedTime: Date.now(),
  };
}

// 缓存有效期：30 天内直接复用，超过则重新评分。
export const BILI_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export function isCacheFresh(checkedTime = 0) {
  return Date.now() - Number(checkedTime || 0) <= BILI_CACHE_TTL_MS;
}

// ---------- B站搜索并发限流（信号量） ----------
// 所有对 searchBilibiliVideos 的调用经此信号量，避免并发过高触发 B站 429/风控。
// 默认并发 4：内部每词已自行 fetchBiliMeta + 字幕校验，4 路并发已能显著压缩总耗时，
// 又不会因瞬时请求过多被限流。
const BILI_MAX_CONCURRENCY = 4;
let _biliActive = 0;
const _biliQueue = [];
function _biliAcquire() {
  return new Promise((resolve) => {
    if (_biliActive < BILI_MAX_CONCURRENCY) { _biliActive++; resolve(); }
    else _biliQueue.push(resolve);
  });
}
function _biliRelease() {
  _biliActive--;
  if (_biliQueue.length) { _biliActive++; _biliQueue.shift()(); }
}
// 包装任意异步任务，受信号量限流
async function withBiliConcurrency(fn) {
  await _biliAcquire();
  try { return await fn(); }
  finally { _biliRelease(); }
}


// ---------- B站视频匹配 ----------
// 每个标准技能搜真实视频（时长 >= 10 分钟，近 6 年），全部来自 B站 API（【实时搜索，不读资源库】）。
// 搜索词 = 固定意图词（buildBiliKeywords）+ 小红书趋势词（mergeBiliKeywords，仅补充、不覆盖）。
// 评分后优先复用 bilibili_resource_cache 中的历史评分（cacheStore 注入），降低重复计算成本。
// 评分模型 v3：skill_title_match 35% + learning_quality 25% + jobFitScore 25% + trend_match 10% + duration 5%。
// v3 新增：
//   - jobFitScore（25%）：AI 产品经理岗位匹配评分，偏向「产品/应用/落地」，抑制「工程/算法/源码」
//   - AI_DOMAIN_RE 硬过滤：视频标题/简介必须命中 AI 领域关键词，杜绝普通教程混入
//   - per-plan 跨阶段去重：同一 BV 号不能出现在多个阶段
// cacheStore 约定（由 plan.mjs 用 DB 实现并注入，本函数不碰 DB）：
//   get(bvid, skill) -> 缓存行 | null（含 score_version，版本不符则重算）
//   put(row)         -> void   （写回评分结果，带 score_version）
// 候选截断：每个搜索关键词只取 TopN 候选进入评分（控制字幕获取+评分耗时，不评全部结果）。
export const BILI_CANDIDATE_TOPN = 10;
export const SCORE_VERSION = 'v3';
export async function matchVideoResources(skills, {
  perSkill = 1,
  job = '',
  trends = [],            // extractTrendKeywordsFromXhs 输出（跨技能），按需按 skill.name 过滤
  cacheStore = null,      // { get(bvid, skill), put(row) }；视频评分缓存，传 null 则跳过
  searchCacheStore = null,// { get(keyword), put(keyword, results) }；B站搜索结果短缓存，传 null 则跳过
  maxTrend = 3,
} = {}) {
  const byLink = new Map();
  const skillHits = {};
  const isAiPm = /ai\s*产品|人工智能\s*产品|大模型\s*产品|产品\s*经理.*ai/i.test(job);
  // 硬过滤：行业大会 / 峰会 / 发布会 / 企业宣传 / 与 AI 产品无关的工程会议（如 CAE 仿真）
  // 即使通过字幕校验也不进入学习计划（用户明确禁止「AI+CAE会议」类混入）。
  const blocked = isAiPm
    ? /(峰会|发布会|行业论坛|行业大会|圆桌|颁奖|路演|招商|CAE|仿真|CUDA|芯片|财会|电商|文员|行政|人事|游戏解说|股票|娱乐|定制家具|图纸|模型说明书|vlog|带货|直播|美食|穿搭|搞笑|游戏|日常|心得|踩坑|碎碎念|分享会|闲聊|建筑|景观|环艺|Adobe|Illustrator|Photoshop|PS教程|结构方程|统计学|考研|雅思|健身|理财|炒股|炒股|烹饪|旅游|情感|脱口秀)/i
    : null;
  const clamp = (n) => Math.max(0, Math.min(1, Number(n) || 0));

  // 技能权重 map（P1）：技能名 -> weight，用于资源优先级 resourcePriority = skillWeight × 评分。
  // 权重来自固定技能体系（AI_PM_SKILL_CATALOG.weight），保证 Agent/RAG 等核心技能的视频优先。
  const skillWeights = new Map();
  for (const s of skills) {
    const w = typeof s?.weight === 'number' && s.weight > 0 ? s.weight : 0.1;
    skillWeights.set(String(s.name || ''), w);
  }
  // 趋势关键词集合（P2 trendMatch 用）：把小红书趋势词的 canonical 关键词汇总，
  // 视频标题命中其一即视为「契合市场热点」加成。
  const trendKeywords = (Array.isArray(trends) ? trends : [])
    .map((t) => String(t?.keyword || '').toLowerCase())
    .filter(Boolean);

  // 按技能名去重（同名才合并），保留不同技能各自独立搜索；不再按 category 去重
  // （否则 AI 产品经理 20 个技能若多属 llm 会被压成 5 个，导致 RAG/Agent/企业知识库 等漏搜）。
  const videoSkills = [...new Map(skills.map((s) => [String(s.name || s.category || Math.random()), s])).values()];
  const deadline = Date.now() + (isAiPm ? 105000 : 180000);
  const withTimeout = (promise, ms) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('B站候选校验超时')), ms)),
  ]);

  for (const skill of videoSkills) {
    if (Date.now() >= deadline) break;
    skillHits[skill.name] = [];
    // 搜索词 = 固定意图词（buildBiliKeywords 每档1个，共3个）+ 小红书趋势词（最多 maxTrend 个，
    // mergeBiliKeywords 保证固定词在前且不可被覆盖）。趋势词来自 extractTrendKeywordsFromXhs 输出。
    // 单技能搜索词上限约 3 + maxTrend（默认3）= 6 词，控制搜索量避免 deadline 截断。
    const merged = mergeBiliKeywords(skill, job, trends, { maxTrend });
    const keywords = merged.map((k) => k.keyword).filter(Boolean);
    // 意图词（用于标题技能命中）：意图表词 + 标准技能名 + 别名，提升标题命中准确率
    const intentTerms = [
      ...(AI_PM_SKILL_INTENT[skill.name] ? Object.values(AI_PM_SKILL_INTENT[skill.name]).flat() : []),
      skill.name,
      ...(skill.aliases || []),
    ].map(String);

    // ---------- 并发搜索（受信号量限流，避免 B站 429） ----------
    // 把本技能的所有关键词搜索任务并发派发，显著压缩总耗时（原串行 6 词≈30-60s → 并发≈8-15s）。
    // 任一关键词失败仅告警、不影响其它关键词结果；实时搜索性质不变（每次仍真实调 B站 API）。
    const searchTasks = keywords.map((keyword) =>
      withBiliConcurrency(() =>
        withTimeout(
          searchBilibiliVideos(keyword, { durationMin: 600, topN: BILI_CANDIDATE_TOPN, timeoutMs: 5000, maxAgeYears: 8, skill: skill.name, cacheStore, searchCacheStore }),
          18000
        )
      ).then((vs) => ({ vs }))
        .catch((e) => {
          console.warn('[skillResourceMatcher] B站搜索失败 skill=%s kw=%s: %s', skill.name, keyword, e.message);
          return { vs: [] };
        })
    );
    const searchResults = await Promise.all(searchTasks);
    const videos = [];
    for (const r of searchResults) videos.push(...r.vs);

    const cacheWritten = new Set(); // 同一视频跨多 skill 时，缓存写回只做一次
    for (const v of videos) {
      const link = v?.link || v?.url || '';
      if (!link) continue; // 无真实链接不收录
      const title = String(v.title || v.biliTitle || '');
      if (blocked?.test(title)) continue; // 会议/峰会/无关工程会议等硬过滤
      // P0：AI 领域硬过滤——标题/简介必须命中 AI 领域关键词，否则直接剔除（不进入评分）
      const desc = String(v.description || v.desc || '');
      if (!AI_DOMAIN_RE.test(title) && !AI_DOMAIN_RE.test(desc)) continue;
      // 仅收录「有公开字幕」的 B站视频（无字幕无法生成笔记，入口已保证不串号）
      if (v?.platform === 'bilibili' && v.hasSubtitle === false) continue;

      const bvid = String(link).match(/BV\w+/)?.[0] || '';
      // 缓存复用：30 天内直接取历史评分，跳过本地重算（降低重复评分计算成本）。
      // 注意：缓存【不】替代实时搜索——视频仍是本次 B站实时搜回的，只是评分可复用。
      let skillTitleMatch, trendMatch, learningQuality, duration, jobFit, relevance_score, fromCache = false;
      if (cacheStore && bvid) {
        const cached = cacheStore.get(bvid, skill.name);
        // 版本校验：缓存 score_version 必须匹配当前模型，否则视为失效、重新评分（避免旧模型评分污染新链路）
        if (cached && isCacheFresh(cached.checkedTime) && cached.scoreVersion === SCORE_VERSION) {
          fromCache = true;
          skillTitleMatch = cached.score?.titleMatch ?? 0.8;
          trendMatch = cached.score?.trendMatch ?? 0;
          learningQuality = cached.score?.learningQuality ?? 0.7;
          duration = cached.score?.durationScore ?? 0.8;
          jobFit = scoreJobFit(title, desc); // 岗位匹配实时算（不依赖旧缓存分项）
          relevance_score = Number((
            0.35 * skillTitleMatch + 0.25 * learningQuality + 0.25 * jobFit + 0.10 * trendMatch + 0.05 * duration
          ).toFixed(3));
        }
      }

      const tl = title.toLowerCase();
      if (!fromCache) {
        // 1) 标题技能命中（40%）：命中任一意图词视为强相关，否则弱相关
        skillTitleMatch = intentTerms.some((t) => tl.includes(String(t).toLowerCase())) ? 1 : 0.45;
        // 2) 趋势契合（10%）：视频标题命中小红书趋势关键词（近期热点工具名，如 Coze/Dify）则加分，
        //    让「市场热点」视频在排序中被适度提升（来源：extractTrendKeywordsFromXhs 的 keyword）。
        trendMatch = trendKeywords.some((kw) => tl.includes(kw)) ? 1 : 0;
        // 3) 学习质量（35%）：按 B站标题习惯词库分层（高/中/低）
        //    高：系统课 / 完整教程 / 从0到1 / 实战（系统性强）
        //    中：教程 / 案例 / 解析 / 讲解
        //    低：分享 / 介绍 / 闲聊 / 入门科普
        if (BILI_HABIT_RE.course.test(title)) {
          learningQuality = 1;            // 系统课/完整课程/从0到1
        } else if (BILI_HABIT_RE.practice.test(title) || BILI_HABIT_RE.teach.test(title)) {
          learningQuality = 0.85;         // 实战/教程/案例/解析
        } else if (/(分享|介绍|闲聊|科普|聊聊|浅谈|速览|盘点)/i.test(title)) {
          learningQuality = 0.5;          // 偏分享/介绍类，系统性弱
        } else {
          learningQuality = 0.7;          // 普通相关但不易判定层级
        }
        // 4) 时长（5%）
        duration = (Number(v.durationSec) || 0) >= 3600 ? 1 : (Number(v.durationSec) || 0) >= 1800 ? 0.9 : 0.7;
        // 5) AI 产品经理岗位匹配（25%）：产品/应用方向加权，工程/算法方向减权
        jobFit = scoreJobFit(title, desc);
        relevance_score = Number((
          0.35 * skillTitleMatch + 0.25 * learningQuality + 0.25 * jobFit + 0.10 * trendMatch + 0.05 * duration
        ).toFixed(3));
      }
      if (relevance_score < 0.6) continue; // 整体不达标则剔除（无字幕不会到此，因已硬过滤）

      // 跨阶段去重：用 bvid 作为唯一键，防止同一视频出现在多个阶段
      const dedupKey = bvid || link;
      if (!byLink.has(dedupKey)) {
        byLink.set(dedupKey, {
          id: `video_${byLink.size + 1}`,
          title: v.title || v.biliTitle || '',
          link,
          platform: 'bilibili',
          author: v.author || '',
          // searchBilibiliVideos 返回 durationSec(秒) 与 pubdate(unix 秒)
          durationSec: Number(v.durationSec) || 0,
          publishDate: v.pubdate ? new Date(v.pubdate * 1000).toISOString().slice(0, 10) : '',
          // 真实分P列表（来自 B站 view 接口 data.pages），供每日任务精确到「第几P」
          parts: Array.isArray(v.parts) ? v.parts : [],
          hasSubtitle: v.hasSubtitle === true, // 是否有公开字幕（筛选条件）
          relevance_score,
          from_cache: fromCache,
          // 资源优先级（P1）：技能权重 × 评分，让高权重技能（Agent/RAG）的视频在排序/入选上优先
          resourcePriority: Number(((skillWeights.get(skill.name) || 0.1) * relevance_score).toFixed(4)),
          relevance: {
            skill_title_match: Number(skillTitleMatch.toFixed(3)),
            trend_match: Number((trendMatch || 0).toFixed(3)),
            learning_quality: Number(learningQuality.toFixed(3)),
            duration_score: Number(duration.toFixed(3)),
            job_fit: Number(scoreJobFit(title, desc).toFixed(3)),
            final_score: relevance_score,
            score_version: SCORE_VERSION,
          },
          reason: [
            `覆盖技能「${skill.name}」(权重${skillWeights.get(skill.name) || 0.1})`,
            `学习搜索意图=${intentTerms.slice(0, 2).join('/')}`,
            BILI_HABIT_RE.course.test(title) ? '系统教程' : BILI_HABIT_RE.practice.test(title) ? '项目实战' : BILI_HABIT_RE.teach.test(title) ? '教学讲解' : '内容相关',
            (trendMatch ? '契合小红书趋势热点' : ''),
            scoreJobFit(title, desc) >= 0.8 ? `契合${job || '目标岗位'}视角` : scoreJobFit(title, desc) <= 0.3 ? `偏技术底层(岗位降权)` : '岗位中性',
            fromCache ? `评分复用缓存(${SCORE_VERSION})` : `AI领域硬过滤通过；有公开字幕`,
          ].filter(Boolean).join('；'),
          skills: [],
        });
        // 写回缓存（每个视频仅一次）：新视频重新评分后持久化；命中缓存的视频无需重复写。
        if (cacheStore && bvid && !fromCache && !cacheWritten.has(bvid + '|' + skill.name)) {
          cacheWritten.add(bvid + '|' + skill.name);
          try {
            cacheStore.put(serializeCacheScore({
              video: v,
              skill: skill.name,
              searchKeyword: merged.find((k) => k.isTrend) ? merged.find((k) => k.isTrend).keyword : (merged[0]?.keyword || ''),
              score: byLink.get(dedupKey).relevance,
              subtitleStatus: v.hasSubtitle ? 'available' : 'none',
              duration: v.durationSec,
            }));
          } catch (e) { console.warn('[skillResourceMatcher] 写回 B站评分缓存失败 bvid=%s: %s', bvid, e.message); }
        }
      }
      const item = byLink.get(dedupKey);
      if (!item.skills.includes(skill.name)) item.skills.push(skill.name);
      if (!skillHits[skill.name].includes(item.id)) skillHits[skill.name].push(item.id);
    }
  }

  // 排序：主序 resourcePriority（技能权重 × 评分），让 Agent/RAG 等高权重技能的视频优先；
  // 同优先级内按 relevance_score 降序。岗位偏好已计入 relevance_score。
  return {
    resources: [...byLink.values()].sort((a, b) =>
      (b.resourcePriority ?? b.relevance_score) - (a.resourcePriority ?? a.relevance_score) ||
      b.relevance_score - a.relevance_score
    ),
    skillHits,
  };
}

// ---------- 主入口 ----------
// 输入：标准技能树（skillNormalizer 输出）
// 输出：{ skills, pdfResources, videoResources, coverage }
// 全流程零 LLM 参与，产出即为"真实资源池"。
export async function matchResources(skillTree, { job = '', perSkillTopK = 4, maxSkills = 12, trends = [], cacheStore = null, searchCacheStore = null, maxTrend = 3 } = {}) {
  const all = extractStandardSkills(skillTree);
  if (!all.length) {
    return { skills: [], pdfResources: [], videoResources: [], coverage: { pdf: {}, video: {}, missing: [] } };
  }
  // 控制 token 与外部请求量：最多取前 maxSkills 个技能
  const effectiveJob = job || skillTree?.job || '';
  const isAiPm = /ai\s*产品|人工智能\s*产品|大模型\s*产品|产品\s*经理.*ai/i.test(effectiveJob);
  const skills = all.slice(0, isAiPm ? 20 : maxSkills);

  // 视频独立超时：AI 产品经理技能多（20 个），每个技能固定词3个+趋势词最多3个，
  // 全部搜完需更长时间，deadline 放宽到 180s（generateIntegratedPlan 总超时 280s 内）。
  const videoDeadlineMs = isAiPm ? 180000 : 120000;
  const videoWithDeadline = Promise.race([
    matchVideoResources(skills, { perSkill: 1, job: effectiveJob, trends, cacheStore, searchCacheStore, maxTrend }),
    new Promise((resolve) => setTimeout(() => resolve({ resources: [], skillHits: {}, timedOut: true }), videoDeadlineMs)),
  ]);

  // ---- PDF 检索：独立超时 + 失败重试 + 错误记录（禁止静默降级为空）----
  const pdfDeadlineMs = isAiPm ? 240000 : 150000; // PDF(RAG/BGE-M3) 加载慢，独立放宽到 240s，不依赖视频节奏
  const runPdfOnce = () =>
    Promise.race([
      matchPdfResources(skills, { perSkillTopK, job: effectiveJob }),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`PDF检索超时(${pdfDeadlineMs}ms)`)), pdfDeadlineMs)),
    ]);

  console.log(`[PDF_MATCH] 开始 skills=${skills.length}`);
  const pdfStart = Date.now();
  let pdf;
  let pdfMatchError = false;
  let pdfErrorReason = '';
  try {
    pdf = await runPdfOnce();
  } catch (e1) {
    // 第一次失败：等待 2 秒后重试一次（BGE-M3 首次加载偶发慢/锁竞争）
    console.warn('[PDF_MATCH] 第一次检索失败，2s 后重试：', e1 && e1.message ? e1.message : e1);
    await new Promise((r) => setTimeout(r, 2000));
    try {
      pdf = await runPdfOnce();
    } catch (e2) {
      pdfMatchError = true;
      pdfErrorReason = (e2 && e2.message ? e2.message : String(e2)) || 'unknown';
      console.error('[PDF_MATCH] 重试后仍失败，记录错误原因（不再静默降级）：', pdfErrorReason);
      pdf = { resources: [], skillHits: {} };
    }
  }
  const pdfDuration = Date.now() - pdfStart;
  console.log(`[PDF_MATCH] 完成 skills=${skills.length} duration=${pdfDuration}ms count=${(pdf.resources || []).length}${pdfMatchError ? ` error=${pdfErrorReason}` : ''}`);

  // 视频与 PDF 各自独立容错：PDF(RAG) 偶发超时/网络异常不应连累视频匹配，反之亦然。
  const video = await videoWithDeadline;

  // 资源缺口：既没有 PDF 也没有视频的技能，如实标记（不允许后续编造补齐）
  const missing = skills
    .filter((s) => !(pdf.skillHits[s.name] || []).length && !(video.skillHits[s.name] || []).length)
    .map((s) => s.name);

  return {
    skills,
    pdfResources: pdf.resources,
    videoResources: video.resources,
    coverage: { pdf: pdf.skillHits, video: video.skillHits, missing },
    // 透传 PDF 检索错误标记，供上层（plan.mjs / 调试）感知，不静默吞掉
    pdfMatchError,
    pdfErrorReason,
  };
}

// ---------- 资源缓存层持久化 ----------
// 把 matchResources 已匹配到的真实资源写入 matched_resources 表，
// 后续每日计划直接读缓存，不再重新调用 B站搜索。
// resource.skills 为标准技能名数组，按 skill 展开为一行（每个 skill 一条），便于按 skill 重建阶段资源。
export function persistMatchedResources(db, { planId, pdfResources = [], videoResources = [] }) {
  if (!planId) return { saved: 0 };
  // 重存前清空该 plan 的旧缓存
  db.prepare('DELETE FROM matched_resources WHERE plan_id = ?').run(planId);

  const now = Date.now();
  let count = 0;
  const insert = db.prepare(`INSERT INTO matched_resources (plan_id, skill_id, resource_type, title, url, doc_id, duration, author, parts, metadata, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);

  for (const p of pdfResources) {
    const skills = Array.isArray(p.skills) && p.skills.length ? p.skills : ['__unknown__'];
    for (const sk of skills) {
      insert.run(planId, sk, 'pdf', p.title || '', '', p.docId || '', 0, '', '', JSON.stringify({ file: p.file || '', link: p.link || '', chapters: p.chapters || [], relevance_score: p.relevance_score || 0, relevance: p.relevance || null, reason: p.reason || '' }), now);
      count++;
    }
  }
  // 跨阶段去重：同一 BV（link）只归属首个 skill，避免同一视频重复出现在多个阶段。
  const seenVideoLinks = new Set();
  for (const v of videoResources) {
    const link = v.link || '';
    if (seenVideoLinks.has(link)) continue; // 已在更早的 skill 写入，跳过重复
    seenVideoLinks.add(link);
    const skills = Array.isArray(v.skills) && v.skills.length ? [v.skills[0]] : ['__unknown__'];
    const partsJson = JSON.stringify(Array.isArray(v.parts) ? v.parts : []);
    for (const sk of skills) {
      insert.run(planId, sk, 'video', v.title || '', v.link || '', '', v.durationSec || 0, v.author || '', partsJson, JSON.stringify({ platform: v.platform || 'bilibili', publishDate: v.publishDate || '', relevance_score: v.relevance_score || 0, relevance: v.relevance || null, reason: v.reason || '' }), now);
      count++;
    }
  }
  return { saved: count };
}

// 从 matched_resources 缓存重建「阶段资源」结构：按 skill 分组为 pdf[] 与 videos[]
export function loadMatchedResources(db, planId) {
  if (!planId) return null;
  const rows = db.prepare('SELECT * FROM matched_resources WHERE plan_id = ?').all(planId);
  if (!rows || !rows.length) return null;

  const bySkill = {};
  for (const r of rows) {
    const sk = r.skill_id || '__unknown__';
    if (!bySkill[sk]) bySkill[sk] = { pdf: [], videos: [] };
    if (r.resource_type === 'pdf') {
      let meta = {};
      try { meta = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata || {}); } catch { meta = {}; }
      bySkill[sk].pdf.push({
        id: r.doc_id ? `pdf_${r.doc_id}` : `pdf_${r.id}`,
        title: r.title,
        docId: r.doc_id,
        file: meta.file || '',
        link: meta.link || '',
         chapters: meta.chapters || [],
         relevance_score: meta.relevance_score || 0,
         relevance: meta.relevance || null,
         reason: meta.reason || '',
        skills: [sk],
      });
    } else if (r.resource_type === 'video') {
      let meta = {};
      try { meta = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata || {}); } catch { meta = {}; }
      let parts = [];
      try { parts = typeof r.parts === 'string' ? JSON.parse(r.parts) : (r.parts || []); } catch { parts = []; }
      bySkill[sk].videos.push({
        id: r.url ? `video_${r.url}` : `video_${r.id}`,
        title: r.title,
        link: r.url,
        url: r.url,
        platform: meta.platform || 'bilibili',
        author: r.author || '',
        durationSec: r.duration || 0,
        publishDate: meta.publishDate || '',
         parts,
         relevance_score: meta.relevance_score || 0,
         relevance: meta.relevance || null,
         reason: meta.reason || '',
        skills: [sk],
      });
    }
  }
  return bySkill;
}
