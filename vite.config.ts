import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    return {
      server: {
        port: 3000,
        host: '0.0.0.0',
      },
      plugins: [react()],
      define: {
        // 주의: 이 값은 빌드된 JS 번들에 그대로 박혀서 브라우저에 노출됩니다.
        // (프론트엔드에서 Claude API를 직접 호출하는 구조를 그대로 쓰기로 한 결정에 따른 것)
        'process.env.API_KEY': JSON.stringify(env.ANTHROPIC_API_KEY),
        'process.env.ANTHROPIC_API_KEY': JSON.stringify(env.ANTHROPIC_API_KEY),
        'process.env.VITE_ANTHROPIC_API_KEY': JSON.stringify(env.ANTHROPIC_API_KEY)
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
