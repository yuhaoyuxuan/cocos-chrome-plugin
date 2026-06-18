import { releaseAsset, resetDynamicAtlas, sortedBundleGroups, sortedGroups } from './assets-inspector';
import type {
  AssetPreview,
  AssetSnapshot,
  DynamicAtlas,
  DynamicAtlasFrame,
  DynamicAtlasSnapshot,
  SerializedAsset,
} from '../types';

/** 资源分组维度 */
export type GroupBy = 'type' | 'bundle' | 'dynamicAtlas';

/** 资源组内排序维度：default = 进入缓存的顺序；memory = 按内存降序 */
export type AssetSortBy = 'default' | 'memory';

/** 渲染资源视图的选项 */
export interface AssetRenderOptions {
  /** 搜索关键字（匹配名称或类型） */
  filterText: string;
  /** 分组维度：按类型 / 按 bundle */
  groupBy: GroupBy;
  /** 组内排序：默认（加载顺序）/ 内存降序 */
  sortBy?: AssetSortBy;
  /** 用户手动展开的分组键集合（key = 维度+分组名，如 'type:Texture'） */
  expandedGroups: Set<string>;
  /** 当前选中的资源 uuid */
  selectedUuid: string | null;
  /** 选中资源回调 */
  onSelect: (asset: SerializedAsset) => void;
  /** 切换分组展开回调 */
  onToggleGroup: (groupKey: string) => void;
  /** 释放资源后的回调（由 panel 重新拉取） */
  onReleased: () => void;
}

/** 支持预览图的资源类型（详情面板顶部显示缩略图） */
const PREVIEWABLE_TYPES = new Set(['Texture', 'Texture2D', 'TextureCube', 'SpriteFrame']);

/** 判断资源类型是否支持预览图 */
export function isPreviewable(type: string): boolean {
  return PREVIEWABLE_TYPES.has(type);
}

/** 分组维度的前缀，用于生成唯一展开键 */
function groupKeyPrefix(groupBy: GroupBy): string {
  if (groupBy === 'bundle') return 'bundle:';
  if (groupBy === 'dynamicAtlas') return 'atlas:';
  return 'type:';
}

/**
 * 渲染资源分组树到容器。
 * 结构：分组行（可折叠）→ 该分组下的资源行。
 * 分组维度由 opts.groupBy 决定（类型 / bundle）。
 */
export function renderAssetsTree(
  container: HTMLElement,
  snap: AssetSnapshot | null,
  opts: AssetRenderOptions
): void {
  container.replaceChildren();
  if (!snap || snap.total === 0) {
    container.appendChild(placeholder('（无缓存资源）'));
    return;
  }

  const filter = opts.filterText.trim().toLowerCase();
  const prefix = groupKeyPrefix(opts.groupBy);
  const groups =
    opts.groupBy === 'bundle' ? sortedBundleGroups(snap) : sortedGroups(snap);
  const frag = document.createDocumentFragment();

  const sortByMem = opts.sortBy === 'memory';

  for (const g of groups) {
    // 过滤：搜索时，分组键命中或该组内有资源名/类型/bundle 命中才显示
    let assets = g.assets;
    if (filter) {
      const keyHit = g.type.toLowerCase().includes(filter);
      assets = keyHit
        ? g.assets
        : g.assets.filter(
            (a) =>
              a.name.toLowerCase().includes(filter) ||
              a.type.toLowerCase().includes(filter) ||
              a.bundle.toLowerCase().includes(filter)
          );
      if (assets.length === 0) continue;
    }

    // 组内排序：按内存降序（不改原数组，避免影响快照）。默认保持加载顺序。
    const ordered = sortByMem ? [...assets].sort((a, b) => b.memory - a.memory) : assets;

    // 分组总内存（仅累加已估算的，memory>0 的）
    let groupMem = 0;
    for (const a of ordered) groupMem += a.memory;

    const gKey = prefix + g.type;
    const expanded = filter ? true : opts.expandedGroups.has(gKey);
    const icon = opts.groupBy === 'bundle' ? '📦' : '📁';

    // 分组行（数量 + 总内存）
    const groupRow = makeGroupRow(icon, g.type, ordered.length, groupMem, expanded);
    frag.appendChild(groupRow);

    // 资源行容器
    const childBox = document.createElement('div');
    childBox.className = 'asset-children';
    childBox.hidden = !expanded;
    for (const a of ordered) {
      childBox.appendChild(makeAssetRow(a, opts));
    }
    groupRow.insertAdjacentElement('afterend', childBox);

    // 点击分组行 = 切换展开
    groupRow.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).classList.contains('asset-name')) return;
      opts.onToggleGroup(gKey);
    });
  }

  if (frag.childElementCount === 0) {
    container.appendChild(placeholder('（无匹配资源）'));
    return;
  }
  container.appendChild(frag);
}

/** 创建分组行（数量 + 总内存） */
function makeGroupRow(
  icon: string,
  label: string,
  count: number,
  totalMemory: number,
  expanded: boolean
): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'asset-row asset-group-row';
  const twisty = document.createElement('span');
  twisty.className = 'twisty';
  twisty.textContent = expanded ? '▼' : '▶';
  row.appendChild(twisty);
  const name = document.createElement('span');
  name.className = 'asset-type';
  name.textContent = icon + ' ' + label;
  row.appendChild(name);
  const meta = document.createElement('span');
  meta.className = 'node-meta asset-group-meta';
  // 数量 + 总内存（仅在可估算时显示内存）
  meta.textContent = totalMemory > 0 ? `${count} · ${formatBytes(totalMemory)}` : String(count);
  row.appendChild(meta);
  return row;
}

/** 创建单个资源行（按当前分组维度显示对应的次要信息） */
function makeAssetRow(a: SerializedAsset, opts: AssetRenderOptions): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'asset-row asset-leaf';
  if (a.refCount === 0) row.classList.add('zero-ref');
  if (opts.selectedUuid === a.uuid) row.classList.add('selected');
  row.tabIndex = 0;
  row.dataset.uuid = a.uuid;
  row.style.setProperty('--depth', '1');

  const twisty = document.createElement('span');
  twisty.className = 'twisty';
  twisty.textContent = '';
  row.appendChild(twisty);

  const name = document.createElement('span');
  name.className = 'asset-name';
  name.textContent = a.name || '(unnamed)';
  row.appendChild(name);

  // 次要信息：按类型分组时显示 bundle；按 bundle 分组时显示类型
  const sub = document.createElement('span');
  sub.className = 'asset-sub';
  sub.textContent = opts.groupBy === 'bundle' ? a.type : '@' + a.bundle;
  row.appendChild(sub);

  const ref = document.createElement('span');
  ref.className = 'asset-ref';
  ref.textContent = 'ref:' + a.refCount;
  ref.title = '引用计数';
  row.appendChild(ref);

  // 估算占用内存（仅可估算的资源显示具体值，否则显示 —）
  const mem = document.createElement('span');
  mem.className = 'asset-mem';
  mem.textContent = a.memory > 0 ? formatBytes(a.memory) : '—';
  mem.title = '估算占用内存';
  row.appendChild(mem);

  row.addEventListener('click', () => opts.onSelect(a));
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      opts.onSelect(a);
    }
  });
  return row;
}

/**
 * 渲染资源详情（右栏）。
 * @param onReleased 释放成功后的回调（由 panel 重新拉取快照）
 */
export function renderAssetDetails(
  container: HTMLElement,
  asset: SerializedAsset | null,
  onReleased: () => void,
  preview: AssetPreview | null = null
): void {
  container.replaceChildren();
  if (!asset) {
    container.appendChild(placeholder('在左侧选择一个资源查看详情'));
    return;
  }

  // 头部
  const head = el('div', 'detail-header');
  const title = el('div', 'dh-name-row');
  const badge = el('span', 'badge ' + (asset.refCount > 0 ? 'enabled' : 'disabled'), asset.type);
  title.appendChild(badge);
  title.appendChild(el('span', 'asset-detail-name', asset.name || '(unnamed)'));
  head.appendChild(title);
  container.appendChild(head);

  // 预览图（仅 Texture/SpriteFrame 等可预览类型；preview===null 表示尚未加载或非图像类型）
  if (isPreviewable(asset.type)) {
    container.appendChild(makePreviewBlock(preview));
  }

  // 属性表
  const table = el('table', 'kv-table');
  table.appendChild(kv('uuid', shortUuid(asset.uuid), asset.uuid));
  table.appendChild(kv('name', asset.name || '(空)'));
  table.appendChild(kv('type', asset.type));
  table.appendChild(kv('bundle', asset.bundle || '(unbundled)'));
  table.appendChild(kv('refCount', String(asset.refCount)));
  table.appendChild(kv('depCount', String(asset.depCount)));
  table.appendChild(kv('memory', asset.memory > 0 ? formatBytes(asset.memory) : '—（不可估算）'));
  container.appendChild(table);

  // 释放按钮
  const btnWrap = el('div', 'release-wrap');
  const btn = document.createElement('button');
  btn.className = 'btn btn-release';
  btn.textContent = '释放此资源';
  btn.title = '调用 cc.assetManager.releaseAsset';
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = '释放中…';
    const res = await releaseAsset(asset.uuid);
    if (res.ok) {
      btn.textContent = '已释放';
      onReleased();
    } else {
      btn.disabled = false;
      btn.textContent = '释放失败：' + (res.reason || '');
    }
  });
  btnWrap.appendChild(btn);
  container.appendChild(btnWrap);
}

// ===== 动态图集视图（groupBy === 'dynamicAtlas'）=====

/** 动态图集渲染选项 */
export interface DynamicAtlasRenderOptions {
  filterText: string;
  /** 用户手动展开的图集键集合（key = 'atlas:<index>'） */
  expandedGroups: Set<string>;
  /** 当前选中的项：{ atlasIndex, frameIndex }；frameIndex=-1 表示选中图集本身 */
  selected: { atlasIndex: number; frameIndex: number } | null;
  /** 选中子项回调（panel 层据此从快照查找 atlas/frame） */
  onSelect: (atlasIndex: number, frameIndex: number) => void;
  /** 切换图集展开回调 */
  onToggleGroup: (groupKey: string) => void;
}

/**
 * 渲染动态图集分组树：两级结构
 *   图集行（🗺️ Atlas #0 · 2048×2048 · 内存）→ 展开 → SpriteFrame 子项行
 * 图集按内存降序排列。
 */
export function renderDynamicAtlasTree(
  container: HTMLElement,
  snap: DynamicAtlasSnapshot | null,
  opts: DynamicAtlasRenderOptions
): void {
  container.replaceChildren();
  if (!snap || !snap.enabled) {
    container.appendChild(placeholder('未启用动态图集（在项目设置中开启）'));
    return;
  }
  if (snap.atlases.length === 0) {
    container.appendChild(placeholder('（暂无动态图集，UI 渲染后会自动创建）'));
    return;
  }

  const filter = opts.filterText.trim().toLowerCase();
  // 图集按内存降序
  const atlases = [...snap.atlases].sort((a, b) => b.memory - a.memory);
  const frag = document.createDocumentFragment();

  for (const atlas of atlases) {
    // 过滤：搜索时，图集键命中或子项名/纹理名命中才显示
    let frames = atlas.frames;
    if (filter) {
      const keyHit = ('atlas #' + atlas.index).includes(filter);
      frames = keyHit
        ? atlas.frames
        : atlas.frames.filter(
            (f) =>
              f.name.toLowerCase().includes(filter) ||
              f.textureName.toLowerCase().includes(filter)
          );
      if (frames.length === 0) continue;
    }

    const gKey = 'atlas:' + atlas.index;
    const expanded = filter ? true : opts.expandedGroups.has(gKey);

    // 图集行
    const groupRow = makeAtlasRow(atlas, expanded);
    frag.appendChild(groupRow);

    // 子项容器
    const childBox = document.createElement('div');
    childBox.className = 'asset-children';
    childBox.hidden = !expanded;
    for (let i = 0; i < frames.length; i++) {
      childBox.appendChild(
        makeAtlasFrameRow(atlas.index, i, frames[i], opts)
      );
    }
    groupRow.insertAdjacentElement('afterend', childBox);

    // 点击图集行 = 切换展开
    groupRow.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).classList.contains('atlas-reset-btn')) return;
      opts.onToggleGroup(gKey);
    });
  }

  if (frag.childElementCount === 0) {
    container.appendChild(placeholder('（无匹配图集）'));
    return;
  }
  container.appendChild(frag);
}

/** 创建图集行：🗺️ Atlas #N · WxH · 内存 */
function makeAtlasRow(atlas: DynamicAtlas, expanded: boolean): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'asset-row asset-group-row atlas-row';
  const twisty = document.createElement('span');
  twisty.className = 'twisty';
  twisty.textContent = expanded ? '▼' : '▶';
  row.appendChild(twisty);
  const name = document.createElement('span');
  name.className = 'asset-type';
  name.textContent = '🗺️ Atlas #' + atlas.index;
  row.appendChild(name);
  const meta = document.createElement('span');
  meta.className = 'node-meta asset-group-meta';
  meta.textContent =
    atlas.width + '×' + atlas.height +
    ' · ' + atlas.frameCount + ' 帧' +
    (atlas.memory > 0 ? ' · ' + formatBytes(atlas.memory) : '');
  row.appendChild(meta);
  return row;
}

/** 创建图集子项行：SpriteFrame 名 + 源纹理名 + 帧区域 */
function makeAtlasFrameRow(
  atlasIndex: number,
  frameIndex: number,
  frame: DynamicAtlasFrame,
  opts: DynamicAtlasRenderOptions
): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'asset-row asset-leaf atlas-frame-row';
  if (
    opts.selected &&
    opts.selected.atlasIndex === atlasIndex &&
    opts.selected.frameIndex === frameIndex
  ) {
    row.classList.add('selected');
  }
  row.tabIndex = 0;
  row.dataset.atlas = String(atlasIndex);
  row.dataset.frame = String(frameIndex);
  row.style.setProperty('--depth', '1');

  const twisty = document.createElement('span');
  twisty.className = 'twisty';
  twisty.textContent = '';
  row.appendChild(twisty);

  const name = document.createElement('span');
  name.className = 'asset-name';
  name.textContent = frame.name || '(unnamed)';
  row.appendChild(name);

  // 次要信息：源纹理名
  const sub = document.createElement('span');
  sub.className = 'asset-sub';
  sub.textContent = frame.textureName ? '@' + frame.textureName : '';
  row.appendChild(sub);

  // 帧区域尺寸（靠右）
  const size = document.createElement('span');
  size.className = 'asset-ref';
  size.textContent = frame.rect.width + '×' + frame.rect.height;
  size.title = '源帧区域 (x:' + frame.rect.x + ' y:' + frame.rect.y + ')';
  row.appendChild(size);

  row.addEventListener('click', () => opts.onSelect(atlasIndex, frameIndex));
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      opts.onSelect(atlasIndex, frameIndex);
    }
  });
  return row;
}

/**
 * 渲染动态图集详情（右栏）。
 * @param atlas 选中图集（可含完整 frames）
 * @param frame 选中的子项（null 表示只展示图集本身）
 * @param onReset reset 按钮回调（清空所有动态图集）
 */
export function renderDynamicAtlasDetails(
  container: HTMLElement,
  atlas: DynamicAtlas | null,
  frame: DynamicAtlasFrame | null,
  onReset: () => void,
  preview: { dataUrl: string | null } | null = null
): void {
  container.replaceChildren();
  if (!atlas) {
    container.appendChild(placeholder('在左侧选择一个图集查看详情'));
    return;
  }

  // 头部
  const head = el('div', 'detail-header');
  const title = el('div', 'dh-name-row');
  title.appendChild(el('span', 'badge enabled', 'DynamicAtlas'));
  title.appendChild(el('span', 'asset-detail-name', 'Atlas #' + atlas.index));
  head.appendChild(title);
  container.appendChild(head);

  // 预览图（合并大纹理，GPU 回读；preview===null 表示仍在加载中）
  container.appendChild(
    makePreviewBlock(preview, '无法提取预览（GPU 回读失败）')
  );

  // 属性表
  const table = el('table', 'kv-table');
  table.appendChild(kv('index', String(atlas.index)));
  table.appendChild(kv('size', atlas.width + ' × ' + atlas.height + ' px'));
  table.appendChild(kv('frameCount', String(atlas.frameCount)));
  table.appendChild(kv('memory', atlas.memory > 0 ? formatBytes(atlas.memory) : '—（不可估算）'));
  container.appendChild(table);

  // 子项信息（选中了某帧时显示）
  if (frame) {
    const frameHead = el('div', 'detail-header detail-sub-header');
    frameHead.appendChild(el('span', 'dh-name-row', '选中子项'));
    container.appendChild(frameHead);
    const frameTable = el('table', 'kv-table');
    frameTable.appendChild(kv('name', frame.name || '(空)'));
    frameTable.appendChild(kv('texture', frame.textureName || '(空)'));
    frameTable.appendChild(kv(
      'rect',
      'x:' + frame.rect.x + ' y:' + frame.rect.y +
      ' w:' + frame.rect.width + ' h:' + frame.rect.height
    ));
    if (frame.uuid) frameTable.appendChild(kv('uuid', shortUuid(frame.uuid), frame.uuid));
    container.appendChild(frameTable);
  }

  // reset 按钮（整包清空）
  const btnWrap = el('div', 'release-wrap');
  const btn = document.createElement('button');
  btn.className = 'btn btn-release atlas-reset-btn';
  btn.textContent = '清空所有动态图集';
  btn.title = '调用 dynamicAtlasManager.reset()（引擎无法单个释放）';
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = '清空中…';
    const res = await resetDynamicAtlas();
    if (res.ok) {
      btn.textContent = '已清空';
      onReset();
    } else {
      btn.disabled = false;
      btn.textContent = '清空失败：' + (res.reason || '');
    }
  });
  btnWrap.appendChild(btn);
  container.appendChild(btnWrap);
}

// ===== 小工具 =====
function kv(key: string, value: string, title?: string): HTMLElement {
  const tr = document.createElement('tr');
  tr.className = 'kv-row';
  const th = el('th', 'kv-label', key);
  const td = el('td', 'kv-value mono', value);
  if (title) td.title = title;
  tr.appendChild(th);
  tr.appendChild(td);
  return tr;
}

function shortUuid(uuid: string): string {
  if (!uuid) return '(空)';
  return uuid.length > 13 ? uuid.slice(0, 8) + '…' + uuid.slice(-4) : uuid;
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function placeholder(text: string): HTMLElement {
  const d = document.createElement('div');
  d.className = 'placeholder';
  d.textContent = text;
  return d;
}

/**
 * 构造预览图块。
 * - preview?.dataUrl 有 → <img> + 棋盘背景 + 宽×高 标注
 * - preview 非 null 但 dataUrl===null → 淡灰「无法提取预览」提示
 * - preview===null（仍在加载中）→ 不显示任何内容（返回空占位，避免布局抖动）
 */
/**
 * 构造预览图块。
 * @param preview 预览数据（AssetPreview 或动态图集预览，结构上只需 dataUrl/width/height）
 * @param emptyText dataUrl 为 null 时的失败提示文案（默认「压缩纹理或非图像源」）
 *
 * - preview?.dataUrl 有 → <img> + 棋盘背景 + 宽×高 标注
 * - preview 非 null 但 dataUrl===null → 淡灰失败提示
 * - preview===null（仍在加载中）→ 不显示任何内容（返回空占位，避免布局抖动）
 */
function makePreviewBlock(
  preview: { dataUrl: string | null; width?: number; height?: number } | null,
  emptyText = '无法提取预览（压缩纹理或非图像源）'
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'detail-preview';
  if (!preview) {
    // 加载中：占位但不显示内容，eval 完成后会重渲染
    return wrap;
  }
  if (preview.dataUrl) {
    const img = document.createElement('img');
    img.className = 'detail-preview-img';
    img.src = preview.dataUrl;
    img.alt = '纹理预览';
    wrap.appendChild(img);
    if (preview.width && preview.height) {
      const meta = el('span', 'detail-preview-meta', preview.width + ' × ' + preview.height + ' px');
      wrap.appendChild(meta);
    }
  } else {
    // 提取失败：压缩纹理 / GPU 回读失败 / 非图像源
    wrap.appendChild(el('span', 'detail-preview-empty', emptyText));
  }
  return wrap;
}

/** 字节数格式化为可读字符串（B/KB/MB/GB）。0 或负返回 '0 B'。 */
function formatBytes(n: number): string {
  if (!n || n <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / Math.pow(1024, i);
  return (i === 0 ? Math.round(v) : Number(v.toFixed(1))) + ' ' + u[i];
}
