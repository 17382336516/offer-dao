import { useEffect, useState } from 'react';
import { BookOpen, CalendarDays, Clock3 } from 'lucide-react';
import { searchInterviewExperience, getInterviewHistory, getXhsQrcode, bindXhs, getXhsStatus } from '../lib/api';

function safeParse(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

export default function InterviewExperience() {
  const [company, setCompany] = useState('');
  const [role, setRole] = useState('');
  const [round, setRound] = useState('一面');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [needLogin, setNeedLogin] = useState(false);
  const [showXhsModal, setShowXhsModal] = useState(false);
  const [qrImage, setQrImage] = useState('');
  const [qrLoading, setQrLoading] = useState(false);
  const [history, setHistory] = useState([]);

  const loadHistory = async () => {
    try {
      const res = await getInterviewHistory();
      setHistory(Array.isArray(res.items) ? res.items : []);
    } catch { /* 忽略 */ }
  };

  useEffect(() => {
    loadHistory();
  }, []);

  // 真正发起面经生成；useLocalOnly=true 时仅用本地面经库（不抓小红书）
  const runSearch = async (opts = {}) => {
    if (!company.trim() || !role.trim() || !round) {
      setError('请填写公司、岗位并选择轮次');
      return;
    }
    setLoading(true);
    setError('');
    setNeedLogin(false);
    setResult(null);
    try {
      const res = await searchInterviewExperience({
        company: company.trim(),
        role: role.trim(),
        round,
        useLocalOnly: opts.useLocalOnly === true,
      });
      if (res.needLogin) {
        setNeedLogin(true);
        setShowXhsModal(true);
      }
      setResult(res);
    } catch (e) {
      setError(e.message || '面经搜索失败');
    } finally {
      setLoading(false);
      loadHistory();
    }
  };

  // 点击「生成面经」：先判定当前用户是否已绑定小红书（与生成学习计划一致）
  // - 已绑定 -> 直接生成（抓实时面经 + RAG 库），不弹框
  // - 未绑定 -> 弹提示框：建议绑定获取实时面经，也可选「仅用本地面经库」
  const handleGenerate = async () => {
    if (!company.trim() || !role.trim() || !round) {
      setError('请填写公司、岗位并选择轮次');
      return;
    }
    try {
      const st = await getXhsStatus();
      if (st && st.bound) {
        // 已绑定自己的小红书：直接生成，不弹框
        await runSearch();
      } else {
        // 未绑定/未登录：弹出绑定提示框（也可选择仅用本地库）
        setShowXhsModal(true);
      }
    } catch {
      // 探测失败按未绑定处理，弹框让用户选择
      setShowXhsModal(true);
    }
  };

  const loginXhs = async () => {
    setQrLoading(true);
    try {
      const data = await getXhsQrcode();
      if (data?.image) setQrImage(data.image);
      else if (data?.alreadyLoggedIn) await bindXhs();
    } catch (e) {
      setError(e.message || '获取小红书二维码失败');
    } finally { setQrLoading(false); }
  };

  return (
    <div className="min-h-screen bg-warm-white p-4 md:p-8">
      <div className="max-w-6xl mx-auto space-y-6">
        <div>
          <p className="text-sm text-mint font-semibold mb-1">面试管家 · 面经库</p>
          <h1 className="text-2xl font-bold text-gray-900">AI 面经整理</h1>
          <p className="text-sm text-gray-500 mt-1">输入公司与岗位，实时检索小红书面经、查询历史沉淀资料，并由 AI 整理为结构化准备内容。</p>
        </div>

        {/* 搜索条件 */}
        <div className="card">
          <div className="flex items-center gap-2 mb-4">
            <BookOpen className="w-5 h-5 text-mint" />
            <h2 className="font-bold text-gray-800">检索面经</h2>
          </div>
          <div className="grid md:grid-cols-[1fr_1fr_auto_auto] gap-3 items-end">
            <div>
              <label className="block text-xs text-gray-500 mb-1">公司</label>
              <input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="如 百度" className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-mint/40" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">岗位</label>
              <input value={role} onChange={(e) => setRole(e.target.value)} placeholder="如 AI产品经理" className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-mint/40" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">轮次</label>
              <select value={round} onChange={(e) => setRound(e.target.value)} className="px-3 py-2 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-mint/40">
                <option>一面</option>
                <option>二面</option>
                <option>三面</option>
                <option>HR面</option>
                <option>终面</option>
              </select>
            </div>
            <button onClick={handleGenerate} disabled={loading} className="btn-primary whitespace-nowrap disabled:opacity-60">
              {loading ? '整理中…' : '生成面经'}
            </button>
          </div>
          {error && <p className="text-sm text-red-500 mt-3">{error}</p>}
          {needLogin && <p className="text-sm text-amber-600 mt-3">小红书需要登录后才能抓取实时面经，请在「小红书助手」中完成登录。</p>}
          {history.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-2">
              <span className="text-xs text-gray-400">历史：</span>
              {history.slice(0, 8).map((h) => (
                <button key={h.id} onClick={() => { setCompany(h.company); setRole(h.role); setRound(h.round); }} className="text-xs px-2 py-1 rounded-full bg-gray-100 text-gray-600 hover:bg-gray-200">
                  {h.company} {h.role} {h.round}{h.searchIndex ? ` · ${h.searchIndex}次` : ''}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* 结果展示 */}
        {showXhsModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
              <h3 className="text-lg font-bold text-gray-900">小红书面经授权</h3>
              <p className="mt-2 text-sm text-gray-600">当前未获取到可用的小红书面经。扫码登录后可获得更贴合目标公司的真实面经；也可以继续使用 RAG 本地知识库。</p>
              {qrImage && <img src={qrImage} alt="小红书登录二维码" className="mx-auto my-4 h-52 w-52 rounded-lg border" />}
              <div className="mt-5 flex justify-end gap-2">
                <button onClick={() => { setShowXhsModal(false); setQrImage(''); runSearch({ useLocalOnly: true }); }} className="rounded-lg px-3 py-2 text-sm text-gray-600 hover:bg-gray-100">仅使用 RAG 知识库</button>
                <button onClick={loginXhs} disabled={qrLoading} className="btn-primary disabled:opacity-60">{qrLoading ? '获取二维码中…' : qrImage ? '请扫码登录' : '扫码登录小红书'}</button>
              </div>
              {qrImage && <button onClick={() => { setShowXhsModal(false); setQrImage(''); handleGenerate(); }} className="mt-3 w-full rounded-lg bg-mint/10 px-3 py-2 text-sm text-mint">登录完成，重新生成面经</button>}
            </div>
          </div>
        )}

        {result && (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-3">
              <h3 className="font-bold text-lg text-gray-800">{result.company} {result.role} {result.round}面经</h3>
              <span className="text-xs px-2 py-1 rounded-full bg-mint/10 text-mint font-semibold">已整理 {result.searchIndex} 次</span>
            </div>
            <p className="text-xs text-gray-400">
              本次新增：实时小红书 {result.xhsCount} 篇 · 面经素材 {result.ragCount} 条
              {result.isIncremental ? ' · 已追加到已有面经' : ' · 首次创建面经'}
              {result.llmSkipped ? ' · 无新增素材（跳过AI）' : (result.llmUsed ? ' · 已AI整理' : ' · 整理失败')}
            </p>

            {/* 本次新增来源（增量追踪） */}
            {result.incrementSources && result.incrementSources.length > 0 && (
              <div className="card border-mint/30 bg-mint/5">
                <h4 className="font-semibold text-mint mb-3">第 {result.searchIndex} 次新增来源</h4>
                <div className="space-y-2">
                  {result.incrementSources.map((s, i) => {
                    const meta = typeof s.metadata === 'string' ? safeParse(s.metadata) : (s.metadata || {});
                    return (
                      <div key={i} className="text-xs text-gray-600 border border-gray-100 rounded-lg p-3 bg-white">
                        <span className="inline-block px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 mr-2">
                          {s.source_type === 'xiaohongshu' ? '小红书' : '面经素材'}
                        </span>
                        {s.source_type === 'xiaohongshu' ? (meta.title || '帖子') : '检索到的面经原文片段（已用于生成上方问题）'}
                        {meta.author ? <span className="text-gray-400 ml-2">— {meta.author}</span> : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* 区域1：基础问题（合并全部历史 + 本次新增） */}
            <div className="card">
              <h4 className="font-semibold text-mint mb-3">基础问题（AI 生成简短回答）</h4>
              <div className="space-y-3">
                {(result.questions?.basic || []).map((q, i) => (
                  <div key={i} className="border border-gray-100 rounded-xl p-4">
                    <p className="font-medium text-gray-800">{q.question}</p>
                    <p className="text-sm text-gray-600 mt-2">{q.answer}</p>
                  </div>
                ))}
                {(result.questions?.basic || []).length === 0 && <p className="text-sm text-gray-400">暂无</p>}
              </div>
            </div>

            {/* 区域2：产品设计问题 */}
            <div className="card">
              <h4 className="font-semibold text-mint mb-3">产品设计问题（输出回答思路框架）</h4>
              <div className="space-y-3">
                {(result.questions?.product || []).map((q, i) => (
                  <div key={i} className="border border-gray-100 rounded-xl p-4">
                    <p className="font-medium text-gray-800">{q.question}</p>
                    <div className="text-sm text-gray-600 mt-2 whitespace-pre-line">{q.framework}</div>
                  </div>
                ))}
                {(result.questions?.product || []).length === 0 && <p className="text-sm text-gray-400">暂无</p>}
              </div>
            </div>

            {/* 区域3：项目经历问题 */}
            <div className="card">
              <h4 className="font-semibold text-mint mb-3">项目经历问题（结合个人经历）</h4>
              <div className="space-y-3">
                {(result.questions?.project || []).map((q, i) => (
                  <div key={i} className="border border-amber-100 rounded-xl p-4 bg-amber-50/40">
                    <p className="font-medium text-gray-800">{q.question}</p>
                    <p className="text-xs text-amber-600 mt-1">请结合个人经历回答，以下为准备方向：</p>
                    <div className="text-sm text-gray-600 mt-2 whitespace-pre-line">{q.direction}</div>
                  </div>
                ))}
                {(result.questions?.project || []).length === 0 && <p className="text-sm text-gray-400">暂无</p>}
              </div>
            </div>
          </div>
        )}

        {/* 后续扩展：AI 模拟面试入口占位（保持结构可扩展） */}
        <div className="card border-dashed border-gray-200 bg-transparent">
          <div className="flex items-center gap-2 text-gray-400">
            <CalendarDays className="w-4 h-4" />
            <span className="text-xs">AI 模拟面试即将上线 · 可在整理出的面经基础上进行一对一模拟问答</span>
          </div>
        </div>
      </div>
    </div>
  );
}
