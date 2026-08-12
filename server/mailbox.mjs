import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

const KEYWORDS = ['面试', '面邀', '笔试', '约面', '时间确认', '面试邀请', '初试', '复试', '终面'];

function secureByPort(port) {
  return Number(port) === 993 || Number(port) === 465;
}

function normalizeAccount(account) {
  return {
    provider: account?.provider || 'qq',
    email: String(account?.email || '').trim(),
    authCode: String(account?.authCode || '').trim(),
    imapHost: String(account?.imapHost || '').trim(),
    imapPort: Number(account?.imapPort || 993),
    smtpHost: String(account?.smtpHost || '').trim(),
    smtpPort: Number(account?.smtpPort || 465),
  };
}

function extractInterviewTime(text = '') {
  const dateMatch = text.match(/(20\d{2})[年/-](\d{1,2})[月/-](\d{1,2})/);
  const timeMatch = text.match(/(\d{1,2}):(\d{2})/);
  let period = '';
  if (/上午|早上|am/i.test(text)) period = '上午';
  if (/下午|晚上|pm/i.test(text)) period = '下午';
  const date = dateMatch
    ? `${dateMatch[1]}-${String(dateMatch[2]).padStart(2, '0')}-${String(dateMatch[3]).padStart(2, '0')}`
    : '';
  const time = timeMatch ? `${String(timeMatch[1]).padStart(2, '0')}:${timeMatch[2]}` : '';
  return { date, time, period };
}

function detectInterviewInvite(message) {
  const subject = String(message.subject || '');
  const body = String(message.text || '');
  const joined = `${subject}\n${body}`;
  const hit = KEYWORDS.some((kw) => joined.includes(kw));
  if (!hit) return null;
  const company = message.from?.value?.[0]?.name || subject.split(/[：:]/)[0] || '未知公司';
  const info = extractInterviewTime(joined);
  return {
    company,
    role: subject.replace(company, '').replace(/[：:]/g, ' ').trim() || '待确认岗位',
    sender: message.from?.text || '',
    subject,
    date: info.date,
    time: info.time,
    period: info.period,
    preview: body.slice(0, 200),
  };
}

async function withClient(account, fn) {
  const client = new ImapFlow({
    host: account.imapHost,
    port: account.imapPort,
    secure: secureByPort(account.imapPort),
    auth: {
      user: account.email,
      pass: account.authCode,
    },
    logger: false,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => {});
  }
}

export async function testMailboxConnection(rawAccount) {
  const account = normalizeAccount(rawAccount);
  if (!account.email || !account.authCode) throw new Error('邮箱账号或授权码为空');
  return withClient(account, async (client) => {
    const lock = await client.getMailboxLock('INBOX');
    try {
      return {
        ok: true,
        path: client.mailbox?.path || 'INBOX',
        exists: client.mailbox?.exists || 0,
      };
    } finally {
      lock.release();
    }
  });
}

export async function syncInterviewInvites(rawAccount, limit = 10) {
  const account = normalizeAccount(rawAccount);
  if (!account.email || !account.authCode) throw new Error('邮箱账号或授权码为空');
  return withClient(account, async (client) => {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const exists = Number(client.mailbox?.exists || 0);
      if (!exists) return { items: [], scanned: 0 };
      const start = Math.max(1, exists - Math.max(limit * 3, 15) + 1);
      const range = `${start}:${exists}`;
      const items = [];
      for await (const msg of client.fetch(range, { uid: true, envelope: true, source: true })) {
        const parsed = await simpleParser(msg.source);
        const detected = detectInterviewInvite({
          subject: parsed.subject || msg.envelope?.subject || '',
          from: parsed.from || msg.envelope?.from || null,
          text: parsed.text || parsed.html || '',
        });
        if (detected) {
          items.push({
            id: msg.uid,
            ...detected,
          });
        }
      }
      return {
        scanned: exists - start + 1,
        items: items.slice(-limit).reverse(),
      };
    } finally {
      lock.release();
    }
  });
}
