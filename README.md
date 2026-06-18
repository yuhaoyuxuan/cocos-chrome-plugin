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
**按类型**、**按 Bundle** 或 **动态图集**。

```
按类型：                            按 Bundle：
📁 Texture (12) · 8.3 MB          📦 main (45) · 12.4 MB
   ├─ hero.png  @resources  2.1 MB    ├─ hero.png  Texture  2.1 MB
   ├─ bg.png    @main     1024 KB    ├─ bg.png    Texture  1024 KB
📁 SpriteFrame (8)              📦 resources (30) · 4.1 MB
📁 AudioClip (3) · 560 KB        📦 (unbundled) (5)
```

- 顶层 = 分组键（类型 `constructor.name` / 或所属 bundle 名），按数量排序；展开看组内资源
- 分组行在数量后追加**该组总占用内存**（如 `· 8.3 MB`）；无法估算的组只显示数量
- 每个资源显示名称 + 次要信息（按类型分组时显示 `@bundle`，按 bundle 分组时显示类型）+ 引用计数 + **估算占用内存**
- **占用内存**：按资源类型估算（Texture=宽×高×字节/像素、AudioBuffer=样本数×声道×4、RenderTexture=宽×高×4）；不可估算的类型（Material/JSON/Font 等）显示 `—`
- **按内存排序**：工具条「排序」段控件可切「默认（加载顺序）/ 内存（组内按内存降序）」，memory=0 的资源沉到组底
- 引用计数为 0 的资源置灰（可能可释放）；`(unbundled)` 组是无法判定 bundle 归属的资源，永远排在最后
- **资源详情面板**：点选资源显示 类型/uuid/**bundle**/引用计数/依赖数/**估算内存**
- **纹理预览**：选中 **Texture/Texture2D/TextureCube/SpriteFrame** 时，详情顶部显示缩略图（透明区用棋盘格背景，便于看清 alpha 通道）；SpriteFrame 按 `_rect` 裁剪只显示帧区域。压缩纹理（ASTC/ETC2 等非 HTML 图源）显示「无法提取预览」
- **动态图集维度**：读取 `cc.internal.dynamicAtlasManager._atlases`，两级树展示——图集行（`🗺️ Atlas #N · 2048×2048 · 内存`）展开后是已合并的 SpriteFrame 子项（名称 + 源纹理名 + 帧区域）；图集按内存降序；项目未启用动态图集时显示占位；**清空按钮**调 `dynamicAtlasManager.reset()` 整包释放（引擎无法单个释放）
- **动态图集预览**：选中图集时，详情顶部显示合并大纹理预览（棋盘格背景，能看到图集合并了哪些图）；GPU 回读失败时显示提示
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
有 forEach），每项提取 uuid/name/类型/引用计数/依赖数/**bundle 归属**/**估算内存**。引用计数读 `asset._ref`（3.x
release-manager 用此字段，公开 getter 为 `refCount`）。bundle 归属通过遍历所有 bundle 的 `config.assetInfos` 建倒排索引判定。
**内存估算**：Cocos 资源没有官方"占用字节"API，扩展按 `constructor.name` 分发——Texture 优先用引擎
`cc.gfx.FormatSize(format, w, h, 1)`（正确处理压缩纹理块大小），format 取纹理公开的 `getPixelFormat()`
（即 `_format`，PixelFormat 枚举）；不可用时回退 `width×height×bytesPerPixel(format)`（`bytesPerPixel` 查引擎内置
`cc.gfx.FormatInfos` 表的 `size` 字段）；RenderTexture 用 `width×height×4`，AudioBuffer 用 `length×声道数×4`
（f32 采样），AudioClip 汇总内部 `_buffers`；其余类型（Material/JSON/Font/Mesh 等）返回 0（不可估算）。
释放资源时按 uuid 取出 asset 再调 `releaseAsset`。

**纹理预览（懒加载）**：选中 Texture/SpriteFrame 时，扩展用 `inspectedWindow.eval` 单独执行一段脚本
（`fetchAssetPreview`），按 uuid 取出资源后：SpriteFrame 先经 `texture` 取底层纹理并读 `_rect` 裁剪区域，
Texture 直接用本体；再用多条路径兜底取 HTML 图像源（`getHtmlElementObj()` → `image.data` → `mipmaps[0].data`），
画到一张 maxDim=256 的临时 canvas 上 `toDataURL('image/png')` 回传。**不在序列化快照里全量带图**，
避免每次刷新/轮询都为每个纹理生成 dataURL；提取结果缓存到面板级 `Map<uuid, AssetPreview>`，手动刷新时清空
（纹理可能已变），轮询不清空。压缩纹理（ASTC/ETC2/PVRTC）level-0 非 HTML 元素，所有路径拿不到源，
返回 `dataUrl:null` 由前端显示「无法提取预览」。

**动态图集维度（懒加载）**：切到「动态图集」维度时，扩展用 `inspectedWindow.eval` 单独执行一段脚本
（`fetchDynamicAtlas`），读取 `cc.internal.dynamicAtlasManager._atlases`。每个图集提取合并大纹理
（`_texture`）的 `width/height/getPixelFormat()` 算内存（恒为 RGBA8888，即 `width×height×4`），并遍历
`_innerSpriteFrames` 提取已合并的源 SpriteFrame（名称 + 源纹理名 + `rect` 帧区域）。动态图集渲染期实时变化，
**不进资源快照**，仅在切到该维度/手动刷新/轮询时按需拉取。引擎仅提供 `reset()` 整包清空（无法单个释放），
由详情面板的「清空所有动态图集」按钮触发。项目未启用（`enabled=false`）时显示占位。

**动态图集预览（GPU 回读，懒加载）**：动态图集纹理是 GPU 端动态合成的（`drawTextureAt` → `copyTexImagesToTexture`），
**没有 HTML 图像源**（`getHtmlElementObj()` 返回 null），无法复用普通纹理的预览路径。选中图集时扩展单独执行一段
脚本（`fetchAtlasPreview`）：`atlas._texture.getGFXTexture()` 拿 GFX 纹理 → `cc.director.root.device.copyTextureToBuffers`
回读 RGBA8 ArrayBuffer → 包成 `ImageData` → 画到 256px 缩略 canvas → `toDataURL`。结果缓存到面板级
`Map<index, {dataUrl}>`，手动刷新清空（动态图集会变），轮询不清空。GPU 回读失败（个别平台/格式不支持）时
返回 `dataUrl:null`，由前端显示「无法提取预览（GPU 回读失败）」。

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
| 资源内存列显示 `—` | 该资源类型不可估算（Material/JSON/Font 等），仅 Texture/RenderTexture/Audio 等精确估算 |
| 内存值与实际偏差大 | 估算用引擎 `FormatSize` 算，压缩纹理按块计费正确；但仍不含 mipmap 链额外占用（mipmap 总量约原图 1.33 倍） |
| 选中 Texture/SpriteFrame 没显示预览图 | 预览是懒加载，选中后异步提取需几百毫秒；压缩纹理（ASTC/ETC2）无法提取会显示「无法提取预览」 |
| 预览图与实际纹理不符 | 纹理在引擎侧已更新但扩展缓存未刷新，点「刷新」按钮清空预览缓存后重新选中 |
| 动态图集维度显示「未启用」 | 项目未开启动态图集（`cc.internal.dynamicAtlasManager.enabled=false`），需在项目设置开启 |
| 动态图集内存是整张大图占用 | 如 2048×2048 显示约 16MB（RGBA8），即使只塞了 1 张子图，GPU 已分配整张画布 |
| 动态图集选中后显示「GPU 回读失败」 | `copyTextureToBuffers` 在当前 WebGL 环境/纹理格式不支持；少数平台限制，可切回普通纹理维度查看 |

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
资源缓存（按类型/bundle/**动态图集**分组树、引用计数显示、**估算占用内存**、**按内存排序**、**Texture/SpriteFrame 预览图**、资源详情、释放资源按钮）；
搜索、手动刷新 + 智能轮询刷新（按当前 Tab）、手动展开跨刷新保持。

暂不做：spriteFrame/font 等资源引用的编辑、自动轮询刷新、Cocos 2.x 专门适配
（代码已保留 `_children` 回退）。给其他组件加可编辑属性只需扩展 `EDITABLE_FIELDS` 注册表。

## 重新生成图标

```powershell
powershell -ExecutionPolicy Bypass -File scripts\gen-icons.ps1
```
