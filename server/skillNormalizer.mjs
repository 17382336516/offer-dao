// 技能标准化服务（Skill Normalization）
// 目标：把不同来源（小红书帖子 / RAG 文档 / 大模型预测）里叫法不一的技能名称，
// 统一收敛成一个标准名 standard_name，并保留原始叫法 aliases。
//
// 约束：
//   1. 保留原始技能名称，不覆盖（aliases 保存原始叫法）。
//   2. standard_name 作为后续系统统一查询名称。
//   3. 不合并【不同】的技能（例如「机器学习」≠「深度学习」）。
//
// 两种调用形态：
//   A) normalizeRoute(route)        —— 传入完整学习路线 JSON（向后兼容 MVP 链路）
//   B) normalizeSkills({job,skills}) —— 传入标准接口形态 { job, skills:[{name,level,category}] }
//      （对应 POST /api/skills/normalize）

import crypto from 'crypto';

// 固定 category 枚举
const CATEGORY_ENUM = [
  'programming', 'math', 'ml', 'dl', 'data', 'nlp', 'cv', 'rag', 'agent',
  'llm', 'pm', 'product', 'tool', 'soft', 'other',
];
// 固定 level 枚举
const LEVEL_ENUM = ['beginner', 'intermediate', 'advanced'];

// AI 产品经理的岗位能力边界。该目录是资源匹配的硬约束，避免把普通产品、视觉设计
// 或纯工程内容因为一个泛化关键词混入学习路线。
export const AI_PM_SKILL_CATALOG = [
  { name: 'LLM基础概念', category: 'llm', level: 'beginner', weight: 0.18, aliases: ['LLM', '大语言模型', '大模型基础', 'Transformer', 'ChatGPT原理'] },
  { name: '大模型能力边界', category: 'llm', level: 'beginner', weight: 0.12, aliases: ['模型能力边界', '大模型能力', '模型幻觉', '上下文窗口'] },
  { name: 'Prompt工程', category: 'llm', level: 'beginner', weight: 0.15, aliases: ['提示词工程', '提示词设计', 'Prompt设计'] },
  { name: 'AI产品基础认知', category: 'pm', level: 'beginner', weight: 0.10, aliases: ['AI产品经理', 'AI产品', '人工智能产品经理'] },
  { name: 'AI需求分析', category: 'product', level: 'intermediate', weight: 0.10, aliases: ['AI需求', 'AI场景需求', '需求分析', '需求拆解'] },
  { name: 'AI功能设计', category: 'product', level: 'intermediate', weight: 0.10, aliases: ['AI功能', '功能设计', 'AI功能拆解', '产品功能拆解'] },
  { name: '用户场景分析', category: 'product', level: 'intermediate', weight: 0.08, aliases: ['用户场景', '场景分析', '用户研究', '用户洞察'] },
  { name: 'AI产品设计方法', category: 'product', level: 'intermediate', weight: 0.08, aliases: ['AI产品设计', 'AI产品方法', '产品设计'] },
  { name: 'AI PRD设计', category: 'product', level: 'intermediate', weight: 0.07, aliases: ['AI PRD', '产品需求文档', 'PRD撰写'] },
  { name: 'Prompt效果评估', category: 'product', level: 'intermediate', weight: 0.09, aliases: ['Prompt评估', 'Prompt效果', '提示词评测'] },
  { name: 'RAG评估', category: 'rag', level: 'intermediate', weight: 0.10, aliases: ['RAG评测', '检索评估', '知识库评估'] },
  { name: '模型效果指标', category: 'data', level: 'intermediate', weight: 0.08, aliases: ['模型效果', '模型指标', '效果评估', '准确率', '召回率'] },
  { name: '用户反馈闭环', category: 'product', level: 'intermediate', weight: 0.06, aliases: ['用户反馈', '反馈闭环', '效果闭环', 'AB实验'] },
  { name: 'RAG', category: 'rag', level: 'intermediate', weight: 0.28, aliases: ['检索增强生成', '企业知识库', '向量数据库', 'RAG技术'] },
  { name: 'Agent', category: 'agent', level: 'intermediate', weight: 0.35, aliases: ['AI Agent', '智能体', '智能体开发'] },
  { name: 'Workflow', category: 'agent', level: 'intermediate', weight: 0.18, aliases: ['工作流', '智能体工作流', 'AI工作流'] },
  { name: 'AI应用架构', category: 'agent', level: 'advanced', weight: 0.16, aliases: ['应用架构', 'RAG架构', 'Agent架构'] },
  { name: '企业知识库', category: 'rag', level: 'intermediate', weight: 0.18, aliases: ['企业知识库搭建', '知识库应用', 'AI知识库'] },
  { name: 'AI产品项目管理', category: 'product', level: 'intermediate', weight: 0.07, aliases: ['AI项目', '项目管理', '项目推进'] },
  { name: '技术团队协作', category: 'product', level: 'intermediate', weight: 0.05, aliases: ['研发协作', '跨团队协作', '技术沟通'] },
  { name: '商业化应用', category: 'product', level: 'advanced', weight: 0.08, aliases: ['AI商业化', '业务落地', '产品商业化'] },
];

// AI 产品经理固定五阶段能力地图（与前端「学习阶段」对齐）。
// 每个阶段列出「允许出现的技能池」与「阶段检索意图 searchIntent」，
// 资源匹配层（PDF/B站）据此把岗位能力 -> 阶段 -> 技能 -> 学习意图 串起来。
// 普通产品技能（用户故事 / 普通需求分析 / 普通UX / 团队沟通）一律不在池中，除非已明确 AI 化。
export const AI_PM_STAGE_MAP = [
  {
    stage: 'AI基础与产品认知',
    searchIntent: '理解大模型与 AI 产品的基础概念、能力边界与 Prompt 用法',
    skills: ['LLM基础概念', '大模型能力边界', 'Prompt工程', 'AI产品基础认知'],
  },
  {
    stage: 'AI产品设计',
    searchIntent: '从 AI 视角做需求分析、功能设计、场景分析与 PRD 撰写',
    skills: ['AI需求分析', 'AI功能设计', '用户场景分析', 'AI产品设计方法', 'AI PRD设计'],
  },
  {
    stage: 'AI效果评估',
    searchIntent: '评估 Prompt / RAG / 模型效果并建立用户反馈闭环',
    skills: ['Prompt效果评估', 'RAG评估', '模型效果指标', '用户反馈闭环'],
  },
  {
    stage: '大模型与AI应用',
    searchIntent: '掌握 RAG / Agent / Workflow 等大模型应用与架构',
    skills: ['RAG', 'Agent', 'Workflow', 'AI应用架构', '企业知识库'],
  },
  {
    stage: 'AI项目落地与协作',
    searchIntent: '推进 AI 产品项目落地、跨团队技术协作与商业化',
    skills: ['AI产品项目管理', '技术团队协作', '商业化应用'],
  },
];

// 普通（非 AI）产品技能黑名单：AI 产品经理链路出现这些名字时一律剔除，
// 避免阶段技能退化成普通产品经理能力。
export const AI_PM_FORBIDDEN_SKILLS = [
  '用户故事', '用户故事编写', '普通需求分析', '普通ux', 'ux设计', '用户体验设计',
  '团队沟通', '沟通表达', '普通项目管理', '竞品分析', '原型设计', 'axure', 'figma',
];

// =====================================================================
// AI 产品经理固定技能目录（唯一技能来源，不依赖 LLM / 不依赖历史 plan 快照）
// ---------------------------------------------------------------------
// 本数组是 AI产品经理岗位能力模型的【唯一权威来源】。它被：
//   - plan.mjs 的 extractIntegratedSkillTree（AI产品岗直接返回，零 LLM）
//   - skillResourceMatcher 的 B站 Search Intent（按 skillName 关联 AI_PM_SKILL_INTENT）
//   - attachSectionWeights / buildCombinedPlan（阶段与权重分配）
// 共同引用，避免多份目录漂移。
// 字段：stage 学习板块 / skillName 标准技能名 / category 类目 / level 掌握要求
//       / weight 基准学习权重（Learning Budget 依据，趋势仅可 +≤20%）
// =====================================================================
export const AI_PM_SKILL_MAP = (() => {
  const stageOf = (name) => {
    const m = AI_PM_STAGE_MAP.find((s) => s.skills.includes(name));
    return m ? m.stage : 'AI基础与产品认知';
  };
  return AI_PM_SKILL_CATALOG.map((s) => ({
    stage: stageOf(s.name),
    skillName: s.name,
    category: s.category,
    level: s.level,
    weight: s.weight,
  }));
})();

// 把固定目录转换为技能树抽取接口的旧形状：[{ name, category, level, weight }]
export function aiPmFixedSkills() {
  return AI_PM_SKILL_MAP.map((s) => ({
    name: s.skillName,
    category: s.category,
    level: s.level,
    weight: s.weight,
  }));
}

export function isAiProductManagerJob(job = '') {
  return /ai\s*产品|人工智能\s*产品|大模型\s*产品|产品\s*经理.*ai|产品\s*经理.*大模型/i.test(String(job || ''));
}

// 已知同义归一词典：把常见别名映射到标准名（只用于「明显同一事物」的写法归一，
// 绝不跨技能合并）。
const ALIAS_DICTIONARY = [
  { standard_name: 'Python', keywords: ['python基础', 'python 基础', 'python编程', 'python 编程', 'python语言', 'python 语言', 'py基础', '学python', 'python入门'] },
  { standard_name: 'Prompt工程', keywords: ['prompt 工程', 'promptengineering', '提示词工程', '提示工程', 'prompt设计', 'prompt 设计', '提示词设计'] },
  { standard_name: '机器学习', keywords: ['machine learning', 'ml基础', 'ml 基础'] },
  { standard_name: '深度学习', keywords: ['deep learning', 'dl基础', 'dl 基础'] },
  { standard_name: 'SQL', keywords: ['sql语言', 'sql 语言', 'sql基础', '数据库sql', 'mysql基础', 'mysql 基础', 'sql查询'] },
  { standard_name: '数据分析', keywords: ['data analysis', '数据分折', 'sql数据分析', '数据分析能力'] },
  { standard_name: '产品经理', keywords: ['产品', 'pm', '产品岗', '产品策划'] },
  { standard_name: '需求分析', keywords: ['需求工程', '需求拆解', '需求理解'] },
  { standard_name: 'Axure', keywords: ['axure rp', 'axure原型', '原型工具axure'] },
  { standard_name: 'Figma', keywords: ['figma设计', 'figma原型'] },
  { standard_name: 'Excel', keywords: ['excel表格', '表格处理', 'excel基础'] },
  { standard_name: 'SQL基础', keywords: ['sql 基础', 'sql基础', '数据库基础'] },
  { standard_name: 'AI产品经理', keywords: ['ai pm', 'ai产品', '人工智能产品经理', 'ai产品岗'] },
  { standard_name: '大模型', keywords: ['llm', '大语言模型', 'large language model', 'llms'] },
  { standard_name: 'RAG', keywords: ['检索增强生成', 'rag系统', 'rag技术', 'rag 检索增强'] },
  { standard_name: 'Agent', keywords: ['智能体', 'ai agent', 'ai agent开发', 'agent开发', '智能体开发'] },
  { standard_name: '数据结构与算法', keywords: ['算法', '数据结构', '算法基础', '数据结构和算法', 'leetcode', '刷算法'] },
  { standard_name: '沟通表达', keywords: ['沟通', '表达能力', '表达沟通', '汇报沟通'] },
  { standard_name: '项目管理', keywords: ['项目管控', '项目推进', '项目协调'] },
  { standard_name: '统计学', keywords: ['统计', '统计基础', '概率统计'] },
  { standard_name: '数据可视化', keywords: ['可视化', '图表制作', '数据图表'] },
  { standard_name: 'Git', keywords: ['git基础', 'git 基础', '代码管理', '版本控制'] },
  { standard_name: 'NLP', keywords: ['自然语言处理', '自然语言', 'nlp基础'] },
  { standard_name: 'CV', keywords: ['计算机视觉', '图像识别', 'cv基础'] },
  { standard_name: 'PowerPoint', keywords: ['ppt', 'ppt制作', '幻灯片'] },
  { standard_name: 'PRD', keywords: ['prd撰写', '产品需求文档', '需求文档'] },
  { standard_name: '用户研究', keywords: ['用研', '用户调研', '用户洞察'] },
  { standard_name: '竞品分析', keywords: ['竞品', '竞品调研'] },
  { standard_name: '线性回归', keywords: ['回归分析', 'linear regression'] },
  { standard_name: '特征工程', keywords: ['特征处理', '特征提取'] },
  { standard_name: 'PPT', keywords: ['ppt制作', '幻灯片', 'powerpoint'] },
];

function norm(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, '');
}

// 根据原始技能名给出一个「合理猜测」的标准名：若命中词典则取标准名，
// 否则取原始名（去掉冗余修饰词）作为标准名。
function inferStandardName(name) {
  const n = norm(name);
  if (!n) return name;
  // 命中词典
  for (const d of ALIAS_DICTIONARY) {
    if (norm(d.standard_name) === n) return d.standard_name;
    if (d.keywords.some((k) => norm(k) === n)) return d.standard_name;
  }
  // 未命中：做轻量清洗，去掉「基础/入门/编程/语言/教程」等修饰，但列表里出现的原词均保留进 aliases
  let base = name.trim();
  return base;
}

function coerceCategory(c) {
  const v = String(c || '').trim().toLowerCase();
  return CATEGORY_ENUM.includes(v) ? v : 'other';
}

function coerceLevel(l) {
  const v = String(l || '').trim().toLowerCase();
  return LEVEL_ENUM.includes(v) ? v : 'beginner';
}

function makeSkillId(name) {
  const hash = crypto.createHash('md5').update(String(name || '').trim().toLowerCase()).digest('hex').slice(0, 10);
  return 'sk_' + hash;
}

// ---------- 主入口：标准接口形态 ----------
// 输入： { job, skills:[{ name, level, category }] }
// 输出： { job, skills:[{ skill_id, standard_name, aliases, category, level }] }
export function normalizeSkills({ job = '', skills = [] } = {}) {
  const rawList = Array.isArray(skills) ? skills : [];
  if (isAiProductManagerJob(job)) {
    // AI 产品经理固定返回完整能力目录。这样一次生成中阶段不会因小红书内容差异
    // 漏掉评测、架构或落地能力，也不会把普通产品技能传给资源检索层。
    // 同时剔除上游（LLM 技能树）混入的普通产品技能黑名单，给每个技能标注所属阶段。
    const blacklist = new Set(AI_PM_FORBIDDEN_SKILLS.map((x) => norm(x)));
    const dropped = rawList.filter((it) => {
      const nm = norm(typeof it === 'string' ? it : (it?.name || it?.standard_name || ''));
      return nm && blacklist.has(nm);
    }).map((it) => (typeof it === 'string' ? it : (it?.name || it?.standard_name || '')));
    const skills = AI_PM_SKILL_CATALOG.map((s) => {
      const st = AI_PM_STAGE_MAP.find((m) => m.skills.includes(s.name));
      return {
        skill_id: makeSkillId(s.name),
        standard_name: s.name,
        aliases: [s.name, ...s.aliases],
        category: s.category,
        level: s.level,
        weight: typeof s.weight === 'number' ? s.weight : 0.1,
        stage: st ? st.stage : '',
        searchIntent: st ? st.searchIntent : '',
      };
    });
    return { job: String(job || '').trim(), skills, dropped };
  }
  const out = [];
  // 记录已经收敛到的 standard_name，避免把不同原始名误并入同一项；
  // 但「同一 standard_name 的不同原始写法」应合并进同一项的 aliases。
  const byStd = new Map();

  for (const it of rawList) {
    const originalName = String(it?.name || '').trim();
    if (!originalName) continue;
    const std = inferStandardName(originalName);
    if (!std) continue;
    const category = coerceCategory(it?.category);
    const level = coerceLevel(it?.level);
    const alias = originalName; // 原始叫法一定进 aliases

    const key = norm(std);
    if (byStd.has(key)) {
      const rec = byStd.get(key);
      // 同标准名：合并别名（去重），level/category 取已存在的（首次出现的为准）
      if (!rec.aliases.includes(alias)) rec.aliases.push(alias);
      // 若之前没有 level/category 而本次有，则补上
      if ((!rec.level || rec.level === 'beginner') && level) rec.level = level;
      if (rec.category === 'other' && category !== 'other') rec.category = category;
    } else {
      const rec = {
        skill_id: makeSkillId(std),
        standard_name: std,
        aliases: [alias],
        category,
        level,
      };
      byStd.set(key, rec);
      out.push(rec);
    }
  }
  return { job: String(job || '').trim(), skills: out };
}

// ---------- 向后兼容：学习路线形态（MVP 链路使用） ----------
// 从 route 中抽取所有技能名 -> 调用 normalizeSkills -> 回填进 route
export function normalizeRoute(route) {
  const r = route || {};
  const job = r.job || '';
  // 从多个来源收集原始技能名
  const rawSkills = [];

  // route.core_skills:[{skill,level}] / [{name,level}]
  const core = Array.isArray(r.core_skills) ? r.core_skills : [];
  for (const c of core) {
    const nm = c?.skill || c?.name || c?.title;
    if (nm) rawSkills.push({ name: nm, level: c?.level || 'beginner', category: c?.category || 'other' });
  }
  // route.skills:[{name,level,category}]
  const arr = Array.isArray(r.skills) ? r.skills : [];
  for (const s of arr) {
    const nm = s?.name || s?.skill;
    if (nm) rawSkills.push({ name: nm, level: s?.level || 'beginner', category: s?.category || 'other' });
  }
  // 兼容阶段阶段里的技能
  const stages = Array.isArray(r.stages) ? r.stages : [];
  for (const st of stages) {
    const sk = Array.isArray(st?.skills) ? st.skills : [];
    for (const s of sk) {
      const nm = (typeof s === 'string' ? s : (s?.name || s?.skill));
      if (nm) rawSkills.push({ name: nm, level: (s?.level || 'beginner'), category: (s?.category || 'other') });
    }
  }

  const normalized = normalizeSkills({ job, skills: rawSkills });
  const tree = normalized; // { job, skills:[{skill_id,standard_name,aliases,category,level}] }

  // 把标准化结果挂回 route，方便下游消费
  return {
    ...r,
    job,
    skillTree: tree,
    skills: tree.skills.map((s) => ({
      skill_id: s.skill_id,
      standard_name: s.standard_name,
      aliases: s.aliases,
      category: s.category,
      level: s.level,
    })),
  };
}

export default { normalizeSkills, normalizeRoute };
