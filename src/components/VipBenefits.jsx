// 会员专享权益列表：4 张权益卡，纵向排列，hover 轻微上浮。
const BENEFITS = [
  {
    icon: '📄',
    title: 'AI 学习笔记不限次数',
    normal: '普通用户：每日只能生成一天学习笔记',
    tag: '无限制',
  },
  {
    icon: '🔍',
    title: '面经 Agent 无限使用',
    normal: '普通用户：每日只能查询一次面经',
    tag: '无限制',
  },
  {
    icon: '🧭',
    title: '学习路线无限优化',
    normal: '普通用户：岗位方向只能修改一次',
    tag: '无限制',
  },
  {
    icon: '🎁',
    title: '新用户免费体验 3 天会员',
    normal: '注册即可自动获得 3 天会员体验',
    tag: '限时福利',
  },
];

export default function VipBenefits() {
  return (
    <div style={{ padding: '18px 32px 4px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ fontSize: 18 }}>💎</span>
        <h3 style={{ margin: 0, fontSize: 20, fontWeight: 600, color: '#111827' }}>会员专享权益</h3>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {BENEFITS.map((b) => (
          <div
            key={b.title}
            style={{
              height: 64,
              width: 'calc(100% - 0px)',
              background: '#fff',
              border: '1px solid #EEEEEE',
              borderRadius: 16,
              display: 'flex',
              alignItems: 'center',
              gap: 16,
              padding: '0 20px',
              transition: 'transform .18s ease, box-shadow .18s ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = 'translateY(-2px)';
              e.currentTarget.style.boxShadow = '0 8px 24px rgba(0,0,0,0.08)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = 'translateY(0)';
              e.currentTarget.style.boxShadow = 'none';
            }}
          >
            <span style={{ fontSize: 26, lineHeight: 1 }}>{b.icon}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 600, color: '#111827' }}>{b.title}</div>
              <div style={{ fontSize: 13, color: '#6B7280', marginTop: 4 }}>{b.normal}</div>
            </div>
            <span
              style={{
                flexShrink: 0,
                padding: '6px 12px',
                borderRadius: 8,
                background: 'rgba(255,179,71,.14)',
                color: '#D97706',
                fontSize: 13,
                fontWeight: 600,
              }}
            >
              {b.tag}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
