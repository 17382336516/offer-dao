import { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { User, Lock, Eye, EyeOff, ArrowRight, Github, Mail, AlertTriangle, X } from 'lucide-react';
import { getToken, setToken, login, register, getProfile } from '../lib/api';

function profileToJobInfo(p) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = p.targetDate
    ? Math.max(0, Math.ceil((new Date(p.targetDate) - today) / 86400000))
    : 60;
  return {
    jobName: p.jobName || '策略产品经理',
    company: p.company || '字节跳动',
    direction: p.direction || 'strategy',
    targetDate: p.targetDate || '',
    days,
  };
}

function getHomePath(profile) {
  return profile?.role === 'admin' ? '/admin' : '/dashboard';
}

function AuthLogin() {
  const navigate = useNavigate();
  const location = useLocation();
  // 由路由守卫（RequireAuth）跳转带入：用户直接访问了受保护页面但并未登录
  const [needLogin, setNeedLogin] = useState(!!location.state?.needLogin);
  const [mode, setMode] = useState('login'); // 'login' | 'register'
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  // 已登录（token 有效）则直接进入对应页面，实现“下次免填”
  useEffect(() => {
    let active = true;
    if (!getToken()) return;
    (async () => {
      try {
        const profile = await getProfile();
        if (!active) return;
        if (profile) {
          localStorage.setItem('offerToJobInfo', JSON.stringify(profileToJobInfo(profile)));
          navigate(getHomePath(profile), { replace: true });
        } else {
          navigate('/login', { replace: true });
        }
      } catch {
        if (active) setToken('');
      }
    })();
    return () => { active = false; };
  }, [navigate]);

  // 登录成功后拉取当前用户资料写回 localStorage，确保各页面以该登录用户的目标岗位为准
  const loadProfileAndGo = async (to) => {
    try {
      const profile = await getProfile();
      if (profile) {
        localStorage.setItem('offerToJobInfo', JSON.stringify(profileToJobInfo(profile)));
        navigate(getHomePath(profile));
        return;
      }
    } catch {
      /* 忽略：无资料时沿用既有兜底 */
    }
    navigate(to);
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    setError('');
    if (!username || !password) { setError('请输入用户名和密码'); return; }
    setIsLoading(true);
    try {
      await login(username, password);
      await loadProfileAndGo('/dashboard'); // 登录校验通过后进入主页
    } catch (err) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleRegister = async (e) => {
    e.preventDefault();
    setError('');
    if (!username || !password) { setError('请输入用户名和密码'); return; }
    if (password !== confirm) { setError('两次输入的密码不一致'); return; }
    setIsLoading(true);
    try {
      await register(username, password);
      navigate('/login'); // 新用户尚无目标岗位资料
    } catch (err) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleDemoLogin = async () => {
    setIsLoading(true);
    setError('');
    try {
      try {
        await login('demo', 'demo123');
      } catch {
        await register('demo', 'demo123');
      }
      await loadProfileAndGo('/dashboard'); // 演示登录后直接进入主页
    } catch (err) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const isRegister = mode === 'register';

  return (
    <div className="min-h-screen bg-gradient-to-br from-mint/5 via-warm-white to-cream/5 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-mint to-mint/60 mb-4 shadow-lg">
            <span className="text-3xl">🎯</span>
          </div>
          <h1 className="text-3xl font-bold text-gray-800 mb-2">Offer到</h1>
          <p className="text-gray-500">产品经理学习陪跑，助你拿到心仪Offer</p>
        </div>

        <div className="bg-white rounded-2xl shadow-xl p-6 md:p-8">
          <h2 className="text-xl font-bold text-gray-800 mb-6 text-center">
            {isRegister ? '创建账号' : '欢迎回来'}
          </h2>

          {error && (
            <div className="mb-4 p-3 bg-red-50 text-red-600 rounded-xl text-sm">
              {error}
            </div>
          )}

          {needLogin && (
            <div className="mb-4 p-3 bg-amber-50 border border-amber-200 text-amber-700 rounded-xl text-sm flex items-start justify-between gap-2">
              <span className="flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                请先登录后再访问该页面
              </span>
              <button
                type="button"
                onClick={() => setNeedLogin(false)}
                className="text-amber-500 hover:text-amber-700 transition-colors"
                aria-label="关闭提示"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          <form onSubmit={isRegister ? handleRegister : handleLogin} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">用户名</label>
              <div className="relative">
                <User className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="设置或输入用户名"
                  className="w-full pl-12 pr-4 py-3 rounded-xl border border-gray-200 bg-gray-50 focus:outline-none focus:border-mint focus:ring-2 focus:ring-mint/20 transition-all text-gray-700"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">密码</label>
              <div className="relative">
                <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={isRegister ? '至少 6 位密码' : '请输入密码'}
                  className="w-full pl-12 pr-12 py-3 rounded-xl border border-gray-200 bg-gray-50 focus:outline-none focus:border-mint focus:ring-2 focus:ring-mint/20 transition-all text-gray-700"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition-colors"
                >
                  {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                </button>
              </div>
            </div>

            {isRegister && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">确认密码</label>
                <div className="relative">
                  <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    placeholder="再次输入密码"
                    className="w-full pl-12 pr-4 py-3 rounded-xl border border-gray-200 bg-gray-50 focus:outline-none focus:border-mint focus:ring-2 focus:ring-mint/20 transition-all text-gray-700"
                  />
                </div>
              </div>
            )}

            {!isRegister && (
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer">
                  <input type="checkbox" className="w-4 h-4 rounded border-gray-300 text-mint focus:ring-mint" />
                  记住我
                </label>
                <a href="#" className="text-sm text-mint hover:text-mint/80 transition-colors">忘记密码？</a>
              </div>
            )}

            <button
              type="submit"
              disabled={isLoading}
              className="w-full py-3.5 rounded-xl bg-gradient-to-r from-mint to-mint/80 text-white font-semibold shadow-lg hover:shadow-xl hover:from-mint/90 hover:to-mint/70 transition-all flex items-center justify-center gap-2 disabled:opacity-70 disabled:cursor-not-allowed"
            >
              {isLoading ? (
                <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : (
                <>
                  {isRegister ? '注册' : '登录'}
                  <ArrowRight className="w-5 h-5" />
                </>
              )}
            </button>
          </form>

          {!isRegister && (
            <>
              <div className="my-6 flex items-center">
                <div className="flex-1 h-px bg-gray-200" />
                <span className="px-4 text-sm text-gray-500">或</span>
                <div className="flex-1 h-px bg-gray-200" />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <button className="flex items-center justify-center gap-2 py-3 rounded-xl border border-gray-200 bg-white hover:bg-gray-50 transition-colors text-gray-700">
                  <Github className="w-5 h-5" />
                  GitHub
                </button>
                <button className="flex items-center justify-center gap-2 py-3 rounded-xl border border-gray-200 bg-white hover:bg-gray-50 transition-colors text-gray-700">
                  <Mail className="w-5 h-5" />
                  邮箱
                </button>
              </div>

              <div className="mt-6 text-center">
                <button
                  onClick={handleDemoLogin}
                  className="text-sm text-gray-500 hover:text-mint transition-colors"
                >
                  {isLoading ? '加载中...' : '👀 演示模式，直接进入'}
                </button>
              </div>
            </>
          )}

          <p className="text-center text-gray-400 text-sm mt-6">
            {isRegister ? (
              <>已经有账号？<span className="text-mint cursor-pointer hover:underline" onClick={() => setMode('login')}>立即登录</span></>
            ) : (
              <>还没有账号？<span className="text-mint cursor-pointer hover:underline" onClick={() => setMode('register')}>立即注册</span></>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}

export default AuthLogin;
