
import React, { useState, useMemo, useEffect, useRef } from 'react';
import { Search, BookOpen, Sparkles, Loader2, ArrowUp, CloudDownload, Lightbulb, X } from 'lucide-react';
import { Note, NoteCategory, CATEGORIES, CATEGORY_LABELS, CATEGORY_COLORS, hasCategory } from '../types';
import { embedTexts, cosineSimilarity, hasVoyageApiKey } from '../services/voyageService';

interface NoteListProps {
  notes: Note[];
  onDelete: (id: string) => void;
  onUpdateNote: (note: Note) => void;
  onImportBackup: () => void;
  onExportBackup: () => void;
  onSelectNote: (id: string) => void;
  activeNoteId: string | null;
  onClearActiveNote: () => void;
  onRandomNote: () => void;
  onLoadMore?: () => void;
  onFetchAll?: () => void;
  isLoadingMore?: boolean;
  searchTerm: string;
  onSearchChange: (term: string) => void;
  embeddingBackfillProgress?: { done: number; total: number } | null;
  tagFilter: TagFilter;
  onTagFilterChange: (filter: TagFilter) => void;
  isFetchingAll?: boolean;
  reviewDueCount?: number;
  onOpenReview?: () => void;
}

export type TagFilter = 'all' | NoteCategory;

// 의미 검색 결과로 인정할 최소 코사인 유사도. Voyage 임베딩 실측치를 보고
// 너무 많이/적게 걸리면 이 값을 조절하세요(낮출수록 더 널널하게 잡힘).
const SEMANTIC_SIMILARITY_THRESHOLD = 0.4;
const SEMANTIC_MAX_RESULTS = 8;
// 키워드 검색(150ms)보다 조금 더 기다렸다가 연관 검색 요청 — 타이핑 중 불필요한 요청 방지
const SEMANTIC_DEBOUNCE_MS = 250;

// 검색어 → 임베딩 벡터 캐시 (앱을 켜둔 동안 유지). 같은 검색어로 다시 검색하거나,
// 메모를 열었다 돌아오거나, 메모 목록이 갱신돼도 서버에 다시 묻지 않고 바로 계산합니다.
const queryVectorCache = new Map<string, number[]>();

type SemanticStatus = 'idle' | 'waiting' | 'loading' | 'ready' | 'error' | 'unavailable';

// Optimization: Memoized NoteCard component with content truncation to prevent rendering freezes
const NoteCard = React.memo(({ note, onClick, badge }: { note: Note, onClick: () => void, badge?: string }) => {

    const previewContent = useMemo(() => {
        // Prefer summary if available and note has no main content
        const text = note.content || note.summary || '';

        if (!text.trim() && note.title) return '';

        if (text.length > 150) {
            return text.substring(0, 150) + '...';
        }
        return text;
    }, [note.content, note.title, note.summary]);

    return (
        <div
            id={`note-${note.id}`}
            onClick={onClick}
            className="rounded-lg border p-4 cursor-pointer transition-colors relative bg-white border-slate-200 hover:border-accent-300 hover:bg-slate-50"
        >
            <div className="flex flex-col gap-2">
                <p className="text-sm text-slate-600 leading-normal line-clamp-4 h-auto min-h-[1.5rem]" style={{ wordBreak: 'keep-all', overflowWrap: 'break-word' }}>
                    {previewContent || <span className="text-slate-300 italic">No additional text</span>}
                </p>

                <div className="flex items-center justify-between mt-1.5 pt-1.5 border-t border-slate-100/50">
                    <span className="flex items-center gap-1.5 text-[11px] text-slate-400 font-medium">
                        {new Date(note.createdAt).toLocaleDateString()}
                        {CATEGORIES.filter(c => hasCategory(note, c)).map(c => (
                            <span key={c} className={`px-1.5 py-0.5 rounded font-bold ${CATEGORY_COLORS[c].badge}`}>
                                {CATEGORY_LABELS[c]}
                            </span>
                        ))}
                    </span>
                    <div className="flex items-center gap-1.5">
                        {note.guidelineCheck?.status === 'changed' && (
                            <span className="text-[11px] font-bold text-warn-700 bg-warn-50 border border-warn-200 px-1.5 py-0.5 rounded" title="최신 가이드라인과 달라진 내용이 있음">가이드라인 변경</span>
                        )}
                        {badge && (
                            <span className="text-[11px] font-bold text-accent-600 bg-accent-50 px-1.5 py-0.5 rounded">{badge}</span>
                        )}
                        {note.summary && (
                            <div className="flex items-center gap-1 text-[11px] text-accent-400 bg-accent-50 px-1.5 py-0.5 rounded">
                                <Sparkles className="w-3 h-3" /> {note.summaryKind === 'journal' ? 'Journal' : 'Summary'}
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
});

const NoteList: React.FC<NoteListProps> = ({
    notes,
    onSelectNote,
    activeNoteId,
    onClearActiveNote,
    onLoadMore,
    onFetchAll,
    isLoadingMore,
    searchTerm,
    onSearchChange,
    embeddingBackfillProgress,
    tagFilter,
    onTagFilterChange,
    isFetchingAll,
    reviewDueCount = 0,
    onOpenReview
}) => {
  // Pagination / Infinite Scroll State
  const [visibleCount, setVisibleCount] = useState(20);
  const observerTarget = useRef<HTMLDivElement>(null);

  // Scroll to Top Logic
  const [showScrollTop, setShowScrollTop] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  // Handle Scroll Event to show/hide button
  useEffect(() => {
    const listElement = listRef.current;
    if (!listElement) return;

    const handleScroll = () => {
        if (listElement.scrollTop > 300) {
            setShowScrollTop(true);
        } else {
            setShowScrollTop(false);
        }
    };

    listElement.addEventListener('scroll', handleScroll);
    return () => listElement.removeEventListener('scroll', handleScroll);
  }, []);

  useEffect(() => {
    if (activeNoteId) {
        setTimeout(() => {
            const element = document.getElementById(`note-${activeNoteId}`);
            if (element) element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 100);
        onClearActiveNote();
    }
  }, [activeNoteId, onClearActiveNote]);

  // Reset pagination on search / filter change
  useEffect(() => {
      setVisibleCount(20);
  }, [searchTerm, tagFilter]);

  // 분류(메모/환자) 필터: 검색과 함께 적용됩니다.
  const tagFilteredNotes = useMemo(
      () => (tagFilter === 'all' ? notes : notes.filter(n => hasCategory(n, tagFilter))),
      [notes, tagFilter]
  );
  const tagCounts = useMemo(() => {
      const c: Record<NoteCategory, number> = { memo: 0, patient: 0, work: 0 };
      notes.forEach(n => CATEGORIES.forEach(k => { if (hasCategory(n, k)) c[k]++; }));
      return c;
  }, [notes]);

  const scrollToTop = () => {
      listRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // --- Search: local input state + debounce (typing stays instant; the actual
  // filtering below only re-runs ~150ms after the user stops typing) ---
  const [searchInput, setSearchInput] = useState(searchTerm);

  // Keep local input in sync if the search term is cleared/changed from outside
  useEffect(() => {
      setSearchInput(searchTerm);
  }, [searchTerm]);

  useEffect(() => {
      const handle = setTimeout(() => {
          if (searchInput !== searchTerm) onSearchChange(searchInput);
      }, 150);
      return () => clearTimeout(handle);
      // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

  // 검색어를 한 번에 지우고 디바운스를 기다리지 않고 바로 메인 목록으로 돌아갑니다.
  const handleClearSearch = () => {
      setSearchInput('');
      onSearchChange('');
  };

  // Precompute a normalized (lowercased) search index PER NOTE, only when the
  // notes themselves change — not on every keystroke. Includes OCR-extracted
  // image text (transcription) so photos' content is searchable too.
  const noteSearchIndex = useMemo(() => {
      const index = new Map<string, string>();
      notes.forEach(note => {
          const combined = [note.title, note.content, note.summary, note.transcription]
              .filter(Boolean)
              .join('\n')
              .toLowerCase();
          index.set(note.id, combined);
      });
      return index;
  }, [notes]);

  // Multi-keyword, order-independent AND matching (e.g. "심방 세동" or
  // "AF 항응고제" matches notes containing all of those tokens, regardless of
  // spacing/order), instead of one exact substring.
  const textFilteredNotes = useMemo(() => {
    const tokens = searchTerm.toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return tagFilteredNotes;

    return tagFilteredNotes.filter(note => {
      const haystack = noteSearchIndex.get(note.id) || '';
      return tokens.every(token => haystack.includes(token));
    });
  }, [tagFilteredNotes, searchTerm, noteSearchIndex]);

  const otherNotes = textFilteredNotes;

  // --- 연관(의미 기반, 임베딩) 검색: 키워드는 없지만 내용이 비슷한 메모 ---
  // 1) 검색어의 임베딩만 서버(Voyage)에 한 번 요청하고 캐시합니다 — 검색어가 바뀔 때만.
  // 2) 각 메모와의 유사도 계산은 이 기기에서 바로 합니다 — 메모 목록이 바뀌어도 네트워크 없이 즉시 갱신.
  const [queryVector, setQueryVector] = useState<number[] | null>(null);
  const [semanticStatus, setSemanticStatus] = useState<SemanticStatus>('idle');
  const semanticRequestIdRef = useRef(0);

  useEffect(() => {
      const term = searchTerm.trim();
      const requestId = ++semanticRequestIdRef.current;
      if (!term) { setQueryVector(null); setSemanticStatus('idle'); return; }
      if (!hasVoyageApiKey()) { setQueryVector(null); setSemanticStatus('unavailable'); return; }

      const cached = queryVectorCache.get(term);
      if (cached) { setQueryVector(cached); setSemanticStatus('ready'); return; }

      setQueryVector(null);
      setSemanticStatus('waiting');
      const handle = setTimeout(async () => {
          if (semanticRequestIdRef.current !== requestId) return;
          setSemanticStatus('loading');
          try {
              const [vector] = await embedTexts([term], 'query');
              if (!vector || vector.length === 0) throw new Error('빈 임베딩 응답');
              if (queryVectorCache.size >= 100) queryVectorCache.clear();
              queryVectorCache.set(term, vector);
              if (semanticRequestIdRef.current === requestId) {
                  setQueryVector(vector);
                  setSemanticStatus('ready');
              }
          } catch (e) {
              console.error("연관 검색 실패(키워드 검색 결과는 정상 동작):", e);
              if (semanticRequestIdRef.current === requestId) setSemanticStatus('error');
          }
      }, SEMANTIC_DEBOUNCE_MS);
      return () => clearTimeout(handle);
  }, [searchTerm]);

  const semanticMatches = useMemo(() => {
      if (!queryVector || !searchTerm.trim()) return [] as { note: Note; score: number }[];
      const exactMatchIds = new Set(textFilteredNotes.map(n => n.id));
      return tagFilteredNotes
          .filter(n => n.embedding && n.embedding.length > 0 && !exactMatchIds.has(n.id))
          .map(n => ({ note: n, score: cosineSimilarity(queryVector, n.embedding) }))
          .filter(r => r.score >= SEMANTIC_SIMILARITY_THRESHOLD)
          .sort((a, b) => b.score - a.score)
          .slice(0, SEMANTIC_MAX_RESULTS);
  }, [queryVector, searchTerm, tagFilteredNotes, textFilteredNotes]);

  const isSemanticSearching = semanticStatus === 'waiting' || semanticStatus === 'loading';
  // 연관 검색에 쓸 수 있는(임베딩이 준비된) 메모 수
  const embeddedCount = useMemo(
      () => tagFilteredNotes.filter(n => n.embedding && n.embedding.length > 0).length,
      [tagFilteredNotes]
  );
  const isSearching = searchTerm.trim().length > 0;

  // Infinite Scroll Observer
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setVisibleCount((prev) => prev + 20);
        }
      },
      { threshold: 0.1 }
    );

    if (observerTarget.current) {
      observer.observe(observerTarget.current);
    }

    return () => observer.disconnect();
  }, [otherNotes]);

  // Slice the other notes for pagination
  const visibleOtherNotes = useMemo(() => {
      return otherNotes.slice(0, visibleCount);
  }, [otherNotes, visibleCount]);

  return (
    <div className="flex flex-col h-full bg-white relative">
      {/* Header Area */}
      <div className="p-3 space-y-2 bg-white border-b border-slate-100 z-10 flex-shrink-0">
        {/* Search Bar */}
        <div className="relative group">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-slate-400 w-4 h-4 group-focus-within:text-accent-500 transition-colors" />
            <input
                type="text"
                placeholder="검색 (내용, 사진 텍스트, AI 요약 — 여러 단어 가능)..."
                className="w-full pl-10 pr-16 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:bg-white focus:border-accent-300 focus:ring-2 focus:ring-accent-50 transition-all outline-none text-slate-700 text-sm font-medium placeholder:text-slate-400"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
            />
            <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                {isLoadingMore && searchInput.trim() && (
                    <Loader2
                        className="w-4 h-4 text-slate-300 animate-spin"
                        title="전체 메모 불러오는 중..."
                    />
                )}
                {searchInput && (
                    <button
                        type="button"
                        onClick={handleClearSearch}
                        className="p-1 text-slate-400 hover:text-slate-600 hover:bg-slate-200/70 rounded-full transition-colors"
                        title="검색어 지우고 목록으로 돌아가기"
                    >
                        <X className="w-3.5 h-3.5" />
                    </button>
                )}
            </div>
        </div>
        {/* 분류 필터 */}
        <div className="flex flex-wrap items-center gap-1.5 px-0.5">
            {(['all', ...CATEGORIES] as TagFilter[]).map(f => {
                const active = tagFilter === f;
                const label = f === 'all' ? '전체' : CATEGORY_LABELS[f];
                const count = f === 'all' ? null : tagCounts[f];
                const activeClass = f === 'all' ? 'bg-accent-50 border-accent-200 text-accent-600' : CATEGORY_COLORS[f].active;
                return (
                    <button
                        key={f}
                        type="button"
                        onClick={() => onTagFilterChange(f)}
                        className={`px-3 py-1 rounded-full text-xs font-bold border transition-colors whitespace-nowrap ${
                            active ? activeClass : 'bg-white border-slate-200 text-slate-400 hover:text-slate-600'
                        }`}
                    >
                        {label}{count !== null && count > 0 ? ` ${count}` : ''}
                    </button>
                );
            })}
            {reviewDueCount > 0 && onOpenReview && (
                <button
                    type="button"
                    onClick={onOpenReview}
                    className="ml-auto px-3 py-1 rounded-full text-xs font-bold border border-accent-200 bg-accent-50 text-accent-700 hover:bg-accent-100 transition-colors whitespace-nowrap"
                    title="복습일이 된 메모로 퀴즈 풀기"
                >
                    오늘 복습 {reviewDueCount}개 →
                </button>
            )}
        </div>
        {/* 검색 상태: 무엇을, 어디까지 찾았는지 */}
        {isSearching && (
            <div className="px-1 space-y-0.5 text-[11px] leading-relaxed">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-slate-600">
                    <span>키워드 일치 <b>{otherNotes.length}</b>개</span>
                    <span className="flex items-center gap-1">
                        연관 메모
                        {isSemanticSearching && (<><Loader2 className="w-3 h-3 animate-spin text-accent-500" /> <span className="text-accent-600">찾는 중…</span></>)}
                        {semanticStatus === 'ready' && <b className="text-accent-600">{semanticMatches.length}개</b>}
                        {semanticStatus === 'error' && <span className="text-red-500">연결 실패 — 키워드 결과만 표시</span>}
                        {semanticStatus === 'unavailable' && <span className="text-slate-400">사용 안 함 (Voyage 키 없음)</span>}
                    </span>
                </div>
                <div className="flex flex-wrap items-center gap-x-2 text-slate-400">
                    {isFetchingAll ? (
                        <span className="flex items-center gap-1">
                            <Loader2 className="w-3 h-3 animate-spin" />
                            예전 메모까지 불러오는 중 · 지금은 {tagFilteredNotes.length}개에서 검색
                        </span>
                    ) : (
                        <span>메모 {tagFilteredNotes.length}개에서 검색{tagFilter !== 'all' ? ` (${CATEGORY_LABELS[tagFilter]} 분류만)` : ''}</span>
                    )}
                    {semanticStatus !== 'unavailable' && embeddedCount < tagFilteredNotes.length && (
                        <span className="flex items-center gap-1">
                            · 연관 검색 준비 {embeddedCount}/{tagFilteredNotes.length}
                            {embeddingBackfillProgress && <Loader2 className="w-3 h-3 animate-spin" />}
                        </span>
                    )}
                </div>
            </div>
        )}
        {/* 예전 메모에 의미 기반 검색을 적용하는 중이라는 조용한 안내 (막지 않음) */}
        {!isSearching && embeddingBackfillProgress && (
            <p className="text-[11px] text-slate-400 px-1 flex items-center gap-1">
                <Loader2 className="w-3 h-3 animate-spin" />
                연관 검색 준비 중... ({embeddingBackfillProgress.done}/{embeddingBackfillProgress.total})
            </p>
        )}
      </div>

      {/* Note List */}
      <div ref={listRef} className="flex-1 overflow-y-auto p-4 space-y-3 pb-32 scroll-smooth bg-slate-50/50">
        {otherNotes.length === 0 && semanticMatches.length === 0 && !isSemanticSearching ? (
          <div className="flex flex-col items-center justify-center h-64 text-slate-300">
            <BookOpen className="w-12 h-12 mb-3 opacity-10" />
            <p className="font-bold text-sm">
                {isSearching
                    ? (isFetchingAll ? '아직 결과가 없습니다 — 예전 메모를 불러오는 중이에요.' : '검색 결과가 없습니다.')
                    : (tagFilter === 'all' ? '메모가 없습니다.' : `'${CATEGORY_LABELS[tagFilter]}'로 분류된 메모가 없습니다.`)}
            </p>
          </div>
        ) : (
          <>
            {otherNotes.length > 0 && (
                <>
                    <div className="space-y-3">
                         {visibleOtherNotes.map(note => (
                             <NoteCard
                                key={note.id}
                                note={note}
                                onClick={() => onSelectNote(note.id)}
                             />
                         ))}
                    </div>

                    {/* Local Infinite Scroll Trigger */}
                    {visibleCount < otherNotes.length ? (
                        <div ref={observerTarget} className="h-10 flex items-center justify-center">
                            <Loader2 className="w-4 h-4 text-slate-300 animate-spin" />
                        </div>
                    ) : (
                        /* Cloud Pagination Trigger: Only show when local list is exhausted and no search is active */
                        !searchTerm && (onLoadMore || onFetchAll) && (
                            <div className="py-6 flex flex-col items-center justify-center gap-3">
                                {onLoadMore && (
                                    <button
                                        onClick={onLoadMore}
                                        disabled={isLoadingMore}
                                        className="flex items-center gap-2 px-5 py-2.5 bg-white border border-slate-200 rounded-full text-slate-500 text-sm font-medium hover:bg-slate-50 hover:text-accent-600 hover:border-accent-200 transition-all shadow-sm active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed w-full max-w-[280px] justify-center"
                                    >
                                        {isLoadingMore ? <Loader2 className="w-4 h-4 animate-spin" /> : <CloudDownload className="w-4 h-4" />}
                                        {isLoadingMore ? '불러오는 중...' : '클라우드에서 이전 메모 더 불러오기'}
                                    </button>
                                )}

                                {onFetchAll && (
                                    <button
                                        onClick={onFetchAll}
                                        disabled={isLoadingMore}
                                        className="flex items-center gap-2 px-5 py-2.5 bg-accent-50 border border-accent-100 rounded-full text-accent-600 text-sm font-bold hover:bg-accent-100 transition-all shadow-sm active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed w-full max-w-[280px] justify-center"
                                    >
                                        {isLoadingMore ? <Loader2 className="w-4 h-4 animate-spin" /> : <CloudDownload className="w-4 h-4" />}
                                        {isLoadingMore ? '불러오는 중...' : '클라우드 모든 메모 한꺼번에 불러오기'}
                                    </button>
                                )}
                            </div>
                        )
                    )}
                </>
            )}

            {/* 연관 검색 결과: 키워드는 없지만 내용이 비슷한 메모 */}
            {isSearching && (semanticMatches.length > 0 || isSemanticSearching) && (
                <div className={otherNotes.length > 0 ? "pt-5 mt-2 border-t border-slate-100" : ""}>
                    <div className="flex items-center gap-1.5 text-xs font-bold text-accent-600 mb-3 px-1">
                        <Lightbulb className="w-3.5 h-3.5" />
                        연관 메모 <span className="font-normal text-accent-500">— 키워드는 없지만 내용이 비슷한 메모</span>
                        {isSemanticSearching && <Loader2 className="w-3 h-3 animate-spin text-accent-400" />}
                    </div>
                    <div className="space-y-3">
                         {semanticMatches.map(({ note, score }) => (
                             <NoteCard
                                key={note.id}
                                note={note}
                                badge={`관련도 ${Math.round(score * 100)}%`}
                                onClick={() => onSelectNote(note.id)}
                             />
                         ))}
                    </div>
                </div>
            )}
          </>
        )}
      </div>

      {/* Scroll to Top Button */}
      {showScrollTop && (
          <button
            onClick={scrollToTop}
            className="absolute bottom-24 right-6 w-10 h-10 bg-white text-slate-500 rounded-full shadow-md border border-slate-100 flex items-center justify-center transition-all hover:bg-slate-50 active:scale-95 z-40"
            title="맨 위로 가기"
          >
              <ArrowUp className="w-4 h-4" />
          </button>
      )}
    </div>
  );
};

export default NoteList;
