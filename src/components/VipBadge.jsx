// 左下角会员入口：皇冠图标，根据会员状态切换高亮/灰色。
// 复用 localStorage 中的 isVip（登录/注册时由 api.js 写入），刷新后不丢失，不引入全局状态。
import { useState } from 'react';
import { getVipState } from '../lib/api';
import VipModal from './VipModal';

export default function VipBadge() {
  const [open, setOpen] = useState(false);
  // 每次渲染读取最新会员状态（登录后写入，刷新后从 localStorage 恢复）
  const isVip = getVipState();

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="vip-badge"
        title={isVip ? '会员已开通' : '开通会员'}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          padding: '10px 12px',
          marginBottom: 4,
          border: 'none',
          borderRadius: 10,
          cursor: 'pointer',
          background: 'transparent',
          color: isVip ? '#b8860b' : 'var(--text-muted)',
          transition: 'background .18s ease, color .18s ease, box-shadow .18s ease',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'rgba(0,0,0,.04)';
          if (isVip) e.currentTarget.style.boxShadow = '0 0 0 1px rgba(184,134,11,.35), 0 0 12px rgba(212,175,55,.25)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent';
          e.currentTarget.style.boxShadow = 'none';
        }}
      >
        <span
          style={{
            fontSize: 18,
            lineHeight: 1,
            filter: isVip ? 'none' : 'grayscale(1) opacity(.55)',
            // 会员皇冠金色渐变 + 轻微发光；普通用户灰色低饱和
            background: isVip
              ? 'linear-gradient(135deg, #ffe08a 0%, #d4af37 45%, #b8860b 100%)'
              : 'linear-gradient(135deg, #cfcfcf 0%, #9a9a9a 100%)',
            WebkitBackgroundClip: 'text',
            backgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            textShadow: isVip ? '0 0 10px rgba(212,175,55,.45)' : 'none',
          }}
        >
          👑
        </span>
        <span style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap' }}>
          {isVip ? '会员已开通' : '开通会员'}
        </span>
      </button>

      {open && <VipModal isVip={isVip} onClose={() => setOpen(false)} />}
    </>
  );
}
