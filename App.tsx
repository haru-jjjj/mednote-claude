
import React, { useState, useEffect, useRef } from 'react';
import { Plus, LayoutGrid, Network, Menu, X, Cloud, Shuffle, Clock, BrainCircuit, Loader2, Upload, Download, Lightbulb, LogOut, MessageSquareText, KeyRound, ShieldCheck, Layers, Sparkles, Search } from 'lucide-react';
import NoteEditor from './components/NoteEditor';
import NoteList, { TagFilter } from './components/NoteList';
import NoteDetail from './components/NoteDetail';
import QuizView from './components/QuizView';
import StudyGuideView from './components/StudyGuideView';
import AskNotesView from './components/AskNotesView';
import GuidelineCheckView from './components/GuidelineCheckView';
import InsightsView from './components/InsightsView';
import ThreadsView from './components/ThreadsView';
import { followUpStatus, contentForAnalysis } from './services/insightUtils';
import { buildPatientIndex, patientIdOf, buildMergedPatientContent, buildAppendedContent } from './services/patientId';
import { hasTrustedDeviceFlag, forgetThisDevice } from './services/authService';
import PinSettingsModal from './components/PinSettingsModal';
import { Note, ViewMode, QuizState, QuizQuestion, QuizLanguage, NoteCategory, toggleCategory, categoryLabels } from './types';
import { localMidnightAfter, scheduleNextReview, isReviewDue, countDueNotes, quizPickWeight, wrongAnswerFromQuestion, upsertWrongAnswer, removeWrongAnswer, questionFromWrongAnswer, WrongAnswerWithNote } from './services/studyUtils';
import { getAllNotesFromDB, saveNoteToDB, deleteNoteFromDB, saveAllNotesToDB, getNoteFromDB, getRecentNotesFromDB } from './services/storage';
import { generateMedicalQuiz, generateOXQuiz, extractTextFromImages, checkNoteAgainstGuidelines } from './services/claudeService';
import { syncNotesFromFirestore, saveNoteToFirestore, updateNoteFieldsInFirestore, hasPendingCloudWrite, hasFailedCloudWrite, isDeletedNoteId, isUnsyncedNote, listUnsyncedNotes, forgetUnsynced, setRemoteDeletedHandler, waitForCloudSave, deleteNoteFromFirestore, fetchOlderNotes, fetchRandomNoteFromFirestore, fetchRandomNotesBatch, fetchAllNotesFromFirestore } from './services/firebaseService';
import { embedTexts, buildNoteEmbeddingText } from './services/voyageService';
import { sanitizeHistory, historyKey, archiveCurrentSummary, trimHistory } from './services/summaryHistory';
import { splitNoteParts, textPartsCached, coverageProgress, pickQuizPart, askedTopicsOf, recordQuizCoverage, sanitizeCoverage } from './services/quizCoverage';
import { isThread, sanitizePending } from './services/threadFormat';

const sanitizeNotes = (rawNotes: any[]): Note[] => {
    if (!Array.isArray(rawNotes)) return [];
    return rawNotes.map((n, index) => {
        const parseDate = (val: any): number => {
            if (typeof val === 'number' && !isNaN(val)) return val;
            if (typeof val === 'string') {
                const parsed = Date.parse(val);
                if (!isNaN(parsed)) return parsed;
            }
            return Date.now();
        };
        return {
            id: typeof n.id === 'string' ? n.id : `restored-${index}-${Date.now()}`,
            title: typeof n.title === 'string' ? n.title : 'Untitled Note',
            content: typeof n.content === 'string' ? n.content : '',
            summary: typeof n.summary === 'string' ? n.summary : '',
            createdAt: parseDate(n.createdAt),
            updatedAt: parseDate(n.updatedAt),
            images: Array.isArray(n.images) ? n.images.filter((img: any) => typeof img === 'string') : [],
            transcription: typeof n.transcription === 'string' ? n.transcription : '',
            sources: Array.isArray(n.sources) ? n.sources : [],
            isProcessed: !!n.isProcessed,
            isEnhancing: false,
            quizMasteryCount: typeof n.quizMasteryCount === 'number' ? n.quizMasteryCount : 0,
            tag: n.tag === 'memo' || n.tag === 'patient' ? n.tag : undefined,
            work: n.work === true ? true : undefined,
            summarizedAt: typeof n.summarizedAt === 'number' ? n.summarizedAt : undefined,
            summaryKind: n.summaryKind === 'journal' ? 'journal' : undefined,
            summaryHistory: sanitizeHistory(n.summaryHistory),
            quizCoverage: sanitizeCoverage(n.quizCoverage),
            kind: n.kind === 'thread' ? 'thread' : undefined,
            threadPending: sanitizePending(n.threadPending),
            quizExcluded: n.quizExcluded === true ? true : undefined,
            reviewDueAt: typeof n.reviewDueAt === 'number' ? n.reviewDueAt : undefined,
            reviewIntervalDays: typeof n.reviewIntervalDays === 'number' ? n.reviewIntervalDays : undefined,
            lastReviewedAt: typeof n.lastReviewedAt === 'number' ? n.lastReviewedAt : undefined,
            wrongAnswers: Array.isArray(n.wrongAnswers)
                ? n.wrongAnswers.filter((w: any) => w && typeof w.id === 'string' && typeof w.question === 'string' && Array.isArray(w.options))
                : undefined,
            guidelineCheck: n.guidelineCheck && typeof n.guidelineCheck.report === 'string' && typeof n.guidelineCheck.checkedAt === 'number'
                ? {
                    checkedAt: n.guidelineCheck.checkedAt,
                    status: ['ok', 'changed', 'uncertain'].includes(n.guidelineCheck.status) ? n.guidelineCheck.status : 'uncertain',
                    report: n.guidelineCheck.report,
                    sources: Array.isArray(n.guidelineCheck.sources) ? n.guidelineCheck.sources : []
                }
                : undefined,
            metaUpdatedAt: typeof n.metaUpdatedAt === 'number' ? n.metaUpdatedAt : undefined,
            origin: n.origin === 'ai' ? 'ai' : undefined,
            followUpCheckedAt: typeof n.followUpCheckedAt === 'number' ? n.followUpCheckedAt : undefined,
            followUpIntervalDays: typeof n.followUpIntervalDays === 'number' ? n.followUpIntervalDays : undefined,
            followUpDueAt: typeof n.followUpDueAt === 'number' ? n.followUpDueAt : undefined,
            handover: n.handover && typeof n.handover === 'object' && Array.isArray(n.handover.refs) && n.handover.sources && typeof n.handover.sources === 'object'
                ? { sources: n.handover.sources, refs: n.handover.refs, updatedAt: Number(n.handover.updatedAt) || 0, purpose: typeof n.handover.purpose === 'string' ? n.handover.purpose : undefined }
                : undefined
        };
    });
};

// 퀴즈에 낼 수 있는 메모: 퀴즈에서 빼지 않았고, 질문 노트라면 답이 하나라도 있는 것
const isQuizEligible = (n: Note) => !n.quizExcluded && (!isThread(n) || /<!-- mt:a \d+ -->/.test(n.content || ''));

// 두 사본 중 a가 더 최신인지: 내용 수정 시각(updatedAt)이 우선, 같으면 부가정보 수정 시각(metaUpdatedAt)
const isNewerCopy = (a: Note, b: Note) => {
    const au = a.updatedAt || 0, bu = b.updatedAt || 0;
    if (au !== bu) return au > bu;
    return (a.metaUpdatedAt || 0) > (b.metaUpdatedAt || 0);
};

const App: React.FC = () => {
  const [view, setView] = useState<ViewMode>(ViewMode.LIST);
  const [notes, setNotes] = useState<Note[]>([]);
  const [showSidebar, setShowSidebar] = useState(true);
  const [lastBackupTime, setLastBackupTime] = useState<number | null>(null);
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  const [isCloudLoading, setIsCloudLoading] = useState(false);

  // Search State - Hoisted for Persistence (단순 텍스트 검색만 사용. AI 시맨틱 검색은 정리 대상으로 제거됨)
  const [searchTerm, setSearchTerm] = useState('');

  // Loading state specifically for Random Note button to prevent double clicks
  const [isRandomLoading, setIsRandomLoading] = useState(false);

  // Track recently shown random notes to prevent repetition.
  const [recentRandomIds, setRecentRandomIds] = useState<string[]>([]);
  
  // Use ref for notes to prevent re-triggering quiz generation on note updates
  const notesRef = useRef<Note[]>(notes);
  // 질문 노트(대화)는 메모 목록·메모 도구에서 빼고 따로 보여줌 (퀴즈·동기화는 함께)
  const memoNotes = React.useMemo(() => notes.filter(n => !isThread(n)), [notes]);
  const threadNotes = React.useMemo(() => notes.filter(isThread), [notes]);
  const [threadsMounted, setThreadsMounted] = useState(false);
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);
  // 메모 활용·퀴즈에서 질문 노트를 열었으면, 질문 노트 목록의 뒤로 가기는 그 화면으로
  const [threadsReturnView, setThreadsReturnView] = useState<ViewMode | null>(null);
  const threadPendingCount = React.useMemo(() => threadNotes.reduce((c, t) => c + (t.threadPending?.length || 0), 0), [threadNotes]);
  useEffect(() => { notesRef.current = notes; }, [notes]);
  // 실시간 동기화 콜백(처음 한 번 만든 함수)에서 현재 화면·열린 메모를 알기 위한 참조
  const viewRef = useRef(view);
  useEffect(() => { viewRef.current = view; }, [view]);
  const activeNoteIdRef = useRef(activeNoteId);
  useEffect(() => { activeNoteIdRef.current = activeNoteId; }, [activeNoteId]);
  // 편집 중에 다른 기기에서 지워져서 화면에만 남겨둔 메모 — 편집을 마치고 나왔는데 저장 안 했으면 정리
  const keptForEditRef = useRef<Set<string>>(new Set());
  useEffect(() => {
      if (view === ViewMode.EDIT || keptForEditRef.current.size === 0) return;
      const ids = Array.from(keptForEditRef.current);
      keptForEditRef.current = new Set();
      (async () => {
          const gone = new Set<string>();
          for (const id of ids) if (!(await getNoteFromDB(id).catch(() => undefined))) gone.add(id);
          if (gone.size === 0) return;
          setNotes(prev => prev.filter(n => !gone.has(n.id)));
          if (activeNoteIdRef.current && gone.has(activeNoteIdRef.current)) {
              setActiveNoteId(null);
              if (viewRef.current === ViewMode.DETAIL) setView(ViewMode.LIST);
          }
      })();
  }, [view]);

  // Quiz State with Queue support
  const [quizState, setQuizState] = useState<QuizState>({
    isActive: false,
    mode: null,
    source: 'RANDOM',
    noMoreQuestions: false,
    language: 'Korean',
    isGenerating: false,
    questionQueue: [],
    currentQuestion: null,
    error: null,
    stats: { correct: 0, total: 0 }
  });
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const quizAbortController = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;

    // 다른 기기에서 지운 메모를 이 기기에서도 지움 (편집 중인 메모는 작성 내용을 잃지 않게 화면에는 남김)
    const removeLocally = async (ids: Set<string>) => {
        if (ids.size === 0) return;
        const editingId = viewRef.current === ViewMode.EDIT ? activeNoteIdRef.current : null;
        if (editingId && ids.has(editingId)) keptForEditRef.current.add(editingId);
        for (const id of ids) await deleteNoteFromDB(id).catch(console.error);
        setNotes(prev => prev.filter(n => !ids.has(n.id) || n.id === editingId));
        if (activeNoteIdRef.current && ids.has(activeNoteIdRef.current) && viewRef.current === ViewMode.DETAIL) {
            setView(ViewMode.LIST);
            setActiveNoteId(null);
        }
    };
    // 저장하려던 메모가 이미 다른 기기에서 지워진 경우(클라우드 저장 직전 확인에서 발견)
    setRemoteDeletedHandler(id => { removeLocally(new Set([id])); });

    // 실시간 동기화 처리: 콜백이 겹쳐도 도착 순서대로
    let syncChain: Promise<void> = Promise.resolve();
    const onRemote = (remoteNotes: Note[]) => {
        syncChain = syncChain.then(async () => {
            // (이 기기에서 지운 메모의 삭제 표시도 처리 — 지운 것이 확실히 반영되도록)
            const live = remoteNotes.filter(r => r.deleted || !isDeletedNoteId(r.id));
            const decisions = await Promise.all(live.map(async r => {
                const local = await getNoteFromDB(r.id).catch(() => undefined);
                // 이 기기 사본을 유지하는 건 "더 최신이면서, 이 기기에서 고치고 아직 클라우드에 못 올린 경우"뿐.
                // (그 외에는 클라우드를 따름 — 기기 시계가 어긋나 다른 기기의 최신 수정을 되돌리는 일 방지)
                const keepLocal = !!local && isNewerCopy(local, r) && (isUnsyncedNote(r.id) || hasPendingCloudWrite(r.id));
                return { r, local, keepLocal };
            }));
            // 다른 기기에서 지운 메모 → 이 기기에서도 지움
            await removeLocally(new Set(decisions.filter(d => !d.keepLocal && d.r.deleted && d.local).map(d => d.r.id)));
            const accepted = decisions.filter(d => !d.keepLocal && !d.r.deleted && !isDeletedNoteId(d.r.id)).map(d => d.r);

            if (accepted.length > 0) {
                setNotes(prevNotes => {
                    const noteMap = new Map<string, Note>();
                    prevNotes.forEach(n => noteMap.set(n.id, n));
                    accepted.forEach(n => noteMap.set(n.id, n));
                    const merged = Array.from(noteMap.values());
                    merged.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
                    return merged;
                });
                await saveAllNotesToDB(accepted).catch(console.error);
            }
            // 이 기기 사본이 더 최신인데 올라가지 않은 메모 → 다시 올림 (보내는 중이거나 이번 세션에 거절된 건 제외)
            decisions
                .filter(d => d.keepLocal && d.local && !hasPendingCloudWrite(d.r.id) && !hasFailedCloudWrite(d.r.id))
                .forEach(d => { saveNoteToFirestore(d.local as Note); });
        }).catch(e => console.error("Sync merge failed", e));
    };

    const initData = async () => {
        try {
            const savedBackupTime = localStorage.getItem('medinote_last_backup');
            if (savedBackupTime) setLastBackupTime(parseInt(savedBackupTime, 10));

            // Fast Track Loading from Local DB
            const recentNotes = await getRecentNotesFromDB(15);
            if (recentNotes.length > 0 && !cancelled) {
                setNotes(recentNotes);
            }

            // Full Load from Local DB
            const dbNotes = await getAllNotesFromDB();
            if (!cancelled) setNotes(dbNotes.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)));
        } catch (e) { console.error("Init failed", e); }

        if (cancelled) return;
        // 기기 저장소를 다 읽은 뒤에 실시간 동기화를 시작 (먼저 시작하면, 동기화로 받은 변경·삭제를
        // 기기 저장소 내용이 뒤늦게 덮어써서 되돌리는 일이 있었음)
        console.log("App: Initializing Firebase Sync...");
        unsubscribe = syncNotesFromFirestore(onRemote);

        // 지난번에 클라우드에 올라가지 못한 변경(앱을 닫았거나 연결이 끊겼던 경우)을 다시 올림
        for (const u of listUnsyncedNotes()) {
            if (u.deleted) { deleteNoteFromFirestore(u.id); continue; }
            const local = await getNoteFromDB(u.id).catch(() => undefined);
            // 클라우드가 더 최신이면 덮지 않고, 확인이 안 되면 다음에 다시 시도
            if (local) saveNoteToFirestore(local, { replay: true });
            else forgetUnsynced(u.id);
        }
    };
    initData();

    return () => { cancelled = true; if (unsubscribe) unsubscribe(); };
  }, []);

  const handleLoadMoreNotes = async () => {
      if (notes.length === 0) return;
      setIsCloudLoading(true);
      try {
          const lastNote = notes[notes.length - 1];
          const olderNotes = await fetchOlderNotes(lastNote.updatedAt || 0);
          
          if (olderNotes.length > 0) {
              setNotes(prev => {
                  const noteMap = new Map<string, Note>();
                  prev.forEach(n => noteMap.set(n.id, n));
                  olderNotes.forEach(n => noteMap.set(n.id, n));
                  const merged = Array.from(noteMap.values());
                  merged.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
                  return merged;
              });
              await saveAllNotesToDB(olderNotes);
          } else {
              alert("더 이상 불러올 메모가 없습니다.");
          }
      } catch (e) {
          console.error("Fetch older notes failed", e);
      } finally {
          setIsCloudLoading(false);
      }
  };

  // opts.silent: 검색 시 자동으로 전체 메모를 불러올 때는 alert 팝업을 띄우지 않습니다.
  // - 이 기기에 있는 메모가 클라우드 것보다 최신이면 그대로 둡니다(덮어쓰지 않음).
  // - 화면(메모리)에는 사진을 뺀 가벼운 버전만 올려서, 첫 검색이 무거워지지 않게 합니다.
  //   (사진은 메모를 열 때 로컬DB에서 다시 읽음)
  const [isFetchingAll, setIsFetchingAll] = useState(false);
  const handleFetchAllNotes = async (opts?: { silent?: boolean }) => {
      setIsCloudLoading(true);
      setIsFetchingAll(true);
      try {
          const fetched = await fetchAllNotesFromFirestore();
          // 다른 기기에서 지운 메모(삭제 표시) → 이 기기에서도 지움 (이 기기에서 그 뒤에 고쳐 아직 못 올린 경우는 제외)
          const tombstones = fetched.filter(n => n.deleted);
          if (tombstones.length > 0) {
              const removeIds = new Set<string>();
              for (const t of tombstones) {
                  const local = await getNoteFromDB(t.id).catch(() => undefined);
                  if (!local) continue;
                  if (isNewerCopy(local, t) && (isUnsyncedNote(t.id) || hasPendingCloudWrite(t.id))) continue;
                  await deleteNoteFromDB(t.id).catch(console.error);
                  removeIds.add(t.id);
              }
              const editingId = viewRef.current === ViewMode.EDIT ? activeNoteIdRef.current : null;
              if (editingId && removeIds.has(editingId)) keptForEditRef.current.add(editingId);
              if (removeIds.size > 0) setNotes(prev => prev.filter(n => !removeIds.has(n.id) || n.id === editingId));
          }
          const allNotes = fetched.filter(n => !n.deleted);
          if (allNotes.length > 0) {
              const localById = new Map(notesRef.current.map(n => [n.id, n]));
              const newerFromCloud = allNotes.filter(n => {
                  const local = localById.get(n.id);
                  // 같은 시각이면(내용 변경 없음) 이 기기 것을 유지 — 동기화 전인 태그·퀴즈 기록 등을 덮지 않도록.
                  // 단, 복습 일정·오답·점검 결과처럼 내용 밖의 정보는 다른 기기에서 더 최근에 바뀌었으면 가져옴.
                  return !local || isNewerCopy(n, local);
              });
              if (newerFromCloud.length > 0) await saveAllNotesToDB(newerFromCloud);
              const lightweight = newerFromCloud.map(({ images, ...rest }) => rest as Note);
              setNotes(prev => {
                  const noteMap = new Map<string, Note>();
                  prev.forEach(n => noteMap.set(n.id, n));
                  lightweight.forEach(n => {
                      const cur = noteMap.get(n.id);
                      if (!cur || isNewerCopy(n, cur)) {
                          // 지금 열려 있는 메모처럼 사진까지 들고 있던 항목은 사진을 잃지 않도록 유지
                          noteMap.set(n.id, cur?.images?.length ? { ...n, images: cur.images } : n);
                      }
                  });
                  const merged = Array.from(noteMap.values());
                  merged.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
                  return merged;
              });
              if (!opts?.silent) alert(`${allNotes.length}개의 메모를 모두 불러왔습니다.`);
              // 새로 들어온 예전 메모들도 연관(의미) 검색에 바로 쓰이도록 임베딩 준비
              setTimeout(() => runEmbeddingBackfill(), 500);
          } else if (!opts?.silent) {
              alert("불러올 메모가 없습니다.");
          }
      } catch (e) {
          console.error("Fetch all notes failed", e);
          if (!opts?.silent) alert("메모를 불러오는 중 오류가 발생했습니다.");
      } finally {
          setIsCloudLoading(false);
          setIsFetchingAll(false);
      }
  };

  // 검색을 처음 사용하는 순간, 또는 AI 주제 탐구 화면을 처음 여는 순간, 화면에
  // 아직 로드되지 않은(오래된) 클라우드 메모까지 검색/임베딩 대상 범위에
  // 포함되도록 전체 메모를 한 번만 자동으로 불러옵니다. (두 트리거가 같은 ref를
  // 공유해서, 검색을 먼저 했든 주제 탐구를 먼저 열었든 전체 불러오기는 딱 한
  // 번만 실행됩니다.)
  const hasAutoFetchedAllRef = useRef(false);
  const triggerAutoFetchAllOnce = () => {
      if (!hasAutoFetchedAllRef.current) {
          hasAutoFetchedAllRef.current = true;
          handleFetchAllNotes({ silent: true });
      }
  };
  useEffect(() => {
      if (searchTerm.trim()) triggerAutoFetchAllOnce();
  }, [searchTerm]);
  useEffect(() => {
      // AI 주제 탐구는 임베딩으로 "관련 메모"를 찾아 주제를 제안/심화하는 기능이라
      // 로컬에 적게 로드된 상태(예: 최근 30개)로는 관련 메모 풀이 너무 작아 사실상
      // 항상 무작위 폴백만 타게 됩니다. 화면을 열자마자 전체 메모를 불러와 임베딩
      // 백필 대상과 클러스터링 후보 풀을 넓혀줍니다.
      // 퀴즈(오늘 복습 수·오답 노트)와 오래된 메모 점검도 전체 메모 기준이라 함께 불러옴
      if (view === ViewMode.STUDY_GUIDE || view === ViewMode.ASK_NOTES || view === ViewMode.QUIZ || view === ViewMode.GUIDELINE_CHECK || view === ViewMode.INSIGHTS || view === ViewMode.THREADS) triggerAutoFetchAllOnce();
  }, [view]);

  // "내 메모에 물어보기" 화면에서 인용된 메모를 열었다가 뒤로 가면, 목록이 아니라 방금 보던
  // 답변 화면으로 돌아오도록 합니다. 답변 화면은 한 번 열면 숨긴 채로 유지해서(언마운트
  // 안 함) 질문·답변 내용이 사라지지 않게 합니다.
  const [showPinSettings, setShowPinSettings] = useState(false);
  // 메모 목록의 분류 필터 (전체/메모/환자) — 메모를 열었다 돌아와도 유지되도록 여기서 관리
  const [tagFilter, setTagFilter] = useState<TagFilter>('all');
  useEffect(() => {
      // 분류로 모아볼 때는 예전 메모까지 포함되도록 전체 메모를 한 번 불러옴
      if (tagFilter !== 'all') triggerAutoFetchAllOnce();
      // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tagFilter]);
  const [askViewMounted, setAskViewMounted] = useState(false);
  // 메모 활용 화면도 한 번 열면 숨긴 채 유지 (결과가 사라지지 않게)
  const [insightsMounted, setInsightsMounted] = useState(false);
  const [returnToAsk, setReturnToAsk] = useState(false);
  // 퀴즈(오답 노트)·오래된 메모 점검 화면에서 메모를 열었으면, 뒤로 가기 시 그 화면으로 돌아감
  const [detailReturnView, setDetailReturnView] = useState<ViewMode | null>(null);
  useEffect(() => {
      if (view === ViewMode.ASK_NOTES) setAskViewMounted(true);
      if (view === ViewMode.INSIGHTS) setInsightsMounted(true);
      if (view === ViewMode.THREADS) setThreadsMounted(true);
      // (답변 화면 → 메모 → 편집 → 저장 → 뒤로 에서도 답변 화면으로 돌아오도록 EDIT도 유지)
      if (view !== ViewMode.DETAIL && view !== ViewMode.ASK_NOTES && view !== ViewMode.EDIT) setReturnToAsk(false);
      if (view !== ViewMode.DETAIL && view !== ViewMode.EDIT && view !== detailReturnView) setDetailReturnView(null);
      // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // --- Voyage 임베딩: 의미 기반 검색 지원 ---
  // Voyage 키가 없거나 호출이 실패해도(네트워크 오류 등) 메모 저장/사용 자체는
  // 절대 막지 않도록, 이 섹션의 실패는 전부 콘솔 로그만 남기고 조용히 무시합니다.
  const [embeddingBackfillProgress, setEmbeddingBackfillProgress] = useState<{ done: number; total: number } | null>(null);
  const isBackfillingEmbeddingsRef = useRef(false);

  // 질문 노트(대화)도 계산 — 메모 활용 > 비슷한 메모 묶기에서 메모와 함께 묶음.
  // 대화는 질문·답변마다 저장되므로 저장 직후가 아니라 백필 때 한 번에 계산(답 없는 질문만 있는 대화는 건너뜀)
  const noteNeedsEmbedding = (n: Note) =>
      !(isThread(n) && !/<!-- mt:a \d+ -->/.test(n.content || ''))
      && (!n.embedding || !n.embeddingUpdatedAt || n.embeddingUpdatedAt < (n.updatedAt || 0));

  // targets에 대해 임베딩을 계산하고 로컬DB/Firestore/화면 상태에 반영합니다.
  // opts.silent가 없으면 실패 시 alert을 띄웁니다(수동 재시도용으로 남겨둠 — 현재는 항상 silent로 호출).
  // 반환값: 성공 여부 (백필 스윕이 키 누락 등 지속적인 실패를 만났을 때 무한 재시도하지 않고
  // 멈추도록 판단하는 용도).
  const embedAndPersistNotes = async (allTargets: Note[], opts?: { silent?: boolean }): Promise<boolean> => {
      const targets = allTargets.filter(n => !isThread(n) || /<!-- mt:a \d+ -->/.test(n.content || ''));
      if (targets.length === 0) return true;
      try {
          const texts = targets.map(buildNoteEmbeddingText);
          const vectors = await embedTexts(texts, 'document');
          const now = Date.now();

          // 중요: 목록 화면의 notes 상태는 메모리 절약을 위해 이미지가 빠진 "가벼운"
          // 버전일 수 있습니다(storage.ts의 getAllNotesFromDB 참고). 그 상태 그대로
          // 저장하면 Firestore/IndexedDB에 있는 원본 이미지를 통째로 덮어써 지워버리게
          // 되므로, 저장 직전에 항상 이미지를 포함한 완전한 노트를 다시 읽어옵니다.
          // (그 사이 삭제된 노트는 undefined가 반환되므로 건너뛰고, 되살리지 않습니다.)
          // 메모별 저장 순서(patchNoteMeta 대기열)를 따라, 최신 메모 위에 임베딩 필드만 얹고
          // 클라우드에도 그 필드만 보냅니다. 화면에도 임베딩 필드만 반영(사진을 메모리로 다시 올리지 않음).
          // 계산하는 동안 내용이 또 바뀌었으면 이번 결과는 버립니다(다음 백필 때 새 내용으로 다시 계산).
          for (let i = 0; i < targets.length; i++) {
              const t = targets[i];
              await patchNoteMeta(t.id, latest => {
                  if ((latest.updatedAt || 0) > (t.updatedAt || 0)) return null;
                  return { embedding: vectors[i], embeddingUpdatedAt: Math.max(now, latest.updatedAt || 0) };
              }, { touchMeta: false });
          }
          return true;
      } catch (e) {
          console.error("임베딩 계산/저장 실패 (검색 기능에만 영향, 메모 자체는 안전합니다):", e);
          if (!opts?.silent) alert("검색용 임베딩 계산 중 오류가 발생했습니다. (Voyage API 키를 확인해주세요)");
          return false;
      }
  };

  // 아직 임베딩이 없거나(예전 메모) 내용이 바뀐 뒤 갱신되지 않은 메모들을 백그라운드에서
  // 조용히 배치로 채워줍니다. 앱 시작 시 + 전체 메모를 새로 불러온 뒤에 실행됩니다.
  // 이미 돌고 있을 때 다시 요청되면, 지금 루프가 끝난 뒤 한 번 더 훑습니다.
  const backfillRerunRef = useRef(false);
  const runEmbeddingBackfill = async () => {
      if (isBackfillingEmbeddingsRef.current) {
          backfillRerunRef.current = true;
          return;
      }
      isBackfillingEmbeddingsRef.current = true;
      const BATCH_SIZE = 32;
      try {
          do {
              backfillRerunRef.current = false;
              let pending = notesRef.current.filter(noteNeedsEmbedding);
              const total = pending.length;
              if (total === 0) continue;

              setEmbeddingBackfillProgress({ done: 0, total });
              let done = 0;
              // 안전장치: 무한 루프 방지용 최대 반복 횟수 + 한 번 시도한 메모는 이번 회차에 다시 보내지 않음
              // (다른 기기 시계가 앞서 있거나, 로컬DB에 없는 메모라 저장이 건너뛰어진 경우 등)
              let iterations = 0;
              let failed = false;
              const attempted = new Set<string>();
              while (pending.length > 0 && iterations < 500) {
                  iterations++;
                  const batch = pending.slice(0, BATCH_SIZE);
                  batch.forEach(n => attempted.add(n.id));
                  const ok = await embedAndPersistNotes(batch, { silent: true });
                  if (!ok) {
                      // 키 미설정 등 지속적인 실패로 보이면, 실패한 배치를 계속
                      // 재시도하며 API를 두드리지 않고 이번 세션에서는 중단합니다.
                      console.warn("임베딩 백필 중단: 배치 처리 실패 (Voyage API 키를 확인해주세요)");
                      failed = true;
                      break;
                  }
                  done += batch.length;
                  setEmbeddingBackfillProgress({ done: Math.min(done, total), total });
                  // 연속 호출 부담을 줄이기 위해 배치 사이에 짧게 대기
                  await new Promise(r => setTimeout(r, 300));
                  pending = notesRef.current.filter(n => noteNeedsEmbedding(n) && !attempted.has(n.id));
              }
              if (failed) break;
          } while (backfillRerunRef.current);
      } finally {
          isBackfillingEmbeddingsRef.current = false;
          setEmbeddingBackfillProgress(null);
      }
  };

  useEffect(() => {
      // 초기 로딩/동기화가 어느 정도 자리잡을 시간을 준 뒤 시작
      const timer = setTimeout(() => { runEmbeddingBackfill(); }, 2000);
      return () => clearTimeout(timer);
      // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pickLocalRandomNote = (currentNotes: Note[], excludeIds: string[]): Note | null => {
      // 퀴즈에서 뺀 메모·질문 노트, 아직 답이 하나도 없는 질문 노트는 제외
      const eligible = currentNotes.filter(isQuizEligible);
      if (eligible.length === 0) return null;
      currentNotes = eligible;
      let candidates = currentNotes.filter(n => !excludeIds.includes(n.id));
      
      if (candidates.length === 0) {
          candidates = currentNotes;
      }
      
      // 가중치 선택: 복습일이 된 메모 > 아직 안 푼 메모 > 복습일이 남은 메모 (services/studyUtils.ts)
      const now = Date.now();
      // 아직 덜 출제된 구역이 많은 메모일수록 더 자주 (메모 전체를 고루 다루도록)
      const itemsWithWeights = candidates.map(note => {
          const uncovered = 1 - coverageProgress(textPartsCached(note), note.quizCoverage).ratio;
          return { note, weight: quizPickWeight(note, now) * (1 + 1.5 * uncovered) };
      });

      // Sum of all weights
      const totalWeight = itemsWithWeights.reduce((sum, item) => sum + item.weight, 0);
      let randomVal = Math.random() * totalWeight;

      for (const item of itemsWithWeights) {
          randomVal -= item.weight;
          if (randomVal <= 0) {
              return item.note;
          }
      }

      // Fallback
      return candidates[Math.floor(Math.random() * candidates.length)];
  };

  // 퀴즈 세션 번호: 이전 세션에서 늦게 도착한 문제/오류가 새 세션에 섞이지 않게 합니다.
  const quizSessionRef = useRef(0);
  // "오늘의 복습" 세션에서 이미 문제를 만든 메모 (같은 메모로 두 번 내지 않도록)
  const reviewUsedIdsRef = useRef<Set<string>>(new Set());
  // 이번 세션에서 이미 문제를 만든(아직 안 푼 것 포함) 구역 — 미리 만들어 두는 문제가 같은 구역에서 겹치지 않게
  const reservedPartsRef = useRef<Map<string, Set<string>>>(new Map());

  useEffect(() => {
    // Background Quiz Generation Logic
    if (!quizState.isActive || !quizState.mode) return;
    // 오답 다시 풀기는 저장된 문제만 쓰고, 복습 대상이 바닥나면 더 만들지 않음
    if (quizState.source === 'WRONG' || quizState.noMoreQuestions) return;

    const BUFFER_SIZE = quizState.mode === 'QUICK_OX' ? 2 : 1;
    if (quizState.questionQueue.length >= BUFFER_SIZE || quizState.isGenerating || quizState.error) return;

    const session = quizSessionRef.current;
    const setIfCurrent = (fn: (prev: QuizState) => QuizState) =>
        setQuizState(prev => (quizSessionRef.current === session ? fn(prev) : prev));

    const fetchNext = async () => {
        if (quizState.isGenerating) return;
        setIfCurrent(prev => ({ ...prev, isGenerating: true, error: null }));
        
        try {
            // Small delay to allow UI to settle on mobile and ensure environment is ready
            await new Promise(resolve => setTimeout(resolve, 300));
            // 그 사이 세션이 끝났거나 새로 시작됐으면 이 요청은 버림(복습 대상 소모·유료 호출 방지)
            if (quizSessionRef.current !== session) return;
            
            // 세션이 바뀐 뒤 늦게 끝난 요청이 새 세션의 기록을 건드리지 않도록 지금 세션의 것을 잡아 둠
            const reservedMap = reservedPartsRef.current;
            const reviewUsed = reviewUsedIdsRef.current;
            const skipIds: string[] = []; // 낼 내용이 없는 메모 (이번 요청에서 건너뜀)

            let fullNote: Note | null = null;
            let parts: ReturnType<typeof splitNoteParts> = [];
            let part: ReturnType<typeof pickQuizPart> = null;

            // 낼 내용이 없는 메모(빈 메모 등)는 건너뛰고 최대 3번까지 다른 메모로
            for (let attempt = 0; attempt < 3 && !part; attempt++) {
                let focusNote: Note | null = null;
                if (quizState.source === 'REVIEW') {
                    // 오늘의 복습: 복습일이 된 메모를 가장 오래 밀린 것부터 한 개씩 (메모 1개 = 문제 1개)
                    const now = Date.now();
                    const due = notesRef.current
                        .filter(n => isReviewDue(n, now) && !reviewUsed.has(n.id) && isQuizEligible(n))
                        .sort((a, b) => (a.reviewDueAt || 0) - (b.reviewDueAt || 0));
                    if (due.length === 0) {
                        setIfCurrent(prev => ({ ...prev, isGenerating: false, noMoreQuestions: true }));
                        return;
                    }
                    reviewUsed.add(due[0].id);
                    focusNote = due[0];
                } else {
                    // 문제 하나에 메모 하나: 복습일·안 푼 메모·덜 출제된 메모 우선 (최근에 낸 메모는 잠시 제외)
                    const exclude = [...recentRandomIds, ...skipIds];
                    if (notesRef.current.length > 0) {
                        focusNote = pickLocalRandomNote(notesRef.current, exclude);
                    }
                    // 기기에 메모가 없으면(새 기기 등) 클라우드에서
                    if (!focusNote) {
                         const cloudNotes = (await fetchRandomNotesBatch(1, exclude, notesRef.current)).filter(isQuizEligible);
                         focusNote = cloudNotes[0] || null;
                    }
                }

                if (!focusNote) {
                     setIfCurrent(prev => ({ 
                         ...prev, 
                         isGenerating: false, 
                         error: notesRef.current.length === 0 ? "작성된 메모가 없습니다. 먼저 메모를 작성해주세요." : "문제를 생성할 메모를 찾지 못했습니다."
                     }));
                     return;
                }

                // 사진까지 있는 전체 메모로 구역을 나누고, 아직 덜 나온 구역을 고름
                fullNote = (await getNoteFromDB(focusNote.id).catch(() => undefined)) || focusNote;
                if (quizSessionRef.current !== session) return;
                parts = splitNoteParts(fullNote);
                part = pickQuizPart(parts, fullNote.quizCoverage, reservedMap.get(fullNote.id));
                if (!part) skipIds.push(fullNote.id);
            }

            if (!part || !fullNote) {
                setIfCurrent(prev => ({ ...prev, isGenerating: false, error: "문제로 낼 내용이 있는 메모를 찾지 못했습니다. 다시 시도해주세요." }));
                return;
            }
            const focusId = fullNote.id;
            if (quizState.source !== 'REVIEW') {
                setRecentRandomIds(prev => [focusId, ...skipIds, ...prev.filter(id => id !== focusId && !skipIds.includes(id))].slice(0, 50));
            }
            const reserved = reservedMap.get(focusId) || new Set<string>();
            reserved.add(part.key);
            reservedMap.set(focusId, reserved);

            const { images: _omit, ...lightNote } = fullNote;
            const focus = {
                note: lightNote as Note,
                part,
                partIndex: parts.indexOf(part),
                partCount: parts.length,
                outline: parts.map(p => p.label),
                askedTopics: askedTopicsOf(fullNote.quizCoverage, part.key),
                image: part.kind === 'image' && typeof part.imageIndex === 'number' ? (fullNote.images || [])[part.imageIndex] : undefined
            };

            let question: QuizQuestion | null = null;
            if (quizState.mode === 'DETAILED') {
                question = await generateMedicalQuiz(focus, quizState.language);
            } else {
                question = await generateOXQuiz(focus, quizState.language);
            }
            // 실패하면 그 구역은 다시 고를 수 있게
            if (!question) reserved.delete(part.key);

            if (question) {
                setIfCurrent(prev => {
                    if (!prev.isActive || prev.mode !== quizState.mode) return prev;
                    if (!prev.currentQuestion) {
                        return {
                            ...prev,
                            isGenerating: false,
                            currentQuestion: question,
                            error: null
                        };
                    } 
                    return {
                        ...prev,
                        isGenerating: false,
                        questionQueue: [...prev.questionQueue, question],
                        error: null
                    };
                });
            } else {
                 setIfCurrent(prev => ({ ...prev, isGenerating: false, error: "AI가 문제를 생성하는 데 실패했습니다. 다시 시도해주세요." })); 
            }

        } catch (e: any) {
            console.error("BG Gen Error", e);
            let errorMsg = "네트워크 연결이 불안정합니다. 잠시 후 다시 시도해주세요.";
            
            if (e && typeof e === 'object') {
                const msg = e.message || "";
                if (msg.includes("API Key")) {
                    errorMsg = "API 설정에 문제가 있습니다. 관리자에게 문의하거나 잠시 후 다시 시도해주세요.";
                } else if (msg.includes("Quota") || msg.includes("429")) {
                    errorMsg = "AI 사용량이 많아 잠시 제한되었습니다. 잠시 후 다시 시도해주세요.";
                } else if (msg.includes("Safety") || msg.includes("blocked")) {
                    errorMsg = "AI가 해당 내용을 분석할 수 없습니다. 다른 메모로 시도해주세요.";
                }
            }
            
            setIfCurrent(prev => ({ ...prev, isGenerating: false, error: errorMsg }));
        }
    };

    fetchNext();

  }, [quizState.isActive, quizState.mode, quizState.source, quizState.noMoreQuestions, quizState.questionQueue.length, quizState.isGenerating, quizState.currentQuestion, quizState.language, quizState.error, recentRandomIds]);


  const handleStartQuiz = React.useCallback((mode: 'DETAILED' | 'QUICK_OX', language: QuizLanguage, source: 'RANDOM' | 'REVIEW' = 'RANDOM') => {
      quizSessionRef.current += 1;
      reviewUsedIdsRef.current = new Set();
      reservedPartsRef.current = new Map();
      setQuizState({
          isActive: true,
          mode: mode,
          source,
          noMoreQuestions: false,
          language: language,
          isGenerating: false,
          questionQueue: [],
          currentQuestion: null,
          error: null,
          stats: { correct: 0, total: 0 }
      });
  }, []);

  // 오답 노트 다시 풀기: 저장된 문제를 그대로 다시 냄 (AI 호출 없음)
  const handleStartWrongReview = (entries: WrongAnswerWithNote[]) => {
      if (entries.length === 0) return;
      quizSessionRef.current += 1;
      const questions = entries.map(questionFromWrongAnswer);
      setQuizState({
          isActive: true,
          mode: questions[0].type === 'OX' ? 'QUICK_OX' : 'DETAILED',
          source: 'WRONG',
          noMoreQuestions: true,
          language: entries[0].language || 'Korean',
          isGenerating: false,
          questionQueue: questions.slice(1),
          currentQuestion: questions[0],
          error: null,
          stats: { correct: 0, total: 0 }
      });
  };

  // 메모의 "내용 밖 정보"(복습 일정·오답·점검 결과)만 바꿀 때 쓰는 저장 함수.
  // - 저장 직전에 최신 메모(사진 포함)를 다시 읽어 그 위에 바뀐 필드만 얹습니다.
  // - 같은 메모에 대한 변경은 순서대로 처리해서 서로 덮어쓰지 않게 합니다.
  // - updatedAt은 건드리지 않아 목록 순서·요약 상태가 바뀌지 않고, 임베딩 재계산도 없습니다.
  const metaQueueRef = useRef<Map<string, Promise<unknown>>>(new Map());
  // - 클라우드에는 바뀐 필드만 보냅니다(다른 기기에서 바뀐 나머지 필드를 덮지 않도록).
  // - opts.touchMeta=false: 임베딩처럼 기기 간 병합 기준(metaUpdatedAt)을 바꾸지 않을 값.
  const patchNoteMeta = (id: string, makePatch: (latest: Note) => Partial<Note> | null, opts?: { touchMeta?: boolean }): Promise<Note | null> => {
      const prev = metaQueueRef.current.get(id) || Promise.resolve();
      const run: Promise<Note | null> = prev.catch(() => undefined).then(async () => {
          const latest = await getNoteFromDB(id).catch(() => undefined);
          if (!latest) return null;
          const basePatch = makePatch(latest);
          if (!basePatch) return null;
          const patch: Partial<Note> = opts?.touchMeta === false ? basePatch : { ...basePatch, metaUpdatedAt: Date.now() };
          const updated: Note = { ...latest, ...patch };
          await saveNoteToDB(updated);
          updateNoteFieldsInFirestore(id, patch);
          setNotes(p => p.map(n => n.id === id ? { ...n, ...patch } : n));
          return updated;
      });
      metaQueueRef.current.set(id, run);
      const cleanup = () => { if (metaQueueRef.current.get(id) === run) metaQueueRef.current.delete(id); };
      run.then(cleanup, cleanup);
      return run;
  };

  const handleNextQuestion = async (wasCorrect: boolean, chosenIndex: number | null) => {
      const q = quizState.currentQuestion;
      const source = quizState.source;
      const language = quizState.language;

      // 화면은 바로 다음 문제로 (저장은 뒤에서)
      setQuizState(prev => {
          const nextQ = prev.questionQueue.length > 0 ? prev.questionQueue[0] : null;
          const remainingQueue = prev.questionQueue.slice(1);
          
          return {
              ...prev,
              currentQuestion: nextQ, 
              questionQueue: remainingQueue,
              stats: {
                  total: prev.stats.total + 1,
                  correct: prev.stats.correct + (wasCorrect ? 1 : 0)
              }
          };
      });

      if (!q) return;
      const now = Date.now();
      try {
          if (source === 'WRONG' || q.replayOfNoteId) {
              // 오답 다시 풀기: 맞히면 오답 노트에서 빼고, 또 틀리면 횟수만 올림 (복습 일정은 그대로)
              const holderId = q.replayOfNoteId;
              if (holderId) {
                  await patchNoteMeta(holderId, latest => ({
                      wrongAnswers: wasCorrect
                          ? removeWrongAnswer(latest.wrongAnswers, q.id)
                          : upsertWrongAnswer(latest.wrongAnswers, wrongAnswerFromQuestion(q, chosenIndex ?? -1, now, language))
                  }));
              }
              return;
          }

          // 새 문제: 출제에 쓰인 메모의 다음 복습일을 잡고, 틀렸으면 오답 노트에 저장(첫 메모에 보관)
          const ids = q.relatedNoteIds || [];
          for (let i = 0; i < ids.length; i++) {
              await patchNoteMeta(ids[i], latest => {
                  const patch: Partial<Note> = {
                      quizMasteryCount: wasCorrect ? (latest.quizMasteryCount || 0) + 1 : 0,
                      ...scheduleNextReview(latest.reviewIntervalDays, wasCorrect, now)
                  };
                  // 출제 범위 기록: 이 구역에서 문제 1개를 냈고, 이런 요점을 다뤘음
                  if (q.coverage && q.coverage.noteId === ids[i]) {
                      patch.quizCoverage = recordQuizCoverage(
                          latest.quizCoverage,
                          splitNoteParts(latest).map(p => p.key),
                          q.coverage.partKey,
                          q.coverage.topic,
                          now
                      );
                  }
                  if (!wasCorrect && i === 0) {
                      patch.wrongAnswers = upsertWrongAnswer(latest.wrongAnswers, wrongAnswerFromQuestion(q, chosenIndex ?? -1, now, language));
                  }
                  return patch;
              });
          }
      } catch (e) {
          console.error("Failed to save review result", e);
      }
  };

  // 문제 생성 실패 후 "다시 시도": 세션(점수·복습 진행)은 유지하고 오류만 지워서 다음 문제를 만듦.
  // 오늘의 복습에서는 실패한 메모를 건너뛰고 다음 메모로 넘어갑니다.
  const handleRetryQuiz = () => {
      setQuizState(prev => ({ ...prev, error: null, isGenerating: false }));
  };

  const handleDeleteWrongAnswer = (noteId: string, questionId: string) => {
      patchNoteMeta(noteId, latest => ({ wrongAnswers: removeWrongAnswer(latest.wrongAnswers, questionId) }))
          .catch(e => { console.error(e); alert('오답 삭제에 실패했습니다.'); });
  };

  const handleStopQuiz = () => {
      quizSessionRef.current += 1;
      setQuizState(prev => ({ ...prev, isActive: false, mode: null, currentQuestion: null, questionQueue: [], isGenerating: false, error: null, noMoreQuestions: false }));
      setView(ViewMode.LIST);
  };

  // 세션만 끝내고 퀴즈 첫 화면(오늘의 복습·오답 노트)에 머무름
  const handleEndQuizSession = () => {
      quizSessionRef.current += 1;
      setQuizState(prev => ({ ...prev, isActive: false, mode: null, currentQuestion: null, questionQueue: [], isGenerating: false, error: null, noMoreQuestions: false }));
  };

  // 오늘 복습할 메모 수 (자정이 지나면 갱신되도록 몇 분마다 시각을 새로 읽음)
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
      const t = setInterval(() => setNowTick(Date.now()), 5 * 60 * 1000);
      const onVisible = () => { if (document.visibilityState === 'visible') setNowTick(Date.now()); };
      document.addEventListener('visibilitychange', onVisible);
      return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVisible); };
  }, []);
  const reviewDueCount = React.useMemo(() => countDueNotes(notes.filter(n => !n.quizExcluded), nowTick), [notes, nowTick]);

  // --- 오래된 메모 가이드라인 점검 (화면을 벗어나도 계속 진행되도록 여기서 관리) ---
  const [guidelineCheckingIds, setGuidelineCheckingIds] = useState<string[]>([]);
  // 점검 화면의 필터 (메모를 열었다 돌아와도 유지)
  const [guidelineFilter, setGuidelineFilter] = useState<'todo' | 'changed' | 'all'>('todo');
  const guidelineCheckingRef = useRef<Set<string>>(new Set());
  const handleCheckGuideline = async (id: string) => {
      if (guidelineCheckingRef.current.has(id)) return;
      guidelineCheckingRef.current.add(id);
      setGuidelineCheckingIds(Array.from(guidelineCheckingRef.current));
      try {
          const full = (await getNoteFromDB(id).catch(() => undefined)) || notesRef.current.find(n => n.id === id);
          if (!full) throw new Error('메모를 찾을 수 없습니다.');
          const result = await checkNoteAgainstGuidelines({ ...full, content: contentForAnalysis(full.content || '') });
          const saved = await patchNoteMeta(id, () => ({ guidelineCheck: result }));
          if (!saved) throw new Error('결과를 저장하지 못했습니다(메모가 삭제되었을 수 있음).');
      } catch (e: any) {
          console.error("Guideline check failed", e);
          alert(`가이드라인 점검 중 오류가 발생했습니다: ${e?.message || '알 수 없는 오류'}`);
      } finally {
          guidelineCheckingRef.current.delete(id);
          setGuidelineCheckingIds(Array.from(guidelineCheckingRef.current));
      }
  };
  // 환자 팔로업 "확인함": 지금 확인했고, intervalDays일 뒤에 다시 확인할 차례로
  const handleFollowUpCheck = (id: string, intervalDays: number) => {
      const now = Date.now();
      patchNoteMeta(id, () => ({
          followUpCheckedAt: now,
          followUpIntervalDays: intervalDays,
          followUpDueAt: localMidnightAfter(now, intervalDays)
      })).catch(e => { console.error(e); alert('확인 기록 저장에 실패했습니다.'); });
  };
  // 사이드바 "메모 활용" 옆에 표시할, 지금 확인할 차례인 환자 메모 수
  const patientFollowUpDue = React.useMemo(
      () => notes.filter(n => n.tag === 'patient' && n.origin !== 'ai' && followUpStatus(n, nowTick) === 'due').length,
      [notes, nowTick]
  );

  const handleClearGuidelineCheck = (id: string) => {
      patchNoteMeta(id, () => ({ guidelineCheck: undefined })).catch(console.error);
  };


  const handleExportBackup = async () => {
      // (Existing Export Logic)
      try {
        if (notes.length === 0) {
            alert("백업할 메모가 없습니다.");
            return;
        }
        const allFullNotes: Note[] = [];
        for (const n of notes) {
            const full = await getNoteFromDB(n.id);
            if (full) allFullNotes.push(full);
        }
        const now = new Date();
        const y = now.getFullYear();
        const m = String(now.getMonth() + 1).padStart(2, '0');
        const d = String(now.getDate()).padStart(2, '0');
        const hh = String(now.getHours()).padStart(2, '0');
        const mm = String(now.getMinutes()).padStart(2, '0');
        
        const fileName = `medinote_backup_${y}${m}${d}_${hh}${mm}.json`;
        const dataStr = JSON.stringify(allFullNotes, null, 2);
        
        let shareSuccess = false;
        try {
            if (navigator.share && navigator.canShare) {
                const file = new File([dataStr], fileName, { type: 'application/json' });
                if (navigator.canShare({ files: [file] })) {
                    await navigator.share({
                        files: [file],
                        title: 'MediNote Backup',
                    });
                    shareSuccess = true;
                }
            }
        } catch (err) {
            if ((err as Error).name === 'AbortError') return;
        }

        if (!shareSuccess) {
            const blob = new Blob([dataStr], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = fileName;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            setTimeout(() => URL.revokeObjectURL(url), 100);
        }
        const backupTimestamp = now.getTime();
        setLastBackupTime(backupTimestamp);
        localStorage.setItem('medinote_last_backup', backupTimestamp.toString());
    } catch (e) {
        alert("백업 파일 생성에 실패했습니다.");
    }
  };

  const handleExportCSV = async () => {
      // (Existing CSV Export Logic)
      try {
        if (notes.length === 0) {
            alert("내보낼 메모가 없습니다.");
            return;
        }
        const allFullNotes: Note[] = [];
        for (const n of notes) {
            const full = await getNoteFromDB(n.id);
            if (full) allFullNotes.push(full);
        }
        const headers = ['Title', 'Tag', 'Content', 'Created At', 'Updated At'];
        const csvRows = [headers.join(',')];
        for (const note of allFullNotes) {
            const escapeCsv = (str: string) => {
                if (!str) return '""';
                return `"${str.replace(/"/g, '""')}"`;
            };
            const title = escapeCsv(note.title);
            const content = escapeCsv(note.content);
            const createdAt = escapeCsv(new Date(note.createdAt).toISOString());
            const updatedAt = escapeCsv(note.updatedAt ? new Date(note.updatedAt).toISOString() : new Date(note.createdAt).toISOString());
            const tag = escapeCsv(categoryLabels(note).join('+'));
            csvRows.push([title, tag, content, createdAt, updatedAt].join(','));
        }
        const csvString = csvRows.join('\n');
        const blob = new Blob(['\uFEFF' + csvString], { type: 'text/csv;charset=utf-8;' });
        const now = new Date();
        const y = now.getFullYear();
        const m = String(now.getMonth() + 1).padStart(2, '0');
        const d = String(now.getDate()).padStart(2, '0');
        const hh = String(now.getHours()).padStart(2, '0');
        const fileName = `medinote_export_${y}${m}${d}_${hh}.csv`;
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(() => URL.revokeObjectURL(url), 100);
    } catch (e) {
        console.error("CSV Export Error", e);
        alert("CSV 내보내기 중 오류가 발생했습니다.");
    }
  };

  const handleOpenFilePicker = () => {
    fileInputRef.current?.click();
  };

  const handleFetchAndSelectNote = async (id: string) => {
      try {
          const fullNote = await getNoteFromDB(id);
          if (fullNote) {
              setNotes(prev => prev.map(n => n.id === id ? fullNote : n));
              setActiveNoteId(id);
              setView(ViewMode.DETAIL);
          } else {
              alert("메모를 불러올 수 없습니다.");
          }
      } catch (e) {
          console.error("Failed to load note details", e);
          alert("메모 로딩 중 오류가 발생했습니다.");
      }
  };

  const handleRandomNote = async () => {
    if (isRandomLoading) return;
    setIsRandomLoading(true);
    
    try {
        let randomNote: Note | null = null;

        // PRIORITY 1: LOCAL NOTES (Truly random selection)
        // If the user has notes synced locally, picking from here is mathematically better for randomness
        // than querying cloud cursors which might fail or repeat in sparse datasets.
        if (memoNotes.length > 0) {
            randomNote = pickLocalRandomNote(memoNotes, recentRandomIds);
        }

        // PRIORITY 2: CLOUD FALLBACK
        // Only if local notes are empty (e.g., initial load not finished, or truly empty device)
        if (!randomNote) {
             const randomNotes = (await fetchRandomNotesBatch(1, recentRandomIds, notes)).filter(n => !isThread(n));
             if (randomNotes.length > 0) randomNote = randomNotes[0];
        }
        
        if (randomNote) {
             // If local lightweight note, ensure we load full details (images)
             if (!randomNote.images || randomNote.images.length === 0) {
                 const fullNote = await getNoteFromDB(randomNote.id);
                 if (fullNote) {
                     randomNote = fullNote;
                 }
             }

             setRecentRandomIds(prev => {
                 const updated = [randomNote!.id, ...prev];
                 // INCREASED HISTORY SIZE: 50
                 return updated.slice(0, 50);
             });

             setNotes(prev => {
                 const exists = prev.some(n => n.id === randomNote!.id);
                 if (exists) {
                     return prev.map(n => n.id === randomNote!.id ? randomNote! : n);
                 }
                 return [randomNote!, ...prev];
             });
             
             setActiveNoteId(randomNote.id);
             setView(ViewMode.DETAIL);
             
             if (window.innerWidth < 768) setShowSidebar(false);
        } else {
             alert("메모가 충분하지 않습니다. 새 메모를 작성해보세요!");
        }
    } catch (e) {
        console.error("Random Note Fetch Failed", e);
        alert("랜덤 메모 불러오기 실패");
    } finally {
        setIsRandomLoading(false);
    }
  };

  const handleImportBackup = async (event: React.ChangeEvent<HTMLInputElement>) => {
    // (Existing Import Logic)
    const file = event.target.files?.[0];
    if (!file) return;
    if (fileInputRef.current) fileInputRef.current.value = '';
    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const content = e.target?.result as string;
            let importedData;
            try { importedData = JSON.parse(content); } catch (err) { alert("파일 형식이 올바르지 않습니다."); return; }
            const cleanNotes = sanitizeNotes(importedData);
            if (cleanNotes.length === 0) { alert("유효한 백업 데이터가 없습니다."); return; }
            if (confirm(`${cleanNotes.length}개의 메모를 가져올까요? (기존 데이터에 병합/덮어쓰기 됩니다)`)) {
                await saveAllNotesToDB(cleanNotes);
                const dbNotes = await getAllNotesFromDB();
                setNotes(dbNotes.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)));
                alert("복구가 완료되었습니다.");
                (async () => {
                    for (const note of cleanNotes) {
                         await saveNoteToFirestore(note);
                         await new Promise(r => setTimeout(r, 50));
                    }
                })().catch(err => console.error("Background sync error:", err));
            }
        } catch (err) {
            console.error("Import Error", err);
            alert("백업 파일 처리 중 오류가 발생했습니다: " + (err as Error).message);
        }
    };
    reader.readAsText(file);
  };

  // 성공 여부를 돌려줍니다(정리본 저장처럼 결과에 따라 화면 표시가 달라지는 호출부용).
  const handleSaveNote = async (note: Note): Promise<boolean> => {
    try {
        if (!note.id) throw new Error("Invalid Note ID");
        const isNewNote = !notes.some(n => n.id === note.id);
        await saveNoteToDB(note);
        saveNoteToFirestore(note);
        setNotes(prev => {
             const exists = prev.some(n => n.id === note.id);
             if (exists) {
                 return prev.map(n => n.id === note.id ? note : n).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
             }
             return [note, ...prev];
        });
        setActiveNoteId(note.id);
        if (isNewNote) {
            setView(ViewMode.LIST);
        } else {
            setView(ViewMode.DETAIL);
        }
        // 버그 수정: 이전에는 이미지가 있으면 재저장할 때마다(내용만 고쳐도) OCR을 다시 돌렸습니다.
        // isProcessed 플래그로 "이미지가 실제로 바뀌어 재처리가 필요한 경우"만 OCR을 실행합니다.
        if (!note.isProcessed && note.images && note.images.length > 0) {
             extractTextFromImages(note.images).then(async text => {
                 if (text) {
                     // 사진 글자 읽기는 몇 초 걸리므로, 그 사이 바뀐 내용(태그·요약 등)을 덮어쓰지 않도록
                     // 최신 메모를 다시 읽어서 사진 텍스트만 얹습니다. 사진이 그새 바뀌었으면 버립니다.
                     const latest = await getNoteFromDB(note.id).catch(() => undefined);
                     if (!latest || JSON.stringify(latest.images || []) !== JSON.stringify(note.images || [])) return;
                     const updatedNote = { ...latest, transcription: text, isProcessed: true };
                     // OCR 텍스트를 먼저 완전히 저장한 뒤 임베딩을 계산해야, 임베딩이
                     // OCR 이전의 오래된 내용을 참조하는 경쟁 상태(race condition)를 피할 수 있습니다.
                     await saveNoteToDB(updatedNote).catch(console.error);
                     saveNoteToFirestore(updatedNote);
                     setNotes(prev => prev.map(n => n.id === updatedNote.id ? updatedNote : n));
                     // OCR 텍스트까지 반영된 최종 내용으로 임베딩 재계산 (검색용, 실패해도 무해)
                     embedAndPersistNotes([updatedNote], { silent: true });
                 }
             });
        }
        // 검색(의미 기반)에 바로 반영되도록 저장 직후 임베딩 계산 (fire-and-forget, 실패해도 무해)
        embedAndPersistNotes([note], { silent: true });
        return true;
    } catch (e) {
        console.error("Save Error", e);
        alert("메모 저장 중 오류가 발생했습니다. 다시 시도해주세요.");
        return false;
    }
  };

  // opts.insert: 새로 만든 질문 노트처럼 아직 목록에 없는 메모면 목록에 추가
  const handleUpdateNote = async (incoming: Note, opts?: { insert?: boolean }): Promise<boolean> => {
    try {
        // 복습·확인 기록 같은 부가정보 저장(patchNoteMeta)과 순서를 맞추고, 그 사이 더 최신 부가정보가
        // 저장돼 있으면 그것을 유지 (요약 저장이 "확인함" 기록 등을 덮지 않도록)
        const updatedNote: Note = await new Promise<Note>((resolve, reject) => {
            const prev = metaQueueRef.current.get(incoming.id) || Promise.resolve();
            const run = prev.catch(() => undefined).then(async () => {
                const latest = await getNoteFromDB(incoming.id).catch(() => undefined);
                let merged = incoming;
                if (latest && (latest.metaUpdatedAt || 0) > (incoming.metaUpdatedAt || 0)) {
                    merged = {
                        ...incoming,
                        quizMasteryCount: latest.quizMasteryCount, reviewDueAt: latest.reviewDueAt,
                        reviewIntervalDays: latest.reviewIntervalDays, lastReviewedAt: latest.lastReviewedAt,
                        wrongAnswers: latest.wrongAnswers, guidelineCheck: latest.guidelineCheck, tag: latest.tag, work: latest.work,
                        followUpIntervalDays: latest.followUpIntervalDays, followUpDueAt: latest.followUpDueAt,
                        followUpCheckedAt: Math.max(latest.followUpCheckedAt || 0, incoming.followUpCheckedAt || 0) || undefined,
                        quizCoverage: latest.quizCoverage, // 퀴즈 출제 범위도 더 최신 쪽 유지
                        threadPending: latest.threadPending, quizExcluded: latest.quizExcluded,
                        metaUpdatedAt: latest.metaUpdatedAt
                    };
                }
                // AI 요약이 바뀐 저장(요약·저널클럽·요약 삭제 등)은 내용 수정 시각이 그대로라 다른 기기로
                // 실시간 전달이 안 됐음 → 부가정보 수정 시각을 올려서 전달되게 함
                const summaryChanged = !latest || (latest.summary || '') !== (merged.summary || '')
                    || (latest.summarizedAt || 0) !== (merged.summarizedAt || 0)
                    || historyKey(latest) !== historyKey(merged); // 요약 이력만 바뀐 경우(이력 삭제 등)도
                if (summaryChanged) {
                    merged = { ...merged, metaUpdatedAt: Date.now() };
                }
                // 그 사이 이 기기에서 지운 메모면 저장하지 않음 (되살아나지 않게)
                if (isDeletedNoteId(merged.id)) throw new Error('deleted');
                await saveNoteToDB(merged);
                return merged;
            });
            metaQueueRef.current.set(incoming.id, run);
            const cleanup = () => { if (metaQueueRef.current.get(incoming.id) === run) metaQueueRef.current.delete(incoming.id); };
            run.then(cleanup, cleanup);
            run.then(resolve, reject);
        });
        saveNoteToFirestore(updatedNote);
        setNotes(prev => prev.some(n => n.id === updatedNote.id)
            ? prev.map(n => n.id === updatedNote.id ? updatedNote : n)
            : (opts?.insert && !isDeletedNoteId(updatedNote.id) ? [updatedNote, ...prev] : prev));
        if (updatedNote.images && updatedNote.images.length > 0 && !updatedNote.isProcessed) {
            extractTextFromImages(updatedNote.images).then(async text => {
                if (text) {
                    // 위와 같은 이유로 최신 메모 위에 사진 텍스트만 얹음
                    const latest = await getNoteFromDB(updatedNote.id).catch(() => undefined);
                    if (!latest || JSON.stringify(latest.images || []) !== JSON.stringify(updatedNote.images || [])) return;
                    const finalNote = { ...latest, transcription: text, isProcessed: true };
                    // OCR 텍스트를 먼저 완전히 저장한 뒤 임베딩을 계산 (경쟁 상태 방지)
                    await saveNoteToDB(finalNote).catch(console.error);
                    saveNoteToFirestore(finalNote);
                    setNotes(prev => prev.map(n => n.id === finalNote.id ? finalNote : n));
                    embedAndPersistNotes([finalNote], { silent: true });
                }
            });
        }
        embedAndPersistNotes([updatedNote], { silent: true });
        return true;
    } catch(e: any) {
        if (e?.message === 'deleted') return false; // 지운 메모에 늦게 도착한 저장은 조용히 버림
        console.error("Update Error", e);
        alert("메모 수정 저장 실패");
        return false;
    }
  };

  // 분류 태그만 바꿀 때: 저장·동기화만 하고 임베딩/사진 읽기 같은 유료 호출은 하지 않음
  const handleSetNoteTag = async (id: string, category: NoteCategory) => {
    try {
        // 저장 직전의 최신 분류를 기준으로 켜고/끔 (빠르게 연달아 눌러도 앞의 변경이 사라지지 않게)
        const saved = await patchNoteMeta(id, latest => {
            const next = toggleCategory(latest, category);
            return { tag: next.tag, work: next.work ? true : undefined };
        });
        if (!saved) throw new Error('note not found');
    } catch (e) {
        console.error("Tag update failed", e);
        alert("분류 변경 저장에 실패했습니다.");
    }
  };

  // --- 환자 식별번호(제목 맨 앞) ---
  const patientIndex = React.useMemo(() => buildPatientIndex(notes), [notes]);
  const findSamePatient = (pid: string) => patientIndex.get(pid) || [];

  // 같은 번호 환자 메모들을 가장 오래된 메모 하나로 합침 (날짜 소제목으로 이어붙이고 나머지는 삭제)
  const handleMergePatientNotes = async (ids: string[]): Promise<string | null> => {
      try {
          const full = (await Promise.all(ids.map(id => getNoteFromDB(id).catch(() => undefined))))
              .filter((n): n is Note => !!n)
              .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
          if (full.length < 2) { alert('합칠 메모를 불러오지 못했습니다.'); return null; }
          const pid = patientIdOf(full[0]);
          if (!pid || full.some(n => patientIdOf(n) !== pid)) { alert('번호가 같은 환자 메모만 합칠 수 있어요.'); return null; }
          const images = Array.from(new Set(full.flatMap(n => n.images || [])));
          const imageChars = images.reduce((s, i) => s + i.length, 0);
          const msg = `'${pid}' 환자 메모 ${full.length}개를 하나로 합칠까요?\n\n` +
              `가장 오래된 메모에 나머지 메모를 작성 날짜 소제목(## 날짜)으로 이어 붙이고, 나머지 ${full.length - 1}개는 삭제합니다.\n` +
              `(각 메모의 AI 요약은 없어지니, 합친 뒤 AI 메뉴에서 새로 요약해주세요)` +
              (imageChars > 700_000 ? `\n\n참고: 사진이 많아(약 ${Math.round(imageChars / 1024)}KB) 클라우드 저장 한도(1MB)를 넘을 수 있어요.` : '');
          if (!window.confirm(msg)) return null;
          const target = full[0];
          const others = full.slice(1);
          const now = Date.now();
          const latestCheck = full.reduce((a, b) => ((b.followUpCheckedAt || 0) > (a.followUpCheckedAt || 0) ? b : a));
          const dues = full.map(n => n.reviewDueAt).filter((x): x is number => typeof x === 'number');
          const merged: Note = {
              ...target,
              content: buildMergedPatientContent(full, pid),
              images,
              transcription: full.map(n => n.transcription).filter(Boolean).join('\n\n') || undefined,
              // 사진 글자 읽기가 모두 끝난 메모들만이면 다시 읽지 않음
              isProcessed: full.every(n => !(n.images && n.images.length) || n.isProcessed),
              summary: '', sources: [], summarizedAt: undefined, summaryKind: undefined,
              // 각 메모의 AI 요약(지금 요약 포함)은 합친 메모의 요약 이력으로 모아 둠
              summaryHistory: (() => {
                  const all = full.flatMap(n => archiveCurrentSummary(n)).sort((a, b) => a.createdAt - b.createdAt);
                  return all.length ? trimHistory(all) : undefined;
              })(),
              guidelineCheck: undefined,
              embedding: undefined, embeddingUpdatedAt: undefined,
              followUpCheckedAt: latestCheck.followUpCheckedAt,
              followUpIntervalDays: latestCheck.followUpIntervalDays,
              followUpDueAt: latestCheck.followUpDueAt,
              reviewDueAt: dues.length ? Math.min(...dues) : undefined,
              wrongAnswers: full.flatMap(n => n.wrongAnswers || []).slice(0, 5),
              updatedAt: now,
              metaUpdatedAt: now
          };
          if (!(await handleUpdateNote(merged))) return null; // 이 기기 저장부터 실패하면 원본은 그대로
          // 합친 메모가 클라우드에 확실히 저장된 뒤에만 나머지를 지움 (용량 초과 등으로 저장이 거절되면 원본 보존)
          const saved = await waitForCloudSave(target.id, 20000);
          if (!saved) {
              alert('합친 메모의 클라우드 저장을 확인하지 못해서(연결 끊김 또는 용량 초과) 원래 메모들은 지우지 않았어요.\n합친 메모는 이 기기에 저장돼 있으니, 연결된 뒤 확인하고 나머지 메모를 직접 지워주세요.');
              return target.id;
          }
          for (const o of others) {
              await deleteNoteFromDB(o.id);
              deleteNoteFromFirestore(o.id);
          }
          const removed = new Set(others.map(o => o.id));
          setNotes(prev => prev.filter(n => !removed.has(n.id)));
          return target.id;
      } catch (e: any) {
          console.error('Merge failed', e);
          alert(`합치는 중 오류가 발생했습니다: ${e?.message || '알 수 없는 오류'}`);
          return null;
      }
  };

  // 작성 중인 새 환자 메모를 같은 번호의 기존 메모 끝에 오늘 날짜 소제목으로 이어붙여 저장
  const handleAppendToPatientNote = async (targetId: string, added: string, images: string[]): Promise<boolean> => {
      const latest = await getNoteFromDB(targetId).catch(() => undefined);
      const pid = latest ? patientIdOf(latest) : null;
      if (!latest || !pid) { alert('이어붙일 메모를 찾지 못했습니다. 새 메모로 저장해주세요.'); return false; }
      const now = Date.now();
      await handleUpdateNote({
          ...latest,
          content: buildAppendedContent(latest.content || '', added, pid, now),
          images: [...(latest.images || []), ...images],
          isProcessed: images.length > 0 ? false : latest.isProcessed,
          updatedAt: now
      });
      setActiveNoteId(targetId);
      setView(ViewMode.DETAIL);
      return true;
  };

  const handleDeleteNote = async (id: string) => {
    if(confirm('삭제하시겠습니까?')) {
        await deleteNoteFromDB(id);
        deleteNoteFromFirestore(id);
        setNotes(prev => prev.filter(n => n.id !== id));
        setView(ViewMode.LIST);
        setActiveNoteId(null);
    }
  };

  // 질문 노트 저장: 같은 대화에 대한 저장(질문·답변·제목·적어둔 질문)을 순서대로 처리하고,
  // 매번 저장 직전의 최신 대화를 읽어 그 위에 바꿈 → 답변이 오는 사이 제목을 바꿔도 서로 덮지 않음.
  // mutate(null)은 "아직 없는 대화"(새 대화이거나, 다른 기기에서 지워짐) — null을 돌려주면 저장 안 함.
  const updateThread = (id: string, mutate: (latest: Note | null) => Note | null): Promise<Note | null> => {
      const prev = metaQueueRef.current.get(id) || Promise.resolve();
      const run: Promise<Note | null> = prev.catch(() => undefined).then(async () => {
          if (isDeletedNoteId(id)) return null;
          const latest = (await getNoteFromDB(id).catch(() => undefined)) || null;
          const next = mutate(latest);
          if (!next) return null;
          await saveNoteToDB(next);
          saveNoteToFirestore(next);
          setNotes(p => p.some(n => n.id === id) ? p.map(n => n.id === id ? next : n) : (isDeletedNoteId(id) ? p : [next, ...p]));
          return next;
      });
      metaQueueRef.current.set(id, run);
      const cleanup = () => { if (metaQueueRef.current.get(id) === run) metaQueueRef.current.delete(id); };
      run.then(cleanup, cleanup);
      return run;
  };

  // 질문 노트 삭제 (확인은 질문 노트 화면에서)
  const handleDeleteThread = async (id: string) => {
      await deleteNoteFromDB(id).catch(console.error);
      deleteNoteFromFirestore(id);
      setNotes(prev => prev.filter(n => n.id !== id));
  };

  // 다른 화면(퀴즈·메모 활용)에서 메모 열기: 질문 노트면 대화 화면으로
  const openNoteFrom = (from: ViewMode) => (id: string) => {
      const n = notes.find(x => x.id === id);
      if (n && isThread(n)) {
          setOpenThreadId(id);
          setThreadsReturnView(from);
          setView(ViewMode.THREADS);
          return;
      }
      setDetailReturnView(from);
      handleFetchAndSelectNote(id);
  };
  const openNoteFromQuiz = openNoteFrom(ViewMode.QUIZ);

  const handleUpdateNotes = async (updatedNotes: Note[]) => {
    try {
        for (const note of updatedNotes) {
            await saveNoteToDB(note);
            saveNoteToFirestore(note);
        }
        setNotes(prev => {
            const noteMap = new Map<string, Note>();
            prev.forEach(n => noteMap.set(n.id, n));
            updatedNotes.forEach(n => noteMap.set(n.id, n));
            const merged = Array.from(noteMap.values());
            merged.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
            return merged;
        });
    } catch (e) {
        console.error("Bulk Update Error", e);
        alert("메모 일괄 업데이트 중 오류가 발생했습니다.");
    }
  };

  const isMobile = typeof navigator !== 'undefined' && /Mobi|Android/i.test(navigator.userAgent);
  const activeNote = notes.find(n => n.id === activeNoteId);

  return (
    <div className="relative flex w-full h-full overflow-hidden bg-white">
      {/* Sidebar */}
      <div className={`${showSidebar ? 'w-full md:w-80 translate-x-0' : 'w-0 -translate-x-full md:w-0'} transition-all duration-300 flex-shrink-0 bg-white border-r border-slate-100 flex flex-col h-full absolute md:relative z-50 shadow-2xl md:shadow-none overflow-hidden`}>
        <div className="p-6 h-16 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-accent-600 rounded-lg flex items-center justify-center">
               <Network className="text-white w-4 h-4" />
            </div>
            <h1 className="font-bold text-lg text-slate-800 tracking-tight">MediNote</h1>
          </div>
          <button onClick={() => setShowSidebar(false)} className="md:hidden p-2 text-slate-400 hover:bg-slate-50 rounded-full">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-5 mb-6 flex-shrink-0">
          <button
            onClick={() => { setView(ViewMode.CREATE); setActiveNoteId(null); if (isMobile) setShowSidebar(false); }}
            className="w-full bg-accent-700 hover:bg-accent-800 text-white py-3 px-4 rounded-lg flex items-center justify-center font-bold text-sm shadow-sm transition-all active:scale-95"
          >
            <Plus className="w-3.5 h-3.5 mr-2" />
            새 메모 작성
          </button>
        </div>

        <nav className="flex-1 px-3 space-y-0.5 overflow-y-auto">
          {/* 모든 항목을 같은 모양으로: 아이콘은 단색, 선택된 항목만 강조색 */}
          {([
            { key: 'list', view: ViewMode.LIST, label: '내 메모장', icon: LayoutGrid, onClick: () => { setView(ViewMode.LIST); setSearchTerm(''); } },
            { key: 'random', label: '무작위 공부하기', icon: Shuffle, onClick: handleRandomNote, busy: isRandomLoading, disabled: isRandomLoading, keepSidebar: false },
            { key: 'threads', view: ViewMode.THREADS, onClick: () => { setThreadsReturnView(null); setView(ViewMode.THREADS); }, label: '질문 노트', icon: MessageSquareText, badge: threadPendingCount > 0 ? `적어둔 ${threadPendingCount}` : null, badgeTitle: '적어두고 아직 안 물어본 질문' },
            { key: 'quiz', view: ViewMode.QUIZ, label: 'AI 퀴즈 복습', icon: BrainCircuit, busy: quizState.isGenerating && quizState.isActive,
              badge: reviewDueCount > 0 ? `오늘 ${reviewDueCount}` : (quizState.questionQueue.length > 0 ? String(quizState.questionQueue.length) : null), badgeTitle: '오늘 복습할 메모' },
            { key: 'study', view: ViewMode.STUDY_GUIDE, label: 'AI 주제 탐구', icon: Lightbulb },
            { key: 'ask', view: ViewMode.ASK_NOTES, label: '내 메모에 물어보기', icon: Search },
            { key: 'guideline', view: ViewMode.GUIDELINE_CHECK, label: '오래된 메모 점검', icon: ShieldCheck, busy: guidelineCheckingIds.length > 0 },
            { key: 'insights', view: ViewMode.INSIGHTS, label: '메모 활용', icon: Layers, badge: patientFollowUpDue > 0 ? `환자 ${patientFollowUpDue}` : null, badgeTitle: '확인할 차례인 환자 메모' },
          ] as { key: string; view?: ViewMode; label: string; icon: React.ComponentType<{ className?: string }>; onClick?: () => void; busy?: boolean; disabled?: boolean; badge?: string | null; badgeTitle?: string }[]).map(item => {
            const active = !!item.view && view === item.view;
            const Icon = item.icon;
            return (
              <button
                key={item.key}
                onClick={() => { if (item.onClick) item.onClick(); else if (item.view) setView(item.view); if (isMobile) setShowSidebar(false); }}
                disabled={item.disabled}
                className={`w-full flex items-center px-3 py-2.5 rounded-lg text-[13px] transition-colors whitespace-nowrap disabled:opacity-50 ${active ? 'bg-accent-50 text-accent-800 font-bold' : 'text-slate-600 font-medium hover:bg-slate-50 hover:text-slate-900'}`}
              >
                {item.busy
                  ? <Loader2 className="w-4 h-4 mr-3 shrink-0 animate-spin text-accent-500" />
                  : <Icon className={`w-4 h-4 mr-3 shrink-0 ${active ? 'text-accent-600' : 'text-slate-400'}`} />}
                {item.label}
                {item.badge && (
                  <span className="ml-auto shrink-0 bg-slate-100 text-slate-600 text-[10px] font-bold px-1.5 py-0.5 rounded-full" title={item.badgeTitle}>
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <div className="p-5 border-t border-slate-50 space-y-3">
            <div className="flex gap-2">
                <button onClick={handleExportBackup} className="flex-1 flex flex-col items-center justify-center gap-1 py-3 bg-slate-50 rounded-xl text-[11px] font-bold text-slate-600 hover:bg-slate-100 transition-all">
                    <Cloud className="w-4 h-4 text-slate-400" /> 백업 저장하기
                </button>
                <button onClick={handleOpenFilePicker} className="flex-1 flex flex-col items-center justify-center gap-1 py-3 bg-slate-50 rounded-xl text-[11px] font-bold text-slate-600 hover:bg-slate-100 transition-all">
                    <Upload className="w-4 h-4 text-slate-400" /> 복구 불러오기
                </button>
            </div>
            
            <button onClick={handleExportCSV} className="w-full flex items-center justify-center gap-2 py-2.5 bg-white border border-slate-200 rounded-xl text-[11px] font-bold text-slate-500 hover:text-slate-700 hover:bg-slate-50 transition-all shadow-sm">
                <Download className="w-3.5 h-3.5" /> Notion/Excel용 CSV 내보내기
            </button>

            <input type="file" ref={fileInputRef} onChange={handleImportBackup} accept=".json" className="hidden" />
            
            {lastBackupTime && (
                <div className="flex items-center gap-1.5 text-[10px] text-slate-300 justify-center">
                    <Clock className="w-2.5 h-2.5" /> 마지막 백업: {new Date(lastBackupTime).toLocaleString()}
                </div>
            )}

            <div className="flex items-center justify-center gap-4">
                <button
                    onClick={() => setShowPinSettings(true)}
                    className="flex items-center gap-1.5 py-2 text-[11px] font-bold text-slate-400 hover:text-accent-600 transition-colors"
                >
                    <KeyRound className="w-3 h-3" /> PIN·자동 잠금
                </button>
                {hasTrustedDeviceFlag() && (
                    <button
                        onClick={() => { if (confirm('이 기기의 로그인 기억을 해제할까요? 다음 접속부터 PIN을 다시 입력해야 합니다.')) forgetThisDevice(); }}
                        className="flex items-center gap-1.5 py-2 text-[11px] font-bold text-slate-400 hover:text-red-500 transition-colors"
                    >
                        <LogOut className="w-3 h-3" /> 이 기기 로그아웃
                    </button>
                )}
            </div>
        </div>
      </div>

      {/* Main Content */}
      <main className="flex-1 h-full relative flex flex-col overflow-hidden bg-white">
        {!showSidebar && (
            <div className="h-12 px-4 bg-white border-b border-slate-50 flex items-center justify-between sticky top-0 z-40 flex-none shadow-sm">
                <button onClick={() => setShowSidebar(true)} className="w-10 h-10 flex items-center justify-center text-slate-400 hover:bg-slate-50 rounded-full transition-all">
                    <Menu className="w-5 h-5" />
                </button>
                <span className="font-bold text-slate-800 text-base absolute left-1/2 transform -translate-x-1/2">MediNote</span>
                <div className="flex items-center gap-1">
                   <button onClick={handleExportBackup} className="w-10 h-10 flex items-center justify-center text-slate-400 hover:bg-slate-50 rounded-full" title="백업하기">
                      <Cloud className="w-5 h-5" />
                   </button>
                   <button onClick={handleRandomNote} className="w-10 h-10 flex items-center justify-center text-slate-400 hover:bg-slate-50 rounded-full" title="무작위 공부하기">
                      <Shuffle className="w-5 h-5" />
                   </button>
                </div>
            </div>
        )}

        <div className="flex-1 overflow-hidden relative flex flex-col">
            <div className="flex-1 w-full bg-white overflow-hidden flex flex-col relative">
                {view === ViewMode.CREATE && <NoteEditor onSave={handleSaveNote} onCancel={() => setView(ViewMode.LIST)} findSamePatient={findSamePatient} onAppendToPatient={handleAppendToPatientNote} />}
                {view === ViewMode.EDIT && activeNote && <NoteEditor initialNote={activeNote} onSave={handleSaveNote} onCancel={() => setView(ViewMode.DETAIL)} findSamePatient={findSamePatient} />}
                {/* 목록 화면은 메모를 열었다 돌아와도 검색어·검색 결과·스크롤 위치가 그대로 남도록
                    다른 화면으로 가도 없애지 않고 숨겨만 둡니다. */}
                <div className={view === ViewMode.LIST ? 'h-full flex flex-col' : 'hidden'}>
                    <NoteList 
                        notes={memoNotes} 
                        onDelete={handleDeleteNote} 
                        onUpdateNote={handleUpdateNote} 
                        onImportBackup={handleOpenFilePicker}
                        onExportBackup={handleExportBackup}
                        onSelectNote={handleFetchAndSelectNote}
                        activeNoteId={view === ViewMode.LIST ? activeNoteId : null}
                        onClearActiveNote={() => setActiveNoteId(null)}
                        onRandomNote={handleRandomNote}
                        onLoadMore={handleLoadMoreNotes}
                        onFetchAll={() => handleFetchAllNotes()}
                        isLoadingMore={isCloudLoading}
                        searchTerm={searchTerm}
                        onSearchChange={setSearchTerm}
                        embeddingBackfillProgress={embeddingBackfillProgress}
                        tagFilter={tagFilter}
                        onTagFilterChange={setTagFilter}
                        isFetchingAll={isFetchingAll}
                        reviewDueCount={reviewDueCount}
                        onOpenReview={() => setView(ViewMode.QUIZ)}
                    />
                </div>
                {view === ViewMode.DETAIL && activeNote && (
                    <NoteDetail 
                        note={activeNote} 
                        allNotes={memoNotes} 
                        onBack={() => setView(returnToAsk ? ViewMode.ASK_NOTES : (detailReturnView || ViewMode.LIST))} 
                        onDelete={handleDeleteNote} 
                        onSelectNote={handleFetchAndSelectNote} 
                        onEdit={() => { setView(ViewMode.EDIT); }} 
                        onUpdateNote={handleUpdateNote} 
                        onSetTag={handleSetNoteTag}
                        samePatientNotes={(() => { const pid = patientIdOf(activeNote); return pid ? findSamePatient(pid).filter(n => n.id !== activeNote.id) : []; })()}
                        onMergePatient={async (ids) => { const id = await handleMergePatientNotes(ids); if (id) handleFetchAndSelectNote(id); }}
                        onCheckGuideline={handleCheckGuideline}
                        isCheckingGuideline={guidelineCheckingIds.includes(activeNote.id)}
                        onClearGuidelineCheck={handleClearGuidelineCheck}
                    />
                )}
                {view === ViewMode.QUIZ && (
                    <QuizView 
                        notes={notes} 
                        quizState={quizState} 
                        onStart={handleStartQuiz} 
                        onNext={handleNextQuestion}
                        onStop={handleStopQuiz}
                        onEndSession={handleEndQuizSession}
                        onRetry={handleRetryQuiz}
                        onBack={() => { setView(ViewMode.LIST); }} 
                        reviewDueCount={reviewDueCount}
                        onStartWrongReview={handleStartWrongReview}
                        onDeleteWrongAnswer={handleDeleteWrongAnswer}
                        onOpenNote={openNoteFromQuiz}
                        isFetchingAll={isFetchingAll}
                    />
                )}
                 {view === ViewMode.STUDY_GUIDE && (
                    <StudyGuideView
                        notes={memoNotes}
                        onBack={() => setView(ViewMode.LIST)}
                    />
                )}
                {view === ViewMode.GUIDELINE_CHECK && (
                    <GuidelineCheckView
                        notes={memoNotes}
                        checkingIds={guidelineCheckingIds}
                        filter={guidelineFilter}
                        onFilterChange={setGuidelineFilter}
                        onCheck={handleCheckGuideline}
                        onOpenNote={(id) => { setDetailReturnView(ViewMode.GUIDELINE_CHECK); handleFetchAndSelectNote(id); }}
                        onBack={() => setView(ViewMode.LIST)}
                        isFetchingAll={isFetchingAll}
                    />
                )}
                {(insightsMounted || view === ViewMode.INSIGHTS) && (
                    <div className={view === ViewMode.INSIGHTS ? 'h-full flex flex-col' : 'hidden'}>
                        <InsightsView
                            notes={memoNotes}
                            threads={threadNotes}
                            reviewDueCount={reviewDueCount}
                            isFetchingAll={isFetchingAll}
                            onBack={() => setView(ViewMode.LIST)}
                            onSelectNote={openNoteFrom(ViewMode.INSIGHTS)}
                            onSaveNewNote={async (note) => {
                                const ok = await handleSaveNote(note);
                                if (!ok) throw new Error('메모 저장에 실패했습니다.');
                                // 새 메모 저장은 기본적으로 목록으로 가므로, 저장 후에도 이 화면에 머무름
                                setView(ViewMode.INSIGHTS);
                            }}
                            onUpdateNote={handleUpdateNote}
                            onFollowUpCheck={handleFollowUpCheck}
                            onMergePatient={async (ids) => { await handleMergePatientNotes(ids); }}
                            nowTick={nowTick}
                        />
                    </div>
                )}
                {(askViewMounted || view === ViewMode.ASK_NOTES) && (
                    <div className={view === ViewMode.ASK_NOTES ? 'h-full flex flex-col' : 'hidden'}>
                        <AskNotesView
                            notes={memoNotes}
                            onBack={() => setView(ViewMode.LIST)}
                            onSelectNote={(id) => { setReturnToAsk(true); handleFetchAndSelectNote(id); }}
                            onSaveNewNote={async (note) => {
                                const ok = await handleSaveNote(note);
                                if (!ok) throw new Error('메모 저장에 실패했습니다.');
                                // 새 메모 저장은 기본적으로 목록으로 가므로, 정리본은 저장 후 답변 화면에 그대로 머무름
                                setView(ViewMode.ASK_NOTES);
                            }}
                        />
                    </div>
                )}
                {/* 질문 노트: 답변을 받는 중에 다른 화면에 가도 계속되도록 한 번 열면 계속 띄워 둠 */}
                {(threadsMounted || view === ViewMode.THREADS) && (
                    <div className={view === ViewMode.THREADS ? 'h-full flex flex-col' : 'hidden'}>
                        <ThreadsView
                            threads={threadNotes}
                            onUpdate={updateThread}
                            onPatchMeta={(id, makePatch) => patchNoteMeta(id, makePatch)}
                            onDelete={handleDeleteThread}
                            onBack={() => { setView(threadsReturnView || ViewMode.LIST); setThreadsReturnView(null); }}
                            openThreadId={openThreadId}
                            onOpened={() => setOpenThreadId(null)}
                        />
                    </div>
                )}
            </div>
        </div>

        {view === ViewMode.LIST && (
          <button onClick={() => { setView(ViewMode.CREATE); setActiveNoteId(null); if (isMobile) setShowSidebar(false); }} className="absolute bottom-10 right-8 w-14 h-14 bg-accent-600 text-white rounded-full shadow-2xl flex items-center justify-center transition-all z-40 active:scale-95 hover:bg-accent-700">
            <Plus className="w-8 h-8" />
          </button>
        )}
      </main>

      {showPinSettings && <PinSettingsModal onClose={() => setShowPinSettings(false)} />}
    </div>
  );
};

export default App;
