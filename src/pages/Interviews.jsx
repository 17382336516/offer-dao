import { useEffect, useMemo, useState } from 'react';
import {
  Bell,
  BookOpen,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Copy,
  Mail,
  Plus,
  Save,
  ShieldAlert,
} from 'lucide-react';
import { confirmInterviewEvent, getInterviewEvents, getInterviewSchedules, getMailboxAccount, getMailboxInvites, saveMailboxAccount, testMailboxAccount } from '../lib/api';

const seedInterviews = [
  { id: 1, company: '星海科技', role: 'AI 产品经理', date: '2026-08-03', period: '上午', time: '10:00', status: 'confirmed' },
  { id: 2, company: '云帆数据', role: '策略产品经理', date: '2026-08-05', period: '下午', time: '14:30', status: 'confirmed' },
];

const seedInvite = {
  id: 101,
  company: '远见智能',
  role: 'AI 策略产品经理',
  date: '2026-08-03',
  period: '上午',
  time: '11:00',
  sender: '招聘团队 <talent@vision-ai.example>',
};

const providerPresets = {
  qq: { imapHost: 'imap.qq.com', imapPort: 993, smtpHost: 'smtp.qq.com', smtpPort: 465 },
  gmail: { imapHost: 'imap.gmail.com', imapPort: 993, smtpHost: 'smtp.gmail.com', smtpPort: 465 },
  outlook: { imapHost: 'outlook.office365.com', imapPort: 993, smtpHost: 'smtp.office365.com', smtpPort: 587 },
  netease: { imapHost: 'imap.163.com', imapPort: 993, smtpHost: 'smtp.163.com', smtpPort: 465 },
};

const dateKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export default function Interviews() {
  const [tab, setTab] = useState('inbox');
  const [month, setMonth] = useState(new Date(2026, 7, 1));
  const [interviews, setInterviews] = useState(seedInterviews);
  const [invite, setInvite] = useState(seedInvite);
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState('');
  const [mailbox, setMailbox] = useState({
    provider: 'qq',
    email: '',
    authCode: '',
    imapHost: 'imap.qq.com',
    imapPort: 993,
    smtpHost: 'smtp.qq.com',
    smtpPort: 465,
    enabled: false,
    pollingMinutes: 10,
  });
  const [accounts, setAccounts] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const hasAny = accounts.length > 0;

  const normalizeInvite = (item) => ({
    id: item.id || Date.now(),
    company: item.company || '未知公司',
    role: item.role || '待确认岗位',
    date: item.date || '',
    period: item.period || '',
    time: item.time || '',
    sender: item.sender || '',
  });

  useEffect(() => {
    (async () => {
      try {
        const data = await getMailboxAccount();
        if (data) {
          setMailbox(data.account || data);
          setAccounts(data.accounts || []);
        }
      } catch {}
    })();
    (async () => {
      try {
        const items = await getInterviewEvents();
        const schedules = await getInterviewSchedules();
        if (schedules.length) {
          setInterviews(schedules.map(normalizeInvite));
        } else if (items.length) {
          setInterviews(items.filter((item) => item.status === 'confirmed'));
        }
        if (items.length) {
          const pending = items.find((item) => item.status === 'pending');
          if (pending) setInvite(normalizeInvite(pending));
        }
      } catch {}
    })();
  }, []);

  const emailConnected = !!(mailbox.email && mailbox.authCode);
  const conflict = invite && interviews.some((i) => i.date === invite.date && i.period === invite.period && i.status === 'confirmed');

  const declineText =
    invite &&
    `您好，感谢 ${invite.company} 的面试邀请。我非常期待与团队交流，但该时间段已有无法调整的安排。请问是否可以改到 8 月 3 日下午，或 8 月 4 日上午？给您带来不便，敬请谅解，谢谢。`;

  const days = useMemo(() => {
    const y = month.getFullYear();
    const m = month.getMonth();
    const leading = new Date(y, m, 1).getDay();
    const count = new Date(y, m + 1, 0).getDate();
    return [...Array(leading).fill(null), ...Array.from({ length: count }, (_, i) => new Date(y, m, i + 1))];
  }, [month]);

  const addInvite = () => {
    if (!invite || conflict) return;
    (async () => {
      try {
        const result = await confirmInterviewEvent(invite.id);
        setInterviews((result.schedules || []).map(normalizeInvite));
        const pending = (result.items || []).find((item) => item.status === 'pending');
        setInvite(pending ? normalizeInvite(pending) : null);
        setTab('calendar');
        setNotice('已将这场面试加入你的个人月历。');
      } catch (e) {
        setNotice(e.message || '面试确认失败');
      }
    })();
  };

  const copyReply = async () => {
    await navigator.clipboard.writeText(declineText);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const changeProvider = (provider) => {
    const preset = providerPresets[provider];
    setMailbox((prev) => ({ ...prev, provider, ...preset }));
  };

  const saveMailbox = async () => {
    setSaving(true);
    setNotice('');
    try {
      const data = await saveMailboxAccount(mailbox);
      setAccounts(data.accounts || []);
      const saved = data.accounts?.find((a) => a.email === mailbox.email) || data.account;
      if (saved) setMailbox(saved);
      setShowForm(false);
      setNotice('邮箱配置已保存。后续会按你的邮箱配置监听面试邀请。');
    } catch (e) {
      setNotice(e.message || '邮箱配置保存失败');
    } finally {
      setSaving(false);
    }
  };

  const handleTestMailbox = async () => {
    setTesting(true);
    setNotice('');
    try {
      const res = await testMailboxAccount(mailbox.email);
      setNotice(`邮箱连接成功，当前收件箱共有 ${res.exists || 0} 封邮件。`);
    } catch (e) {
      setNotice(e.message || '邮箱连接失败');
    } finally {
      setTesting(false);
    }
  };

  const handleDeleteAccount = async (email) => {
    if (!window.confirm(`确定解绑邮箱「${email}」吗？`)) return;
    setNotice('');
    try {
      const list = await deleteMailboxAccount(email);
      setAccounts(list);
      if (mailbox.email === email) {
        const next = list[0];
        setMailbox(next ? { ...next, authCode: next.authCode || '' } : {
          provider: 'qq',
          email: '',
          authCode: '',
          imapHost: 'imap.qq.com',
          imapPort: 993,
          smtpHost: 'smtp.qq.com',
          smtpPort: 465,
          enabled: false,
          pollingMinutes: 10,
        });
      }
      setNotice(`已解绑 ${email}。`);
      if (!list.length) setShowForm(false);
    } catch (e) {
      setNotice(e.message || '解绑失败');
    }
  };

  const handleUseAccount = (acc) => {
    setMailbox({ ...acc, authCode: acc.authCode || '' });
    setShowForm(true);
  };

  const openAddForm = () => {
    setMailbox({
      provider: 'qq',
      email: '',
      authCode: '',
      imapHost: 'imap.qq.com',
      imapPort: 993,
      smtpHost: 'smtp.qq.com',
      smtpPort: 465,
      enabled: true,
      pollingMinutes: 10,
    });
    setShowForm(true);
  };

  const handleSyncInvites = async () => {
    setSyncing(true);
    setNotice('');
    try {
      const res = await getMailboxInvites(10);
      const items = Array.isArray(res.items) ? res.items : [];
      if (items.length > 0) {
        const schedules = await getInterviewSchedules();
        setInterviews((schedules || []).map(normalizeInvite));
        const pending = items.find((item) => item.status === 'pending');
        setInvite(pending ? normalizeInvite(pending) : null);
        setNotice(`已从你的邮箱中识别出 ${items.length} 条疑似面试邀请，已展示最新一条。`);
      } else {
        setInvite(null);
        setNotice(`最近扫描了 ${res.scanned || 0} 封邮件，暂未发现面试邀请。`);
      }
    } catch (e) {
      setNotice(e.message || '邮件同步失败');
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="min-h-screen bg-warm-white p-4 md:p-8">
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm text-mint font-semibold mb-1">面试管家</p>
            <h1 className="text-2xl font-bold text-gray-900">面试日历</h1>
            <p className="text-sm text-gray-500 mt-1">在这里绑定你自己的邮箱，识别面试邀请，并管理你的个人面试月历。</p>
          </div>
          {hasAny ? (
            <button onClick={() => setShowForm((v) => !v)} className="px-4 py-2.5 rounded-xl text-sm font-semibold bg-mint/10 text-mint hover:bg-mint/20">
              <Mail className="w-4 h-4 inline mr-2" />
              + 添加更多邮箱
            </button>
          ) : (
            <div className="px-4 py-2.5 rounded-xl text-sm font-semibold bg-gray-900 text-white">
              <Mail className="w-4 h-4 inline mr-2" />
              请先绑定求职邮箱
            </div>
          )}
        </div>

        {notice ? <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}</div> : null}

        <div className="card">
          <div className="flex items-center gap-2 mb-4">
            <Mail className="w-5 h-5 text-mint" />
            <h2 className="text-lg font-bold text-gray-800">绑定你的邮箱</h2>
          </div>
          {!hasAny && (
            <p className="text-gray-500 text-sm mb-4">支持 QQ、Gmail、Outlook、网易（163/126）邮箱。请绑定<b className="text-gray-700 font-medium">你自己的邮箱</b>，以便为你单独抓取面试通知——不会与其他账号共用。可绑定多个邮箱，互不干扰。</p>
          )}

          {showForm && accounts.length > 0 && (
            <div className="mb-5">
              <p className="text-xs text-gray-500 mb-2">已绑定的邮箱（{accounts.length}）</p>
              <div className="space-y-2">
                {accounts.map((acc) => (
                  <div key={acc.accountId || acc.email} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gray-100 bg-gray-50 px-4 py-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <span className={`w-2.5 h-2.5 rounded-full ${acc.connected ? 'bg-mint' : 'bg-gray-300'}`} />
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-800 truncate">{acc.email}</p>
                        <p className="text-xs text-gray-500">
                          {acc.provider === 'qq' ? 'QQ 邮箱' : acc.provider === 'gmail' ? 'Gmail' : acc.provider === 'outlook' ? 'Outlook' : acc.provider === 'netease' ? '网易邮箱' : acc.provider}
                          {acc.enabled ? ' · 监听中' : ' · 未监听'}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button onClick={() => handleUseAccount(acc)} className="px-3 py-1.5 rounded-lg border border-gray-200 text-xs text-gray-600 hover:bg-white">编辑</button>
                      <button onClick={() => handleDeleteAccount(acc.email)} className="px-3 py-1.5 rounded-lg border border-rose-200 text-xs text-rose-600 hover:bg-rose-50">解绑</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {(!hasAny || showForm) && (
            <>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
            <div>
              <label className="text-xs text-gray-500 block mb-1">邮箱类型</label>
              <select value={mailbox.provider} onChange={(e) => changeProvider(e.target.value)} className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm focus:outline-none focus:border-mint">
                <option value="qq">QQ 邮箱</option>
                <option value="gmail">Gmail</option>
                <option value="outlook">Outlook</option>
                <option value="netease">网易邮箱（163/126）</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">邮箱账号</label>
              <input value={mailbox.email} onChange={(e) => setMailbox((prev) => ({ ...prev, email: e.target.value }))} className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm focus:outline-none focus:border-mint" placeholder="请输入邮箱地址" />
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">授权码</label>
              <input value={mailbox.authCode} onChange={(e) => setMailbox((prev) => ({ ...prev, authCode: e.target.value }))} className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm focus:outline-none focus:border-mint" placeholder="邮箱授权码（非登录密码）" />
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">监听频率</label>
              <select value={mailbox.pollingMinutes} onChange={(e) => setMailbox((prev) => ({ ...prev, pollingMinutes: Number(e.target.value) }))} className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm focus:outline-none focus:border-mint">
                <option value={5}>每 5 分钟</option>
                <option value={10}>每 10 分钟</option>
                <option value={15}>每 15 分钟</option>
              </select>
            </div>
          </div>

          <div className="mt-3 rounded-xl bg-gray-50 border border-gray-100 px-4 py-3 text-xs text-gray-600 leading-relaxed">
            <p className="font-medium text-gray-700 mb-1">授权码去哪里找？（不是邮箱登录密码）</p>
            {mailbox.provider === 'qq' && (
              <p>QQ 邮箱：登录 <a href="https://mail.qq.com" target="_blank" rel="noreferrer" className="text-mint underline">mail.qq.com</a> → 设置 → 账户 → 开启「IMAP/SMTP 服务」→ 按提示发短信 → 页面会生成一串 <b>16 位授权码</b>，复制填到上方即可。</p>
            )}
            {mailbox.provider === 'gmail' && (
              <p>Gmail：访问 <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer" className="text-mint underline">Google 应用专用密码</a> → 需先开启两步验证 → 生成 16 位「应用专用密码」填入上方（若只填密码会连不上）。</p>
            )}
            {mailbox.provider === 'outlook' && (
              <p>Outlook：通常直接用微软账户<b>登录密码</b>即可；若开启了双重验证，需到 <a href="https://account.microsoft.com/security" target="_blank" rel="noreferrer" className="text-mint underline">Microsoft 安全中心</a> → 高级安全选项 → 创建「应用密码」后填入。</p>
            )}
            {mailbox.provider === 'netease' && (
              <p>网易邮箱（163/126）：登录 <a href="https://mail.163.com" target="_blank" rel="noreferrer" className="text-mint underline">mail.163.com</a> → 设置 → POP3/SMTP/IMAP → 开启「IMAP/SMTP 服务」→ 按提示发短信验证 → 页面生成一串<b>授权码</b>，复制填到上方（126 邮箱在 mail.126.com 走相同路径，授权码通用）。</p>
            )}
            <p className="mt-1 text-gray-400">服务器地址与端口已根据你的邮箱类型自动匹配，无需手动填写。</p>
          </div>

          <div className="flex flex-wrap items-center gap-3 mt-5">
            <label className="inline-flex items-center gap-2 text-sm text-gray-600">
              <input type="checkbox" checked={mailbox.enabled} onChange={(e) => setMailbox((prev) => ({ ...prev, enabled: e.target.checked }))} className="rounded border-gray-300 text-mint focus:ring-mint" />
              开启面试邮件监听
            </label>
            <button onClick={saveMailbox} disabled={saving} className="px-4 py-2.5 rounded-xl bg-mint text-white text-sm font-semibold hover:bg-mint/90 disabled:opacity-60">
              <Save className="w-4 h-4 inline mr-2" />
              {saving ? '保存中...' : '保存邮箱配置'}
            </button>
            <button onClick={handleTestMailbox} disabled={testing} className="px-4 py-2.5 rounded-xl border border-mint text-mint text-sm font-semibold hover:bg-mint/5 disabled:opacity-60">
              {testing ? '测试中...' : '测试邮箱连接'}
            </button>
            <button onClick={handleSyncInvites} disabled={syncing || !emailConnected} className="px-4 py-2.5 rounded-xl border border-gray-200 text-gray-700 text-sm font-semibold hover:bg-gray-50 disabled:opacity-60">
              {syncing ? '同步中...' : '同步最近面试邀请'}
            </button>
            {showForm && (
              <button onClick={() => setShowForm(false)} className="px-4 py-2.5 rounded-xl border border-gray-200 text-gray-500 text-sm font-semibold hover:bg-gray-50">
                取消
              </button>
            )}
            </div>
            </>
          )}
        </div>

        <div className="inline-flex p-1 bg-white rounded-xl shadow-sm">
          <button onClick={() => setTab('inbox')} className={`px-4 py-2 rounded-lg text-sm font-medium ${tab === 'inbox' ? 'bg-mint text-white' : 'text-gray-500'}`}>
            面试通知 {invite && <span className="ml-1">· 1</span>}
          </button>
          <button onClick={() => setTab('calendar')} className={`px-4 py-2 rounded-lg text-sm font-medium ${tab === 'calendar' ? 'bg-mint text-white' : 'text-gray-500'}`}>
            我的月历
          </button>
        </div>

        {tab === 'inbox' ? (
          <div className="grid lg:grid-cols-[1.2fr_.8fr] gap-5">
            <div className="card">
              <div className="flex items-center justify-between mb-5">
                <div className="flex items-center gap-2"><Bell className="w-5 h-5 text-mint" /><h2 className="font-bold">新面试邀请</h2></div>
                <span className="text-xs px-2 py-1 rounded-full bg-red-50 text-red-500">已识别</span>
              </div>
              {invite ? (
                <div className="border border-gray-100 rounded-2xl p-5">
                  <div className="flex justify-between gap-4">
                    <div>
                      <h3 className="font-bold text-lg text-gray-900">{invite.company}</h3>
                      <p className="text-gray-600">{invite.role}</p>
                      <p className="text-xs text-gray-400 mt-1">{invite.sender}</p>
                    </div>
                    <div className="text-right text-sm text-gray-600">
                      <p>{invite.date}</p>
                      <p className="font-semibold">{invite.period} {invite.time}</p>
                    </div>
                  </div>
                  {conflict ? (
                    <div className="mt-5 bg-amber-50 border border-amber-100 rounded-xl p-4">
                      <div className="flex items-center gap-2 text-amber-700 font-semibold text-sm">
                        <ShieldAlert className="w-4 h-4" />发现时间冲突
                      </div>
                      <p className="text-sm text-amber-700/80 mt-1">当天同一半天已经有面试安排，所以系统不会自动加入月历，而是为你生成改期回复草稿。</p>
                    </div>
                  ) : (
                    <div className="mt-5 bg-emerald-50 rounded-xl p-4 text-sm text-emerald-700">
                      时间没有冲突。确认后，这场面试会加入你的个人月历。
                    </div>
                  )}
                  {!conflict && (
                    <button onClick={addInvite} className="btn-primary mt-4">
                      <Plus className="w-4 h-4 inline mr-1" />
                      确认并加入月历
                    </button>
                  )}
                </div>
              ) : (
                <div className="py-14 text-center text-gray-400">
                  <Check className="w-8 h-8 mx-auto mb-2 text-mint" />
                  所有邀请都已处理
                </div>
              )}
            </div>

            <div className="card">
              <h2 className="font-bold mb-2">改期回复草稿</h2>
              <p className="text-xs text-gray-400 mb-4">系统只生成草稿，由你复制后自行回复邮件。</p>
              {conflict ? (
                <>
                  <div className="bg-warm-white rounded-xl p-4 text-sm text-gray-700 leading-7">{declineText}</div>
                  <button onClick={copyReply} className="w-full mt-4 py-3 rounded-xl border border-mint text-mint font-semibold text-sm hover:bg-mint/5">
                    <Copy className="w-4 h-4 inline mr-2" />
                    {copied ? '已复制' : '复制回复'}
                  </button>
                </>
              ) : (
                <p className="text-sm text-gray-400 py-8 text-center">当前邀请没有冲突，无需生成改期回复。</p>
              )}
            </div>
          </div>
        ) : (
          <div className="card">
            <div className="flex items-center justify-between mb-5">
              <button onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} className="p-2 rounded-lg hover:bg-gray-100"><ChevronLeft className="w-5 h-5" /></button>
              <div className="flex items-center gap-2 font-bold"><CalendarDays className="w-5 h-5 text-mint" />{month.getFullYear()} 年 {month.getMonth() + 1} 月</div>
              <button onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} className="p-2 rounded-lg hover:bg-gray-100"><ChevronRight className="w-5 h-5" /></button>
            </div>
            <div className="grid grid-cols-7 text-center text-xs text-gray-400 mb-2">
              {['日', '一', '二', '三', '四', '五', '六'].map((d) => <div key={d} className="py-2">周{d}</div>)}
            </div>
            <div className="grid grid-cols-7 border-l border-t border-gray-100">
              {days.map((day, idx) => {
                const key = day ? dateKey(day) : '';
                const list = interviews.filter((i) => i.date === key);
                return (
                  <div key={idx} className="min-h-24 md:min-h-32 border-r border-b border-gray-100 p-1.5 md:p-2 bg-white">
                    {day && (
                      <>
                        <span className="text-xs text-gray-500">{day.getDate()}</span>
                        {list.map((i) => (
                          <div key={i.id} className="mt-1 rounded-lg bg-mint/10 text-mint p-1.5 text-[10px] md:text-xs">
                            <p className="font-semibold truncate">{i.company}</p>
                            <p className="flex items-center gap-1"><Clock3 className="w-3 h-3" />{i.period} {i.time}</p>
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
