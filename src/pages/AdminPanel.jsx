import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Briefcase,
  CheckCircle2,
  Clock3,
  Crown,
  Database,
  KeyRound,
  RefreshCw,
  Shield,
  Sparkles,
  Users,
} from 'lucide-react';
import {
  getAdminUsers,
  getBossLibraryStatus,
  getBossSession,
  getDirectionConfigs,
  getProfile,
  refreshBossLibrary,
  saveBossSession,
  updateAdminUser,
  updateDirectionConfig,
} from '../lib/api';

function fmtTime(ts) {
  if (!ts) return '暂无';
  try {
    return new Date(ts).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return '暂无';
  }
}

function userTypeLabel(role, tier) {
  if (role === 'admin') return '管理员';
  if (tier === 'member') return '会员用户';
  if (role === 'guest') return '访客用户';
  return '普通用户';
}

export default function AdminPanel() {
  const [profile, setProfile] = useState(null);
  const [session, setSession] = useState({ connected: false, cookiePreview: '' });
  const [cookieInput, setCookieInput] = useState('');
  const [library, setLibrary] = useState({ items: [], schedule: null });
  const [directions, setDirections] = useState([]);
  const [userData, setUserData] = useState({ items: [], summary: null });
  const [savingCookie, setSavingCookie] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [savingUserId, setSavingUserId] = useState(0);
  const [savingDirectionId, setSavingDirectionId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const isAdmin = profile?.role === 'admin';

  const overview = useMemo(() => {
    const summary = userData.summary || {};
    return [
      { label: '管理员', value: summary.admins || 0, icon: Shield, tone: 'text-violet-600 bg-violet-50' },
      { label: '会员用户', value: summary.members || 0, icon: Crown, tone: 'text-amber-600 bg-amber-50' },
      { label: '普通用户', value: summary.normalUsers || 0, icon: Users, tone: 'text-sky-600 bg-sky-50' },
      { label: '岗位方向', value: directions.length || 0, icon: Briefcase, tone: 'text-emerald-600 bg-emerald-50' },
    ];
  }, [userData.summary, directions.length]);

  async function loadAll() {
    setLoading(true);
    setError('');
    try {
      const p = await getProfile();
      setProfile(p);
      if (p?.role === 'admin') {
        const [bossSession, libraryStatus, users, directionData] = await Promise.all([
          getBossSession(),
          getBossLibraryStatus(),
          getAdminUsers(),
          getDirectionConfigs(),
        ]);
        setSession(bossSession || { connected: false, cookiePreview: '' });
        setLibrary(libraryStatus || { items: [], schedule: null });
        setUserData(users || { items: [], summary: null });
        setDirections(directionData?.items || []);
      }
    } catch (e) {
      setError(e.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAll();
  }, []);

  async function handleSaveCookie() {
    setSavingCookie(true);
    setError('');
    setNotice('');
    try {
      await saveBossSession(cookieInput);
      setCookieInput('');
      setNotice('Boss 登录态已保存，管理员现在可以刷新真实岗位库。');
      setSession(await getBossSession());
    } catch (e) {
      setError(e.message || '保存失败');
    } finally {
      setSavingCookie(false);
    }
  }

  async function handleRefreshLibrary() {
    setRefreshing(true);
    setError('');
    setNotice('');
    try {
      const res = await refreshBossLibrary();
      setNotice(`本次已刷新 ${res.refreshed || 0} 个岗位方向的本地岗位库。`);
      setLibrary(await getBossLibraryStatus());
    } catch (e) {
      setError(e.message || '刷新失败');
    } finally {
      setRefreshing(false);
    }
  }

  async function handleUserTypeChange(user, nextType) {
    let nextRole = 'user';
    let nextTier = 'normal';
    if (nextType === 'admin') {
      nextRole = 'admin';
      nextTier = 'member';
    } else if (nextType === 'member') {
      nextRole = 'user';
      nextTier = 'member';
    }
    setSavingUserId(user.id);
    setError('');
    setNotice('');
    try {
      await updateAdminUser(user.id, nextRole, nextTier);
      setNotice(`已将 ${user.username} 调整为${userTypeLabel(nextRole, nextTier)}。`);
      setUserData(await getAdminUsers());
    } catch (e) {
      setError(e.message || '用户分类更新失败');
    } finally {
      setSavingUserId(0);
    }
  }

  function handleDirectionFieldChange(id, field, value) {
    setDirections((prev) => prev.map((item) => (item.id === id ? { ...item, [field]: value } : item)));
  }

  async function handleSaveDirection(item) {
    setSavingDirectionId(item.id);
    setError('');
    setNotice('');
    try {
      await updateDirectionConfig({
        id: item.id,
        name: item.name,
        keyword: item.keyword,
        enabled: !!item.enabled,
        fetchCount: Number(item.fetchCount) || 10,
        sampleCount: Number(item.sampleCount) || 5,
        sortOrder: Number(item.sortOrder) || 0,
      });
      setNotice(`岗位方向「${item.name}」已保存。`);
      const directionData = await getDirectionConfigs();
      setDirections(directionData?.items || []);
    } catch (e) {
      setError(e.message || '岗位方向保存失败');
    } finally {
      setSavingDirectionId('');
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-warm-white p-4 md:p-6">
        <div className="max-w-7xl mx-auto">
          <div className="card text-center py-16 text-gray-500">管理员页面加载中...</div>
        </div>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="min-h-screen bg-warm-white p-4 md:p-6">
        <div className="max-w-4xl mx-auto">
          <div className="card text-center py-16">
            <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-red-50 text-red-500 flex items-center justify-center">
              <Shield className="w-8 h-8" />
            </div>
            <h1 className="text-2xl font-bold text-gray-900 mb-2">当前账号不是管理员</h1>
            <p className="text-sm text-gray-500">这个页面只开放给管理员，用来维护 Boss 岗位库、岗位方向和用户分类。</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-warm-white p-4 md:p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        <section className="card overflow-hidden">
          <div className="relative rounded-2xl bg-[radial-gradient(circle_at_top_left,_rgba(111,196,175,0.24),_transparent_34%),linear-gradient(135deg,#fffdf8_0%,#f4fbf8_48%,#f7f4ee_100%)] p-6 md:p-8">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="max-w-3xl">
                <p className="text-sm font-semibold text-mint mb-2">管理员工作台</p>
                <h1 className="text-3xl font-bold text-gray-900 mb-3">Offer 到 · 管理后台</h1>
                <p className="text-sm text-gray-600 leading-7">
                  这里负责管理员 Boss 登录态、岗位方向配置、本地岗位库刷新，以及管理员 / 普通用户 / 会员用户分类维护。
                </p>
              </div>

              <div className="rounded-2xl bg-white/85 border border-white shadow-sm px-4 py-4 min-w-[240px]">
                <div className="flex items-center gap-2 text-sm font-semibold text-gray-800">
                  <Crown className="w-4 h-4 text-amber-500" />
                  当前管理员身份
                </div>
                <div className="mt-3 space-y-2 text-sm text-gray-600">
                  <p>角色：{profile?.role || 'admin'}</p>
                  <p>会员等级：{profile?.tier || 'member'}</p>
                  <p>Boss 状态：{session.connected ? '已绑定' : '未绑定'}</p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {(error || notice) && (
          <div className="space-y-3">
            {error ? <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div> : null}
            {notice ? <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}</div> : null}
          </div>
        )}

        <section className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
          {overview.map((item) => {
            const Icon = item.icon;
            return (
              <div key={item.label} className="card">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-gray-500">{item.label}</p>
                    <p className="text-3xl font-bold text-gray-900 mt-2">{item.value}</p>
                  </div>
                  <div className={`w-12 h-12 rounded-2xl flex items-center justify-center ${item.tone}`}>
                    <Icon className="w-5 h-5" />
                  </div>
                </div>
              </div>
            );
          })}
        </section>

        <section className="grid grid-cols-1 xl:grid-cols-3 gap-5">
          <div className="card">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-11 h-11 rounded-2xl bg-mint/10 text-mint flex items-center justify-center">
                <KeyRound className="w-5 h-5" />
              </div>
              <div>
                <h2 className="font-bold text-gray-900">Boss 登录态</h2>
                <p className="text-xs text-gray-500">仅管理员可维护</p>
              </div>
            </div>
            <p className="text-sm text-gray-600 mb-3">
              当前状态：{session.connected ? '已绑定，可抓取真实岗位' : '未绑定，无法刷新真实岗位库'}
            </p>
            {session.cookiePreview ? <p className="text-xs text-gray-400 mb-3">最近绑定：{session.cookiePreview}</p> : null}
            <textarea
              value={cookieInput}
              onChange={(e) => setCookieInput(e.target.value)}
              placeholder="粘贴管理员的 Boss 登录 cookie"
              className="w-full min-h-[120px] rounded-xl border border-gray-200 bg-warm-white/60 px-3 py-2 text-sm text-gray-700 focus:outline-none focus:border-mint"
            />
            <button
              onClick={handleSaveCookie}
              disabled={savingCookie}
              className="mt-4 w-full rounded-xl bg-mint text-white py-3 text-sm font-semibold hover:bg-mint/90 disabled:opacity-60"
            >
              {savingCookie ? '保存中...' : '保存 Boss 登录态'}
            </button>
          </div>

          <div className="card">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-11 h-11 rounded-2xl bg-sky-100 text-sky-600 flex items-center justify-center">
                <RefreshCw className={`w-5 h-5 ${refreshing ? 'animate-spin' : ''}`} />
              </div>
              <div>
                <h2 className="font-bold text-gray-900">岗位库刷新</h2>
                <p className="text-xs text-gray-500">手动刷新 + 每日定时刷新</p>
              </div>
            </div>
            <div className="space-y-3 text-sm text-gray-600">
              <p>已生成岗位方向：{library.items?.length || 0} 个</p>
              <p>
                每日自动刷新时间：
                {library.schedule
                  ? ` ${String(library.schedule.hour).padStart(2, '0')}:${String(library.schedule.minute).padStart(2, '0')}`
                  : ' 暂无'}
              </p>
              <p>刷新逻辑：每个启用方向抓取约 10 条真实岗位，再保留 3-5 条典型示例给前台展示。</p>
            </div>
            <button
              onClick={handleRefreshLibrary}
              disabled={refreshing || !session.connected}
              className="mt-5 w-full rounded-xl bg-sky-500 text-white py-3 text-sm font-semibold hover:bg-sky-600 disabled:opacity-60"
            >
              {refreshing ? '刷新中...' : '立即刷新本地岗位库'}
            </button>
          </div>

          <div className="card">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-11 h-11 rounded-2xl bg-amber-100 text-amber-600 flex items-center justify-center">
                <Clock3 className="w-5 h-5" />
              </div>
              <div>
                <h2 className="font-bold text-gray-900">运行状态</h2>
                <p className="text-xs text-gray-500">一眼看当前是否健康</p>
              </div>
            </div>
            <div className="space-y-3">
              <div className="flex items-center justify-between rounded-xl bg-warm-white/70 px-3 py-2">
                <span className="text-sm text-gray-600">Boss 登录态</span>
                <span className={`text-sm font-semibold ${session.connected ? 'text-emerald-600' : 'text-red-500'}`}>{session.connected ? '正常' : '待绑定'}</span>
              </div>
              <div className="flex items-center justify-between rounded-xl bg-warm-white/70 px-3 py-2">
                <span className="text-sm text-gray-600">岗位方向配置</span>
                <span className={`text-sm font-semibold ${directions.length ? 'text-emerald-600' : 'text-amber-600'}`}>{directions.length ? '已初始化' : '未初始化'}</span>
              </div>
              <div className="flex items-center justify-between rounded-xl bg-warm-white/70 px-3 py-2">
                <span className="text-sm text-gray-600">本地岗位库</span>
                <span className={`text-sm font-semibold ${(library.items?.length || 0) > 0 ? 'text-emerald-600' : 'text-red-500'}`}>{(library.items?.length || 0) > 0 ? '可用' : '未就绪'}</span>
              </div>
            </div>
          </div>
        </section>

        <section className="card">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
            <div>
              <h2 className="text-xl font-bold text-gray-900">岗位方向配置管理</h2>
              <p className="text-sm text-gray-500 mt-1">初始值已按登录页当前 6 个岗位方向生成，你可以继续改名称、抓取关键词、抓取数量和示例数量。</p>
            </div>
            <div className="flex items-center gap-2 text-sm text-gray-500">
              <Sparkles className="w-4 h-4" />
              共 {directions.length} 个方向
            </div>
          </div>

          <div className="space-y-4">
            {directions.map((item) => (
              <div key={item.id} className="rounded-2xl border border-gray-100 bg-warm-white/50 p-4">
                <div className="grid grid-cols-1 xl:grid-cols-12 gap-3 items-end">
                  <div className="xl:col-span-2">
                    <label className="text-xs text-gray-500 block mb-1">方向名称</label>
                    <input
                      value={item.name}
                      onChange={(e) => handleDirectionFieldChange(item.id, 'name', e.target.value)}
                      className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm focus:outline-none focus:border-mint"
                    />
                  </div>
                  <div className="xl:col-span-3">
                    <label className="text-xs text-gray-500 block mb-1">抓取关键词</label>
                    <input
                      value={item.keyword}
                      onChange={(e) => handleDirectionFieldChange(item.id, 'keyword', e.target.value)}
                      className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm focus:outline-none focus:border-mint"
                    />
                  </div>
                  <div className="xl:col-span-2">
                    <label className="text-xs text-gray-500 block mb-1">抓取条数</label>
                    <input
                      type="number"
                      min="1"
                      max="30"
                      value={item.fetchCount}
                      onChange={(e) => handleDirectionFieldChange(item.id, 'fetchCount', e.target.value)}
                      className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm focus:outline-none focus:border-mint"
                    />
                  </div>
                  <div className="xl:col-span-2">
                    <label className="text-xs text-gray-500 block mb-1">示例条数</label>
                    <input
                      type="number"
                      min="1"
                      max="5"
                      value={item.sampleCount}
                      onChange={(e) => handleDirectionFieldChange(item.id, 'sampleCount', e.target.value)}
                      className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm focus:outline-none focus:border-mint"
                    />
                  </div>
                  <div className="xl:col-span-1">
                    <label className="text-xs text-gray-500 block mb-1">排序</label>
                    <input
                      type="number"
                      min="0"
                      value={item.sortOrder}
                      onChange={(e) => handleDirectionFieldChange(item.id, 'sortOrder', e.target.value)}
                      className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm focus:outline-none focus:border-mint"
                    />
                  </div>
                  <div className="xl:col-span-1">
                    <label className="text-xs text-gray-500 block mb-1">启用</label>
                    <select
                      value={item.enabled ? '1' : '0'}
                      onChange={(e) => handleDirectionFieldChange(item.id, 'enabled', e.target.value === '1')}
                      className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm focus:outline-none focus:border-mint"
                    >
                      <option value="1">启用</option>
                      <option value="0">暂停</option>
                    </select>
                  </div>
                  <div className="xl:col-span-1">
                    <button
                      onClick={() => handleSaveDirection(item)}
                      disabled={savingDirectionId === item.id}
                      className="w-full rounded-xl bg-gray-900 text-white py-2.5 text-sm font-semibold hover:bg-black disabled:opacity-60"
                    >
                      {savingDirectionId === item.id ? '保存中' : '保存'}
                    </button>
                  </div>
                </div>
                <div className="mt-3 text-xs text-gray-400">方向 ID：{item.id} · 最近更新：{fmtTime(item.updatedAt)}</div>
              </div>
            ))}
          </div>
        </section>

        <section className="card">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
            <div>
              <h2 className="text-xl font-bold text-gray-900">本地岗位库快照</h2>
              <p className="text-sm text-gray-500 mt-1">这些就是前台普通用户和会员用户最终读取的真实岗位缓存结果。</p>
            </div>
            <div className="flex items-center gap-2 text-sm text-gray-500">
              <Database className="w-4 h-4" />
              共 {library.items?.length || 0} 个缓存方向
            </div>
          </div>

          {(!library.items || library.items.length === 0) ? (
            <div className="rounded-2xl border border-dashed border-amber-200 bg-amber-50/60 px-5 py-10 text-center">
              <AlertTriangle className="w-8 h-8 text-amber-500 mx-auto mb-3" />
              <h3 className="font-bold text-gray-900 mb-1">本地岗位库还没有生成</h3>
              <p className="text-sm text-gray-600">先绑定 Boss 登录态，再点击“立即刷新本地岗位库”，系统就会开始沉淀真实岗位数据。</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              {library.items.map((item) => (
                <div key={item.keyword} className="rounded-2xl border border-gray-100 bg-warm-white/50 p-4 hover:shadow-sm transition-shadow">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <Briefcase className="w-4 h-4 text-mint" />
                        <h3 className="font-bold text-gray-900">{item.keyword}</h3>
                      </div>
                      <p className="text-xs text-gray-400">方向 ID：{item.direction_id || 'manual'}</p>
                    </div>
                    <div className="flex items-center gap-1 text-emerald-600 text-sm font-semibold">
                      <CheckCircle2 className="w-4 h-4" />
                      {item.total || 0} 条
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-3 mt-4">
                    <div className="rounded-xl bg-white px-3 py-2 border border-gray-100">
                      <p className="text-xs text-gray-400 mb-1">真实岗位</p>
                      <p className="text-base font-bold text-gray-900">{item.total || 0}</p>
                    </div>
                    <div className="rounded-xl bg-white px-3 py-2 border border-gray-100">
                      <p className="text-xs text-gray-400 mb-1">抓取来源</p>
                      <p className="text-sm font-semibold text-gray-900">{item.source || 'snapshot'}</p>
                    </div>
                    <div className="rounded-xl bg-white px-3 py-2 border border-gray-100">
                      <p className="text-xs text-gray-400 mb-1">最近刷新</p>
                      <p className="text-sm font-semibold text-gray-900">{fmtTime(item.fetched_at)}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="card">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
            <div>
              <h2 className="text-xl font-bold text-gray-900">用户分类管理</h2>
              <p className="text-sm text-gray-500 mt-1">你可以在这里把用户设置为管理员、普通用户或会员用户。</p>
            </div>
            <div className="flex items-center gap-2 text-sm text-gray-500">
              <Sparkles className="w-4 h-4" />
              共 {userData.items?.length || 0} 个账号
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-gray-400 border-b border-gray-100">
                  <th className="py-3 pr-4 font-medium">账号</th>
                  <th className="py-3 pr-4 font-medium">当前分类</th>
                  <th className="py-3 pr-4 font-medium">目标岗位</th>
                  <th className="py-3 pr-4 font-medium">最近更新</th>
                  <th className="py-3 font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {(userData.items || []).map((user) => {
                  const currentType = user.role === 'admin' ? 'admin' : user.tier === 'member' ? 'member' : 'normal';
                  return (
                    <tr key={user.id} className="border-b border-gray-50 align-top">
                      <td className="py-4 pr-4">
                        <div className="font-semibold text-gray-900">{user.username}</div>
                        <div className="text-xs text-gray-400 mt-1">创建时间：{fmtTime(user.createdAt)}</div>
                      </td>
                      <td className="py-4 pr-4">
                        <span className="inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold bg-warm-white text-gray-700 border border-gray-200">
                          {user.userType || userTypeLabel(user.role, user.tier)}
                        </span>
                      </td>
                      <td className="py-4 pr-4 text-gray-600">
                        {user.jobName || '未设置'}
                        {user.company ? <div className="text-xs text-gray-400 mt-1">{user.company}</div> : null}
                      </td>
                      <td className="py-4 pr-4 text-gray-600">{fmtTime(user.updatedAt)}</td>
                      <td className="py-4">
                        <select
                          value={currentType}
                          disabled={savingUserId === user.id}
                          onChange={(e) => handleUserTypeChange(user, e.target.value)}
                          className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 focus:outline-none focus:border-mint"
                        >
                          <option value="normal">普通用户</option>
                          <option value="member">会员用户</option>
                          <option value="admin">管理员</option>
                        </select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}
