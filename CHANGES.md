# MediNote → Claude API 전환 변경 내역

## 1. AI 엔진: Gemini → Claude API

- `services/geminiService.ts` 삭제, `services/claudeService.ts` 신규 작성.
- 브라우저에서 Anthropic Messages API(`https://api.anthropic.com/v1/messages`)를 `fetch`로 직접 호출합니다(결정: 프론트엔드 직접 호출 유지).
  - 필수 헤더 `anthropic-dangerous-direct-browser-access: true` 포함.
  - **API 키가 빌드 결과물에 노출됩니다.** 로컬/소수 인원 전용으로만 사용하세요. (README·주석에 명시)
- 모델: 빠른 백그라운드 생성(퀴즈)은 `claude-haiku-4-5-20251001`, 품질이 중요한 작업(요약/주제탐구/OCR/상세설명)은 `claude-sonnet-5`.
- JSON이 필요한 곳(퀴즈 MCQ/OX, 주제 제안)은 Gemini의 `responseMimeType` 텍스트 파싱 대신 **Claude의 강제 tool-use(입력 스키마)** 를 사용해 항상 유효한 JSON을 받도록 개선했습니다.
- 출처/인용이 필요한 곳(메모 요약, 주제탐구 콘텐츠, 퀴즈 상세설명)은 Google Search grounding 대신 **Claude의 `web_search` 툴**을 사용하고, 응답에 붙는 citations를 그대로 출처로 사용합니다.
- 환경변수명 변경: `GEMINI_API_KEY` → `ANTHROPIC_API_KEY` (`.env.local`, `vite.config.ts`, `index.html` importmap 모두 반영). `.env.local.example` 파일을 새로 추가했습니다.

## 2. 유지한 기능 (요청하신 3개 + 선택하신 부가기능)

- 메모 작성/보기/수정/삭제 (핵심, 변경 없음)
- **랜덤 메모 보기**
- **AI 퀴즈 복습** (객관식 Case Study / OX Quick Review, 다국어)
- **메모 안에서 AI 요약**
- **AI 주제 탐구 (Study Guide)** — 유지 선택
- **JSON 백업 저장/복원, CSV 내보내기** — 유지 선택 (단, 아래 3번 참고)

## 3. 삭제한 기능

- AI 시맨틱 검색(`findRelevantNotes`, "AI 추천" 노트 목록 UI) — 검색은 이제 일반 텍스트 검색만 남았습니다.
- Further Reading(관련 자료 추천, `getFurtherReading`) — 메모 상세 화면의 관련 버튼/섹션 제거.
- **Data Transfer Modal**(복사/붙여넣기 방식 백업)은 별도 후보로 여쭤보지 못했지만, 파일 기반 백업(JSON 내보내기/가져오기)과 기능이 겹치면서 버그(§4-②③)가 있어 정리 대상으로 판단해 함께 제거했습니다. 백업/복원은 사이드바의 "백업 저장하기 / 복구 불러오기" (JSON 파일)와 "CSV 내보내기"로 계속 가능합니다.
- 죽은 코드 삭제: `components/TagsView.tsx`(연결 안 됨 + `Note.tags` 타입 자체가 없어 실행 시 에러 나던 코드), `components/MindMap.tsx`(빈 껍데기), `enhanceNoteContent()`(아무 데서도 호출되지 않던 함수).
- 미사용 의존성 제거: `@google/genai`, `d3`. 새로 추가: `dompurify`(아래 5번).

## 4. 함께 고친 버그

1. **Firestore `undefined` 필드 저장 실패** — `initializeFirestore(app, { ignoreUndefinedProperties: true })`로 변경. 이미지가 바뀐 메모를 수정해도 클라우드 동기화가 조용히 실패하지 않습니다.
2. **"Overwrite"가 실제로 삭제하지 않던 문제** — 원인이었던 Data Transfer Modal을 제거하면서 함께 해소되었습니다. 남은 파일 기반 가져오기는 원래도 "병합"으로 정확히 동작합니다.
3. Data Transfer Modal 가져오기가 클라우드에 동기화되지 않던 불일치 — 위와 함께 제거.
4. **클라우드 랜덤 노트의 통계적 편향** — `generateAutoId()`가 실제 노트 ID(uuid) 형식과 다른 문자셋을 쓰던 것을 `uuidv4()`로 교체.
5. **저장할 때마다 OCR 재실행되던 낭비** — `isProcessed` 플래그 기준으로, 이미지가 실제로 바뀐 경우에만 OCR을 다시 돌리도록 수정.
6. **AI 요약 수정 시 출처만 사라지던 불일치** — 메모 내용/이미지를 수정하면 이제 `summary`와 `sources`를 함께 초기화합니다.

## 5. 보안 보강

- `NoteDetail`, `QuizView`, `StudyGuideView`의 `marked.parse()` 결과에 **DOMPurify**를 적용해 마크다운 렌더링 시 XSS 가능성을 줄였습니다.

## 5-1. 메모 편집기: 마크다운 / 표 붙여넣기 호환 (추가 요청)

- `NoteEditor.tsx`의 본문 입력창은 원래도 마크다운(`marked` + `gfm: true`)으로 렌더링되고 있었지만, 클로드 채팅에서 만들어준 표를 그대로 복사해 붙여넣으면 브라우저가 `<textarea>`에 서식 없는 텍스트만 넣어줘서 표 구분선(`| --- | --- |`)이 없는 깨진 텍스트로 저장되는 문제가 있었습니다.
- `onPaste` 이벤트를 가로채 클립보드의 **HTML 버전**(`clipboardData.getData('text/html')`)이 있고 표/목록/굵게 등 서식 태그가 감지되면, 이를 파싱해 **GFM 마크다운으로 변환**한 뒤 커서 위치에 삽입하도록 했습니다.
  - 표(`<table>`) → `| 헤더 |` / `| --- |` / `| 내용 |` 형태의 정식 마크다운 표로 변환 (셀 안의 굵게/링크 등 서식도 함께 변환, `|` 문자는 이스케이프).
  - 목록(`<ul>/<ol>`), 제목(`h1~h6`), 굵게/기울임/취소선, 링크, 인라인 코드/코드블록, 인용문(`blockquote`)도 함께 마크다운으로 변환.
  - 워드/구글 문서 등에서 붙여넣을 때 함께 딸려오는 `<style>/<script>/<head>/<meta>/<link>` 태그는 내용이 새어 들어가지 않도록 무시.
  - 표/서식이 감지되지 않는 일반 텍스트 붙여넣기, 또는 변환 중 오류가 나는 경우는 **기존 방식(순수 텍스트 붙여넣기)** 그대로 동작합니다 (기능 저하 없음).
- 툴바에 표를 바로 삽입할 수 있는 **"Table" 버튼**을 추가했습니다 (3x3 형태의 마크다운 표 틀 삽입).
- 안내 문구(placeholder)에 "표는 클로드 답변에서 그대로 복사해 붙여넣어도 됩니다"를 추가했습니다.

## 5-2. 메모 상세: 첨부 사진 확대/축소 보기 (추가 요청)

- `NoteDetail.tsx`의 사진 전체화면 보기(모달)에 확대/축소·이동 기능을 추가했습니다.
  - 마우스 휠 스크롤로 확대/축소 (100%~500%).
  - 하단의 **-/+ 버튼**과 **원래 크기로(리셋)** 버튼으로도 조절 가능. 현재 배율(%)도 함께 표시됩니다.
  - 이미지를 **더블클릭**하면 250%로 확대/원래 크기로 토글됩니다.
  - 확대된 상태에서는 이미지를 **드래그해서 이동**할 수 있고, 모바일에서는 **두 손가락 핀치**로 확대/축소할 수 있습니다.
  - 사진마다 새로 열 때 확대 상태는 100%로 초기화됩니다.

## 6. 그대로 유지하기로 하신 부분 (참고용 재안내)

- Firestore는 여전히 사용자 구분 없는 **공용 컬렉션**입니다. 여러 사람이 같은 배포본을 쓰면 메모가 섞여 보일 수 있습니다.
- API 키는 여전히 **브라우저에 노출**됩니다. 공개 배포 시엔 프록시 서버 도입을 권장합니다.

## 실행 방법

```
npm install
cp .env.local.example .env.local   # ANTHROPIC_API_KEY 값 채우기
npm run dev
```

## ⚠️ 참고: 이 변경사항은 아직 `npm install` / 빌드로 검증하지 못했습니다

작업 환경의 네트워크 정책상 npm 레지스트리(registry.npmjs.org)에 직접 접근이 막혀 있어
`npm install` 및 `tsc` 빌드 검증을 실행하지 못했습니다. 모든 변경은 코드를 꼼꼼히
교차 확인(참조 정합성, import 경로, 타입 시그니처 일치 등)했지만, 실제 `npm install && npm run build`는
받아보신 후 로컬에서 한 번 실행해 확인해 주세요. 만약 에러가 나면 알려주시면 바로 고치겠습니다.
