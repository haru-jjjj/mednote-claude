
// ============================================================================
// 간단한 PIN 기반 접속 잠금
// ----------------------------------------------------------------------------
// 1인용 앱이라, 공용 컴퓨터 등에서 남이 화면을 들여다보는 것을 막는 "가벼운" 잠금입니다.
//
// PIN을 어디서 가져오나 (우선순위):
//   1) 클라우드(Firestore appSettings/pin) — 앱 안 "PIN 변경"으로 저장한 값.
//      PIN 자체가 아니라 salt를 섞은 SHA-256 해시만 저장합니다.
//   2) 이 기기에 캐시해둔 1)의 사본 — 오프라인이어도 잠금이 동작하도록.
//   3) Vercel/.env.local 의 APP_PIN — 앱에서 한 번도 PIN을 바꾸지 않았을 때의 초기값.
//   4) 아무것도 없으면 잠금 없이 열림 (화면에 안내 배지 표시).
//
// "이 기기 기억하기"는 PIN "버전"과 함께 저장됩니다. 그래서 PIN을 바꾸면, 바꾼 기기를
// 제외한 다른 기억된 기기들은 다음 접속 때 새 PIN을 다시 입력해야 합니다.
//
// 주의(보안): 이 프로젝트의 다른 키들처럼 Firebase 설정이 브라우저에 공개되어 있어,
// 마음먹고 파고드는 사람이라면 해시를 읽어 짧은 PIN을 추측할 수 있습니다. 즉 실제
// 보안이 아니라 "잠금 화면이 없는 것보다 나은" 수준입니다.
// ============================================================================

import { fetchPinSetting, savePinSetting, PinSetting } from './firebaseService';

const TRUSTED_DEVICE_KEY = 'medinote_trusted_device';
const PIN_CACHE_KEY = 'medinote_pin_setting_cache';
export const PIN_CHANGED_EVENT = 'medinote-pin-changed';

export type PinSource = 'cloud' | 'env' | 'none';

export interface PinConfig {
    source: PinSource;
    // PIN이 바뀔 때마다 달라지는 식별자 ("이 기기 기억하기"가 어느 PIN 기준인지 구분용)
    version: string;
    setting?: PinSetting;
    envPin?: string;
}

// ----------------------------------------------------------------------------
// SHA-256 (순수 JS 구현)
// 브라우저 내장 crypto.subtle은 https가 아닌 환경(예: 같은 와이파이에서 http://192.168...로
// 개발 서버 접속)에서는 아예 없어서, 어디서나 같은 결과가 나오도록 직접 구현합니다.
// ----------------------------------------------------------------------------
const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export const sha256Hex = (message: string): string => {
    const bytes = new TextEncoder().encode(message);
    const bitLen = bytes.length * 8;
    const paddedLen = Math.ceil((bytes.length + 9) / 64) * 64;
    const buf = new Uint8Array(paddedLen);
    buf.set(bytes);
    buf[bytes.length] = 0x80;
    const view = new DataView(buf.buffer);
    view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000));
    view.setUint32(paddedLen - 4, bitLen >>> 0);

    const h = new Uint32Array([
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);
    const w = new Uint32Array(64);
    const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

    for (let off = 0; off < paddedLen; off += 64) {
        for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
        for (let i = 16; i < 64; i++) {
            const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
            const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
        }
        let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
        for (let i = 0; i < 64; i++) {
            const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            const ch = (e & f) ^ (~e & g);
            const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
            const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const t2 = (S0 + maj) >>> 0;
            hh = g; g = f; f = e; e = (d + t1) >>> 0;
            d = c; c = b; b = a; a = (t1 + t2) >>> 0;
        }
        h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
        h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
    }
    return Array.from(h).map(x => x.toString(16).padStart(8, '0')).join('');
};

const hashPin = (salt: string, pin: string) => sha256Hex(`${salt}:${pin}`);

const randomHex = (byteLen: number): string => {
    const arr = new Uint8Array(byteLen);
    try {
        crypto.getRandomValues(arr);
    } catch {
        for (let i = 0; i < byteLen; i++) arr[i] = Math.floor(Math.random() * 256);
    }
    return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
};

// ----------------------------------------------------------------------------
// 환경변수 APP_PIN (초기값) — Vite 환경변수 → process.env 순서로 폴백
// ----------------------------------------------------------------------------
export const getEnvPin = (): string | null => {
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

// ----------------------------------------------------------------------------
// 설정 읽기
// ----------------------------------------------------------------------------
const configFromSetting = (setting: PinSetting): PinConfig => ({
    source: 'cloud',
    version: `cloud:${setting.updatedAt}`,
    setting,
});

const readCachedSetting = (): PinSetting | null => {
    try {
        const raw = localStorage.getItem(PIN_CACHE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (typeof parsed?.pinHash === 'string' && typeof parsed?.salt === 'string' && typeof parsed?.updatedAt === 'number') {
            return parsed as PinSetting;
        }
    } catch { /* 무시 */ }
    return null;
};

const writeCachedSetting = (setting: PinSetting) => {
    try { localStorage.setItem(PIN_CACHE_KEY, JSON.stringify(setting)); } catch { /* 무시 */ }
};

// 네트워크 없이 바로 알 수 있는 설정 (캐시 → 환경변수 → 없음)
export const getInitialPinConfig = (): PinConfig => {
    const cached = readCachedSetting();
    if (cached) return configFromSetting(cached);
    const envPin = getEnvPin();
    if (envPin) return { source: 'env', version: 'env', envPin };
    return { source: 'none', version: 'none' };
};

const withTimeout = <T,>(promise: Promise<T>, ms: number): Promise<T> =>
    new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), ms);
        promise.then(
            v => { clearTimeout(timer); resolve(v); },
            e => { clearTimeout(timer); reject(e); }
        );
    });

const clearCachedSetting = () => {
    try { localStorage.removeItem(PIN_CACHE_KEY); } catch { /* 무시 */ }
};

// 클라우드 설정을 확인합니다. PIN이 있으면 캐시에도 저장하고 반환합니다.
// 클라우드에 PIN이 없으면(예: PIN을 잊어서 Firebase 콘솔에서 appSettings/pin 문서를 지운 경우)
// 이 기기의 캐시도 지우고 null — 그러면 APP_PIN 또는 "잠금 없음"으로 돌아가 복구할 수 있습니다.
// 네트워크·권한 문제로 확인할 수 없으면 예외를 던집니다. timeoutMs를 생략하면 기다립니다.
export const loadCloudPinConfig = async (timeoutMs?: number): Promise<PinConfig | null> => {
    const setting = await (timeoutMs ? withTimeout(fetchPinSetting(), timeoutMs) : fetchPinSetting());
    if (!setting) {
        clearCachedSetting();
        return null;
    }
    writeCachedSetting(setting);
    return configFromSetting(setting);
};

export const verifyPin = (config: PinConfig, pin: string): boolean => {
    if (config.source === 'cloud' && config.setting) {
        return hashPin(config.setting.salt, pin) === config.setting.pinHash;
    }
    if (config.source === 'env') return pin.length > 0 && pin === config.envPin;
    return true;
};

// ----------------------------------------------------------------------------
// "이 기기 기억하기"
// ----------------------------------------------------------------------------
export const hasTrustedDeviceFlag = (): boolean => {
    try {
        return !!localStorage.getItem(TRUSTED_DEVICE_KEY);
    } catch {
        return false;
    }
};

export const isDeviceTrusted = (version: string): boolean => {
    try {
        const stored = localStorage.getItem(TRUSTED_DEVICE_KEY);
        if (!stored) return false;
        if (stored === version) return true;
        // 예전 버전(PIN 버전 없이 'true'만 저장)과의 호환: 환경변수 PIN을 쓰던 시절의 기억
        return stored === 'true' && version === 'env';
    } catch {
        return false;
    }
};

// PIN이 바뀌어 다시 잠길 때, 예전 PIN 기준의 "기억하기" 표시를 지웁니다 (새로고침 없이).
export const clearTrustedDeviceFlag = (): void => {
    try { localStorage.removeItem(TRUSTED_DEVICE_KEY); } catch { /* 무시 */ }
};

export const trustThisDevice = (version: string): void => {
    try { localStorage.setItem(TRUSTED_DEVICE_KEY, version); } catch { /* 무시 */ }
};

// 이 기기의 "기억하기"를 해제하고 잠금 화면부터 다시 보여줍니다 (사이드바의 로그아웃 버튼에서 사용).
export const forgetThisDevice = (): void => {
    try { localStorage.removeItem(TRUSTED_DEVICE_KEY); } catch { /* 무시 */ }
    window.location.reload();
};

// ----------------------------------------------------------------------------
// PIN 변경 (앱 안에서)
// ----------------------------------------------------------------------------
export type PinChangeErrorCode = 'NEEDS_CURRENT' | 'WRONG_CURRENT' | 'PERMISSION' | 'NETWORK' | 'PENDING';

export class PinChangeError extends Error {
    code: PinChangeErrorCode;
    constructor(code: PinChangeErrorCode, message: string) {
        super(message);
        this.code = code;
    }
}

const toPinChangeError = (e: any): PinChangeError => {
    if (e instanceof PinChangeError) return e;
    if (e?.code === 'permission-denied') {
        return new PinChangeError('PERMISSION',
            'Firestore 보안 규칙이 PIN 설정 저장을 막고 있습니다. Firebase 콘솔 → Firestore → 규칙에서 appSettings 컬렉션의 읽기/쓰기를 허용해주세요 (CHANGES.md §5-26에 예시 있음).');
    }
    return new PinChangeError('NETWORK', '클라우드에 연결할 수 없습니다. 인터넷 연결을 확인한 뒤 다시 시도해주세요.');
};

// currentPin: 지금 PIN (PIN이 아직 없으면 null). 성공하면 새 설정을 돌려줍니다.
export const changePin = async (currentPin: string | null, newPin: string): Promise<PinConfig> => {
    // 캐시가 아니라 클라우드의 최신 PIN 기준으로 현재 PIN을 확인 (다른 기기에서 바꿨을 수 있음)
    let current: PinConfig;
    try {
        const cloud = await loadCloudPinConfig(8000);
        const envPin = getEnvPin();
        current = cloud ?? (envPin ? { source: 'env', version: 'env', envPin } : { source: 'none', version: 'none' });
    } catch (e) {
        throw toPinChangeError(e);
    }

    if (current.source !== 'none') {
        if (currentPin === null) {
            throw new PinChangeError('NEEDS_CURRENT', '이미 PIN이 설정되어 있습니다. 현재 PIN을 입력해주세요.');
        }
        if (!verifyPin(current, currentPin)) {
            throw new PinChangeError('WRONG_CURRENT', '현재 PIN이 올바르지 않습니다.');
        }
    }

    const salt = randomHex(16);
    const setting: PinSetting = { pinHash: hashPin(salt, newPin), salt, updatedAt: Date.now() };
    const config = configFromSetting(setting);

    // 저장이 끝난 뒤(늦게 끝나더라도) 이 기기에 반영할 것들
    const applyLocally = () => {
        writeCachedSetting(setting);
        // PIN을 바꾼 이 기기는, 원래 "기억하기" 상태였다면 새 PIN 기준으로 계속 기억
        if (hasTrustedDeviceFlag()) trustThisDevice(config.version);
        try {
            window.dispatchEvent(new CustomEvent(PIN_CHANGED_EVENT, { detail: config }));
        } catch { /* 무시 */ }
    };

    const savePromise = savePinSetting(setting);
    try {
        await withTimeout(savePromise, 10000);
    } catch (e: any) {
        if (e?.message === 'timeout') {
            // Firestore는 연결이 느려도 저장을 계속 시도하므로, 실패로 단정하지 않고
            // 나중에 저장이 끝나면 그때 이 기기에도 반영합니다.
            savePromise.then(applyLocally).catch(err => console.error('PIN 저장 실패:', err));
            throw new PinChangeError('PENDING', '연결이 느려 저장이 지연되고 있습니다. 연결되면 자동으로 새 PIN이 적용되니, 잠시 후 확인해주세요.');
        }
        throw toPinChangeError(e);
    }
    applyLocally();
    return config;
};
