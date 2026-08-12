// 底部购买/管理按钮区：主按钮 + 安全支付提示 + 新用户专享说明。
// 未接入支付：点击后仅保留交互状态并提示入口已预留。
export default function VipButton({ isVip, onAction }) {
  return (
    <div style={{ padding: '16px 32px 24px', marginTop: 'auto' }}>
      <button
        type="button"
        onClick={onAction}
        style={{
          width: '100%',
          height: 56,
          borderRadius: 28,
          border: 'none',
          background: isVip ? '#E5E7EB' : '#67C7B7',
          color: isVip ? '#374151' : '#fff',
          fontSize: 20,
          fontWeight: 700,
          cursor: 'pointer',
          transition: 'background .15s ease, transform .08s ease',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = isVip ? '#D1D5DB' : '#4FB3A3'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = isVip ? '#E5E7EB' : '#67C7B7'; }}
        onMouseDown={(e) => { e.currentTarget.style.transform = 'scale(.99)'; }}
        onMouseUp={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
      >
        {isVip ? '管理会员' : '立即体验会员'}
      </button>

      <p style={{ textAlign: 'center', fontSize: 14, color: '#9CA3AF', margin: '12px 0 0' }}>
        安全支付 · 随时可取消 · 自动续费可管理
      </p>
      <p style={{ textAlign: 'center', fontSize: 13, color: '#9CA3AF', margin: '6px 0 0' }}>
        新用户专享：注册即可获得 3 天会员体验
      </p>
    </div>
  );
}
