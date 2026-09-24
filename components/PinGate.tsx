import React, { useState, useEffect } from 'react';
import { Lock, Eye, EyeOff, ShieldCheck, AlertTriangle } from 'lucide-react';
import { getAppPin, isDeviceTrusted, trustThisDevice } from '../services/authService';

interface PinGateProps {
    children: React.ReactNode;
}

// 앱 전체를 감싸서, PIN이 맞을 때까지(또는 이미 신뢰된 기기라면 즉시) 하위 컴포넌트를
// 아예 마운트하지 않는 게이트입니다. 이렇게 하면 잠금이 풀리기 전에는 메모 데이터를
// 불러오는 로직 자체가 실행되지 않습니다.
const PinGate: React.FC<PinGateProps> = ({ children }) => {
    const configuredPin = getAppPin();

    const [unlocked, setUnlocked] = useState<boolean>(() => !configuredPin || isDeviceTrusted());
    const [pinInput, setPinInput] = useState('');
    const [remember, setRemember] = useState(false);
    const [error, setError] = useState('');
    const [showPin, setShowPin] = useState(false);

    useEffect(() => {
        if (!configuredPin) {
            console.warn('APP_PIN이 설정되어 있지 않아 접속 잠금이 비활성화되어 있습니다. .env.local에 APP_PIN을 설정하고 개발 서버를 재시작해주세요.');
        }
    }, [configuredPin]);

    // PIN이 설정 안 된 경우 앱은 그대로 열어주되(개발 중 잠기지 않도록), 콘솔 경고만으로는
    // "PIN 기능이 아예 안 만들어진 것"처럼 보일 수 있어 화면에도 눈에 띄게 알려줍니다.
    if (unlocked) {
        return (
            <>
                {!configuredPin && (
                    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[9999] flex items-center gap-1.5 bg-amber-500 text-white text-[11px] font-bold px-3.5 py-2 rounded-full shadow-lg">
                        <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                        PIN 잠금 꺼짐 — .env.local에 APP_PIN 설정 후 서버 재시작 필요
                    </div>
                )}
                {children}
            </>
        );
    }

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (pinInput.length > 0 && pinInput === configuredPin) {
            setError('');
            if (remember) trustThisDevice();
            setUnlocked(true);
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
