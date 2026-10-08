
export interface Source {
  title: string;
  uri: string;
  snippet?: string; // 질문 노트: 답변이 인용한 원문 일부 (출처 확인용)
}

export interface Note {
  id: string;
  title: string;
  content: string; // Markdown supported
  summary: string;
  createdAt: number;
  updatedAt?: number;
  sources: Source[];
  images?: string[];
  transcription?: string;
  isEnhancing: boolean;
  isProcessed?: boolean;
  quizMasteryCount?: number; // Tracks how many times a user answered correctly related to this note
  embedding?: number[]; // Voyage AI 임베딩 벡터 (의미 기반 검색용)
  embeddingUpdatedAt?: number; // embedding이 계산된 시점 — updatedAt보다 오래되면 재계산 필요
  tag?: NoteTag; // 분류 태그 (없으면 미분류)
  work?: boolean; // "업무" 분류 (인계 사항·시술 팁 등). '메모'와 함께 붙일 수 있음
  summarizedAt?: number; // AI 요약을 만든 시각 — 이후 메모가 수정됐으면 "수정 전 요약" 표시
  summaryKind?: 'journal'; // 요약 칸에 들어 있는 것이 저널클럽 분석이면 'journal' (일반 요약이면 없음)
  // AI 요약을 만들거나 추가 요청으로 고칠 때마다 남기는 이력 (오래된 것 → 최신 순, 개수·분량 제한)
  summaryHistory?: SummaryVersion[];
  // --- 복습 일정 (간격 반복) ---
  reviewDueAt?: number; // 다음 복습일(그날 0시). 이 시각이 지나면 "오늘 복습" 대상
  reviewIntervalDays?: number; // 직전에 잡힌 복습 간격(일)
  lastReviewedAt?: number; // 마지막으로 이 메모로 퀴즈를 푼 시각
  wrongAnswers?: WrongAnswer[]; // 이 메모에서 나온 틀린 문제 (오답 노트, 메모당 최대 5개)
  // 퀴즈 출제 범위: 구역(내용 해시) → 출제 횟수·마지막 출제 시각·이미 낸 요점 (services/quizCoverage.ts)
  quizCoverage?: Record<string, QuizCoverageEntry>;
  // --- 가이드라인 점검 ---
  guidelineCheck?: GuidelineCheck;
  // 내용이 아닌 부가정보(복습 일정·오답·점검 결과)를 마지막으로 바꾼 시각.
  // updatedAt(=내용 수정 시각)은 건드리지 않아 목록 순서·요약 상태가 바뀌지 않게 하고,
  // 기기 간 병합 때 updatedAt이 같으면 이 값이 더 최신인 쪽을 씁니다.
  metaUpdatedAt?: number;
  // AI 결과를 저장한 메모('ai')는 메모 활용 도구의 분석 대상에서 빠짐 (결과가 다시 입력으로 섞이지 않게)
  origin?: 'ai';
  deleted?: boolean; // 클라우드에만 쓰는 "삭제됨" 표시 (다른 기기에 삭제를 전달하기 위함, 화면에는 나오지 않음)
  // --- 환자 팔로업 (환자 메모를 주기적으로 열어 확인) ---
  followUpCheckedAt?: number; // 마지막으로 "확인함"을 누른 시각
  followUpIntervalDays?: number; // 확인 주기(일)
  followUpDueAt?: number; // 다음 확인일(그날 0시)
  // 이 메모가 "인계장" 문서일 때: 어떤 업무 메모를 어느 버전까지 반영했는지
  handover?: HandoverMeta;
  // --- 질문 노트 (대화). kind === 'thread'인 메모는 메모 목록·메모 활용에는 안 보이고 퀴즈에는 출제됨 ---
  kind?: 'thread';
  threadPending?: ThreadPending[]; // 적어 두고 아직 안 물어본 질문
  quizExcluded?: boolean; // 퀴즈에서 빼기 (질문 노트에서 설정)
}

export interface ThreadPending {
  id: string;
  text: string;
  at: number;
}

export interface SummaryVersion {
  id: string;
  createdAt: number; // 이 버전을 만든 시각
  summary: string;
  sources: Source[];
  kind?: 'journal'; // 저널클럽 분석이면 'journal'
  // new = AI 요약 새로 만들기, journal = 저널클럽 분석, refine = 질문·추가 요청 반영, legacy = 이력 기능 전에 만든 요약
  mode: 'new' | 'journal' | 'refine' | 'legacy';
  request?: string; // refine일 때 내가 입력한 질문·추가 사항
}

export interface QuizCoverageEntry {
  n: number; // 이 구역에서 낸 문제 수
  at: number; // 마지막으로 낸 시각
  t?: string[]; // 이미 낸 요점 (다음 문제는 다른 요점으로)
}

export interface HandoverMeta {
  sources: Record<string, number>; // 업무 메모 id → 반영할 때의 수정 시각(updatedAt)
  refs: string[]; // [메모N]의 고정 번호 순서 (N = 인덱스+1)
  updatedAt: number; // 마지막으로 정리한 시각
  purpose?: string; // 용도·받는 사람
  v?: number; // 2 = 메모를 자르지 않고 통째로 반영하는 방식 (그 이전 버전은 긴 메모가 5천 자에서 잘렸음)
}

export interface WrongAnswer {
  id: string; // 문제 id
  type: QuizType;
  question: string;
  options: string[];
  correctAnswerIndex: number;
  chosenIndex: number; // 내가 고른 답
  explanation?: string;
  sources?: Source[];
  relatedNoteIds?: string[];
  language?: QuizLanguage;
  wrongAt: number; // 마지막으로 틀린 시각
  wrongCount: number; // 틀린 횟수 (다시 풀기에서 또 틀리면 증가)
}

export interface GuidelineCheck {
  checkedAt: number;
  status: 'ok' | 'changed' | 'uncertain';
  report: string; // 마크다운
  sources: Source[];
}

// 태그는 일부러 두 가지만 둡니다 (많아지면 관리가 번거로워짐).
export type NoteTag = 'memo' | 'patient';
export const NOTE_TAG_LABELS: Record<NoteTag, string> = { memo: '메모', patient: '환자' };

// 화면에서 쓰는 분류 3가지: 메모 / 환자 / 업무
// - 메모와 환자는 둘 중 하나만
// - 업무는 메모와 함께 고를 수 있음 (구분이 모호한 경우용). 환자와는 함께 쓰지 않음
//   (환자 메모는 팔로업·케이스 기록에 쓰이므로 인계 사항과 섞이지 않게)
export type NoteCategory = 'memo' | 'patient' | 'work';
export const CATEGORY_LABELS: Record<NoteCategory, string> = { memo: '메모', patient: '환자', work: '업무' };
export const CATEGORIES: NoteCategory[] = ['memo', 'patient', 'work'];
export interface CategoryState { tag?: NoteTag; work?: boolean }

export const hasCategory = (n: CategoryState, c: NoteCategory): boolean =>
    c === 'work' ? !!n.work : n.tag === c;

export const toggleCategory = (cur: CategoryState, c: NoteCategory): CategoryState => {
    if (c === 'work') {
        if (cur.work) return { tag: cur.tag, work: undefined };
        return { tag: cur.tag === 'patient' ? undefined : cur.tag, work: true };
    }
    if (cur.tag === c) return { tag: undefined, work: cur.work };
    return { tag: c, work: c === 'patient' ? undefined : cur.work };
};

export const categoryLabels = (n: CategoryState): string[] =>
    CATEGORIES.filter(c => hasCategory(n, c)).map(c => CATEGORY_LABELS[c]);

// 분류별 색 (배지·버튼 공용)
export const CATEGORY_COLORS: Record<NoteCategory, { active: string; badge: string }> = {
    memo: { active: 'bg-accent-50 border-accent-300 text-accent-600', badge: 'bg-accent-50 text-accent-500' },
    patient: { active: 'bg-clay-50 border-clay-300 text-clay-600', badge: 'bg-clay-50 text-clay-500' },
    work: { active: 'bg-sage-50 border-sage-300 text-sage-700', badge: 'bg-sage-50 text-sage-600' },
};

export enum ViewMode {
  LIST = 'LIST',
  CREATE = 'CREATE',
  EDIT = 'EDIT',
  DETAIL = 'DETAIL',
  QUIZ = 'QUIZ',
  ASK_NOTES = 'ASK_NOTES',
  GUIDELINE_CHECK = 'GUIDELINE_CHECK',
  INSIGHTS = 'INSIGHTS',
  THREADS = 'THREADS',
  PHOTOS = 'PHOTOS',
  USAGE = 'USAGE',
  PDFS = 'PDFS'
}

export type QuizType = 'MULTIPLE_CHOICE' | 'OX';
export type QuizLanguage = 'Korean' | 'English' | 'Japanese';

export interface QuizQuestion {
    id: string;
    type: QuizType;
    question: string;
    options: string[]; // For OX, this might be ignored or used for rendering
    correctAnswerIndex: number; // 0 for O (True), 1 for X (False) usually
    explanation?: string;
    sources?: { title: string; uri: string }[];
    relatedNoteIds?: string[];
    // 오답 노트에서 다시 푸는 문제일 때: 이 문제가 저장된 메모 id
    replayOfNoteId?: string;
    // 메모의 어느 구역에서 낸 문제인지 (푼 뒤 출제 범위 기록에 사용)
    coverage?: { noteId: string; partKey: string; partLabel: string; partIndex: number; partCount: number; topic?: string };
    // PDF 자료에서 낸 문제 (§5-75): 어느 PDF의 어느 구간·요점인지 (푼 뒤 진행 기록에 사용)
    pdfRef?: PdfQuestionRef;
}

export interface PdfQuestionRef {
    docId: string;
    docTitle: string;
    docSource: string;
    sectionKey: string;
    sectionLabel: string; // 예: "p.3–4"
    sectionIndex: number; // 0부터 (출제 대상 구간 기준)
    sectionCount: number;
    pointIndex: number;
    point: string; // 이 문제가 다룬 요점 (한국어 짧게)
}

// ----------------------------------------------------------------------------
// PDF 자료실 (§5-75): 올린 PDF에서 뽑은 글을 구간으로 나눠 보관하고, 구간마다 요점 목록을 만들어
// 요점 하나 = OX 문제 하나로 빠짐없이 냄. 원본 PDF 파일은 보관하지 않음(글만).
// ----------------------------------------------------------------------------
export interface PdfSectionMeta {
    key: string; // 's0', 's1' … (Firestore 필드 이름으로 씀)
    label: string; // "p.3–4"
    pageFrom: number;
    pageTo: number;
    chars: number;
    head: string; // 구간 첫 줄 (목록 표시용)
    excluded?: boolean; // 출제에서 뺌 (참고문헌·표지 등)
}

export interface PdfPoint {
    p: string; // 요점 (한국어 짧게)
    st: 'new' | 'ok' | 'wrong'; // 이번 바퀴에서: 아직 / 맞힘 / 틀림
    at?: number; // 마지막으로 푼 시각
    wc?: number; // 틀린 횟수 (누적)
}

export interface PdfQuestion {
    id: string;
    pi: number; // 요점 번호 (pts 인덱스)
    q: string; // 참/거짓 문장
    t: boolean; // 참이면 true
    ex: string; // 해설
    lang: QuizLanguage;
}

export interface PdfSectionProgress {
    pts?: PdfPoint[]; // 요점 목록 (처음 출제할 때 AI가 만듦)
    qs?: PdfQuestion[]; // 만들어 두고 아직 안 풀었거나 틀린 문제 (맞히면 지움)
    empty?: boolean; // 문제로 낼 내용이 없는 구간(참고문헌·표지 등)으로 AI가 판단
    u?: number; // 이 구간 기록을 마지막으로 바꾼 시각 (기기 간 병합용)
}

export interface PdfDoc {
    id: string;
    title: string;
    source: string; // 출처 (학회·학술지·연도·URL 등 자유 입력)
    fileName: string;
    pageCount: number;
    charCount: number;
    createdAt: number;
    updatedAt: number;
    sections: PdfSectionMeta[];
    progress: Record<string, PdfSectionProgress>;
    textParts: number; // 클라우드에 글을 나눠 저장한 문서 수
    round?: number; // "처음부터 다시"를 누른 횟수 (1바퀴 = 0)
    ocr?: boolean; // 사진(스캔) PDF라 AI로 글자를 읽음
    refsFromPage?: number; // 참고문헌이 시작돼 출제에서 뺀 쪽
    inPool?: boolean; // false면 "PDF 복습"(전체 풀)에서 뺌 (§5-76). 없으면 포함
    deleted?: boolean;
}

export interface QuizState {
    isActive: boolean;
    mode: 'DETAILED' | 'QUICK_OX' | null;
    // RANDOM: 무작위(복습 예정·안 푼 메모 우선) / REVIEW: 오늘 복습할 메모만 / WRONG: 오답 다시 풀기
    // PERIOD: 기간별 복습(선택한 기간에 쓰거나 고친 메모만, 메모를 한 바퀴 돌면 다시 처음부터)
    // PDF: PDF 자료실의 PDF 하나로 OX (요점마다 한 문제, 빠짐없이) (§5-75)
    source: 'RANDOM' | 'REVIEW' | 'WRONG' | 'PERIOD' | 'PDF';
    pdfId?: string; // source가 PDF일 때: 이 PDF만. 없으면 전체 풀(PDF 복습에 넣어 둔 모든 PDF) (§5-76)
    pdfMode?: 'all' | 'wrong'; // all: 안 푼 요점부터 / wrong: 틀린 요점만 다시
    period?: 'today' | '1w' | '2w' | '1m' | '3m'; // source가 PERIOD일 때
    periodAll?: boolean; // 기간별 복습: 맞혀서 쉬는 메모까지 포함 (§5-72)
    // 더 낼 문제가 없음(오늘 복습을 다 만들었거나, 오답 다시 풀기 목록이 끝남)
    noMoreQuestions: boolean;
    language: QuizLanguage;
    isGenerating: boolean;
    questionQueue: QuizQuestion[];
    currentQuestion: QuizQuestion | null;
    error: string | null;
    stats: {
        correct: number;
        total: number;
    };
}
