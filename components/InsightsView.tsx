import React, { useEffect, useMemo, useRef, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { ArrowLeft, Layers, Loader2, AlertTriangle, CalendarDays, Search, FileText, ClipboardList, EyeOff, Sparkles, Lightbulb, Users, Check, ChevronDown, ChevronUp, ClipboardCheck, Copy, RotateCw } from 'lucide-react';
import { Note, Source, HandoverMeta } from '../types';
import { sectionizeHtml } from '../services/sectionize';
import NoteResultCard, { renderLinkedMarkdown } from './NoteResultCard';
import {
    generateWeeklyDigest, findCoverageGaps, buildDocumentationTemplate, extractCaseLogBatch, synthesizeNotes,
    notesWithinContextBudget, CONTEXT_BUDGETS, summarizeSingleNote, updateHandoverDocument
} from '../services/claudeService';
import { getNoteFromDB } from '../services/storage';
import { buildPatientIndex, duplicatePatientGroups } from '../services/patientId';
import { contentForAnalysis } from '../services/insightUtils';
import { summaryFieldsFor } from '../services/summaryHistory';
import { hasVoyageApiKey } from '../services/voyageService';
import { findRelatedNotes, hydrateNotes } from '../services/noteSearch';
import {
    findSimilarNoteGroups, NoteGroup, notesInLastDays, buildCaseLogMarkdown, CaseExtract, DAY_MS,
    followUpStatus, FollowUpStatus, analysisTextOf, extractSection, FOLLOWUP_INTERVALS, DEFAULT_FOLLOWUP_DAYS
} from '../services/insightUtils';
import { collectWrongAnswers } from '../services/studyUtils';
import { estimateDataRecordCount } from '../services/pasteUtils';

// ============================================================================
// 메모 활용: 쌓인 메모를 다시 쓰는 도구들
//  이번 주 돌아보기 / 환자 팔로업 / 비슷한 메모 묶기 / 빈 곳 찾기 / 작성 템플릿 / 케이스·시술 기록
// - 모든 AI 호출은 버튼을 눌렀을 때만 실행. 결과는 원할 때만 "새 메모로 저장".
// - 탭을 바꾸거나 메모를 열었다 돌아와도 결과가 남아 있도록 탭을 숨기기만 함.
// ============================================================================

interface Props {
    notes: Note[]; // (AI 결과를 저장한 메모는 InsightsView에서 미리 걸러서 넘김)
    threads?: Note[]; // 질문 노트 대화 — 이번 주·비슷한 메모 묶기·빈 곳 찾기에만 함께 씀
    reviewDueCount: number;
    isFetchingAll?: boolean;
    onBack: () => void;
    onSelectNote: (id: string) => void;
    onSaveNewNote: (note: Note) => Promise<void>;
    onUpdateNote: (note: Note) => void | Promise<unknown>; // 케이스 분석 갱신·인계장 저장용
    handoverDoc?: Note; // 저장돼 있는 인계장 (메모 활용 > 인계장 정리)
    onMergePatient?: (ids: string[]) => Promise<void>; // 같은 환자 번호 메모 합치기
    onFollowUpCheck: (id: string, intervalDays: number) => void; // "확인함"
    nowTick: number; // 몇 분마다 갱신되는 현재 시각 (자정이 지나면 "확인할 차례"가 바뀌도록)
}

type Tab = 'weekly' | 'handover' | 'patients' | 'similar' | 'gap' | 'template' | 'cases';

const TABS: { key: Tab; label: string; icon: React.ReactNode }[] = [
    { key: 'weekly', label: '이번 주', icon: <CalendarDays className="w-3.5 h-3.5" /> },
    { key: 'handover', label: '인계장 정리', icon: <ClipboardCheck className="w-3.5 h-3.5" /> },
    { key: 'patients', label: '환자 팔로업', icon: <Users className="w-3.5 h-3.5" /> },
    { key: 'similar', label: '비슷한 메모 묶기', icon: <Layers className="w-3.5 h-3.5" /> },
    { key: 'gap', label: '빈 곳 찾기', icon: <Search className="w-3.5 h-3.5" /> },
    { key: 'template', label: '작성 템플릿', icon: <FileText className="w-3.5 h-3.5" /> },
    { key: 'cases', label: '케이스·시술 기록', icon: <ClipboardList className="w-3.5 h-3.5" /> },
];

const safeGet = (key: string): string | null => { try { return localStorage.getItem(key); } catch { return null; } };
const safeSet = (key: string, val: string) => { try { localStorage.setItem(key, val); } catch { /* 저장 불가해도 무시 */ } };

const ErrorBox: React.FC<{ message: string }> = ({ message }) => (
    <div className="flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-xl">
        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
        <span className="flex-1">{message}</span>
    </div>
);

const Intro: React.FC<{ children: React.ReactNode; cost?: string }> = ({ children, cost }) => (
    <div className="bg-white border border-slate-200 rounded-xl p-4 text-sm text-slate-600 leading-relaxed">
        {children}
        {cost && <span className="block text-xs text-slate-400 mt-1">{cost}</span>}
    </div>
);

const primaryBtn = 'flex items-center gap-1.5 px-4 py-2 rounded-lg bg-accent-600 hover:bg-accent-700 text-white text-sm font-bold whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed transition-colors';
const inputCls = 'w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm text-slate-800 outline-none focus:border-accent-300 focus:ring-2 focus:ring-accent-50 placeholder:text-slate-300';

const NoteLink = ({ note, onSelect, extra }: { key?: string; note: Note; onSelect: (id: string) => void; extra?: React.ReactNode }) => (
    <button onClick={() => onSelect(note.id)} className="w-full flex items-center gap-2 text-left text-sm text-slate-700 hover:text-accent-600 py-0.5">
        {note.kind === 'thread' && <span className="shrink-0 text-[10px] font-bold text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded">질문 노트</span>}
        <span className="truncate flex-1 min-w-0">{note.title || '(제목 없음)'}</span>
        {extra}
    </button>
);

// ---------------------------------------------------------------------------
// 1) 이번 주 돌아보기
// ---------------------------------------------------------------------------
const WEEKLY_KEY = 'medinote_weekly_digest';
const WEEK_DAYS = 7;

const WeeklyTab: React.FC<Props> = ({ notes, reviewDueCount, onSelectNote, onSaveNewNote }) => {
    const now = Date.now();
    const weekNotes = useMemo(
        () => notesInLastDays(notes, WEEK_DAYS, Date.now()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
        [notes]
    );
    const newCount = weekNotes.filter(n => n.kind !== 'thread' && (n.createdAt || 0) >= now - WEEK_DAYS * DAY_MS).length;
    const weekThreadCount = weekNotes.filter(n => n.kind === 'thread').length;
    const weekWrong = useMemo(
        () => collectWrongAnswers(notes).filter(w => (w.wrongAt || 0) >= Date.now() - WEEK_DAYS * DAY_MS),
        [notes]
    );

    const [digest, setDigest] = useState<{ markdown: string; refIds: string[]; createdAt: number } | null>(() => {
        const raw = safeGet(WEEKLY_KEY);
        if (!raw) return null;
        try {
            const d = JSON.parse(raw);
            return d && typeof d.markdown === 'string' && Array.isArray(d.refIds) ? d : null;
        } catch { return null; }
    });
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [showAll, setShowAll] = useState(false);

    const refNotes = useMemo(() => {
        if (!digest) return [];
        const byId = new Map(notes.map(n => [n.id, n]));
        return digest.refIds.map(id => byId.get(id) || ({ id, title: '(삭제된 메모)' } as Note));
    }, [digest, notes]);

    const handleGenerate = async () => {
        if (busy || weekNotes.length === 0) return;
        setBusy(true);
        setError(null);
        try {
            const hydrated = await hydrateNotes(weekNotes.slice(0, 30));
            const target = notesWithinContextBudget(hydrated, CONTEXT_BUDGETS.weekly[0], CONTEXT_BUDGETS.weekly[1]);
            const markdown = await generateWeeklyDigest(target, {
                days: WEEK_DAYS,
                dueCount: reviewDueCount,
                wrongQuestions: weekWrong.map(w => ({ question: w.question, explanation: w.explanation }))
            });
            const d = { markdown, refIds: target.map(n => n.id), createdAt: Date.now() };
            setDigest(d);
            safeSet(WEEKLY_KEY, JSON.stringify(d));
        } catch (e: any) {
            setError(e?.message || '돌아보기를 만들지 못했습니다.');
        } finally {
            setBusy(false);
        }
    };

    const stat = (label: string, value: number, tone = 'text-slate-800') => (
        <div className="bg-white border border-slate-200 rounded-xl px-3 py-2.5">
            <div className="text-[11px] text-slate-400 font-bold">{label}</div>
            <div className={`text-xl font-bold ${tone}`}>{value}</div>
        </div>
    );

    return (
        <div className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {stat('새 메모', newCount)}
                {stat('질문 노트 대화', weekThreadCount)}
                {stat('오늘 복습', reviewDueCount, reviewDueCount > 0 ? 'text-warn-600' : 'text-slate-800')}
                {stat('이번 주 틀린 문제', weekWrong.length, weekWrong.length > 0 ? 'text-clay-500' : 'text-slate-800')}
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-4">
                <div className="flex items-center justify-between gap-2 mb-2">
                    <span className="text-xs font-bold text-slate-500">최근 {WEEK_DAYS}일 동안 쓰거나 고친 메모 · 질문 노트</span>
                    {weekNotes.length > 8 && (
                        <button onClick={() => setShowAll(v => !v)} className="text-xs font-bold text-slate-400 hover:text-slate-600">
                            {showAll ? '접기' : `모두 보기 (${weekNotes.length})`}
                        </button>
                    )}
                </div>
                {weekNotes.length === 0 ? (
                    <p className="text-sm text-slate-400">이번 주에 쓴 메모나 질문이 없어요.</p>
                ) : (
                    <div className="divide-y divide-slate-50">
                        {(showAll ? weekNotes : weekNotes.slice(0, 8)).map(n => (
                            <NoteLink key={n.id} note={n} onSelect={onSelectNote}
                                extra={<span className="text-[11px] text-slate-400 shrink-0">{new Date(n.updatedAt || n.createdAt).toLocaleDateString()}</span>} />
                        ))}
                    </div>
                )}
            </div>

            <div className="flex flex-wrap items-center gap-3">
                <button onClick={handleGenerate} disabled={busy || weekNotes.length === 0} className={primaryBtn}>
                    {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                    {digest ? 'AI 돌아보기 새로 만들기' : 'AI로 이번 주 돌아보기'}
                </button>
                <span className="text-xs text-slate-400">핵심 정리·메모 간 연결·다시 볼 것·다음 주 제안 (빠른 모델, 1회 수십 원)</span>
            </div>

            {error && !busy && <ErrorBox message={error} />}
            {digest && !busy && (
                <NoteResultCard
                    label={`이번 주 돌아보기 · ${new Date(digest.createdAt).toLocaleDateString()} 생성`}
                    markdown={digest.markdown}
                    refNotes={refNotes}
                    saveTitle={`주간 돌아보기 (${new Date(digest.createdAt).toLocaleDateString()})`}
                    onSelectNote={onSelectNote}
                    onSaveNewNote={onSaveNewNote}
                />
            )}
        </div>
    );
};

// ---------------------------------------------------------------------------
// 인계장 정리: '업무' 메모를 모아 분류별 제목·소제목이 있는 하나의 인계장으로
// ---------------------------------------------------------------------------
type HandoverStatus = 'done' | 'new' | 'changed' | 'truncated';
const handoverVersion = (n: Note) => n.updatedAt || n.createdAt || 0;
const HANDOVER_MAX_BATCHES = 20;
const HANDOVER_META_VERSION = 2;
// 한 번에 보낼 메모 분량. 새로 들어갈 내용이 곧 AI가 써야 할 분량이라 작게 나눠 여러 번 반영
// (한국어는 글자당 토큰이 많음). 한도에 걸리면 자동으로 절반씩 줄여 다시 시도.
const HANDOVER_BATCH_CHARS = 24000;
const HANDOVER_MIN_BATCH_CHARS = 6000;
const HANDOVER_CHUNK_CHARS = 12000;  // 이보다 긴 메모는 여러 조각으로 나눔 (자르지 않음)
const LEGACY_CLIP_CHARS = 4500;      // 이전 버전은 메모당 약 5천 자까지만 보냈음 → 이보다 긴 메모는 다시 반영

// 인계장에 보낼 메모 본문: 요약 칸은 빼고, "메모 내용으로 저장"한 요약도 빼고 원래 기록 + 사진 글자
const handoverTextOf = (n: Note) =>
    [contentForAnalysis(n.content || ''), n.transcription ? `(사진에서 추출한 텍스트)\n${n.transcription}` : '']
        .filter(Boolean).join('\n\n');
// 이전 버전이 보낸 분량 계산과 같은 방식 (잘렸는지 판단용)
const legacyLength = (n: Note) =>
    [n.content || '', n.transcription ? `(사진에서 추출한 텍스트: ${n.transcription})` : '', n.summary ? `(이전에 만든 AI 요약: ${n.summary})` : '']
        .filter(Boolean).join('\n').length;

// 긴 글을 줄 단위로 max 글자 이하 조각들로 (줄 하나가 너무 길면 그 줄만 잘라서)
export const splitForHandover = (text: string, max: number): string[] => {
    if (text.length <= max) return [text];
    const parts: string[] = [];
    let cur = '';
    for (const line of text.split('\n')) {
        const pieces = line.length > max ? line.match(new RegExp(`[\\s\\S]{1,${max}}`, 'g')) || [line] : [line];
        for (const piece of pieces) {
            if (cur && cur.length + 1 + piece.length > max) { parts.push(cur); cur = ''; }
            cur = cur ? `${cur}\n${piece}` : piece;
        }
    }
    if (cur) parts.push(cur);
    return parts;
};

const HANDOVER_MAX_DOC_CHARS = 80000; // 인계장은 바뀐 구역만 다시 쓰지만, 너무 길면 매번 읽는 비용이 커짐

const HandoverTab: React.FC<Props> = ({ notes, onSelectNote, onSaveNewNote, onUpdateNote, handoverDoc, isFetchingAll }) => {
    const meta: HandoverMeta = handoverDoc?.handover || { sources: {}, refs: [], updatedAt: 0 };
    const byId = useMemo(() => new Map(notes.map(n => [n.id, n])), [notes]);
    // 업무 메모 (AI 결과 메모는 InsightsView에서 이미 빠짐)
    const workNotes = useMemo(() => notes.filter(n => n.work), [notes]);
    const statusOf = (n: Note): HandoverStatus => {
        const v = meta.sources[n.id];
        if (v === undefined) return 'new';
        // 이전 버전에서 긴 메모가 잘린 채 반영된 경우 → 통째로 다시 반영 필요
        if ((meta.v || 1) < HANDOVER_META_VERSION && legacyLength(n) > LEGACY_CLIP_CHARS) return 'truncated';
        if (v === 0) return 'truncated'; // 다시 반영하기로 표시했지만 아직 못 한 메모
        return handoverVersion(n) > v ? 'changed' : 'done';
    };
    const withStatus = workNotes
        .map(n => ({ n, status: statusOf(n) }))
        .sort((a, b) => handoverVersion(b.n) - handoverVersion(a.n));
    const pending = withStatus.filter(x => x.status !== 'done');
    // 반영했던 메모 중 업무 분류가 풀렸거나(목록에 있는데 업무 아님) 목록에 없는(삭제됐을 수 있는) 것.
    // 목록에 없는 것은 실행할 때 기기 저장소에서 한 번 더 확인하고, 예전 메모를 불러오는 중에는 실행하지 않음.
    const removedIds = Object.keys(meta.sources).filter(id => { const n = byId.get(id); return !n || !n.work; });

    const [purpose, setPurpose] = useState(meta.purpose || '');
    useEffect(() => { setPurpose(meta.purpose || ''); }, [handoverDoc?.id, meta.purpose]); // eslint-disable-line react-hooks/exhaustive-deps
    const runningRef = useRef(false); // 두 번 눌러도 한 번만 실행
    const [busy, setBusy] = useState<string | null>(null); // 진행 표시 문구
    const [error, setError] = useState<string | null>(null);
    const [showList, setShowList] = useState(false);
    const [copied, setCopied] = useState(false);
    const docBoxRef = useRef<HTMLDivElement>(null);

    // [메모N] → 고정 번호 순서의 메모 (삭제된 메모는 자리만 유지)
    const refNotes = meta.refs.map(id => byId.get(id) || ({ id, title: '(삭제·분류 해제된 메모)' } as Note));
    const docHtml = useMemo(
        () => handoverDoc?.content ? sectionizeHtml(renderLinkedMarkdown(handoverDoc.content, meta.refs.length)).html : '',
        [handoverDoc?.content, meta.refs.length]
    );

    // expectedUpdatedAt: 정리를 시작할 때(또는 직전 저장 때)의 인계장 메모 수정 시각. 그 사이 다른 곳에서 고쳤으면 덮지 않음.
    const persist = async (docId: string | null, content: string, next: HandoverMeta, expectedUpdatedAt: number | null): Promise<{ id: string; savedAt: number }> => {
        const now = Date.now();
        if (!docId) {
            const note: Note = {
                id: uuidv4(),
                title: '인계장',
                content,
                summary: '',
                createdAt: now,
                updatedAt: now,
                sources: [],
                images: [],
                isEnhancing: false,
                isProcessed: false,
                work: true,
                origin: 'ai',
                handover: next
            };
            await onSaveNewNote(note);
            return { id: note.id, savedAt: now };
        }
        const latest = await getNoteFromDB(docId).catch(() => undefined);
        if (!latest) throw new Error('인계장 메모를 찾지 못했습니다(삭제됐을 수 있음). "처음부터 다시 정리"를 눌러주세요.');
        if (expectedUpdatedAt !== null && (latest.updatedAt || 0) !== expectedUpdatedAt) {
            throw new Error('정리하는 동안 인계장 메모가 수정돼서(이 기기 또는 다른 기기) 덮어쓰지 않았어요. 다시 눌러주세요.');
        }
        await onUpdateNote({ ...latest, content, updatedAt: now, handover: next });
        const check = await getNoteFromDB(docId).catch(() => undefined);
        if (!check || check.updatedAt !== now) throw new Error('인계장 저장에 실패했습니다. 잠시 후 다시 시도해주세요.');
        return { id: docId, savedAt: now };
    };

    // mode 'update': 새/수정/삭제된 업무 메모만 반영 · 'rebuild': 처음부터 다시
    const run = async (mode: 'update' | 'rebuild') => {
        if (runningRef.current || busy) return;
        if (isFetchingAll) { setError('예전 메모를 불러오는 중이에요. 잠시 뒤에 다시 눌러주세요.'); return; }
        if (mode === 'rebuild' && handoverDoc && !window.confirm('인계장을 처음부터 다시 정리할까요? 인계장 메모에 직접 고친 내용은 사라지고, 업무 메모 전체로 새로 만듭니다.')) return;
        if (mode === 'update' && (handoverDoc?.content || '').length > HANDOVER_MAX_DOC_CHARS) {
            setError(`인계장이 길어져(${Math.round((handoverDoc?.content || '').length / 1000)}천 자) 한 번에 다시 쓰기 어려워요. 인계장 메모에서 지난 항목을 정리하거나 "처음부터 다시 정리"를 눌러주세요.`);
            return;
        }
        runningRef.current = true;
        setBusy('준비 중…');
        setError(null);
        let docId = handoverDoc?.id || null;
        let expected: number | null = handoverDoc ? (handoverDoc.updatedAt || 0) : null;
        let current = mode === 'rebuild' ? '' : (handoverDoc?.content || '');
        const sources: Record<string, number> = mode === 'rebuild' ? {} : { ...meta.sources };
        const refs: string[] = mode === 'rebuild' ? [] : [...meta.refs];
        // 이전 버전에서 잘린 채 반영된 메모는 "다시 반영할 것"(0)으로 표시 → 이번에 못 끝내도 다음에 이어서 반영
        pending.filter(x => x.status === 'truncated').forEach(x => { sources[x.n.id] = 0; });
        // 오래된 메모부터 반영 (같은 항목이 다르면 나중 메모가 이기도록)
        const queue = (mode === 'rebuild' ? workNotes : pending.map(x => x.n))
            .slice().sort((a, b) => handoverVersion(a) - handoverVersion(b));
        // 메모는 자르지 않고 보냄. 아주 긴 메모만 여러 조각으로 나눠 여러 번에 걸쳐 반영
        type Piece = { note: Note; part: number; parts: number; text: string };
        let pieces: Piece[] = [];
        queue.forEach(n => {
            const parts = splitForHandover(handoverTextOf(n), HANDOVER_CHUNK_CHARS);
            parts.forEach((text, i) => pieces.push({ note: n, part: i + 1, parts: parts.length, text }));
        });
        const cleanPurpose = purpose.trim();
        try {
            // 목록에 없는 메모는 정말 지워진 것인지 기기 저장소에서 확인 (아직 안 불러온 메모를 지우지 않도록)
            let removed: string[] = [];
            if (mode === 'update') {
                for (const id of removedIds) {
                    const inList = byId.get(id);
                    if (inList) { if (!inList.work) removed.push(id); continue; }
                    const stored = await getNoteFromDB(id).catch(() => undefined);
                    if (!stored || !stored.work) removed.push(id);
                }
            }
            let batchChars = HANDOVER_BATCH_CHARS;
            let purposeDone = false;
            for (let batch = 1; batch <= HANDOVER_MAX_BATCHES && (pieces.length > 0 || removed.length > 0 || batch === 1); batch++) {
                if (pieces.length === 0 && removed.length === 0 && current.trim() && cleanPurpose === (meta.purpose || '')) break;
                // 한 번에 보낼 조각들 (최소 1조각)
                const take: Piece[] = [];
                let used = 0;
                for (const p of pieces) {
                    if (take.length > 0 && used + p.text.length > batchChars) break;
                    take.push(p);
                    used += p.text.length;
                }
                const noteCount = new Set(take.map(p => p.note.id)).size;
                setBusy(pieces.length > take.length || batch > 1
                    ? `정리 중… (${batch}번째 묶음, 메모 ${noteCount}개)`
                    : `정리 중… (메모 ${noteCount}개)`);
                const labelOf = (id: string) => {
                    let idx = refs.indexOf(id);
                    if (idx < 0) { refs.push(id); idx = refs.length - 1; }
                    return idx + 1;
                };
                const items = take.map(p => ({
                    label: labelOf(p.note.id), title: p.note.title || '', date: handoverVersion(p.note),
                    text: p.text, part: p.part, parts: p.parts
                }));
                // 수정된 메모(또는 잘린 채 반영됐던 메모)는 첫 조각에서만 "예전 항목을 새 내용으로" 지시
                const modifiedLabels = Array.from(new Set(take
                    .filter(p => p.part === 1 && sources[p.note.id] !== undefined)
                    .map(p => refs.indexOf(p.note.id) + 1)));
                const removedLabels = removed.map(id => refs.indexOf(id) + 1).filter(x => x > 0);
                try {
                    current = await updateHandoverDocument({
                        current, items, modifiedLabels, removedLabels, purpose: cleanPurpose,
                        purposeChanged: !purposeDone && mode === 'update' && cleanPurpose !== (meta.purpose || '')
                    });
                    purposeDone = true;
                } catch (e: any) {
                    // 분량 한도: 더 작게 나눠 같은 묶음부터 다시 (조각 하나가 커서 걸린 경우는 그 조각을 반으로)
                    if (e?.code === 'MAX_TOKENS' && (take.length > 1 || take[0].text.length > HANDOVER_MIN_BATCH_CHARS)) {
                        if (take.length === 1) {
                            const big = take[0];
                            const halves = splitForHandover(big.text, Math.ceil(big.text.length / 2) + 1);
                            const sameNote = pieces.filter(p => p.note.id === big.note.id);
                            const texts = sameNote.flatMap(p => p === big ? halves : [p.text]);
                            // 이미 반영한 앞 조각 번호는 그대로 이어서 매김 (1번 조각이 아니면 "이어지는 내용"으로 처리되도록)
                            const startPart = sameNote[0].part;
                            const rebuilt = texts.map((text, i) => ({ note: big.note, part: startPart + i, parts: startPart - 1 + texts.length, text }));
                            const firstIdx = pieces.indexOf(sameNote[0]);
                            pieces = [...pieces.slice(0, firstIdx), ...rebuilt, ...pieces.slice(firstIdx + sameNote.length)];
                        }
                        batchChars = Math.max(HANDOVER_MIN_BATCH_CHARS, Math.floor(batchChars / 2));
                        continue;
                    }
                    throw e;
                }
                // 마지막 조각까지 반영한 메모만 "반영됨"으로 기록
                take.filter(p => p.part === p.parts).forEach(p => { sources[p.note.id] = handoverVersion(p.note); });
                removed.forEach(id => { delete sources[id]; });
                removed = [];
                pieces = pieces.slice(take.length);
                // 묶음마다 저장 → 중간에 끊겨도 반영한 만큼은 남음
                const saved = await persist(docId, current, { sources, refs, updatedAt: Date.now(), purpose: cleanPurpose || undefined, v: HANDOVER_META_VERSION }, expected);
                docId = saved.id;
                expected = saved.savedAt;
            }
            const left = new Set(pieces.map(p => p.note.id)).size;
            if (left > 0) setError(`업무 메모가 많아 ${left}개는 아직 반영하지 못했어요. "새 업무 메모 반영"을 한 번 더 눌러주세요.`);
        } catch (e: any) {
            setError(e?.message || '인계장을 정리하지 못했습니다.');
        } finally {
            runningRef.current = false;
            setBusy(null);
        }
    };

    const handleCopy = async () => {
        if (!handoverDoc?.content) return;
        // 인용 표시 [메모N]은 빼고 복사 (메신저 등에 붙여넣기용)
        const text = handoverDoc.content.replace(/\s*\[메모\s?\d{1,3}(?:\s*[,·]\s*(?:메모\s?)?\d{1,3})*\]/g, '');
        try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            setError('복사하지 못했습니다. 인계장 메모를 열어 직접 복사해주세요.');
        }
    };

    const handleDocClick = (e: React.MouseEvent) => {
        const target = (e.target as HTMLElement).closest('[data-note-ref]');
        if (!target) return;
        const n = refNotes[Number(target.getAttribute('data-note-ref')) - 1];
        if (n && byId.has(n.id)) onSelectNote(n.id);
    };
    const setAllSections = (open: boolean) => {
        docBoxRef.current?.querySelectorAll('details.md-section').forEach(d => {
            if (open) d.setAttribute('open', ''); else d.removeAttribute('open');
        });
    };

    const newCount = pending.filter(x => x.status === 'new').length;
    const changedCount = pending.filter(x => x.status === 'changed').length;
    const truncatedCount = pending.filter(x => x.status === 'truncated').length;
    const hasWork = pending.length > 0 || removedIds.length > 0;
    const statusBadge = (st: HandoverStatus) =>
        st === 'done' ? <span className="text-[10px] font-bold text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded shrink-0">반영됨</span>
        : st === 'new' ? <span className="text-[10px] font-bold text-accent-700 bg-accent-50 px-1.5 py-0.5 rounded shrink-0">새 메모</span>
        : st === 'truncated' ? <span className="text-[10px] font-bold text-clay-600 bg-clay-50 px-1.5 py-0.5 rounded shrink-0">잘려서 반영됨</span>
        : <span className="text-[10px] font-bold text-warn-700 bg-warn-50 px-1.5 py-0.5 rounded shrink-0">수정됨</span>;

    return (
        <div className="space-y-4">
            <Intro cost="처음 정리는 1회 약 100~400원, 이후 새 메모만 반영할 때는 인계장 길이에 따라 약 50~200원.">
                <b>'업무'로 분류한 메모</b>(인계 사항, 시술 팁 등)로 인계장 하나를 만들어 <b>여기에 계속 보관</b>합니다(모든 기기에 동기화).
                다음부터는 <b>새로 쓰거나 고친 업무 메모만</b> 반영해서 갱신하고, 이미 반영된 메모는 건너뜁니다.
                인계장은 '인계장'이라는 업무 메모로도 저장돼서, 메모 화면에서 직접 고칠 수도 있어요. 고친 내용은 다음 갱신 때도 유지되고, 원래 업무 메모를 고친 경우에만 그 메모에서 나온 항목이 새 내용으로 바뀝니다.
            </Intro>

            {workNotes.length === 0 && !handoverDoc ? (
                <p className="text-sm text-slate-400">아직 '업무'로 분류한 메모가 없어요. 메모를 쓸 때나 메모 화면 날짜 옆 분류에서 <b>업무</b>를 누르면 여기에 모입니다(메모와 함께 고를 수 있어요).</p>
            ) : (
                <>
                    <div className="bg-white border border-slate-200 rounded-xl p-3 space-y-3">
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                            <span className="font-bold text-slate-600">업무 메모 {workNotes.length}개</span>
                            <span className="text-slate-400">반영됨 {withStatus.length - pending.length}</span>
                            {newCount > 0 && <span className="font-bold text-accent-700">새 메모 {newCount}</span>}
                            {changedCount > 0 && <span className="font-bold text-warn-700">수정됨 {changedCount}</span>}
                            {truncatedCount > 0 && <span className="font-bold text-clay-600">잘려서 반영됨 {truncatedCount}</span>}
                            {removedIds.length > 0 && <span className="font-bold text-clay-600">삭제·분류 해제 {removedIds.length}</span>}
                            <button onClick={() => setShowList(v => !v)} className="ml-auto flex items-center gap-1 font-bold text-slate-500 hover:text-slate-700">
                                목록 {showList ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                            </button>
                        </div>
                        {showList && (
                            <div className="space-y-1 max-h-72 overflow-y-auto border-t border-slate-100 pt-2">
                                {withStatus.map(({ n, status }) => (
                                    <button key={n.id} onClick={() => onSelectNote(n.id)} className="w-full flex items-center gap-2 text-left text-sm hover:text-accent-700">
                                        {statusBadge(status)}
                                        <span className="flex-1 min-w-0 truncate text-slate-700">{n.title || '(제목 없음)'}</span>
                                        <span className="text-[11px] text-slate-400 shrink-0">{new Date(handoverVersion(n)).toLocaleDateString()}</span>
                                    </button>
                                ))}
                            </div>
                        )}
                        <input
                            value={purpose}
                            onChange={e => setPurpose(e.target.value)}
                            placeholder="용도·받는 사람 (선택) — 예: 주말 당직 인계, EP lab 새로 오는 fellow용"
                            className={inputCls}
                        />
                        <div className="flex flex-wrap items-center gap-2">
                            <button
                                onClick={() => run(handoverDoc ? 'update' : 'rebuild')}
                                disabled={!!busy || !!isFetchingAll || (handoverDoc ? !hasWork && purpose.trim() === (meta.purpose || '') : workNotes.length === 0)}
                                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-accent-600 hover:bg-accent-700 text-white text-sm font-bold whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                            >
                                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ClipboardCheck className="w-4 h-4" />}
                                {busy ? busy
                                    : isFetchingAll ? '예전 메모 불러오는 중…'
                                    : !handoverDoc ? '인계장 만들기'
                                    : truncatedCount > 0 && truncatedCount === pending.length && removedIds.length === 0 ? `잘린 메모 다시 반영 (${truncatedCount})`
                                    : hasWork ? `새 업무 메모 반영 (${pending.length + removedIds.length})`
                                    : purpose.trim() !== (meta.purpose || '') ? '용도 바꿔서 다시 정리'
                                    : '새로 반영할 메모 없음'}
                            </button>
                            {handoverDoc && (
                                <button onClick={() => run('rebuild')} disabled={!!busy || !!isFetchingAll || workNotes.length === 0}
                                    className="flex items-center gap-1 px-3 py-2 rounded-lg text-xs font-bold text-slate-500 hover:text-slate-700 hover:bg-slate-100 disabled:opacity-40">
                                    <RotateCw className="w-3.5 h-3.5" /> 처음부터 다시 정리
                                </button>
                            )}
                        </div>
                    </div>

                    {error && !busy && <ErrorBox message={error} />}

                    {handoverDoc && (
                        <div className="bg-white border border-slate-200 rounded-xl p-4 md:p-5 shadow-sm">
                            <div className="flex flex-wrap items-center gap-2 mb-3">
                                <span className="text-xs font-bold text-accent-700">
                                    인계장 · {meta.updatedAt ? `${new Date(meta.updatedAt).toLocaleString()} 정리` : ''} · 업무 메모 {Object.keys(meta.sources).length}개 반영
                                </span>
                                <div className="ml-auto flex items-center gap-3 text-[11px] font-bold text-slate-400">
                                    <button onClick={() => setAllSections(true)} className="hover:text-slate-600">모두 펼치기</button>
                                    <button onClick={() => setAllSections(false)} className="hover:text-slate-600">모두 접기</button>
                                    <button onClick={handleCopy} className="flex items-center gap-1 hover:text-slate-600">
                                        {copied ? <Check className="w-3.5 h-3.5 text-accent-600" /> : <Copy className="w-3.5 h-3.5" />} {copied ? '복사됨' : '복사'}
                                    </button>
                                    <button onClick={() => onSelectNote(handoverDoc.id)} className="hover:text-slate-600">메모로 열기·고치기</button>
                                </div>
                            </div>
                            <div
                                ref={docBoxRef}
                                className="prose prose-sm prose-slate max-w-none text-slate-700 leading-relaxed break-words"
                                onClick={handleDocClick}
                                dangerouslySetInnerHTML={{ __html: docHtml }}
                            />
                        </div>
                    )}
                </>
            )}
        </div>
    );
};

// ---------------------------------------------------------------------------
// 환자 팔로업: '환자' 메모를 주기적으로 열어 경과 확인 + 공부할 것 챙기기
// - "확인함"을 누르면 정한 주기(3일~1달) 뒤에 다시 "확인할 차례"로 올라옴
// - 확인한 뒤 기록이 추가·수정되면 "새 기록"으로 표시
// - 케이스 분석(✨ 요약)의 "추가로 확인할 것 / 추가 공부"를 여기서 바로 보고, 모아볼 수 있음
// ---------------------------------------------------------------------------
type PatientFilter = 'due' | 'updated' | 'all';

const daysAgo = (t: number, now: number) => {
    const d = Math.floor((now - t) / DAY_MS);
    return d <= 0 ? '오늘' : `${d}일 전`;
};

const MiniMarkdown: React.FC<{ markdown: string }> = ({ markdown }) => (
    <div className="prose prose-sm prose-slate max-w-none text-slate-700 leading-relaxed break-words"
        dangerouslySetInnerHTML={{ __html: renderLinkedMarkdown(markdown, 0) }} />
);

const PatientsTab: React.FC<Props> = ({ notes, onSelectNote, onUpdateNote, onFollowUpCheck, nowTick, onMergePatient }) => {
    const now = Date.now();
    const patients = useMemo(() => notes.filter(n => n.tag === 'patient'), [notes]);
    // 같은 식별번호(제목 맨 앞)의 환자 메모 묶음
    const dupGroups = useMemo(() => duplicatePatientGroups(buildPatientIndex(patients)), [patients]);
    const [mergingId, setMergingId] = useState<string | null>(null);
    const withStatus = useMemo(() => {
        const t = Date.now();
        return patients.map(n => ({ n, status: followUpStatus(n, t) as FollowUpStatus, analysis: analysisTextOf(n) }));
        // nowTick: 화면이 숨겨진 채 자정을 넘겨도 상태가 갱신되도록
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [patients, nowTick]);
    const counts = {
        due: withStatus.filter(x => x.status === 'due').length,
        updated: withStatus.filter(x => x.status === 'updated').length,
        all: withStatus.length
    };

    const [filter, setFilter] = useState<PatientFilter>('due');
    const [openId, setOpenId] = useState<string | null>(null);
    const [showStudy, setShowStudy] = useState(false);
    const [intervals, setIntervals] = useState<Record<string, number>>({});
    const [analyzingIds, setAnalyzingIds] = useState<Set<string>>(new Set());
    const [error, setError] = useState<string | null>(null);

    const list = useMemo(() => {
        const rank: Record<FollowUpStatus, number> = { due: 0, updated: 1, ok: 2 };
        const base = filter === 'all' ? withStatus : withStatus.filter(x => x.status === filter);
        return [...base].sort((a, b) => {
            if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];
            // 오래 확인 안 한 환자부터 (확인한 적 없으면 가장 먼저)
            return (a.n.followUpCheckedAt || 0) - (b.n.followUpCheckedAt || 0) || (b.n.updatedAt || 0) - (a.n.updatedAt || 0);
        });
    }, [withStatus, filter]);

    // 모든 환자 메모의 "추가 공부"를 한곳에 (무료, 이미 만든 케이스 분석에서 꺼냄)
    const studyItems = useMemo(() => withStatus
        .map(x => ({ n: x.n, text: extractSection(x.analysis, '추가 공부') }))
        .filter(x => x.text), [withStatus]);

    const handleAnalyze = async (n: Note) => {
        if (analyzingIds.has(n.id)) return;
        setAnalyzingIds(prev => new Set(prev).add(n.id));
        setError(null);
        try {
            const full = (await getNoteFromDB(n.id).catch(() => undefined)) || n;
            const result = await summarizeSingleNote({ ...full, content: contentForAnalysis(full.content || '') });
            if (!result) throw new Error('케이스 분석을 만들지 못했습니다.');
            const latest = (await getNoteFromDB(n.id).catch(() => undefined)) || full;
            onUpdateNote({ ...latest, ...summaryFieldsFor(latest, result, { mode: 'new' }), isProcessed: true });
            setOpenId(n.id);
        } catch (e: any) {
            setError(e?.message || '케이스 분석 중 오류가 발생했습니다.');
        } finally {
            setAnalyzingIds(prev => { const next = new Set(prev); next.delete(n.id); return next; });
        }
    };

    const chip = (f: PatientFilter, label: string, count: number, active: string) => (
        <button key={f} onClick={() => setFilter(f)}
            className={`px-3 py-1 rounded-full text-xs font-bold border whitespace-nowrap ${filter === f ? active : 'bg-white border-slate-200 text-slate-400 hover:text-slate-600'}`}>
            {label} {count}
        </button>
    );

    if (patients.length === 0) {
        return (
            <Intro>
                아직 '환자'로 분류한 메모가 없어요. 메모 화면 날짜 옆의 분류에서 <b>환자</b>를 누르면 여기에 모여, 주기적으로 경과를 확인하고 공부할 것을 챙길 수 있습니다.
            </Intro>
        );
    }

    return (
        <div className="space-y-4">
            <Intro cost="목록·확인 기록·공부 목록은 무료. 케이스 분석(갱신)은 누를 때만, 1회 약 50~150원.">
                '환자' 메모를 주기적으로 열어 경과를 확인하는 곳입니다. 확인한 뒤 <b>확인함</b>을 누르면 정한 주기(3일~1달) 뒤에 다시 <b>확인할 차례</b>로 올라오고, 그 사이 기록을 추가하면 <b>새 기록</b>으로 표시됩니다.
            </Intro>

            {dupGroups.length > 0 && (
                <div className="bg-warn-50/70 border border-warn-200 rounded-xl p-3 space-y-2">
                    <div className="text-sm font-bold text-warn-800">같은 번호의 환자 메모 {dupGroups.length}건</div>
                    <p className="text-xs text-warn-700">제목 맨 앞 번호가 같은 메모들이에요. 합치면 가장 오래된 메모에 작성 날짜 소제목(## 날짜)으로 이어 붙이고 나머지는 지웁니다(합치기 전 확인 창).</p>
                    {dupGroups.map(g => (
                        <div key={g.id} className="bg-white border border-warn-100 rounded-lg p-2">
                            <div className="flex items-center gap-2">
                                <span className="text-xs font-bold text-warn-800">{g.id}</span>
                                <span className="text-[11px] text-slate-400">메모 {g.notes.length}개</span>
                                {onMergePatient && (
                                    <button
                                        onClick={async () => { setMergingId(g.id); try { await onMergePatient(g.notes.map(n => n.id)); } finally { setMergingId(null); } }}
                                        disabled={!!mergingId}
                                        className="ml-auto flex items-center gap-1 px-2.5 py-1 rounded-lg bg-warn-600 hover:bg-warn-700 text-white text-xs font-bold disabled:opacity-50"
                                    >
                                        {mergingId === g.id && <Loader2 className="w-3.5 h-3.5 animate-spin" />} 하나로 합치기
                                    </button>
                                )}
                            </div>
                            <ul className="mt-1 space-y-0.5">
                                {g.notes.map(n => (
                                    <li key={n.id}>
                                        <button onClick={() => onSelectNote(n.id)} className="text-xs text-slate-600 hover:text-accent-600 text-left truncate max-w-full">
                                            · {n.title || '(제목 없음)'} <span className="text-slate-400">({new Date(n.createdAt).toLocaleDateString()})</span>
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    ))}
                </div>
            )}

            <div className="flex flex-wrap items-center gap-1.5">
                {chip('due', '확인할 차례', counts.due, 'bg-warn-50 border-warn-200 text-warn-700')}
                {chip('updated', '새 기록', counts.updated, 'bg-clay-50 border-clay-200 text-clay-600')}
                {chip('all', '전체', counts.all, 'bg-slate-100 border-slate-300 text-slate-700')}
                {studyItems.length > 0 && (
                    <button onClick={() => setShowStudy(v => !v)}
                        className={`ml-auto flex items-center gap-1 px-3 py-1 rounded-full text-xs font-bold border whitespace-nowrap ${showStudy ? 'bg-accent-50 border-accent-200 text-accent-600' : 'bg-white border-slate-200 text-slate-500 hover:text-slate-700'}`}>
                        <Lightbulb className="w-3.5 h-3.5" /> 공부할 것 모아보기 {studyItems.length}
                    </button>
                )}
            </div>

            {showStudy && (
                <div className="bg-white border border-accent-100 rounded-xl p-4 space-y-4">
                    <p className="text-xs text-slate-400">각 환자 메모의 케이스 분석 중 "추가 공부" 부분을 모았습니다.</p>
                    {studyItems.map(({ n, text }) => (
                        <div key={n.id}>
                            <button onClick={() => onSelectNote(n.id)} className="text-sm font-bold text-slate-800 hover:text-accent-600 mb-1 text-left">{n.title || '(제목 없음)'}</button>
                            <MiniMarkdown markdown={text} />
                        </div>
                    ))}
                </div>
            )}

            {error && <ErrorBox message={error} />}

            {list.length === 0 ? (
                <p className="text-sm text-slate-400 text-center py-8">
                    {filter === 'due' ? '지금 확인할 환자가 없어요.' : filter === 'updated' ? '확인 뒤 새로 추가된 기록이 없어요.' : '환자 메모가 없어요.'}
                </p>
            ) : (
                <div className="space-y-2">
                    {list.map(({ n, status, analysis }) => {
                        const isOpen = openId === n.id;
                        const analyzing = analyzingIds.has(n.id);
                        const interval = intervals[n.id] ?? n.followUpIntervalDays ?? DEFAULT_FOLLOWUP_DAYS;
                        const outdated = !!analysis && !!n.summarizedAt && (n.updatedAt || 0) > n.summarizedAt;
                        const toCheck = extractSection(analysis, '추가로 확인할 것');
                        const toStudy = extractSection(analysis, '추가 공부');
                        const dx = extractSection(analysis, '추정 진단');
                        return (
                            <div key={n.id} className="bg-white border border-slate-200 rounded-xl p-3">
                                <div className="flex items-start gap-2">
                                    <button onClick={() => onSelectNote(n.id)} className="flex-1 min-w-0 text-left">
                                        <div className="flex items-center gap-1.5">
                                            <span className="text-sm font-bold text-slate-800 truncate hover:text-accent-600">{n.title || '(제목 없음)'}</span>
                                            {status === 'due' && <span className="shrink-0 text-[10px] font-bold text-warn-700 bg-warn-50 px-1.5 py-0.5 rounded">확인할 차례</span>}
                                            {status === 'updated' && <span className="shrink-0 text-[10px] font-bold text-clay-600 bg-clay-50 px-1.5 py-0.5 rounded">새 기록</span>}
                                        </div>
                                        <div className="text-[11px] text-slate-400 mt-0.5">
                                            마지막 기록 {daysAgo(n.updatedAt || n.createdAt, now)}
                                            {' · '}{n.followUpCheckedAt ? `마지막 확인 ${daysAgo(n.followUpCheckedAt, now)}` : '아직 확인 안 함'}
                                            {n.followUpDueAt && n.followUpCheckedAt ? ` · 다음 확인 ${new Date(n.followUpDueAt).toLocaleDateString()}` : ''}
                                        </div>
                                    </button>
                                </div>

                                <div className="flex flex-wrap items-center gap-2 mt-2">
                                    <div className="inline-flex items-center gap-1">
                                        <select
                                            value={interval}
                                            onChange={e => setIntervals(prev => ({ ...prev, [n.id]: Number(e.target.value) }))}
                                            className="text-xs border border-slate-200 rounded-lg px-1.5 py-1 bg-white text-slate-600"
                                            title="다음 확인까지"
                                        >
                                            {FOLLOWUP_INTERVALS.map(d => <option key={d} value={d}>{d === 30 ? '1달 뒤' : d === 14 ? '2주 뒤' : d === 7 ? '1주 뒤' : `${d}일 뒤`}</option>)}
                                        </select>
                                        <button
                                            onClick={() => onFollowUpCheck(n.id, interval)}
                                            className="flex items-center gap-1 px-3 py-1 rounded-lg bg-accent-600 hover:bg-accent-700 text-white text-xs font-bold"
                                        >
                                            <Check className="w-3.5 h-3.5" /> 확인함
                                        </button>
                                    </div>
                                    <button
                                        onClick={() => handleAnalyze(n)}
                                        disabled={analyzing}
                                        className="flex items-center gap-1 px-3 py-1 rounded-lg bg-white border border-clay-200 text-clay-600 hover:bg-clay-50 text-xs font-bold disabled:opacity-50"
                                        title="케이스 분석(추정·감별 진단, 추가로 확인할 것, 추가 공부)을 지금 기록 기준으로 새로 만들기"
                                    >
                                        {analyzing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                                        {analyzing ? '분석 중…' : !analysis ? '케이스 분석' : outdated ? '분석 갱신 (기록 추가됨)' : '분석 다시 하기'}
                                    </button>
                                    {analysis && (
                                        <button onClick={() => setOpenId(isOpen ? null : n.id)} className="ml-auto flex items-center gap-1 text-xs font-bold text-slate-500 hover:text-slate-700">
                                            확인·공부할 것 {isOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                                        </button>
                                    )}
                                </div>

                                {isOpen && analysis && (
                                    <div className="mt-3 pt-3 border-t border-slate-100 space-y-3">
                                        {dx && <div><div className="text-xs font-bold text-slate-500 mb-1">추정 진단</div><MiniMarkdown markdown={dx} /></div>}
                                        {toCheck && <div><div className="text-xs font-bold text-warn-600 mb-1">추가로 확인할 것</div><MiniMarkdown markdown={toCheck} /></div>}
                                        {toStudy && <div><div className="text-xs font-bold text-accent-600 mb-1">추가 공부</div><MiniMarkdown markdown={toStudy} /></div>}
                                        {!dx && !toCheck && !toStudy && <MiniMarkdown markdown={analysis} />}
                                        {outdated && <p className="text-[11px] text-warn-600">분석한 뒤 기록이 추가됐어요. "분석 갱신"으로 최신 기록 기준으로 다시 정리할 수 있습니다.</p>}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
};

// ---------------------------------------------------------------------------
// 2) 비슷한 메모 묶기
// ---------------------------------------------------------------------------
const DISMISSED_KEY = 'medinote_dismissed_groups';
const STRICTNESS: { key: string; label: string; threshold: number }[] = [
    { key: 'loose', label: '느슨하게', threshold: 0.62 },
    { key: 'normal', label: '보통', threshold: 0.7 },
    { key: 'strict', label: '엄격하게', threshold: 0.78 },
];
const GROUP_PAGE = 15;

const SimilarTab: React.FC<Props> = ({ notes, onSelectNote, onSaveNewNote }) => {
    // 환자 메모와 '업무'만 붙은 메모(인계 사항 등)는 공부용 묶음에서 제외
    const pool = useMemo(() => notes.filter(n => n.tag !== 'patient' && !(n.work && n.tag !== 'memo')), [notes]);
    const withEmb = pool.filter(n => n.embedding && n.embedding.length > 0).length;
    const byId = useMemo(() => new Map(notes.map(n => [n.id, n])), [notes]);

    const [strictness, setStrictness] = useState('normal');
    const [groups, setGroups] = useState<NoteGroup[] | null>(null);
    const [scanning, setScanning] = useState(false);
    const [progress, setProgress] = useState(0);
    const [visible, setVisible] = useState(GROUP_PAGE);
    const [dismissed, setDismissed] = useState<Set<string>>(() => {
        try { return new Set(JSON.parse(safeGet(DISMISSED_KEY) || '[]')); } catch { return new Set(); }
    });
    const [generatingKey, setGeneratingKey] = useState<string | null>(null);
    const [results, setResults] = useState<Record<string, { markdown: string; refNotes: Note[]; topic: string }>>({});
    const [error, setError] = useState<string | null>(null);

    const handleScan = async () => {
        if (scanning) return;
        setScanning(true);
        setProgress(0);
        setError(null);
        try {
            const th = STRICTNESS.find(s => s.key === strictness)?.threshold ?? 0.7;
            const g = await findSimilarNoteGroups(pool, th, { onProgress: setProgress });
            setGroups(g);
            setVisible(GROUP_PAGE);
        } catch (e: any) {
            setError(e?.message || '비슷한 메모를 찾지 못했습니다.');
        } finally {
            setScanning(false);
        }
    };

    const dismiss = (key: string) => {
        setDismissed(prev => {
            const next = new Set(prev);
            next.add(key);
            safeSet(DISMISSED_KEY, JSON.stringify(Array.from(next).slice(-500)));
            return next;
        });
    };

    const handleSynthesize = async (g: NoteGroup) => {
        if (generatingKey) return;
        setGeneratingKey(g.key);
        setError(null);
        try {
            const seed = byId.get(g.seedId);
            const topic = seed?.title || '비슷한 메모 정리';
            const all = await hydrateNotes(g.noteIds.map(id => byId.get(id)).filter((n): n is Note => !!n));
            const hydrated = notesWithinContextBudget(all, CONTEXT_BUDGETS.synthesize[0], CONTEXT_BUDGETS.synthesize[1]);
            const markdown = await synthesizeNotes(topic, hydrated);
            setResults(prev => ({ ...prev, [g.key]: { markdown, refNotes: hydrated, topic } }));
        } catch (e: any) {
            setError(e?.message || '정리본을 만들지 못했습니다.');
        } finally {
            setGeneratingKey(null);
        }
    };

    const shown = (groups || []).filter(g => !dismissed.has(g.key) && g.noteIds.every(id => byId.has(id)));

    return (
        <div className="space-y-4">
            <Intro cost="묶음 찾기는 이미 계산해 둔 검색용 데이터로 기기 안에서 계산해 무료입니다. 정리본은 묶음마다 누를 때만 만들어요(1회 약 100~200원).">
                같은 주제를 여러 번 나눠 적은 메모를 찾아 묶어 보여줍니다. 묶음마다 <b>정리본 만들기</b>로 하나의 메모로 합칠 수 있어요(원래 메모는 그대로 둡니다). 환자 메모는 제외합니다.
            </Intro>
            <div className="flex flex-wrap items-center gap-2">
                <div className="inline-flex p-0.5 bg-slate-100 rounded-lg">
                    {STRICTNESS.map(s => (
                        <button key={s.key} onClick={() => setStrictness(s.key)} disabled={scanning}
                            className={`px-3 py-1 rounded-md text-xs font-bold ${strictness === s.key ? 'bg-white text-accent-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
                            {s.label}
                        </button>
                    ))}
                </div>
                <button onClick={handleScan} disabled={scanning || withEmb < 2} className={primaryBtn}>
                    {scanning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Layers className="w-4 h-4" />}
                    {scanning ? `찾는 중 ${Math.round(progress * 100)}%` : groups ? '다시 찾기' : '비슷한 메모 찾기'}
                </button>
                <span className="text-xs text-slate-400">
                    메모 {withEmb}/{pool.length}개 기준{withEmb < pool.length ? (hasVoyageApiKey() ? ' (나머지는 검색 준비 중)' : ' (검색용 키가 없어 계산 불가)') : ''}
                </span>
            </div>

            {error && <ErrorBox message={error} />}

            {groups && !scanning && (
                shown.length === 0 ? (
                    <p className="text-sm text-slate-400 text-center py-8">묶을 만한 메모를 찾지 못했어요. "느슨하게"로 다시 찾아보세요.</p>
                ) : (
                    <div className="space-y-3">
                        <p className="text-xs text-slate-500 px-1">묶음 {shown.length}개 · 메모가 많은 묶음부터</p>
                        {shown.slice(0, visible).map(g => {
                            const seed = byId.get(g.seedId);
                            const res = results[g.key];
                            return (
                                <div key={g.key} className="space-y-2">
                                    <div className="bg-white border border-slate-200 rounded-xl p-3">
                                        <div className="flex items-center gap-2 mb-1.5">
                                            <span className="text-sm font-bold text-slate-800 truncate flex-1 min-w-0">{seed?.title || '(제목 없음)'}</span>
                                            <span className="text-[11px] text-slate-400 shrink-0">메모 {g.noteIds.length}개 · 유사도 {Math.round(g.avgSim * 100)}%</span>
                                        </div>
                                        <div className="pl-1 border-l-2 border-slate-100 ml-1">
                                            {g.noteIds.map(id => byId.get(id)).filter((n): n is Note => !!n).map(n => (
                                                <NoteLink key={n.id} note={n} onSelect={onSelectNote}
                                                    extra={<span className="text-[11px] text-slate-300 shrink-0">{new Date(n.createdAt).toLocaleDateString()}</span>} />
                                            ))}
                                        </div>
                                        <div className="flex items-center gap-2 mt-2">
                                            <button onClick={() => handleSynthesize(g)} disabled={!!generatingKey}
                                                className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-accent-50 text-accent-600 hover:bg-accent-100 text-xs font-bold disabled:opacity-50">
                                                {generatingKey === g.key ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Layers className="w-3.5 h-3.5" />}
                                                {generatingKey === g.key ? '정리 중…' : res ? '정리본 다시 만들기' : '정리본 만들기'}
                                            </button>
                                            <button onClick={() => dismiss(g.key)} className="flex items-center gap-1 px-2 py-1.5 text-xs font-bold text-slate-400 hover:text-slate-600" title="이 묶음을 다시 보지 않기">
                                                <EyeOff className="w-3.5 h-3.5" /> 숨기기
                                            </button>
                                        </div>
                                    </div>
                                    {res && generatingKey !== g.key && (
                                        <NoteResultCard
                                            label="정리본"
                                            markdown={res.markdown}
                                            refNotes={res.refNotes}
                                            saveTitle={`정리: ${res.topic}`}
                                            onSelectNote={onSelectNote}
                                            onSaveNewNote={onSaveNewNote}
                                        />
                                    )}
                                </div>
                            );
                        })}
                        {shown.length > visible && (
                            <button onClick={() => setVisible(v => v + GROUP_PAGE)} className="w-full py-2 text-xs font-bold text-slate-500 hover:text-slate-700">
                                더 보기 ({shown.length - visible}개 더)
                            </button>
                        )}
                    </div>
                )
            )}
        </div>
    );
};

// ---------------------------------------------------------------------------
// 3) 빈 곳 찾기
// ---------------------------------------------------------------------------
const GapTab: React.FC<Props> = ({ notes, onSelectNote, onSaveNewNote }) => {
    const [topic, setTopic] = useState('');
    const [busy, setBusy] = useState<'search' | 'gen' | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [result, setResult] = useState<{ markdown: string; sources: Source[]; refNotes: Note[]; topic: string } | null>(null);

    const handleRun = async () => {
        const t = topic.trim();
        if (!t || busy) return;
        setError(null);
        setBusy('search');
        try {
            const found = await findRelatedNotes(t, notes.filter(n => n.tag !== 'patient' && !(n.work && n.tag !== 'memo')), 15, 0.3);
            const list = notesWithinContextBudget(found.list, CONTEXT_BUDGETS.gap[0], CONTEXT_BUDGETS.gap[1]);
            setBusy('gen');
            const { text, sources } = await findCoverageGaps(t, list);
            setResult({ markdown: text, sources, refNotes: list, topic: t });
        } catch (e: any) {
            setError(e?.message || '빈 곳을 찾지 못했습니다.');
        } finally {
            setBusy(null);
        }
    };

    return (
        <div className="space-y-4">
            <Intro cost="웹 검색 포함, 1회 약 100~200원.">
                주제나 가이드라인을 입력하면 표준 목차(가이드라인 섹션 구조)와 내 메모를 비교해 <b>충분 / 일부 / 없음</b>으로 표시하고, 먼저 채울 곳을 알려줍니다.
            </Intro>
            <div className="flex flex-col sm:flex-row gap-2">
                <input
                    value={topic}
                    onChange={e => setTopic(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) handleRun(); }}
                    placeholder="예: 2023 ACC/AHA AF guideline · 2021 ESC pacing/CRT guideline · HCM"
                    className={inputCls}
                />
                <button onClick={handleRun} disabled={!topic.trim() || !!busy} className={primaryBtn}>
                    {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                    {busy === 'search' ? '관련 메모 찾는 중…' : busy === 'gen' ? '목차와 비교 중…' : '빈 곳 찾기'}
                </button>
            </div>
            {error && !busy && <ErrorBox message={error} />}
            {result && !busy && (
                <>
                    <p className="text-xs text-slate-500 px-1">관련 메모 {result.refNotes.length}개와 비교했습니다.</p>
                    <NoteResultCard
                        label={`빈 곳 찾기 · ${result.topic}`}
                        markdown={result.markdown}
                        refNotes={result.refNotes}
                        sources={result.sources}
                        saveTitle={`빈 곳: ${result.topic}`}
                        onSelectNote={onSelectNote}
                        onSaveNewNote={onSaveNewNote}
                    />
                </>
            )}
        </div>
    );
};

// ---------------------------------------------------------------------------
// 4) 작성 템플릿
// ---------------------------------------------------------------------------
const TemplateTab: React.FC<Props & { active: boolean }> = ({ notes, onSelectNote, onSaveNewNote, active }) => {
    // 기록 건수 추정은 정규식 계산이라, 이 탭이 보일 때만 계산 (숨겨진 동안 메모가 바뀔 때마다 돌지 않게)
    const recordCounts = useMemo(() => {
        const m = new Map<string, number>();
        if (!active) return m;
        notes.forEach(n => {
            const c = estimateDataRecordCount(n.content || '');
            if (c >= 3) m.set(n.id, c);
        });
        return m;
    }, [notes, active]);
    const dataNotes = useMemo(
        () => notes.filter(n => recordCounts.has(n.id)).sort((a, b) => (recordCounts.get(b.id) || 0) - (recordCounts.get(a.id) || 0)),
        [notes, recordCounts]
    );

    const [target, setTarget] = useState('');
    const [candidates, setCandidates] = useState<Note[] | null>(null);
    const [checked, setChecked] = useState<Set<string>>(new Set());
    const [busy, setBusy] = useState<'search' | 'gen' | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [result, setResult] = useState<{ markdown: string; refNotes: Note[]; target: string } | null>(null);

    const handleFind = async () => {
        if (busy) return;
        setError(null);
        const t = target.trim();
        let list: Note[] = [];
        if (!t) {
            list = dataNotes.slice(0, 12);
        } else {
            setBusy('search');
            try {
                const res = await findRelatedNotes(t, notes, 12, 0.3);
                // 기록 묶음 메모를 앞으로
                list = [...res.list].sort((a, b) => (recordCounts.has(b.id) ? 1 : 0) - (recordCounts.has(a.id) ? 1 : 0));
            } catch (e: any) {
                setError(e?.message || '관련 메모를 찾지 못했습니다.');
            } finally {
                setBusy(null);
            }
        }
        setCandidates(list);
        const preferred = list.filter(n => recordCounts.has(n.id)).slice(0, 5);
        setChecked(new Set((preferred.length > 0 ? preferred : list.slice(0, 3)).map(n => n.id)));
    };

    const toggle = (id: string) => setChecked(prev => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
    });

    const handleGenerate = async () => {
        if (!candidates || checked.size === 0 || busy) return;
        setBusy('gen');
        setError(null);
        try {
            const all = await hydrateNotes(candidates.filter(n => checked.has(n.id)));
            const sel = notesWithinContextBudget(all, CONTEXT_BUDGETS.template[0], CONTEXT_BUDGETS.template[1]);
            const markdown = await buildDocumentationTemplate(target.trim(), sel);
            if (sel.length < all.length) {
                setError(`선택한 메모 ${all.length}개 중 분량 한도 안에 들어간 ${sel.length}개만 참고했습니다.`);
            }
            setResult({ markdown, refNotes: sel, target: target.trim() });
        } catch (e: any) {
            setError(e?.message || '템플릿을 만들지 못했습니다.');
        } finally {
            setBusy(null);
        }
    };

    return (
        <div className="space-y-4">
            <Intro cost="1회 약 100~300원 (붙여넣은 기록 양에 따라).">
                판독문·시술기록·의무기록을 붙여넣은 메모에서 <b>바로 쓸 수 있는 작성 틀</b>을 만듭니다. 실제 기록에서 쓰는 순서와 표현 그대로, 빈칸은 [ ]로. <b>틀 복사</b> 버튼으로 바로 가져다 쓸 수 있어요.
                <span className="block text-xs text-slate-500 mt-1">기록 묶음 메모 {dataNotes.length}개 발견</span>
            </Intro>
            <div className="flex flex-col sm:flex-row gap-2">
                <input
                    value={target}
                    onChange={e => setTarget(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) handleFind(); }}
                    placeholder="예: severe AS TTE 판독 · AF ablation 시술기록 · CIED interrogation (비우면 기록 많은 메모부터)"
                    className={inputCls}
                />
                <button onClick={handleFind} disabled={!!busy} className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-white border border-accent-200 text-accent-600 hover:bg-accent-50 text-sm font-bold whitespace-nowrap disabled:opacity-40">
                    {busy === 'search' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />} 기록 메모 찾기
                </button>
            </div>

            {candidates && (
                candidates.length === 0 ? (
                    <p className="text-sm text-slate-400">관련 기록 메모가 없어요. 판독문·시술기록을 여러 건 붙여넣은 메모가 있으면 더 좋은 틀이 나옵니다.</p>
                ) : (
                    <div className="bg-white border border-slate-200 rounded-xl p-3">
                        <div className="text-xs font-bold text-slate-500 mb-2">틀을 만들 때 참고할 메모 {checked.size}/{candidates.length}개</div>
                        <div className="space-y-1">
                            {candidates.map(n => (
                                <label key={n.id} className="flex items-center gap-2 text-sm">
                                    <input type="checkbox" checked={checked.has(n.id)} onChange={() => toggle(n.id)} disabled={!!busy}
                                        className="w-4 h-4 shrink-0 rounded border-slate-300 text-accent-600" />
                                    <span className="flex-1 min-w-0 truncate text-slate-700">{n.title || '(제목 없음)'}</span>
                                    {recordCounts.has(n.id) && (
                                        <span className="text-[11px] font-bold text-accent-500 bg-accent-50 px-1.5 py-0.5 rounded shrink-0">기록 {recordCounts.get(n.id)}건</span>
                                    )}
                                    <button type="button" onClick={() => onSelectNote(n.id)} className="text-[11px] text-slate-400 hover:text-accent-600 shrink-0">열기</button>
                                </label>
                            ))}
                        </div>
                        <div className="mt-3">
                            <button onClick={handleGenerate} disabled={checked.size === 0 || !!busy} className={primaryBtn}>
                                {busy === 'gen' ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />}
                                {busy === 'gen' ? '틀 만드는 중…' : '템플릿 만들기'}
                            </button>
                        </div>
                    </div>
                )
            )}
            {error && !busy && (result ? <p className="text-xs text-warn-600 px-1">{error}</p> : <ErrorBox message={error} />)}
            {result && busy !== 'gen' && (
                <NoteResultCard
                    label="작성 템플릿"
                    copyTemplate
                    markdown={result.markdown}
                    refNotes={result.refNotes}
                    saveTitle={`템플릿: ${result.target || '기록 작성 틀'}`}
                    onSelectNote={onSelectNote}
                    onSaveNewNote={onSaveNewNote}
                />
            )}
        </div>
    );
};

// ---------------------------------------------------------------------------
// 5) 케이스·시술 기록 (환자 메모)
// ---------------------------------------------------------------------------
const PERIODS: { key: string; label: string; days: number | null }[] = [
    { key: '1m', label: '1개월', days: 31 },
    { key: '3m', label: '3개월', days: 92 },
    { key: '6m', label: '6개월', days: 183 },
    { key: '1y', label: '1년', days: 366 },
    { key: 'all', label: '전체', days: null },
];
const CASE_BATCH = 10;
const CASE_MAX = 150;

const CasesTab: React.FC<Props> = ({ notes, onSelectNote, onSaveNewNote }) => {
    const [period, setPeriod] = useState('3m');
    const p = PERIODS.find(x => x.key === period) || PERIODS[1];
    const patientNotes = useMemo(() => {
        const since = p.days === null ? 0 : Date.now() - p.days * DAY_MS;
        return notes
            .filter(n => n.tag === 'patient' && (n.createdAt || 0) >= since)
            .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    }, [notes, p.days]);

    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [result, setResult] = useState<{ markdown: string; refNotes: Note[]; periodLabel: string } | null>(null);

    const handleRun = async () => {
        if (busy || patientNotes.length === 0) return;
        setBusy(true);
        setError(null);
        const target = patientNotes.slice(0, CASE_MAX);
        const batches: Note[][] = [];
        for (let i = 0; i < target.length; i += CASE_BATCH) batches.push(target.slice(i, i + CASE_BATCH));
        setProgress({ done: 0, total: batches.length });
        try {
            const extracts: CaseExtract[] = [];
            let failed = 0;
            for (let b = 0; b < batches.length; b++) {
                try {
                    const items = await extractCaseLogBatch(batches[b]);
                    items.forEach(it => {
                        const n = batches[b][it.index];
                        if (n) extracts.push({ noteId: n.id, procedures: it.procedures, diagnoses: it.diagnoses, memorable: it.memorable, learningPoint: it.learningPoint });
                    });
                } catch (e) {
                    console.error('case log batch failed', e);
                    failed++;
                }
                setProgress({ done: b + 1, total: batches.length });
            }
            if (failed === batches.length) throw new Error('AI 호출이 모두 실패했습니다. 잠시 후 다시 시도해주세요.');
            const refIndex = new Map(target.map((n, i) => [n.id, i + 1]));
            let markdown = buildCaseLogMarkdown(extracts, refIndex, p.label, patientNotes.length, target.length);
            if (failed > 0) markdown = `> 참고: ${failed}개 묶음(최대 ${failed * CASE_BATCH}개 메모)은 분석하지 못해 빠졌습니다.\n\n` + markdown;
            setResult({ markdown, refNotes: target, periodLabel: p.label });
        } catch (e: any) {
            setError(e?.message || '기록을 정리하지 못했습니다.');
        } finally {
            setBusy(false);
            setProgress(null);
        }
    };

    return (
        <div className="space-y-4">
            <Intro cost={`빠른 모델로 메모 ${CASE_BATCH}개씩 읽어요. 메모 50개 기준 약 50~100원. 한 번에 최근 ${CASE_MAX}개까지.`}>
                <b>'환자'로 분류한 메모</b>에서 시술 건수, 주요 진단, 기억할 케이스(배운 점)를 정리합니다. 건수는 AI가 뽑은 항목을 앱이 직접 세서 표로 만듭니다.
            </Intro>
            <div className="flex flex-wrap items-center gap-2">
                <div className="inline-flex p-0.5 bg-slate-100 rounded-lg">
                    {PERIODS.map(x => (
                        <button key={x.key} onClick={() => setPeriod(x.key)} disabled={busy}
                            className={`px-3 py-1 rounded-md text-xs font-bold ${period === x.key ? 'bg-white text-accent-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
                            {x.label}
                        </button>
                    ))}
                </div>
                <span className="text-xs text-slate-500">환자 메모 {patientNotes.length}개</span>
                <button onClick={handleRun} disabled={busy || patientNotes.length === 0} className={primaryBtn}>
                    {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ClipboardList className="w-4 h-4" />}
                    {busy && progress ? `정리 중 ${progress.done}/${progress.total}` : '기록 정리하기'}
                </button>
            </div>
            {patientNotes.length === 0 && (
                <p className="text-sm text-slate-400">이 기간에 '환자'로 분류한 메모가 없어요. 메모 화면에서 분류를 '환자'로 지정하면 여기에 모입니다.</p>
            )}
            {error && !busy && <ErrorBox message={error} />}
            {result && !busy && (
                <NoteResultCard
                    label={`케이스·시술 기록 · ${result.periodLabel}`}
                    markdown={result.markdown}
                    refNotes={result.refNotes}
                    saveTitle={`케이스·시술 기록 (${result.periodLabel}, ${new Date().toLocaleDateString()})`}
                    onSelectNote={onSelectNote}
                    onSaveNewNote={onSaveNewNote}
                />
            )}
        </div>
    );
};

// ---------------------------------------------------------------------------
const TAB_KEY = 'medinote_insights_tab';

const InsightsView: React.FC<Props> = (rawProps) => {
    // AI 결과를 저장한 메모는 분석 대상에서 제외 (결과가 다시 입력으로 섞이지 않게)
    const sourceNotes = useMemo(() => rawProps.notes.filter(n => n.origin !== 'ai'), [rawProps.notes]);
    // 보관 중인 인계장 (여러 개면 가장 최근에 정리한 것)
    const handoverDoc = useMemo(() => rawProps.notes
        .filter(n => n.handover)
        .sort((a, b) => (b.handover?.updatedAt || 0) - (a.handover?.updatedAt || 0))[0], [rawProps.notes]);
    const props: Props = { ...rawProps, notes: sourceNotes, handoverDoc };
    // 이번 주·비슷한 메모 묶기·빈 곳 찾기에는 질문 노트 대화(답이 하나라도 있는 것)도 함께
    const withThreads = useMemo(
        () => [...sourceNotes, ...(rawProps.threads || []).filter(t => /<!-- mt:a \d+ -->/.test(t.content || ''))],
        [sourceNotes, rawProps.threads]
    );
    const studyProps: Props = { ...props, notes: withThreads };
    const [tab, setTab] = useState<Tab>(() => {
        const saved = safeGet(TAB_KEY) as Tab | null;
        return saved && TABS.some(t => t.key === saved) ? saved : 'weekly';
    });
    useEffect(() => { safeSet(TAB_KEY, tab); }, [tab]);

    return (
        <div className="flex flex-col h-full bg-slate-50">
            <div className="h-16 px-4 bg-white border-b border-slate-200 flex items-center gap-2 shrink-0 z-10 shadow-sm">
                <button onClick={props.onBack} className="p-2 hover:bg-slate-100 rounded-full text-slate-500 transition-colors shrink-0" title="메인으로">
                    <ArrowLeft className="w-5 h-5" />
                </button>
                <span className="shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-md bg-accent-100 text-accent-700">
                    <Lightbulb className="w-4 h-4" />
                </span>
                <h2 className="font-bold text-slate-800 text-sm md:text-base whitespace-nowrap truncate">메모 활용</h2>
                {props.isFetchingAll && (
                    <span className="ml-1 flex items-center gap-1 text-[11px] text-slate-400"><Loader2 className="w-3.5 h-3.5 animate-spin" /> 예전 메모 불러오는 중</span>
                )}
            </div>

            <div className="bg-white border-b border-slate-100 shrink-0">
                <div className="max-w-3xl mx-auto px-3 py-2 flex gap-1.5 overflow-x-auto">
                    {TABS.map(t => (
                        <button key={t.key} onClick={() => setTab(t.key)}
                            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold border whitespace-nowrap transition-colors ${
                                tab === t.key ? 'bg-accent-50 border-accent-200 text-accent-700' : 'bg-white border-slate-200 text-slate-500 hover:text-slate-700'
                            }`}>
                            {t.icon}{t.label}
                        </button>
                    ))}
                </div>
            </div>

            <div className="flex-1 overflow-y-auto">
                <div className="max-w-3xl mx-auto p-4 md:p-6 pb-24">
                    {/* 탭은 숨기기만 해서 결과가 유지되게 함 */}
                    <div className={tab === 'weekly' ? '' : 'hidden'}><WeeklyTab {...studyProps} /></div>
                    <div className={tab === 'handover' ? '' : 'hidden'}><HandoverTab {...props} /></div>
                    <div className={tab === 'patients' ? '' : 'hidden'}><PatientsTab {...props} /></div>
                    <div className={tab === 'similar' ? '' : 'hidden'}><SimilarTab {...studyProps} /></div>
                    <div className={tab === 'gap' ? '' : 'hidden'}><GapTab {...studyProps} /></div>
                    <div className={tab === 'template' ? '' : 'hidden'}><TemplateTab {...props} active={tab === 'template'} /></div>
                    <div className={tab === 'cases' ? '' : 'hidden'}><CasesTab {...props} /></div>
                </div>
            </div>
        </div>
    );
};

export default InsightsView;
