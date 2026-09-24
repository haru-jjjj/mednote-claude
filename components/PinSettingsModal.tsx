import React, { useState } from 'react';
import { KeyRound, X, Loader2, CheckCircle2 } from 'lucide-react';
import { changePin, getInitialPinConfig, PinChangeError } from '../services/authService';

interface PinSettingsModalProps {
    onClose: () => void;
}

const MIN_PIN_LENGTH = 4;

// 앱 안에서 PIN을 바꾸는 창. 새 PIN은 클라우드에 저장되어 모든 기기에 적용됩니다.
const PinSettingsModal: React.FC<PinSettingsModalProps> = ({ onClose }) => {
    const [hasPin, setHasPin] = useState(() => getInitialPinConfig().source !== 'none');
    const [currentPin, setCurrentPin] = useState('');
    const [newPin, setNewPin] = useState('');
    const [confirmPin, setConfirmPin] = useState('');
    const [error, setError] = useState('');
    const [pending, setPending] = useState('');
    const [saving, setSaving] = useState(false);
    const [done, setDone] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (saving) return;
        setError('');
        if (newPin.length < MIN_PIN_LENGTH) {
            setError(`새 PIN은 ${MIN_PIN_LENGTH}자리 이상으로 정해주세요.`);
            return;
        }
        if (newPin !== confirmPin) {
            setError('새 PIN과 확인 입력이 서로 다릅니다.');
            return;
        }
        if (hasPin && !currentPin) {
            setError('현재 PIN을 입력해주세요.');
            return;
        }
        setSaving(true);
        setPending('');
        try {
            await changePin(hasPin ? currentPin : null, newPin);
            setDone(true);
        } catch (err: any) {
            if (err instanceof PinChangeError && err.code === 'NEEDS_CURRENT') setHasPin(true);
            if (err instanceof PinChangeError && err.code === 'WRONG_CURRENT') setCurrentPin('');
            if (err instanceof PinChangeError && err.code === 'PENDING') setPending(err.message);
            else setError(err?.message || 'PIN 변경에 실패했습니다.');
        } finally {
            setSaving(false);
        }
    };

    const inputClass = "w-full text-center tracking-[0.4em] text-base font-bold px-4 py-2.5 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400";

    return (
        <div
            className="fixed inset-0 z-[200] bg-black/40 backdrop-blur-sm flex items-center justify-center p-4"
            onClick={() => { if (!saving) onClose(); }}
        >
            <div
                className="w-full max-w-xs bg-white rounded-2xl shadow-xl border border-slate-200 p-5"
                onClick={e => e.stopPropagation()}
            >
                <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-2 font-bold text-slate-800">
                        <KeyRound className="w-4 h-4 text-blue-600" />
                        {hasPin ? 'PIN 변경' : 'PIN 설정'}
                    </div>
                    <button onClick={onClose} disabled={saving} className="p-1 text-slate-400 hover:text-slate-600 rounded-full" aria-label="닫기">
                        <X className="w-4 h-4" />
                    </button>
                </div>

                {done ? (
                    <div className="text-center space-y-3">
                        <CheckCircle2 className="w-10 h-10 text-emerald-500 mx-auto" />
                        <p className="text-sm font-bold text-slate-800">{hasPin ? 'PIN이 변경되었습니다.' : 'PIN이 설정되었습니다.'}</p>
                        <p className="text-xs text-slate-500 leading-relaxed">
                            모든 기기에 적용됩니다. 다른 기기에서 "이 기기 기억하기"로 들어가 있던 경우에도 다음 접속 때 새 PIN을 입력해야 합니다.
                        </p>
                        <button onClick={onClose} className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold text-sm py-2.5 rounded-xl">
                            확인
                        </button>
                    </div>
                ) : (
                    <form onSubmit={handleSubmit} className="space-y-3">
                        {hasPin && (
                            <div>
                                <label className="block text-[11px] font-bold text-slate-500 mb-1">현재 PIN</label>
                                <input type="password" inputMode="numeric" autoFocus value={currentPin}
                                    onChange={e => { setCurrentPin(e.target.value); setError(''); }}
                                    className={inputClass} />
                            </div>
                        )}
                        <div>
                            <label className="block text-[11px] font-bold text-slate-500 mb-1">새 PIN ({MIN_PIN_LENGTH}자리 이상)</label>
                            <input type="password" inputMode="numeric" autoFocus={!hasPin} value={newPin}
                                onChange={e => { setNewPin(e.target.value); setError(''); }}
                                className={inputClass} />
                        </div>
                        <div>
                            <label className="block text-[11px] font-bold text-slate-500 mb-1">새 PIN 확인</label>
                            <input type="password" inputMode="numeric" value={confirmPin}
                                onChange={e => { setConfirmPin(e.target.value); setError(''); }}
                                className={inputClass} />
                        </div>

                        {error && <p className="text-xs text-red-500 leading-relaxed">{error}</p>}
                        {pending && <p className="text-xs text-amber-600 leading-relaxed">{pending}</p>}

                        <button
                            type="submit"
                            disabled={saving || !newPin || !confirmPin}
                            className="w-full flex items-center justify-center gap-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold text-sm py-2.5 rounded-xl transition-colors"
                        >
                            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
                            {hasPin ? '변경하기' : '설정하기'}
                        </button>
                        <p className="text-[10px] text-slate-400 leading-relaxed">
                            새 PIN은 클라우드에 저장되어 모든 기기에 적용되고, 이 기기는 로그인 상태가 유지됩니다.
                        </p>
                    </form>
                )}
            </div>
        </div>
    );
};

export default PinSettingsModal;
