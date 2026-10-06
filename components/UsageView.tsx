import React, { useEffect, useState } from 'react';
import { ArrowLeft, Loader2, RotateCw, Wallet } from 'lucide-react';
import { fetchRecentUsage, formatUsd, monthKeyOf, USAGE_FEATURE_LABELS, UsageFeature } from '../services/usageTracker';
import type { UsageMonth } from '../services/firebaseService';

// ============================================================================
// API 사용량 (§5-70): 이번 달 누적 추정 비용(기능별) + 최근 6개월. 달이 바뀌면 0부터
// ============================================================================

interface Props {
    onBack: () => void;
    liveMonthCost: number; // 이 기기에서 방금 쓴 몫까지 반영된 이번 달 합계
}

const monthLabel = (m: string) => {
    const [y, mo] = m.split('-');
    return `${y}년 ${Number(mo)}월`;
};
const fmtTok = (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : String(Math.round(v)));

const UsageView: React.FC<Props> = ({ onBack, liveMonthCost }) => {
    const [months, setMonths] = useState<UsageMonth[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    const load = async () => {
        setLoading(true);
        try {
            setMonths(await fetchRecentUsage(6));
            setError(null);
        } catch (e) {
            console.error(e);
            setError('사용량을 불러오지 못했습니다. 인터넷 연결을 확인해주세요.');
        } finally {
            setLoading(false);
        }
    };
    useEffect(() => { load(); }, []);

    const thisMonth = monthKeyOf();
    const cur = months?.find(m => m.month === thisMonth);
    // 클라우드 값과 이 기기의 실시간 합계 중 큰 쪽 (방금 쓴 몫이 아직 저장 중일 수 있음)
    const curCost = Math.max(cur?.cost || 0, liveMonthCost);
    const features = Object.entries(cur?.byFeature || {})
        .filter(([, v]) => v.cost > 0)
        .sort((a, b) => b[1].cost - a[1].cost);
    const maxFeature = features.length ? features[0][1].cost : 0;
    const maxMonth = Math.max(0.0001, ...(months || []).map(m => (m.month === thisMonth ? curCost : m.cost)));
    const day = new Date().getDate();
    const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();

    return (
        <div className="h-full flex flex-col bg-slate-50">
            <div className="h-12 px-2 bg-white border-b border-slate-100 flex items-center gap-1 flex-none">
                <button onClick={onBack} className="p-2 text-slate-500 hover:text-slate-800" title="뒤로"><ArrowLeft className="w-5 h-5" /></button>
                <h2 className="font-bold text-slate-800 flex items-center gap-1.5"><Wallet className="w-4 h-4 text-slate-400" /> API 사용량</h2>
                <button onClick={load} disabled={loading} className="ml-auto p-2 text-slate-400 hover:text-accent-700 disabled:opacity-50" title="새로고침">
                    {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCw className="w-4 h-4" />}
                </button>
            </div>

            <div className="flex-1 overflow-y-auto">
                <div className="max-w-2xl mx-auto p-4 md:p-6 space-y-4">
                    {/* 이번 달 */}
                    <div className="bg-white border border-slate-200 rounded-2xl p-5">
                        <p className="text-xs font-bold text-slate-400">{monthLabel(thisMonth)} 누적 (추정)</p>
                        <p className="text-3xl font-bold text-slate-900 mt-1">{formatUsd(curCost)}</p>
                        <p className="text-[11px] text-slate-400 mt-1">
                            {day}일째 / {daysInMonth}일 · 매월 1일에 0부터 다시 집계 (지난달 기록은 아래에 남음)
                        </p>
                        {cur && cur.calls > 0 && (
                            <p className="text-[11px] text-slate-500 mt-3 leading-relaxed">
                                AI 요청 {cur.calls}회 · 입력 {fmtTok(cur.inputTokens)} · 출력 {fmtTok(cur.outputTokens)}
                                {cur.cacheReadTokens > 0 && ` · 캐시 읽기 ${fmtTok(cur.cacheReadTokens)}`}
                                {cur.cacheWriteTokens > 0 && ` · 캐시 쓰기 ${fmtTok(cur.cacheWriteTokens)}`}
                                {cur.searches > 0 && ` · 웹 검색 ${cur.searches}회`}
                                {cur.embedTokens > 0 && ` · 임베딩 ${fmtTok(cur.embedTokens)}`}
                            </p>
                        )}
                    </div>

                    {/* 기능별 */}
                    <div className="bg-white border border-slate-200 rounded-2xl p-5">
                        <p className="text-xs font-bold text-slate-400 mb-3">이번 달 기능별</p>
                        {error ? (
                            <p className="text-sm text-red-500">{error}</p>
                        ) : months === null ? (
                            <p className="text-sm text-slate-400 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> 불러오는 중…</p>
                        ) : features.length === 0 ? (
                            <p className="text-sm text-slate-400">이번 달에 기록된 사용량이 아직 없어요.</p>
                        ) : (
                            <ul className="space-y-2.5">
                                {features.map(([k, v]) => (
                                    <li key={k}>
                                        <div className="flex items-baseline gap-2 text-[13px]">
                                            <span className="text-slate-700">{USAGE_FEATURE_LABELS[k as UsageFeature] || k}</span>
                                            <span className="text-[11px] text-slate-400">{v.calls}회</span>
                                            <span className="ml-auto font-bold text-slate-800">{formatUsd(v.cost)}</span>
                                        </div>
                                        <div className="mt-1 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                                            <div className="h-full rounded-full bg-accent-500" style={{ width: `${Math.max(2, (v.cost / maxFeature) * 100)}%` }} />
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>

                    {/* 최근 6개월 */}
                    {months && (
                        <div className="bg-white border border-slate-200 rounded-2xl p-5">
                            <p className="text-xs font-bold text-slate-400 mb-3">최근 6개월</p>
                            <ul className="space-y-2">
                                {months.map(m => {
                                    const c = m.month === thisMonth ? curCost : m.cost;
                                    return (
                                        <li key={m.month} className="flex items-center gap-3 text-[13px]">
                                            <span className={`w-20 shrink-0 ${m.month === thisMonth ? 'font-bold text-slate-800' : 'text-slate-500'}`}>{monthLabel(m.month)}</span>
                                            <div className="flex-1 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                                                <div className={`h-full rounded-full ${m.month === thisMonth ? 'bg-accent-500' : 'bg-slate-300'}`} style={{ width: `${c > 0 ? Math.max(2, (c / maxMonth) * 100) : 0}%` }} />
                                            </div>
                                            <span className="w-16 shrink-0 text-right text-slate-700">{c > 0 ? formatUsd(c) : '—'}</span>
                                        </li>
                                    );
                                })}
                            </ul>
                        </div>
                    )}

                    <div className="text-[11px] text-slate-400 leading-relaxed space-y-1 px-1">
                        <p>앱이 AI 응답마다 받은 토큰 수·웹 검색 횟수에 공개 요금표를 곱해 계산한 <b className="text-slate-500">추정치</b>입니다. 실제 청구 금액은 Anthropic Console(Claude)과 Voyage 대시보드가 기준입니다.</p>
                        <p>이 기능을 넣기 전의 사용량, 다른 앱·Claude 구독 사용량은 들어 있지 않습니다. 모든 기기의 사용량이 합쳐지며, 달은 이 기기의 날짜 기준입니다.</p>
                        <p>요금(100만 토큰당): Sonnet 5 입력 $2 · 출력 $10 · 캐시 읽기 $0.2 · 1시간 캐시 쓰기 $4 / Haiku 4.5 입력 $1 · 출력 $5 / 웹 검색 1회 $0.01 / Voyage 임베딩 $0.02.</p>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default UsageView;
