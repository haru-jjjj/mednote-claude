import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight, Loader2, X, Image as ImageIcon, MessageSquareText, FileText } from 'lucide-react';
import { NoteCategory, CATEGORIES, CATEGORY_LABELS, hasCategory } from '../types';
import { getPhotoNotesMetaFromDB, getNoteFromDB, PhotoNoteMeta } from '../services/storage';
import { parseThread } from '../services/threadFormat';
import { imageSrc } from '../services/imageUtils';

// ============================================================================
// 사진 모아보기 (§5-69): 메모에 붙인 사진 / 질문 노트에 올린 사진을 따로 모아 격자로 보기
// - 이 기기(IndexedDB)에 있는 메모 기준. 사진 데이터는 화면에 보일 만큼만 메모별로 읽음 (한꺼번에 읽으면 무거움)
// - 사진을 누르면 크게 보기(이전/다음, 밀어서 넘기기) + 그 메모·대화로 이동
// ============================================================================

interface Props {
    onBack: () => void;
    onOpenNote: (id: string) => void; // 메모는 메모 화면, 질문 노트는 대화 화면으로
    refreshKey: string; // 메모 목록이 바뀌면(모두 불러오기 등) 다시 읽음
    isFetchingAll?: boolean;
}

interface PhotoRef {
    key: string;
    noteId: string;
    index: number; // 메모의 images 배열 번호
    title: string;
    at: number;
    caption?: string; // 질문 노트: 그 사진을 올린 질문
    tag?: PhotoNoteMeta['tag'];
    work?: boolean;
}

type Tab = 'memo' | 'thread';
type MemoFilter = 'all' | NoteCategory;
const PAGE = 30;
const TAB_KEY = 'medinote_photos_tab';

const fmtDate = (t: number) => (t ? new Date(t).toLocaleDateString() : '');

const buildRefs = (metas: PhotoNoteMeta[]): { memo: PhotoRef[]; thread: PhotoRef[] } => {
    const memo: PhotoRef[] = [];
    const thread: PhotoRef[] = [];
    metas.forEach(m => {
        const base = { noteId: m.id, title: m.title || '(제목 없음)', tag: m.tag, work: m.work };
        if (m.kind === 'thread') {
            // 사진이 붙은 질문을 찾아 그 질문 글과 시각을 붙임
            const owner = new Map<number, { text: string; at: number }>();
            parseThread(m.content || '').forEach(msg => {
                if (msg.role === 'user') (msg.images || []).forEach(i => owner.set(i, { text: msg.text, at: msg.at }));
            });
            for (let i = 0; i < m.imageCount; i++) {
                const o = owner.get(i);
                thread.push({ ...base, key: `${m.id}:${i}`, index: i, at: o?.at || m.updatedAt || m.createdAt, caption: o?.text });
            }
        } else {
            for (let i = 0; i < m.imageCount; i++) {
                memo.push({ ...base, key: `${m.id}:${i}`, index: i, at: m.updatedAt || m.createdAt });
            }
        }
    });
    // 최신 것부터, 같은 메모 안에서는 붙인 순서대로
    const sort = (a: PhotoRef, b: PhotoRef) => (b.at - a.at) || a.noteId.localeCompare(b.noteId) || (a.index - b.index);
    return { memo: memo.sort(sort), thread: thread.sort(sort) };
};

const PhotosView: React.FC<Props> = ({ onBack, onOpenNote, refreshKey, isFetchingAll }) => {
    const [metas, setMetas] = useState<PhotoNoteMeta[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [tab, setTabState] = useState<Tab>(() => { try { return localStorage.getItem(TAB_KEY) === 'thread' ? 'thread' : 'memo'; } catch { return 'memo'; } });
    const setTab = (t: Tab) => { setTabState(t); setShown(PAGE); try { localStorage.setItem(TAB_KEY, t); } catch { /* 이번 화면에선 동작 */ } };
    const [filter, setFilter] = useState<MemoFilter>('all');
    const [shown, setShown] = useState(PAGE);
    const [images, setImages] = useState<Record<string, string[]>>({}); // 메모 id → 사진들 (읽어 온 것만)
    const loadingRef = useRef<Set<string>>(new Set());
    const [viewer, setViewer] = useState<number | null>(null); // 지금 목록에서 크게 보는 사진 번호
    const touchX = useRef<number | null>(null);

    useEffect(() => {
        let alive = true;
        getPhotoNotesMetaFromDB()
            .then(list => { if (alive) { setMetas(list); setError(null); } })
            .catch(e => { console.error(e); if (alive) setError('사진을 읽지 못했습니다.'); });
        return () => { alive = false; };
    }, [refreshKey]);

    const refs = useMemo(() => buildRefs(metas || []), [metas]);
    const list = useMemo(() => {
        if (tab === 'thread') return refs.thread;
        return filter === 'all' ? refs.memo : refs.memo.filter(r => hasCategory({ tag: r.tag, work: r.work }, filter));
    }, [refs, tab, filter]);
    const visible = list.slice(0, shown);

    // 화면에 보이는 사진(+ 크게 보는 사진)의 메모만 읽어 옴
    useEffect(() => {
        const need = new Set(visible.map(r => r.noteId));
        if (viewer !== null && list[viewer]) need.add(list[viewer].noteId);
        need.forEach(id => {
            if (images[id] || loadingRef.current.has(id)) return;
            loadingRef.current.add(id);
            getNoteFromDB(id)
                .then(n => setImages(prev => ({ ...prev, [id]: (n?.images || []) as string[] })))
                .catch(() => setImages(prev => ({ ...prev, [id]: [] })))
                .finally(() => loadingRef.current.delete(id));
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [visible.map(r => r.noteId).join('|'), viewer, list]);

    const imgOf = (r: PhotoRef): string | null | undefined => {
        const arr = images[r.noteId];
        if (!arr) return undefined; // 아직 읽는 중
        const v = arr[r.index];
        return typeof v === 'string' && v ? v : null; // 없음(그 사이 지워짐 등)
    };

    // 크게 보기: 키보드 ← → Esc
    useEffect(() => {
        if (viewer === null) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setViewer(null);
            if (e.key === 'ArrowLeft') setViewer(v => (v !== null && v > 0 ? v - 1 : v));
            if (e.key === 'ArrowRight') setViewer(v => (v !== null && v < list.length - 1 ? v + 1 : v));
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [viewer, list.length]);

    // 크게 보다가 목록 끝 근처로 가면 다음 묶음도 미리 보이게
    useEffect(() => { if (viewer !== null && viewer >= shown - 3) setShown(s => Math.max(s, viewer + PAGE)); }, [viewer, shown]);

    const memoCount = refs.memo.length;
    const threadCount = refs.thread.length;
    const current = viewer !== null ? list[viewer] : null;

    return (
        <div className="h-full flex flex-col bg-slate-50">
            <div className="h-12 px-2 bg-white border-b border-slate-100 flex items-center gap-1 flex-none">
                <button onClick={onBack} className="p-2 text-slate-500 hover:text-slate-800" title="뒤로"><ArrowLeft className="w-5 h-5" /></button>
                <h2 className="font-bold text-slate-800 flex items-center gap-1.5"><ImageIcon className="w-4 h-4 text-slate-400" /> 사진 모아보기</h2>
            </div>

            <div className="flex-1 overflow-y-auto">
                <div className="max-w-5xl mx-auto p-3 md:p-6 space-y-3">
                    {/* 메모 사진 / 질문 노트 사진 */}
                    <div className="inline-flex p-0.5 bg-slate-100 rounded-lg">
                        {([['memo', `메모 사진 ${memoCount}`], ['thread', `질문 노트 사진 ${threadCount}`]] as [Tab, string][]).map(([k, label]) => (
                            <button
                                key={k}
                                onClick={() => setTab(k)}
                                className={`px-3 py-1.5 rounded-md text-xs font-bold transition-colors ${tab === k ? 'bg-white shadow-sm text-accent-700' : 'text-slate-500 hover:text-slate-700'}`}
                            >
                                {label}
                            </button>
                        ))}
                    </div>

                    {tab === 'memo' && memoCount > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                            {(['all', ...CATEGORIES] as MemoFilter[]).map(f => {
                                const n = f === 'all' ? memoCount : refs.memo.filter(r => hasCategory({ tag: r.tag, work: r.work }, f)).length;
                                return (
                                    <button
                                        key={f}
                                        onClick={() => { setFilter(f); setShown(PAGE); }}
                                        className={`px-2.5 py-1 rounded-lg border text-xs font-bold ${filter === f ? 'bg-accent-50 border-accent-300 text-accent-700' : 'bg-white border-slate-200 text-slate-500 hover:border-slate-300'}`}
                                    >
                                        {f === 'all' ? '전체' : CATEGORY_LABELS[f]} <span className="font-normal text-slate-400">{n}</span>
                                    </button>
                                );
                            })}
                        </div>
                    )}

                    <p className="text-[11px] text-slate-400">
                        {tab === 'memo' ? '메모에 붙인 사진, 최근 수정한 메모부터.' : '질문 노트에 올린 사진, 최근 질문부터. 사진 아래는 그 사진과 함께 한 질문.'}
                        {' '}이 기기에 있는 메모 기준{isFetchingAll ? ' (예전 메모 불러오는 중…)' : ''}.
                    </p>

                    {error ? (
                        <p className="text-sm text-red-500 py-8 text-center">{error}</p>
                    ) : metas === null ? (
                        <p className="text-sm text-slate-400 py-8 text-center flex items-center justify-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> 사진 찾는 중…</p>
                    ) : list.length === 0 ? (
                        <p className="text-sm text-slate-400 py-8 text-center">
                            {tab === 'memo' ? (filter === 'all' ? '사진이 있는 메모가 없어요.' : '이 분류에는 사진이 없어요.') : '질문 노트에 올린 사진이 없어요.'}
                        </p>
                    ) : (
                        <>
                            <ul className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-1.5 md:gap-2">
                                {visible.map((r, i) => {
                                    const src = imgOf(r);
                                    return (
                                        <li key={r.key} className="min-w-0">
                                            <button onClick={() => setViewer(i)} className="block w-full text-left group" title={r.caption || r.title}>
                                                <div className="aspect-square rounded-lg overflow-hidden bg-slate-200/60 border border-slate-200 group-hover:border-accent-300 flex items-center justify-center">
                                                    {src ? (
                                                        <img src={imageSrc(src)} alt="" loading="lazy" className="w-full h-full object-cover" />
                                                    ) : src === null ? (
                                                        <ImageIcon className="w-5 h-5 text-slate-300" />
                                                    ) : (
                                                        <Loader2 className="w-4 h-4 animate-spin text-slate-400" />
                                                    )}
                                                </div>
                                                <p className="mt-1 text-[11px] leading-tight text-slate-600 truncate">{tab === 'thread' ? (r.caption || r.title) : r.title}</p>
                                                <p className="text-[10px] text-slate-400 truncate">{fmtDate(r.at)}{tab === 'thread' && r.caption ? ` · ${r.title}` : ''}</p>
                                            </button>
                                        </li>
                                    );
                                })}
                            </ul>
                            {shown < list.length && (
                                <div className="text-center pt-2">
                                    <button onClick={() => setShown(s => s + PAGE)} className="px-4 py-2 rounded-lg border border-slate-200 bg-white text-xs font-bold text-slate-600 hover:border-accent-300 hover:text-accent-700">
                                        더 보기 ({list.length - shown}장 남음)
                                    </button>
                                </div>
                            )}
                        </>
                    )}
                </div>
            </div>

            {/* 크게 보기 */}
            {current && viewer !== null && (
                <div
                    className="fixed inset-0 z-[100] bg-black/95 flex flex-col"
                    onTouchStart={e => { touchX.current = e.touches[0].clientX; }}
                    onTouchEnd={e => {
                        if (touchX.current === null) return;
                        const dx = e.changedTouches[0].clientX - touchX.current;
                        touchX.current = null;
                        if (dx > 50 && viewer > 0) setViewer(viewer - 1);
                        if (dx < -50 && viewer < list.length - 1) setViewer(viewer + 1);
                    }}
                >
                    <div className="flex items-center gap-2 px-3 text-white/80 text-xs" style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 0.75rem)' }}>
                        <span>{viewer + 1} / {list.length}</span>
                        <button onClick={() => setViewer(null)} className="ml-auto p-2 bg-white/10 rounded-full text-white" title="닫기"><X className="w-5 h-5" /></button>
                    </div>
                    <div className="flex-1 min-h-0 flex items-center justify-center relative px-2" onClick={() => setViewer(null)}>
                        {(() => {
                            const src = imgOf(current);
                            if (src) return <img src={imageSrc(src)} alt="" className="max-w-full max-h-full object-contain rounded" onClick={e => e.stopPropagation()} />;
                            if (src === null) return <p className="text-white/60 text-sm">사진을 찾지 못했어요.</p>;
                            return <Loader2 className="w-6 h-6 animate-spin text-white/60" />;
                        })()}
                        {viewer > 0 && (
                            <button onClick={e => { e.stopPropagation(); setViewer(viewer - 1); }} className="absolute left-2 top-1/2 -translate-y-1/2 p-2 bg-white/10 rounded-full text-white" title="이전"><ChevronLeft className="w-6 h-6" /></button>
                        )}
                        {viewer < list.length - 1 && (
                            <button onClick={e => { e.stopPropagation(); setViewer(viewer + 1); }} className="absolute right-2 top-1/2 -translate-y-1/2 p-2 bg-white/10 rounded-full text-white" title="다음"><ChevronRight className="w-6 h-6" /></button>
                        )}
                    </div>
                    <div className="px-4 pt-3 text-white" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 1rem)' }}>
                        {tab === 'thread' && current.caption && <p className="text-sm leading-snug line-clamp-3 mb-1">{current.caption}</p>}
                        <p className="text-xs text-white/60 truncate">{current.title} · {fmtDate(current.at)}</p>
                        <button
                            onClick={() => { const id = current.noteId; setViewer(null); onOpenNote(id); }}
                            className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/15 hover:bg-white/25 text-xs font-bold"
                        >
                            {tab === 'thread' ? <><MessageSquareText className="w-3.5 h-3.5" /> 대화 열기</> : <><FileText className="w-3.5 h-3.5" /> 메모 열기</>}
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
};

export default PhotosView;
