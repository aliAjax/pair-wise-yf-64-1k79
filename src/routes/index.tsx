import { $, component$, useSignal, useStore, useVisibleTask$ } from '@builder.io/qwik';
import { Progress } from '@qwik-ui/headless';
import { useForm, zodForm$ } from '@modular-forms/qwik';
import { useSpeakLocale } from 'qwik-speak';
import { z } from 'zod';
import type { DocumentHead } from '@builder.io/qwik-city';

type SpeechStatus = 'queued' | 'speaking' | 'done' | 'skipped';
type InterpreterStatus = 'active' | 'handoff' | 'standby';
type CaptionStatus = 'draft' | 'confirmed' | 'invalid';
type Room = { id: string; name: string; topic: string; simultaneousChannels: number };
type Speech = { id: string; roomId: string; speaker: string; delegation: string; language: string; topic: string; plannedSeconds: number; remainingSeconds: number; status: SpeechStatus; updatedAt: string };
type Channel = { id: string; roomId: string; language: string; interpreter: string; status: InterpreterStatus; health: number };
type Term = { id: string; phrase: string; translation: string; language: string; approved: boolean };
type Caption = { id: string; speechId: string; roomId: string; language: string; interpreter: string; text: string; revision: number; at: string; status: CaptionStatus };
type Audit = { id: string; at: string; roomId: string; message: string };
type OpKind = 'speech' | 'caption' | 'interpreter';
type OpStatus = 'pending-merge' | 'failed';
type PendingOp = {
  id: string;
  hallId: string;
  opNo: number;
  kind: OpKind;
  label: string;
  baseVersion: number;
  payload: Record<string, any>;
  diff: string[];
  status: OpStatus;
  attempts: number;
  lastError?: string;
  at: string;
};

interface ConferenceState {
  rooms: Room[];
  activeRoomId: string;
  speechQueue: Speech[];
  channels: Channel[];
  terms: Term[];
  captions: Caption[];
  audits: Audit[];
  lowLatency: boolean;
  hallVersions: Record<string, number>;
  opSeq: Record<string, number>;
  pendingOps: PendingOp[];
  simulateFailure: boolean;
}

const STORAGE_KEY = 'conference-interpretation-v2';
const now = new Date().toISOString();
const seed: ConferenceState = {
  rooms: [
    { id: 'hall-a', name: 'A厅 · 全体会议', topic: '全球气候融资', simultaneousChannels: 6 },
    { id: 'hall-b', name: 'B厅 · 技术分会', topic: '人工智能基础设施', simultaneousChannels: 4 }
  ],
  activeRoomId: 'hall-a',
  speechQueue: [
    { id: 'speech-1', roomId: 'hall-a', speaker: 'Amina Diallo', delegation: '塞内加尔', language: '英语', topic: '适应性融资缺口', plannedSeconds: 600, remainingSeconds: 214, status: 'speaking', updatedAt: now },
    { id: 'speech-2', roomId: 'hall-a', speaker: '李明远', delegation: '中国', language: '中文', topic: '绿色基础设施机制', plannedSeconds: 600, remainingSeconds: 600, status: 'queued', updatedAt: now },
    { id: 'speech-3', roomId: 'hall-b', speaker: 'Maria Silva', delegation: '巴西', language: '葡萄牙语', topic: '边缘算力与能源', plannedSeconds: 420, remainingSeconds: 420, status: 'queued', updatedAt: now }
  ],
  channels: [
    { id: 'ch-a-zh', roomId: 'hall-a', language: '中文', interpreter: '周雨', status: 'active', health: 96 },
    { id: 'ch-a-es', roomId: 'hall-a', language: '西班牙语', interpreter: 'Lucía M.', status: 'active', health: 91 },
    { id: 'ch-a-fr', roomId: 'hall-a', language: '法语', interpreter: 'Noah B.', status: 'standby', health: 88 },
    { id: 'ch-b-zh', roomId: 'hall-b', language: '中文', interpreter: '何佳', status: 'active', health: 94 }
  ],
  terms: [
    { id: 'term-1', phrase: 'loss and damage', translation: '损失与损害', language: '中文', approved: true },
    { id: 'term-2', phrase: 'edge inference', translation: '边缘推理', language: '中文', approved: true },
    { id: 'term-3', phrase: 'just transition', translation: '公正转型', language: '中文', approved: false }
  ],
  captions: [
    { id: 'caption-1', speechId: 'speech-1', roomId: 'hall-a', language: '中文', interpreter: '周雨', text: '我们需要把适应资金与可衡量的社区韧性目标绑定。', revision: 2, at: now, status: 'confirmed' }
  ],
  audits: [
    { id: 'audit-1', at: now, roomId: 'hall-a', message: 'Amina Diallo 开始发言，中文频道由周雨接续' },
    { id: 'audit-2', at: new Date(Date.now() - 90000).toISOString(), roomId: 'hall-a', message: '临时插话申请已插入队列第2位' }
  ],
  lowLatency: false,
  hallVersions: { 'hall-a': 3, 'hall-b': 1 },
  opSeq: { 'hall-a': 0, 'hall-b': 0 },
  pendingOps: [],
  simulateFailure: false
};

const captionSchema = z.object({ text: z.string().min(1, '字幕不能为空') });
const queueSchema = z.object({
  speaker: z.string().min(2, '请输入发言人'),
  delegation: z.string().min(2, '请输入代表团'),
  language: z.string().min(2),
  topic: z.string().min(3, '请输入议题'),
  plannedSeconds: z.coerce.number().min(60).max(3600)
});
type QueueForm = z.infer<typeof queueSchema>;

function hallVersion(state: ConferenceState, hallId: string): number {
  return state.hallVersions[hallId] ?? 0;
}

function nextOpNo(state: ConferenceState, hallId: string): number {
  const n = (state.opSeq[hallId] ?? 0) + 1;
  state.opSeq[hallId] = n;
  return n;
}

function readState(): ConferenceState {
  if (typeof localStorage === 'undefined') return seed;
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (!raw) return seed;
    return normalizeState(raw);
  } catch {
    return seed;
  }
}

function normalizeState(raw: Partial<ConferenceState>): ConferenceState {
  return {
    ...seed,
    ...raw,
    hallVersions: raw.hallVersions ?? { 'hall-a': 0, 'hall-b': 0 },
    opSeq: raw.opSeq ?? { 'hall-a': 0, 'hall-b': 0 },
    pendingOps: raw.pendingOps ?? [],
    simulateFailure: raw.simulateFailure ?? false,
    captions: (raw.captions ?? seed.captions).map((c) => ({ ...c, status: c.status ?? 'confirmed' }))
  };
}

function applyCaption(state: ConferenceState, hallId: string, speechId: string, text: string) {
  const ch = state.channels.find((c) => c.roomId === hallId && c.language === '中文');
  const interpreter = ch?.interpreter ?? '';
  const existing = state.captions.find((c) => c.speechId === speechId && c.language === '中文');
  if (existing) {
    state.captions = state.captions.map((c) => c.id === existing.id ? { ...c, text, interpreter, status: 'confirmed', revision: c.revision + 1, at: new Date().toISOString() } : c);
  } else {
    state.captions.unshift({ id: crypto.randomUUID(), speechId, roomId: hallId, language: '中文', interpreter, text, revision: 1, status: 'confirmed', at: new Date().toISOString() });
  }
}

// 发言人切换 / 译员交接 / 队列顺序变化后，未确认字幕草稿失效并重新归属到当前发言人与译员
function invalidateDrafts(state: ConferenceState, hallId: string) {
  const currentSpeech = state.speechQueue.find((s) => s.roomId === hallId && s.status === 'speaking');
  const ch = state.channels.find((c) => c.roomId === hallId && c.language === '中文');
  state.captions = state.captions.map((c) => {
    if (c.roomId !== hallId || c.status === 'confirmed') return c;
    return { ...c, status: 'invalid', speechId: currentSpeech?.id ?? c.speechId, interpreter: ch?.interpreter ?? c.interpreter };
  });
}

function reorderQueue(state: ConferenceState, hallId: string, orderedIds: string[]) {
  const byId = new Map(state.speechQueue.map((s) => [s.id, s]));
  const hallItems = orderedIds.map((id) => byId.get(id)).filter((s): s is Speech => Boolean(s));
  const other = state.speechQueue.filter((s) => s.roomId !== hallId);
  state.speechQueue = [...hallItems, ...other];
}

function applyPayload(state: ConferenceState, hallId: string, payload: Record<string, any>) {
  const p = payload;
  switch (p.action) {
    case 'speech-add': {
      state.speechQueue.push({ ...p.speech, updatedAt: new Date().toISOString() });
      state.audits.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), roomId: hallId, message: `${p.speech.speaker} 已加入发言队列` });
      break;
    }
    case 'speech-status': {
      state.speechQueue = state.speechQueue.map((it) => it.id === p.speechId ? { ...it, status: p.status, updatedAt: new Date().toISOString() } : it);
      if (p.status === 'speaking') {
        state.speechQueue = state.speechQueue.map((it) => it.id !== p.speechId && it.roomId === hallId && it.status === 'speaking' ? { ...it, status: 'done' } : it);
      }
      state.audits.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), roomId: hallId, message: `发言 ${p.speechId} 状态更新为 ${p.status}` });
      invalidateDrafts(state, hallId);
      break;
    }
    case 'speech-adjust': {
      state.speechQueue = state.speechQueue.map((it) => it.id === p.speechId ? { ...it, remainingSeconds: Math.max(0, it.remainingSeconds + p.delta), updatedAt: new Date().toISOString() } : it);
      break;
    }
    case 'reorder': {
      reorderQueue(state, hallId, p.orderedIds);
      state.audits.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), roomId: hallId, message: '发言队列顺序已调整' });
      invalidateDrafts(state, hallId);
      break;
    }
    case 'handoff-start': {
      state.channels = state.channels.map((c) => c.id === p.channelId ? { ...c, status: 'handoff' } : c);
      state.audits.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), roomId: hallId, message: `${p.channelId} 启动译员交接，原译文版本已冻结` });
      break;
    }
    case 'handoff-complete': {
      state.channels = state.channels.map((c) => c.id === p.channelId ? { ...c, interpreter: p.interpreter, status: 'active', health: Math.min(100, c.health + 2) } : c);
      state.audits.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), roomId: hallId, message: `${p.interpreter} 接续 ${p.channelId}，后续字幕归属新译员` });
      invalidateDrafts(state, hallId);
      break;
    }
    case 'caption': {
      applyCaption(state, hallId, p.speechId, p.text);
      break;
    }
  }
}

function computeDiff(state: ConferenceState, op: { hallId: string; payload: Record<string, any> }): string[] {
  const p = op.payload;
  const hallId = op.hallId;
  switch (p.action) {
    case 'caption': {
      const speech = state.speechQueue.find((s) => s.id === p.speechId);
      const ch = state.channels.find((c) => c.roomId === hallId && c.language === '中文');
      const existing = state.captions.find((c) => c.speechId === p.speechId && c.language === '中文');
      return [
        `发言人：${speech?.speaker ?? '（未知）'}`,
        `译员：${ch?.interpreter ?? '（未知）'}`,
        `原字幕：${existing?.text ?? '（无，将新建）'}`,
        `新字幕：${p.text}`
      ];
    }
    case 'speech-status': {
      const s = state.speechQueue.find((x) => x.id === p.speechId);
      return [`发言 ${s?.speaker ?? p.speechId} 状态：${s?.status ?? '?'} → ${p.status}`];
    }
    case 'speech-adjust': {
      const s = state.speechQueue.find((x) => x.id === p.speechId);
      const next = Math.max(0, (s?.remainingSeconds ?? 0) + p.delta);
      return [`发言 ${s?.speaker ?? ''} 剩余时间：${s?.remainingSeconds ?? 0} → ${next} 秒`];
    }
    case 'handoff-start': {
      const ch = state.channels.find((c) => c.id === p.channelId);
      return [`频道 ${ch?.language ?? p.channelId} 状态：${ch?.status ?? '?'} → handoff`];
    }
    case 'handoff-complete': {
      const ch = state.channels.find((c) => c.id === p.channelId);
      return [`频道 ${ch?.language ?? ''} 译员：${ch?.interpreter ?? '?'} → ${p.interpreter}`, `状态：${ch?.status ?? '?'} → active`];
    }
    case 'reorder': {
      return ['发言队列顺序已调整，与当前顺序存在差异'];
    }
    case 'speech-add': {
      return [`新增发言：${p.speech?.speaker ?? ''} · ${p.speech?.topic ?? ''}`];
    }
    default:
      return ['存在未合并的修改'];
  }
}

// 写入带依据版本：baseVersion 与当前版本一致才提交，否则先写入保留、后到进待合并
function commitWrite(
  state: ConferenceState,
  hallId: string,
  baseVersion: number,
  kind: OpKind,
  label: string,
  payload: Record<string, any>
): { ok: boolean; reason?: 'conflict' | 'failed' } {
  const opNo = nextOpNo(state, hallId);
  const current = hallVersion(state, hallId);
  const base = baseVersion ?? current;
  if (state.simulateFailure) {
    state.pendingOps = [{
      id: crypto.randomUUID(), hallId, opNo, kind, label,
      baseVersion: base, payload, diff: computeDiff(state, { hallId, payload }),
      status: 'failed', attempts: 1, lastError: '模拟网络失败：写入未送达', at: new Date().toISOString()
    }, ...state.pendingOps];
    return { ok: false, reason: 'failed' };
  }
  if (base !== current) {
    state.pendingOps = [{
      id: crypto.randomUUID(), hallId, opNo, kind, label,
      baseVersion: base, payload, diff: computeDiff(state, { hallId, payload }),
      status: 'pending-merge', attempts: 1, at: new Date().toISOString()
    }, ...state.pendingOps];
    return { ok: false, reason: 'conflict' };
  }
  applyPayload(state, hallId, payload);
  state.hallVersions[hallId] = current + 1;
  return { ok: true };
}

// 写入失败后按厅 + 操作编号重试
function retryOp(state: ConferenceState, opId: string) {
  const op = state.pendingOps.find((o) => o.id === opId);
  if (!op) return;
  op.attempts += 1;
  op.at = new Date().toISOString();
  if (state.simulateFailure) {
    op.status = 'failed';
    op.lastError = '模拟网络失败：写入未送达';
    return;
  }
  const current = hallVersion(state, op.hallId);
  if (op.baseVersion !== current) {
    op.status = 'pending-merge';
    op.diff = computeDiff(state, op);
    return;
  }
  applyPayload(state, op.hallId, op.payload);
  state.hallVersions[op.hallId] = current + 1;
  state.pendingOps = state.pendingOps.filter((o) => o.id !== opId);
}

// 待合并项基于最新版本重提（先写入的内容不被覆盖）
function rebaseOp(state: ConferenceState, opId: string) {
  const op = state.pendingOps.find((o) => o.id === opId);
  if (!op) return;
  const current = hallVersion(state, op.hallId);
  op.baseVersion = current;
  op.diff = computeDiff(state, op);
  applyPayload(state, op.hallId, op.payload);
  state.hallVersions[op.hallId] = current + 1;
  state.pendingOps = state.pendingOps.filter((o) => o.id !== opId);
}

function discardOp(state: ConferenceState, opId: string) {
  state.pendingOps = state.pendingOps.filter((o) => o.id !== opId);
}

// 模拟另一主持人抢先保存（先写入），本地依据版本随之落后
function competingSave(state: ConferenceState) {
  const hallId = state.activeRoomId;
  const current = hallVersion(state, hallId);
  const speech = state.speechQueue.find((s) => s.roomId === hallId && s.status === 'speaking');
  if (speech) applyCaption(state, hallId, speech.id, `（另一主持人抢先保存）${new Date().toLocaleTimeString()} 临时发言与字幕`);
  state.audits.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), roomId: hallId, message: `另一主持人已抢先保存，版本 v${current} → v${current + 1}` });
  state.hallVersions[hallId] = current + 1;
}

export default component$(() => {
  const locale = useSpeakLocale();
  const state = useStore<ConferenceState>(readState());
  const captionLoader = useSignal({ text: '' });
  const [captionForm, { Form: CaptionForm, Field: CaptionField }] = useForm<z.infer<typeof captionSchema>>({
    loader: captionLoader,
    validate: zodForm$(captionSchema)
  });
  const queueLoader = useSignal<QueueForm>({ speaker: '', delegation: '', language: '英语', topic: '', plannedSeconds: 300 });
  const [queueForm, { Form: QueueForm, Field: QueueField }] = useForm<QueueForm>({
    loader: queueLoader,
    validate: zodForm$(queueSchema)
  });

  // 各域写入时依据的版本（聚焦控件时捕获）
  const captionBase = useSignal<number | null>(null);
  const queueBase = useSignal<number | null>(null);
  const channelBase = useSignal<number | null>(null);

  useVisibleTask$(({ track }) => {
    track(() => state);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  });

  const activeRoom = () => state.rooms.find((room) => room.id === state.activeRoomId) ?? state.rooms[0];
  const roomQueue = () => state.speechQueue.filter((item) => item.roomId === state.activeRoomId);
  const roomChannels = () => state.channels.filter((item) => item.roomId === state.activeRoomId);
  const currentSpeech = () => roomQueue().find((item) => item.status === 'speaking');
  const baseLabel = (b: number | null) => (b === null ? '未捕获' : `v${b}`);

  const selectRoom$ = $((roomId: string) => {
    state.activeRoomId = roomId;
    captionBase.value = null;
    queueBase.value = null;
    channelBase.value = null;
    state.audits.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), roomId, message: `切换到 ${state.rooms.find((room) => room.id === roomId)?.name}` });
  });

  const addSpeech$ = $((values: QueueForm) => {
    const hallId = state.activeRoomId;
    const base = queueBase.value ?? hallVersion(state, hallId);
    const speech = { id: crypto.randomUUID(), roomId: hallId, ...values, remainingSeconds: values.plannedSeconds, status: 'queued' as SpeechStatus, updatedAt: new Date().toISOString() };
    const res = commitWrite(state, hallId, base, 'speech', `新增发言 · ${values.speaker}`, { action: 'speech-add', speech });
    if (res.ok) queueBase.value = hallVersion(state, hallId);
  });

  const advanceSpeech$ = $((id: string, status: SpeechStatus) => {
    const hallId = state.activeRoomId;
    const base = queueBase.value ?? hallVersion(state, hallId);
    const res = commitWrite(state, hallId, base, 'speech', `发言状态 → ${status}`, { action: 'speech-status', speechId: id, status });
    if (res.ok) queueBase.value = hallVersion(state, hallId);
  });

  const adjustSeconds$ = $((id: string, delta: number) => {
    const hallId = state.activeRoomId;
    const base = queueBase.value ?? hallVersion(state, hallId);
    commitWrite(state, hallId, base, 'speech', `调整计时 ${delta}s`, { action: 'speech-adjust', speechId: id, delta });
  });

  const reorderSpeech$ = $((id: string, dir: -1 | 1) => {
    const hallId = state.activeRoomId;
    const base = queueBase.value ?? hallVersion(state, hallId);
    const ids = roomQueue().map((s) => s.id);
    const idx = ids.indexOf(id);
    const swap = idx + dir;
    if (swap < 0 || swap >= ids.length) return;
    const next = [...ids];
    [next[idx], next[swap]] = [next[swap], next[idx]];
    commitWrite(state, hallId, base, 'speech', '队列顺序调整', { action: 'reorder', orderedIds: next });
  });

  const handoff$ = $((channelId: string) => {
    const hallId = state.activeRoomId;
    const base = channelBase.value ?? hallVersion(state, hallId);
    commitWrite(state, hallId, base, 'interpreter', '启动译员交接', { action: 'handoff-start', channelId });
  });

  const completeHandoff$ = $((channelId: string, interpreter: string) => {
    const hallId = state.activeRoomId;
    const base = channelBase.value ?? hallVersion(state, hallId);
    const res = commitWrite(state, hallId, base, 'interpreter', `完成交接 → ${interpreter}`, { action: 'handoff-complete', channelId, interpreter });
    if (res.ok) channelBase.value = hallVersion(state, hallId);
  });

  const publishCaption$ = $(async (values: z.infer<typeof captionSchema>) => {
    const hallId = state.activeRoomId;
    const speech = state.speechQueue.find((s) => s.roomId === hallId && s.status === 'speaking');
    if (!speech) return;
    const base = captionBase.value ?? hallVersion(state, hallId);
    const res = commitWrite(state, hallId, base, 'caption', `字幕修正 · ${speech.speaker}`, { action: 'caption', speechId: speech.id, text: values.text });
    if (res.ok) {
      captionBase.value = hallVersion(state, hallId);
      captionLoader.value = { text: '' };
    }
  });

  const approveTerm$ = $((id: string) => {
    state.terms = state.terms.map((term) => term.id === id ? { ...term, approved: true } : term);
    state.audits.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), roomId: state.activeRoomId, message: `术语已批准：${state.terms.find((term) => term.id === id)?.phrase}` });
  });

  return (
    <main class={`conference-shell ${state.lowLatency ? 'low-latency' : ''}`}>
      <header class="hero">
        <div><span class="pill">{locale.lang}</span><h1>同声传译与发言队列</h1><p>{activeRoom().name} · {activeRoom().topic} · 版本 v{hallVersion(state, state.activeRoomId)}</p></div>
        <div style="display:flex;gap:12px;flex-wrap:wrap">
          <select value={state.activeRoomId} onChange$={(event) => selectRoom$((event.target as HTMLSelectElement).value)}>{state.rooms.map((room) => <option value={room.id}>{room.name}</option>)}</select>
          <button class="secondary" onClick$={() => state.lowLatency = !state.lowLatency}>{state.lowLatency ? '退出低延迟' : '低延迟模式'}</button>
        </div>
      </header>

      <section class="grid">
        <article class="panel" onFocusin$={() => { queueBase.value = hallVersion(state, state.activeRoomId); }}>
          <div style="display:flex;justify-content:space-between;align-items:center">
            <h2>发言队列</h2>
            <span class="pill">{roomQueue().length} 条 · 依据 {baseLabel(queueBase.value)}
              <button class="link-btn" onClick$={() => queueBase.value = hallVersion(state, state.activeRoomId)}>刷新</button>
            </span>
          </div>
          {roomQueue().map((speech, index) => (
            <div class={`queue-row ${speech.status === 'speaking' ? 'active' : ''}`} key={speech.id}>
              <strong>#{index + 1}</strong>
              <div><b>{speech.speaker}</b><div style="color:#638087;font-size:13px">{speech.delegation} · {speech.language} · {speech.topic}</div></div>
              <span class="pill">{speech.status}</span>
              <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
                {speech.status === 'queued' && <>
                  <button title="上移" class="secondary" onClick$={() => reorderSpeech$(speech.id, -1)}>↑</button>
                  <button title="下移" class="secondary" onClick$={() => reorderSpeech$(speech.id, 1)}>↓</button>
                  <button onClick$={() => advanceSpeech$(speech.id, 'speaking')}>开始</button>
                  <button class="danger" onClick$={() => advanceSpeech$(speech.id, 'skipped')}>跳过</button>
                </>}
                {speech.status === 'speaking' && <>
                  <button onClick$={() => advanceSpeech$(speech.id, 'done')}>结束</button>
                  <button class="secondary" onClick$={() => adjustSeconds$(speech.id, -60)}>减1分钟</button>
                </>}
              </div>
            </div>
          ))}
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-top:18px">
            <QueueForm onSubmit$={addSpeech$}>
              <QueueField name="speaker">{(field, props) => <input {...props} value={field.value} onInput$={(event) => field.value = (event.target as HTMLInputElement).value} placeholder="发言人" />}</QueueField>
              <QueueField name="delegation">{(field, props) => <input {...props} value={field.value} onInput$={(event) => field.value = (event.target as HTMLInputElement).value} placeholder="代表团" />}</QueueField>
              <QueueField name="topic">{(field, props) => <input {...props} value={field.value} onInput$={(event) => field.value = (event.target as HTMLInputElement).value} placeholder="议题" />}</QueueField>
              <QueueField name="plannedSeconds" type="number">{(field, props) => <input {...props} type="number" value={field.value} onInput$={(event) => field.value = Number((event.target as HTMLInputElement).value)} placeholder="计划秒数" />}</QueueField>
              <button type="submit">加入队列</button>
            </QueueForm>
          </div>
        </article>

        <aside class="panel">
          <div onFocusin$={() => { channelBase.value = hallVersion(state, state.activeRoomId); }}>
            <h2>频道与译员 <span class="pill">依据 {baseLabel(channelBase.value)}
              <button class="link-btn" onClick$={() => channelBase.value = hallVersion(state, state.activeRoomId)}>刷新</button>
            </span></h2>
            {roomChannels().map((channel) => (
              <div style="padding:12px 0;border-bottom:1px solid #e6efee" key={channel.id}>
                <div style="display:flex;justify-content:space-between"><b>{channel.language} · {channel.interpreter}</b><span class="pill">{channel.status}</span></div>
                <div class="decorative" style="margin:8px 0"><Progress.Root value={channel.health} max={100} /></div>
                <div style="display:flex;gap:8px"><button class="secondary" onClick$={() => handoff$(channel.id)}>开始交接</button>{channel.status === 'handoff' && <button onClick$={() => completeHandoff$(channel.id, `替补译员-${channel.language}`)}>完成交接</button>}</div>
              </div>
            ))}
          </div>
          <h3>实时字幕修正 <span class="pill">依据 {baseLabel(captionBase.value)}
            <button class="link-btn" onClick$={() => captionBase.value = hallVersion(state, state.activeRoomId)}>刷新</button>
          </span></h3>
          {currentSpeech() ? <CaptionForm onSubmit$={publishCaption$}><CaptionField name="text">{(field, props) => <textarea {...props} rows={3} value={field.value} onInput$={(event) => field.value = (event.target as HTMLTextAreaElement).value} onFocusin$={() => { captionBase.value = hallVersion(state, state.activeRoomId); }} placeholder="输入或修正当前字幕" />}</CaptionField><button type="submit">提交新版字幕</button></CaptionForm> : <p>当前没有发言中的代表。</p>}
          {state.captions.filter((caption) => caption.roomId === state.activeRoomId).map((caption) => (
            <div class={`caption-card ${caption.status === 'invalid' ? 'caption-invalid' : ''}`} key={caption.id}>
              <b>{caption.interpreter} · v{caption.revision}</b>
              <span class={`pill ${caption.status === 'confirmed' ? 'pill-ok' : 'pill-invalid'}`}>{caption.status === 'confirmed' ? '已确认' : '草稿已失效·待重归属'}</span>
              <p>{caption.text}</p>
            </div>
          ))}
        </aside>
      </section>

      <section class="grid" style="margin-top:18px">
        <article class="panel">
          <h2>按厅版本账</h2>
          <div style="display:flex;flex-direction:column;gap:8px;margin:10px 0">
            {state.rooms.map((room) => (
              <div key={room.id} style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px;background:#f1f8f7;border-radius:8px">
                <span><b>{room.name}</b></span>
                <span class="pill">版本 v{hallVersion(state, room.id)} · 操作 #{state.opSeq[room.id] ?? 0}</span>
              </div>
            ))}
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
            <button class="secondary" onClick$={() => competingSave(state)}>模拟另一主持人抢先保存</button>
            <button class={state.simulateFailure ? 'danger' : 'secondary'} onClick$={() => state.simulateFailure = !state.simulateFailure}>
              {state.simulateFailure ? '模拟写入失败：开（点击关闭）' : '模拟写入失败：关'}
            </button>
          </div>
          <p style="color:#638087;font-size:13px;margin-top:10px">先写入的内容保留；后到的修改进入「待合并」并列出差异，不会覆盖先到内容。写入失败会保留待办，按厅与操作编号重试，刷新页面后继续。</p>
        </article>

        <article class="panel">
          <h2>待合并 / 重试队列</h2>
          {state.pendingOps.length === 0 && <p style="color:#638087">暂无待办。所有写入均已按依据版本提交。</p>}
          {state.pendingOps.map((op) => {
            const room = state.rooms.find((r) => r.id === op.hallId);
            const stale = op.baseVersion !== hallVersion(state, op.hallId);
            return (
              <div class="op-card" key={op.id}>
                <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
                  <b>#{op.opNo} · {op.label}</b>
                  <span class={`pill ${op.status === 'failed' ? 'pill-failed' : 'pill-merge'}`}>{op.status === 'failed' ? '写入失败' : '待合并'}</span>
                </div>
                <div style="font-size:12px;color:#638087;margin:4px 0">{room?.name} · 依据 v{op.baseVersion} → 当前 v{hallVersion(state, op.hallId)}{stale ? '（已落后）' : ''} · 尝试 {op.attempts} 次</div>
                <ul class="diff-list">
                  {op.diff.map((line, i) => <li key={i}>{line}</li>)}
                </ul>
                {op.lastError && <div class="op-error">{op.lastError}</div>}
                <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
                  {op.status === 'failed' && <button onClick$={() => retryOp(state, op.id)}>按 #{op.opNo} 重试</button>}
                  {op.status === 'pending-merge' && <button onClick$={() => rebaseOp(state, op.id)}>基于最新版本重提</button>}
                  <button class="secondary" onClick$={() => discardOp(state, op.id)}>放弃</button>
                </div>
              </div>
            );
          })}
        </article>
      </section>

      <section class="grid" style="margin-top:18px">
        <article class="panel">
          <h2>术语库</h2>
          {state.terms.map((term) => <div class="queue-row" key={term.id}><span/><div><b>{term.phrase}</b><div>{term.translation} · {term.language}</div></div><span class="pill">{term.approved ? '已批准' : '待审'}</span><button disabled={term.approved} onClick$={() => approveTerm$(term.id)}>批准</button></div>)}
        </article>
        <article class="panel">
          <h2>操作与交接时间线</h2>
          {state.audits.filter((audit) => audit.roomId === state.activeRoomId).slice(0, 10).map((audit) => <div style="padding:10px 0;border-bottom:1px solid #e6efee" key={audit.id}><small>{new Date(audit.at).toLocaleTimeString()}</small><div>{audit.message}</div></div>)}
        </article>
      </section>
    </main>
  );
});

export const head: DocumentHead = {
  title: '国际会议同声传译控制台',
  meta: [{ name: 'description', content: '发言队列、多语种频道、术语、译员交接与实时字幕修正原型' }]
};
