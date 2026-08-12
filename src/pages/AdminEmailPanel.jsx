import { useMemo, useState } from 'react';
import {
  Bell,
  CalendarDays,
  Clock3,
  Mail,
  RefreshCw,
  Settings2,
  ShieldAlert,
  Sparkles,
} from 'lucide-react';

const seedInbox = [
  {
    id: 1,
    company: '星海智能',
    role: 'AI产品经理',
    sender: 'hr@starsea.ai',
    subject: '面试邀请：AI产品经理一面',
    date: '2026-08-02',
    period: '上午',
    time: '10:00',
    status: 'new',
  },
  {
    id: 2,
    company: '远见数据',
    role: '数据产品经理',
    sender: 'talent@visiondata.com',
    subject: '二面时间确认',
    date: '2026-08-02',
    period: '下午',
    time: '15:00',
    status: 'processed',
  },
];

const seedRules = [
  { id: 'rule_1', name: '面试邀请识别', desc: '自动识别“面试邀请 / 面试安排 / 时间确认”类邮件', enabled: true },
  { id: 'rule_2', name: '半天冲突检查', desc: '同一天上午或下午只接受一场面试', enabled: true },
  { id: 'rule_3', name: '改期回复草稿', desc: '有冲突时自动生成婉拒 + 希望改期的回复内容', enabled: true },
];

function statusBadge(status) {
  if (status === 'processed') return 'bg-emerald-50 text-emerald-600';
  return 'bg-amber-50 text-amber-600';
}

export default function AdminEmailPanel() {
  const [connected, setConnected] = useState(false);
  const [provider, setProvider] = useState('gmail');
  const [pollingMinutes, setPollingMinutes] = useState(10);
  const [rules, setRules] = useState(seedRules);
  const [emails] = useState(seedInbox);

  const stats = useMemo(() => ({
    total: emails.length,
    newCount: emails.filter((item) => item.status === 'new').length,
    processed: emails.filter((item) => item.status === 'processed').length,
  }), [emails]);

  const toggleRule = (id) => {
    setRules((prev) => prev.map((item) => (item.id === id ? { ...item, enabled: !item.enabled } : item)));
  };

  return (
    <div className="min-h-screen bg-warm-white p-4 md:p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        <section className="card overflow-hidden">
          <div className="relative rounded-2xl bg-[radial-gradient(circle_at_top_left,_rgba(111,196,175,0.22),_transparent_34%),linear-gradient(135deg,#fffdf8_0%,#f4fbf8_48%,#f7f4ee_100%)] p-6 md:p-8">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="max-w-3xl">
                <p className="text-sm font-semibold text-mint mb-2">邮件管理中心</p>
                <h1 className="text-3xl font-bold text-gray-900 mb-3">求职邮箱管理</h1>
                <p className="text-sm text-gray-600 leading-7">
                  这里用于统一管理邮箱监听、面试邀请识别、冲突检测和回复草稿策略。你后面接入 Gmail 或 Outlook 后，
                  管理员就可以在这里统一维护邮件规则。
                </p>
              </div>

              <div className="rounded-2xl bg-white/85 border border-white shadow-sm px-4 py-4 min-w-[240px]">
                <div className="flex items-center gap-2 text-sm font-semibold text-gray-800">
                  <Mail className="w-4 h-4 text-mint" />
                  当前邮箱状态
                </div>
                <div className="mt-3 space-y-2 text-sm text-gray-600">
                  <p>服务商：{provider === 'gmail' ? 'Gmail' : 'Outlook'}</p>
                  <p>监听状态：{connected ? '已绑定' : '未绑定'}</p>
                  <p>轮询频率：每 {pollingMinutes} 分钟</p>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="card">
            <p className="text-sm text-gray-500">邮件总数</p>
            <p className="text-3xl font-bold text-gray-900 mt-2">{stats.total}</p>
          </div>
          <div className="card">
            <p className="text-sm text-gray-500">待处理邀请</p>
            <p className="text-3xl font-bold text-amber-600 mt-2">{stats.newCount}</p>
          </div>
          <div className="card">
            <p className="text-sm text-gray-500">已处理邮件</p>
            <p className="text-3xl font-bold text-emerald-600 mt-2">{stats.processed}</p>
          </div>
        </section>

        <section className="grid grid-cols-1 xl:grid-cols-3 gap-5">
          <div className="card">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-11 h-11 rounded-2xl bg-mint/10 text-mint flex items-center justify-center">
                <Mail className="w-5 h-5" />
              </div>
              <div>
                <h2 className="font-bold text-gray-900">邮箱接入</h2>
                <p className="text-xs text-gray-500">管理求职邮箱连接</p>
              </div>
            </div>

            <div className="space-y-3">
              <div>
                <label className="text-xs text-gray-500 block mb-1">邮箱服务商</label>
                <select
                  value={provider}
                  onChange={(e) => setProvider(e.target.value)}
                  className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm focus:outline-none focus:border-mint"
                >
                  <option value="gmail">Gmail</option>
                  <option value="outlook">Outlook</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">监听频率</label>
                <select
                  value={pollingMinutes}
                  onChange={(e) => setPollingMinutes(Number(e.target.value))}
                  className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm focus:outline-none focus:border-mint"
                >
                  <option value={5}>每 5 分钟</option>
                  <option value={10}>每 10 分钟</option>
                  <option value={15}>每 15 分钟</option>
                </select>
              </div>
            </div>

            <button
              onClick={() => setConnected((prev) => !prev)}
              className={`mt-5 w-full rounded-xl py-3 text-sm font-semibold transition-colors ${
                connected ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-gray-900 text-white'
              }`}
            >
              {connected ? '已绑定邮箱（点击断开演示）' : '绑定求职邮箱（演示）'}
            </button>
          </div>

          <div className="card xl:col-span-2">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-11 h-11 rounded-2xl bg-sky-100 text-sky-600 flex items-center justify-center">
                <Settings2 className="w-5 h-5" />
              </div>
              <div>
                <h2 className="font-bold text-gray-900">邮件规则配置</h2>
                <p className="text-xs text-gray-500">控制识别、冲突判断与回复策略</p>
              </div>
            </div>

            <div className="space-y-3">
              {rules.map((rule) => (
                <div key={rule.id} className="rounded-2xl border border-gray-100 bg-warm-white/60 px-4 py-4 flex items-center justify-between gap-4">
                  <div>
                    <p className="font-semibold text-gray-900">{rule.name}</p>
                    <p className="text-sm text-gray-500 mt-1">{rule.desc}</p>
                  </div>
                  <button
                    onClick={() => toggleRule(rule.id)}
                    className={`px-3 py-1.5 rounded-full text-xs font-semibold ${
                      rule.enabled ? 'bg-mint text-white' : 'bg-gray-100 text-gray-500'
                    }`}
                  >
                    {rule.enabled ? '已开启' : '已关闭'}
                  </button>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="card">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
            <div>
              <h2 className="text-xl font-bold text-gray-900">最近邮件与面试识别结果</h2>
              <p className="text-sm text-gray-500 mt-1">这里先用页面骨架把后台搭好，后面接真实邮箱后直接替换数据源。</p>
            </div>
            <div className="flex items-center gap-2 text-sm text-gray-500">
              <RefreshCw className="w-4 h-4" />
              最近同步：刚刚
            </div>
          </div>

          <div className="space-y-4">
            {emails.map((item) => (
              <div key={item.id} className="rounded-2xl border border-gray-100 bg-warm-white/50 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="font-bold text-gray-900">{item.company}</h3>
                      <span className={`px-2 py-1 rounded-full text-xs font-semibold ${statusBadge(item.status)}`}>
                        {item.status === 'processed' ? '已处理' : '待处理'}
                      </span>
                    </div>
                    <p className="text-sm text-gray-600 mt-1">{item.role}</p>
                    <p className="text-xs text-gray-400 mt-1">{item.sender}</p>
                    <p className="text-sm text-gray-700 mt-3">{item.subject}</p>
                  </div>

                  <div className="text-sm text-gray-600 space-y-2">
                    <div className="flex items-center gap-2">
                      <CalendarDays className="w-4 h-4 text-mint" />
                      {item.date}
                    </div>
                    <div className="flex items-center gap-2">
                      <Clock3 className="w-4 h-4 text-mint" />
                      {item.period} {item.time}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <div className="card">
            <div className="flex items-center gap-2 mb-3">
              <ShieldAlert className="w-5 h-5 text-amber-500" />
              <h2 className="font-bold text-gray-900">冲突处理策略</h2>
            </div>
            <ul className="space-y-2 text-sm text-gray-600">
              <li>同一天的上午只接受一场面试</li>
              <li>同一天的下午只接受一场面试</li>
              <li>发现冲突时，只生成回复草稿，不自动发信</li>
              <li>无冲突时，先询问用户，再加入月历</li>
            </ul>
          </div>

          <div className="card">
            <div className="flex items-center gap-2 mb-3">
              <Sparkles className="w-5 h-5 text-mint" />
              <h2 className="font-bold text-gray-900">下一步接入建议</h2>
            </div>
            <ul className="space-y-2 text-sm text-gray-600">
              <li>接 Gmail / Outlook 授权登录</li>
              <li>把真实邮件写入管理员邮件中心</li>
              <li>把识别出的面试邀请同步到求职月历</li>
              <li>把改期回复草稿输出到用户端复制发送</li>
            </ul>
          </div>
        </section>
      </div>
    </div>
  );
}
