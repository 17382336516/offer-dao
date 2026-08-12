import React, { useState } from 'react';
import { Loader2, ChevronDown, Sparkles } from 'lucide-react';

// ============ 尺寸与配色常量（XMind + Notion 低饱和风格） ============
const ROOT_W = 160, ROOT_H = 70;
const STAGE_W = 160, STAGE_H = 70;
const SKILL_W = 160, SKILL_H = 38;
const KW_W = 200;                       // 三级：搜索词节点（比技能列略宽，避免超出卡片）
const COL_GAP = 48;
const ITEM_GAP = 16;
const ROW_GAP = 16;
// 搜索词节点内部排版（纵向单行，避免重叠）
const KW_PAD_Y = 10;
const KW_TITLE_H = 16;
const KW_LINE_H = 24;
// 单个技能的三级节点高度（按搜索词数量自适应）
function kwHeight(keywords) {
  const n = keywords && keywords.length ? keywords.length : 1;
  return KW_PAD_Y * 2 + (n > 1 || (keywords && keywords.length === 1) ? KW_TITLE_H + n * KW_LINE_H : KW_LINE_H);
}

const STAGE_X = ROOT_W + COL_GAP;
const SKILL_X = STAGE_X + STAGE_W + COL_GAP;
const KW_X = SKILL_X + SKILL_W + COL_GAP;
const MAP_WIDTH = KW_X + KW_W;

const STAGE_THEMES = [
  { bg: '#E8F1FB', border: '#BFD8F2', line: '#93C5FD', num: '#3B82F6' }, // 浅蓝
  { bg: '#E6F6EC', border: '#BCE7CA', line: '#86EFAC', num: '#16A34A' }, // 浅绿
  { bg: '#FBF1DD', border: '#F0D9A8', line: '#FCD34D', num: '#D97706' }, // 浅橙
  { bg: '#F0EBFB', border: '#D8CCF0', line: '#C4B5FD', num: '#7C3AED' }, // 浅紫
  { bg: '#E8EBFB', border: '#C3C9F2', line: '#A5B4FC', num: '#4F46E5' }, // 浅蓝紫
];
const DEFAULT_THEME = STAGE_THEMES[0];
const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];

const INTENT_LABEL = { basic: '基础', product: '落地', practice: '实战', trend: '趋势' };

// 把 stages 数据归一为地图坐标模型
function buildModel(stages) {
  const models = (stages || []).map((st, idx) => {
    const theme = STAGE_THEMES[idx] || DEFAULT_THEME;
    const skills = (st.skills || []).map((s) => ({
      name: s.skillName || s.name,
      keywords: (s.keywords || []).map((k) => ({
        keyword: k.keyword,
        intent: k.intent,
        isTrend: k.isTrend,
      })),
    }));
    return { idx, order: st.order || idx + 1, title: st.stage, theme, skills };
  });

  let cursorY = 0;
  const rowHeights = models.map((m) => {
    if (!m.skills.length) return SKILL_H + ITEM_GAP;
    return m.skills.reduce((sum, sk) => sum + Math.max(SKILL_H, kwHeight(sk.keywords)) + ITEM_GAP, 0);
  });
  const totalHeight = rowHeights.reduce((a, b) => a + b, 0) + ROW_GAP * Math.max(models.length - 1, 0);
  const rootCenterY = totalHeight / 2;

  models.forEach((m, i) => {
    const rowH = rowHeights[i];
    const heights = m.skills.map((sk) => Math.max(SKILL_H, kwHeight(sk.keywords)));
    const groupH = heights.length
      ? heights.reduce((a, b) => a + b, 0) + (heights.length - 1) * ITEM_GAP
      : SKILL_H;
    const groupTop = cursorY + (rowH - groupH) / 2;
    let yy = groupTop;
    m.skills.forEach((sk, j) => {
      const h = heights[j];
      sk.top = yy;            // 技能卡与搜索词卡同顶对齐
      sk.centerY = yy + SKILL_H / 2;
      sk.kwHeight = kwHeight(sk.keywords);
      sk.kwTop = yy;
      sk.kwCenterY = yy + sk.kwHeight / 2;
      yy += h + ITEM_GAP;
    });
    const groupCenter = groupTop + groupH / 2;
    m.stageCenterY = groupCenter;
    m.stageTop = groupCenter - STAGE_H / 2;
    cursorY += rowH + ROW_GAP;
  });

  return { models, totalHeight, rootCenterY };
}

function ConnectionLines({ models, rootCenterY }) {
  const paths = [];
  models.forEach((m) => {
    const sy = m.stageCenterY;
    paths.push({
      d: `M ${ROOT_W} ${rootCenterY} C ${ROOT_W + 40} ${rootCenterY}, ${STAGE_X - 40} ${sy}, ${STAGE_X} ${sy}`,
      stroke: m.theme.line,
    });
    m.skills.forEach((sk) => {
      const y = sk.centerY;
      paths.push({
        d: `M ${STAGE_X + STAGE_W} ${sy} C ${STAGE_X + STAGE_W + 30} ${sy}, ${SKILL_X - 30} ${y}, ${SKILL_X} ${y}`,
        stroke: m.theme.line,
      });
      // 技能 -> 搜索词节点（连到搜索词节点垂直中心）
      const ky = sk.kwCenterY;
      paths.push({
        d: `M ${SKILL_X + SKILL_W} ${y} C ${SKILL_X + SKILL_W + 30} ${y}, ${KW_X - 30} ${ky}, ${KW_X} ${ky}`,
        stroke: m.theme.line,
      });
    });
  });
  return (
    <svg className="pointer-events-none absolute inset-0" width={MAP_WIDTH} height="100%" style={{ overflow: 'visible' }}>
      {paths.map((p, i) => (
        <path key={i} d={p.d} fill="none" stroke={p.stroke} strokeWidth={1.5} strokeLinecap="round" />
      ))}
    </svg>
  );
}

export default function SkillTreeMap({ stages, loading, error }) {
  const [collapsed, setCollapsed] = useState({});
  const toggle = (i) => setCollapsed((p) => ({ ...p, [i]: !p[i] }));
  const [mapCollapsed, setMapCollapsed] = useState(false);

  if (loading) {
    return (
      <div className="card p-5 flex items-center gap-2 text-gray-400 text-sm">
        <Loader2 className="w-4 h-4 animate-spin" /> 正在加载能力地图…
      </div>
    );
  }
  if (error) {
    return <div className="card p-5 text-sm text-red-500">⚠️ {error}</div>;
  }
  if (!stages || !stages.length) {
    return (
      <div className="card p-6 text-sm text-gray-400 flex flex-col items-center gap-2 text-center">
        <Sparkles className="w-5 h-5 text-gray-300" />
        暂无能力地图，请先生成学习计划
      </div>
    );
  }

  const { models, totalHeight, rootCenterY } = buildModel(stages);

  return (
    <div className="card p-7 mb-6 overflow-x-auto" style={{ width: '100%' }}>
      <div className="flex items-center justify-between mb-6">
        <button
          type="button"
          onClick={() => setMapCollapsed((v) => !v)}
          className="flex items-center gap-2 group"
        >
          <ChevronDown
            className="w-4 h-4 text-gray-400 transition-transform"
            style={{ transform: mapCollapsed ? 'rotate(-90deg)' : 'none' }}
          />
          <h3 className="font-bold text-gray-800 group-hover:text-mint transition-colors">AI 产品经理 · 能力地图</h3>
        </button>
      </div>

      {!mapCollapsed && (
      <div className="relative" style={{ width: '100%', height: totalHeight, background: '#FAFAF8', overflow: 'visible' }}>
        <ConnectionLines models={models} rootCenterY={rootCenterY} />

        {/* Root 节点 */}
        <div
          className="absolute flex flex-col justify-center px-4"
          style={{ left: 0, top: '50%', transform: 'translateY(-50%)', width: ROOT_W, height: ROOT_H, background: '#FFFFFF', border: '1px solid #CBD5E1', borderRadius: 14, color: '#1E293B', boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}
        >
          <div style={{ fontSize: 16, fontWeight: 700, lineHeight: 1.2 }}>AI产品能力地图</div>
          <div style={{ fontSize: 12, color: '#64748B', marginTop: 4 }}>固定能力模型</div>
        </div>

        {models.map((m, i) => {
          const isCollapsed = collapsed[i];
          return (
            <React.Fragment key={i}>
              {/* 一级：板块 */}
              <div
                className="absolute group"
                style={{ left: STAGE_X, top: m.stageTop, width: STAGE_W, height: STAGE_H }}
              >
                <div
                  onClick={() => toggle(i)}
                  className="relative h-full w-full flex items-center gap-2 px-3 cursor-pointer transition-all hover:-translate-y-0.5"
                  style={{ background: m.theme.bg, border: `1px solid ${m.theme.border}`, borderRadius: 12, boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}
                >
                  <span
                    className="flex items-center justify-center rounded-full shrink-0"
                    style={{ width: 26, height: 26, background: '#fff', color: m.theme.num, fontSize: 14, fontWeight: 700, border: `1px solid ${m.theme.border}` }}
                  >
                    {CIRCLED[m.idx] || m.order}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div style={{ fontSize: 12, color: '#64748B' }}>阶段 {m.order}</div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: '#334155', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.title}</div>
                  </div>
                </div>
              </div>

              {/* 二级：技能 + 三级：搜索词 */}
              {!isCollapsed &&
                m.skills.map((sk, j) => (
                  <React.Fragment key={j}>
                    <div
                      className="absolute flex items-center px-3 transition-all hover:-translate-y-0.5"
                      style={{ left: SKILL_X, top: sk.top, width: SKILL_W, height: SKILL_H, background: '#FFFFFF', border: '1px solid #E5E7EB', borderRadius: 8, boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}
                    >
                      <span style={{ width: 6, height: 6, borderRadius: '50%', background: m.theme.num, marginRight: 8, flex: 'none' }} />
                      <span style={{ fontSize: 14, color: '#334155', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }} title={sk.name}>{sk.name}</span>
                    </div>

                    <div
                      className="absolute px-3 transition-all hover:-translate-y-0.5"
                      style={{ left: KW_X, top: sk.kwTop, width: KW_W, height: sk.kwHeight, background: '#F8F8F7', border: '1px solid #E7E5E4', borderRadius: 8 }}
                    >
                      {sk.keywords.length ? (
                        <>
                          <div style={{ fontSize: 11, color: '#94A3B8', height: KW_TITLE_H, lineHeight: KW_TITLE_H + 'px' }}>
                            搜索词 · {sk.keywords.length}
                          </div>
                          <div className="flex flex-col gap-1" style={{ paddingBottom: KW_PAD_Y }}>
                            {sk.keywords.map((k, kIdx) => (
                              <span
                                key={kIdx}
                                className={'inline-flex items-center gap-1.5 px-2 rounded-md text-[12px] leading-[20px] ' + (k.isTrend ? 'text-amber-700' : 'text-slate-600')}
                                style={{ background: k.isTrend ? '#FEF3C7' : '#FFFFFF', border: '1px solid ' + (k.isTrend ? '#FDE68A' : '#EAEAEC') }}
                                title={k.keyword}
                              >
                                <span style={{ width: 5, height: 5, borderRadius: '50%', background: k.isTrend ? '#F59E0B' : m.theme.num, flex: 'none' }} />
                                {k.keyword}
                              </span>
                            ))}
                          </div>
                        </>
                      ) : (
                        <div className="flex items-center h-full text-[12px] text-slate-400">暂无搜索词</div>
                      )}
                    </div>
                  </React.Fragment>
                ))}
            </React.Fragment>
          );
        })}
      </div>
      )}
    </div>
  );
}
