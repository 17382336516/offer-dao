// 升级 Offer到会员 · 购买弹窗页面（760px，现代 AI SaaS 风格）
// 组合：Header + 会员态状态条 + VipBenefits + VipPlans(普通用户) + VipButton
// 未接入支付：购买/管理按钮点击后保留交互状态并提示入口已预留。
import { useState } from 'react';
import VipBenefits from './VipBenefits';
import VipPlans from './VipPlans';
import VipButton from './VipButton';

export default function VipModal({ isVip, onClose }) {
  const [plan, setPlan] = useState('month'); // 默认选中月度会员
  const [touched, setTouched] = useState(false);

  const handleAction = () => setTouched(true);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(17,24,39,.45)',
        backdropFilter: 'blur(6px)',
        WebkitBackdropFilter: 'blur(6px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 760,
          maxWidth: '100%',
          maxHeight: '90vh',
          overflowY: 'auto',
          background: '#fff',
          borderRadius: 24,
          boxShadow: '0 20px 60px rgba(0,0,0,0.15)',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* ===== 顶部 Header（110px）===== */}
        <div
          style={{
            minHeight: 110,
            padding: '24px 32px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottom: '1px solid #EEEEEE',
            position: 'relative',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <span style={{ fontSize: 36, lineHeight: 1 }}>👑</span>
            <div>
              <h2 style={{ margin: 0, fontSize: 32, fontWeight: 700, color: '#111827', letterSpacing: '-0.5px' }}>
                升级 Offer到会员
              </h2>
              <p style={{ margin: '6px 0 0', fontSize: 16, color: '#6B7280' }}>
                解锁 AI 学习陪跑无限能力
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            style={{
              width: 40,
              height: 40,
              borderRadius: '50%',
              border: 'none',
              background: 'transparent',
              color: '#111827',
              fontSize: 24,
              lineHeight: 1,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'background .15s ease',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = '#F3F4F6'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >
            ×
          </button>
        </div>

        {/* ===== 会员用户：当前状态条 ===== */}
        {isVip && (
          <div style={{ padding: '20px 32px 0' }}>
            <div
              style={{
                padding: '14px 16px',
                borderRadius: 14,
                background: 'rgba(212,175,55,.10)',
                border: '1px solid rgba(184,134,11,.28)',
                fontSize: 13,
                color: '#8a6d1f',
              }}
            >
              <div style={{ fontWeight: 700, marginBottom: 4 }}>你正在享受会员权益</div>
              <div>· 会员服务生效中，权益全解锁</div>
              <div>· 已解锁：AI 笔记无限 / 面经无限 / 路线无限优化</div>
            </div>
          </div>
        )}

        {/* ===== 会员专享权益 ===== */}
        <VipBenefits />

        {/* ===== 套餐选择（仅普通用户）===== */}
        {!isVip && <VipPlans selected={plan} onSelect={setPlan} />}

        {/* ===== 底部按钮 ===== */}
        <VipButton isVip={isVip} onAction={handleAction} />

        {/* 未接入支付提示 */}
        {touched && (
          <p style={{ textAlign: 'center', fontSize: 12, color: '#9CA3AF', margin: '0 0 24px', padding: '0 32px' }}>
            当前版本暂未接入支付，{isVip ? '会员管理' : '开通'}入口已预留
          </p>
        )}
      </div>
    </div>
  );
}
