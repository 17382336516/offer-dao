// 会员套餐选择：月度/季度/终身，横向排列，月度默认选中。
// 纯前端状态组件，价格与说明为展示用常量，未接入支付。
const PLANS = [
  { id: 'month', name: '月度会员', price: '¥12.9', desc: '享受 30 天会员权益', badge: null, badgeColor: null },
  { id: 'quarter', name: '季度会员', price: '¥29.9', desc: '享受 90 天会员权益', badge: '省 ¥8', badgeColor: 'rgba(245,158,11,.14)' },
  { id: 'lifetime', name: '终身会员', price: '¥49.9', desc: '永久享受会员权益', badge: '超值推荐', badgeColor: 'rgba(239,68,68,.12)' },
];

export default function VipPlans({ selected, onSelect }) {
  return (
    <div style={{ padding: '4px 32px 0' }}>
      <h3 style={{ margin: '0 0 12px', fontSize: 20, fontWeight: 600, color: '#111827' }}>选择会员套餐</h3>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        {PLANS.map((p) => {
          const active = selected === p.id;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => onSelect(p.id)}
              style={{
                position: 'relative',
                width: 220,
                height: 132,
                flex: '1 1 200px',
                borderRadius: 16,
                background: '#FFFFFF',
                border: active ? '2px solid #F59E0B' : '1px solid #E5E7EB',
                cursor: 'pointer',
                padding: 20,
                textAlign: 'left',
                transition: 'border-color .15s ease, box-shadow .15s ease',
                boxShadow: active ? '0 8px 24px rgba(245,158,11,.16)' : 'none',
              }}
            >
              {/* 右上角标签 */}
              {p.badge && (
                <span
                  style={{
                    position: 'absolute',
                    top: 12,
                    right: 12,
                    padding: '3px 8px',
                    borderRadius: 8,
                    background: p.badgeColor,
                    color: p.id === 'lifetime' ? '#DC2626' : '#B45309',
                    fontSize: 12,
                    fontWeight: 600,
                  }}
                >
                  {p.badge}
                </span>
              )}

              <div style={{ fontSize: 16, fontWeight: 600, color: '#111827' }}>{p.name}</div>
              <div style={{ fontSize: 26, fontWeight: 700, color: '#111827', margin: '10px 0 6px' }}>{p.price}</div>
              <div style={{ fontSize: 13, color: '#6B7280' }}>{p.desc}</div>

              {/* 选中态右下角黄色圆形勾选 */}
              {active && (
                <span
                  style={{
                    position: 'absolute',
                    bottom: 14,
                    right: 14,
                    width: 22,
                    height: 22,
                    borderRadius: '50%',
                    background: '#F59E0B',
                    color: '#fff',
                    fontSize: 13,
                    fontWeight: 700,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  ✓
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
