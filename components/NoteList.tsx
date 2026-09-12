
import React, { useState, useMemo, useEffect, useRef } from 'react';
import { Search, BookOpen, Sparkles, Loader2, ArrowUp, CloudDownload, Lightbulb, X } from 'lucide-react';
import { Note } from '../types';
import { embedTexts, cosineSimilarity } from '../services/voyageService';

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
}

// 의미 검색 결과로 인정할 최소 코사인 유사도. Voyage 임베딩 실측치를 보고
// 너무 많이/적게 걸리면 이 값을 조절하세요(낮출수록 더 널널하게 잡힘).
const SEMANTIC_SIMILARITY_THRESHOLD = 0.4;
const SEMANTIC_MAX_RESULTS = 5;

// Optimization: Memoized NoteCard component with content truncation to prevent rendering freezes
const NoteCard = React.memo(({ note, onClick }: { note: Note, onClick: () => void }) => {

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
            className="rounded-lg border p-4 cursor-pointer transition-colors relative bg-white border-slate-200 hover:border-blue-300 hover:bg-slate-50"
        >
            <div className="flex flex-col gap-2">
                <p className="text-sm text-slate-600 leading-normal line-clamp-4 h-auto min-h-[1.5rem]" style={{ wordBreak: 'keep-all', overflowWrap: 'break-word' }}>
                    {previewContent || <span className="text-slate-300 italic">No additional text</span>}
                </p>

                <div className="flex items-center justify-between mt-1.5 pt-1.5 border-t border-slate-100/50">
                    <span className="text-[11px] text-slate-400 font-medium">
                        {new Date(note.createdAt).toLocaleDateString()}
                    </span>
                    {note.summary && (
                        <div className="flex items-center gap-1 text-[11px] text-indigo-400 bg-indigo-50 px-1.5 py-0.5 rounded">
                            <Sparkles className="w-3 h-3" /> Summary
                        </div>
                    )}
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
    embeddingBackfillProgress
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

  // Reset pagination on search change
  useEffect(() => {
      setVisibleCount(20);
  }, [searchTerm]);

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
    if (tokens.length === 0) return notes;

    return notes.filter(note => {
      const haystack = noteSearchIndex.get(note.id) || '';
      return tokens.every(token => haystack.includes(token));
    });
  }, [notes, searchTerm, noteSearchIndex]);

  const otherNotes = textFilteredNotes;

  // --- 의미 기반(임베딩) 검색: 정확히 일치하진 않지만 관련 있을 수 있는 메모 ---
  // 검색어(디바운스된 searchTerm)가 바뀔 때만 실행되며, 실패해도(키 미설정 등)
  // 조용히 무시하고 기존 텍스트 검색 결과만 보여줍니다.
  const [semanticMatches, setSemanticMatches] = useState<Note[]>([]);
  const [isSemanticSearching, setIsSemanticSearching] = useState(false);
  const semanticRequestIdRef = useRef(0);

  useEffect(() => {
      const term = searchTerm.trim();
      if (!term) {
          setSemanticMatches([]);
          setIsSemanticSearching(false);
          return;
      }

      const requestId = ++semanticRequestIdRef.current;
      setIsSemanticSearching(true);

      (async () => {
          try {
              const [queryVector] = await embedTexts([term], 'query');
              if (semanticRequestIdRef.current !== requestId) return; // 이미 새 검색어가 들어옴

              const exactMatchIds = new Set(textFilteredNotes.map(n => n.id));
              const scored = notes
                  .filter(n => n.embedding && !exactMatchIds.has(n.id))
                  .map(n => ({ note: n, score: cosineSimilarity(queryVector, n.embedding) }))
                  .filter(s => s.score >= SEMANTIC_SIMILARITY_THRESHOLD)
                  .sort((a, b) => b.score - a.score)
                  .slice(0, SEMANTIC_MAX_RESULTS)
                  .map(s => s.note);

              if (semanticRequestIdRef.current === requestId) setSemanticMatches(scored);
          } catch (e) {
              console.error("의미 기반 검색 실패(키워드 검색 결과는 정상 동작):", e);
              if (semanticRequestIdRef.current === requestId) setSemanticMatches([]);
          } finally {
              if (semanticRequestIdRef.current === requestId) setIsSemanticSearching(false);
          }
      })();
  }, [searchTerm, notes]);

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
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-slate-400 w-4 h-4 group-focus-within:text-blue-500 transition-colors" />
            <input
                type="text"
                placeholder="검색 (내용, 사진 텍스트, AI 요약 — 여러 단어 가능)..."
                className="w-full pl-10 pr-16 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:bg-white focus:border-blue-300 focus:ring-2 focus:ring-blue-50 transition-all outline-none text-slate-700 text-sm font-medium placeholder:text-slate-400"
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
        {/* 예전 메모에 의미 기반 검색을 적용하는 중이라는 조용한 안내 (막지 않음) */}
        {embeddingBackfillProgress && (
            <p className="text-[11px] text-slate-400 px-1 flex items-center gap-1">
                <Loader2 className="w-3 h-3 animate-spin" />
                검색 기능 업데이트 중... ({embeddingBackfillProgress.done}/{embeddingBackfillProgress.total})
            </p>
        )}
      </div>

      {/* Note List */}
      <div ref={listRef} className="flex-1 overflow-y-auto p-4 space-y-3 pb-32 scroll-smooth bg-slate-50/50">
        {otherNotes.length === 0 && semanticMatches.length === 0 && !isSemanticSearching ? (
          <div className="flex flex-col items-center justify-center h-64 text-slate-300">
            <BookOpen className="w-12 h-12 mb-3 opacity-10" />
            <p className="font-bold text-sm">메모가 없습니다.</p>
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
                                        className="flex items-center gap-2 px-5 py-2.5 bg-white border border-slate-200 rounded-full text-slate-500 text-sm font-medium hover:bg-slate-50 hover:text-blue-600 hover:border-blue-200 transition-all shadow-sm active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed w-full max-w-[280px] justify-center"
                                    >
                                        {isLoadingMore ? <Loader2 className="w-4 h-4 animate-spin" /> : <CloudDownload className="w-4 h-4" />}
                                        {isLoadingMore ? '불러오는 중...' : '클라우드에서 이전 메모 더 불러오기'}
                                    </button>
                                )}

                                {onFetchAll && (
                                    <button
                                        onClick={onFetchAll}
                                        disabled={isLoadingMore}
                                        className="flex items-center gap-2 px-5 py-2.5 bg-blue-50 border border-blue-100 rounded-full text-blue-600 text-sm font-bold hover:bg-blue-100 transition-all shadow-sm active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed w-full max-w-[280px] justify-center"
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

            {/* 의미 기반 검색 결과: 정확히 일치하진 않지만 관련 있을 수 있는 메모 */}
            {searchTerm.trim() && (semanticMatches.length > 0 || isSemanticSearching) && (
                <div className={otherNotes.length > 0 ? "pt-5 mt-2 border-t border-slate-100" : ""}>
                    <div className="flex items-center gap-1.5 text-xs font-bold text-amber-600 mb-3 px-1">
                        <Lightbulb className="w-3.5 h-3.5" />
                        의미상 관련 있을 수 있는 메모
                        {isSemanticSearching && <Loader2 className="w-3 h-3 animate-spin text-amber-400" />}
                    </div>
                    <div className="space-y-3">
                         {semanticMatches.map(note => (
                             <NoteCard
                                key={note.id}
                                note={note}
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
