# Cocos DevTools — Chrome 扩展

在 Chrome DevTools 里新增一个 **"Cocos"** 面板，以可折叠树形展示当前运行中的
**Cocos Creator 3.x** 游戏场景节点树。

## 功能

面板顶部有两个 **Tab**：「节点树」和「资源缓存」。两个视图共用刷新、搜索、轮询、左右分栏。

### 节点树 Tab

- 读取 `window.cc.director.getScene()` 并递归展示节点树
- **树默认全折叠**（仅根可见）；选中节点时自动展开从根到它的整条路径；手动展开的节点跨刷新保持
- `active = false` 的节点名置灰
- **左右分栏**：左侧节点树，右侧节点详情面板（可拖拽分隔条调宽）
- **可编辑 Node 属性**（失焦/Enter 写回游戏节点）：
  - `active` 复选框、`name`、`layer`
  - `position` (X/Y/Z)、`rotation`（欧拉角度 X/Y/Z）、`scale` (X/Y/Z)
- **可编辑 UITransform**（节点含该组件时）：ContentSize (W/H)、AnchorPoint (X/Y)
- **组件可编辑属性**（每个组件在组件列表里，头部带 enable 复选框）：
  - Sprite：color(拾色器+Alpha)、type/sizeMode(下拉)、trim(复选框)
  - Label：string(文本)、fontSize/lineHeight(数字)、color(拾色器)、horizontalAlign/verticalAlign/overflow(下拉)
  - RichText：string(多行文本)、fontSize/maxWidth/lineHeight(数字)
  - Widget：四边距离(数字)、四个对齐开关(复选框)
  - Layout：type(下拉)、spacing/padding(数字)
  - UIOpacity：opacity(数字)
  - 资源引用字段（spriteFrame/font 等）只读
- **搜索**：输入实时过滤树，保留命中项及其祖先链
- **手动刷新**（顶部按钮或快捷键 `R`）：重置选中，获取全新状态
- **轮询刷新**（可选）：勾选工具条「轮询」开关即开启定时刷新；间隔可调（0.5s/1s/2s/5s）。
  轮询会**智能保留状态**——保留选中节点、保留手动展开/折叠、用户正在编辑输入框时跳过本次详情刷新

### 资源缓存 Tab

读取 `cc.assetManager.assets`（已加载资源缓存），以**分组树**展示。资源视图顶部可切换分组维度：
**按类型** 或 **按 Bundle**。

```
按类型：                      按 Bundle：
📁 Texture (12)              📦 main (45)
   ├─ hero.png  @resources      ├─ hero.png  Texture
   ├─ bg.png    @main           ├─ bg.png    Texture
📁 SpriteFrame (8)          📦 resources (30)
📁 AudioClip (3)            📦 (unbundled) (5)
```

- 顶层 = 分组键（类型 `constructor.name` / 或所属 bundle 名），按数量排序；展开看组内资源
- 每个资源显示名称 + 次要信息（按类型分组时显示 `@bundle`，按 bundle 分组时显示类型）+ 引用计数
- 引用计数为 0 的资源置灰（可能可释放）；`(unbundled)` 组是无法判定 bundle 归属的资源，永远排在最后
- **资源详情面板**：点选资源显示 类型/uuid/**bundle**/引用计数/依赖数
- **释放资源按钮**：调用 `cc.assetManager.releaseAsset(asset)` 释放该资源（排查内存泄漏用）
- 支持搜索（资源名/类型/bundle）、轮询、左右分栏

**bundle 归属判定**：单个 Asset 本身不记录所属 bundle，扩展在序列化时遍历所有已加载 bundle 的
`config.assetInfos`（uuid→信息缓存），一次性建立 uuid→bundleName 倒排索引，再给每个资源打标。
无法匹配的归入 `(unbundled)`。

- 深色主题，贴合 DevTools 风格

## 工作原理

扩展通过 `chrome.devtools.inspectedWindow.eval()` 在**被检查页面的主世界**执行一段
序列化脚本。该脚本访问 `window.cc`，从场景根节点递归地把节点树"拍平"成纯 JSON 对象
（`name` / `active` / `uuid` / `childCount` / `children`）回传给面板，面板再渲染成树。

之所以用 `inspectedWindow.eval` 而不是 content script：content script 运行在隔离世界，
无法直接访问页面的 `window.cc`。`eval` 天然在页面主世界执行，无需 background 中转或
跨世界消息桥接 —— 这正是 React/Vue DevTools 采用的同一套机制。

子节点字段用 `n.children || n._children` 双保险：3.x 公开字段是 `children`，但部分场景
能见到私有 `_children`。

资源缓存 Tab 同样用 `inspectedWindow.eval` 遍历 `cc.assetManager.assets`（ICache<Asset>，
有 forEach），每项提取 uuid/name/类型/引用计数/依赖数/**bundle 归属**。引用计数读 `asset._reference`（3.x
release-manager 用此字段）。bundle 归属通过遍历所有 bundle 的 `config.assetInfos` 建倒排索引判定。
释放资源时按 uuid 取出 asset 再调 `releaseAsset`。

组件属性走硬编码白名单（Sprite/Label/UITransform/UIOpacity/Button/Layout/Widget/Mask/Animation
等），命中白名单的组件会枚举常用属性；未命中的组件只列类名。属性值经净化：Vec3/Size/Rect/Color
转纯对象，资源/节点引用转占位字符串防循环引用。

**编辑写回**：在面板修改数值后（失焦或按 Enter），扩展通过 `inspectedWindow.eval` 在页面主世界
调用对应的 setter 修改节点：
- `setPosition(x,y,z)` / `setScale(Vec3)` / `setRotationFromEuler(x,y,z)`（欧拉角→四元数）
- `active` / `name` / `layer` 直接赋值
- UITransform：`setContentSize(w,h)` / `setAnchorPoint(x,y)`
- 组件属性（Sprite/Label/RichText/Widget/Layout/UIOpacity 等）：按字段类型直接赋值；color 用 `new cc.Color(r,g,b,a)`；Widget 改后调 `updateAlignment()`
- 组件 enabled：`component.enabled = bool`
- **3.8.4+ 兼容**：每次都传新构造的值给 setter，不修改 readonly 返回值，规避 dirty flag 不触发的陷阱
- 写回成功后同步更新本地缓存，无需整树重抓；改 name 会刷新树显示

**字段编辑器注册表**：哪些组件的哪些字段可编辑，由 `details.ts` 顶部的 `EDITABLE_FIELDS` 注册表声明。
要给其他组件（Button/Mask/ScrollView 等）加可编辑字段，只需在注册表里加一行字段描述即可，
无需改写回脚本（写回脚本已通用化，按 `<类名小写>.<字段>` 路径自动分发）。

## 目录结构

```
ZCodeProject/
├── package.json              # vite + typescript + @types/chrome
├── tsconfig.json
├── vite.config.ts            # 两个 HTML 入口(devtools/panel)
├── devtools.html             # DevTools 入口页（注册面板）
├── panel.html                # 面板页
├── public/
│   ├── manifest.json         # MV3 清单
│   └── icons/                # 占位图标
├── scripts/
│   └── gen-icons.ps1         # 生成占位图标的脚本
└── src/
    ├── types.ts              # SerializedNode / ComponentInfo / SerializedAsset 等类型
    ├── devtools/devtools.ts  # 注册 "Cocos" 面板
    └── panel/
        ├── panel.ts          # 入口：Tab 切换/刷新/搜索/选中/编辑写回/轮询状态管理
        ├── panel.css         # 深色主题 + Tab + 左右分栏 + Inspector 控件样式
        ├── tree.ts           # 节点树渲染（选中/过滤/折叠保持）
        ├── details.ts        # 节点详情可编辑 Inspector（Node 变换 + 组件）
        ├── cocos-inspector.ts# 节点序列化脚本 + 写回脚本
        ├── assets-inspector.ts# 资源序列化脚本 + 释放脚本
        └── assets-view.ts    # 资源缓存视图（分组树 + 详情 + 释放）
```

## 构建

需要 Node.js 18+。

```bash
npm install
npm run build
```

产物输出到 `dist/`。

## 在 Chrome 中加载

1. 运行 `npm run build`
2. 打开 `chrome://extensions`
3. 右上角开启 **开发者模式**
4. 点击 **加载已解压的扩展程序**，选择项目下的 `dist/` 目录
5. 打开任意 Cocos Creator 3.x 游戏页面
6. 按 `F12` 打开 DevTools，切到 **"Cocos"** 选项卡
7. 面板会自动读取一次；之后点「刷新」或按 `R` 重新读取

## 开发

```bash
npm run dev   # 等同 vite build --watch，文件改动后自动重新构建到 dist/
```

改完代码后，到 `chrome://extensions` 点该扩展卡片上的「刷新」按钮，再重新打开 DevTools
即可看到更新（第一版未做热重载）。

## 故障排查

| 现象 | 原因 |
|------|------|
| 状态显示「未检测到 window.cc」 | 当前页面不是 Cocos 游戏，或引擎尚未初始化完成 |
| 状态显示「检测到 cc，但当前没有运行中的场景」 | 场景未加载/已销毁 |
| DevTools 里没有 "Cocos" 选项卡 | 扩展未正确加载，检查 `chrome://extensions` 是否报错 |
| 树为空但状态是「已连接」 | 场景根节点确实没有子节点 |
| 修改数值后输入框变红 | 写回失败，状态栏会显示原因（节点已销毁 / 无 UITransform 等） |
| UITransform 区没出现 | 该节点无 UITransform 组件（3D 节点） |
| 组件只显示类名没有属性 | 该组件不在硬编码白名单内；可在 `cocos-inspector.ts` 的 `COMP_PROPS` 里补充 |
| 改完值刷新后又变回去 | 游戏脚本每帧覆盖了该值（如动画/Tween 在持续修改），非扩展问题 |

## 快捷键

- `R` — 手动刷新场景树
- `/` — 聚焦搜索框
- `Enter` — 提交当前编辑框的值（写回节点）
- 树行：`Enter`/`空格` 选中，`←`/`→` 折叠展开

## 刷新机制

扩展提供两种刷新方式：

**手动刷新**（按钮 / `R` 键）：重置选中状态，重新读取整棵场景树。适合需要全新状态的场景。

**轮询刷新**（工具条「轮询」复选框 + 间隔下拉）：
- 勾选开启，取消关闭；间隔可选 0.5s / 1s / 2s / 5s
- 用 setTimeout 递归调度（非 setInterval），避免上次未完成就触发下一次
- 上一次刷新未完成时跳过本次
- **智能保留状态**：
  - 保留当前选中节点（节点被销毁时才清空）
  - 保留手动展开/折叠状态
  - 保留树滚动位置
  - 用户正在编辑详情面板的输入框时，跳过本次详情刷新，避免打断输入
- 轮询失败不清空已有数据，仅状态栏提示，下次自动重试

## 范围

已实现：**Tab 切换**（节点树 ↔ 资源缓存）；节点树（默认全折叠 + 选中路径自动展开）、左右分栏、
可编辑 Node 属性（active/name/position/rotation/scale/layer）、可编辑 UITransform、
可编辑组件属性（Sprite/Label/RichText/Widget/Layout/UIOpacity，含拾色器/下拉/复选框/文本）、
每个组件 enable 复选框、资源引用字段只读；
资源缓存（按类型分组树、引用计数显示、资源详情、释放资源按钮）；
搜索、手动刷新 + 智能轮询刷新（按当前 Tab）、手动展开跨刷新保持。

暂不做：spriteFrame/font 等资源引用的编辑、自动轮询刷新、Cocos 2.x 专门适配
（代码已保留 `_children` 回退）。给其他组件加可编辑属性只需扩展 `EDITABLE_FIELDS` 注册表。

## 重新生成图标

```powershell
powershell -ExecutionPolicy Bypass -File scripts\gen-icons.ps1
```
