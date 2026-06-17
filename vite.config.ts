import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

// 两个 HTML 入口都构建到 dist/ 根目录，manifest.json 只引用 devtools.html，
// devtools.ts 再以相对路径 panel.html 注册面板。
// base: './' 保证 chrome-extension:// 页面里所有资源引用是相对路径。
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020',
    rollupOptions: {
      input: {
        devtools: fileURLToPath(new URL('./devtools.html', import.meta.url)),
        panel: fileURLToPath(new URL('./panel.html', import.meta.url)),
      },
    },
  },
});
