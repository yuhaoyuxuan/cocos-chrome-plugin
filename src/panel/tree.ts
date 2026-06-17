import type { SerializedNode, TreeData } from '../types';

/** 树渲染选项 */
export interface RenderOptions {
  /** 当前选中的节点 uuid（高亮该行 + 自动展开到它） */
  selectedUuid?: string | null;
  /** 搜索关键字（大小写不敏感，匹配节点名） */
  filterText?: string;
  /** 用户手动展开的节点 uuid 集合（跨渲染/刷新保持） */
  expanded: Set<string>;
  /** 选中节点的回调 */
  onSelect?: (node: SerializedNode) => void;
}

/**
 * 把整棵序列化节点树渲染进容器。
 * 每次调用都会清空并重建整棵 DOM。
 *
 * 展开规则：
 * - 默认全折叠（仅根可见）
 * - 选中节点时，从根到该节点的整条祖先链自动展开
 * - 用户手动点三角展开的节点记入 expanded 集合，跨渲染保持
 * - 搜索过滤时，命中路径强制展开
 */
export function renderTree(container: HTMLElement, root: TreeData, opts: RenderOptions): void {
  container.replaceChildren();

  if (!root) {
    container.appendChild(createPlaceholder('（暂无数据）'));
    return;
  }

  const filter = opts.filterText?.trim().toLowerCase() ?? '';
  const matches = filter
    ? (n: SerializedNode) => n.name.toLowerCase().includes(filter)
    : undefined;

  // 选中节点的祖先 uuid 集合（这些要自动展开，让选中项可见）
  const ancestorUuids = opts.selectedUuid
    ? collectAncestors(root, opts.selectedUuid)
    : new Set<string>();

  const fragment = document.createDocumentFragment();
  buildRows(fragment, root, 0, opts, matches, ancestorUuids);
  container.appendChild(fragment);
}

/**
 * 递归构建节点行。
 */
function buildRows(
  parent: DocumentFragment | HTMLElement,
  node: SerializedNode,
  depth: number,
  opts: RenderOptions,
  matches: ((n: SerializedNode) => boolean) | undefined,
  ancestorUuids: Set<string>
): void {
  // 过滤模式：判断该子树是否值得渲染
  if (matches && !subtreeMatches(node, matches)) {
    return;
  }

  const row = createRow(node, depth, opts);
  parent.appendChild(row);

  const hasChildren = node.children.length > 0;

  if (hasChildren) {
    // 决定展开状态
    let expanded: boolean;
    if (matches) {
      // 搜索模式下命中路径强制展开
      expanded = true;
    } else {
      // 默认全折叠；展开条件：手动展开过 / 在选中路径上
      expanded = opts.expanded.has(node.uuid) || ancestorUuids.has(node.uuid);
    }

    const childContainer = document.createElement('div');
    childContainer.className = 'children';
    childContainer.hidden = !expanded;
    applyExpanded(row, expanded);

    for (const child of node.children) {
      buildRows(childContainer, child, depth + 1, opts, matches, ancestorUuids);
    }
    row.insertAdjacentElement('afterend', childContainer);

    attachRowEvents(row, node, opts, childContainer);
  } else {
    // 叶子节点：无展开/折叠，但仍需绑定选中事件
    attachRowEvents(row, node, opts, null);
  }
}

/** 判断 node 自身或其子孙是否有命中 */
function subtreeMatches(node: SerializedNode, matches: (n: SerializedNode) => boolean): boolean {
  if (matches(node)) return true;
  return node.children.some((c) => subtreeMatches(c, matches));
}

/**
 * 收集从根到目标 uuid 节点的所有「祖先」uuid（不含目标自身）。
 * 这些节点需要展开，目标节点才可见。未找到则返回空集合。
 */
function collectAncestors(root: SerializedNode, targetUuid: string): Set<string> {
  const result = new Set<string>();
  const path: string[] = [];
  const dfs = (n: SerializedNode): boolean => {
    if (n.uuid === targetUuid) return true;
    path.push(n.uuid);
    for (const c of n.children) {
      if (dfs(c)) return true;
    }
    path.pop();
    return false;
  };
  if (dfs(root)) {
    for (const u of path) result.add(u);
  }
  return result;
}

/** 创建单行 DOM */
function createRow(node: SerializedNode, depth: number, opts: RenderOptions): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'node-row';
  if (!node.active) row.classList.add('inactive');
  if (opts.selectedUuid && node.uuid === opts.selectedUuid) row.classList.add('selected');
  row.tabIndex = 0;
  row.style.setProperty('--depth', String(depth));
  row.dataset.uuid = node.uuid;

  const twisty = document.createElement('span');
  twisty.className = 'twisty';
  twisty.textContent = node.children.length > 0 ? '▶' : '';
  twisty.setAttribute('aria-hidden', 'true');

  const name = document.createElement('span');
  name.className = 'node-name';
  name.textContent = node.name || '(unnamed)';

  const meta = document.createElement('span');
  meta.className = 'node-meta';
  meta.textContent = node.childCount > 0 ? String(node.childCount) : '';

  row.append(twisty, name, meta);
  return row;
}

/**
 * 绑定行事件：三角=折叠切换，其余位置=选中。
 * childContainer 为 null 表示叶子节点（无展开/折叠，仅选中）。
 */
function attachRowEvents(
  row: HTMLDivElement,
  node: SerializedNode,
  opts: RenderOptions,
  childContainer: HTMLElement | null
): void {
  const onSelect = () => {
    opts.onSelect?.(node);
  };
  const onToggle = (e: MouseEvent) => {
    e.stopPropagation();
    if (childContainer) toggleRow(row, childContainer, opts.expanded, node.uuid);
  };

  row.addEventListener('click', (e) => {
    const tgt = e.target as HTMLElement;
    if (tgt.classList.contains('twisty') && childContainer) {
      onToggle(e);
    } else {
      onSelect();
    }
  });

  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect();
    } else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && childContainer) {
      e.preventDefault();
      toggleRow(row, childContainer, opts.expanded, node.uuid);
    }
  });
}

/** 切换某行展开/折叠，并把状态写入 expanded 集合 */
function toggleRow(
  row: HTMLDivElement,
  childContainer: HTMLElement,
  expanded: Set<string>,
  uuid: string
): void {
  const willExpand = childContainer.hidden;
  childContainer.hidden = !willExpand;
  applyExpanded(row, willExpand);
  if (willExpand) expanded.add(uuid);
  else expanded.delete(uuid);
}

/** 把行标记为展开/折叠（影响三角图标方向 + class） */
function applyExpanded(row: HTMLDivElement, expanded: boolean): void {
  const twisty = row.querySelector('.twisty');
  if (twisty) twisty.textContent = expanded ? '▼' : '▶';
  row.classList.toggle('expanded', expanded);
  row.classList.toggle('collapsed', !expanded);
  row.setAttribute('aria-expanded', String(expanded));
}

/** 统计整棵树的节点总数（含根） */
export function countNodes(node: SerializedNode | null): number {
  if (!node) return 0;
  let n = 1;
  for (const c of node.children) n += countNodes(c);
  return n;
}

/** 按 uuid 在树中查找节点 */
export function findNodeByUuid(root: TreeData, uuid: string): SerializedNode | null {
  if (!root) return null;
  if (root.uuid === uuid) return root;
  for (const c of root.children) {
    const hit = findNodeByUuid(c, uuid);
    if (hit) return hit;
  }
  return null;
}

function createPlaceholder(text: string): HTMLDivElement {
  const div = document.createElement('div');
  div.className = 'placeholder';
  div.textContent = text;
  return div;
}
