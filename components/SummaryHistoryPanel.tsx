import React, { useEffect, useState } from 'react';
import { Clock, RotateCcw, Trash2, ChevronDown, ChevronUp, X, Globe } from 'lucide-react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import type { Note, SummaryVersion } from '../types';
import { formatMedicalMarkdown } from '../services/claudeService';
import { historyOf, isCurrentVersion, MODE_LABELS } from '../services/summaryHistory';

interface Props {
    note: Note;
    disabled?: boolean;
    onRestore: (v: SummaryVersion) => void;
    onDelete: (v: SummaryVersion) => void;
    onClose: () => void;
}

const MODE_COLORS: Record<SummaryVersion['mode'], string> = {
    new: 'bg-indigo-50 text-indigo-600 border-indigo-100',
    journal: 'bg-violet-50 text-violet-600 border-violet-100',
    refine: 'bg-emerald-50 text-emerald-700 border-emerald-100',
    legacy: 'bg-slate-50 text-slate-500 border-slate-200'
};

const fmt = (t: number) => {
    const d = new Date(t);
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
};

// AI 요약 이력: 최신 버전이 위. 펼쳐서 보기 · 이 버전으로 되돌리기 · 삭제
const SummaryHistoryPanel: React.FC<Props> = ({ note, disabled, onRestore, onDelete, onClose }) => {
    const list = [...historyOf(note)].reverse();
    const [openId, setOpenId] = useState<string | null>(null);
    const [html, setHtml] = useState('');

    useEffect(() => { setOpenId(null); }, [note.id]);

    const open = list.find(v => v.id === openId);
    useEffect(() => {
        let alive = true;
        if (!open) { setHtml(''); return; }
        (async () => {
            try {
                const parsed = await marked.parse(formatMedicalMarkdown(open.summary), { breaks: false, gfm: true });
                if (alive) setHtml(DOMPurify.sanitize(parsed as string));
            } catch {
                if (alive) setHtml(DOMPurify.sanitize(open.summary));
            }
        })();
        return () => { alive = false; };
    }, [open?.id, open?.summary]);

    return (
        <div className="mb-6 rounded-xl border border-slate-200 bg-white p-3 animate-in fade-in slide-in-from-top-1 duration-150">
            <div className="flex items-center gap-2 mb-2">
                <Clock className="w-4 h-4 text-slate-400" />
                <span className="text-sm font-bold text-slate-700">AI 요약 이력</span>
                <span className="text-[11px] text-slate-400">{list.length}개 · 최근 것이 위</span>
                <button onClick={onClose} className="ml-auto p-1 text-slate-400 hover:text-slate-600" title="닫기">
                    <X className="w-4 h-4" />
                </button>
            </div>
            {list.length === 0 ? (
                <p className="text-xs text-slate-400 py-2">아직 이력이 없어요. 요약을 만들거나 추가 요청을 반영하면 여기에 쌓입니다.</p>
            ) : (
                <ul className="space-y-1.5">
                    {list.map(v => {
                        const current = isCurrentVersion(note, v);
                        const isOpen = openId === v.id;
                        return (
                            <li key={v.id} className={`rounded-lg border ${current ? 'border-indigo-200 bg-indigo-50/40' : 'border-slate-100 bg-slate-50/50'}`}>
                                <button
                                    onClick={() => setOpenId(isOpen ? null : v.id)}
                                    className="w-full flex items-start gap-2 px-2.5 py-2 text-left"
                                >
                                    <span className="min-w-0 flex-1">
                                        <span className="flex flex-wrap items-center gap-1.5">
                                            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${MODE_COLORS[v.mode]}`}>
                                                {v.mode === 'legacy' && v.kind === 'journal' ? '이전 저널클럽 분석' : MODE_LABELS[v.mode]}
                                            </span>
                                            {current && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-indigo-600 text-white">현재</span>}
                                            <span className="text-[11px] text-slate-400">{fmt(v.createdAt)}</span>
                                        </span>
                                        {v.request && (
                                            <span className="block text-xs text-slate-600 mt-1 line-clamp-2">“{v.request}”</span>
                                        )}
                                    </span>
                                    {isOpen ? <ChevronUp className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" /> : <ChevronDown className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />}
                                </button>
                                {isOpen && (
                                    <div className="px-2.5 pb-2.5">
                                        {v.request && (
                                            <div className="text-xs text-slate-600 bg-white border border-slate-100 rounded-md px-2 py-1.5 mb-2 whitespace-pre-wrap">
                                                <span className="font-bold text-slate-500">요청: </span>{v.request}
                                            </div>
                                        )}
                                        <div
                                            className="prose prose-sm prose-slate max-w-none text-slate-700 leading-relaxed break-words [&_code]:break-all [&_code]:whitespace-pre-wrap bg-white border border-slate-100 rounded-md p-3 max-h-[60vh] overflow-y-auto"
                                            dangerouslySetInnerHTML={{ __html: html }}
                                        />
                                        {v.sources && v.sources.length > 0 && (
                                            <div className="flex flex-wrap gap-1.5 mt-2">
                                                {v.sources.map((src, i) => (
                                                    <a key={i} href={src.uri} target="_blank" rel="noopener noreferrer"
                                                       className="flex items-center gap-1 px-2 py-1 bg-white text-slate-600 rounded-md text-[11px] border border-slate-200 hover:border-indigo-300">
                                                        <Globe className="w-3 h-3" />
                                                        <span className="truncate max-w-[160px]">{src.title}</span>
                                                    </a>
                                                ))}
                                            </div>
                                        )}
                                        <div className="flex justify-end gap-2 mt-2">
                                            {!current && (
                                                <button
                                                    onClick={() => onRestore(v)}
                                                    disabled={disabled}
                                                    className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold disabled:opacity-50"
                                                >
                                                    <RotateCcw className="w-3.5 h-3.5" /> 이 버전으로 되돌리기
                                                </button>
                                            )}
                                            {!current && <button
                                                onClick={() => onDelete(v)}
                                                disabled={disabled}
                                                className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-white border border-slate-200 text-slate-500 hover:text-red-500 hover:border-red-200 text-xs font-bold disabled:opacity-50"
                                            >
                                                <Trash2 className="w-3.5 h-3.5" /> 이력에서 삭제
                                            </button>}
                                        </div>
                                    </div>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
};

export default SummaryHistoryPanel;
