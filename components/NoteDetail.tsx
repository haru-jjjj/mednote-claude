
import React, { useMemo, useState, useEffect, useRef } from 'react';
import { ArrowLeft, Calendar, Trash2, Edit, X, Globe, Loader2, Sparkles } from 'lucide-react';
import DOMPurify from 'dompurify';
import { Note, Source } from '../types';
import { marked } from 'marked';
import { summarizeSingleNote, formatMedicalMarkdown } from '../services/claudeService';

interface NoteDetailProps {
  note: Note;
  allNotes: Note[];
  onBack: () => void;
  onDelete: (id: string) => void;
  onSelectNote: (id: string) => void;
  onEdit: (note: Note) => void;
  onUpdateNote: (note: Note) => void;
}

const NoteDetail: React.FC<NoteDetailProps> = ({ note, onBack, onDelete, onEdit, onUpdateNote }) => {
  const [viewingImage, setViewingImage] = useState<string | null>(null);
  
  // Progress State
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [progressStatus, setProgressStatus] = useState("");

  // HTML Content State (Async Loading to prevent freeze)
  const [htmlContent, setHtmlContent] = useState('');
  const [isContentRendering, setIsContentRendering] = useState(true);

  // Async Markdown Parsing
  useEffect(() => {
    let isMounted = true;
    const renderMarkdown = async () => {
        setIsContentRendering(true);
        try {
            // Apply medical formatting before markdown parsing
            const formatted = formatMedicalMarkdown(note.content);
            // marked.parse can be async in v12+
            const parsed = await marked.parse(formatted, { breaks: true, gfm: true });
            if (isMounted) {
                setHtmlContent(DOMPurify.sanitize(parsed as string));
            }
        } catch (e) {
            console.error("Markdown parsing error", e);
            if (isMounted) {
                setHtmlContent(note.content); // Fallback to raw text
            }
        } finally {
            if (isMounted) {
                setIsContentRendering(false);
            }
        }
    };
    renderMarkdown();
    return () => { isMounted = false; };
  }, [note.content]);

  // Async Summary Markdown Rendering
  const [summaryHtml, setSummaryHtml] = useState('');
  useEffect(() => {
      let isMounted = true;
      const renderSummary = async () => {
          if (!note.summary) {
              if (isMounted) setSummaryHtml('');
              return;
          }
          try {
              const formatted = formatMedicalMarkdown(note.summary);
              const parsed = await marked.parse(formatted, { breaks: true, gfm: true });
              if (isMounted) setSummaryHtml(DOMPurify.sanitize(parsed as string));
          } catch (e) {
              if (isMounted) setSummaryHtml(note.summary);
          }
      };
      renderSummary();
      return () => { isMounted = false; };
  }, [note.summary]);

  // Cleanup timers on unmount
  const statusTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
        if (statusTimerRef.current) clearInterval(statusTimerRef.current);
    };
  }, []);

  const handleSummarize = async () => {
      setIsSummarizing(true);
      setProgressStatus("노트 분석 시작...");
      
      // Detailed progress simulation
      const statuses = [
          "이미지 및 텍스트 스캔 중...",
          "의학적 핵심 내용 추출 중...",
          "요약문 작성 및 출처 확인 중...",
          "마무리 정리 중..."
      ];
      let statusIdx = 0;
      
      statusTimerRef.current = setInterval(() => {
          if (statusIdx < statuses.length) {
              setProgressStatus(statuses[statusIdx]);
              statusIdx++;
          }
      }, 1500);

      try {
          const result = await summarizeSingleNote(note);
          if (result) {
              // SAVE result to DB via onUpdateNote (Persistence)
              const updatedNote = {
                  ...note,
                  summary: result.summary,
                  sources: result.sources,
                  isProcessed: true // Mark as AI processed
              };
              onUpdateNote(updatedNote);
          } else {
              alert("요약 정보를 가져오지 못했습니다.");
          }
      } catch (e) {
          console.error(e);
          alert("오류가 발생했습니다.");
      } finally {
          if (statusTimerRef.current) clearInterval(statusTimerRef.current);
          setIsSummarizing(false);
          setProgressStatus("");
      }
  };

  const handleDeleteSummary = () => {
      if (window.confirm("AI 요약을 삭제하시겠습니까?")) {
          const updatedNote = {
              ...note,
              summary: '',
              sources: []
          };
          onUpdateNote(updatedNote);
      }
  };

  // Helper to determine image source (Legacy Base64 or New URL)
  const getImageSrc = (imgString: string) => {
      if (imgString.startsWith('http')) return imgString;
      return `data:image/jpeg;base64,${imgString}`;
  };

  return (
    <div className="h-full bg-white flex flex-col relative animate-in slide-in-from-right duration-300">
      {/* Sticky Header */}
      <div className="h-12 px-3 border-b border-slate-100 flex items-center justify-between bg-white z-50 flex-none sticky top-0">
        <button onClick={onBack} className="flex items-center text-slate-500 hover:text-slate-800 py-2">
            <ArrowLeft className="w-5 h-5 mr-1" /> <span className="text-base font-medium">Back</span>
        </button>
        <div className="flex items-center gap-1 sm:gap-2">
             <button
                onClick={handleSummarize} 
                disabled={isSummarizing}
                className={`text-slate-400 p-2 transition-colors ${isSummarizing ? 'cursor-not-allowed' : 'hover:text-indigo-500'}`} 
                title="AI 요약"
             >
                {isSummarizing ? <Loader2 className="w-5 h-5 animate-spin text-indigo-500" /> : <Sparkles className="w-5 h-5" />}
             </button>
             <div className="w-px h-4 bg-slate-200 mx-1"></div>
             <button onClick={() => onEdit(note)} className="text-slate-400 hover:text-blue-500 p-2" title="Edit"><Edit className="w-5 h-5" /></button>
             <button onClick={() => onDelete(note.id)} className="text-slate-400 hover:text-red-500 p-2" title="Delete"><Trash2 className="w-5 h-5" /></button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto bg-slate-50/30">
        <div className="max-w-3xl mx-auto p-4 md:p-6 pb-32">
            
            <div className="mb-6">
                <div className="flex items-center justify-between mb-3">
                    <span className="text-sm text-slate-400 flex items-center font-medium"><Calendar className="w-4 h-4 mr-1.5" /> {new Date(note.createdAt).toLocaleString()}</span>
                </div>
            </div>

            {/* AI Summary Section */}
            {(note.summary || isSummarizing) && (
                <div className="mb-6 bg-indigo-50/60 border border-indigo-100 rounded-xl p-4 animate-in fade-in slide-in-from-top-2 relative overflow-hidden">
                    <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2 text-indigo-700 font-bold">
                            {isSummarizing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                            <h3 className="text-base uppercase tracking-wide">
                                {isSummarizing ? progressStatus : 'AI Smart Summary'}
                            </h3>
                        </div>
                        {!isSummarizing && note.summary && (
                            <button 
                                onClick={handleDeleteSummary}
                                className="p-1.5 text-indigo-400 hover:text-red-500 hover:bg-white rounded-full transition-all"
                                title="요약 삭제"
                            >
                                <X className="w-5 h-5" />
                            </button>
                        )}
                    </div>
                    
                    {isSummarizing ? (
                        <div className="space-y-2 animate-pulse">
                            <div className="h-5 bg-indigo-200/50 rounded w-3/4"></div>
                            <div className="h-5 bg-indigo-200/50 rounded w-full"></div>
                            <div className="h-5 bg-indigo-200/50 rounded w-5/6"></div>
                        </div>
                    ) : (
                        <>
                            {/* CSS Fix: enforce breaking on code blocks within prose */}
                            <div 
                                className="prose prose-sm prose-indigo max-w-none text-slate-700 leading-relaxed mb-4 break-words [&_code]:break-all [&_code]:whitespace-pre-wrap" 
                                dangerouslySetInnerHTML={{ __html: summaryHtml }} 
                            />
                            
                            {note.sources && note.sources.length > 0 && (
                                <div className="flex flex-wrap gap-2 pt-3 border-t border-indigo-100/50">
                                    {note.sources.map((src, idx) => (
                                        <a 
                                            key={idx} 
                                            href={src.uri} 
                                            target="_blank" 
                                            rel="noopener noreferrer"
                                            className="flex items-center gap-1.5 px-3 py-1.5 bg-white text-indigo-600 rounded-lg text-sm font-medium border border-indigo-100 hover:border-indigo-300 transition-colors shadow-sm"
                                        >
                                            <Globe className="w-3 h-3" />
                                            <span className="truncate max-w-[150px]">{src.title}</span>
                                        </a>
                                    ))}
                                </div>
                            )}
                        </>
                    )}
                </div>
            )}

            {note.images && note.images.length > 0 && (
                <div className="grid grid-cols-2 gap-4 mb-10">
                    {note.images.map((img, idx) => (
                        <div 
                            key={idx} 
                            onClick={() => setViewingImage(img)}
                            className="relative rounded-xl border border-slate-200 shadow-sm overflow-hidden bg-slate-100 cursor-zoom-in group"
                        >
                             <img 
                                src={getImageSrc(img)} 
                                className="w-full h-auto object-cover transition-transform duration-500 group-hover:scale-105" 
                                alt="Note Attachment" 
                             />
                             {/* Number Badge */}
                             <div className="absolute top-2 left-2 px-2 py-0.5 bg-black/60 text-white text-xs font-bold rounded shadow-sm backdrop-blur-sm z-10 pointer-events-none">
                                #{idx + 1}
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {isContentRendering ? (
                <div className="flex flex-col items-center justify-center py-20 opacity-50 space-y-3">
                    <Loader2 className="w-10 h-10 animate-spin text-slate-400" />
                    <span className="text-base text-slate-400">Rendering large content...</span>
                </div>
            ) : (
                <div 
                    className="prose prose-base prose-slate max-w-none text-slate-700 leading-relaxed mb-12 prose-headings:font-bold break-words overflow-x-hidden" 
                    dangerouslySetInnerHTML={{ __html: htmlContent }} 
                />
            )}
            
        </div>
      </div>

      {/* Full Screen Image Viewer Modal */}
      {viewingImage && (
          <div 
            className="fixed inset-0 z-[100] bg-black/90 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-200"
            onClick={() => setViewingImage(null)}
          >
             <button 
                onClick={() => setViewingImage(null)}
                className="absolute top-4 right-4 p-2 bg-white/10 hover:bg-white/20 text-white rounded-full transition-colors z-50"
             >
                 <X className="w-6 h-6" />
             </button>
             <img 
                src={getImageSrc(viewingImage)}
                alt="Full screen view"
                className="max-w-full max-h-full object-contain rounded shadow-2xl"
                onClick={(e) => e.stopPropagation()}
             />
          </div>
      )}
    </div>
  );
};

export default NoteDetail;
