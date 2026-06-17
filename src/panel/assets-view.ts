import { releaseAsset, sortedBundleGroups, sortedGroups } from './assets-inspector';
import type { AssetSnapshot, SerializedAsset } from '../types';

/** 资源分组维度 */
export type GroupBy = 'type' | 'bundle';

/** 渲染资源视图的选项 */
export interface AssetRenderOptions {
  /** 搜索关键字（匹配名称或类型） */
  filterText: string;
  /** 分组维度：按类型 / 按 bundle */
  groupBy: GroupBy;
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

/** 分组维度的前缀，用于生成唯一展开键 */
function groupKeyPrefix(groupBy: GroupBy): string {
  return groupBy === 'bundle' ? 'bundle:' : 'type:';
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

    const gKey = prefix + g.type;
    const expanded = filter ? true : opts.expandedGroups.has(gKey);
    const icon = opts.groupBy === 'bundle' ? '📦' : '📁';

    // 分组行
    const groupRow = makeGroupRow(icon, g.type, assets.length, expanded);
    frag.appendChild(groupRow);

    // 资源行容器
    const childBox = document.createElement('div');
    childBox.className = 'asset-children';
    childBox.hidden = !expanded;
    for (const a of assets) {
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

/** 创建分组行 */
function makeGroupRow(icon: string, label: string, count: number, expanded: boolean): HTMLDivElement {
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
  meta.className = 'node-meta';
  meta.textContent = String(count);
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
  onReleased: () => void
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

  // 属性表
  const table = el('table', 'kv-table');
  table.appendChild(kv('uuid', shortUuid(asset.uuid), asset.uuid));
  table.appendChild(kv('name', asset.name || '(空)'));
  table.appendChild(kv('type', asset.type));
  table.appendChild(kv('bundle', asset.bundle || '(unbundled)'));
  table.appendChild(kv('refCount', String(asset.refCount)));
  table.appendChild(kv('depCount', String(asset.depCount)));
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
