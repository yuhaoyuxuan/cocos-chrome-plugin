import { fetchAssets } from './assets-inspector';
import { renderAssetDetails, renderAssetsTree, type GroupBy } from './assets-view';
import { fetchSceneTree, setNodeField } from './cocos-inspector';
import { renderDetails, type CommitHandler } from './details';
import { countNodes, findNodeByUuid, renderTree } from './tree';
import type { AssetSnapshot, NodeFieldPath, SerializedAsset, SerializedNode, TreeData } from '../types';

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
const expandedGroups = new Set<string>();
const segButtons = document.querySelectorAll<HTMLButtonElement>('.seg');

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
  renderAssetsTree(assetsTreeEl, assetSnap, {
    filterText,
    groupBy: assetGroupBy,
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

function rerenderAssetDetails(): void {
  if (!assetDetailsEl) return;
  const asset = selectedAssetUuid ? findAsset(assetSnap, selectedAssetUuid) : null;
  renderAssetDetails(assetDetailsEl, asset, () => void refresh());
}

function handleAssetSelect(asset: SerializedAsset): void {
  selectedAssetUuid = asset.uuid;
  rerenderAssetsTree();
  rerenderAssetDetails();
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

/** 拉取资源快照（智能保留选中） */
async function refreshAssets(): Promise<void> {
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
      if (g !== 'type' && g !== 'bundle') return;
      if (g === assetGroupBy) return;
      assetGroupBy = g;
      segButtons.forEach((x) => x.classList.toggle('active', x.dataset.groupby === g));
      // 切换维度时清空展开记忆（两套维度的展开键不通用）
      expandedGroups.clear();
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
bindSplitter(splitterEl, layoutEl, SPLIT_KEY, DEFAULT_SPLIT);
bindSplitter(assetsSplitterEl, viewAssets, 'cocos-devtools:assets-split', 45);
bindKeys();
updatePlaceholder();
void refresh();
