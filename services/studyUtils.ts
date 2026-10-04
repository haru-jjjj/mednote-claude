// ============================================================================
// 복습 일정(간격 반복) · 오답 노트 · 오래된 메모 점검 대상 판별 — API 호출 없는 순수 함수들
// ============================================================================
import type { Note, WrongAnswer, QuizQuestion } from '../types';

export const DAY_MS = 24 * 60 * 60 * 1000;

// 맞히면 간격이 약 2.5배씩 늘어나고(3 → 8 → 20 → 50 → 125 → 180일), 틀리면 다음 날 다시.
export const FIRST_INTERVAL_DAYS = 3;
export const MAX_INTERVAL_DAYS = 180;
export const INTERVAL_GROWTH = 2.5;
export const MAX_WRONG_PER_NOTE = 5;

// now 기준 "오늘 0시"에서 days일 뒤의 0시 (현지 시간, 서머타임이 있어도 날짜 단위로 정확)
export const localMidnightAfter = (now: number, days: number): number => {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + days);
    return d.getTime();
};

export const scheduleNextReview = (
    prevIntervalDays: number | undefined,
    correct: boolean,
    now: number
): { reviewIntervalDays: number; reviewDueAt: number; lastReviewedAt: number } => {
    const prev = typeof prevIntervalDays === 'number' && prevIntervalDays > 0 ? prevIntervalDays : 0;
    const interval = correct
        ? Math.min(MAX_INTERVAL_DAYS, Math.max(FIRST_INTERVAL_DAYS, Math.round(prev * INTERVAL_GROWTH)))
        : 1;
    return { reviewIntervalDays: interval, reviewDueAt: localMidnightAfter(now, interval), lastReviewedAt: now };
};

export const isReviewDue = (n: Pick<Note, 'reviewDueAt'>, now: number): boolean =>
    typeof n.reviewDueAt === 'number' && n.reviewDueAt <= now;

export const countDueNotes = (notes: Note[], now: number): number =>
    notes.reduce((c, n) => c + (isReviewDue(n, now) ? 1 : 0), 0);

// 퀴즈에 낼 수 있는 메모: 퀴즈에서 뺀 것 제외, 질문 노트는 답이 하나라도 있을 때만
export const isQuizEligible = (n: Note): boolean =>
    !n.quizExcluded && (n.kind !== 'thread' || /<!-- mt:a \d+ -->/.test(n.content || ''));

// ---------------------------------------------------------------------------
// 기간별 복습: 선택한 기간에 새로 쓰거나 내용을 고친 메모(질문 노트 포함)로만 출제
// ---------------------------------------------------------------------------
export type ReviewPeriod = 'today' | '1w' | '2w' | '1m' | '3m';
export const REVIEW_PERIODS: { key: ReviewPeriod; label: string; long: string; days: number }[] = [
    { key: 'today', label: '오늘', long: '오늘', days: 1 },
    { key: '1w', label: '1주', long: '최근 1주', days: 7 },
    { key: '2w', label: '2주', long: '최근 2주', days: 14 },
    { key: '1m', label: '1달', long: '최근 1달', days: 30 },
    { key: '3m', label: '3달', long: '최근 3달', days: 90 },
];
export const periodInfo = (p: ReviewPeriod | undefined) => REVIEW_PERIODS.find(x => x.key === p) || REVIEW_PERIODS[1];
// 기간 시작 = 오늘 0시에서 (일수-1)일 전 0시 (예: 1주 = 오늘 포함 7일)
export const periodStart = (p: ReviewPeriod, now: number): number => localMidnightAfter(now, -(periodInfo(p).days - 1));
// 내용을 쓰거나 고친 시각 (복습 일정·오답 같은 부가정보 변경은 포함하지 않음)
export const noteTouchedAt = (n: Pick<Note, 'createdAt' | 'updatedAt'>): number => Math.max(n.createdAt || 0, n.updatedAt || 0);
export const notesInPeriod = (notes: Note[], p: ReviewPeriod, now: number): Note[] => {
    const start = periodStart(p, now);
    return notes.filter(n => isQuizEligible(n) && noteTouchedAt(n) >= start);
};

// 퀴즈 출제 가중치: 복습일이 된 메모 > 아직 한 번도 안 푼 메모 > 복습일이 아직 안 된 메모
export const quizPickWeight = (n: Note, now: number): number => {
    if (isReviewDue(n, now)) return 4;
    if (typeof n.reviewDueAt === 'number') return 0.2;
    return 1 / ((n.quizMasteryCount || 0) + 1);
};

// ---------------------------------------------------------------------------
// 오답 노트
// ---------------------------------------------------------------------------
export const wrongAnswerFromQuestion = (
    q: QuizQuestion,
    chosenIndex: number,
    now: number,
    language?: WrongAnswer['language']
): WrongAnswer => ({
    id: q.id,
    type: q.type,
    question: q.question,
    options: q.options,
    correctAnswerIndex: q.correctAnswerIndex,
    chosenIndex,
    explanation: q.explanation,
    sources: q.sources || [],
    relatedNoteIds: q.relatedNoteIds || [],
    language,
    wrongAt: now,
    wrongCount: 1
});

// 같은 문제를 또 틀리면 횟수만 늘리고 맨 앞으로. 메모당 최근 MAX개까지만 보관.
export const upsertWrongAnswer = (list: WrongAnswer[] | undefined, entry: WrongAnswer, max = MAX_WRONG_PER_NOTE): WrongAnswer[] => {
    const cur = Array.isArray(list) ? list : [];
    const existing = cur.find(w => w.id === entry.id);
    const merged: WrongAnswer = existing
        ? { ...existing, chosenIndex: entry.chosenIndex, wrongAt: entry.wrongAt, wrongCount: (existing.wrongCount || 1) + 1 }
        : entry;
    return [merged, ...cur.filter(w => w.id !== entry.id)].slice(0, max);
};

export const removeWrongAnswer = (list: WrongAnswer[] | undefined, id: string): WrongAnswer[] =>
    (Array.isArray(list) ? list : []).filter(w => w.id !== id);

export interface WrongAnswerWithNote extends WrongAnswer {
    noteId: string; // 이 오답이 저장된 메모
    noteTitle: string;
}

export const collectWrongAnswers = (notes: Note[]): WrongAnswerWithNote[] => {
    const seen = new Set<string>();
    const out: WrongAnswerWithNote[] = [];
    notes.forEach(n => {
        (n.wrongAnswers || []).forEach(w => {
            if (!w || !w.id || seen.has(w.id)) return;
            seen.add(w.id);
            out.push({ ...w, noteId: n.id, noteTitle: n.title || '(제목 없음)' });
        });
    });
    return out.sort((a, b) => (b.wrongAt || 0) - (a.wrongAt || 0));
};

export const questionFromWrongAnswer = (w: WrongAnswerWithNote): QuizQuestion => ({
    id: w.id,
    type: w.type,
    question: w.question,
    options: w.options,
    correctAnswerIndex: w.correctAnswerIndex,
    explanation: w.explanation,
    sources: w.sources || [],
    relatedNoteIds: w.relatedNoteIds && w.relatedNoteIds.length > 0 ? w.relatedNoteIds : [w.noteId],
    replayOfNoteId: w.noteId
});

// ---------------------------------------------------------------------------
// 오래된 메모 가이드라인 점검 대상
// - 마지막 수정이 1년 이상 지났고, 환자 메모가 아니며,
// - 수치(단위·부등호가 붙은 숫자)나 권고 관련 표현이 들어 있는 메모
// ---------------------------------------------------------------------------
export const GUIDELINE_STALE_DAYS = 365;

const NUMERIC_RE = /(?:[<>≤≥]=?\s*\d)|(?:\d+(?:\.\d+)?\s*(?:%|mg|mcg|μg|ug|mmHg|mmol|mEq|mL|ml|ms|mm|cm|bpm|kg|ng|pg|IU|U\/L|g\/dL|J\b|V\b|점|회|개월|주))/gi;
const RECOMMENDATION_RE = /guideline|가이드라인|권고|recommend|\bclass\s*(?:I{1,3}|IIa|IIb|1|2a|2b|3)\b|\bCOR\b|\bLOE\b|indicat|적응증|금기|contraindicat|target|목표|cut-?off|threshold|first-?line|1차\s*치료|용량|dose/gi;

export const guidelineSignals = (text: string): { numeric: number; recommendation: number } => {
    const t = text || '';
    return {
        numeric: (t.match(NUMERIC_RE) || []).length,
        recommendation: (t.match(RECOMMENDATION_RE) || []).length
    };
};

export const noteAgeDays = (n: Pick<Note, 'updatedAt' | 'createdAt'>, now: number): number =>
    Math.floor((now - (n.updatedAt || n.createdAt || now)) / DAY_MS);

export const isGuidelineCheckCandidate = (n: Note, now: number): boolean => {
    // 환자 메모, AI 결과 메모, '업무'만 붙은 메모(인계 사항 등)는 제외
    if (n.tag === 'patient' || n.origin === 'ai' || (n.work && n.tag !== 'memo')) return false;
    if (noteAgeDays(n, now) < GUIDELINE_STALE_DAYS) return false;
    const { numeric, recommendation } = guidelineSignals(`${n.content || ''}\n${n.transcription || ''}`);
    return numeric >= 2 || (numeric >= 1 && recommendation >= 1);
};

// "1년 3개월 전" 같은 대략적 표현
export const formatAge = (days: number): string => {
    if (days < 30) return `${days}일 전`;
    const months = Math.round(days / 30.44);
    const y = Math.floor(months / 12);
    const m = months % 12;
    if (y === 0) return `${m}개월 전`;
    return m === 0 ? `${y}년 전` : `${y}년 ${m}개월 전`;
};

// ---------------------------------------------------------------------------
// 논문(초록/본문)을 붙여넣은 메모인지 대략 판별 → 저널클럽 준비 안내 카드 표시용
// ---------------------------------------------------------------------------
const PAPER_MARKERS: RegExp[] = [
    /\babstract\b/i, /\bbackground\b/i, /\bmethods?\b/i, /\bresults?\b/i, /\bconclusions?\b/i,
    /randomi[sz]ed/i, /hazard ratio|\bHR\b\s*[,:=]?\s*\d/i, /95%\s*(?:CI|confidence interval)|confidence interval/i,
    /\bdoi\b|doi\.org/i, /\bet al\b/i, /primary (?:end ?point|outcome)/i, /\bP\s*[<=]\s*0?\.\d/i
];

export const looksLikePaper = (text: string): boolean => {
    const t = (text || '').slice(0, 20000);
    if (t.length < 400) return false;
    return PAPER_MARKERS.reduce((c, re) => c + (re.test(t) ? 1 : 0), 0) >= 4;
};
