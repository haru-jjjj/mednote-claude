// ============================================================================
// API 사용량 추정 (§5-70)
// - Claude 응답마다 오는 usage(입력·출력·캐시 토큰, 웹 검색 횟수)와 Voyage 임베딩 토큰으로 비용을 계산해 월별로 누적
// - 월 = 이 기기 시간 기준 YYYY-MM. 달이 바뀌면 새 문서라 0부터 다시 (지난달 기록은 남아 비교용으로 보임)
// - 앱이 계산한 "추정치" — 실제 청구는 Anthropic Console·Voyage 대시보드가 기준
// ============================================================================
import { addUsageToFirestore, fetchUsageMonth, UsageMonth } from './firebaseService';

export type UsageFeature =
    | 'thread' | 'threadTitle' | 'quiz' | 'summary' | 'study' | 'ask' | 'imageText'
    | 'guideline' | 'insights' | 'pdf' | 'embedding' | 'other';

export const USAGE_FEATURE_LABELS: Record<UsageFeature, string> = {
    thread: '질문 노트 답변',
    threadTitle: '질문 노트 제목',
    quiz: 'AI 퀴즈',
    summary: 'AI 요약·저널클럽',
    study: 'AI 주제 탐구(삭제된 기능)',
    ask: '내 메모에 물어보기',
    imageText: '사진 글자 읽기',
    guideline: '가이드라인 점검',
    insights: '메모 활용(이번 주·인계장 등)',
    pdf: 'PDF 자료 OX·글자 읽기',
    embedding: '검색용 임베딩(Voyage)',
    other: '기타',
};

// 가격 (USD / 100만 토큰) — https://platform.claude.com/docs/en/about-claude/pricing
// 캐시: 5분 쓰기 1.25배, 1시간 쓰기 2배, 읽기 0.1배(Sonnet 5.5는 0.05배)
type Price = { input: number; output: number; write5m: number; write1h: number; read: number };
const PRICES: Record<string, Price> = {
    sonnet5: { input: 2, output: 10, write5m: 2.5, write1h: 4, read: 0.2 },
    sonnet55: { input: 2, output: 10, write5m: 2.5, write1h: 4, read: 0.1 },
    haiku45: { input: 1, output: 5, write5m: 1.25, write1h: 2, read: 0.1 },
    // Haiku 5.5는 프롬프트(입력+캐시) 10만 토큰을 넘으면 비싼 요금
    haiku55: { input: 0.1, output: 0.5, write5m: 0.125, write1h: 0.2, read: 0.01 },
    haiku55Long: { input: 0.5, output: 2.5, write5m: 0.625, write1h: 1, read: 0.05 },
};
const WEB_SEARCH_USD = 10 / 1000; // 검색 1회
const VOYAGE_USD_PER_M = 0.02; // voyage-4-lite (무료 제공량이 있으면 실제 청구는 더 적음)

// 모르는 모델은 비싼 쪽(Sonnet)으로
const priceOf = (model: string, promptTokens: number): Price => {
    const m = (model || '').toLowerCase();
    if (m.includes('haiku-5-5')) return promptTokens > 100000 ? PRICES.haiku55Long : PRICES.haiku55;
    if (m.includes('haiku')) return PRICES.haiku45;
    if (m.includes('sonnet-5-5')) return PRICES.sonnet55;
    return PRICES.sonnet5;
};

export const monthKeyOf = (t: number = Date.now()) => {
    const d = new Date(t);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

const n = (v: any) => (typeof v === 'number' && isFinite(v) && v > 0 ? v : 0);

// Claude usage → 비용·토큰 (캐시 쓰기는 5분/1시간 구분이 있으면 그대로, 없으면 1시간으로 — 이 앱의 캐시는 1시간)
export const costOfClaudeUsage = (model: string, usage: any) => {
    const input = n(usage?.input_tokens);
    const output = n(usage?.output_tokens);
    const read = n(usage?.cache_read_input_tokens);
    const w5 = n(usage?.cache_creation?.ephemeral_5m_input_tokens);
    const w1h = n(usage?.cache_creation?.ephemeral_1h_input_tokens);
    const wTotal = n(usage?.cache_creation_input_tokens);
    const write5m = w5;
    const write1h = w5 || w1h ? w1h : wTotal;
    const searches = n(usage?.server_tool_use?.web_search_requests);
    const p = priceOf(model, input + read + write5m + write1h);
    const cost = (input * p.input + output * p.output + read * p.read + write5m * p.write5m + write1h * p.write1h) / 1e6
        + searches * WEB_SEARCH_USD;
    return { cost, input, output, cacheWrite: write5m + write1h, cacheRead: read, searches };
};

// ---------------------------------------------------------------------------
// 이번 달 합계 (사이드바 표시용): 앱 시작 시 클라우드에서 읽고, 이후 이 기기에서 쓴 만큼 더함
// ---------------------------------------------------------------------------
let current: { month: string; cost: number; loaded: boolean } = { month: monthKeyOf(), cost: 0, loaded: false };
const listeners = new Set<(cost: number) => void>();
const emit = () => listeners.forEach(fn => fn(current.cost));

// 달이 바뀌었으면 이번 달 합계를 0부터 (사이드바 숫자도 바로 0으로)
const rollMonth = () => {
    const m = monthKeyOf();
    if (current.month !== m) { current = { month: m, cost: 0, loaded: false }; emit(); loadCurrentMonthUsage(); }
};
export const checkMonthRollover = () => rollMonth();

export const loadCurrentMonthUsage = async (): Promise<void> => {
    const m = monthKeyOf();
    try {
        const doc = await fetchUsageMonth(m);
        if (current.month !== m) return;
        // 읽는 사이 이 기기에서 더한 몫은 클라우드 값에 이미 들어갔을 수 있어, 큰 쪽을 씀
        current = { month: m, cost: Math.max(doc?.cost || 0, current.cost), loaded: true };
        emit();
    } catch (e) {
        console.warn('사용량 불러오기 실패', e);
    }
};

export const subscribeMonthCost = (fn: (cost: number) => void): (() => void) => {
    listeners.add(fn);
    rollMonth();
    fn(current.cost);
    return () => { listeners.delete(fn); };
};

const add = (feature: UsageFeature, delta: Omit<Parameters<typeof addUsageToFirestore>[1], 'feature'>) => {
    if (!(delta.cost > 0)) return;
    rollMonth();
    current.cost += delta.cost;
    emit();
    addUsageToFirestore(current.month, { ...delta, feature }).catch(e => console.warn('사용량 저장 실패', e));
};

export const recordClaudeUsage = (model: string, usage: any, feature: UsageFeature = 'other') => {
    if (!usage) return;
    const c = costOfClaudeUsage(model, usage);
    add(feature, {
        cost: c.cost, inputTokens: c.input, outputTokens: c.output, cacheWriteTokens: c.cacheWrite,
        cacheReadTokens: c.cacheRead, searches: c.searches, embedTokens: 0,
    });
};

export const recordEmbeddingUsage = (tokens: number) => {
    const t = n(tokens);
    if (!t) return;
    add('embedding', {
        cost: (t * VOYAGE_USD_PER_M) / 1e6, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0,
        cacheReadTokens: 0, searches: 0, embedTokens: t,
    });
};

// 최근 N개월 (이번 달 포함, 기록 없는 달은 빈 값)
export const fetchRecentUsage = async (months = 6): Promise<UsageMonth[]> => {
    const now = new Date();
    const keys: string[] = [];
    for (let i = 0; i < months; i++) keys.push(monthKeyOf(new Date(now.getFullYear(), now.getMonth() - i, 15).getTime()));
    const list = await Promise.all(keys.map(k => fetchUsageMonth(k).catch(() => null)));
    return keys.map((k, i) => list[i] || {
        month: k, cost: 0, calls: 0, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0,
        searches: 0, embedTokens: 0, byFeature: {},
    });
};

export const formatUsd = (v: number) => (v >= 10 ? `$${v.toFixed(1)}` : v >= 0.01 || v === 0 ? `$${v.toFixed(2)}` : '<$0.01');
