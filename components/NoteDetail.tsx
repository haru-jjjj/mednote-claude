
import React, { useMemo, useState, useEffect, useRef } from 'react';
import { ArrowLeft, Calendar, Trash2, Edit, X, Globe, Loader2, Sparkles, ZoomIn, ZoomOut, RotateCcw, Link2 } from 'lucide-react';
import DOMPurify from 'dompurify';
import { Note, Source } from '../types';
import { marked } from 'marked';
import { summarizeSingleNote, formatMedicalMarkdown } from '../services/claudeService';
import { cosineSimilarity } from '../services/voyageService';
import { estimateDataRecordCount } from '../services/pasteUtils';

interface NoteDetailProps {
  note: Note;
  allNotes: Note[];
  onBack: () => void;
  onDelete: (id: string) => void;
  onSelectNote: (id: string) => void;
  onEdit: (note: Note) => void;
  onUpdateNote: (note: Note) => void;
}

const NoteDetail: React.FC<NoteDetailProps> = ({ note, allNotes, onBack, onDelete, onSelectNote, onEdit, onUpdateNote }) => {
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
              // breaks:false(CommonMark 기본값) — AI가 생성한 요약은 문장 중간에
              // 줄바꿈이 섞여 있어도(특히 web_search 인용 처리 과정에서) 그걸 강제
              // 줄바꿈으로 보여주지 않고 자연스럽게 한 문단으로 이어지도록 합니다.
              // (참고: 위쪽 note.content 렌더링은 사용자가 직접 입력한 글이라
              // Enter로 줄을 바꾸면 그대로 보이는 게 맞아서 breaks:true를 유지합니다.)
              const parsed = await marked.parse(formatted, { breaks: false, gfm: true });
              if (isMounted) setSummaryHtml(DOMPurify.sanitize(parsed as string));
          } catch (e) {
              if (isMounted) setSummaryHtml(note.summary);
          }
      };
      renderSummary();
      return () => { isMounted = false; };
  }, [note.summary]);

  // 관련 메모: 이미 계산되어 저장된 Voyage 임베딩끼리 코사인 유사도만 비교합니다.
  // 추가 API 호출이 전혀 없고(검색/주제 탐구 기능이 이미 계산해 둔 벡터를 재사용),
  // 완전히 클라이언트에서 계산되므로 항상 즉시 표시됩니다.
  const RELATED_NOTES_THRESHOLD = 0.5;
  const RELATED_NOTES_MAX = 5;
  const relatedNotes = useMemo(() => {
      if (!note.embedding || note.embedding.length === 0) return [];
      return allNotes
          .filter(n => n.id !== note.id && n.embedding && n.embedding.length > 0)
          .map(n => ({ note: n, sim: cosineSimilarity(note.embedding, n.embedding) }))
          .filter(r => r.sim >= RELATED_NOTES_THRESHOLD)
          .sort((a, b) => b.sim - a.sim)
          .slice(0, RELATED_NOTES_MAX);
  }, [note.id, note.embedding, allNotes]);

  // 판독문·시술기록·의무기록을 여러 건 붙여넣은 메모인지 형식과 무관하게 대략 판별 → 정리 안내 카드 표시
  const dataRecordCount = useMemo(() => estimateDataRecordCount(note.content || ''), [note.content]);
  const isDataNote = dataRecordCount >= 3;

  const getSnippet = (n: Note) => {
      const text = (n.summary || n.content || '').replace(/[#*`>_-]/g, '').trim();
      return text.length > 60 ? text.slice(0, 60) + '…' : text;
  };

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
      } catch (e: any) {
          console.error(e);
          alert(`요약 생성 중 오류가 발생했습니다: ${e?.message || '알 수 없는 오류'}`);
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

  // --- Full-screen image viewer: zoom & pan ---
  const MIN_ZOOM = 1;
  const MAX_ZOOM = 5;
  const [zoomScale, setZoomScale] = useState(1);
  const [zoomOffset, setZoomOffset] = useState({ x: 0, y: 0 });
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchStateRef = useRef<{ distance: number; scale: number } | null>(null);
  const panStateRef = useRef<{ startX: number; startY: number; offsetX: number; offsetY: number } | null>(null);

  // Reset zoom state whenever the viewer is opened/closed or a new image is shown
  useEffect(() => {
      setZoomScale(1);
      setZoomOffset({ x: 0, y: 0 });
      pointersRef.current.clear();
      pinchStateRef.current = null;
      panStateRef.current = null;
  }, [viewingImage]);

  const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

  const zoomBy = (delta: number) => {
      setZoomScale(prev => {
          const next = clampZoom(prev + delta);
          if (next === 1) setZoomOffset({ x: 0, y: 0 });
          return next;
      });
  };

  const resetZoom = () => {
      setZoomScale(1);
      setZoomOffset({ x: 0, y: 0 });
  };

  const handleWheel = (e: React.WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      zoomBy(e.deltaY > 0 ? -0.3 : 0.3);
  };

  const handleImageDoubleClick = (e: React.MouseEvent) => {
      e.stopPropagation();
      if (zoomScale > 1) {
          resetZoom();
      } else {
          setZoomScale(2.5);
      }
  };

  const getDistance = (p1: { x: number; y: number }, p2: { x: number; y: number }) =>
      Math.hypot(p1.x - p2.x, p1.y - p2.y);

  const handlePointerDown = (e: React.PointerEvent<HTMLImageElement>) => {
      e.stopPropagation();
      (e.target as Element).setPointerCapture?.(e.pointerId);
      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (pointersRef.current.size === 2) {
          const pts = Array.from(pointersRef.current.values());
          pinchStateRef.current = { distance: getDistance(pts[0], pts[1]), scale: zoomScale };
          panStateRef.current = null;
      } else if (pointersRef.current.size === 1 && zoomScale > 1) {
          panStateRef.current = {
              startX: e.clientX,
              startY: e.clientY,
              offsetX: zoomOffset.x,
              offsetY: zoomOffset.y,
          };
      }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLImageElement>) => {
      if (!pointersRef.current.has(e.pointerId)) return;
      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (pointersRef.current.size === 2 && pinchStateRef.current) {
          const pts = Array.from(pointersRef.current.values());
          const newDistance = getDistance(pts[0], pts[1]);
          const ratio = newDistance / (pinchStateRef.current.distance || 1);
          const nextScale = clampZoom(pinchStateRef.current.scale * ratio);
          setZoomScale(nextScale);
          if (nextScale === 1) setZoomOffset({ x: 0, y: 0 });
      } else if (pointersRef.current.size === 1 && panStateRef.current && zoomScale > 1) {
          const dx = e.clientX - panStateRef.current.startX;
          const dy = e.clientY - panStateRef.current.startY;
          setZoomOffset({ x: panStateRef.current.offsetX + dx, y: panStateRef.current.offsetY + dy });
      }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLImageElement>) => {
      pointersRef.current.delete(e.pointerId);
      if (pointersRef.current.size < 2) pinchStateRef.current = null;
      if (pointersRef.current.size === 0) panStateRef.current = null;
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

            {/* 기록 묶음 메모: 요약이 아직 없으면 정리 기능을 눈에 띄게 안내 */}
            {isDataNote && !note.summary && !isSummarizing && (
                <button
                    onClick={handleSummarize}
                    className="w-full mb-6 flex items-start gap-3 text-left bg-indigo-50/60 border border-indigo-100 rounded-xl p-4 hover:bg-indigo-50 transition-colors"
                >
                    <Sparkles className="w-5 h-5 text-indigo-500 shrink-0 mt-0.5" />
                    <div className="min-w-0">
                        <div className="font-bold text-indigo-700 text-sm">붙여넣은 기록 — AI로 묘사·표현 패턴 정리하기</div>
                        <div className="text-xs text-indigo-500 mt-1 leading-relaxed">
                            질환·소견별로 어떤 항목을 중시하는지, 어떤 표현을 자주 쓰는지, 결론 문장을 어떻게 쓰는지 정리합니다. 기록을 더 붙여넣은 뒤 다시 누르면 전체 기준으로 새로 정리돼요.
                        </div>
                    </div>
                </button>
            )}

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

            {/* 관련 메모 (임베딩 기반, 저장된 벡터 재사용 — 추가 API 호출 없음) */}
            {relatedNotes.length > 0 && (
                <div className="mb-12">
                    <p className="text-xs font-bold text-slate-400 uppercase mb-3 flex items-center gap-1.5 tracking-wider">
                        <Link2 className="w-3.5 h-3.5" /> 관련 메모
                    </p>
                    <div className="space-y-2">
                        {relatedNotes.map(({ note: rn }) => (
                            <button
                                key={rn.id}
                                onClick={() => onSelectNote(rn.id)}
                                className="w-full text-left p-3.5 bg-white rounded-xl border border-slate-200 hover:border-indigo-300 hover:shadow-sm transition-all flex items-start gap-3"
                            >
                                <div className="w-8 h-8 shrink-0 rounded-lg bg-indigo-50 text-indigo-500 flex items-center justify-center mt-0.5">
                                    <Link2 className="w-4 h-4" />
                                </div>
                                <div className="min-w-0">
                                    <p className="text-sm font-bold text-slate-800 truncate">{rn.title || '(제목 없음)'}</p>
                                    {getSnippet(rn) && (
                                        <p className="text-xs text-slate-400 mt-0.5 line-clamp-1">{getSnippet(rn)}</p>
                                    )}
                                </div>
                            </button>
                        ))}
                    </div>
                </div>
            )}

        </div>
      </div>

      {/* Full Screen Image Viewer Modal (with zoom & pan) */}
      {viewingImage && (
          <div
            className="fixed inset-0 z-[100] bg-black/90 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-200 overflow-hidden touch-none select-none"
            onClick={() => { if (zoomScale === 1) setViewingImage(null); }}
            onWheel={handleWheel}
          >
             <button
                onClick={() => setViewingImage(null)}
                className="absolute top-4 right-4 p-2 bg-white/10 hover:bg-white/20 text-white rounded-full transition-colors z-50"
                style={{ top: 'calc(env(safe-area-inset-top, 0px) + 1rem)' }}
                title="닫기"
             >
                 <X className="w-6 h-6" />
             </button>

             {/* Zoom Controls */}
             <div
                className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-1 bg-black/50 rounded-full px-2 py-1.5 z-50"
                style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 1rem)' }}
                onClick={(e) => e.stopPropagation()}
             >
                <button
                    onClick={() => zoomBy(-0.5)}
                    disabled={zoomScale <= MIN_ZOOM}
                    className="p-2 text-white disabled:opacity-30 disabled:cursor-not-allowed hover:bg-white/20 rounded-full transition-colors"
                    title="축소"
                >
                    <ZoomOut className="w-5 h-5" />
                </button>
                <span className="text-white text-xs font-medium w-12 text-center select-none">
                    {Math.round(zoomScale * 100)}%
                </span>
                <button
                    onClick={() => zoomBy(0.5)}
                    disabled={zoomScale >= MAX_ZOOM}
                    className="p-2 text-white disabled:opacity-30 disabled:cursor-not-allowed hover:bg-white/20 rounded-full transition-colors"
                    title="확대"
                >
                    <ZoomIn className="w-5 h-5" />
                </button>
                {zoomScale > 1 && (
                    <button
                        onClick={resetZoom}
                        className="p-2 text-white hover:bg-white/20 rounded-full transition-colors ml-1"
                        title="원래 크기로"
                    >
                        <RotateCcw className="w-5 h-5" />
                    </button>
                )}
             </div>

             <img
                src={getImageSrc(viewingImage)}
                alt="Full screen view"
                className={`max-w-full max-h-full object-contain rounded shadow-2xl ${zoomScale > 1 ? 'cursor-grab active:cursor-grabbing' : 'cursor-zoom-in'}`}
                style={{
                    transform: `translate(${zoomOffset.x}px, ${zoomOffset.y}px) scale(${zoomScale})`,
                    transition: pointersRef.current.size > 0 ? 'none' : 'transform 0.15s ease-out',
                    touchAction: 'none',
                }}
                onClick={(e) => e.stopPropagation()}
                onDoubleClick={handleImageDoubleClick}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerUp}
                draggable={false}
             />
          </div>
      )}
    </div>
  );
};

export default NoteDetail;
