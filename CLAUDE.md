# CLAUDE.md — 项目上下文记忆

> 本文件是给 AI 助手（和新人）的项目脉络速查。新会话请**先读本文件**，
> 再读 `README.md` 和源码，可快速接手。本项目所有重要决策、踩过的坑、
> 演进历史都在这里。

## 一句话简介

Chrome DevTools 扩展，调试 **Cocos Creator 3.x** 网页游戏。两个 Tab：
「节点树」（查看并编辑场景节点树）、「资源缓存」（查看/释放 assetManager 缓存的资源）。

- 目标引擎：Cocos Creator **3.x**（用户实际用 3.5.2，引擎源码在 `D:\wzy\client\3.5.2-client\creator-engine`）
- 技术栈：TypeScript + Vite + Chrome MV3，无第三方 UI 库
- 构建：`npm run build` → 产物在 `dist/`，到 `chrome://extensions` 加载 `dist/`

## 架构核心（最重要的 5 件事）

### 1. 跨世界访问 window.cc：用 inspectedWindow.eval
Content script 在隔离世界，**无法**访问页面 `window.cc`。本扩展用
`chrome.devtools.inspectedWindow.eval()`——它天然在被检查页面的**主世界**执行，
直接访问 `window.cc`，无需 content script / background / 跨世界消息。
返回值必须可 JSON 序列化，所以注入脚本里把节点树/资源"拍平"成纯对象。
这是 React/Vue DevTools 的同一套机制。

### 2. 两个数据视图共享同一套基础设施
- `cocos-inspector.ts`：节点序列化脚本（遍历 `cc.director.getScene()`）+ 字段写回脚本
- `assets-inspector.ts`：资源序列化脚本（遍历 `cc.assetManager.assets`）+ 释放脚本
- 两者都用 `inspectedWindow.eval`，UI 都用左右分栏 + 搜索 + 轮询，复用 panel.ts 的状态管理

### 3. 字段编辑器注册表（节点属性可编辑的核心设计）
节点详情面板（`details.ts`）顶部有一个 `EDITABLE_FIELDS` 注册表：
```ts
const EDITABLE_FIELDS: Record<string, FieldSpec[]> = { Sprite:[...], Label:[...], ... }
```
- 声明"组件 → 可编辑字段（控件类型+选项）"
- `renderComponent` 按注册表自动渲染控件，未登记字段退回只读表格
- 写回脚本 `handleComponentPath` 通用化：按 `<类名小写>.<字段>` 路径自动找到组件并赋值
- **给任何组件加可编辑属性只需在注册表加一行**，无需改写回脚本

### 4. 树默认全折叠 + 选中路径自动展开
节点树不是默认展开根+一层，而是**默认全折叠**。选中节点时自动展开从根到它的祖先链。
用户手动展开的节点记入 `expanded` 集合，跨刷新保持。

### 5. 两种刷新路径分离
- 手动刷新（按钮/R）：重置选中，全新状态
- 轮询刷新（可选开关 + 间隔档位）：**智能保留状态**——保留选中、保留展开、
  保留滚动位置、用户正在编辑输入框时跳过本次详情刷新
- 轮询按**当前激活 Tab** 工作

## 文件结构与职责

```
根目录：
  devtools.html / devtools.ts   DevTools 入口，注册"Cocos"面板
  panel.html                    面板页（工具条 + Tab 条 + 两视图）
  vite.config.ts                多 HTML 入口构建，base:'./'
  package.json                  vite + typescript + @types/chrome
src/
  types.ts                      所有类型：SerializedNode/ComponentInfo/
                                FieldSpec/AssetSnapshot/NodeFieldPath 等
  devtools/devtools.ts          chrome.devtools.panels.create 注册面板
  panel/
    panel.ts                    ★入口：Tab切换/刷新/搜索/选中/编辑写回/轮询
    panel.css                   深色主题 + Tab + 分栏 + Inspector 控件
    tree.ts                     节点树渲染（选中/过滤/折叠保持/选中路径展开）
    details.ts                  节点详情：EDITABLE_FIELDS注册表 + 通用renderComponent
    cocos-inspector.ts          节点序列化脚本 + 字段写回脚本(setNodeField)
    assets-view.ts              资源视图：分组树(类型/bundle)+详情+释放按钮
    assets-inspector.ts         资源序列化脚本 + 释放脚本
```

## 关键技术陷阱（踩过的坑，别再踩）

### ⚠️ Cocos 3.x 引擎 API 细节
1. **节点子项字段双保险**：用 `n.children || n._children`。3.x 公开是 `children`，
   部分场景能见到私有 `_children`。
2. **3.8.4+ setter 陷阱**：必须把新值传给 setter（`setPosition`/`setScale`/
   `setRotationFromEuler`），**不能**修改 readonly 返回的 Vec3 再赋值，否则不触发
   dirty flag、渲染不更新。本扩展每次都构造新值传给 setter。
3. **资源引用计数字段是 `_ref`，不是 `_reference`**。公开 getter 是 `refCount`。
   `addRef()`/`decRef()` 操作的就是 `_ref`。曾因读 `_reference`（不存在）导致永远显示 0。
4. **资源的 `name` 通常为空**：资源用 `_uuid` 标识，`_name` 不参与序列化，加载时
   引擎不赋值。显示可读名要用 uuid 反查 bundle config 的 `path`。
5. **rotation 是 Quat**：序列化时用 `node.eulerAngles` 转欧拉角，写回时 `setRotationFromEuler`。
6. **bundle 归属判定**：单个 Asset 不记录所属 bundle。要遍历每个 bundle 的
   `config.assetInfos`（uuid→info）建倒排索引来判定。`bundle.getAssetInfo(uuid)` 查这个。
7. **资源释放**：`cc.assetManager.releaseAsset(asset)` 需传 asset 实例，eval 时只有
   uuid，脚本里先 `assets.get(uuid)` 取出再 release。
8. **组件序列化**：用 `n.components || n._components`，类名取
   `constructor.name || __classname__`，去掉 `cc.` 前缀。

### ⚠️ Chrome 扩展 / TypeScript 细节
1. **vite base 必须 `./`**：否则 chrome-extension:// 协议下资源路径错误。
2. **视图切换 CSS 特异性**：`.view{display:none}` 会被同特异性的 `.layout{display:flex}`
   覆盖。要用 `.view.layout`（双类，特异性更高）确保 display:none 生效。
3. **联合类型 keydown 监听器**：`HTMLInputElement|HTMLTextAreaElement` 联合上
   addEventListener('keydown') 会退化为 Event 参数，需 `as HTMLElement` 窄化。
4. **叶子节点也要绑事件**：树渲染时无子节点不能 `return` 早退，否则行没绑定点击事件
   无法选中——选中和折叠逻辑要解耦。

## 已实现能力清单（当前状态）

### 节点树 Tab
- 场景节点树（默认全折叠 + 选中路径自动展开）
- 可编辑 Node 属性：active/name/layer/position/rotation/scale（失焦/Enter 写回）
- 可编辑 UITransform：ContentSize/AnchorPoint
- 可编辑组件属性（EDITABLE_FIELDS 注册表）：
  - Sprite：color(拾色器+Alpha)/type/sizeMode(下拉)/trim(复选框)
  - Label：string/fontSize/color/lineHeight/HAlign/VAlign/Overflow
  - RichText：string(多行)/fontSize/maxWidth/lineHeight
  - Widget：四边距离 + 四对齐开关
  - Layout：type/spacing/padding
  - UIOpacity：opacity
- 每个组件头部 enable 复选框
- 资源引用字段(spriteFrame/font)只读

### 资源缓存 Tab
- 遍历 cc.assetManager.assets，按类型/Bundle 两种分组维度切换
- 资源名用 uuid 反查 bundle config path（不显示 unnamed）
- 引用计数(refCount)、依赖数、bundle 归属
- 资源详情面板 + 释放资源按钮(releaseAsset)
- 搜索/轮询/分栏与节点树一致

### 通用
- 左右分栏可拖拽（各视图独立记忆宽度）
- 搜索（按 Tab 分别过滤）
- 手动刷新 + 智能轮询（按当前 Tab 刷新）
- 快捷键：R刷新 / /搜索 / Enter提交 / ←→折叠

## 演进历史（版本脉络）

- **v0.1** 初始：DevTools 面板 + 节点树（手动刷新，仅展示）
- **v0.2** 节点详情面板 + 组件列表 + 高亮 + 搜索
- **v0.3** 去除高亮；基础属性改为可编辑 Inspector（position/rotation/scale/layer）
- **v0.4** 树默认全折叠+选中路径展开；组件 enable 复选框；Widget/Layout 可编辑
- **v0.5** Widget/Layout 降为普通组件；新增 Sprite/Label/RichText 可编辑（字段编辑器注册表架构）
- **（小迭代）** 刷新机制：手动+轮询（智能保留状态）
- **（修bug）** 叶子节点无法选中（事件未绑定）
- **（修bug）** Tab 切换视图不隐藏（CSS 特异性）
- **（新功能）** 资源缓存 Tab（assetManager.assets）+ 按类型/bundle 分组 + 释放
- **（修bug）** 资源 name 显示 path、refCount 读 _ref（不是 _reference）

## 已知限制 / 后续可做

- 不支持 Cocos 2.x（代码保留 `_children`/`_components` 回退而已）
- 资源引用字段(spriteFrame/font)不可编辑（只读）
- 未做资源快照导出（CSV/对比两次）
- 未做 bundle 层级整包释放
- 未做组件属性的"撤销/重做"
- 开发时无热重载（改代码后到 chrome://extensions 手动刷新扩展）

## 开发与验证

```bash
npm install        # 装依赖
npm run build      # 构建（产物在 dist/）
npx tsc --noEmit   # 类型检查（strict 模式）
npm run dev        # vite build --watch，文件改动自动重建
```

验证清单：构建后到 `chrome://extensions` 刷新扩展 → 重开 DevTools → 打开 Cocos 游戏页 →
切到"Cocos"面板。两个 Tab：节点树 / 资源缓存。

## 给未来接手者的提醒

1. 改注入脚本（cocos-inspector.ts / assets-inspector.ts 里的字符串脚本）时，
   记得那是**纯 JS 字符串**，不能引用外部 TS 变量，返回值必须可 JSON 序列化。
2. 加新可编辑组件属性：只在 `details.ts` 的 `EDITABLE_FIELDS` 注册表加一行，
   写回脚本已通用化（按 `<类名小写>.<字段>` 自动分发），无需改写回。
3. 改 UI 布局注意 CSS 特异性：`.layout` 的 `display:flex` 会覆盖 `.view`，
   视图切换要用 `.view.layout` 组合选择器。
4. 用户引擎版本 3.5.2，引擎源码在 `D:\wzy\client\3.5.2-client\creator-engine`，
   遇到不确定的 API 去那里查。
