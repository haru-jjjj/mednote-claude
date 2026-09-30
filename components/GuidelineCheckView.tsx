import React, { useMemo, useState } from 'react';
import { ArrowLeft, ShieldCheck, Loader2, ChevronRight } from 'lucide-react';
import { Note } from '../types';
import { isGuidelineCheckCandidate, guidelineSignals, noteAgeDays, formatAge, GUIDELINE_STALE_DAYS } from '../services/studyUtils';

// ============================================================================
// 오래된 메모 가이드라인 점검
// - 1년 넘게 수정하지 않은 메모 중 수치·권고가 들어 있는 메모를 모아 보여줍니다.
// - 점검은 메모마다 버튼을 눌렀을 때만 실행됩니다(웹 검색 포함 유료 호출이라 자동 실행 안 함).
// - 결과는 메모에 저장되어 메모 화면과 목록(⚠️ 표시)에서도 보입니다.
// ============================================================================

interface Props {
    notes: Note[];
    checkingIds: string[];
    onCheck: (id: string) => void;
    onOpenNote: (id: string) => void;
    onBack: () => void;
    isFetchingAll?: boolean;
    filter: Filter;
    onFilterChange: (f: Filter) => void;
}

type Filter = 'todo' | 'changed' | 'all';
const PAGE = 30;

// 보고서 첫 줄(한 줄 결론)만 미리보기로
const firstLine = (report: string): string => {
    const line = (report || '').split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#')) || '';
    const plain = line.replace(/[*_`>#]/g, '').replace(/^-\s*/, '');
    return plain.length > 120 ? plain.slice(0, 120) + '…' : plain;
};

const GuidelineCheckView: React.FC<Props> = ({ notes, checkingIds, onCheck, onOpenNote, onBack, isFetchingAll, filter, onFilterChange }) => {
    const [visible, setVisible] = useState(PAGE);

    const now = Date.now();
    const { candidates, changed, todo } = useMemo(() => {
        const t = Date.now();
        const cands = notes.filter(n => isGuidelineCheckCandidate(n, t) || !!n.guidelineCheck);
        const chg = cands.filter(n => n.guidelineCheck?.status === 'changed');
        const td = cands.filter(n => !n.guidelineCheck && isGuidelineCheckCandidate(n, t));
        return { candidates: cands, changed: chg, todo: td };
    }, [notes]);

    const list = useMemo(() => {
        const base = filter === 'todo' ? todo : filter === 'changed' ? changed : candidates;
        const age = (n: Note) => n.updatedAt || n.createdAt || 0;
        return [...base].sort((a, b) => {
            if (filter === 'changed') return (b.guidelineCheck?.checkedAt || 0) - (a.guidelineCheck?.checkedAt || 0);
            // 점검 전 메모를 먼저, 그 안에서는 오래된 메모부터
            const ac = a.guidelineCheck ? 1 : 0, bc = b.guidelineCheck ? 1 : 0;
            if (ac !== bc) return ac - bc;
            return age(a) - age(b);
        });
    }, [filter, todo, changed, candidates]);

    const chip = (f: Filter, label: string, count: number, activeClass: string) => (
        <button
            key={f}
            type="button"
            onClick={() => { onFilterChange(f); setVisible(PAGE); }}
            className={`px-3 py-1 rounded-full text-xs font-bold border transition-colors whitespace-nowrap ${
                filter === f ? activeClass : 'bg-white border-slate-200 text-slate-400 hover:text-slate-600'
            }`}
        >
            {label} {count}
        </button>
    );

    return (
        <div className="h-full flex flex-col bg-slate-50">
            <div className="h-12 px-3 bg-white border-b border-slate-100 flex items-center gap-2 flex-none">
                <button onClick={onBack} className="p-2 text-slate-500 hover:text-slate-800" title="목록으로">
                    <ArrowLeft className="w-5 h-5" />
                </button>
                <ShieldCheck className="w-5 h-5 text-emerald-600" />
                <h2 className="font-bold text-slate-800">오래된 메모 점검</h2>
                {isFetchingAll && <span className="ml-1 flex items-center gap-1 text-[11px] text-slate-400"><Loader2 className="w-4 h-4 text-slate-300 animate-spin" /> 예전 메모 불러오는 중</span>}
            </div>

            <div className="flex-1 overflow-y-auto">
                <div className="max-w-3xl mx-auto p-4 md:p-6 pb-24">
                    <div className="bg-white border border-slate-200 rounded-xl p-4 mb-4 text-sm text-slate-600 leading-relaxed">
                        {Math.round(GUIDELINE_STALE_DAYS / 365)}년 넘게 수정하지 않은 메모 중 <b>수치·권고</b>(기준값, 목표치, 용량, 기간, 권고 등급 등)가 들어 있는 메모입니다.
                        <b> 점검</b>을 누른 메모만 최신 가이드라인·연구와 비교해 바뀐 내용을 ⚠️로 표시합니다.
                        <span className="block text-xs text-slate-400 mt-1">
                            메모 1개당 약 100~200원(웹 검색 포함). 결과는 메모에 저장되어 모든 기기에서 보이고, 메모 화면에서도 언제든 점검할 수 있습니다. 환자 메모는 제외됩니다.
                        </span>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5 mb-3">
                        {chip('todo', '점검 전', todo.length, 'bg-emerald-50 border-emerald-200 text-emerald-700')}
                        {chip('changed', '⚠️ 바뀐 내용 있음', changed.length, 'bg-amber-50 border-amber-200 text-amber-700')}
                        {chip('all', '전체', candidates.length, 'bg-slate-100 border-slate-300 text-slate-700')}
                    </div>

                    {list.length === 0 ? (
                        <div className="text-center text-sm text-slate-400 py-16">
                            {filter === 'todo' ? '점검할 오래된 메모가 없습니다.' : filter === 'changed' ? '아직 바뀐 내용이 발견된 메모가 없습니다.' : '대상 메모가 없습니다.'}
                        </div>
                    ) : (
                        <div className="space-y-2">
                            {list.slice(0, visible).map(n => {
                                const checking = checkingIds.includes(n.id);
                                const gc = n.guidelineCheck;
                                const sig = guidelineSignals(`${n.content || ''}\n${n.transcription || ''}`);
                                return (
                                    <div key={n.id} className="bg-white border border-slate-200 rounded-xl p-3 flex items-start gap-3">
                                        <button type="button" onClick={() => onOpenNote(n.id)} className="flex-1 min-w-0 text-left group">
                                            <div className="flex items-center gap-1 text-sm font-bold text-slate-800 group-hover:text-blue-600">
                                                <span className="truncate">{n.title || '(제목 없음)'}</span>
                                                <ChevronRight className="w-3.5 h-3.5 shrink-0 text-slate-300 group-hover:text-blue-500" />
                                            </div>
                                            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-400 mt-0.5">
                                                <span>{formatAge(noteAgeDays(n, now))} 수정</span>
                                                <span>수치 {sig.numeric} · 권고 표현 {sig.recommendation}</span>
                                                {gc && (
                                                    <span className={`font-bold ${gc.status === 'changed' ? 'text-amber-600' : gc.status === 'ok' ? 'text-emerald-600' : 'text-slate-500'}`}>
                                                        {gc.status === 'changed' ? '⚠️ 바뀐 내용 있음' : gc.status === 'ok' ? '✅ 일치' : '❔ 확인 어려움'}
                                                        {' · '}{new Date(gc.checkedAt).toLocaleDateString()}
                                                    </span>
                                                )}
                                            </div>
                                            {gc && firstLine(gc.report) && (
                                                <p className="text-xs text-slate-500 mt-1 line-clamp-2">{firstLine(gc.report)}</p>
                                            )}
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => onCheck(n.id)}
                                            disabled={checking}
                                            className={`shrink-0 px-3 py-1.5 rounded-lg text-xs font-bold border transition-colors disabled:opacity-60 flex items-center gap-1 ${
                                                gc ? 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50' : 'bg-emerald-600 border-emerald-600 text-white hover:bg-emerald-700'
                                            }`}
                                        >
                                            {checking && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                                            {checking ? '점검 중' : gc ? '다시 점검' : '점검'}
                                        </button>
                                    </div>
                                );
                            })}
                            {list.length > visible && (
                                <button type="button" onClick={() => setVisible(v => v + PAGE)} className="w-full py-2 text-xs font-bold text-slate-500 hover:text-slate-700">
                                    더 보기 ({list.length - visible}개 더)
                                </button>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default GuidelineCheckView;
