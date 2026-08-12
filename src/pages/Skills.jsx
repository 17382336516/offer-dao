import React, { useState, useEffect } from 'react';
import { getAiPmSkillTree, getBossRequirements } from '../lib/api';

const CATEGORY_COLOR = {
  硬技能: '#3b82f6',
  软技能: '#22c55e',
  认知: '#f59e0b',
  默认: '#64748b',
};

const INTENT_LABEL = {
  basic: '基础认知',
  product: '产品落地',
  practice: '实战项目',
  trend: '行业趋势',
};

export default function Skills() {
  const [tree, setTree] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expandedStages, setExpandedStages] = useState({});
  const [expandedSkills, setExpandedSkills] = useState({});

  const [bossJobs, setBossJobs] = useState([]);
  const [bossLoading, setBossLoading] = useState(false);
  const [bossError, setBossError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const data = await getAiPmSkillTree('AI产品经理');
        if (data && data.stages) {
          setTree(data);
          // 默认展开所有阶段与技能
          const st = {};
          const sk = {};
          data.stages.forEach((s, i) => {
            st[i] = true;
            s.skills.forEach((skill, j) => { sk[i + '-' + j] = true; });
          });
          setExpandedStages(st);
          setExpandedSkills(sk);
        } else {
          setError('未返回技能树数据');
        }
      } catch (e) {
        setError(e?.message || '技能树加载失败');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const fetchBoss = async () => {
    setBossLoading(true);
    setBossError('');
    try {
      const data = await getBossRequirements('AI产品经理', '全国');
      setBossJobs(data?.jobs || []);
    } catch (e) {
      setBossError(e?.message || 'Boss 获取失败');
    } finally {
      setBossLoading(false);
    }
  };

  const toggleStage = (i) =>
    setExpandedStages((p) => ({ ...p, [i]: !p[i] }));
  const toggleSkill = (key) =>
    setExpandedSkills((p) => ({ ...p, [key]: !p[key] }));

  if (loading) {
    return (
      <div className="skills-page">
        <div className="skills-loading">正在加载固定技能树…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="skills-page">
        <div className="skills-error">⚠️ {error}</div>
      </div>
    );
  }

  return (
    <div className="skills-page">
      <header className="skills-header">
        <h1>AI 产品经理 · 固定能力技能树</h1>
        <p className="skills-sub">
          一层：{tree.stageCount} 大阶段　·　二层：{tree.skillCount} 个核心技能　·　三层：每个技能对应 B站 搜索词
          <br />
          <span className="muted">技能树为固定能力模型（不随小红书趋势变动）；趋势词仅在学习资源搜索时动态追加。</span>
        </p>
      </header>

      <div className="skill-tree">
        {tree.stages.map((stage, i) => (
          <section key={i} className="tree-stage">
            <button className="stage-head" onClick={() => toggleStage(i)}>
              <span className="caret">{expandedStages[i] ? '▾' : '▸'}</span>
              <span className="stage-order">{i + 1}</span>
              <span className="stage-name">{stage.stage}</span>
              <span className="stage-count">{stage.skills.length} 技能</span>
            </button>

            {expandedStages[i] && (
              <div className="stage-body">
                {stage.description && (
                  <p className="stage-desc">{stage.description}</p>
                )}
                <div className="skill-grid">
                  {stage.skills.map((skill, j) => {
                    const key = i + '-' + j;
                    return (
                      <div key={j} className="skill-card">
                        <button className="skill-head" onClick={() => toggleSkill(key)}>
                          <span className="caret">{expandedSkills[key] ? '▾' : '▸'}</span>
                          <span
                            className="skill-dot"
                            style={{ background: CATEGORY_COLOR[skill.category] || CATEGORY_COLOR['默认'] }}
                          />
                          <span className="skill-name">{skill.skillName}</span>
                          <span className="skill-meta">
                            {skill.level} · 权重 {skill.weight}
                          </span>
                        </button>

                        {expandedSkills[key] && (
                          <div className="skill-body">
                            <div className="kw-label">B站 搜索词</div>
                            <div className="kw-list">
                              {skill.keywords.map((k, kIdx) => (
                                <span
                                  key={kIdx}
                                  className={'kw-chip' + (k.isTrend ? ' kw-trend' : '')}
                                  title={INTENT_LABEL[k.intent] || k.intent}
                                >
                                  {k.keyword}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </section>
        ))}
      </div>

      <section className="boss-section">
        <div className="boss-head">
          <h2>Boss 直聘 · 实时岗位需求（技能应用示例）</h2>
          <button className="boss-fetch" onClick={fetchBoss} disabled={bossLoading}>
            {bossLoading ? '获取中…' : '拉取实时岗位'}
          </button>
        </div>
        {bossError && <div className="skills-error">⚠️ {bossError}</div>}
        {bossJobs.length > 0 ? (
          <ul className="boss-list">
            {bossJobs.slice(0, 12).map((job, idx) => (
              <li key={idx} className="boss-item">
                <div className="boss-title">{job.title}</div>
                <div className="boss-meta">
                  <span>{job.company}</span>
                  <span>{job.salary}</span>
                  <span>{job.city}</span>
                </div>
                {job.skills && job.skills.length > 0 && (
                  <div className="boss-skills">
                    {job.skills.slice(0, 8).map((sk, sIdx) => (
                      <span key={sIdx} className="boss-skill">{sk}</span>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">点击「拉取实时岗位」查看该技能树在真实招聘中的应用。</p>
        )}
      </section>

      <style jsx>{`
        .skills-page {
          max-width: 1080px;
          margin: 0 auto;
          padding: 24px 20px 60px;
          color: #e5e7eb;
        }
        .skills-header h1 {
          font-size: 26px;
          margin: 0 0 8px;
        }
        .skills-sub {
          margin: 0;
          font-size: 14px;
          line-height: 1.7;
        }
        .muted { color: #94a3b8; font-size: 13px; }
        .skills-loading, .skills-error {
          padding: 40px;
          text-align: center;
          color: #f87171;
        }
        .skill-tree { margin-top: 24px; display: flex; flex-direction: column; gap: 14px; }
        .tree-stage {
          background: #0f172a;
          border: 1px solid #1e293b;
          border-radius: 12px;
          overflow: hidden;
        }
        .stage-head {
          width: 100%;
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 14px 16px;
          background: transparent;
          border: none;
          color: #f1f5f9;
          cursor: pointer;
          font-size: 17px;
          font-weight: 600;
        }
        .stage-order {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 24px; height: 24px;
          border-radius: 50%;
          background: #2563eb;
          font-size: 13px;
        }
        .stage-name { flex: 1; text-align: left; }
        .stage-count { color: #94a3b8; font-size: 13px; font-weight: 400; }
        .caret { width: 14px; color: #64748b; }
        .stage-body { padding: 4px 16px 16px; }
        .stage-desc { color: #94a3b8; font-size: 13px; margin: 4px 0 14px; }
        .skill-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(220px, 220px));
          justify-content: start;
          gap: 10px;
        }
        .skill-card {
          background: #111827;
          border: 1px solid #1f2937;
          border-radius: 10px;
        }
        .skill-head {
          width: 100%;
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 10px 12px;
          background: transparent;
          border: none;
          color: #e5e7eb;
          cursor: pointer;
          text-align: left;
        }
        .skill-dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
        .skill-name { flex: 1; font-weight: 600; font-size: 14px; }
        .skill-meta { color: #94a3b8; font-size: 12px; white-space: nowrap; }
        .skill-body { padding: 0 12px 12px; max-width: 640px; }
        .kw-label { font-size: 12px; color: #64748b; margin-bottom: 6px; }
        .kw-list { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
        .kw-chip {
          display: flex; align-items: center; justify-content: center;
          min-width: 0;
          padding: 3px 6px;
          background: #1e293b;
          border: 1px solid #334155;
          border-radius: 999px;
          font-size: 12px;
          color: #cbd5e1;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .kw-trend { border-color: #f59e0b; color: #fcd34d; }
        .kw-intent { font-style: normal; font-size: 10px; color: #64748b; }
        .boss-section { margin-top: 40px; }
        .boss-head { display: flex; align-items: center; justify-content: space-between; }
        .boss-head h2 { font-size: 19px; margin: 0; }
        .boss-fetch {
          padding: 8px 16px;
          background: #2563eb;
          color: #fff;
          border: none; border-radius: 8px;
          cursor: pointer; font-size: 13px;
        }
        .boss-fetch:disabled { opacity: 0.6; cursor: default; }
        .boss-list { list-style: none; padding: 0; margin: 16px 0 0; display: grid; gap: 10px; }
        .boss-item {
          background: #0f172a;
          border: 1px solid #1e293b;
          border-radius: 10px;
          padding: 12px 14px;
        }
        .boss-title { font-weight: 600; color: #f1f5f9; }
        .boss-meta { display: flex; gap: 14px; color: #94a3b8; font-size: 13px; margin-top: 4px; }
        .boss-skills { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
        .boss-skill {
          padding: 2px 8px; background: #1e293b; border-radius: 999px;
          font-size: 12px; color: #93c5fd;
        }
      `}</style>
    </div>
  );
}
