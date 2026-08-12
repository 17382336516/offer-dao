import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sparkles, Calendar, Clock, Target, CheckCircle2 } from 'lucide-react';
import { getProfile, saveProfile } from '../lib/api';

const hotJobs = [
  {
    id: 1,
    emoji: '🤖',
    name: 'AI产品经理',
    company: '字节跳动',
    direction: 'ai',
    desc: '聚焦 AI 能力落地，负责模型能力接入、场景设计、效果优化与业务闭环。',
  },
  {
    id: 2,
    emoji: '📊',
    name: '数据产品经理',
    company: '美团',
    direction: 'data',
    desc: '负责数据平台、指标体系、分析产品与数据能力产品化建设。',
  },
  {
    id: 3,
    emoji: '📈',
    name: '增长产品经理',
    company: '拼多多',
    direction: 'growth',
    desc: '围绕拉新、留存、转化和召回设计增长策略与实验方案。',
  },
  {
    id: 4,
    emoji: '💼',
    name: '商业化产品经理',
    company: '滴滴',
    direction: 'monetization',
    desc: '聚焦广告、会员、付费转化等商业化链路，兼顾收入与用户体验。',
  },
  {
    id: 5,
    emoji: '🏢',
    name: 'B端产品经理',
    company: '飞书',
    direction: 'b',
    desc: '面向企业服务、协同办公和业务系统，优化流程效率与组织协作。',
  },
  {
    id: 6,
    emoji: '📱',
    name: 'C端产品经理',
    company: '腾讯',
    direction: 'c',
    desc: '聚焦用户体验、内容分发、核心功能设计与产品活跃提升。',
  },
  {
    id: 7,
    emoji: '🛒',
    name: '电商产品经理',
    company: '阿里巴巴',
    direction: 'ecommerce',
    desc: '负责商品、交易、营销等链路设计，提升转化、复购和经营效率。',
  },
  {
    id: 8,
    emoji: '🧩',
    name: '平台产品经理',
    company: '京东',
    direction: 'platform',
    desc: '建设通用平台能力、中台工具或基础设施，提升多业务协同效率。',
  },
];

const directionLabels = {
  ai: 'AI产品',
  data: '数据产品',
  growth: '增长产品',
  monetization: '商业化产品',
  b: 'B端产品',
  c: 'C端产品',
  ecommerce: '电商产品',
  platform: '平台产品',
};

const MAX_SELECTED_JOBS = 1;

export default function Login() {
  const navigate = useNavigate();
  const [selectedJobIds, setSelectedJobIds] = useState([]);
  const [selectedDate, setSelectedDate] = useState('');
  const [, setLoadingProfile] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [activeTemplate, setActiveTemplate] = useState(null);
  const [saving, setSaving] = useState(false);
  const [selectionMessage, setSelectionMessage] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const profile = await getProfile();
        if (profile) {
          if (profile.targetDate) setSelectedDate(profile.targetDate);

          const directionSet = new Set(
            Array.isArray(profile.directions) && profile.directions.length
              ? profile.directions
              : profile.direction
                ? [profile.direction]
                : []
          );

          const matchedIds = hotJobs
            .filter((job) => directionSet.has(job.direction) || profile.jobName?.includes(job.name))
            .slice(0, MAX_SELECTED_JOBS)
            .map((job) => job.id);

          if (matchedIds.length) setSelectedJobIds(matchedIds);
        }
      } catch {
        // ignore
      } finally {
        setLoadingProfile(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (!selectionMessage) return undefined;
    const timer = window.setTimeout(() => setSelectionMessage(''), 2200);
    return () => window.clearTimeout(timer);
  }, [selectionMessage]);

  const selectedJobs = useMemo(
    () => hotJobs.filter((job) => selectedJobIds.includes(job.id)),
    [selectedJobIds]
  );

  const selectedDirections = useMemo(
    () => selectedJobs.map((job) => job.direction),
    [selectedJobs]
  );

  const targetJobName = useMemo(
    () => selectedJobs.map((job) => job.name).join('、'),
    [selectedJobs]
  );

  const handleTemplateClick = (job) => {
    setActiveTemplate(job);
    setShowModal(true);
  };

  const toggleTemplateSelection = (job) => {
    const isSelected = selectedJobIds.includes(job.id);

    if (isSelected) {
      // 已选中则取消
      setSelectedJobIds((prev) => prev.filter((id) => id !== job.id));
      setSelectionMessage(`已取消：${job.name}`);
      setShowModal(false);
      return;
    }

    // 单选：直接替换为新选中的岗位
    setSelectedJobIds([job.id]);
    setSelectionMessage(`已选中：${job.name}`);
    setShowModal(false);
  };

  const clearSelectedJobs = () => {
    setSelectedJobIds([]);
    setSelectionMessage('已清空目标岗位');
  };

  const handleSubmit = async () => {
    setSaving(true);

    const days = selectedDate ? calculateDaysRemaining(selectedDate) : 90;
    const primaryJob = selectedJobs[0] || hotJobs[0];
    const jobInfo = {
      jobName: targetJobName || primaryJob.name,
      company: primaryJob.company,
      direction: primaryJob.direction,
      days,
      targetDate: selectedDate,
    };

    // 统一真源：只写 targetDate，days 由后端/本地派生，避免三处数据打架
    localStorage.setItem('offerToJobInfo', JSON.stringify(jobInfo));

    try {
      await saveProfile({
        jobName: jobInfo.jobName,
        company: jobInfo.company,
        direction: jobInfo.direction,
        directions: selectedDirections,
        subfield: '',
        targetDate: jobInfo.targetDate,
        jdText: '',
      });
    } catch (e) {
      console.warn('保存目标岗位失败（不影响继续使用）:', e.message);
    }

    navigate('/plan', { state: jobInfo });
  };

  const quickOptions = ['1个月', '2个月', '3个月', '4个月', '5个月', '6个月', '9个月', '12个月'];

  return (
    <div className="min-h-screen bg-warm-white p-4 md:p-6">
      <div className="max-w-4xl mx-auto">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-mint/20 mb-4">
            <span className="text-3xl">🎯</span>
          </div>
          <h1 className="text-3xl font-bold text-gray-800 mb-2">Offer到</h1>
          <p className="text-gray-500">产品经理求职学习陪跑，帮你更快靠近目标 offer</p>
        </div>

        {selectionMessage && (
          <div className="mb-4 rounded-2xl border border-mint/20 bg-mint/10 px-4 py-3 text-sm text-mint flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4" />
            <span>{selectionMessage}</span>
          </div>
        )}

        {selectedJobs.length > 0 && (
          <div className="card mb-6 flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <Target className="w-5 h-5 text-mint" />
              <div>
                <p className="text-xs text-gray-500">当前目标岗位</p>
                <div className="flex flex-wrap gap-2 mt-2">
                  {selectedJobs.map((job) => (
                    <div
                      key={job.id}
                      className="inline-flex items-center gap-2 rounded-2xl bg-mint/10 text-mint px-3 py-2"
                    >
                      <span>{job.emoji}</span>
                      <span className="text-sm font-semibold">{job.name}</span>
                      <span className="text-xs text-mint/80">{directionLabels[job.direction]}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <button
              className="text-sm text-gray-400 hover:text-red-500 transition-colors"
              onClick={clearSelectedJobs}
            >
              清空
            </button>
          </div>
        )}

        <div className="card mb-6">
          <div className="flex items-center gap-2 mb-4">
            <Sparkles className="w-5 h-5 text-cream" />
            <h2 className="text-lg font-bold text-gray-800">目标岗位</h2>
          </div>
          <p className="text-gray-500 text-sm mb-4">
            选择一个目标岗位。点击卡片查看说明，再设定为你的目标岗位。
          </p>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {hotJobs.map((job) => {
              const isSelected = selectedJobIds.includes(job.id);
              const isDisabled = !isSelected && selectedJobIds.length >= MAX_SELECTED_JOBS;

              return (
                <button
                  key={job.id}
                  onClick={() => handleTemplateClick(job)}
                  disabled={isDisabled}
                  className={`p-4 rounded-card border-2 transition-all duration-200 text-left relative ${
                    isSelected
                      ? 'border-mint bg-mint/5 shadow-light'
                      : isDisabled
                        ? 'border-gray-100 bg-gray-50 opacity-50 cursor-not-allowed'
                        : 'border-gray-100 bg-card-white hover:border-mint/30'
                  }`}
                >
                  {isSelected && (
                    <span className="absolute right-2 top-2 z-10 text-mint bg-white rounded-full shadow-sm">
                      <CheckCircle2 className="w-4 h-4" />
                    </span>
                  )}
                  <span className="text-2xl mb-2 block">{job.emoji}</span>
                  <p className="font-medium text-gray-800 text-sm line-clamp-2">{job.name}</p>
                  <p className="text-xs text-gray-400 mt-1">{job.company}</p>
                  {isDisabled && <p className="text-[11px] text-gray-400 mt-2">已选择 1 个</p>}
                </button>
              );
            })}
          </div>
        </div>

        <div className="card mb-8">
          <div className="flex items-center gap-2 mb-4">
            <Calendar className="w-5 h-5 text-cream" />
            <h2 className="text-lg font-bold text-gray-800">计划投递时间</h2>
          </div>

          <div className="mb-6">
            <label className="text-sm text-gray-500 mb-3 block">选择具体投递日期</label>
            <div className="relative">
              <input
                type="date"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                min={new Date().toISOString().split('T')[0]}
                className="w-full p-4 rounded-xl border border-gray-200 bg-warm-white/50 focus:outline-none focus:border-mint transition-colors text-gray-700"
              />
              <Calendar className="absolute right-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400 pointer-events-none" />
            </div>
          </div>

          {selectedDate && (
            <div className="bg-mint/10 rounded-xl p-4 text-center">
              <div className="flex items-center justify-center gap-2 mb-2">
                <Clock className="w-5 h-5 text-mint" />
                <span className="text-sm text-gray-600">距离投递还剩</span>
              </div>
              <div className="text-4xl font-bold text-mint">
                {calculateDaysRemaining(selectedDate)}
                <span className="text-lg font-normal text-gray-500 ml-1">天</span>
              </div>
              <div className="text-sm text-gray-500 mt-2">目标日期：{formatDate(selectedDate)}</div>
            </div>
          )}

          <div className="mt-6">
            <label className="text-sm text-gray-500 mb-3 block">快速选择</label>
            <div className="flex flex-wrap gap-2">
              {quickOptions.map((option) => {
                const months = parseInt(option, 10);
                const date = new Date();
                date.setMonth(date.getMonth() + months);
                const dateStr = date.toISOString().split('T')[0];
                return (
                  <button
                    key={option}
                    onClick={() => setSelectedDate(dateStr)}
                    className={`px-4 py-2 rounded-button text-sm font-medium transition-all duration-200 ${
                      selectedDate === dateStr
                        ? 'bg-mint text-white'
                        : 'bg-warm-white text-gray-600 border border-gray-200 hover:border-mint/30'
                    }`}
                  >
                    {option}后
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <button
          onClick={handleSubmit}
          disabled={saving}
          className="btn-primary w-full text-lg py-4 disabled:opacity-70 flex items-center justify-center gap-2"
        >
          {saving ? (
            <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
          ) : null}
          {saving ? '正在为你生成学习计划…' : '帮我制定学习计划'}
        </button>

        <p className="text-center text-gray-400 text-sm mt-4">
          已有账号？<span className="text-mint cursor-pointer">立即登录</span>
        </p>
      </div>

      {showModal && activeTemplate && (
        <div
          className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50"
          onClick={() => setShowModal(false)}
        >
          <div
            className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-4xl mb-3">{activeTemplate.emoji}</div>
            <h3 className="text-xl font-bold text-gray-800 mb-1">{activeTemplate.name}</h3>
            <p className="text-sm text-gray-500 mb-2">{activeTemplate.company}</p>
            <p className="text-sm text-gray-500 mb-4">{directionLabels[activeTemplate.direction]}</p>
            <p className="text-gray-600 text-sm leading-relaxed mb-6">{activeTemplate.desc}</p>

            {selectedJobIds.includes(activeTemplate.id) && (
              <div className="mb-4 rounded-xl bg-mint/10 px-3 py-2 text-sm text-mint">
                当前已选中这个岗位
              </div>
            )}

            <div className="flex gap-3">
              <button className="btn-primary flex-1" onClick={() => toggleTemplateSelection(activeTemplate)}>
                {selectedJobIds.includes(activeTemplate.id) ? '取消选中' : '设为我的岗位'}
              </button>
              <button
                className="px-4 py-2 rounded-button border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors"
                onClick={() => setShowModal(false)}
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function calculateDaysRemaining(targetDate) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const target = new Date(targetDate);
  target.setHours(0, 0, 0, 0);

  const diffTime = target - today;
  return Math.max(0, Math.ceil(diffTime / (1000 * 60 * 60 * 24)));
}

function formatDate(dateStr) {
  const date = new Date(dateStr);
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}
