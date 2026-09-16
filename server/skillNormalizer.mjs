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

// =====================================================================
// 非 AI 岗位的【内置兜底技能目录】（零 LLM、可复现）
// 背景：AI 产品经理有 AI_PM_SKILL_CATALOG 兜底，但数据/策略/B端/C端等岗位的技能树
//       完全依赖 LLM 抽取。一旦 LLM 不可用（欠费、限流、网络），rawSkills 为空 ->
//       normalizeSkills 返回 0 个技能 -> buildCombinedPlan 的 fallbackSections() 无技能可用 ->
//       sections=0 -> 写库后每日计划落库必然报「未找到对应的阶段计划」。
//       此处为「数据产品经理」与「通用产品经理」补齐同等强度的零 LLM 兜底，
//       保证 LLM 挂掉时仍能生成完整可用的学习路线。
// =====================================================================

// 数据产品经理能力目录
export const DATA_PM_SKILL_CATALOG = [
  { name: '数据分析基础', category: 'data', level: 'beginner', weight: 0.12, aliases: ['数据分析', '数据思维'] },
  { name: 'SQL数据查询', category: 'data', level: 'beginner', weight: 0.13, aliases: ['SQL', 'SQL查询', '取数'] },
  { name: '统计学基础', category: 'data', level: 'beginner', weight: 0.08, aliases: ['统计基础', '概率统计'] },
  { name: '指标体系搭建', category: 'data', level: 'intermediate', weight: 0.12, aliases: ['指标体系', '指标设计', '北极星指标'] },
  { name: '埋点与数据采集', category: 'data', level: 'intermediate', weight: 0.10, aliases: ['埋点', '数据采集', '事件设计'] },
  { name: '数据治理与质量', category: 'data', level: 'intermediate', weight: 0.08, aliases: ['数据质量', '数据治理'] },
  { name: '用户行为分析', category: 'data', level: 'intermediate', weight: 0.10, aliases: ['行为分析', '漏斗分析', '留存分析'] },
  { name: 'AB实验设计', category: 'data', level: 'advanced', weight: 0.09, aliases: ['A/B测试', 'AB测试', '实验设计'] },
  { name: '数据可视化', category: 'data', level: 'intermediate', weight: 0.08, aliases: ['可视化', '看板', 'BI报表'] },
  { name: '数据仓库基础', category: 'data', level: 'advanced', weight: 0.09, aliases: ['数仓', '数据仓库', '数据建模'] },
  { name: '数据产品需求管理', category: 'pm', level: 'intermediate', weight: 0.09, aliases: ['数据需求', '需求管理'] },
  { name: '数据驱动增长', category: 'pm', level: 'advanced', weight: 0.09, aliases: ['增长分析', '数据驱动'] },
];

export const DATA_PM_STAGE_MAP = [
  { stage: '数据基础与分析能力', searchIntent: '掌握数据分析思维、SQL 取数与基础统计方法', skills: ['数据分析基础', 'SQL数据查询', '统计学基础'] },
  { stage: '指标体系与数据采集', searchIntent: '搭建业务指标体系，设计埋点方案并保障数据质量', skills: ['指标体系搭建', '埋点与数据采集', '数据治理与质量'] },
  { stage: '分析实验与可视化', searchIntent: '用行为分析与 A/B 实验验证假设，并把结论可视化呈现', skills: ['用户行为分析', 'AB实验设计', '数据可视化'] },
  { stage: '数据平台与建模', searchIntent: '理解数据仓库分层与数据建模，支撑规模化数据应用', skills: ['数据仓库基础'] },
  { stage: '数据驱动落地', searchIntent: '把数据结论转化为产品需求与增长动作', skills: ['数据产品需求管理', '数据驱动增长'] },
];

// 通用产品经理兜底目录（非 AI、非数据岗时使用）
export const GENERAL_PM_SKILL_CATALOG = [
  { name: '产品基础认知', category: 'pm', level: 'beginner', weight: 0.12, aliases: ['产品经理基础', '产品认知'] },
  { name: '需求分析', category: 'product', level: 'beginner', weight: 0.14, aliases: ['需求拆解', '需求管理'] },
  { name: '用户调研', category: 'product', level: 'beginner', weight: 0.10, aliases: ['用户访谈', '用户研究'] },
  { name: '竞品分析', category: 'product', level: 'beginner', weight: 0.09, aliases: ['竞品调研'] },
  { name: '功能设计', category: 'product', level: 'intermediate', weight: 0.14, aliases: ['产品功能设计', '方案设计'] },
  { name: '原型设计', category: 'product', level: 'intermediate', weight: 0.08, aliases: ['原型', '交互稿'] },
  { name: '数据分析', category: 'data', level: 'intermediate', weight: 0.11, aliases: ['数据分析', '数据指标'] },
  { name: '项目管理', category: 'pm', level: 'intermediate', weight: 0.10, aliases: ['项目推进', '研发协作'] },
];

export const GENERAL_PM_STAGE_MAP = [
  { stage: '产品基础认知', searchIntent: '建立产品经理角色认知与工作方法', skills: ['产品基础认知'] },
  { stage: '需求与用户研究', searchIntent: '通过用户调研与竞品分析挖掘真实需求', skills: ['需求分析', '用户调研', '竞品分析'] },
  { stage: '产品方案设计', searchIntent: '把需求转化为可执行的功能方案与原型', skills: ['功能设计', '原型设计'] },
  { stage: '数据分析与验证', searchIntent: '用数据验证方案效果并持续迭代', skills: ['数据分析'] },
  { stage: '项目落地与协作', searchIntent: '推动研发落地与跨团队协作', skills: ['项目管理'] },
];

export function isDataProductManagerJob(job = '') {
  return /数据\s*产品|数据分析\s*师|BI\s*产品/i.test(String(job || ''));
}

// =====================================================================
// 其余预设岗位的专属技能目录（与 BOSS_DIRECTION_PRESETS 的 6 个方向一一对应）
// 目的：每个职位都有「零 LLM」的能力地图，LLM 不可用时仍能产出贴合该岗位的学习路线，
//       而不是全部退化成通用产品经理目录导致路线失去岗位特征。
// =====================================================================

// 策略产品经理
export const STRATEGY_PM_SKILL_CATALOG = [
  { name: '商业分析', category: 'pm', level: 'beginner', weight: 0.12, aliases: ['商业分析能力', 'business analysis'] },
  { name: '行业研究', category: 'pm', level: 'beginner', weight: 0.11, aliases: ['行业分析', '赛道研究'] },
  { name: '战略思维', category: 'pm', level: 'beginner', weight: 0.12, aliases: ['战略思考', '系统性思维'] },
  { name: '竞争分析', category: 'pm', level: 'intermediate', weight: 0.10, aliases: ['竞争策略', '竞争壁垒'] },
  { name: '商业模式设计', category: 'pm', level: 'intermediate', weight: 0.11, aliases: ['商业模式', '盈利模式'] },
  { name: '用户市场洞察', category: 'product', level: 'intermediate', weight: 0.10, aliases: ['市场洞察', '用户洞察'] },
  { name: '产品规划', category: 'product', level: 'intermediate', weight: 0.11, aliases: ['产品路线图', 'roadmap'] },
  { name: '决策分析', category: 'data', level: 'intermediate', weight: 0.09, aliases: ['决策模型', '取舍判断'] },
  { name: 'OKR目标管理', category: 'pm', level: 'intermediate', weight: 0.08, aliases: ['OKR', '目标拆解'] },
  { name: '数据驱动决策', category: 'data', level: 'advanced', weight: 0.09, aliases: ['数据化决策'] },
];
export const STRATEGY_PM_STAGE_MAP = [
  { stage: '商业与行业认知', searchIntent: '建立商业分析框架与行业研究方法', skills: ['商业分析', '行业研究', '战略思维'] },
  { stage: '竞争与模式设计', searchIntent: '识别竞争壁垒并设计可持续商业模式', skills: ['竞争分析', '商业模式设计'] },
  { stage: '市场洞察与产品规划', searchIntent: '从市场信号中提炼机会并制定产品路线图', skills: ['用户市场洞察', '产品规划'] },
  { stage: '目标拆解与决策', searchIntent: '用 OKR 与数据完成策略落地与取舍决策', skills: ['决策分析', 'OKR目标管理', '数据驱动决策'] },
];

// 增长产品经理
export const GROWTH_PM_SKILL_CATALOG = [
  { name: '增长思维', category: 'pm', level: 'beginner', weight: 0.10, aliases: ['增长黑客', 'growth hacking'] },
  { name: 'AARRR模型', category: 'pm', level: 'beginner', weight: 0.11, aliases: ['增长模型', '海盗指标'] },
  { name: '用户拉新获客', category: 'pm', level: 'beginner', weight: 0.12, aliases: ['拉新', '获客'] },
  { name: '留存提升', category: 'pm', level: 'intermediate', weight: 0.11, aliases: ['用户留存', '活跃提升'] },
  { name: '社交裂变', category: 'pm', level: 'intermediate', weight: 0.10, aliases: ['裂变营销', '分享传播'] },
  { name: '活动策划运营', category: 'pm', level: 'intermediate', weight: 0.09, aliases: ['活动运营', '策划'] },
  { name: '付费投放ROI', category: 'pm', level: 'intermediate', weight: 0.09, aliases: ['投放', '买量', 'ROI'] },
  { name: '增长实验', category: 'data', level: 'advanced', weight: 0.10, aliases: ['增长实验体系', '增长AB'] },
  { name: '用户召回策略', category: 'pm', level: 'intermediate', weight: 0.08, aliases: ['召回', '流失挽回'] },
  { name: '数据分析', category: 'data', level: 'intermediate', weight: 0.10, aliases: ['增长数据分析'] },
];
export const GROWTH_PM_STAGE_MAP = [
  { stage: '增长基础与模型', searchIntent: '建立增长思维，掌握 AARRR 增长模型', skills: ['增长思维', 'AARRR模型'] },
  { stage: '拉新与获客策划', searchIntent: '设计拉新方案、活动与裂变路径', skills: ['用户拉新获客', '社交裂变', '活动策划运营'] },
  { stage: '留存与召回', searchIntent: '提升用户留存并对流失用户进行召回', skills: ['留存提升', '用户召回策略'] },
  { stage: '投放与增长实验', searchIntent: '用付费投放与实验体系规模化验证增长方法', skills: ['付费投放ROI', '增长实验', '数据分析'] },
];

// B端产品经理
export const B_END_PM_SKILL_CATALOG = [
  { name: 'B端业务建模', category: 'pm', level: 'beginner', weight: 0.13, aliases: ['业务建模', '领域建模'] },
  { name: '企业流程梳理', category: 'pm', level: 'beginner', weight: 0.11, aliases: ['业务流程', '流程优化'] },
  { name: '客户需求洞察', category: 'product', level: 'beginner', weight: 0.11, aliases: ['B端需求', '客户调研'] },
  { name: '权限体系设计', category: 'product', level: 'intermediate', weight: 0.10, aliases: ['RBAC', '权限模型'] },
  { name: 'SaaS产品', category: 'pm', level: 'intermediate', weight: 0.11, aliases: ['SaaS', '云服务产品'] },
  { name: '解决方案设计', category: 'pm', level: 'intermediate', weight: 0.10, aliases: ['解决方案', '售前支持'] },
  { name: '项目实施交付', category: 'pm', level: 'intermediate', weight: 0.09, aliases: ['实施交付', '客户成功'] },
  { name: '开放平台与API', category: 'tech', level: 'advanced', weight: 0.09, aliases: ['开放平台', 'OpenAPI'] },
  { name: '数据报表设计', category: 'data', level: 'intermediate', weight: 0.09, aliases: ['后台报表', '管理后台'] },
  { name: '跨部门协作', category: 'pm', level: 'intermediate', weight: 0.07, aliases: ['跨团队推进'] },
];
export const B_END_PM_STAGE_MAP = [
  { stage: 'B端业务与流程', searchIntent: '掌握企业业务建模与流程梳理方法', skills: ['B端业务建模', '企业流程梳理'] },
  { stage: '需求洞察与权限设计', searchIntent: '从客户场景中提炼需求并搭建权限体系', skills: ['客户需求洞察', '权限体系设计'] },
  { stage: 'SaaS与解决方案', searchIntent: '理解 SaaS 产品形态并输出可交付解决方案', skills: ['SaaS产品', '解决方案设计', '项目实施交付'] },
  { stage: '平台能力与数据', searchIntent: '通过开放平台、API 与报表能力支撑企业集成', skills: ['开放平台与API', '数据报表设计', '跨部门协作'] },
];

// C端产品经理
export const C_END_PM_SKILL_CATALOG = [
  { name: 'C端用户洞察', category: 'pm', level: 'beginner', weight: 0.12, aliases: ['用户洞察', 'C端用户理解'] },
  { name: '用户体验UX', category: 'product', level: 'beginner', weight: 0.12, aliases: ['UX', '体验设计'] },
  { name: '交互设计', category: 'product', level: 'beginner', weight: 0.10, aliases: ['交互', 'UI设计'] },
  { name: '内容运营', category: 'pm', level: 'intermediate', weight: 0.09, aliases: ['内容策略', '内容生态'] },
  { name: '社区运营', category: 'pm', level: 'intermediate', weight: 0.09, aliases: ['社区产品', 'UGC'] },
  { name: '会员与激励体系', category: 'pm', level: 'intermediate', weight: 0.10, aliases: ['会员体系', '积分激励'] },
  { name: '推荐与算法应用', category: 'tech', level: 'advanced', weight: 0.09, aliases: ['推荐系统', '算法策略'] },
  { name: 'App产品迭代', category: 'product', level: 'intermediate', weight: 0.10, aliases: ['版本迭代', '移动产品'] },
  { name: '数据分析', category: 'data', level: 'intermediate', weight: 0.10, aliases: ['C端数据分析'] },
  { name: '活动策划', category: 'pm', level: 'intermediate', weight: 0.09, aliases: ['运营活动'] },
];
export const C_END_PM_STAGE_MAP = [
  { stage: '用户洞察与体验', searchIntent: '理解 C 端用户并建立体验设计直觉', skills: ['C端用户洞察', '用户体验UX', '交互设计'] },
  { stage: '内容与社区', searchIntent: '搭建内容生态与社区氛围', skills: ['内容运营', '社区运营'] },
  { stage: '激励与算法', searchIntent: '用会员激励与推荐算法提升留存和消费', skills: ['会员与激励体系', '推荐与算法应用'] },
  { stage: '迭代与增长', searchIntent: '通过版本迭代、活动与数据驱动持续增长', skills: ['App产品迭代', '数据分析', '活动策划'] },
];

export function isStrategyProductManagerJob(job = '') {
  return /策略\s*产品|商业\s*策略|战略\s*产品/i.test(String(job || ''));
}
export function isGrowthProductManagerJob(job = '') {
  return /增长\s*产品|用户\s*增长|growth/i.test(String(job || ''));
}
export function isBEndProductManagerJob(job = '') {
  return /b\s*端|B端|企业\s*服务|saas|SaaS/i.test(String(job || ''));
}
export function isCEndProductManagerJob(job = '') {
  return /c\s*端|C端|用户\s*产品|社区\s*产品/i.test(String(job || ''));
}

// 岗位 -> 内置技能目录 注册表（顺序即匹配优先级）
// AI 岗由 isAiProductManagerJob 单独分支处理（含黑名单剔除），此处保留仅为兜底查表。
export const JOB_SKILL_CATALOG_REGISTRY = [
  { id: 'data', match: isDataProductManagerJob, catalog: DATA_PM_SKILL_CATALOG, stageMap: DATA_PM_STAGE_MAP },
  { id: 'strategy', match: isStrategyProductManagerJob, catalog: STRATEGY_PM_SKILL_CATALOG, stageMap: STRATEGY_PM_STAGE_MAP },
  { id: 'growth', match: isGrowthProductManagerJob, catalog: GROWTH_PM_SKILL_CATALOG, stageMap: GROWTH_PM_STAGE_MAP },
  { id: 'b_end', match: isBEndProductManagerJob, catalog: B_END_PM_SKILL_CATALOG, stageMap: B_END_PM_STAGE_MAP },
  { id: 'c_end', match: isCEndProductManagerJob, catalog: C_END_PM_SKILL_CATALOG, stageMap: C_END_PM_STAGE_MAP },
];

// 按岗位名解析出对应的内置目录；未命中时使用通用产品经理目录
function resolveCatalogByJob(job) {
  const hit = JOB_SKILL_CATALOG_REGISTRY.find((r) => r.match && r.match(job));
  if (hit) return { id: hit.id, catalog: hit.catalog, stageMap: hit.stageMap };
  return { id: 'general', catalog: GENERAL_PM_SKILL_CATALOG, stageMap: GENERAL_PM_STAGE_MAP };
}

// 把内置目录转换为技能树形态（与 AI 产品经理分支的返回结构保持一致）
function buildCatalogSkills(catalog, stageMap) {
  return catalog.map((s) => {
    const st = stageMap.find((m) => m.skills.includes(s.name));
    return {
      skill_id: makeSkillId(s.name),
      standard_name: s.name,
      aliases: [s.name, ...(s.aliases || [])],
      category: s.category,
      level: s.level,
      weight: typeof s.weight === 'number' ? s.weight : 0.1,
      stage: st ? st.stage : '',
      searchIntent: st ? st.searchIntent : '',
    };
  });
}

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
  // 【兜底】LLM 技能抽取返回空（欠费/限流/网络失败）时，按岗位返回内置能力目录。
  // 否则下游 buildCombinedPlan 的 fallbackSections() 会因无技能而产出 0 个板块，
  // 表现为「学习路线生成成功，但每日计划落库失败：未找到对应的阶段计划」。
  if (!out.length) {
    const resolved = resolveCatalogByJob(job);
    const skills = buildCatalogSkills(resolved.catalog, resolved.stageMap);
    console.warn(`[skillNormalizer] 技能树抽取为空，已启用内置目录兜底: job=${job}, 目录=${resolved.id}, 技能数=${skills.length}`);
    return {
      job: String(job || '').trim(),
      skills,
      dropped: [],
      usedFallbackCatalog: true,
      catalogId: resolved.id,
    };
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
