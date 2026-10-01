// ============================================================================
// AI 요약 이력: 요약을 새로 만들거나, 질문·추가 요청으로 다시 정리할 때마다 버전을 남김
// - 메모 문서(Firestore 한 문서, 최대 1MB) 안에 함께 저장되므로 개수·분량을 제한
//   (한국어는 글자당 약 3바이트 → 8만 자 ≈ 240KB)
// ============================================================================
import type { Note, Source, SummaryVersion } from '../types';

export const MAX_SUMMARY_HISTORY = 15;
export const MAX_SUMMARY_HISTORY_CHARS = 80000;

const newId = () => `sv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export const historyOf = (n: Pick<Note, 'summaryHistory'>): SummaryVersion[] =>
    Array.isArray(n.summaryHistory) ? n.summaryHistory : [];

// 오래된 것부터 버려서 개수·분량 한도 안으로 (가장 최신 1개는 항상 남김)
export const trimHistory = (list: SummaryVersion[]): SummaryVersion[] => {
    let out = list.slice(-MAX_SUMMARY_HISTORY);
    const size = (l: SummaryVersion[]) => l.reduce((s, v) => s + (v.summary || '').length + (v.request || '').length, 0);
    while (out.length > 1 && size(out) > MAX_SUMMARY_HISTORY_CHARS) out = out.slice(1);
    return out;
};

// 지금 요약이 이력에 없으면(이력 기능 전에 만든 요약 등) 이력에 먼저 넣어 둠 — 덮어써도 잃지 않게
export const archiveCurrentSummary = (n: Pick<Note, 'summary' | 'sources' | 'summaryKind' | 'summarizedAt' | 'updatedAt' | 'createdAt' | 'summaryHistory'>): SummaryVersion[] => {
    const list = historyOf(n);
    const cur = (n.summary || '').trim();
    if (!cur || list.some(v => (v.summary || '').trim() === cur)) return list;
    const legacy: SummaryVersion = {
        id: newId(),
        createdAt: n.summarizedAt || n.updatedAt || n.createdAt || Date.now(),
        summary: n.summary,
        sources: n.sources || [],
        ...(n.summaryKind ? { kind: n.summaryKind } : {}),
        mode: 'legacy'
    };
    return trimHistory([...list, legacy].sort((a, b) => a.createdAt - b.createdAt));
};

// 새로 만든 요약을 메모에 얹을 필드들 (요약 칸 + 이력)
export const summaryFieldsFor = (
    latest: Note,
    result: { summary: string; sources: Source[] },
    opts: { kind?: 'journal'; mode: SummaryVersion['mode']; request?: string; now?: number }
): Pick<Note, 'summary' | 'sources' | 'summarizedAt' | 'summaryKind' | 'summaryHistory'> => {
    const now = opts.now ?? Date.now();
    const entry: SummaryVersion = {
        id: newId(),
        createdAt: now,
        summary: result.summary,
        sources: result.sources || [],
        mode: opts.mode,
        // Firestore에 undefined 값이 들어가지 않도록 값이 있을 때만 넣음
        ...(opts.kind ? { kind: opts.kind } : {}),
        ...(opts.request?.trim() ? { request: opts.request.trim() } : {})
    };
    return {
        summary: result.summary,
        sources: result.sources || [],
        summarizedAt: now,
        summaryKind: opts.kind,
        summaryHistory: trimHistory([...archiveCurrentSummary(latest), entry])
    };
};

// 지금 요약에 이미 반영된 추가 요청들 (지금 요약과 같은 버전에서 거슬러 올라가며, 새 요약/저널클럽 분석을 만나면 멈춤)
export const requestChainFor = (n: Pick<Note, 'summary' | 'summaryHistory'>): string[] => {
    const list = historyOf(n);
    const cur = (n.summary || '').trim();
    let i = -1;
    for (let k = list.length - 1; k >= 0; k--) {
        if ((list[k].summary || '').trim() === cur) { i = k; break; }
    }
    const out: string[] = [];
    for (let k = i; k >= 0; k--) {
        const v = list[k];
        if (v.mode !== 'refine') break;
        if (v.request) out.unshift(v.request);
    }
    return out;
};

export const isCurrentVersion = (n: Pick<Note, 'summary'>, v: SummaryVersion) =>
    !!(n.summary || '').trim() && (n.summary || '').trim() === (v.summary || '').trim();

export const historyKey = (n: Pick<Note, 'summaryHistory'>) => historyOf(n).map(v => v.id).join(',');

export const MODE_LABELS: Record<SummaryVersion['mode'], string> = {
    new: 'AI 요약',
    journal: '저널클럽 분석',
    refine: '추가 요청 반영',
    legacy: '이전 요약'
};

// 데이터 정리(가져오기·동기화)용: 형식이 맞는 항목만
export const sanitizeHistory = (raw: any): SummaryVersion[] | undefined => {
    if (!Array.isArray(raw)) return undefined;
    const modes = ['new', 'journal', 'refine', 'legacy'];
    const list = raw
        .filter((v: any) => v && typeof v.id === 'string' && typeof v.summary === 'string' && typeof v.createdAt === 'number')
        .map((v: any): SummaryVersion => ({
            id: v.id,
            createdAt: v.createdAt,
            summary: v.summary,
            sources: Array.isArray(v.sources) ? v.sources : [],
            mode: modes.includes(v.mode) ? v.mode : 'legacy',
            ...(v.kind === 'journal' ? { kind: 'journal' as const } : {}),
            ...(typeof v.request === 'string' && v.request ? { request: v.request } : {})
        }));
    return list.length ? list : undefined;
};
