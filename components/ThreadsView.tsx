import React, { useEffect, useMemo, useRef, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { ArrowLeft, ArrowUp, Clock, Loader2, Trash2, X, Plus, Search, Globe, Edit, RotateCw, Sparkles, BrainCircuit, ChevronRight, MessageSquareText, Image as ImageIcon } from 'lucide-react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import type { Note, ThreadPending, Source } from '../types';
import { formatMedicalMarkdown, streamThreadAnswer, THREAD_REINFORCE_INSTRUCTION, ThreadAnswerMode } from '../services/claudeService';
import { encodeThread, parseThread, threadTitleFrom, countQuestions, lastQuestionUnanswered, pendingOf, THREAD_SOFT_LIMIT_CHARS, ThreadMessage, uncitedClaims } from '../services/threadFormat';
import { getNoteFromDB } from '../services/storage';
import AutoTextarea from './AutoTextarea';
import { resizeAndCompressImage, imageSrc } from '../services/imageUtils';

interface Props {
    threads: Note[]; // kind === 'thread'
    // 같은 대화에 대한 저장을 순서대로 처리하고, 저장 직전 최신 대화(없으면 null)를 받아 바꾼 대화를 돌려줌
    onUpdate: (id: string, mutate: (latest: Note | null) => Note | null) => Promise<Note | null>;
    onPatchMeta: (id: string, makePatch: (latest: Note) => Partial<Note> | null) => Promise<Note | null>;
    onDelete: (id: string) => Promise<void>;
    onBack: () => void;
    openThreadId?: string | null; // 퀴즈 등에서 열 대화
    onOpened?: () => void;
}

interface StreamState {
    question: string;
    quote?: string;
    text: string;
    status: 'thinking' | 'searching' | 'writing';
    sources?: Source[];
    reinforceAt?: number; // 다시 쓰는 답변(그 답변의 시각) — "근거 보강" 또는 "자세히"
    redoKind?: 'reinforce' | 'expand';
}

const renderMd = (md: string): string => {
    try {
        return DOMPurify.sanitize(marked.parse(formatMedicalMarkdown(md || ''), { breaks: false, gfm: true }) as string);
    } catch {
        return DOMPurify.sanitize(md || '');
    }
};

const fmtTime = (t: number) => {
    if (!t) return '';
    const d = new Date(t);
    const today = new Date();
    return d.toDateString() === today.toDateString()
        ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : d.toLocaleDateString();
};

const errText = (e: any): string => {
    const msg = e?.message || '';
    if (e?.name === 'AbortError') return '답변을 멈췄습니다.';
    if (msg.includes('429') || msg.includes('Quota')) return 'AI 사용량이 많아 잠시 제한되었습니다. 잠시 후 다시 시도해주세요.';
    if (msg.includes('API Key')) return 'API 설정에 문제가 있습니다.';
    if (msg.includes('Failed to fetch') || msg.includes('network')) return '네트워크 연결이 불안정합니다. 다시 시도해주세요.';
    return msg || '답변을 받지 못했습니다.';
};

// 사진: 질문 하나에 최대 4장. 대화의 사진은 모두 한 클라우드 문서(최대 1MB)에 함께 저장되므로 대화 전체 합계도 제한
const MAX_PHOTOS_PER_QUESTION = 4;
const MAX_THREAD_IMAGE_CHARS = 700000;
const MAX_THREAD_DOC_BYTES = 900000; // 사진 + 대화 글자(한글은 글자당 약 3바이트)를 합쳐 1MB 아래로

const hostOf = (uri: string) => { try { return new URL(uri).hostname.replace(/^www\./, ''); } catch { return ''; } };
const escAttr = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// 렌더링된 답변에서 [1][2] 출처 번호를 누르면 그 출처가 열리는 작은 위첨자로.
// (마크다운 변환 뒤에 바꿈 — 의학 표기 변환이 주소의 _ $ 등을 바꾸지 않게. 코드 블록·태그 속성 안은 그대로)
const linkCitations = (html: string, sources: Source[]): string => {
    if (!sources.length) return html;
    return html.split(/(<pre[\s\S]*?<\/pre>|<[^>]+>)/g).map(part => {
        if (part.startsWith('<')) return part;
        return part.replace(/\[(\d{1,2})\]/g, (all, num) => {
            const src = sources[Number(num) - 1];
            if (!src || !/^https?:\/\//.test(src.uri)) return all;
            return `<sup class="cite"><a href="${escAttr(src.uri)}" title="${escAttr(src.title)}">${num}</a></sup>`;
        });
    }).join('');
};

// 답변 하나 (마크다운 렌더링은 내용이 바뀔 때만)
const AnswerBlock: React.FC<{ text: string; sources?: Source[]; onReinforce?: () => void; reinforceDisabled?: boolean; fast?: boolean; onExpand?: () => void }> = React.memo(({ text, sources, onReinforce, reinforceDisabled, fast, onExpand }) => {
    const list = sources || [];
    // 수치·권고·시험 등이 들어갔는데 근거 번호가 없는 문장 (빠른 답변은 "자세히"로 다시 받는 게 우선이라 표시 안 함)
    const uncited = useMemo(() => (onReinforce && !fast ? uncitedClaims(text) : []), [text, onReinforce, fast]);
    const html = useMemo(
        () => linkCitations(renderMd(text), list).replace(/<a href="(https?:)/g, '<a target="_blank" rel="noopener noreferrer" href="$1'),
        [text, sources]
    );
    return (
        <div data-answer="1">
            {fast && (
                <div className="mb-2 flex items-center gap-2">
                    <span className="text-[10px] font-bold text-slate-400">빠른 답변 · 검색을 줄여 짧게 답함</span>
                    {onExpand && (
                        <button
                            onClick={onExpand}
                            disabled={reinforceDisabled}
                            className="ml-auto flex items-center gap-1 px-2.5 py-1 rounded-md border border-accent-200 bg-accent-50 text-[11px] font-bold text-accent-700 hover:bg-accent-100 disabled:opacity-40 whitespace-nowrap"
                            title="같은 질문을 근거 중심(검색 충분히·자세히)으로 다시 받아 이 답변을 바꿈"
                        >
                            <Search className="w-3.5 h-3.5" /> 근거 중심으로 자세히
                        </button>
                    )}
                </div>
            )}
            <div
                className="prose prose-sm prose-slate max-w-none text-slate-700 leading-relaxed break-words [&_code]:break-all [&_code]:whitespace-pre-wrap [&_sup.cite]:ml-0.5 [&_sup.cite_a]:no-underline [&_sup.cite_a]:text-accent-600 [&_sup.cite_a]:font-bold [&_sup.cite_a]:text-[10px] [&_sup.cite_a]:px-1 [&_sup.cite_a]:rounded [&_sup.cite_a]:bg-accent-50"
                dangerouslySetInnerHTML={{ __html: html }}
            />
            {list.length > 0 && (
                <div className="mt-3 pt-2.5 border-t border-slate-100">
                    <p className="text-[11px] font-bold text-slate-400 mb-1.5">참고 문헌</p>
                    <ol className="space-y-1.5">
                        {list.map((s, i) => (
                            <li key={i} className="flex gap-2 text-[12px] leading-snug">
                                <span className="shrink-0 w-5 text-right font-bold text-accent-600">{i + 1}</span>
                                <div className="min-w-0">
                                    <a href={s.uri} target="_blank" rel="noopener noreferrer" className="text-slate-700 hover:text-accent-700 hover:underline break-words">
                                        {s.title}
                                    </a>
                                    {hostOf(s.uri) && <span className="text-slate-400"> · {hostOf(s.uri)}</span>}
                                    {s.snippet && <p className="text-[11px] text-slate-400 mt-0.5 line-clamp-2">“{s.snippet}”</p>}
                                </div>
                            </li>
                        ))}
                    </ol>
                </div>
            )}
            {uncited.length > 0 && onReinforce && (
                <div className="mt-3 pt-2.5 border-t border-slate-100">
                    <div className="flex items-center gap-2">
                        <span className="text-[11px] font-bold text-warn-700">근거 번호가 없는 내용 {uncited.length}곳</span>
                        <button
                            onClick={onReinforce}
                            disabled={reinforceDisabled}
                            className="ml-auto flex items-center gap-1 px-2.5 py-1 rounded-md border border-slate-200 bg-white text-[11px] font-bold text-slate-600 hover:border-accent-300 hover:text-accent-700 disabled:opacity-40"
                            title="출처가 없는 내용을 하나씩 검색해 근거를 붙여 답변을 다시 씀"
                        >
                            <Search className="w-3.5 h-3.5" /> 근거 찾아 보강
                        </button>
                    </div>
                    <details className="mt-1">
                        <summary className="text-[11px] text-slate-400 cursor-pointer">어떤 내용인지 보기</summary>
                        <ul className="mt-1 space-y-0.5">
                            {uncited.map((u, i) => (
                                <li key={i} className="text-[11px] text-slate-500 line-clamp-2">· {u.replace(/\*\*/g, '')}</li>
                            ))}
                        </ul>
                    </details>
                </div>
            )}
        </div>
    );
});

const MODE_KEY = 'medinote_thread_mode';
const readMode = (): ThreadAnswerMode => { try { return localStorage.getItem(MODE_KEY) === 'fast' ? 'fast' : 'full'; } catch { return 'full'; } };

// 답변 방식: 근거 중심(검색 최대 8회·깊게) / 빠르게(검색 최대 2회·짧게, 비용 적음)
const ModeToggle: React.FC<{ mode: ThreadAnswerMode; onChange: (m: ThreadAnswerMode) => void }> = ({ mode, onChange }) => (
    <div className="flex items-center gap-2">
        <div className="inline-flex p-0.5 bg-slate-100 rounded-lg">
            {([['full', '근거 중심'], ['fast', '빠르게']] as [ThreadAnswerMode, string][]).map(([k, label]) => (
                <button
                    key={k}
                    onClick={() => onChange(k)}
                    className={`px-2.5 py-1 rounded-md text-[11px] font-bold transition-colors ${mode === k ? 'bg-white shadow-sm text-accent-700' : 'text-slate-500 hover:text-slate-700'}`}
                >
                    {label}
                </button>
            ))}
        </div>
        <span className="text-[10px] text-slate-400">{mode === 'fast' ? '검색 최대 2회·짧게 — 비용이 적음' : '근거를 충분히 검색 — 정확도 우선'}</span>
    </div>
);

const ThreadsView: React.FC<Props> = ({ threads, onUpdate, onPatchMeta, onDelete, onBack, openThreadId, onOpened }) => {
    const [activeId, setActiveId] = useState<string | null>(null);
    const [listDraft, setListDraft] = useState('');
    const [draft, setDraft] = useState('');
    const [quote, setQuote] = useState<string | null>(null);
    const [filter, setFilter] = useState('');
    const [streams, setStreams] = useState<Record<string, StreamState>>({});
    const [errors, setErrors] = useState<Record<string, string>>({});
    const [selection, setSelection] = useState('');
    const [mode, setModeState] = useState<ThreadAnswerMode>(readMode);
    const setMode = (m: ThreadAnswerMode) => { setModeState(m); try { localStorage.setItem(MODE_KEY, m); } catch { /* 저장 못 해도 이번엔 적용 */ } };
    const [attachments, setAttachments] = useState<string[]>([]); // 보낼 사진 (base64)
    const [attaching, setAttaching] = useState(false);
    const [activeImages, setActiveImages] = useState<string[]>([]); // 열린 대화의 사진 (목록용 메모에는 사진이 빠져 있어 따로 읽음)
    const [viewImage, setViewImage] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const controllersRef = useRef<Map<string, AbortController>>(new Map());
    // 답변 중인 대화 (state는 화면 갱신 뒤에야 바뀌어서, 두 번 눌러 같은 질문이 두 번 가는 것을 막는 데는 ref를 씀)
    const inFlightRef = useRef<Set<string>>(new Set());
    const submittingRef = useRef(false);
    const scrollRef = useRef<HTMLDivElement>(null);
    const messagesRef = useRef<HTMLDivElement>(null);
    const stickToBottomRef = useRef(true);

    // 퀴즈 등에서 특정 대화 열기
    useEffect(() => {
        if (openThreadId) { setActiveId(openThreadId); onOpened?.(); }
    }, [openThreadId]);

    useEffect(() => { setDraft(''); setQuote(null); setSelection(''); setAttachments([]); stickToBottomRef.current = true; }, [activeId]);

    const sorted = useMemo(
        () => [...threads].sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0)),
        [threads]
    );
    const visible = useMemo(() => {
        const q = filter.trim().toLowerCase();
        if (!q) return sorted;
        return sorted.filter(t => `${t.title} ${t.content}`.toLowerCase().includes(q));
    }, [sorted, filter]);
    const allPending = useMemo(
        () => sorted.flatMap(t => pendingOf(t).map(p => ({ p, thread: t }))).sort((a, b) => b.p.at - a.p.at),
        [sorted]
    );

    const active = threads.find(t => t.id === activeId) || null;
    const messages: ThreadMessage[] = useMemo(() => (active ? parseThread(active.content || '') : []), [active?.content]);
    useEffect(() => {
        if (!active) { setActiveImages([]); return; }
        if (active.images && active.images.length) { setActiveImages(active.images); return; }
        if (!messages.some(m => m.images && m.images.length)) { setActiveImages([]); return; }
        let alive = true;
        getNoteFromDB(active.id).then(n => { if (alive) setActiveImages(n?.images || []); }).catch(() => undefined);
        return () => { alive = false; };
    }, [active?.id, active?.content, active?.images?.length]);
    const stream = activeId ? streams[activeId] : undefined;

    // 새 메시지·스트리밍 중에는 맨 아래를 따라감 (위로 스크롤해서 읽는 중이면 그대로)
    useEffect(() => {
        const el = scrollRef.current;
        if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
    }, [messages.length, stream?.text, activeId]);
    const onScroll = () => {
        const el = scrollRef.current;
        if (el) stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };

    // 답변에서 글자를 고르면 "이 부분 질문하기" 표시 (모바일에서도 동작하도록 selectionchange 사용)
    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        let clearTimer: ReturnType<typeof setTimeout> | null = null;
        const onSel = () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                const sel = window.getSelection();
                const text = sel ? sel.toString().trim() : '';
                const node = sel?.anchorNode ? (sel.anchorNode.nodeType === 1 ? sel.anchorNode as Element : sel.anchorNode.parentElement) : null;
                const inAnswer = !!node && !!messagesRef.current?.contains(node) && !!node.closest('[data-answer]');
                if (clearTimer) { clearTimeout(clearTimer); clearTimer = null; }
                if (text && inAnswer) setSelection(text.slice(0, 600));
                else if (text) setSelection(''); // 답변 밖(입력칸 등)을 고른 경우
                else clearTimer = setTimeout(() => setSelection(''), 400); // 버튼을 누르는 순간 선택이 풀려도 눌리도록 잠깐 유지
            }, 150);
        };
        document.addEventListener('selectionchange', onSel);
        return () => {
            document.removeEventListener('selectionchange', onSel);
            if (timer) clearTimeout(timer);
            if (clearTimer) clearTimeout(clearTimer);
        };
    }, []);

    const newThreadNote = (title: string, now: number): Note => ({
        id: uuidv4(),
        title: threadTitleFrom(title),
        content: '',
        summary: '',
        sources: [],
        createdAt: now,
        updatedAt: now,
        isEnhancing: false,
        kind: 'thread'
    });

    // 질문에 대한 답 받기: history = 이 질문 앞의 대화
    // allImages: 대화 메모의 images 배열 (메시지의 사진 번호를 실제 사진으로 바꿀 때 씀)
    // opts.replaceAt: "근거 보강" — 새 답을 붙이지 않고 그 시각의 답변을 바꿔 씀
    const runAnswer = async (threadId: string, history: ThreadMessage[], question: ThreadMessage, allImages: string[] = [], opts?: { replaceAt?: number; mode?: ThreadAnswerMode; redoKind?: 'reinforce' | 'expand' }) => {
        const answerMode: ThreadAnswerMode = opts?.replaceAt ? 'full' : (opts?.mode || 'full'); // 근거 보강은 항상 근거 중심
        const imgsOf = (m: ThreadMessage) => (m.images || []).map(i => allImages[i]).filter((x): x is string => !!x && !x.startsWith('http'));
        const controller = new AbortController();
        controllersRef.current.set(threadId, controller);
        setErrors(prev => { const n = { ...prev }; delete n[threadId]; return n; });
        setStreams(prev => ({ ...prev, [threadId]: { question: question.text, quote: question.quote, text: '', status: 'thinking', ...(opts?.replaceAt ? { reinforceAt: opts.replaceAt, redoKind: opts.redoKind || 'reinforce' } : {}) } }));
        try {
            const result = await streamThreadAnswer({
                history: history.map(m => ({ role: m.role, text: m.text, quote: m.quote, images: imgsOf(m) })),
                question: { role: 'user', text: question.text, quote: question.quote, images: imgsOf(question) },
                mode: answerMode,
                onText: t => setStreams(prev => prev[threadId] ? { ...prev, [threadId]: { ...prev[threadId], text: t, status: 'writing' } } : prev),
                onStatus: st => setStreams(prev => prev[threadId] ? { ...prev, [threadId]: { ...prev[threadId], status: st } } : prev),
                onSources: list => setStreams(prev => prev[threadId] ? { ...prev, [threadId]: { ...prev[threadId], sources: list } } : prev),
                signal: controller.signal
            });
            // 그 사이 바뀐 내용(제목·적어둔 질문 등)을 덮지 않도록 저장 직전 최신 대화에 답만 붙임.
            // 그 사이 대화가 지워졌으면(이 기기·다른 기기) 저장하지 않음 → 되살아나지 않게
            await onUpdate(threadId, latest => {
                if (!latest) return null;
                const msgs = parseThread(latest.content || '');
                const now = Date.now();
                if (opts?.replaceAt) {
                    const i = msgs.findIndex(m => m.role === 'assistant' && m.at === opts.replaceAt);
                    if (i < 0) return null; // 그 사이 지워졌거나 바뀐 경우
                    msgs[i] = { ...msgs[i], text: result.text, sources: result.sources, fast: undefined };
                } else {
                    msgs.push({ role: 'assistant', at: now, text: result.text, sources: result.sources, ...(answerMode === 'fast' ? { fast: true } : {}) });
                }
                return { ...latest, content: encodeThread(msgs), updatedAt: now };
            });
        } catch (e: any) {
            console.error(e);
            if (opts?.replaceAt) { if (e?.name !== 'AbortError') alert(`${opts.redoKind === 'expand' ? '자세한 답변 받기' : '근거 보강'}에 실패했습니다: ${errText(e)}\n원래 답변은 그대로 있어요.`); }
            else setErrors(prev => ({ ...prev, [threadId]: errText(e) }));
        } finally {
            controllersRef.current.delete(threadId);
            inFlightRef.current.delete(threadId);
            setStreams(prev => { const n = { ...prev }; delete n[threadId]; return n; });
        }
    };

    // 질문 보내기 (threadId 없으면 새 대화). opts.removePendingId: 적어둔 질문을 물어볼 때 같은 저장에서 지움
    const ask = async (threadId: string | null, text: string, q?: string | null, opts?: { removePendingId?: string; images?: string[] }): Promise<string | null> => {
        const newImages = opts?.images || [];
        const question = text.trim() || (newImages.length ? '첨부한 사진을 보고 중요한 소견을 설명해줘' : '');
        if (!question) return null;
        if (threadId && inFlightRef.current.has(threadId)) return null;
        const id = threadId || uuidv4();
        inFlightRef.current.add(id);
        const now = Date.now();
        const qMsg: ThreadMessage = { role: 'user', at: now, text: question, ...(q ? { quote: q } : {}) };
        let history: ThreadMessage[] = [];
        let allImages: string[] = [];
        let tooBig = false;
        try {
            // 질문부터 저장 → 답변 중에 앱을 닫아도 질문은 남음
            const saved = await onUpdate(id, latest => {
                if (!latest && threadId) return null; // 그 사이 지워진 대화
                const base = latest || { ...newThreadNote(question, now), id };
                const baseImages = base.images || [];
                if (newImages.length) {
                    const total = [...baseImages, ...newImages].reduce((n, x) => n + (x || '').length, 0);
                    const textBytes = new TextEncoder().encode(base.content || '').length;
                    if (total > MAX_THREAD_IMAGE_CHARS || total + textBytes > MAX_THREAD_DOC_BYTES) { tooBig = true; return null; }
                    qMsg.images = newImages.map((_, i) => baseImages.length + i);
                }
                allImages = [...baseImages, ...newImages];
                const msgs = parseThread(base.content || '');
                // 답을 못 받은 채 남은 질문이 있으면 이번 질문과 함께 보냄 (기록은 그대로)
                history = [...msgs];
                msgs.push(qMsg);
                const rest = opts?.removePendingId ? pendingOf(base).filter(p => p.id !== opts.removePendingId) : pendingOf(base);
                return {
                    ...base, content: encodeThread(msgs), updatedAt: now, threadPending: rest.length ? rest : undefined,
                    ...(newImages.length ? { images: allImages, isProcessed: true } : {}),
                    // 적어둔 질문 목록이 바뀌면 부가정보 시각도 올려 다른 기기에 이 변경이 이기도록
                    ...(opts?.removePendingId ? { metaUpdatedAt: now } : {})
                };
            });
            if (!saved) {
                inFlightRef.current.delete(id);
                if (tooBig) alert('이 대화에는 사진을 더 넣을 수 없어요 (대화 하나의 저장 한도 1MB). 목록에서 새 질문으로 시작해 첨부해주세요.');
                return null;
            }
        } catch (e) {
            console.error(e);
            inFlightRef.current.delete(id);
            return null;
        }
        runAnswer(id, history, qMsg, allImages, { mode });
        return id;
    };

    const retryLast = async (threadId: string) => {
        if (inFlightRef.current.has(threadId)) return;
        inFlightRef.current.add(threadId);
        const latest = await getNoteFromDB(threadId).catch(() => undefined);
        const msgs = latest ? parseThread(latest.content || '') : [];
        if (!lastQuestionUnanswered(msgs)) { inFlightRef.current.delete(threadId); return; }
        runAnswer(threadId, msgs.slice(0, -1), msgs[msgs.length - 1], latest?.images || [], { mode });
    };

    // 근거 보강: 그 답변의 질문까지를 앞 대화로, "출처 없는 진술을 검색해 근거를 붙여 다시 써줘"를 요청
    const reinforce = async (threadId: string, answerAt: number) => {
        if (inFlightRef.current.has(threadId)) return;
        inFlightRef.current.add(threadId);
        const latest = await getNoteFromDB(threadId).catch(() => undefined);
        const msgs = latest ? parseThread(latest.content || '') : [];
        const i = msgs.findIndex(m => m.role === 'assistant' && m.at === answerAt);
        if (i < 1) { inFlightRef.current.delete(threadId); return; }
        const request: ThreadMessage = { role: 'user', at: Date.now(), text: THREAD_REINFORCE_INSTRUCTION(msgs[i].text) };
        stickToBottomRef.current = true;
        runAnswer(threadId, msgs.slice(0, i), request, latest?.images || [], { replaceAt: answerAt, redoKind: 'reinforce' });
    };

    // 빠른 답변 → 같은 질문을 근거 중심으로 다시 받아 그 자리에서 바꿈 (질문의 인용·사진도 그대로)
    const expandAnswer = async (threadId: string, answerAt: number) => {
        if (inFlightRef.current.has(threadId)) return;
        inFlightRef.current.add(threadId);
        const latest = await getNoteFromDB(threadId).catch(() => undefined);
        const msgs = latest ? parseThread(latest.content || '') : [];
        const i = msgs.findIndex(m => m.role === 'assistant' && m.at === answerAt);
        if (i < 1 || msgs[i - 1].role !== 'user') { inFlightRef.current.delete(threadId); return; }
        stickToBottomRef.current = true;
        runAnswer(threadId, msgs.slice(0, i - 1), msgs[i - 1], latest?.images || [], { replaceAt: answerAt, redoKind: 'expand' });
    };

    // 나중에 물어볼 질문으로 적어두기 (threadId 없으면 질문만 있는 새 대화)
    const addPending = async (threadId: string | null, text: string): Promise<boolean> => {
        const t = text.trim();
        if (!t) return false;
        const item: ThreadPending = { id: uuidv4(), text: t, at: Date.now() };
        try {
            if (!threadId) {
                const note = { ...newThreadNote(t, item.at), threadPending: [item] };
                return !!(await onUpdate(note.id, () => note));
            }
            return !!(await onPatchMeta(threadId, latest => ({ threadPending: [...pendingOf(latest), item] })));
        } catch (e) {
            console.error(e);
            return false;
        }
    };

    const removePending = (threadId: string, pid: string) =>
        onPatchMeta(threadId, latest => {
            const rest = pendingOf(latest).filter(p => p.id !== pid);
            return { threadPending: rest.length ? rest : undefined };
        });

    // 적어둔 질문 물어보기: 질문 저장과 같은 저장에서 목록에서 지움 (실패하면 그대로 남음)
    const askPending = async (thread: Note, p: ThreadPending) => {
        if (inFlightRef.current.has(thread.id)) return;
        setActiveId(thread.id);
        const id = await ask(thread.id, p.text, null, { removePendingId: p.id });
        if (!id) alert('질문을 보내지 못했습니다. 적어둔 질문은 그대로 남아 있어요.');
    };

    const handleDelete = async (t: Note) => {
        if (!window.confirm(`"${t.title}" 대화를 지울까요? 이 대화로 나온 퀴즈 오답도 함께 사라집니다.`)) return;
        controllersRef.current.get(t.id)?.abort();
        await onDelete(t.id);
        if (activeId === t.id) setActiveId(null);
    };

    const handleRename = async (t: Note) => {
        const name = window.prompt('대화 제목', t.title);
        if (name === null || !name.trim() || name.trim() === t.title) return;
        await onUpdate(t.id, latest => latest ? { ...latest, title: name.trim().slice(0, 80), updatedAt: Date.now() } : null);
    };

    const toggleQuiz = (t: Note) => onPatchMeta(t.id, latest => ({ quizExcluded: latest.quizExcluded ? undefined : true }));

    // 사진 붙이기 (파일 선택·붙여넣기)
    const addFiles = async (files: FileList | File[] | null) => {
        const list = Array.from(files || []).filter(f => f.type.startsWith('image/'));
        if (!list.length) return;
        const room = MAX_PHOTOS_PER_QUESTION - attachments.length;
        if (room <= 0) { alert(`질문 하나에 사진은 ${MAX_PHOTOS_PER_QUESTION}장까지 붙일 수 있어요.`); return; }
        if (list.length > room) alert(`질문 하나에 사진은 ${MAX_PHOTOS_PER_QUESTION}장까지라 ${room}장만 붙였어요.`);
        setAttaching(true);
        try {
            const out: string[] = [];
            for (const f of list.slice(0, room)) out.push(await resizeAndCompressImage(f));
            setAttachments(prev => [...prev, ...out].slice(0, MAX_PHOTOS_PER_QUESTION));
        } catch (e) {
            console.error(e);
            alert('사진을 불러오지 못했습니다. 다른 사진으로 시도해주세요.');
        } finally {
            setAttaching(false);
        }
    };
    const onPasteImages = (e: React.ClipboardEvent) => {
        const files = Array.from(e.clipboardData?.files || []).filter(f => f.type.startsWith('image/'));
        if (!files.length) return;
        if (!(e.clipboardData.getData('text/plain') || '').trim()) e.preventDefault(); // 사진만 붙여넣은 경우 글자가 들어가지 않게
        addFiles(files);
    };

    const attachBar = attachments.length > 0 || attaching ? (
        <div className="flex gap-2 overflow-x-auto pb-0.5">
            {attachments.map((img, i) => (
                <div key={i} className="relative shrink-0">
                    <img src={imageSrc(img)} alt="" className="w-16 h-16 object-cover rounded-lg border border-slate-200" />
                    <button
                        onClick={() => setAttachments(prev => prev.filter((_, j) => j !== i))}
                        className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-white border border-slate-300 text-slate-500 flex items-center justify-center"
                        title="빼기"
                    >
                        <X className="w-3 h-3" />
                    </button>
                </div>
            ))}
            {attaching && <div className="w-16 h-16 shrink-0 rounded-lg border border-dashed border-slate-300 flex items-center justify-center"><Loader2 className="w-4 h-4 animate-spin text-slate-400" /></div>}
        </div>
    ) : null;

    const fileInput = (
        <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={e => { addFiles(e.target.files); e.target.value = ''; }}
        />
    );

    const attachButton = (
        <button
            onClick={() => fileInputRef.current?.click()}
            disabled={attaching || attachments.length >= MAX_PHOTOS_PER_QUESTION}
            className="shrink-0 w-8 h-8 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 flex items-center justify-center disabled:opacity-30"
            title={`사진 붙이기 (최대 ${MAX_PHOTOS_PER_QUESTION}장, 붙여넣기도 됨)`}
        >
            <ImageIcon className="w-4 h-4" />
        </button>
    );

    // 목록에서 새 질문 (두 번 눌러도 대화가 두 개 생기지 않게)
    const submitNew = async () => {
        const t = listDraft;
        const imgs = attachments;
        if (submittingRef.current || (!t.trim() && !imgs.length) || attaching) return;
        submittingRef.current = true;
        setListDraft('');
        setAttachments([]);
        const id = await ask(null, t, null, { images: imgs });
        submittingRef.current = false;
        if (id) setActiveId(id);
        else { setListDraft(t); setAttachments(imgs); alert('질문을 보내지 못했습니다. 다시 시도해주세요.'); }
    };

    // ------------------------------------------------------------------ 목록
    if (!active) {
        return (
            <div className="h-full flex flex-col bg-white">
                <div className="h-12 px-3 border-b border-slate-100 flex items-center gap-2 flex-none">
                    <button onClick={onBack} className="p-2 text-slate-500 hover:text-slate-800"><ArrowLeft className="w-5 h-5" /></button>
                    <MessageSquareText className="w-4 h-4 text-slate-400" />
                    <h2 className="font-bold text-slate-800">질문 노트</h2>
                    <span className="text-[11px] text-slate-400 ml-1">묻고 이어 묻기 · 퀴즈에도 출제</span>
                </div>
                <div className="flex-1 overflow-y-auto bg-slate-50/30">
                    <div className="max-w-3xl mx-auto p-4 md:p-6 pb-24 space-y-6">
                        {/* 새 질문 */}
                        <div className="bg-white border border-accent-100 rounded-2xl p-3 shadow-sm">
                            <AutoTextarea
                                value={listDraft}
                                onChange={e => setListDraft(e.target.value)}
                                onKeyDown={e => {
                                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
                                        e.preventDefault();
                                        submitNew();
                                    }
                                }}
                                onPaste={onPasteImages}
                                minRows={2} maxRows={10}
                                placeholder="궁금한 것을 물어보세요 (예: AVNRT와 AVRT를 12유도에서 감별하는 포인트는?) — 사진도 붙일 수 있어요"
                                className="w-full resize-none bg-transparent text-sm text-slate-700 placeholder:text-slate-400 outline-none"
                            />
                            {attachBar && <div className="mt-2">{attachBar}</div>}
                            {fileInput}
                            <div className="mt-2"><ModeToggle mode={mode} onChange={setMode} /></div>
                            <div className="flex items-center justify-end gap-2 mt-1">
                                <span className="mr-auto">{attachButton}</span>
                                <button
                                    onClick={async () => {
                                        const t = listDraft;
                                        if (submittingRef.current || !t.trim()) return;
                                        submittingRef.current = true;
                                        setListDraft('');
                                        const ok = await addPending(null, t);
                                        submittingRef.current = false;
                                        if (!ok) { setListDraft(t); alert('적어두지 못했습니다. 다시 시도해주세요.'); }
                                    }}
                                    disabled={!listDraft.trim()}
                                    className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-bold text-slate-500 hover:bg-slate-100 disabled:opacity-40"
                                    title="지금 묻지 않고 적어두기"
                                >
                                    <Clock className="w-3.5 h-3.5" /> 나중에 물어보기
                                </button>
                                <button
                                    onClick={submitNew}
                                    disabled={(!listDraft.trim() && !attachments.length) || attaching}
                                    className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-accent-600 hover:bg-accent-700 text-white text-xs font-bold disabled:opacity-40"
                                >
                                    <ArrowUp className="w-3.5 h-3.5" /> 질문하기
                                </button>
                            </div>
                        </div>

                        {/* 적어둔 질문 */}
                        {allPending.length > 0 && (
                            <div>
                                <p className="text-xs font-bold text-slate-400 mb-2 flex items-center gap-1.5"><Clock className="w-3.5 h-3.5" /> 적어둔 질문 {allPending.length}</p>
                                <ul className="space-y-1.5">
                                    {allPending.map(({ p, thread }) => (
                                        <li key={p.id} className="flex items-start gap-2 bg-slate-50/60 border border-slate-100 rounded-xl px-3 py-2">
                                            <div className="min-w-0 flex-1">
                                                <p className="text-sm text-slate-700 whitespace-pre-wrap break-words">{p.text}</p>
                                                {countQuestions(thread.content) > 0 && (
                                                    <p className="text-[11px] text-slate-600 mt-0.5 truncate">대화: {thread.title}</p>
                                                )}
                                            </div>
                                            <button
                                                onClick={() => askPending(thread, p)}
                                                disabled={!!streams[thread.id]}
                                                className="shrink-0 px-2.5 py-1 rounded-md bg-accent-600 hover:bg-accent-700 text-white text-[11px] font-bold disabled:opacity-40"
                                            >
                                                물어보기
                                            </button>
                                            <button
                                                onClick={async () => {
                                                    await removePending(thread.id, p.id);
                                                    // 질문만 적어둔 빈 대화였다면 대화도 정리
                                                    if (countQuestions(thread.content) === 0 && pendingOf(thread).length <= 1) await onDelete(thread.id);
                                                }}
                                                className="shrink-0 p-1 text-slate-400 hover:text-red-500" title="지우기"
                                            >
                                                <X className="w-4 h-4" />
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}

                        {/* 대화 목록 */}
                        <div>
                            <div className="flex items-center gap-2 mb-2">
                                <p className="text-xs font-bold text-slate-400 flex items-center gap-1.5"><MessageSquareText className="w-3.5 h-3.5" /> 대화 {threads.filter(t => countQuestions(t.content) > 0).length}</p>
                                <div className="ml-auto flex items-center gap-1 bg-white border border-slate-200 rounded-lg px-2 py-1">
                                    <Search className="w-3.5 h-3.5 text-slate-400" />
                                    <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="대화 검색" className="text-xs outline-none w-28 bg-transparent" />
                                </div>
                            </div>
                            {visible.filter(t => countQuestions(t.content) > 0 || streams[t.id]).length === 0 ? (
                                <p className="text-sm text-slate-400 py-6 text-center">{filter ? '찾는 대화가 없어요.' : '아직 대화가 없어요. 위에서 첫 질문을 해보세요.'}</p>
                            ) : (
                                <ul className="space-y-1.5">
                                    {visible.filter(t => countQuestions(t.content) > 0 || streams[t.id]).map(t => {
                                        const n = countQuestions(t.content);
                                        const pend = pendingOf(t).length;
                                        return (
                                            <li key={t.id}>
                                                <button
                                                    onClick={() => setActiveId(t.id)}
                                                    className="w-full text-left bg-white border border-slate-200 rounded-xl px-3.5 py-3 hover:border-accent-300 hover:shadow-sm transition-all flex items-center gap-3"
                                                >
                                                    <div className="min-w-0 flex-1">
                                                        <p className="text-sm font-bold text-slate-800 truncate">{t.title || '(제목 없음)'}</p>
                                                        <p className="text-[11px] text-slate-400 mt-0.5 flex flex-wrap items-center gap-x-2">
                                                            <span>{fmtTime(t.updatedAt || t.createdAt)}</span>
                                                            <span>질문 {n}</span>
                                                            {pend > 0 && <span className="text-slate-600">적어둔 질문 {pend}</span>}
                                                            {t.quizExcluded && <span>퀴즈 제외</span>}
                                                            {streams[t.id] && <span className="text-accent-600 flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> 답변 중</span>}
                                                            {errors[t.id] && !streams[t.id] && <span className="text-red-500">답변 실패</span>}
                                                        </p>
                                                    </div>
                                                    <ChevronRight className="w-4 h-4 text-slate-300 shrink-0" />
                                                </button>
                                            </li>
                                        );
                                    })}
                                </ul>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    // ------------------------------------------------------------------ 대화
    const pending = pendingOf(active);
    const unanswered = lastQuestionUnanswered(messages) && !stream;
    const tooLong = (active.content || '').length > THREAD_SOFT_LIMIT_CHARS;
    const busy = !!stream;

    const send = async () => {
        const text = draft;
        const q = quote;
        const imgs = attachments;
        if ((!text.trim() && !imgs.length) || busy || attaching) return;
        setDraft(''); setQuote(null); setSelection(''); setAttachments([]);
        stickToBottomRef.current = true;
        const id = await ask(active.id, text, q, { images: imgs });
        if (!id) { setDraft(text); setQuote(q); setAttachments(imgs); }
    };

    return (
        <div className="h-full flex flex-col bg-white">
            <div className="h-12 px-2 border-b border-slate-100 flex items-center gap-1 flex-none">
                <button onClick={() => setActiveId(null)} className="p-2 text-slate-500 hover:text-slate-800" title="목록"><ArrowLeft className="w-5 h-5" /></button>
                <button onClick={() => handleRename(active)} className="min-w-0 flex-1 text-left flex items-center gap-1.5 group" title="제목 바꾸기">
                    <span className="font-bold text-slate-800 truncate">{active.title}</span>
                    <Edit className="w-3.5 h-3.5 text-slate-300 group-hover:text-slate-500 shrink-0" />
                </button>
                <button
                    onClick={() => toggleQuiz(active)}
                    className={`flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-bold whitespace-nowrap ${active.quizExcluded ? 'text-slate-400 bg-slate-100' : 'text-accent-600 bg-accent-50'}`}
                    title={active.quizExcluded ? '퀴즈에 다시 포함' : '이 대화는 퀴즈에서 빼기'}
                >
                    <BrainCircuit className="w-3.5 h-3.5" /> {active.quizExcluded ? '퀴즈 제외됨' : '퀴즈 포함'}
                </button>
                <button onClick={() => handleDelete(active)} className="p-2 text-slate-400 hover:text-red-500" title="대화 삭제"><Trash2 className="w-4 h-4" /></button>
            </div>

            <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto bg-slate-50/30">
                <div ref={messagesRef} className="max-w-3xl mx-auto p-4 md:p-6 pb-6 space-y-5">
                    {messages.length === 0 && !stream && (
                        <p className="text-sm text-slate-400 text-center py-8">아래에서 질문을 시작하세요.{pending.length > 0 ? ' 적어둔 질문도 있어요.' : ''}</p>
                    )}
                    {messages.map((m, i) => m.role === 'user' ? (
                        <div key={i} className="flex justify-end">
                            <div className="max-w-[85%] bg-accent-100 text-slate-800 rounded-2xl rounded-br-md px-4 py-2.5">
                                {m.quote && (
                                    <div className="text-[12px] text-slate-500 border-l-2 border-accent-300 pl-2 mb-1.5 line-clamp-3 whitespace-pre-wrap">{m.quote}</div>
                                )}
                                {m.images && m.images.length > 0 && (
                                    <div className="flex flex-wrap gap-1.5 mb-1.5">
                                        {m.images.map(idx => activeImages[idx] ? (
                                            <button key={idx} onClick={() => setViewImage(activeImages[idx])} className="block">
                                                <img src={imageSrc(activeImages[idx])} alt="" className="w-24 h-24 object-cover rounded-lg border border-white/60" />
                                            </button>
                                        ) : (
                                            <div key={idx} className="w-24 h-24 rounded-lg bg-white/60 flex items-center justify-center"><Loader2 className="w-4 h-4 animate-spin text-slate-400" /></div>
                                        ))}
                                    </div>
                                )}
                                <p className="text-sm whitespace-pre-wrap break-words">{m.text}</p>
                                <p className="text-[10px] text-slate-400 mt-1 text-right">{fmtTime(m.at)}</p>
                            </div>
                        </div>
                    ) : (
                        <div key={i} className="bg-white border border-slate-200 rounded-2xl rounded-bl-md px-4 py-3 shadow-sm">
                            <AnswerBlock
                                text={m.text}
                                sources={m.sources}
                                fast={m.fast}
                                onReinforce={stream?.reinforceAt === m.at ? undefined : () => reinforce(active.id, m.at)}
                                onExpand={stream?.reinforceAt === m.at ? undefined : () => expandAnswer(active.id, m.at)}
                                reinforceDisabled={busy}
                            />
                            {stream?.reinforceAt === m.at && (
                                <p className="mt-2 text-[11px] font-bold text-accent-600 flex items-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" />
                                    {stream.redoKind === 'expand' ? '근거 중심으로 자세히 다시 쓰는 중…' : '이 답변의 근거를 찾아 다시 쓰는 중…'} 아래에 진행 상황이 보여요
                                </p>
                            )}
                        </div>
                    ))}

                    {stream && (
                        <div className="bg-white border border-accent-100 rounded-2xl rounded-bl-md px-4 py-3 shadow-sm">
                            <p className="text-[11px] font-bold text-accent-500 flex items-center gap-1.5 mb-2">
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                {stream.reinforceAt ? (stream.redoKind === 'expand' ? '자세히 — ' : '근거 보강 — ') : ''}{stream.status === 'searching' ? '근거 찾는 중…' : stream.status === 'writing' ? '답변 쓰는 중…' : '생각하는 중…'}
                                <button onClick={() => controllersRef.current.get(active.id)?.abort()} className="ml-auto text-slate-400 hover:text-red-500 font-bold">멈추기</button>
                            </p>
                            {stream.text && <AnswerBlock text={stream.text} sources={stream.sources} />}
                        </div>
                    )}

                    {unanswered && (
                        <div className="flex items-center gap-2 text-xs bg-red-50 border border-red-100 text-red-600 rounded-xl px-3 py-2">
                            <span className="flex-1">{errors[active.id] || '마지막 질문에 아직 답이 없어요.'}</span>
                            <button onClick={() => retryLast(active.id)} className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-white border border-red-200 font-bold hover:bg-red-50">
                                <RotateCw className="w-3.5 h-3.5" /> 다시 답변 받기
                            </button>
                        </div>
                    )}
                    {tooLong && (
                        <p className="text-[11px] text-slate-600 text-center">대화가 많이 길어졌어요. 새 주제는 목록에서 새 질문으로 시작하면 더 빠르고 저렴해요.</p>
                    )}
                </div>
            </div>

            {viewImage && (
                <div className="fixed inset-0 z-[100] bg-black/90 flex items-center justify-center p-4" onClick={() => setViewImage(null)}>
                    <img src={imageSrc(viewImage)} alt="" className="max-w-full max-h-full object-contain rounded" />
                    <button onClick={() => setViewImage(null)} className="absolute right-4 p-2 bg-white/10 text-white rounded-full" style={{ top: 'calc(env(safe-area-inset-top, 0px) + 1rem)' }} title="닫기">
                        <X className="w-6 h-6" />
                    </button>
                </div>
            )}

            {/* 입력 */}
            <div className="flex-none border-t border-slate-100 bg-white px-3 pt-2 pb-3" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 0.75rem)' }}>
                <div className="max-w-3xl mx-auto space-y-2">
                    {selection && !quote && (
                        <button
                            onPointerDown={e => { e.preventDefault(); setQuote(selection); setSelection(''); window.getSelection()?.removeAllRanges(); }}
                            className="w-full flex items-center gap-2 text-left text-xs bg-accent-50 border border-accent-200 text-accent-700 rounded-lg px-3 py-2"
                        >
                            <MessageSquareText className="w-4 h-4 shrink-0" />
                            <span className="truncate flex-1">“{selection}”</span>
                            <span className="font-bold shrink-0">이 부분 질문하기</span>
                        </button>
                    )}
                    {pending.length > 0 && (
                        <div className="flex gap-1.5 overflow-x-auto pb-0.5">
                            {pending.map(p => (
                                <span key={p.id} className="shrink-0 flex items-center gap-1 max-w-[260px] bg-slate-50 border border-slate-200 rounded-full pl-2.5 pr-1 py-1 text-[11px] text-slate-800">
                                    <button onClick={() => askPending(active, p)} disabled={busy} className="truncate disabled:opacity-50" title="지금 물어보기">
                                        <Clock className="w-3 h-3 inline mr-1" />{p.text}
                                    </button>
                                    <button onClick={() => removePending(active.id, p.id)} className="p-0.5 text-slate-400 hover:text-red-500" title="지우기"><X className="w-3 h-3" /></button>
                                </span>
                            ))}
                        </div>
                    )}
                    <ModeToggle mode={mode} onChange={setMode} />
                    {attachBar}
                    {fileInput}
                    {quote && (
                        <div className="flex items-start gap-2 text-xs bg-slate-50 border-l-2 border-accent-400 rounded px-2.5 py-1.5 text-slate-600">
                            <span className="flex-1 line-clamp-2 whitespace-pre-wrap">{quote}</span>
                            <button onClick={() => setQuote(null)} className="text-slate-400 hover:text-slate-600"><X className="w-3.5 h-3.5" /></button>
                        </div>
                    )}
                    <div className="flex items-end gap-2 bg-slate-50 border border-slate-200 rounded-2xl px-3 py-2 focus-within:border-accent-300">
                        <AutoTextarea
                            value={draft}
                            onChange={e => setDraft(e.target.value)}
                            onKeyDown={e => {
                                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
                            }}
                            onPaste={onPasteImages}
                            minRows={1} maxRows={8}
                            placeholder={quote ? '고른 부분에 대해 물어보세요' : '이어서 질문하기'}
                            className="flex-1 resize-none bg-transparent text-sm text-slate-700 placeholder:text-slate-400 outline-none py-1"
                        />
                        {attachButton}
                        <button
                            onClick={async () => {
                                const t = draft;
                                setDraft('');
                                if (!(await addPending(active.id, t))) { setDraft(t); alert('적어두지 못했습니다. 다시 시도해주세요.'); }
                            }}
                            disabled={!draft.trim()}
                            className="shrink-0 w-8 h-8 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-50 flex items-center justify-center disabled:opacity-30"
                            title="나중에 물어보기 (적어두기)"
                        >
                            <Clock className="w-4 h-4" />
                        </button>
                        <button
                            onClick={send}
                            disabled={(!draft.trim() && !attachments.length) || busy || attaching}
                            className="shrink-0 w-8 h-8 rounded-lg bg-accent-600 hover:bg-accent-700 text-white flex items-center justify-center disabled:opacity-40"
                            title="질문하기 (Ctrl/⌘+Enter)"
                        >
                            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowUp className="w-4 h-4" />}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default ThreadsView;
