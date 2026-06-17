// 在 DevTools 打开时执行一次：注册"Cocos"面板。
// panel.html 与 devtools.html 位于同一构建产物目录（dist/ 根）下，
// 因此这里用相对路径 'panel.html' 即可。
chrome.devtools.panels.create(
  'Cocos', // 面板标题（DevTools 选项卡上的文字）
  '', // 面板图标（留空使用默认；后续可放 icons/icon-16.png）
  'panel.html', // 面板页面
  () => {
    // 面板创建完成回调。第一版无需在此做什么。
  }
);
