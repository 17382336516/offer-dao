// ---------- 统一资源解析层 ----------
// 目的：daily_learning_tasks 表中 video_info / pdf_info 字段类型为 TEXT，
// 实际存储可能是 JSON 字符串（"[{\"title\":\"xxx\"}]"）或数组。
// 本模块提供唯一的 parseResourceInfo() 入口，保证前端/后端拿到的格式统一为：
//   { videos: Array, pdfs: Array }
// 任何读取 daily_learning_tasks 的地方都应通过本函数解析，避免各处重复 JSON.parse。

/**
 * 安全将输入转换为数组
 * - 如果已经是数组，直接返回
 * - 如果是字符串，尝试 JSON.parse（兼容旧数据）
 * - 如果 JSON.parse 得到对象且有 video/pdf 字段，返回 [对象]（兼容包裹格式）
 * - 其他情况返回 []
 */
function toArray(x) {
  if (x == null) return [];
  if (Array.isArray(x)) return x;
  if (typeof x !== 'string') return Array.isArray(x) ? x : [x].filter(Boolean);
  const trimmed = x.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
    // 兼容包裹格式：如 { video: [...], pdf: [...] } 被误存为一个对象
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (Array.isArray(parsed.video)) return parsed.video;
      if (Array.isArray(parsed.pdf)) return parsed.pdf;
      if (Array.isArray(parsed.videos)) return parsed.videos;
      if (Array.isArray(parsed.pdfs)) return parsed.pdfs;
      return [parsed];
    }
    return [parsed];
  } catch {
    // 无法解析为 JSON，视为纯文本标题
    return trimmed ? [{ title: trimmed }] : [];
  }
}

/**
 * 统一解析 daily_learning_tasks 行的 resource 字段
 *
 * @param {object|string} input - 可能是：
 *   - daily_learning_tasks 行对象 { video_info, pdf_info }
 *   - 字符串（JSON 字符串）
 *   - 数组
 * @returns {{ videos: Array, pdfs: Array }}
 */
export function parseResourceInfo(input) {
  if (!input || (typeof input !== 'object' && typeof input !== 'string')) {
    return { videos: [], pdfs: [] };
  }

  // 如果是字符串，尝试 JSON.parse 整个对象
  if (typeof input === 'string') {
    try {
      input = JSON.parse(input);
    } catch {
      return { videos: [], pdfs: [] };
    }
  }

  // 数组形态：根据元素特征区分 PDF 与视频
  if (Array.isArray(input)) {
    const videos = [];
    const pdfs = [];
    for (const item of input) {
      if (!item || typeof item !== 'object') { videos.push(item); continue; }
      const isPdf = item.docId || item.file || (item.link && /api\/rag/i.test(item.link)) || item.type === 'pdf';
      const isVideo = item.bvid || item.biliTitle || item.platform === 'bilibili' || item.type === 'video';
      if (isPdf && !isVideo) pdfs.push(item);
      else if (isVideo && !isPdf) videos.push(item);
      else pdfs.push(item);
    }
    return { videos, pdfs };
  }

  const videos = toArray(input.video_info ?? input.video ?? input.videos ?? []);
  const pdfs = toArray(input.pdf_info ?? input.pdf ?? input.pdfs ?? []);

  return { videos, pdfs };
}

export default { parseResourceInfo };
