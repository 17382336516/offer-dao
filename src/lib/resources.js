// 统一资源字段解析层（前端版）
// 后端 daily_learning_tasks 的 video_info / pdf_info 在 DB 中是 TEXT 列，
// 可能存成 JSON 字符串（旧数据）或数组（新数据）。
// 统一的 parseResourceInfo() 兼容两种形态，输出固定 { videos, pdfs }，
// 避免前端各处重复 JSON.parse / Array.isArray 判断。
//
// 输入支持：
//   1) 整行对象：{ video_info, pdf_info } 或 { videos, pdfs }
//   2) 直接的 raw 字段：字符串 JSON 或数组
// 输出永远是 { videos: [], pdfs: [] }

function toArray(x) {
  if (Array.isArray(x)) return x;
  if (typeof x === 'string') {
    try {
      const p = JSON.parse(x);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function parseResourceInfo(input) {
  if (input == null) return { videos: [], pdfs: [] };

  // 行对象形态
  if (typeof input === 'object' && !Array.isArray(input)) {
    if ('video_info' in input || 'pdf_info' in input || 'videos' in input || 'pdfs' in input) {
      return {
        videos: toArray(input.videos ?? input.video_info ?? []),
        pdfs: toArray(input.pdfs ?? input.pdf_info ?? []),
      };
    }
    return { videos: [], pdfs: [] };
  }

  // 直接传入数组：根据元素特征区分 PDF 与视频。
  // PDF 元素通常含 docId / file / link（指向 /api/rag）等字段；
  // 视频元素通常含 bvid / biliTitle / platform==='bilibili'。
  if (Array.isArray(input)) {
    const videos = [];
    const pdfs = [];
    for (const item of input) {
      if (!item || typeof item !== 'object') { videos.push(item); continue; }
      const isPdf = item.docId || item.file || (item.link && /api\/rag/i.test(item.link)) || item.type === 'pdf';
      const isVideo = item.bvid || item.biliTitle || item.platform === 'bilibili' || item.type === 'video';
      if (isPdf && !isVideo) pdfs.push(item);
      else if (isVideo && !isPdf) videos.push(item);
      else pdfs.push(item); // 兜底：无法判断时归为 pdf（知识库文档为主）
    }
    return { videos, pdfs };
  }

  return { videos: [], pdfs: [] };
}

export default parseResourceInfo;
