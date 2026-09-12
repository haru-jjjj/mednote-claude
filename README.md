# MediNote AI

의학 공부 메모 앱. 메모 저장, 랜덤 메모 복습, AI 퀴즈(객관식/OX), 메모 내 AI 요약,
AI 주제 탐구(Study Guide), JSON/CSV 백업, (선택) 의미 기반 검색을 제공합니다.
AI 기능은 Claude API(Anthropic Messages API)를, 의미 기반 검색은 Voyage AI
임베딩 API를 사용합니다.

## ⚠️ 보안 관련 중요 안내

이 프로젝트는 **프론트엔드(브라우저)에서 Claude API와 Voyage AI API를 모두 직접
호출**하는 구조입니다. 즉 `ANTHROPIC_API_KEY`와 `VOYAGE_API_KEY`가 빌드된 JS
번들에 그대로 포함되어 누구나 브라우저 개발자 도구로 열어볼 수 있습니다.
(참고로 Voyage 공식 문서는 API 키를 브라우저/앱에 노출하지 말라고 명시적으로
권고하고 있어, 이 결정에 따른 위험을 각자 감수해야 합니다.) 개인적으로 로컬에서만
실행하거나, 접근이 통제된 소수만 쓰는 환경에서만 이 방식을 사용하세요. 공개 배포가
필요하다면 API 호출을 대신 해주는 서버(서버리스 함수 등)를 앞단에 두어 키를 숨기는
구조로 바꿔야 합니다.

또한 클라우드 동기화(Firestore)는 사용자별로 데이터가 분리되지 않고 하나의 공용
컬렉션을 씁니다(기존 구조를 그대로 유지하기로 한 결정). 여러 사람이 같은 배포본을
쓰면 서로의 메모가 섞여 보일 수 있습니다.

## Run Locally

**Prerequisites:** Node.js

1. Install dependencies:
   `npm install`
2. Set `ANTHROPIC_API_KEY` in `.env.local` to your Claude (Anthropic) API key
   (발급: https://console.anthropic.com/settings/keys)
3. (선택) 의미 기반 검색을 쓰려면 `VOYAGE_API_KEY`도 `.env.local`에 설정
   (발급: https://dashboard.voyageai.com/organization/api-keys → "Create new
   secret key". 설정하지 않아도 앱과 기존 키워드 검색은 정상 동작합니다.)
4. Run the app:
   `npm run dev`

## Vercel 배포 시

Vercel 프로젝트의 Settings → Environment Variables에 아래 두 개를 추가하세요
(이름은 로컬 `.env.local`과 동일하게):
- `ANTHROPIC_API_KEY`
- `VOYAGE_API_KEY` (선택 — 의미 기반 검색을 쓰려면)
