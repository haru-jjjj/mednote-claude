
// ============================================================================
// 간단한 PIN 기반 접속 잠금
// ----------------------------------------------------------------------------
// 이 앱은 사용자가 본인 한 명이라, 공용 컴퓨터 등에서 실수로 남이 들여다보는
// 것을 막을 정도의 "가벼운" 잠금만 필요하다는 전제로 설계했습니다. 백엔드/서버
// 세션이 없는 순수 프론트엔드 앱이므로 "로그인"은 브라우저 안에서 PIN 문자열을
// 비교하는 수준입니다.
//
// 주의(보안): 이 프로젝트의 기존 결정(ANTHROPIC_API_KEY, VOYAGE_API_KEY 노출)과
// 동일하게, PIN 값도 빌드된 JS 번들 안에 그대로 포함되어 브라우저에 노출됩니다.
// 개발자 도구로 코드/네트워크를 들여다보면 PIN을 알아낼 수 있으므로, 이건
// "잠금 화면이 없는 것보다 나은" 수준의 가벼운 보호이지 실제 보안이 아닙니다.
// 진짜 보안이 필요하면 별도 백엔드 인증이 필요합니다.
// ============================================================================

const TRUSTED_DEVICE_KEY = 'medinote_trusted_device';

// ----------------------------------------------------------------------------
// 설정된 PIN 조회 (Vite 환경변수 → process.env 순서로 폴백, claudeService.ts와 동일한 패턴)
// PIN이 설정되어 있지 않으면 null을 반환하고, 이 경우 잠금 화면 자체를 건너뜁니다
// (개발 중이거나 .env.local 설정을 깜빡한 경우 앱을 못 쓰게 막지 않기 위함).
// ----------------------------------------------------------------------------
export const getAppPin = (): string | null => {
    let pin = "";

    try {
        pin = (import.meta as any).env?.VITE_APP_PIN || (import.meta as any).env?.APP_PIN || "";
    } catch (e) {
        // import.meta가 없는 환경일 수 있음
    }

    if (!pin || pin === 'undefined') {
        try {
            pin = process.env.VITE_APP_PIN || process.env.APP_PIN || "";
        } catch (e) {
            // process가 정의되지 않은 브라우저 환경일 수 있음
        }
    }

    if (!pin || pin === 'undefined' || (typeof pin === 'string' && pin.includes('TODO'))) {
        return null;
    }
    return pin;
};

// "이 기기 기억하기"로 저장된 신뢰 여부
export const isDeviceTrusted = (): boolean => {
    try {
        return localStorage.getItem(TRUSTED_DEVICE_KEY) === 'true';
    } catch {
        return false;
    }
};

export const trustThisDevice = (): void => {
    try { localStorage.setItem(TRUSTED_DEVICE_KEY, 'true'); } catch { /* 무시 */ }
};

// 이 기기의 "기억하기"를 해제하고 잠금 화면부터 다시 보여줍니다 (사이드바의 로그아웃 버튼에서 사용).
export const forgetThisDevice = (): void => {
    try { localStorage.removeItem(TRUSTED_DEVICE_KEY); } catch { /* 무시 */ }
    window.location.reload();
};
