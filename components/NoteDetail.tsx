
import React, { useMemo, useState, useEffect, useRef } from 'react';
import { ArrowLeft, Calendar, Trash2, Edit, X, Globe, Loader2, Sparkles, ZoomIn, ZoomOut, RotateCcw, Link2, FileText, ShieldCheck, ChevronDown, ChevronUp } from 'lucide-react';
import DOMPurify from 'dompurify';
import { Note, Source, NoteCategory, CATEGORIES, CATEGORY_LABELS, hasCategory } from '../types';
import { marked } from 'marked';
import { summarizeSingleNote, formatMedicalMarkdown, analyzeJournalArticle } from '../services/claudeService';
import { looksLikePaper, isGuidelineCheckCandidate, noteAgeDays, formatAge } from '../services/studyUtils';
import { cosineSimilarity } from '../services/voyageService';
import { buildContentWithSummary, splitMovedContent, contentForAnalysis } from '../services/insightUtils';
import { sectionizeHtml } from '../services/sectionize';
import { estimateDataRecordCount } from '../services/pasteUtils';
import { getNoteFromDB } from '../services/storage';

interface NoteDetailProps {
  note: Note;
  allNotes: Note[];
  onBack: () => void;
  onDelete: (id: string) => void;
  onSelectNote: (id: string) => void;
  onEdit: (note: Note) => void;
  onUpdateNote: (note: Note) => void;
  onSetTag: (id: string, category: NoteCategory) => void; // 누른 분류를 켜고/끄기 (규칙은 types.ts toggleCategory)
  onCheckGuideline: (id: string) => void;
  isCheckingGuideline: boolean;
  onClearGuidelineCheck: (id: string) => void;
}

const NoteDetail: React.FC<NoteDetailProps> = ({ note, allNotes, onBack, onDelete, onSelectNote, onEdit, onUpdateNote, onSetTag, onCheckGuideline, isCheckingGuideline, onClearGuidelineCheck }) => {
  const [viewingImage, setViewingImage] = useState<string | null>(null);
  
  // Progress State
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [progressStatus, setProgressStatus] = useState("");

  // HTML Content State (Async Loading to prevent freeze)
  const [htmlContent, setHtmlContent] = useState('');
  const [isContentRendering, setIsContentRendering] = useState(true);
  // 제목(#·##·###)마다 접기/펼치기 구역으로 바꾼 개수 (2개 이상이면 "모두 펼치기/접기" 표시)
  const [sectionInfo, setSectionInfo] = useState({ sectionCount: 0, dateSectionCount: 0 });
  const contentBoxRef = useRef<HTMLDivElement>(null);
  const setAllSections = (open: boolean) => {
      contentBoxRef.current?.querySelectorAll('details.md-section').forEach(d => {
          if (open) d.setAttribute('open', ''); else d.removeAttribute('open');
      });
  };

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
                const sec = sectionizeHtml(DOMPurify.sanitize(parsed as string));
                setHtmlContent(sec.html);
                setSectionInfo({ sectionCount: sec.sectionCount, dateSectionCount: sec.dateSectionCount });
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

  // 가이드라인 점검 결과 렌더링
  const [guidelineHtml, setGuidelineHtml] = useState('');
  const [guidelineOpen, setGuidelineOpen] = useState(true);
  useEffect(() => {
      let isMounted = true;
      const report = note.guidelineCheck?.report || '';
      if (!report) { setGuidelineHtml(''); return; }
      (async () => {
          try {
              const parsed = await marked.parse(formatMedicalMarkdown(report), { breaks: false, gfm: true });
              if (isMounted) setGuidelineHtml(DOMPurify.sanitize(parsed as string));
          } catch {
              if (isMounted) setGuidelineHtml(DOMPurify.sanitize(report));
          }
      })();
      return () => { isMounted = false; };
  }, [note.guidelineCheck?.report]);
  // 다른 메모로 넘어가면 점검 결과는 다시 펼친 상태로
  useEffect(() => { setGuidelineOpen(true); }, [note.id]);

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
  const isPatientNote = note.tag === 'patient';
  // 요약을 만든 뒤 메모 내용을 고쳤는지 (요약 시각을 기록한 요약만 판단 가능)
  const isSummaryOutdated = !!note.summarizedAt && !!note.updatedAt && note.updatedAt > note.summarizedAt;
  const isDataNote = !isPatientNote && dataRecordCount >= 3;
  const isJournalSummary = note.summaryKind === 'journal';
  const isPaperNote = useMemo(
      () => !isPatientNote && looksLikePaper(`${note.content || ''}\n${note.transcription || ''}`),
      [note.content, note.transcription, isPatientNote]
  );
  const ageDays = noteAgeDays(note, Date.now());
  const isOldCheckable = isGuidelineCheckCandidate(note, Date.now());
  const suggestGuidelineCheck = isOldCheckable && !note.guidelineCheck && !isCheckingGuideline;
  const [showAiMenu, setShowAiMenu] = useState(false);
  useEffect(() => { setShowAiMenu(false); }, [note.id]);

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
      if (note.summaryKind === 'journal' && note.summary && !window.confirm('저널클럽 분석을 일반 AI 요약으로 바꿀까요?')) return;
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
          // 요약을 메모 내용으로 옮긴 메모면, 예전 요약은 빼고 원래 기록만 보냄
          const result = await summarizeSingleNote({ ...note, content: contentForAnalysis(note.content || '') });
          if (result) {
              // SAVE result to DB via onUpdateNote (Persistence)
              // 요약에는 수십 초가 걸릴 수 있어, 그 사이 바뀐 내용(태그 등)을 덮어쓰지 않도록
              // 최신 메모를 다시 읽어서 요약만 얹습니다.
              const latest = (await getNoteFromDB(note.id).catch(() => undefined)) || note;
              const updatedNote = {
                  ...latest,
                  summary: result.summary,
                  sources: result.sources,
                  summarizedAt: Date.now(),
                  summaryKind: undefined, // 일반 요약 (저널클럽 분석을 덮어쓴 경우 표시도 원래대로)
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

  // 저널클럽 준비: 결과를 요약 칸에 저장 (summaryKind: 'journal')
  const [isAnalyzingJournal, setIsAnalyzingJournal] = useState(false);
  const handleJournalClub = async () => {
      if (isSummarizing || isAnalyzingJournal) return;
      if (note.summary && !isJournalSummary && !window.confirm('지금 있는 AI 요약을 저널클럽 분석으로 바꿀까요?')) return;
      setIsAnalyzingJournal(true);
      setProgressStatus("논문 확인 중...");
      const statuses = [
          "연구 설계·결과 정리 중...",
          "비뚤림 위험 평가 중...",
          "기존 연구·가이드라인 찾는 중...",
          "예상 질문 만드는 중...",
          "마무리 정리 중..."
      ];
      let statusIdx = 0;
      statusTimerRef.current = setInterval(() => {
          if (statusIdx < statuses.length) {
              setProgressStatus(statuses[statusIdx]);
              statusIdx++;
          }
      }, 4000);
      try {
          const full = (await getNoteFromDB(note.id).catch(() => undefined)) || note;
          const result = await analyzeJournalArticle({ ...full, content: contentForAnalysis(full.content || '') });
          if (!result) {
              alert("저널클럽 분석을 만들지 못했습니다. 잠시 후 다시 시도해주세요.");
              return;
          }
          // 분석에는 1분 가까이 걸릴 수 있어, 그 사이 바뀐 내용을 덮지 않도록 최신 메모 위에 얹음
          const latest = (await getNoteFromDB(note.id).catch(() => undefined)) || full;
          onUpdateNote({
              ...latest,
              summary: result.summary,
              sources: result.sources,
              summarizedAt: Date.now(),
              summaryKind: 'journal'
          });
      } catch (e: any) {
          console.error(e);
          alert(`저널클럽 분석 중 오류가 발생했습니다: ${e?.message || '알 수 없는 오류'}`);
      } finally {
          if (statusTimerRef.current) clearInterval(statusTimerRef.current);
          setIsAnalyzingJournal(false);
          setProgressStatus("");
      }
  };
  const isBusy = isSummarizing || isAnalyzingJournal;

  // AI 요약을 메모 내용으로 옮기기: 요약이 메모 본문 맨 위로, 원래 메모는 접을 수 있는 블록으로 아래에 남음
  const handleMoveSummaryToContent = async () => {
      if (!note.summary || isBusy) return;
      const already = !!splitMovedContent(note.content || '').originalBlock;
      const msg = already
          ? '메모 맨 위를 지금 요약으로 바꿀까요? 지금 맨 위에 있는 요약(직접 덧붙인 내용 포함)은 접힌 블록 안 "이전에 옮긴 요약"으로 보관되고, 원래 기록도 그대로 남습니다.'
          : 'AI 요약을 메모 내용으로 저장할까요? 요약이 메모 맨 위에 들어가고, 원래 메모는 아래에 접힌 채로 남습니다.';
      if (!window.confirm(msg)) return;
      // 사진까지 포함된 전체 메모를 읽지 못하면 사진이 빠진 채 저장될 수 있어 중단
      const latest = await getNoteFromDB(note.id).catch(() => undefined);
      if (!latest) {
          alert('메모를 불러오지 못해 저장하지 않았습니다. 잠시 후 다시 시도해주세요.');
          return;
      }
      const now = Date.now();
      const label = `원래 메모 보기 (${new Date(now).toLocaleDateString()} ${isJournalSummary ? '저널클럽 분석' : 'AI 요약'}으로 정리)`;
      // 환자 팔로업에서 이미 확인한 상태였다면, 요약을 옮긴 것만으로 "새 기록"이 뜨지 않게 함
      const wasUpToDate = !!latest.followUpCheckedAt && (latest.updatedAt || 0) <= latest.followUpCheckedAt;
      onUpdateNote({
          ...latest,
          content: buildContentWithSummary(latest.content || '', latest.summary || note.summary, latest.sources || [], label),
          summary: '',
          sources: [],
          summaryKind: undefined,
          summarizedAt: now, // 이후 기록을 추가하면 "분석 뒤 기록 추가됨"으로 알 수 있게
          updatedAt: now,
          ...(wasUpToDate ? { followUpCheckedAt: now } : {})
      });
  };

  const handleDeleteSummary = async () => {
      if (window.confirm("AI 요약을 삭제하시겠습니까?")) {
          // 화면에 있는 메모가 사진이 빠진 가벼운 버전일 수도 있어, 저장 전에 전체 메모를 다시 읽음
          const latest = (await getNoteFromDB(note.id).catch(() => undefined)) || note;
          const updatedNote = {
              ...latest,
              summary: '',
              sources: [],
              summaryKind: undefined
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
             {/* AI 도구는 한 버튼(메뉴)으로 모음: 요약 / 저널클럽 준비 / 가이드라인 점검 */}
             <div className="relative">
                <button
                    onClick={() => setShowAiMenu(v => !v)}
                    className={`relative flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-sm font-bold transition-colors ${showAiMenu ? 'bg-indigo-50 text-indigo-600' : 'text-slate-500 hover:text-indigo-600 hover:bg-indigo-50/60'}`}
                    title="AI 도구"
                >
                    {(isBusy || isCheckingGuideline) ? <Loader2 className="w-4 h-4 animate-spin text-indigo-500" /> : <Sparkles className="w-4 h-4" />}
                    AI
                    {suggestGuidelineCheck && (
                        <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-amber-500" />
                    )}
                </button>
                {showAiMenu && (
                    <>
                        <div className="fixed inset-0 z-40" onClick={() => setShowAiMenu(false)} />
                        <div className="absolute right-0 top-full mt-1.5 z-50 w-72 bg-white border border-slate-200 rounded-xl shadow-xl p-1.5 animate-in fade-in slide-in-from-top-1 duration-150">
                            {[
                                {
                                    key: 'summary',
                                    icon: isSummarizing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />,
                                    color: 'text-indigo-600 bg-indigo-50',
                                    label: note.summary && !isJournalSummary ? 'AI 요약 새로 만들기' : 'AI 요약',
                                    desc: isPatientNote ? '케이스 요약·추정/감별 진단·추가 공부' : '메모 종류에 맞춰 요약·정리',
                                    disabled: isBusy,
                                    onClick: handleSummarize,
                                },
                                {
                                    key: 'journal',
                                    icon: isAnalyzingJournal ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />,
                                    color: 'text-violet-600 bg-violet-50',
                                    label: isJournalSummary ? '저널클럽 분석 다시 하기' : '저널클럽 준비',
                                    desc: '설계·결과(NNT)·비뚤림·예상 질문 정리',
                                    disabled: isBusy,
                                    onClick: handleJournalClub,
                                },
                                {
                                    key: 'guideline',
                                    icon: isCheckingGuideline ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />,
                                    color: 'text-emerald-700 bg-emerald-50',
                                    label: isCheckingGuideline ? '가이드라인 점검 중…' : note.guidelineCheck ? '가이드라인 다시 점검' : '최신 가이드라인 점검',
                                    desc: suggestGuidelineCheck ? `${formatAge(ageDays)} 수정한 메모 — 점검 권장` : '수치·권고가 지금도 맞는지 확인',
                                    descClass: suggestGuidelineCheck ? 'text-amber-600' : undefined,
                                    disabled: isCheckingGuideline,
                                    onClick: () => onCheckGuideline(note.id),
                                },
                            ].map(item => (
                                <button
                                    key={item.key}
                                    onClick={() => { setShowAiMenu(false); item.onClick(); }}
                                    disabled={item.disabled}
                                    className="w-full flex items-center gap-3 px-2.5 py-2 rounded-lg text-left hover:bg-slate-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    <span className={`w-8 h-8 shrink-0 rounded-lg flex items-center justify-center ${item.color}`}>{item.icon}</span>
                                    <span className="min-w-0">
                                        <span className="block text-sm font-bold text-slate-800">{item.label}</span>
                                        <span className={`block text-[11px] ${item.descClass || 'text-slate-400'}`}>{item.desc}</span>
                                    </span>
                                </button>
                            ))}
                        </div>
                    </>
                )}
             </div>
             <div className="w-px h-4 bg-slate-200 mx-1"></div>
             <button onClick={() => onEdit(note)} className="text-slate-400 hover:text-blue-500 p-2" title="Edit"><Edit className="w-5 h-5" /></button>
             <button onClick={() => onDelete(note.id)} className="text-slate-400 hover:text-red-500 p-2" title="Delete"><Trash2 className="w-5 h-5" /></button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto bg-slate-50/30">
        <div className="max-w-3xl mx-auto p-4 md:p-6 pb-32">
            
            {/* 날짜 + 분류 태그 한 줄 (다시 누르면 해제) */}
            <div className="mb-6 flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm text-slate-400 flex items-center font-medium"><Calendar className="w-4 h-4 mr-1.5" /> {new Date(note.createdAt).toLocaleString()}</span>
                <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-slate-400">분류</span>
                    <div className="inline-flex p-0.5 bg-slate-100 rounded-lg">
                        {CATEGORIES.map(c => {
                            const on = hasCategory(note, c);
                            const color = c === 'patient' ? 'text-rose-600' : c === 'work' ? 'text-emerald-700' : 'text-blue-600';
                            return (
                                <button
                                    key={c}
                                    onClick={() => onSetTag(note.id, c)}
                                    disabled={isBusy}
                                    className={`px-3 py-1 rounded-md text-xs font-bold transition-colors whitespace-nowrap disabled:opacity-50 ${
                                        on ? `bg-white shadow-sm ${color}` : 'text-slate-500 hover:text-slate-700'
                                    }`}
                                    title={on ? '다시 누르면 분류 해제' : c === 'work' ? "'업무'로 분류 (메모와 함께 고를 수 있음)" : `'${CATEGORY_LABELS[c]}'로 분류`}
                                >
                                    {CATEGORY_LABELS[c]}
                                </button>
                            );
                        })}
                    </div>
                </div>
            </div>

            {/* 가이드라인 점검 결과 */}
            {(note.guidelineCheck || isCheckingGuideline) && (
                <div className={`mb-6 rounded-xl border p-4 ${
                    isCheckingGuideline ? 'bg-emerald-50/50 border-emerald-100'
                    : note.guidelineCheck?.status === 'changed' ? 'bg-amber-50/70 border-amber-200'
                    : note.guidelineCheck?.status === 'ok' ? 'bg-emerald-50/60 border-emerald-100'
                    : 'bg-slate-50 border-slate-200'
                }`}>
                    <div className="flex items-center gap-2">
                        {isCheckingGuideline ? (
                            <>
                                <Loader2 className="w-4 h-4 animate-spin text-emerald-600" />
                                <span className="text-sm font-bold text-emerald-700">최신 가이드라인과 비교하는 중… (30초~1분, 다른 화면에 가도 계속 진행)</span>
                            </>
                        ) : note.guidelineCheck && (
                            <>
                                <span className={`text-sm font-bold ${
                                    note.guidelineCheck.status === 'changed' ? 'text-amber-700'
                                    : note.guidelineCheck.status === 'ok' ? 'text-emerald-700' : 'text-slate-600'
                                }`}>
                                    {note.guidelineCheck.status === 'changed' ? '⚠️ 최신 가이드라인과 달라진 내용 있음'
                                        : note.guidelineCheck.status === 'ok' ? '✅ 최신 가이드라인과 일치' : '❔ 확인이 어려움'}
                                </span>
                                <span className="text-[11px] text-slate-400">{new Date(note.guidelineCheck.checkedAt).toLocaleDateString()} 점검</span>
                                <div className="ml-auto flex items-center gap-1">
                                    <button onClick={() => setGuidelineOpen(o => !o)} className="p-1 text-slate-400 hover:text-slate-600" title={guidelineOpen ? '접기' : '펼치기'}>
                                        {guidelineOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                                    </button>
                                    <button
                                        onClick={() => { if (window.confirm('점검 결과를 지울까요?')) onClearGuidelineCheck(note.id); }}
                                        className="p-1 text-slate-400 hover:text-red-500"
                                        title="점검 결과 삭제"
                                    >
                                        <X className="w-4 h-4" />
                                    </button>
                                </div>
                            </>
                        )}
                    </div>
                    {!isCheckingGuideline && note.guidelineCheck && guidelineOpen && (
                        <>
                            <div
                                className="prose prose-sm prose-slate max-w-none text-slate-700 leading-relaxed mt-3 break-words [&_code]:break-all [&_code]:whitespace-pre-wrap"
                                dangerouslySetInnerHTML={{ __html: guidelineHtml }}
                            />
                            {note.guidelineCheck.sources && note.guidelineCheck.sources.length > 0 && (
                                <div className="flex flex-wrap gap-2 pt-3 mt-3 border-t border-black/5">
                                    {note.guidelineCheck.sources.map((src, idx) => (
                                        <a key={idx} href={src.uri} target="_blank" rel="noopener noreferrer"
                                           className="flex items-center gap-1.5 px-3 py-1.5 bg-white text-emerald-700 rounded-lg text-sm font-medium border border-emerald-100 hover:border-emerald-300 transition-colors shadow-sm">
                                            <Globe className="w-3 h-3" />
                                            <span className="truncate max-w-[180px]">{src.title}</span>
                                        </a>
                                    ))}
                                </div>
                            )}
                            <p className="text-[11px] text-slate-400 mt-3">AI가 웹 검색으로 비교한 결과입니다. 중요한 수치는 인용된 가이드라인 원문에서 한 번 더 확인하세요.</p>
                        </>
                    )}
                </div>
            )}

            {/* 논문으로 보이는 메모: 저널클럽 준비 안내 */}
            {isPaperNote && !note.summary && !isBusy && (
                <button
                    onClick={handleJournalClub}
                    className="w-full mb-6 flex items-start gap-3 text-left bg-violet-50/60 border border-violet-100 rounded-xl p-4 hover:bg-violet-50 transition-colors"
                >
                    <FileText className="w-5 h-5 text-violet-500 shrink-0 mt-0.5" />
                    <div className="min-w-0">
                        <div className="font-bold text-violet-700 text-sm">논문으로 보이는 메모 — 저널클럽 준비 정리</div>
                        <div className="text-xs text-violet-500 mt-1 leading-relaxed">
                            연구 설계(PICO), 핵심 결과(ARR·NNT), 비뚤림 위험, 적용 가능성, 기존 연구·가이드라인과의 관계, 교수님이 물어볼 만한 질문과 답을 정리합니다. 초록만 붙여넣어도 됩니다.
                        </div>
                    </div>
                </button>
            )}

            {/* 환자 메모: 요약이 아직 없으면 케이스 분석(추정·감별 진단, 추가 공부)을 권함 */}
            {isPatientNote && !note.summary && !isBusy && (
                <button
                    onClick={handleSummarize}
                    className="w-full mb-6 flex items-start gap-3 text-left bg-rose-50/60 border border-rose-100 rounded-xl p-4 hover:bg-rose-50 transition-colors"
                >
                    <Sparkles className="w-5 h-5 text-rose-500 shrink-0 mt-0.5" />
                    <div className="min-w-0">
                        <div className="font-bold text-rose-700 text-sm">환자 메모 — AI로 추정·감별 진단, 추가 공부 정리</div>
                        <div className="text-xs text-rose-500 mt-1 leading-relaxed">
                            케이스 요약(날짜별 핵심 수치 추이), 추정 진단과 근거, 감별 진단, 추가로 확인할 것, 이 케이스로 공부할 내용을 정리합니다. 기록을 더 추가한 뒤 다시 누르면 새로 분석해요.
                        </div>
                    </div>
                </button>
            )}

            {/* 기록 묶음 메모: 요약이 아직 없으면 정리 기능을 눈에 띄게 안내 */}
            {isDataNote && !isPaperNote && !note.summary && !isBusy && (
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
            {(note.summary || isBusy) && (
                <div className="mb-6 bg-indigo-50/60 border border-indigo-100 rounded-xl p-4 animate-in fade-in slide-in-from-top-2 relative overflow-hidden">
                    <div className="flex items-center justify-between gap-2 mb-3">
                        <div className="flex flex-wrap items-center gap-2 text-indigo-700 font-bold min-w-0">
                            {isBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : isJournalSummary ? <FileText className="w-4 h-4" /> : <Sparkles className="w-4 h-4" />}
                            <h3 className="text-base uppercase tracking-wide">
                                {isBusy ? progressStatus : isJournalSummary ? 'Journal Club' : 'AI Smart Summary'}
                            </h3>
                            {!isBusy && note.summary && isSummaryOutdated && (
                                <span className="text-[11px] font-bold text-amber-600 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded normal-case tracking-normal">
                                    {isJournalSummary ? '메모 수정 전 분석 · 다시 분석 가능' : '메모 수정 전 요약 · ✨로 새로 요약'}
                                </span>
                            )}
                        </div>
                        {!isBusy && note.summary && isJournalSummary && (
                            <button
                                onClick={handleJournalClub}
                                className="ml-auto mr-1 text-[11px] font-bold text-violet-500 hover:text-violet-700 whitespace-nowrap"
                                title="저널클럽 분석을 새로 만들기"
                            >
                                저널클럽 분석 다시 하기
                            </button>
                        )}
                        {!isBusy && note.summary && isPatientNote && !isJournalSummary && (
                            <button
                                onClick={handleSummarize}
                                className="ml-auto mr-1 text-[11px] font-bold text-rose-500 hover:text-rose-700 whitespace-nowrap"
                                title="환자 메모 기준으로 추정·감별 진단, 추가 공부를 다시 정리"
                            >
                                케이스 분석 다시 하기
                            </button>
                        )}
                        {!isBusy && note.summary && (
                            <button 
                                onClick={handleDeleteSummary}
                                className="p-1.5 text-indigo-400 hover:text-red-500 hover:bg-white rounded-full transition-all"
                                title="요약 삭제"
                            >
                                <X className="w-5 h-5" />
                            </button>
                        )}
                    </div>
                    
                    {isBusy ? (
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
                            <div className="flex justify-end pt-3">
                                <button
                                    onClick={handleMoveSummaryToContent}
                                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white border border-indigo-200 text-indigo-600 hover:bg-indigo-50 text-xs font-bold transition-colors"
                                    title="요약을 메모 본문 맨 위에 넣고, 원래 메모는 아래에 접어서 보관"
                                >
                                    <FileText className="w-3.5 h-3.5" /> 메모 내용으로 저장
                                </button>
                            </div>
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
                <>
                    {sectionInfo.sectionCount >= 2 && (
                        <div className="flex items-center justify-end gap-3 mb-2 text-[11px] font-bold text-slate-400">
                            {sectionInfo.dateSectionCount >= 3 && <span className="mr-auto font-medium">날짜 {sectionInfo.dateSectionCount}개 · 최근 날짜만 펼쳐서 보여줘요</span>}
                            <button onClick={() => setAllSections(true)} className="hover:text-slate-600">모두 펼치기</button>
                            <button onClick={() => setAllSections(false)} className="hover:text-slate-600">모두 접기</button>
                        </div>
                    )}
                    <div
                        ref={contentBoxRef}
                        className="prose prose-base prose-slate max-w-none text-slate-700 leading-relaxed mb-12 prose-headings:font-bold break-words overflow-x-hidden"
                        dangerouslySetInnerHTML={{ __html: htmlContent }}
                    />
                </>
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
