import React, { useMemo, useState } from 'react';
import { Loader2, Save, Check, Copy, Globe } from 'lucide-react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { v4 as uuidv4 } from 'uuid';
import { Note, Source } from '../types';
import { formatMedicalMarkdown } from '../services/claudeService';

// ============================================================================
// AI 결과 카드 (메모 활용 화면 공용)
// - 마크다운 렌더링 + [메모N] 인용을 누르면 해당 메모 열기
// - "새 메모로 저장"(누를 때만), 템플릿처럼 코드 블록이 있으면 "틀 복사"
// ============================================================================

// [메모1], [메모1, 3] 같은 인용 표시를 링크로 (코드 블록 안과 태그 속성은 건드리지 않음)
export const renderLinkedMarkdown = (markdown: string, refCount: number): string => {
    try {
        const html = DOMPurify.sanitize(marked.parse(formatMedicalMarkdown(markdown), { breaks: false, gfm: true }) as string);
        const linkify = (chunk: string) => chunk.replace(
            /\[메모\s?(\d{1,3})((?:\s*[,·]\s*(?:메모\s?)?\d{1,3})*)\]/g,
            (all: string, firstNum: string, rest: string) => {
                const nums = [firstNum, ...(rest.match(/\d{1,3}/g) || [])].map(Number);
                if (nums.some(n => n < 1 || n > refCount)) return all;
                return nums.map(n =>
                    `<a data-note-ref="${n}" class="text-accent-600 font-semibold no-underline cursor-pointer hover:underline whitespace-nowrap">[메모${n}]</a>`
                ).join('');
            }
        );
        let inCode = 0;
        return html.split(/(<[^>]+>)/g).map(part => {
            if (part.startsWith('<')) {
                if (/^<(pre|code)[\s>]/i.test(part)) inCode++;
                else if (/^<\/(pre|code)>/i.test(part)) inCode = Math.max(0, inCode - 1);
                return part;
            }
            return inCode > 0 ? part : linkify(part);
        }).join('');
    } catch {
        return DOMPurify.sanitize(markdown);
    }
};

// "### 템플릿" 아래의 첫 코드 블록 (없으면 첫 코드 블록)
const templateCodeBlock = (markdown: string): string | null => {
    const text = markdown || '';
    const h = text.search(/#+\s*템플릿/);
    const re = /```[a-zA-Z]*\n([\s\S]*?)```/;
    const m = (h >= 0 ? re.exec(text.slice(h)) : null) || re.exec(text);
    return m ? m[1].replace(/\n$/, '') : null;
};

interface Props {
    label: string;
    markdown: string;
    refNotes: Note[]; // [메모N]의 N번째 메모
    sources?: Source[];
    saveTitle: string;
    copyTemplate?: boolean; // 작성 템플릿 카드에서만 "틀 복사" 버튼 표시
    saveExtra?: Partial<Note>; // 저장할 때 함께 넣을 값 (예: 인계장은 '업무' 분류로)
    onSelectNote: (id: string) => void;
    onSaveNewNote: (note: Note) => Promise<void>;
}

const NoteResultCard: React.FC<Props> = ({ label, markdown, refNotes, sources, saveTitle, copyTemplate, saveExtra, onSelectNote, onSaveNewNote }) => {
    const [savedId, setSavedId] = useState<string | null>(null);
    const [isSaving, setIsSaving] = useState(false);
    const [copied, setCopied] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const html = useMemo(() => renderLinkedMarkdown(markdown, refNotes.length), [markdown, refNotes.length]);
    const template = useMemo(() => (copyTemplate ? templateCodeBlock(markdown) : null), [markdown, copyTemplate]);

    // 결과가 새로 만들어지면 저장 상태 초기화
    const [lastMarkdown, setLastMarkdown] = useState(markdown);
    if (lastMarkdown !== markdown) {
        setLastMarkdown(markdown);
        setSavedId(null);
        setError(null);
    }

    const handleClick = (e: React.MouseEvent) => {
        const target = (e.target as HTMLElement).closest('[data-note-ref]');
        if (!target) return;
        const n = refNotes[Number(target.getAttribute('data-note-ref')) - 1];
        if (n) onSelectNote(n.id);
    };

    const handleSave = async () => {
        if (savedId || isSaving) return;
        setIsSaving(true);
        setError(null);
        const refs = refNotes.map((n, i) => `- [메모${i + 1}] ${n.title || '제목 없음'}`).join('\n');
        const src = (sources || []).map(s => `- [${s.title || s.uri}](${s.uri})`).join('\n');
        const now = Date.now();
        const note: Note = {
            id: uuidv4(),
            title: saveTitle.slice(0, 60),
            content: [
                markdown,
                refs ? `---\n\n**참고한 메모**\n\n${refs}` : '',
                src ? `**출처**\n\n${src}` : ''
            ].filter(Boolean).join('\n\n'),
            summary: '',
            createdAt: now,
            updatedAt: now,
            sources: [],
            images: [],
            isEnhancing: false,
            isProcessed: false,
            ...(saveExtra || {}),
            origin: 'ai'
        };
        try {
            await onSaveNewNote(note);
            setSavedId(note.id);
        } catch (e: any) {
            setError(e?.message || '메모 저장에 실패했습니다.');
        } finally {
            setIsSaving(false);
        }
    };

    const handleCopy = async () => {
        if (!template) return;
        try {
            await navigator.clipboard.writeText(template);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            setError('복사하지 못했습니다. 틀을 직접 선택해서 복사해주세요.');
        }
    };

    return (
        <div className="bg-white border border-slate-200 rounded-xl p-4 md:p-5 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                <span className="text-xs font-bold text-accent-600">
                    {label}{refNotes.length > 0 ? ' · [메모N]을 누르면 해당 메모가 열려요' : ''}
                </span>
                <div className="flex items-center gap-2">
                    {template && (
                        <button
                            onClick={handleCopy}
                            className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-white border border-slate-200 text-slate-600 hover:bg-slate-50 text-xs font-bold whitespace-nowrap"
                        >
                            {copied ? <Check className="w-3.5 h-3.5 text-sage-600" /> : <Copy className="w-3.5 h-3.5" />} {copied ? '복사됨' : '틀 복사'}
                        </button>
                    )}
                    {savedId ? (
                        <button onClick={() => onSelectNote(savedId)} className="flex items-center gap-1 text-xs font-bold text-sage-600 whitespace-nowrap">
                            <Check className="w-3.5 h-3.5" /> 저장됨 · 열기
                        </button>
                    ) : (
                        <button
                            onClick={handleSave}
                            disabled={isSaving}
                            className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-accent-600 hover:bg-accent-700 text-white text-xs font-bold whitespace-nowrap disabled:opacity-50"
                        >
                            {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} 새 메모로 저장
                        </button>
                    )}
                </div>
            </div>
            {error && <p className="text-xs text-red-600 mb-2">{error}</p>}
            <div
                className="prose prose-sm prose-slate max-w-none text-slate-700 leading-relaxed break-words"
                onClick={handleClick}
                dangerouslySetInnerHTML={{ __html: html }}
            />
            {sources && sources.length > 0 && (
                <div className="flex flex-wrap gap-2 pt-3 mt-3 border-t border-slate-100">
                    {sources.map((s, i) => (
                        <a key={i} href={s.uri} target="_blank" rel="noopener noreferrer"
                           className="flex items-center gap-1.5 px-3 py-1.5 bg-white text-accent-600 rounded-lg text-xs font-medium border border-accent-100 hover:border-accent-300">
                            <Globe className="w-3 h-3" />
                            <span className="truncate max-w-[180px]">{s.title || s.uri}</span>
                        </a>
                    ))}
                </div>
            )}
        </div>
    );
};

export default NoteResultCard;
