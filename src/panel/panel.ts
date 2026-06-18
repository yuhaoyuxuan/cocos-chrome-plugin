import { fetchAssetPreview, fetchAssets, fetchAtlasPreview, fetchDynamicAtlas } from './assets-inspector';
import {
  isPreviewable,
  renderAssetDetails,
  renderAssetsTree,
  renderDynamicAtlasDetails,
  renderDynamicAtlasTree,
  type AssetSortBy,
  type GroupBy,
} from './assets-view';
import { fetchSceneTree, setNodeField } from './cocos-inspector';
import { renderDetails, type CommitHandler } from './details';
import { countNodes, findNodeByUuid, renderTree } from './tree';
import type {
  AssetPreview,
  AssetSnapshot,
  DynamicAtlas,
  DynamicAtlasFrame,
  DynamicAtlasSnapshot,
  NodeFieldPath,
  SerializedAsset,
  SerializedNode,
  TreeData,
} from '../types';

type TabKind = 'nodes' | 'assets';

// ===== DOM 引用 =====
const refreshBtn = document.getElementById('refresh') as HTMLButtonElement | null;
const searchInput = document.getElementById('search') as HTMLInputElement | null;
const pollEnable = document.getElementById('poll-enable') as HTMLInputElement | null;
const pollInterval = document.getElementById('poll-interval') as HTMLSelectElement | null;
const statusEl = document.getElementById('status') as HTMLSpanElement | null;
const countEl = document.getElementById('count') as HTMLSpanElement | null;
const tabButtons = document.querySelectorAll<HTMLButtonElement>('.tab');

// 节点树视图
const treeEl = document.getElementById('tree') as HTMLElement | null;
const detailsEl = document.getElementById('details') as HTMLElement | null;
const layoutEl = document.getElementById('layout') as HTMLElement | null;
const splitterEl = document.getElementById('splitter') as HTMLElement | null;

// 资源视图
const assetsTreeEl = document.getElementById('assets-tree') as HTMLElement | null;
const assetDetailsEl = document.getElementById('asset-details') as HTMLElement | null;
const assetsSplitterEl = document.getElementById('assets-splitter') as HTMLElement | null;
const viewNodes = document.getElementById('view-nodes');
const viewAssets = document.getElementById('view-assets');

// ===== 面板状态 =====
let busy = false;
let activeTab: TabKind = 'nodes';
let filterText = '';

// 节点树状态
let treeData: TreeData = null;
let selectedUuid: string | null = null;
const expanded = new Set<string>();

// 资源状态
let assetSnap: AssetSnapshot | null = null;
let selectedAssetUuid: string | null = null;
let assetGroupBy: GroupBy = 'type';
let assetSortBy: AssetSortBy = 'default';
const expandedGroups = new Set<string>();
/** 预览图缓存：uuid → AssetPreview。懒加载，手动刷新时清空。 */
const previewCache = new Map<string, AssetPreview>();
/** 动态图集快照（独立于 assetSnap，切到该维度时懒拉取） */
let dynamicAtlasSnap: DynamicAtlasSnapshot | null = null;
/** 动态图集选中：{ atlasIndex, frameIndex }；frameIndex=-1 表示选中图集本身 */
let selectedAtlas: { atlasIndex: number; frameIndex: number } | null = null;
/** 动态图集预览缓存：图集 index → { dataUrl }（GPU 回读，懒加载） */
const atlasPreviewCache = new Map<number, { dataUrl: string | null }>();
const segButtons = document.querySelectorAll<HTMLButtonElement>('[data-groupby]');
const sortButtons = document.querySelectorAll<HTMLButtonElement>('[data-sort]');

// 轮询状态
let polling = false;
let pollTimer: number | undefined;
let lastManualStatus: 'idle' | 'ok' | 'error' = 'idle';

const SPLIT_KEY = 'cocos-devtools:split';
const DEFAULT_SPLIT = 45;

// ===== 状态文案 =====
function setStatus(text: string, tone: 'idle' | 'ok' | 'error' = 'idle'): void {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.dataset.tone = tone;
}

function setCount(n: number): void {
  if (!countEl) return;
  if (n > 0) {
    countEl.textContent = `${n} 项`;
    countEl.hidden = false;
  } else {
    countEl.hidden = true;
  }
}

// ===== Tab 切换 =====
function switchTab(tab: TabKind): void {
  if (tab === activeTab) return;
  activeTab = tab;
  tabButtons.forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  viewNodes?.classList.toggle('active', tab === 'nodes');
  viewAssets?.classList.toggle('active', tab === 'assets');
  // 切到资源 Tab 时立即拉取一次（若尚未加载）
  if (tab === 'assets' && !assetSnap) void refresh();
  updatePlaceholder();
}

function updatePlaceholder(): void {
  if (searchInput) {
    searchInput.placeholder = activeTab === 'nodes' ? '搜索节点名…' : '搜索资源名/类型…';
  }
}

// ===== 节点树渲染 =====
function rerenderTree(): void {
  if (!treeEl) return;
  renderTree(treeEl, treeData, {
    selectedUuid,
    filterText,
    expanded,
    onSelect: handleSelect,
  });
}

function rerenderDetails(): void {
  if (!detailsEl) return;
  const node = selectedUuid ? findNodeByUuid(treeData, selectedUuid) : null;
  renderDetails(detailsEl, node, commitEdit);
}

function handleSelect(node: SerializedNode): void {
  selectedUuid = node.uuid;
  rerenderTree();
  rerenderDetails();
}

// ===== 资源视图渲染 =====
function rerenderAssetsTree(): void {
  if (!assetsTreeEl) return;
  // dynamicAtlas 维度走独立渲染（数据结构是树形 atlas→frames）
  if (assetGroupBy === 'dynamicAtlas') {
    rerenderDynamicAtlasTree();
    return;
  }
  renderAssetsTree(assetsTreeEl, assetSnap, {
    filterText,
    groupBy: assetGroupBy,
    sortBy: assetSortBy,
    expandedGroups,
    selectedUuid: selectedAssetUuid,
    onSelect: handleAssetSelect,
    onToggleGroup: (gKey) => {
      if (expandedGroups.has(gKey)) expandedGroups.delete(gKey);
      else expandedGroups.add(gKey);
      rerenderAssetsTree();
    },
    onReleased: () => void refresh(),
  });
}

// ===== 动态图集视图渲染（groupBy === 'dynamicAtlas'）=====
function rerenderDynamicAtlasTree(): void {
  if (!assetsTreeEl) return;
  renderDynamicAtlasTree(assetsTreeEl, dynamicAtlasSnap, {
    filterText,
    expandedGroups,
    selected: selectedAtlas,
    onSelect: handleAtlasSelect,
    onToggleGroup: (gKey) => {
      if (expandedGroups.has(gKey)) expandedGroups.delete(gKey);
      else expandedGroups.add(gKey);
      rerenderDynamicAtlasTree();
    },
  });
}

function rerenderDynamicAtlasDetails(): void {
  if (!assetDetailsEl) return;
  let atlas: DynamicAtlas | null = null;
  let frame: DynamicAtlasFrame | null = null;
  if (selectedAtlas && dynamicAtlasSnap) {
    atlas = dynamicAtlasSnap.atlases.find((a) => a.index === selectedAtlas!.atlasIndex) ?? null;
    if (atlas && selectedAtlas.frameIndex >= 0) {
      frame = atlas.frames[selectedAtlas.frameIndex] ?? null;
    }
  }
  const preview = selectedAtlas ? atlasPreviewCache.get(selectedAtlas.atlasIndex) ?? null : null;
  renderDynamicAtlasDetails(assetDetailsEl, atlas, frame, () => void refresh(), preview);
}

/** 选中图集子项：onSelect 传 atlasIndex + frameIndex */
function handleAtlasSelect(atlasIndex: number, frameIndex: number): void {
  selectedAtlas = { atlasIndex, frameIndex };
  rerenderDynamicAtlasTree();
  rerenderDynamicAtlasDetails();
  // 图集预览懒加载（GPU 回读）；缓存未命中时异步拉取，命中直接渲染
  if (!atlasPreviewCache.has(atlasIndex)) {
    void loadAtlasPreview(atlasIndex);
  }
}

/** 异步拉取图集预览图，存入缓存后重渲染（仅当用户仍选中该图集时） */
async function loadAtlasPreview(index: number): Promise<void> {
  const p = await fetchAtlasPreview(index);
  atlasPreviewCache.set(index, { dataUrl: p?.dataUrl ?? null });
  // 防竞态：用户可能在 eval 完成前切换了选中，避免渲染陈旧预览
  if (selectedAtlas?.atlasIndex === index) rerenderDynamicAtlasDetails();
}

function rerenderAssetDetails(): void {
  if (!assetDetailsEl) return;
  // dynamicAtlas 维度走独立详情渲染
  if (assetGroupBy === 'dynamicAtlas') {
    rerenderDynamicAtlasDetails();
    return;
  }
  const asset = selectedAssetUuid ? findAsset(assetSnap, selectedAssetUuid) : null;
  const preview = asset && isPreviewable(asset.type) ? previewCache.get(asset.uuid) ?? null : null;
  renderAssetDetails(assetDetailsEl, asset, () => void refresh(), preview);
}

function handleAssetSelect(asset: SerializedAsset): void {
  selectedAssetUuid = asset.uuid;
  rerenderAssetsTree();
  rerenderAssetDetails();
  // 可预览类型且缓存未命中：懒加载预览图
  if (isPreviewable(asset.type) && !previewCache.has(asset.uuid)) {
    void loadAssetPreview(asset.uuid);
  }
}

/** 异步拉取单个资源的预览图，存入缓存后重渲染（仅当用户仍选中同一资源时） */
async function loadAssetPreview(uuid: string): Promise<void> {
  const preview = await fetchAssetPreview(uuid);
  if (preview) previewCache.set(uuid, preview);
  // 校验：用户可能在 eval 完成前切换了选中，避免渲染陈旧预览
  if (selectedAssetUuid === uuid) rerenderAssetDetails();
}

function findAsset(snap: AssetSnapshot | null, uuid: string): SerializedAsset | null {
  if (!snap) return null;
  return snap.assets.find((a) => a.uuid === uuid) ?? null;
}

// ===== 提交编辑（节点树 Tab 专用）=====
const commitEdit: CommitHandler = async (uuid, path, value): Promise<boolean> => {
  const res = await setNodeField(uuid, path, value);
  if (res.ok) {
    updateLocalCache(uuid, path, value);
    setStatus('已更新 ' + path, 'ok');
    if (path === 'name') rerenderTree();
    return true;
  }
  setStatus('写回失败：' + (res.reason || '未知原因'), 'error');
  return false;
};

function updateLocalCache(uuid: string, path: NodeFieldPath, value: unknown): void {
  const node = findNodeByUuid(treeData, uuid);
  if (!node) return;
  switch (path) {
    case 'active':
      node.active = Boolean(value);
      break;
    case 'name':
      node.name = String(value);
      break;
    case 'layer':
      node.layer = Number(value);
      break;
    case 'position':
    case 'rotation':
    case 'scale': {
      const v = value as { x: number; y: number; z: number };
      node[path] = { x: v.x, y: v.y, z: v.z };
      break;
    }
    case 'uiTransform.width':
      if (node.uiTransform) node.uiTransform.width = Number(value);
      break;
    case 'uiTransform.height':
      if (node.uiTransform) node.uiTransform.height = Number(value);
      break;
    case 'uiTransform.anchorX':
      if (node.uiTransform) node.uiTransform.anchorX = Number(value);
      break;
    case 'uiTransform.anchorY':
      if (node.uiTransform) node.uiTransform.anchorY = Number(value);
      break;
    default:
      if (typeof path === 'string') {
        if (path.startsWith('comp.') && path.endsWith('.enabled')) {
          const compName = path.slice('comp.'.length, -'.enabled'.length);
          const comp = node.components.find((c) => c.name === compName);
          if (comp) comp.enabled = Boolean(value);
          break;
        }
        const dot = path.indexOf('.');
        if (dot > 0) {
          const prefix = path.slice(0, dot);
          const field = path.slice(dot + 1);
          const clsName = prefix.charAt(0).toUpperCase() + prefix.slice(1);
          const comp = node.components.find((c) => c.name === clsName);
          if (comp) comp.props[field] = value;
        }
      }
  }
}

// ===== 刷新：手动（按当前 Tab）=====
async function refresh(): Promise<void> {
  if (busy) return;
  busy = true;
  if (refreshBtn) refreshBtn.disabled = true;
  setStatus('读取中…', 'idle');

  try {
    if (activeTab === 'nodes') {
      await refreshNodes(true);
    } else {
      // 手动刷新：清空预览缓存（纹理/动态图集可能已变），轮询路径不清空
      previewCache.clear();
      atlasPreviewCache.clear();
      await refreshAssets();
    }
    lastManualStatus = 'ok';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setStatus(message, 'error');
    lastManualStatus = 'error';
  } finally {
    busy = false;
    if (refreshBtn) refreshBtn.disabled = false;
  }
}

/** 拉取节点树；resetSelection=true 时清空选中（手动刷新用） */
async function refreshNodes(resetSelection: boolean): Promise<void> {
  const fresh = await fetchSceneTree();
  treeData = fresh;
  if (resetSelection) selectedUuid = null;
  else if (selectedUuid && !findNodeByUuid(fresh, selectedUuid)) selectedUuid = null;
  rerenderTree();
  setCount(countNodes(fresh));
  if (!isDetailsEditing()) rerenderDetails();
  setStatus(polling ? '轮询中' : '已连接', 'ok');
}

/** 拉取资源快照（智能保留选中）；dynamicAtlas 维度时改拉动态图集 */
async function refreshAssets(): Promise<void> {
  // 动态图集维度：拉取 dynamicAtlasSnap，数据结构与 assetSnap 不同，单独处理
  if (assetGroupBy === 'dynamicAtlas') {
    await refreshDynamicAtlas();
    return;
  }
  const fresh = await fetchAssets();
  assetSnap = fresh;
  if (selectedAssetUuid && !findAsset(fresh, selectedAssetUuid)) selectedAssetUuid = null;
  // 记录并恢复滚动位置
  const scrollTop = assetsTreeEl?.scrollTop ?? 0;
  rerenderAssetsTree();
  if (assetsTreeEl) assetsTreeEl.scrollTop = scrollTop;
  setCount(fresh.total);
  if (!isAssetDetailsEditing()) rerenderAssetDetails();
  setStatus(polling ? '轮询中' : '已连接', 'ok');
}

/** 拉取动态图集快照（智能保留选中） */
async function refreshDynamicAtlas(): Promise<void> {
  const fresh = await fetchDynamicAtlas();
  dynamicAtlasSnap = fresh;
  // 选中校验：图集/子项已不存在时清空
  if (selectedAtlas) {
    const atlas = fresh.atlases.find((a) => a.index === selectedAtlas!.atlasIndex);
    if (!atlas || (selectedAtlas.frameIndex >= 0 && !atlas.frames[selectedAtlas.frameIndex])) {
      selectedAtlas = null;
    }
  }
  const scrollTop = assetsTreeEl?.scrollTop ?? 0;
  rerenderAssetsTree();
  if (assetsTreeEl) assetsTreeEl.scrollTop = scrollTop;
  setCount(fresh.atlases.length);
  if (!isAssetDetailsEditing()) rerenderAssetDetails();
  setStatus(polling ? '轮询中' : '已连接', 'ok');
}

/** 详情面板是否正被编辑（节点树 Tab） */
function isDetailsEditing(): boolean {
  if (!detailsEl) return false;
  const active = document.activeElement;
  if (!active || !detailsEl.contains(active)) return false;
  const tag = active.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/** 资源详情面板是否正被编辑 */
function isAssetDetailsEditing(): boolean {
  if (!assetDetailsEl) return false;
  const active = document.activeElement;
  if (!active || !assetDetailsEl.contains(active)) return false;
  const tag = active.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

// ===== 轮询调度 =====
function schedulePoll(): void {
  if (pollTimer !== undefined) {
    window.clearTimeout(pollTimer);
    pollTimer = undefined;
  }
  if (!polling) return;
  const interval = Number(pollInterval?.value ?? 1000);
  pollTimer = window.setTimeout(async () => {
    await pollOnce();
    schedulePoll();
  }, interval);
}

/** 单次轮询：按当前 Tab 拉取，保留状态，失败不清空数据 */
async function pollOnce(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    if (activeTab === 'nodes') await refreshNodes(false);
    else await refreshAssets();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setStatus('轮询失败：' + message, 'error');
  } finally {
    busy = false;
  }
}

function startPolling(): void {
  polling = true;
  if (pollInterval) pollInterval.disabled = false;
  setStatus('轮询中', 'ok');
  schedulePoll();
}

function stopPolling(): void {
  polling = false;
  if (pollTimer !== undefined) {
    window.clearTimeout(pollTimer);
    pollTimer = undefined;
  }
  if (pollInterval) pollInterval.disabled = true;
  setStatus(lastManualStatus === 'error' ? '已停止轮询' : '已连接', lastManualStatus);
}

// ===== 搜索（防抖，按 Tab 分别渲染）=====
let searchTimer: number | undefined;
function bindSearch(): void {
  searchInput?.addEventListener('input', () => {
    filterText = searchInput.value;
    if (searchTimer) window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      if (activeTab === 'nodes') rerenderTree();
      else rerenderAssetsTree();
    }, 120);
  });
}

// ===== Tab 绑定 =====
function bindTabs(): void {
  tabButtons.forEach((b) => {
    b.addEventListener('click', () => {
      const tab = b.dataset.tab;
      if (tab === 'nodes' || tab === 'assets') switchTab(tab);
    });
  });
}

// ===== 轮询控件绑定 =====
function bindPollControls(): void {
  pollEnable?.addEventListener('change', () => {
    if (pollEnable.checked) startPolling();
    else stopPolling();
  });
  pollInterval?.addEventListener('change', () => {
    if (polling) schedulePoll();
  });
}

// ===== 分栏拖拽（两个视图各一个）=====
function bindSplitter(splitter: HTMLElement | null, container: HTMLElement | null, key: string, def: number): void {
  const saved = Number(localStorage.getItem(key));
  const initial = saved > 5 && saved < 95 ? saved : def;
  applySplit(container, initial);
  if (!splitter || !container) return;
  splitter.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    splitter.setPointerCapture(e.pointerId);
    const onMove = (ev: PointerEvent) => {
      const rect = container.getBoundingClientRect();
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
      applySplit(container, Math.max(15, Math.min(85, pct)));
    };
    const onUp = () => {
      splitter.removeEventListener('pointermove', onMove);
      splitter.removeEventListener('pointerup', onUp);
      const cur = getComputedStyle(container).getPropertyValue('--split').trim();
      if (cur) localStorage.setItem(key, cur);
    };
    splitter.addEventListener('pointermove', onMove);
    splitter.addEventListener('pointerup', onUp);
  });
}

function applySplit(container: HTMLElement | null, pct: number): void {
  if (container) container.style.setProperty('--split', String(pct));
}

// ===== 分组维度切换（资源视图）=====
function bindGroupBy(): void {
  segButtons.forEach((b) => {
    b.addEventListener('click', () => {
      const g = b.dataset.groupby;
      if (g !== 'type' && g !== 'bundle' && g !== 'dynamicAtlas') return;
      if (g === assetGroupBy) return;
      assetGroupBy = g;
      segButtons.forEach((x) => x.classList.toggle('active', x.dataset.groupby === g));
      // 切换维度时清空展开记忆（各维度展开键前缀不同：type:/bundle:/atlas:）
      expandedGroups.clear();
      // dynamicAtlas 维度：切到时懒拉取（数据源不同，且渲染期实时变化）
      if (g === 'dynamicAtlas') {
        void refreshDynamicAtlas();
      } else {
        rerenderAssetsTree();
      }
    });
  });
}

// ===== 组内排序切换（资源视图：默认 / 内存）=====
function bindSortBy(): void {
  sortButtons.forEach((b) => {
    b.addEventListener('click', () => {
      const s = b.dataset.sort;
      if (s !== 'default' && s !== 'memory') return;
      if (s === assetSortBy) return;
      assetSortBy = s;
      sortButtons.forEach((x) => x.classList.toggle('active', x.dataset.sort === s));
      rerenderAssetsTree();
    });
  });
}

// ===== 快捷键 =====
function bindKeys(): void {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'r' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      void refresh();
    }
    if (e.key === '/' && !e.ctrlKey && !e.metaKey) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      e.preventDefault();
      searchInput?.focus();
    }
  });
}

// ===== 初始化 =====
refreshBtn?.addEventListener('click', () => void refresh());
bindTabs();
bindSearch();
bindPollControls();
bindGroupBy();
bindSortBy();
bindSplitter(splitterEl, layoutEl, SPLIT_KEY, DEFAULT_SPLIT);
bindSplitter(assetsSplitterEl, viewAssets, 'cocos-devtools:assets-split', 45);
bindKeys();
updatePlaceholder();
void refresh();
