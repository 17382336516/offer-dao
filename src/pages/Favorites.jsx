import { useState } from 'react';
import { Search, Plus, ExternalLink, Brain, BookOpen, Video, Code, Star } from 'lucide-react';

const mockFavorites = [
  {
    id: 1,
    type: 'xiaohongshu',
    title: '产品经理秋招避坑指南',
    summary: '总结了秋招过程中常见的坑和应对方法',
    tags: ['#秋招', '#产品经理', '#避坑'],
    date: '7月8日',
  },
  {
    id: 2,
    type: 'xiaohongshu',
    title: '如何准备产品经理作品集',
    summary: '分享了作品集的制作技巧和模板推荐',
    tags: ['#作品集', '#产品经理', '#面试'],
    date: '7月5日',
  },
  {
    id: 3,
    type: 'bilibili',
    title: '产品思维入门教程',
    status: '已生成脑图 · 3个核心要点',
    tags: ['#产品思维', '#入门', '#教程'],
    date: '7月10日',
  },
  {
    id: 4,
    type: 'bilibili',
    title: '数据分析实战案例',
    status: '已生成脑图 · 5个核心要点',
    tags: ['#数据分析', '#实战', '#案例'],
    date: '7月3日',
  },
  {
    id: 5,
    type: 'github',
    name: 'awesome-product-manager',
    info: { stars: '4.2k', level: 'L2 中级', lang: 'Python' },
    tags: ['#资源', '#产品经理', '#学习'],
    date: '6月28日',
  },
  {
    id: 6,
    type: 'github',
    name: 'product-design-patterns',
    info: { stars: '2.8k', level: 'L3 高级', lang: 'JavaScript' },
    tags: ['#设计模式', '#产品', '#资源'],
    date: '6月20日',
  },
];

const mockRecommendations = [
  { id: 1, type: 'xiaohongshu', title: '小红书爆款产品经理笔记模板', tags: ['#模板', '#笔记'] },
  { id: 2, type: 'bilibili', title: 'B站产品经理面试真题精讲', tags: ['#面试', '#真题'] },
  { id: 3, type: 'github', title: '产品经理学习路线图', tags: ['#路线图', '#学习'] },
];

const tabs = [
  { id: 'all', label: '全部' },
  { id: 'xiaohongshu', label: '📖 小红书' },
  { id: 'bilibili', label: '🎬 B站' },
  { id: 'github', label: '💻 GitHub' },
];

function Favorites() {
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState('all');

  const filteredFavorites = mockFavorites.filter(item => {
    const matchesSearch = item.title?.toLowerCase().includes(searchQuery.toLowerCase()) ||
                          item.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
                          item.summary?.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesTab = activeTab === 'all' || item.type === activeTab;
    return matchesSearch && matchesTab;
  });

  return (
    <div className="min-h-screen bg-warm-white p-4 md:p-6">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-xl font-bold text-gray-800">📚 我的收藏</h1>
          <button className="btn-primary flex items-center gap-2">
            <Plus className="w-4 h-4" />
            导入
          </button>
        </div>

        <div className="card mb-6">
          <div className="relative mb-4">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="🔍 搜索笔记、视频、项目..."
              className="w-full pl-12 pr-4 py-3 rounded-xl border border-gray-200 bg-warm-white/50 focus:outline-none focus:border-mint transition-colors"
            />
          </div>

          <div className="flex gap-2">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex-1 px-4 py-2 rounded-button text-sm font-medium transition-all duration-200 ${
                  activeTab === tab.id
                    ? 'bg-mint text-white'
                    : 'bg-warm-white text-gray-600 border border-gray-200 hover:border-mint/30'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {filteredFavorites.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {filteredFavorites.map((item) => (
              <div key={item.id} className="card">
                <div className="flex items-center gap-2 mb-3">
                  {item.type === 'xiaohongshu' && <BookOpen className="w-5 h-5 text-[#FF2442]" />}
                  {item.type === 'bilibili' && <Video className="w-5 h-5 text-[#FB7299]" />}
                  {item.type === 'github' && <Code className="w-5 h-5 text-gray-600" />}
                  <h3 className="font-bold text-gray-800">{item.title || item.name}</h3>
                </div>

                {item.summary && (
                  <p className="text-sm text-gray-500 mb-3">{item.summary}</p>
                )}

                {item.status && (
                  <p className="text-sm text-mint mb-3">{item.status}</p>
                )}

                {item.info && (
                  <div className="flex items-center gap-3 mb-3 text-sm text-gray-500">
                    <span>⭐ {item.info.stars}</span>
                    <span className="px-2 py-0.5 bg-mint/20 text-mint rounded-full">{item.info.level}</span>
                    <span>{item.info.lang}</span>
                  </div>
                )}

                <div className="flex flex-wrap gap-1 mb-4">
                  {item.tags.map((tag, index) => (
                    <span key={index} className="text-xs px-2 py-1 bg-cream/30 text-gray-600 rounded-full">
                      {tag}
                    </span>
                  ))}
                </div>

                <div className="flex items-center justify-between text-xs text-gray-400 mb-4">
                  <span>收藏日期：{item.date}</span>
                </div>

                <div className="flex gap-2">
                  <button className="flex-1 flex items-center justify-center gap-2 py-2 rounded-lg bg-gray-100 text-gray-600 hover:bg-gray-200 transition-colors">
                    <ExternalLink className="w-4 h-4" />
                    {item.type === 'github' ? '查看项目' : '查看原文'}
                  </button>
                  <button className="flex-1 flex items-center justify-center gap-2 py-2 rounded-lg bg-mint/10 text-mint hover:bg-mint/20 transition-colors">
                    <Brain className="w-4 h-4" />
                    {item.type === 'github' ? '技术简报' : '生成脑图'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="card text-center py-16">
            <div className="w-20 h-20 rounded-2xl bg-gray-100 flex items-center justify-center mx-auto mb-4">
              <Star className="w-10 h-10 text-gray-300" />
            </div>
            <h2 className="text-xl font-bold text-gray-800 mb-2">📭 还没有收藏内容</h2>
            <p className="text-gray-500 mb-6">快去学习吧！</p>
            
            <div className="border-t border-gray-100 pt-6">
              <h3 className="text-sm font-medium text-gray-700 mb-4">热门推荐</h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {mockRecommendations.map((item) => (
                  <button
                    key={item.id}
                    className="p-4 rounded-xl border border-gray-200 text-left hover:border-mint/30 transition-colors"
                  >
                    <div className="flex items-center gap-2 mb-2">
                      {item.type === 'xiaohongshu' && <BookOpen className="w-4 h-4 text-[#FF2442]" />}
                      {item.type === 'bilibili' && <Video className="w-4 h-4 text-[#FB7299]" />}
                      {item.type === 'github' && <Code className="w-4 h-4 text-gray-600" />}
                      <span className="font-medium text-gray-800 text-sm">{item.title}</span>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {item.tags.map((tag, index) => (
                        <span key={index} className="text-xs text-gray-500">{tag}</span>
                      ))}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default Favorites;
