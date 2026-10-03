import React, { useLayoutEffect, useRef } from 'react';

// 내용에 맞춰 높이가 늘어나는 입력칸 (Enter 줄바꿈뿐 아니라 화면 폭 때문에 자동으로 넘어가는 줄도 반영).
// maxRows를 넘으면 그 높이에서 멈추고 안쪽에서 스크롤됩니다.
type Props = React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
    minRows?: number;
    maxRows?: number;
};

const AutoTextarea: React.FC<Props> = ({ minRows = 1, maxRows = 8, value, style, ...rest }) => {
    const ref = useRef<HTMLTextAreaElement>(null);

    const resize = () => {
        const el = ref.current;
        if (!el) return;
        const cs = window.getComputedStyle(el);
        const line = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5 || 20;
        const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
        const border = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
        const min = line * minRows + pad + border;
        const max = line * maxRows + pad + border;
        el.style.height = 'auto';
        const needed = el.scrollHeight + border;
        el.style.height = `${Math.min(max, Math.max(min, needed))}px`;
        el.style.overflowY = needed > max ? 'auto' : 'hidden';
    };

    useLayoutEffect(resize, [value, minRows, maxRows]);
    useLayoutEffect(() => {
        // 화면 회전·창 크기 변경으로 줄 수가 바뀌는 경우
        window.addEventListener('resize', resize);
        return () => window.removeEventListener('resize', resize);
    }, []);

    return <textarea ref={ref} rows={minRows} value={value} style={{ resize: 'none', ...style }} {...rest} />;
};

export default AutoTextarea;
