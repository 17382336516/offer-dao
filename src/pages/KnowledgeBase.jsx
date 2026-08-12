import { useEffect, useState } from 'react';
import {
  AlertCircle,
  BookOpen,
  Database,
  FileText,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
  UploadCloud,
} from 'lucide-react';
import {
  deleteRagDoc,
  importRagSources,
  listRagDocs,
  queryRag,
  reindexRagSources,
  reindexRagXhs,
} from '../lib/api';

const sourceLabel = (source) => {
  if (source === 'xhs') return '小红书';
  if (source === 'file') return 'rag_sources';
  return '手动上传';
};

const formatTime = (value) => {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN');
};

export default function KnowledgeBase() {
  const [docs, setDocs] = useState([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [lastImport, setLastImport] = useState(null);
  const [query, setQuery] = useState('');
  const [topK, setTopK] = useState(6);
  const [hits, setHits] = useState([]);
  const [querying, setQuerying] = useState(false);

  const loadDocs = async () => {
    try {
      setDocs(await listRagDocs());
    } catch (e) {
      setMessage('加载知识库失败：' + (e.message || '未知错误'));
    }
  };

  useEffect(() => {
    loadDocs();
  }, []);

  const runImport = async (force = false) => {
    setBusy(true);
    setMessage('');
    setLastImport(null);
    try {
      const result = force ? await reindexRagSources() : await importRagSources(false);
      setLastImport(result);
      setMessage(
        `完成：成功 ${result.success || 0}，跳过 ${result.skipped || 0}，失败 ${result.failed || 0}`
      );
      await loadDocs();
    } catch (e) {
      setMessage('导入失败：' + (e.message || '未知错误'));
    } finally {
      setBusy(false);
    }
  };

  const handleReindexXhs = async () => {
    setBusy(true);
    setMessage('');
    try {
      const result = await reindexRagXhs();
      setMessage(`小红书索引完成：${result.ingested || 0} 篇，${result.totalChunks || 0} 个片段`);
      await loadDocs();
    } catch (e) {
      setMessage('小红书索引失败：' + (e.message || '未知错误'));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (docId) => {
    setBusy(true);
    setMessage('');
    try {
      await deleteRagDoc(docId);
      setMessage('文档已删除');
      await loadDocs();
    } catch (e) {
      setMessage('删除失败：' + (e.message || '未知错误'));
    } finally {
      setBusy(false);
    }
  };

  const handleQuery = async () => {
    if (!query.trim()) return;
    setQuerying(true);
    setHits([]);
    setMessage('');
    try {
      const result = await queryRag({ query: query.trim(), topK });
      setHits(result.hits || []);
      if (!result.hits?.length) setMessage('没有检索到相关片段');
    } catch (e) {
      setMessage('检索失败：' + (e.message || '未知错误'));
    } finally {
      setQuerying(false);
    }
  };

  return (
    <div className="min-h-screen bg-warm-white p-4 md:p-6">
      <div className="max-w-5xl mx-auto space-y-6">
        <section className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center">
              <Database className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gray-800">知识库 RAG</h1>
              <p className="text-sm text-gray-500">从 rag_sources 批量导入资料，生成向量后供学习计划检索使用。</p>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => runImport(false)}
              disabled={busy}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-500 text-white text-sm font-semibold hover:bg-indigo-600 disabled:opacity-60"
            >
              <UploadCloud className="w-4 h-4" />
              批量导入 rag_sources
            </button>
            <button
              onClick={() => runImport(true)}
              disabled={busy}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-white border border-gray-200 text-gray-600 text-sm font-semibold hover:bg-gray-50 disabled:opacity-60"
            >
              <RotateCcw className="w-4 h-4" />
              重新索引
            </button>
          </div>
        </section>

        {message && (
          <div className="rounded-xl border border-gray-100 bg-white px-4 py-3 text-sm text-gray-600 flex gap-2">
            <AlertCircle className="w-4 h-4 text-indigo-500 shrink-0 mt-0.5" />
            <span>{message}</span>
          </div>
        )}

        {lastImport?.items?.length > 0 && (
          <section className="card">
            <h2 className="text-base font-bold text-gray-800 mb-3">最近导入结果</h2>
            <div className="space-y-2 max-h-72 overflow-auto">
              {lastImport.items.map((item) => (
                <div key={item.file} className="flex items-start gap-3 rounded-lg bg-warm-white/60 px-3 py-2 text-sm">
                  <span
                    className={`mt-0.5 px-2 py-0.5 rounded-full text-xs ${
                      item.status === 'failed'
                        ? 'bg-red-50 text-red-500'
                        : item.status === 'skipped'
                          ? 'bg-gray-100 text-gray-500'
                          : 'bg-mint/10 text-mint'
                    }`}
                  >
                    {item.status}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-gray-700 truncate">{item.file}</p>
                    <p className="text-xs text-gray-400">
                      {item.error || item.reason || `${item.chunks || 0} 个片段`}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="card">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div>
              <h2 className="text-base font-bold text-gray-800">检索测试</h2>
              <p className="text-xs text-gray-400 mt-1">输入问题后查看 Top K 命中的来源文件、片段和相似度。</p>
            </div>
            <button
              onClick={handleReindexXhs}
              disabled={busy}
              className="flex items-center gap-2 px-3 py-2 rounded-xl bg-mint/10 text-mint text-sm font-semibold hover:bg-mint/20 disabled:opacity-60"
            >
              <RefreshCw className="w-4 h-4" />
              重建小红书索引
            </button>
          </div>

          <div className="flex flex-wrap gap-2 mb-4">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleQuery()}
              placeholder="例如：AI产品经理需要哪些项目经验？"
              className="flex-1 min-w-[260px] p-3 rounded-xl border border-gray-200 bg-warm-white/50 focus:outline-none focus:border-indigo-400 text-sm"
            />
            <input
              type="number"
              min={1}
              max={20}
              value={topK}
              onChange={(e) => setTopK(Math.max(1, Math.min(20, Number(e.target.value) || 6)))}
              className="w-20 p-3 rounded-xl border border-gray-200 bg-warm-white/50 focus:outline-none focus:border-indigo-400 text-sm"
            />
            <button
              onClick={handleQuery}
              disabled={querying}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-500 text-white text-sm font-semibold hover:bg-indigo-600 disabled:opacity-60"
            >
              <Search className="w-4 h-4" />
              检索
            </button>
          </div>

          <div className="space-y-3">
            {hits.map((hit, index) => (
              <div key={hit.id || index} className="rounded-xl border border-gray-100 bg-warm-white/50 p-4">
                <div className="flex flex-wrap items-center gap-2 mb-2 text-xs">
                  <span className="px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-600">{sourceLabel(hit.source)}</span>
                  <span className="font-semibold text-gray-700">{hit.title}</span>
                  {hit.meta?.relativePath && <span className="text-gray-400">{hit.meta.relativePath}</span>}
                  <span className="ml-auto text-gray-400">相似度 {Number(hit.score || 0).toFixed(3)}</span>
                </div>
                <p className="text-sm text-gray-600 leading-6 whitespace-pre-wrap">{hit.content}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="card">
          <div className="flex items-center gap-2 mb-3">
            <Database className="w-4 h-4 text-indigo-500" />
            <h2 className="text-base font-bold text-gray-800">文档列表（{docs.length}）</h2>
          </div>

          {docs.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-8">暂无文档。点击“批量导入 rag_sources”开始构建知识库。</p>
          ) : (
            <div className="space-y-2">
              {docs.map((doc) => (
                <div key={doc.doc_id} className="flex items-center gap-3 bg-warm-white/50 rounded-xl p-3">
                  <div className="w-9 h-9 rounded-lg bg-indigo-50 text-indigo-600 flex items-center justify-center shrink-0">
                    {doc.source === 'xhs' ? <BookOpen className="w-4 h-4" /> : <FileText className="w-4 h-4" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-gray-800 truncate">{doc.title}</p>
                    <p className="text-xs text-gray-400 truncate">
                      {sourceLabel(doc.source)} · {doc.chunk_count} 个片段 · {doc.status || 'indexed'} · {formatTime(doc.created_at)}
                      {doc.relativePath ? ` · ${doc.relativePath}` : ''}
                    </p>
                  </div>
                  <button
                    onClick={() => handleDelete(doc.doc_id)}
                    disabled={busy}
                    title="删除文档及其片段"
                    className="p-2 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors disabled:opacity-60"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
