import React, { useState, useEffect, useRef } from 'react';
import { Lock, Eye, EyeOff, ShieldCheck, AlertTriangle, Loader2 } from 'lucide-react';
import {
    PinConfig, PIN_CHANGED_EVENT, getInitialPinConfig, loadCloudPinConfig,
    verifyPin, isDeviceTrusted, trustThisDevice, hasTrustedDeviceFlag, clearTrustedDeviceFlag
} from '../services/authService';

interface PinGateProps {
    children: React.ReactNode;
}

// 앱 전체를 감싸서, PIN이 맞을 때까지(또는 이미 기억된 기기라면 즉시) 하위 컴포넌트를
// 아예 마운트하지 않는 게이트입니다. 잠금이 풀리기 전에는 메모를 불러오는 로직도 실행되지 않습니다.
//
// 흐름: 이 기기에 캐시된 PIN(또는 APP_PIN)으로 바로 판단해서 기다림 없이 열고, 뒤에서
// 클라우드의 최신 PIN을 확인합니다. 다른 기기에서 PIN이 바뀌었으면 그때 다시 잠급니다.
const PinGate: React.FC<PinGateProps> = ({ children }) => {
    const [config, setConfig] = useState<PinConfig>(() => getInitialPinConfig());
    const [cloudChecked, setCloudChecked] = useState(false);
    // 어떤 PIN 버전으로 잠금이 풀렸는지 (PIN이 바뀌면 이 값과 달라져서 다시 잠김)
    const [unlockedVersion, setUnlockedVersion] = useState<string | null>(() => {
        const initial = getInitialPinConfig();
        return initial.source !== 'none' && isDeviceTrusted(initial.version) ? initial.version : null;
    });
    const [pinInput, setPinInput] = useState('');
    const [remember, setRemember] = useState(false);
    const [error, setError] = useState('');
    const [showPin, setShowPin] = useState(false);

    const unlockedVersionRef = useRef(unlockedVersion);
    unlockedVersionRef.current = unlockedVersion;
    const checkingRef = useRef(false);
    // 이 기기에서 PIN을 바꾼 시각 — 그 전에 시작된(오래된 결과를 받을 수 있는) 확인은 무시
    const lastLocalChangeRef = useRef(0);

    // 클라우드 확인 결과 반영: PIN이 바뀌었으면(다른 기기에서 변경 등) 다시 잠그고,
    // 예전 PIN 기준의 "기억하기" 표시는 지웁니다. 클라우드에 PIN이 없으면(캐시도 지워짐)
    // APP_PIN 또는 "잠금 없음"으로 돌아갑니다 — PIN을 잊었을 때의 복구 경로.
    const applyCloudResult = (cloud: PinConfig | null) => {
        const next = cloud ?? getInitialPinConfig();
        if (next.source !== 'none' && hasTrustedDeviceFlag() && !isDeviceTrusted(next.version)) {
            clearTrustedDeviceFlag();
        }
        setConfig(next);
        if (unlockedVersionRef.current !== next.version) {
            setUnlockedVersion(next.source !== 'none' && isDeviceTrusted(next.version) ? next.version : null);
        }
    };

    // 클라우드의 최신 PIN 확인: 시작할 때 + 인터넷이 다시 연결될 때 + 앱으로 돌아올 때.
    // 응답이 늦어도 도착하는 대로 반영합니다(6초 타이머는 첫 대기 화면을 끝내는 용도일 뿐).
    useEffect(() => {
        let cancelled = false;
        const check = () => {
            if (checkingRef.current) return;
            checkingRef.current = true;
            const startedAt = Date.now();
            loadCloudPinConfig()
                .then(cloud => {
                    if (cancelled || lastLocalChangeRef.current >= startedAt) return;
                    applyCloudResult(cloud);
                })
                .catch(e => console.warn('클라우드 PIN 설정 확인 실패 (이 기기에 저장된 설정으로 동작):', e))
                .finally(() => {
                    checkingRef.current = false;
                    if (!cancelled) setCloudChecked(true);
                });
        };
        check();
        const spinnerTimer = setTimeout(() => { if (!cancelled) setCloudChecked(true); }, 6000);
        const onOnline = () => check();
        const onVisible = () => { if (document.visibilityState === 'visible') check(); };
        window.addEventListener('online', onOnline);
        document.addEventListener('visibilitychange', onVisible);
        return () => {
            cancelled = true;
            clearTimeout(spinnerTimer);
            window.removeEventListener('online', onOnline);
            document.removeEventListener('visibilitychange', onVisible);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // 앱 안에서 PIN을 바꾸면 현재 세션은 그대로 열린 상태로 유지
    useEffect(() => {
        const onChanged = (e: Event) => {
            const next = (e as CustomEvent<PinConfig>).detail;
            if (!next) return;
            lastLocalChangeRef.current = Date.now();
            setConfig(next);
            setUnlockedVersion(next.version);
        };
        window.addEventListener(PIN_CHANGED_EVENT, onChanged);
        return () => window.removeEventListener(PIN_CHANGED_EVENT, onChanged);
    }, []);

    const noPin = config.source === 'none';

    // PIN이 이 기기에도 캐시에도 없으면, 클라우드 확인이 끝날 때까지 잠깐 대기 화면
    if (noPin && !cloudChecked) {
        return (
            <div className="h-full w-full flex items-center justify-center bg-slate-50">
                <Loader2 className="w-6 h-6 text-slate-300 animate-spin" />
            </div>
        );
    }

    const unlocked = noPin || unlockedVersion === config.version;

    if (unlocked) {
        return (
            <>
                {noPin && (
                    <div className="fixed left-1/2 -translate-x-1/2 z-[9999] flex items-center gap-1.5 bg-amber-500 text-white text-[11px] font-bold px-3.5 py-2 rounded-full shadow-lg whitespace-nowrap"
                        style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 1rem)' }}>
                        <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                        PIN 잠금 꺼짐 — 사이드바 아래 "PIN 변경"에서 설정하세요
                    </div>
                )}
                {children}
            </>
        );
    }

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (pinInput.length > 0 && verifyPin(config, pinInput)) {
            setError('');
            if (remember) trustThisDevice(config.version);
            setUnlockedVersion(config.version);
        } else {
            setError('PIN이 올바르지 않습니다.');
            setPinInput('');
        }
    };

    return (
        <div className="h-full w-full flex items-center justify-center bg-slate-50 px-6 overflow-y-auto">
            <form onSubmit={handleSubmit} className="w-full max-w-xs bg-white rounded-2xl shadow-lg border border-slate-200 p-6">
                <div className="flex flex-col items-center mb-5">
                    <div className="w-12 h-12 rounded-xl bg-blue-600 flex items-center justify-center mb-3">
                        <Lock className="w-6 h-6 text-white" />
                    </div>
                    <h1 className="font-bold text-slate-800 text-base">MediNote AI</h1>
                    <p className="text-xs text-slate-400 mt-1">PIN 번호를 입력해주세요</p>
                </div>

                <div className="relative mb-3">
                    <input
                        type={showPin ? 'text' : 'password'}
                        inputMode="numeric"
                        autoFocus
                        value={pinInput}
                        onChange={e => { setPinInput(e.target.value); setError(''); }}
                        placeholder="••••"
                        className="w-full text-center tracking-[0.5em] text-lg font-bold px-4 py-3 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400"
                    />
                    <button
                        type="button"
                        onClick={() => setShowPin(s => !s)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-300 hover:text-slate-500"
                        tabIndex={-1}
                    >
                        {showPin ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                </div>

                {error && <p className="text-xs text-red-500 text-center mb-3">{error}</p>}

                <label className="flex items-center gap-2 mb-4 text-xs text-slate-500 select-none cursor-pointer">
                    <input
                        type="checkbox"
                        checked={remember}
                        onChange={e => setRemember(e.target.checked)}
                        className="w-3.5 h-3.5 rounded border-slate-300 text-blue-600 focus:ring-blue-400"
                    />
                    이 기기 기억하기 (다음부터 PIN 생략)
                </label>

                <button
                    type="submit"
                    disabled={!pinInput}
                    className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold text-sm py-3 rounded-xl transition-colors active:scale-95"
                >
                    확인
                </button>

                <p className="text-[10px] text-slate-300 text-center mt-4 flex items-center justify-center gap-1">
                    <ShieldCheck className="w-3 h-3 shrink-0" /> 공용 기기에서는 "기기 기억하기"를 체크하지 마세요
                </p>
            </form>
        </div>
    );
};

export default PinGate;
