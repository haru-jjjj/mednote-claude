import React, { useEffect, useState } from 'react';
import { X, ZoomIn, ZoomOut, Loader2, ImageOff } from 'lucide-react';
import type { PdfImage } from '../types';
import { getPdfImage } from '../services/pdfLibrary';

// PDF에서 저장한 그림 보기 (§5-87): 작은 그림 목록 + 눌러서 크게 보기
// 본문 읽기(구간 아래)·문제 해설의 근거·그림 모아 보기에서 함께 씀

const useImage = (docId: string, imgId: string) => {
    const [url, setUrl] = useState<string | null | undefined>(undefined); // undefined = 불러오는 중, null = 없음
    useEffect(() => {
        let alive = true;
        setUrl(undefined);
        getPdfImage(docId, imgId).then(u => { if (alive) setUrl(u); }).catch(() => { if (alive) setUrl(null); });
        return () => { alive = false; };
    }, [docId, imgId]);
    return url;
};

const Thumb: React.FC<{ docId: string; img: PdfImage; onOpen: () => void; height: number }> = ({ docId, img, onOpen, height }) => {
    const url = useImage(docId, img.id);
    const width = Math.max(48, Math.min(height * 2.2, Math.round((img.w / Math.max(1, img.h)) * height)));
    return (
        <button
            type="button"
            onClick={onOpen}
            disabled={!url}
            className="relative flex-none max-w-full rounded-lg border border-slate-200 bg-slate-50 overflow-hidden hover:border-accent-300"
            style={{ width, height }}
            title={`p.${img.page}${img.kind === 'page' ? ' 쪽 전체' : ''}`}
        >
            {url === undefined && <Loader2 className="absolute inset-0 m-auto w-4 h-4 animate-spin text-slate-300" />}
            {url === null && <ImageOff className="absolute inset-0 m-auto w-4 h-4 text-slate-300" />}
            {url && <img src={url} alt={`p.${img.page}`} className="w-full h-full object-cover object-top" loading="lazy" />}
            <span className="absolute left-1 bottom-1 text-[10px] font-bold text-slate-600 bg-white/90 rounded px-1">
                p.{img.page}{img.kind === 'page' ? ' 쪽' : ''}
            </span>
        </button>
    );
};

export const PdfImageViewer: React.FC<{ docId: string; images: PdfImage[]; index: number; onClose: () => void; onIndex: (i: number) => void }> = ({ docId, images, index, onClose, onIndex }) => {
    const img = images[index];
    const url = useImage(docId, img?.id || '');
    const [zoom, setZoom] = useState(false);
    useEffect(() => { setZoom(false); }, [index]);
    if (!img) return null;
    return (
        <div className="fixed inset-0 z-[60] bg-slate-900/95 flex flex-col" onClick={onClose}>
            <div className="h-12 px-2 flex items-center gap-1 text-white flex-none" onClick={e => e.stopPropagation()}>
                <button onClick={onClose} className="p-2 text-slate-300 hover:text-white" title="닫기"><X className="w-5 h-5" /></button>
                <span className="text-[13px] font-bold">p.{img.page}{img.kind === 'page' ? ' · 쪽 전체' : ''}</span>
                <span className="text-[12px] text-slate-400 ml-1">{index + 1}/{images.length}</span>
                <button onClick={() => setZoom(z => !z)} className="ml-auto p-2 text-slate-300 hover:text-white" title={zoom ? '화면에 맞추기' : '크게'}>
                    {zoom ? <ZoomOut className="w-5 h-5" /> : <ZoomIn className="w-5 h-5" />}
                </button>
            </div>
            <div className="flex-1 overflow-auto" onClick={e => e.stopPropagation()}>
                {url ? (
                    <img
                        src={url}
                        alt={`p.${img.page}`}
                        onClick={() => setZoom(z => !z)}
                        className={zoom ? 'max-w-none mx-auto' : 'max-w-full max-h-full mx-auto object-contain'}
                        style={zoom ? { width: Math.max(img.w, 1) * 1.6 } : undefined}
                    />
                ) : (
                    <div className="h-full flex items-center justify-center text-slate-400 text-sm">
                        {url === undefined ? <Loader2 className="w-5 h-5 animate-spin" /> : '그림을 불러오지 못했습니다'}
                    </div>
                )}
            </div>
            {images.length > 1 && (
                <div className="h-12 flex items-center justify-center gap-6 text-white flex-none" onClick={e => e.stopPropagation()}>
                    <button disabled={index === 0} onClick={() => onIndex(index - 1)} className="px-4 py-1.5 text-[13px] font-bold text-slate-300 disabled:opacity-30">이전</button>
                    <button disabled={index >= images.length - 1} onClick={() => onIndex(index + 1)} className="px-4 py-1.5 text-[13px] font-bold text-slate-300 disabled:opacity-30">다음</button>
                </div>
            )}
        </div>
    );
};

// 작은 그림 한 줄 (가로로 넘김). 없으면 아무것도 안 그림
export const PdfImageStrip: React.FC<{ docId: string; images: PdfImage[]; height?: number; label?: string }> = ({ docId, images, height = 72, label }) => {
    const [open, setOpen] = useState<number | null>(null);
    if (!images.length) return null;
    return (
        <div className="mt-3">
            {label && <p className="text-[11px] font-bold text-slate-400 mb-1.5">{label}</p>}
            <div className="flex gap-2 overflow-x-auto pb-1">
                {images.map((g, i) => <React.Fragment key={g.id}><Thumb docId={docId} img={g} height={height} onOpen={() => setOpen(i)} /></React.Fragment>)}
            </div>
            {open !== null && <PdfImageViewer docId={docId} images={images} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />}
        </div>
    );
};

// 그림 모아 보기 (자료실 카드에서)
export const PdfImageGallery: React.FC<{ docId: string; title: string; images: PdfImage[]; onClose: () => void }> = ({ docId, title, images, onClose }) => {
    const [open, setOpen] = useState<number | null>(null);
    return (
        <div className="fixed inset-0 z-50 bg-white flex flex-col">
            <div className="h-12 px-2 border-b border-slate-100 flex items-center gap-1 flex-none">
                <button onClick={onClose} className="p-2 text-slate-500 hover:text-slate-800" title="닫기"><X className="w-5 h-5" /></button>
                <h2 className="font-bold text-slate-800 truncate text-[15px]">{title}</h2>
                <span className="ml-auto mr-2 text-[12px] text-slate-400 flex-none">그림 {images.length}</span>
            </div>
            <div className="flex-1 overflow-y-auto">
                <div className="max-w-3xl mx-auto p-4 grid grid-cols-2 sm:grid-cols-3 gap-3">
                    {images.map((g, i) => (
                        <div key={g.id} className="flex justify-center">
                            <Thumb docId={docId} img={g} height={150} onOpen={() => setOpen(i)} />
                        </div>
                    ))}
                    {images.length === 0 && <p className="col-span-full text-sm text-slate-400 text-center py-10">저장된 그림이 없습니다.</p>}
                </div>
            </div>
            {open !== null && <PdfImageViewer docId={docId} images={images} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />}
        </div>
    );
};
