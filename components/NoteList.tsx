
import React, { useState, useMemo, useEffect, useRef } from 'react';
import { Search, BookOpen, Sparkles, Loader2, ArrowUp, CloudDownload } from 'lucide-react';
import { Note } from '../types';

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
}

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
    onSearchChange
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

  // Enhanced Text Filter (Includes Summary)
  const textFilteredNotes = useMemo(() => {
    const query = searchTerm.toLowerCase().trim();
    if (!query) return notes;

    return notes.filter(note => {
      const searchFields = [
        note.title,
        note.content,
        note.summary // ADDED: Search in summary
      ].map(f => (f || '').toLowerCase());

      return searchFields.some(field => field.includes(query));
    });
  }, [notes, searchTerm]);

  const otherNotes = textFilteredNotes;

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
                placeholder="검색 (내용, AI 요약)..."
                className="w-full pl-10 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:bg-white focus:border-blue-300 focus:ring-2 focus:ring-blue-50 transition-all outline-none text-slate-700 text-sm font-medium placeholder:text-slate-400"
                value={searchTerm}
                onChange={(e) => onSearchChange(e.target.value)}
            />
        </div>
      </div>

      {/* Note List */}
      <div ref={listRef} className="flex-1 overflow-y-auto p-4 space-y-3 pb-32 scroll-smooth bg-slate-50/50">
        {otherNotes.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-slate-300">
            <BookOpen className="w-12 h-12 mb-3 opacity-10" />
            <p className="font-bold text-sm">메모가 없습니다.</p>
          </div>
        ) : (
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
