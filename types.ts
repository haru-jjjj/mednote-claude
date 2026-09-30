
export interface Source {
  title: string;
  uri: string;
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
  summarizedAt?: number; // AI 요약을 만든 시각 — 이후 메모가 수정됐으면 "수정 전 요약" 표시
  summaryKind?: 'journal'; // 요약 칸에 들어 있는 것이 저널클럽 분석이면 'journal' (일반 요약이면 없음)
  // --- 복습 일정 (간격 반복) ---
  reviewDueAt?: number; // 다음 복습일(그날 0시). 이 시각이 지나면 "오늘 복습" 대상
  reviewIntervalDays?: number; // 직전에 잡힌 복습 간격(일)
  lastReviewedAt?: number; // 마지막으로 이 메모로 퀴즈를 푼 시각
  wrongAnswers?: WrongAnswer[]; // 이 메모에서 나온 틀린 문제 (오답 노트, 메모당 최대 5개)
  // --- 가이드라인 점검 ---
  guidelineCheck?: GuidelineCheck;
  // 내용이 아닌 부가정보(복습 일정·오답·점검 결과)를 마지막으로 바꾼 시각.
  // updatedAt(=내용 수정 시각)은 건드리지 않아 목록 순서·요약 상태가 바뀌지 않게 하고,
  // 기기 간 병합 때 updatedAt이 같으면 이 값이 더 최신인 쪽을 씁니다.
  metaUpdatedAt?: number;
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

export enum ViewMode {
  LIST = 'LIST',
  CREATE = 'CREATE',
  EDIT = 'EDIT',
  DETAIL = 'DETAIL',
  QUIZ = 'QUIZ',
  STUDY_GUIDE = 'STUDY_GUIDE',
  ASK_NOTES = 'ASK_NOTES',
  GUIDELINE_CHECK = 'GUIDELINE_CHECK'
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
}

export interface QuizState {
    isActive: boolean;
    mode: 'DETAILED' | 'QUICK_OX' | null;
    // RANDOM: 무작위(복습 예정·안 푼 메모 우선) / REVIEW: 오늘 복습할 메모만 / WRONG: 오답 다시 풀기
    source: 'RANDOM' | 'REVIEW' | 'WRONG';
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
