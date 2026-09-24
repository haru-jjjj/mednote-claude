import React, { useState } from 'react';
import { ArrowLeft, MessageSquareText, Loader2, Search, FileStack, AlertTriangle, Save, RefreshCw, Check } from 'lucide-react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { v4 as uuidv4 } from 'uuid';
import { Note } from '../types';
import { answerFromNotes, synthesizeNotes, formatMedicalMarkdown } from '../services/claudeService';
import { getNoteFromDB } from '../services/storage';
import { cosineSimilarity, embedTexts, hasVoyageApiKey } from '../services/voyageService';

interface AskNotesViewProps {
    notes: Note[];
    onBack: () => void;
    onSelectNote: (id: string) => void;
    onSaveNewNote: (note: Note) => Promise<void>;
}

type Mode = 'ask' | 'synthesize';

// 관련 메모 찾기 설정
const SIM_THRESHOLD = 0.3;
const MAX_NOTES: Record<Mode, number> = { ask: 8, synthesize: 12 };

// 임베딩이 없거나 Voyage 키가 없을 때의 대체 검색: 단어가 제목/본문에 몇 번 등장하는지로 순위
const keywordRank = (query: string, notes: Note[], limit: number): Note[] => {
    // 한국어 조사(에서, 으로, 는 ...)가 붙은 채로는 본문과 잘 안 맞아서 끝의 조사를 떼고 비교
    const stripParticle = (t: string) => {
        const stripped = t.replace(/(에서|에게|으로|이랑|하고|까지|부터|로|은|는|이|가|을|를|의|와|과|도|에|랑)$/, '');
        return stripped.length >= 2 ? stripped : t;
    };
    const terms = query.toLowerCase().split(/[\s,./()?!]+/).map(stripParticle).filter(t => t.length >= 2);
    if (terms.length === 0) return [];
    return notes
        .map(n => {
            const title = (n.title || '').toLowerCase();
            const body = `${n.content || ''} ${n.summary || ''} ${n.transcription || ''}`.toLowerCase();
            const score = terms.reduce((s, t) => s + (title.includes(t) ? 3 : 0) + (body.includes(t) ? 1 : 0), 0);
            return { n, score };
        })
        .filter(r => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(r => r.n);
};

const AskNotesView: React.FC<AskNotesViewProps> = ({ notes, onBack, onSelectNote, onSaveNewNote }) => {
    const [query, setQuery] = useState('');
    const [mode, setMode] = useState<Mode>('ask');
    const [isSearching, setIsSearching] = useState(false);
    const [isGenerating, setIsGenerating] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // 검색으로 찾은 후보 메모와, 그중 체크된(실제로 AI에 보낼) 메모
    const [foundNotes, setFoundNotes] = useState<Note[]>([]);
    const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
    // 마지막으로 결과를 만들 때 실제로 보낸 메모 (결과의 [메모1], [메모2] 번호가 이 순서와 대응)
    const [usedNotes, setUsedNotes] = useState<Note[]>([]);
    const [resultMarkdown, setResultMarkdown] = useState('');
    const [resultMode, setResultMode] = useState<Mode>('ask');
    const [resultQuery, setResultQuery] = useState('');
    const [savedNoteId, setSavedNoteId] = useState<string | null>(null);
    const [isSaving, setIsSaving] = useState(false);
    const [searchInfo, setSearchInfo] = useState('');

    const busy = isSearching || isGenerating;
    const selectionChanged =
        usedNotes.length > 0 &&
        (usedNotes.length !== checkedIds.size || usedNotes.some(n => !checkedIds.has(n.id)));

    const findRelatedNotes = async (q: string, m: Mode): Promise<{ list: Note[]; how: string }> => {
        const limit = MAX_NOTES[m];
        const withEmb = notes.filter(n => n.embedding && n.embedding.length > 0);

        let ranked: Note[] = [];
        let how = '';
        if (hasVoyageApiKey() && withEmb.length > 0) {
            try {
                const [qv] = await embedTexts([q], 'query');
                if (qv) {
                    ranked = withEmb
                        .map(n => ({ n, sim: cosineSimilarity(qv, n.embedding) }))
                        .filter(r => r.sim >= SIM_THRESHOLD)
                        .sort((a, b) => b.sim - a.sim)
                        .slice(0, limit)
                        .map(r => r.n);
                    how = '의미 기반 검색';
                }
            } catch (e) {
                console.warn('임베딩 검색 실패, 키워드 검색으로 대체:', e);
            }
        }
        if (ranked.length === 0) {
            ranked = keywordRank(q, notes, limit);
            how = '키워드 검색';
        }

        // 목록용 데이터는 사진 등이 빠진 가벼운 버전일 수 있어, 전체 내용으로 다시 불러옴
        const hydrated: Note[] = [];
        for (const n of ranked) {
            try {
                hydrated.push((await getNoteFromDB(n.id)) || n);
            } catch {
                hydrated.push(n);
            }
        }
        return { list: hydrated, how };
    };

    const generate = async (targetNotes: Note[], m: Mode, q: string) => {
        setIsGenerating(true);
        setError(null);
        setSavedNoteId(null);
        try {
            const text = m === 'ask' ? await answerFromNotes(q, targetNotes) : await synthesizeNotes(q, targetNotes);
            setUsedNotes(targetNotes);
            setResultMarkdown(text);
            setResultMode(m);
            setResultQuery(q);
        } catch (e: any) {
            console.error(e);
            setError(e?.message || '알 수 없는 오류가 발생했습니다.');
        } finally {
            setIsGenerating(false);
        }
    };

    const handleRun = async (m: Mode) => {
        const q = query.trim();
        if (!q || busy) return;
        setMode(m);
        setError(null);
        setResultMarkdown('');
        setUsedNotes([]);
        setIsSearching(true);
        let list: Note[] = [];
        try {
            const res = await findRelatedNotes(q, m);
            list = res.list;
            setSearchInfo(res.how);
            setFoundNotes(list);
            setCheckedIds(new Set(list.map(n => n.id)));
        } finally {
            setIsSearching(false);
        }
        if (list.length === 0) {
            setError('관련된 메모를 찾지 못했어요. 다른 표현으로 입력해보세요.');
            return;
        }
        await generate(list, m, q);
    };

    const handleRegenerate = async () => {
        const selected = foundNotes.filter(n => checkedIds.has(n.id));
        if (selected.length === 0 || busy) return;
        await generate(selected, mode, resultQuery || query.trim());
    };

    const toggleChecked = (id: string) => {
        setCheckedIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    };

    const handleSaveAsNote = async () => {
        if (!resultMarkdown || savedNoteId || isSaving) return;
        setIsSaving(true);
        const refs = usedNotes.map((n, i) => `- [메모${i + 1}] ${n.title || '제목 없음'}`).join('\n');
        const now = Date.now();
        const newNote: Note = {
            id: uuidv4(),
            title: `정리: ${resultQuery}`.slice(0, 60),
            content: `${resultMarkdown}\n\n---\n\n**참고한 메모**\n\n${refs}`,
            summary: '',
            createdAt: now,
            updatedAt: now,
            sources: [],
            images: [],
            isEnhancing: false,
            isProcessed: false,
        };
        try {
            await onSaveNewNote(newNote);
            setSavedNoteId(newNote.id);
        } catch (e: any) {
            setError(e?.message || '메모 저장에 실패했습니다.');
        } finally {
            setIsSaving(false);
        }
    };

    // 결과 렌더링: 마크다운 → HTML, 그리고 [메모1] 같은 인용 표시를 누르면 해당 메모로 이동하도록 링크화.
    // (메모 안 결과지 번호 [1], [2] 와 구분되는 전용 형식만 링크로 바꿉니다. 코드 블록 안은 제외.)
    const renderResult = (): { __html: string } => {
        try {
            const html = DOMPurify.sanitize(marked.parse(formatMedicalMarkdown(resultMarkdown), { breaks: false, gfm: true }) as string);
            const linkify = (chunk: string) => chunk.replace(
                /\[메모\s?(\d{1,2})((?:\s*[,·]\s*(?:메모\s?)?\d{1,2})*)\]/g,
                (all: string, firstNum: string, rest: string) => {
                    const nums = [firstNum, ...(rest.match(/\d{1,2}/g) || [])].map(Number);
                    if (nums.some(n => n < 1 || n > usedNotes.length)) return all;
                    return nums.map(n =>
                        `<a data-note-ref="${n}" class="text-indigo-600 font-semibold no-underline cursor-pointer hover:underline whitespace-nowrap">[메모${n}]</a>`
                    ).join('');
                }
            );
            // <pre>/<code> 안과 태그 속성은 건드리지 않도록, 태그 바깥 텍스트에만 적용
            let inCode = 0;
            const linked = html.split(/(<[^>]+>)/g).map(part => {
                if (part.startsWith('<')) {
                    if (/^<(pre|code)[\s>]/i.test(part)) inCode++;
                    else if (/^<\/(pre|code)>/i.test(part)) inCode = Math.max(0, inCode - 1);
                    return part;
                }
                return inCode > 0 ? part : linkify(part);
            }).join('');
            return { __html: linked };
        } catch {
            return { __html: DOMPurify.sanitize(resultMarkdown) };
        }
    };

    const handleResultClick = (e: React.MouseEvent) => {
        const target = (e.target as HTMLElement).closest('[data-note-ref]');
        if (!target) return;
        const idx = Number(target.getAttribute('data-note-ref'));
        const n = usedNotes[idx - 1];
        if (n) onSelectNote(n.id);
    };

    const usedIndexOf = (id: string) => usedNotes.findIndex(n => n.id === id);

    return (
        <div className="flex flex-col h-full bg-slate-50">
            {/* 헤더 */}
            <div className="h-16 px-4 bg-white border-b border-slate-200 flex items-center gap-2 shrink-0 z-10 shadow-sm">
                <button onClick={onBack} className="p-2 hover:bg-slate-100 rounded-full text-slate-500 transition-colors shrink-0" title="메인으로">
                    <ArrowLeft className="w-5 h-5" />
                </button>
                <span className="shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-md bg-indigo-100 text-indigo-600">
                    <MessageSquareText className="w-4 h-4" />
                </span>
                <h2 className="font-bold text-slate-800 text-sm md:text-base whitespace-nowrap truncate">내 메모에 물어보기</h2>
            </div>

            <div className="flex-1 overflow-y-auto">
                <div className="max-w-3xl mx-auto p-4 md:p-6 pb-24 space-y-4">
                    {/* 입력 */}
                    <div className="bg-white border border-slate-200 rounded-xl p-3 shadow-sm">
                        <textarea
                            value={query}
                            onChange={e => setQuery(e.target.value)}
                            onKeyDown={e => {
                                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); handleRun('ask'); }
                            }}
                            rows={2}
                            placeholder="질문이나 주제를 입력하세요 (예: CRT-D에서 LV threshold가 올랐을 때 확인할 것 / persistent AF ablation 전략)"
                            className="w-full resize-none outline-none text-sm text-slate-800 placeholder:text-slate-300 leading-relaxed"
                        />
                        <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-100">
                            <button
                                onClick={() => handleRun('ask')}
                                disabled={!query.trim() || busy}
                                className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                            >
                                {busy && mode === 'ask' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
                                질문하기
                            </button>
                            <button
                                onClick={() => handleRun('synthesize')}
                                disabled={!query.trim() || busy}
                                className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-white border border-indigo-200 text-indigo-600 hover:bg-indigo-50 text-xs font-bold whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                            >
                                {busy && mode === 'synthesize' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileStack className="w-3.5 h-3.5" />}
                                정리본 만들기
                            </button>
                            <span className="text-[11px] text-slate-400 leading-snug">
                                질문하기: 내 메모를 근거로 답변 · 정리본: 관련 메모를 한 노트로 통합
                            </span>
                        </div>
                    </div>

                    {/* 상태 */}
                    {isSearching && (
                        <div className="flex items-center gap-2 text-xs text-slate-500 px-1">
                            <Loader2 className="w-3.5 h-3.5 animate-spin" /> 관련 메모 찾는 중…
                        </div>
                    )}

                    {/* 찾은 메모 (체크 해제하면 다음 생성에서 제외) */}
                    {foundNotes.length > 0 && (
                        <div className="bg-white border border-slate-200 rounded-xl p-3">
                            <div className="flex items-center justify-between mb-2 gap-2">
                                <span className="text-xs font-bold text-slate-500">
                                    참고할 메모 {checkedIds.size}/{foundNotes.length}개{searchInfo ? ` · ${searchInfo}` : ''}
                                </span>
                                {selectionChanged && !busy && (
                                    <button
                                        onClick={handleRegenerate}
                                        disabled={checkedIds.size === 0}
                                        className="flex items-center gap-1 text-xs font-bold text-indigo-600 hover:text-indigo-800 whitespace-nowrap disabled:opacity-40"
                                    >
                                        <RefreshCw className="w-3.5 h-3.5" /> 선택한 메모로 다시 만들기
                                    </button>
                                )}
                            </div>
                            <div className="space-y-1">
                                {foundNotes.map(n => {
                                    const idx = usedIndexOf(n.id);
                                    return (
                                        <div key={n.id} className="flex items-center gap-2 text-sm">
                                            <input
                                                type="checkbox"
                                                checked={checkedIds.has(n.id)}
                                                onChange={() => toggleChecked(n.id)}
                                                disabled={busy}
                                                className="w-4 h-4 shrink-0 rounded border-slate-300 text-indigo-600"
                                            />
                                            <span className="w-12 shrink-0 text-[11px] font-bold text-indigo-500">{idx >= 0 ? `[메모${idx + 1}]` : ''}</span>
                                            <button
                                                onClick={() => onSelectNote(n.id)}
                                                className="flex-1 min-w-0 text-left truncate text-slate-700 hover:text-indigo-600"
                                                title="메모 열기"
                                            >
                                                {n.title || '제목 없음'}
                                            </button>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    {isGenerating && (
                        <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-2 animate-pulse">
                            <div className="text-xs text-slate-500 flex items-center gap-2">
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                {mode === 'ask' ? '메모를 근거로 답변 작성 중…' : '메모들을 하나로 정리하는 중…'}
                            </div>
                            <div className="h-4 bg-slate-100 rounded w-3/4" />
                            <div className="h-4 bg-slate-100 rounded w-full" />
                            <div className="h-4 bg-slate-100 rounded w-5/6" />
                        </div>
                    )}

                    {error && !busy && (
                        <div className="flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-xl">
                            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                            <span className="flex-1">{error}</span>
                        </div>
                    )}

                    {/* 결과 */}
                    {resultMarkdown && !isGenerating && (
                        <div className="bg-white border border-slate-200 rounded-xl p-4 md:p-5 shadow-sm">
                            <div className="flex items-center justify-between gap-2 mb-3">
                                <span className="text-xs font-bold text-indigo-600">
                                    {resultMode === 'ask' ? '답변' : '정리본'} · [메모N]을 누르면 해당 메모가 열려요
                                </span>
                                {resultMode === 'synthesize' && (
                                    savedNoteId ? (
                                        <button
                                            onClick={() => onSelectNote(savedNoteId)}
                                            className="flex items-center gap-1 text-xs font-bold text-emerald-600 whitespace-nowrap"
                                        >
                                            <Check className="w-3.5 h-3.5" /> 저장됨 · 열기
                                        </button>
                                    ) : (
                                        <button
                                            onClick={handleSaveAsNote}
                                            disabled={isSaving}
                                            className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold whitespace-nowrap disabled:opacity-50"
                                        >
                                            {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} 새 메모로 저장
                                        </button>
                                    )
                                )}
                            </div>
                            <div
                                className="prose prose-sm prose-slate max-w-none text-slate-700 leading-relaxed break-words"
                                onClick={handleResultClick}
                                dangerouslySetInnerHTML={renderResult()}
                            />
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default AskNotesView;
