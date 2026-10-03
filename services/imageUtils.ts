// 사진 줄이기: 긴 변 1280px, JPEG 품질 0.7 → 순수 base64 (메모 작성 화면과 같은 방식)
export const MAX_IMAGE_SIDE = 1280;

export const resizeAndCompressImage = (file: Blob): Promise<string> =>
    new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = e => {
            const img = new Image();
            img.onload = () => {
                let { width, height } = img;
                const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(width, height));
                width = Math.round(width * scale);
                height = Math.round(height * scale);
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                if (!ctx) { reject(new Error('canvas')); return; }
                ctx.fillStyle = '#ffffff'; // 투명 PNG가 검게 나오지 않게
                ctx.fillRect(0, 0, width, height);
                ctx.drawImage(img, 0, 0, width, height);
                resolve(canvas.toDataURL('image/jpeg', 0.7).split(',')[1]);
            };
            img.onerror = reject;
            img.src = e.target?.result as string;
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });

export const imageSrc = (img: string) => (img.startsWith('http') ? img : `data:image/jpeg;base64,${img}`);
