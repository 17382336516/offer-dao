import { useEffect, useState } from 'react';
import { ExternalLink, Github, Star } from 'lucide-react';
import { getTrendingInsights } from '../lib/api';

function repoToCard(repo, idx) {
  return {
    id: repo.url || repo.title || `repo-${idx}`,
    title: (repo.title || '').replace(/\s+/g, ' ').trim(),
    summary: repo.desc || '暂无项目描述',
    stars: repo.stars || 0,
    link: repo.url || '',
  };
}

export default function Insights() {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(false);
  const [dataDate, setDataDate] = useState('');
  const [toast, setToast] = useState('');

  const showToast = (msg) => {
    setToast(msg);
    window.setTimeout(() => setToast(''), 1800);
  };

  // 从数据库读取全局每日快照（系统零点自动抓取，用户不触发抓取）
  const loadSnapshot = async () => {
    setLoading(true);
    try {
      const data = await getTrendingInsights();
      if (data && Array.isArray(data.insights)) {
        setDataDate(data.date || '');
        setProjects(data.insights.map(repoToCard));
      }
    } catch (e) {
      showToast(`加载失败：${e.message || '网络错误'}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSnapshot();
  }, []);

  return (
    <div className="min-h-screen bg-warm-white p-4 md:p-6">
      {toast && (
        <div className="fixed top-20 left-1/2 -translate-x-1/2 bg-gray-800 text-white px-6 py-3 rounded-full text-sm z-50 animate-check">
          {toast}
        </div>
      )}

      <div className="max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-stone-800">热门项目</h1>
            <p className="text-sm text-stone-500 mt-1">
              {dataDate ? `GitHub Trending 每日快照 · 更新于 ${dataDate}` : '当前直接连接 GitHub Trending 真实热门开源项目'}
            </p>
          </div>
        </div>

        {loading && (
          <div className="text-center text-sm text-stone-400 py-16">正在加载热门项目…</div>
        )}

        {!loading && projects.length === 0 && (
          <div className="text-center text-sm text-stone-400 py-16">暂无热门项目，请稍后再来查看。</div>
        )}

        <div className="space-y-4">
          {projects.map((project) => (
            <div key={project.id} className="rounded-2xl bg-white border border-stone-200 p-5 hover:border-emerald-300 transition-colors shadow-sm">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium text-white bg-[#24292F]">
                      <Github className="w-3 h-3" />
                      GitHub
                    </span>
                    <span className="inline-flex items-center gap-1 text-xs text-stone-400">
                      <Star className="w-3 h-3" />
                      {project.stars.toLocaleString()} stars
                    </span>
                  </div>

                  <a
                    href={project.link}
                    target="_blank"
                    rel="noreferrer"
                    className="font-bold text-stone-800 hover:text-emerald-600 flex items-center gap-2"
                  >
                    {project.title}
                    <ExternalLink className="w-4 h-4 text-stone-400" />
                  </a>

                  <p className="text-sm text-stone-500 mt-2 leading-6">{project.summary}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
