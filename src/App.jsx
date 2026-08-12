import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useEffect, useState } from 'react';
import Navbar, { TopNav } from './components/Navbar';
import Dashboard from './pages/Dashboard';
import Login from './pages/Login';
import AuthLogin from './pages/AuthLogin';
import Notes from './pages/Notes';
import PlanBoard from './pages/PlanBoard';
import Skills from './pages/Skills';
import Insights from './pages/Insights';
import Favorites from './pages/Favorites';
import Interviews from './pages/Interviews';
import InterviewExperience from './pages/InterviewExperience';
import KnowledgeBase from './pages/KnowledgeBase';
import AdminPanel from './pages/AdminPanel';
import AdminEmailPanel from './pages/AdminEmailPanel';
import { getToken, getProfile } from './lib/api';

// 登录守卫：未登录（无 token 或资料校验失败）一律重定向到登录页，并提示「请先登录」
function RequireAuth({ children }) {
  const [status, setStatus] = useState('loading');
  const location = useLocation();

  useEffect(() => {
    let active = true;
    (async () => {
      if (!getToken()) {
        if (active) setStatus('unauthed');
        return;
      }
      try {
        await getProfile();
        if (active) setStatus('ok');
      } catch {
        if (active) setStatus('unauthed');
      }
    })();
    return () => { active = false; };
  }, []);

  if (status === 'loading') {
    return <div className="min-h-[40vh] flex items-center justify-center text-gray-400">加载中…</div>;
  }
  if (status === 'unauthed') {
    // 跳到登录页并带上「需要登录」标记，登录页据此弹出提示框
    return <Navigate to="/" replace state={{ needLogin: true, from: location.pathname }} />;
  }
  return children;
}

function RoleRoute({ allow, fallback, children }) {
  const [status, setStatus] = useState('loading');
  const [role, setRole] = useState('user');

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const profile = await getProfile();
        if (!active) return;
        setRole(profile?.role || 'user');
      } catch {
        if (!active) return;
        setRole('user');
      } finally {
        if (active) setStatus('ready');
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  if (status === 'loading') {
    return <div className="min-h-[40vh] flex items-center justify-center text-gray-400">加载中…</div>;
  }

  if (!allow(role)) {
    return <Navigate to={fallback} replace />;
  }

  return children;
}

function AppContent() {
  const location = useLocation();
  const showNavbar = !['/', '/login'].includes(location.pathname);

  return (
    <>
      {showNavbar && <Navbar />}
      <main className={showNavbar ? 'md:pl-60' : ''}>
        {showNavbar && <TopNav />}
        <Routes>
          <Route path="/" element={<AuthLogin />} />
          <Route path="/login" element={<Login />} />
          <Route path="/dashboard" element={<RequireAuth><Dashboard /></RequireAuth>} />
          <Route path="/notes" element={<RequireAuth><Notes /></RequireAuth>} />
          <Route path="/plan" element={<RequireAuth><PlanBoard /></RequireAuth>} />
          <Route path="/skills" element={<RequireAuth><Skills /></RequireAuth>} />
          <Route path="/insights" element={<RequireAuth><Insights /></RequireAuth>} />
          <Route path="/favorites" element={<RequireAuth><Favorites /></RequireAuth>} />
          <Route path="/interviews" element={<RequireAuth><Interviews /></RequireAuth>} />
          <Route path="/interview-experience" element={<RequireAuth><InterviewExperience /></RequireAuth>} />
          <Route
            path="/knowledge"
            element={
              <RequireAuth>
                <RoleRoute allow={(role) => role === 'admin'} fallback="/dashboard">
                  <KnowledgeBase />
                </RoleRoute>
              </RequireAuth>
            }
          />
          <Route
            path="/admin"
            element={
              <RequireAuth>
                <RoleRoute allow={(role) => role === 'admin'} fallback="/dashboard">
                  <AdminPanel />
                </RoleRoute>
              </RequireAuth>
            }
          />
          <Route
            path="/admin/email"
            element={
              <RequireAuth>
                <RoleRoute allow={(role) => role === 'admin'} fallback="/dashboard">
                  <AdminEmailPanel />
                </RoleRoute>
              </RequireAuth>
            }
          />
        </Routes>
      </main>
    </>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppContent />
    </BrowserRouter>
  );
}
