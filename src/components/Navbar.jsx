import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  BookOpen,
  Briefcase,
  FileText,
  ListTodo,
  LogOut,
  Mail,
  Map,
  Menu,
  Radar,
  Shield,
  Smartphone,
  Star,
  X,
} from 'lucide-react';
import { getProfile, getXhsQrcode, getXhsStatus, logout } from '../lib/api';
import VipBadge from './VipBadge';

const userSections = [
  {
    key: 'learn',
    title: '学习中心',
    icon: BookOpen,
    items: [
      { name: '今日任务', icon: ListTodo, path: '/dashboard' },
      { name: '学习计划', icon: Map, path: '/plan' },
      { name: '学习笔记', icon: FileText, path: '/notes' },
      { name: '热门项目', icon: Radar, path: '/insights' },
    ],
  },
  {
    key: 'job',
    title: '面试管家',
    icon: Briefcase,
    items: [
      { name: '面试日历', icon: Mail, path: '/interviews' },
      { name: '面经库', icon: BookOpen, path: '/interview-experience' },
    ],
  },
];

const adminSections = [
  {
    key: 'admin',
    title: '管理中心',
    icon: Shield,
    items: [
      { name: '管理员后台', icon: Shield, path: '/admin' },
      { name: '邮件管理', icon: Mail, path: '/admin/email' },
    ],
  },
];

const learnPaths = ['/dashboard', '/plan', '/notes', '/skills', '/insights', '/favorites'];

export default function Navbar() {
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState('user');
  const isAdmin = role === 'admin';

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const profile = await getProfile();
        if (active) setRole(profile?.role || 'user');
      } catch {
        if (active) setRole('user');
      }
    })();
    return () => {
      active = false;
    };
  }, [location.pathname]);

  const isLearn = learnPaths.includes(location.pathname);
  const sections = useMemo(() => {
    if (isAdmin) return adminSections;
    return userSections.filter((section) => (isLearn ? section.key === 'learn' : section.key === 'job'));
  }, [isAdmin, isLearn]);

  const go = (path) => {
    navigate(path);
    setOpen(false);
  };

  const homePath = isAdmin ? '/admin' : '/dashboard';

  const handleLogout = async () => {
    await logout();
    navigate('/', { replace: true });
    setOpen(false);
  };

  const content = (
    <>
      <div className="h-16 flex items-center gap-3 px-5 border-b border-gray-100">
        <div className="w-10 h-10 rounded-xl bg-mint/20 flex items-center justify-center text-xl">🎯</div>
        <div>
          <div className="font-bold text-gray-900">Offer到</div>
          <div className="text-xs text-gray-400">{isAdmin ? '管理员工作台' : '你的求职陪跑 Agent'}</div>
        </div>
      </div>

      <div className="p-3 flex-1 overflow-y-auto space-y-6">
        {sections.map((section) => {
          const SectionIcon = section.icon;
          return (
            <section key={section.key}>
              <div className="flex items-center gap-2 px-3 mb-2 text-xs font-semibold tracking-wider text-gray-400">
                <SectionIcon className="w-4 h-4" />
                {section.title}
              </div>

              <div className="space-y-1">
                {section.items.map((item) => {
                  const Icon = item.icon;
                  const basePath = item.path.split('?')[0];
                  const itemQuery = item.path.includes('?') ? item.path.split('?')[1] : '';
                  const active =
                    location.pathname === basePath &&
                    (itemQuery
                      ? location.search.replace('?', '') === itemQuery
                      : !location.search.includes('view='));

                  return (
                    <button
                      key={item.path}
                      onClick={() => go(item.path)}
                      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors ${
                        active ? 'bg-mint text-white shadow-light' : 'text-gray-600 hover:bg-warm-white'
                      }`}
                    >
                      <Icon className="w-4 h-4" />
                      <span>{item.name}</span>
                    </button>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>

      <div className="p-3 border-t border-gray-100 space-y-2">
        <VipBadge />

        <button
          onClick={handleLogout}
          className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl text-sm font-medium text-red-500 hover:bg-red-50 transition-colors"
        >
          <LogOut className="w-4 h-4" />
          退出登录
        </button>
      </div>
    </>
  );

  return (
    <>
      <div className="md:hidden sticky top-0 z-40 h-16 bg-white border-b flex items-center justify-between gap-2 px-3">
        <button onClick={() => go(homePath)} className="font-bold text-gray-900 whitespace-nowrap">
          🎯 Offer到
        </button>

        <div className="flex items-center gap-1">
          {isAdmin ? (
            <button
              onClick={() => go('/admin')}
              className="px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-mint text-white"
            >
              管理后台
            </button>
          ) : (
            <>
              <button
                onClick={() => go('/dashboard')}
                className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold ${isLearn ? 'bg-mint text-white' : 'text-gray-600'}`}
              >
                学习
              </button>
              <button
                onClick={() => go('/interviews')}
                className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold ${!isLearn ? 'bg-mint text-white' : 'text-gray-600'}`}
              >
                求职
              </button>
            </>
          )}

          <button onClick={() => setOpen(true)} className="p-2 rounded-lg hover:bg-gray-100" aria-label="打开导航">
            <Menu className="w-6 h-6" />
          </button>
        </div>
      </div>

      <aside className="hidden md:flex fixed inset-y-0 left-0 z-40 w-60 bg-white border-r border-gray-100 flex-col">
        {content}
      </aside>

      {open && (
        <div className="md:hidden fixed inset-0 z-50 bg-black/30" onClick={() => setOpen(false)}>
          <aside className="w-72 h-full bg-white flex flex-col shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setOpen(false)} className="absolute left-[17rem] top-4 p-2" aria-label="关闭导航">
              <X className="w-5 h-5" />
            </button>
            {content}
          </aside>
        </div>
      )}
    </>
  );
}

export function TopNav() {
  const navigate = useNavigate();
  const location = useLocation();
  const [role, setRole] = useState('user');
  const isAdmin = role === 'admin';
  const isLearn = learnPaths.includes(location.pathname);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const profile = await getProfile();
        if (active) setRole(profile?.role || 'user');
      } catch {
        if (active) setRole('user');
      }
    })();
    return () => {
      active = false;
    };
  }, [location.pathname]);

  if (isAdmin) {
    const adminTabs = [
      { key: 'admin', label: '管理员后台', icon: Shield, home: '/admin', active: location.pathname === '/admin' },
      { key: 'email', label: '邮件管理', icon: Mail, home: '/admin/email', active: location.pathname === '/admin/email' },
    ];

    return (
      <div className="hidden md:flex sticky top-0 z-30 h-14 items-center justify-between gap-2 px-6 bg-white/80 backdrop-blur border-b border-gray-100">
        <div className="flex items-center gap-1">
          {adminTabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.key}
                onClick={() => navigate(tab.home)}
                className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-colors ${
                  tab.active ? 'bg-mint text-white shadow-light' : 'text-gray-600 hover:bg-warm-white'
                }`}
              >
                <Icon className="w-4 h-4" />
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  const tabs = [
    { key: 'learn', label: '学习中心', icon: BookOpen, home: '/dashboard', active: isLearn },
    { key: 'job', label: '面试管家', icon: Briefcase, home: '/interviews', active: !isLearn },
  ];

  return (
    <div className="hidden md:flex sticky top-0 z-30 h-14 items-center justify-between gap-2 px-6 bg-white/80 backdrop-blur border-b border-gray-100">
      <div className="flex items-center gap-1">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.key}
              onClick={() => navigate(tab.home)}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-colors ${
                tab.active ? 'bg-mint text-white shadow-light' : 'text-gray-600 hover:bg-warm-white'
              }`}
            >
              <Icon className="w-4 h-4" />
              {tab.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
