import type { ComponentInfo, FieldSpec, NodeFieldPath, SerializedNode, Vec3Like } from '../types';

/**
 * 用户提交一次编辑时的回调。
 * 由 panel.ts 提供，负责 eval 写回 + 更新本地缓存。
 */
export type CommitHandler = (uuid: string, path: NodeFieldPath, value: unknown) => Promise<boolean>;

interface RenderCtx {
  uuid: string;
  commit: CommitHandler;
}

let currentCtx: RenderCtx | null = null;

/** 跨重渲染持久化的组件展开状态（key = 组件名）。
 *  详情面板在轮询刷新时整体重建 DOM（renderDetails → replaceChildren），
 *  组件的展开/折叠若只存在 DOM 的 body.hidden 上会丢失，导致已展开的组件被重新折叠。
 *  这里把它提到模块级集合，与节点树的 expanded Set 同理。 */
const expandedComps = new Set<string>();

/** 上一次渲染详情的节点 uuid；切换到不同节点时清空 expandedComps，
 *  让每个节点的组件折叠状态各自独立（而不是按组件名跨节点串台）。 */
let lastRenderedUuid: string | null = null;

// ===== 组件可编辑字段注册表：类名 → 字段描述数组 =====
// 写回路径前缀 = 类名小写（sprite/label/...）；初始值来自序列化的 props。
const EDITABLE_FIELDS: Record<string, FieldSpec[]> = {
  Sprite: [
    { key: 'color', label: 'Color', control: 'color' },
    { key: 'type', label: 'Type', control: 'select', options: [['SIMPLE', 0], ['SLICED', 1], ['TILED', 2], ['FILLED', 3]] },
    { key: 'sizeMode', label: 'SizeMode', control: 'select', options: [['CUSTOM', 0], ['RAW', 1], ['TRIMMED', 2]] },
    { key: 'trim', label: 'Trim', control: 'checkbox' },
  ],
  Label: [
    { key: 'string', label: 'String', control: 'text' },
    { key: 'fontSize', label: 'FontSize', control: 'number', step: 1 },
    { key: 'color', label: 'Color', control: 'color' },
    { key: 'lineHeight', label: 'LineHeight', control: 'number', step: 1 },
    { key: 'horizontalAlign', label: 'HAlign', control: 'select', options: [['LEFT', 0], ['CENTER', 1], ['RIGHT', 2]] },
    { key: 'verticalAlign', label: 'VAlign', control: 'select', options: [['TOP', 0], ['CENTER', 1], ['BOTTOM', 2]] },
    { key: 'overflow', label: 'Overflow', control: 'select', options: [['NONE', 0], ['CLAMP', 1], ['SHRINK', 2], ['RESIZE_HEIGHT', 3]] },
  ],
  RichText: [
    { key: 'string', label: 'String', control: 'text' },
    { key: 'fontSize', label: 'FontSize', control: 'number', step: 1 },
    { key: 'maxWidth', label: 'MaxWidth', control: 'number', step: 1 },
    { key: 'lineHeight', label: 'LineHeight', control: 'number', step: 1 },
  ],
  Widget: [
    { key: 'top', label: 'Top', control: 'number', step: 1 },
    { key: 'bottom', label: 'Bottom', control: 'number', step: 1 },
    { key: 'left', label: 'Left', control: 'number', step: 1 },
    { key: 'right', label: 'Right', control: 'number', step: 1 },
    { key: 'isAlignTop', label: 'AlignTop', control: 'checkbox' },
    { key: 'isAlignBottom', label: 'AlignBottom', control: 'checkbox' },
    { key: 'isAlignLeft', label: 'AlignLeft', control: 'checkbox' },
    { key: 'isAlignRight', label: 'AlignRight', control: 'checkbox' },
  ],
  Layout: [
    { key: 'type', label: 'Type', control: 'select', options: [['NONE', 0], ['HORIZONTAL', 1], ['VERTICAL', 2], ['GRID', 3]] },
    { key: 'spacingX', label: 'SpacingX', control: 'number', step: 1 },
    { key: 'spacingY', label: 'SpacingY', control: 'number', step: 1 },
    { key: 'paddingLeft', label: 'PadL', control: 'number', step: 1 },
    { key: 'paddingRight', label: 'PadR', control: 'number', step: 1 },
    { key: 'paddingTop', label: 'PadT', control: 'number', step: 1 },
    { key: 'paddingBottom', label: 'PadB', control: 'number', step: 1 },
  ],
  UIOpacity: [{ key: 'opacity', label: 'Opacity', control: 'number', step: 1 }],
};

/** 组件的可编辑字段 key 集合（用于区分只读属性） */
function editableKeys(name: string): Set<string> {
  return new Set((EDITABLE_FIELDS[name] ?? []).map((f) => f.key));
}

/**
 * 渲染节点详情到右栏容器（可编辑 Inspector）。
 */
export function renderDetails(container: HTMLElement, node: SerializedNode | null, commit: CommitHandler): void {
  container.replaceChildren();
  if (!node) {
    currentCtx = null;
    lastRenderedUuid = null;
    expandedComps.clear();
    container.appendChild(emptyHint('在左侧树中选择一个节点以查看详情'));
    return;
  }
  // 切换到不同节点：重置组件展开记忆，避免上一节点的展开状态串到新节点
  if (lastRenderedUuid !== node.uuid) {
    expandedComps.clear();
    lastRenderedUuid = node.uuid;
  }
  currentCtx = { uuid: node.uuid, commit };

  container.appendChild(renderHeader(node));
  container.appendChild(renderTransform(node));
  if (node.uiTransform) container.appendChild(renderUITransform(node));

  // 所有组件一视同仁（UITransform 已在顶部单独渲染，这里跳过它）
  const others = node.components.filter((c) => c.name !== 'UITransform');
  if (others.length > 0) {
    container.appendChild(el('h2', 'section-title', '组件 (' + others.length + ')'));
    for (const c of others) container.appendChild(renderComponent(c));
  }
}

// ===== 头部：active + name =====
function renderHeader(node: SerializedNode): HTMLElement {
  const head = el('div', 'detail-header');
  const row = el('div', 'dh-name-row');

  const activeWrap = el('label', 'check-row');
  const activeInput = document.createElement('input');
  activeInput.type = 'checkbox';
  activeInput.checked = node.active;
  activeInput.title = 'active';
  bindField(activeInput, 'active', () => activeInput.checked);
  activeWrap.appendChild(activeInput);
  activeWrap.appendChild(el('span', 'check-label', 'active'));
  row.appendChild(activeWrap);

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'name-input';
  nameInput.value = node.name || '';
  nameInput.placeholder = '(unnamed)';
  nameInput.spellcheck = false;
  bindField(nameInput, 'name', () => nameInput.value);
  row.appendChild(nameInput);
  head.appendChild(row);

  const uuidRow = el('div', 'dh-uuid');
  uuidRow.appendChild(el('span', 'kv-label', 'uuid'));
  const uuidVal = el('span', 'kv-value mono', shortUuid(node.uuid));
  uuidVal.title = node.uuid;
  uuidRow.appendChild(uuidVal);
  head.appendChild(uuidRow);
  return head;
}

// ===== Transform 区：position / rotation / scale / layer =====
function renderTransform(node: SerializedNode): HTMLElement {
  const section = el('section', 'basic');
  section.appendChild(el('h2', 'section-title', 'Node'));
  section.appendChild(vec3Row('Position', 'position', node.position, 0.1));
  section.appendChild(vec3Row('Rotation', 'rotation', node.rotation, 1));
  section.appendChild(vec3Row('Scale', 'scale', node.scale, 0.1));
  section.appendChild(layerRow(node.layer));
  return section;
}

// ===== UITransform 区：contentSize / anchorPoint =====
function renderUITransform(node: SerializedNode): HTMLElement {
  const section = el('section', 'basic');
  section.appendChild(el('h2', 'section-title', 'UITransform'));
  const uit = node.uiTransform!;
  section.appendChild(
    twoFieldRow('ContentSize', [
      { label: 'W', path: 'uiTransform.width', value: uit.width, step: 1 },
      { label: 'H', path: 'uiTransform.height', value: uit.height, step: 1 },
    ])
  );
  section.appendChild(
    twoFieldRow('Anchor', [
      { label: 'X', path: 'uiTransform.anchorX', value: uit.anchorX, step: 0.05 },
      { label: 'Y', path: 'uiTransform.anchorY', value: uit.anchorY, step: 0.05 },
    ])
  );
  return section;
}

// ===== 通用组件渲染：enable 复选框 + 可编辑字段 + 只读属性 =====
function renderComponent(c: ComponentInfo): HTMLElement {
  const wrap = el('div', 'comp' + (c.enabled ? '' : ' comp-disabled'));
  const head = el('div', 'comp-head');

  // enable 复选框
  const enableWrap = el('label', 'comp-enable');
  const enableInput = document.createElement('input');
  enableInput.type = 'checkbox';
  enableInput.checked = c.enabled;
  enableInput.title = c.name + '.enabled';
  bindField(enableInput, ('comp.' + c.name + '.enabled') as NodeFieldPath, () => enableInput.checked);
  enableInput.addEventListener('click', (e) => e.stopPropagation());
  enableWrap.appendChild(enableInput);
  head.appendChild(enableWrap);

  const twisty = el('span', 'twisty', expandedComps.has(c.name) ? '▼' : '▶');
  twisty.setAttribute('aria-hidden', 'true');
  head.appendChild(twisty);
  head.appendChild(el('span', 'comp-name', c.name));
  wrap.appendChild(head);

  // 展开区：初始状态读自 expandedComps，使轮询重建后能保持用户上次展开的组件
  const body = el('div', 'comp-body');
  body.hidden = !expandedComps.has(c.name);
  if (!body.hidden) wrap.classList.add('expanded');
  wrap.appendChild(body);

  const fields = EDITABLE_FIELDS[c.name] ?? [];
  const editable = editableKeys(c.name);

  // 可编辑字段
  if (fields.length > 0) {
    const prefix = c.name.toLowerCase();
    for (const f of fields) {
      const cur = c.props[f.key];
      body.appendChild(renderFieldRow(f, prefix, cur));
    }
  } else {
    body.appendChild(el('div', 'muted', '（无可编辑字段）'));
  }

  // 只读属性（排除已可编辑的 + 引用/未登记字段）
  const readOnly = Object.entries(c.props).filter(([k]) => !editable.has(k));
  if (readOnly.length > 0) {
    const table = el('table', 'kv-table comp-props');
    for (const [k, v] of readOnly) table.appendChild(kvRow(k, formatValue(v)));
    body.appendChild(el('div', 'muted compact', '其他属性'));
    body.appendChild(table);
  }

  // 点击头部展开/折叠（复选框点击已阻止冒泡）；状态同步到 expandedComps 以跨刷新保持
  head.style.cursor = 'pointer';
  head.addEventListener('click', () => {
    body.hidden = !body.hidden;
    twisty.textContent = body.hidden ? '▶' : '▼';
    wrap.classList.toggle('expanded', !body.hidden);
    if (body.hidden) expandedComps.delete(c.name);
    else expandedComps.add(c.name);
  });

  // enable 切换后视觉同步
  enableInput.addEventListener('change', () => {
    wrap.classList.toggle('comp-disabled', !enableInput.checked);
  });

  return wrap;
}

/** 按 FieldSpec 渲染一个可编辑字段行 */
function renderFieldRow(f: FieldSpec, prefix: string, current: unknown): HTMLElement {
  const path = (prefix + '.' + f.key) as NodeFieldPath;
  switch (f.control) {
    case 'number':
      return numberRow(f.label, path, typeof current === 'number' ? current : 0, f.step ?? 1);
    case 'text':
      return textRow(f.label, path, typeof current === 'string' ? current : String(current ?? ''), prefix === 'richtext');
    case 'checkbox':
      return checkboxRow(f.label, path, Boolean(current));
    case 'color':
      return colorRow(f.label, path, asColor(current));
    case 'select':
      return selectRow(f.label, path, typeof current === 'number' ? current : 0, f.options ?? []);
  }
}

// ===== 行构造工具 =====
function vec3Row(label: string, path: NodeFieldPath, val: Vec3Like, step: number): HTMLElement {
  const row = el('div', 'insp-row');
  row.appendChild(el('span', 'insp-label', label));
  const vec = el('div', 'vec3');
  const axes: Array<[string, keyof Vec3Like]> = [
    ['X', 'x'],
    ['Y', 'y'],
    ['Z', 'z'],
  ];
  for (const [tag, key] of axes) {
    const cell = el('label', 'vec-cell');
    cell.appendChild(el('span', 'vec-tag', tag));
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'num-input';
    input.value = String(val[key]);
    input.step = String(step);
    bindField(input, path, () => readVec3(vec, val));
    cell.appendChild(input);
    vec.appendChild(cell);
  }
  row.appendChild(vec);
  return row;
}

function twoFieldRow(
  label: string,
  fields: Array<{ label: string; path: NodeFieldPath; value: number; step: number }>
): HTMLElement {
  const row = el('div', 'insp-row');
  row.appendChild(el('span', 'insp-label', label));
  const vec = el('div', 'vec3');
  for (const f of fields) {
    const cell = el('label', 'vec-cell');
    cell.appendChild(el('span', 'vec-tag', f.label));
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'num-input';
    input.value = String(f.value);
    input.step = String(f.step);
    bindField(input, f.path, () => numFromInput(input));
    cell.appendChild(input);
    vec.appendChild(cell);
  }
  row.appendChild(vec);
  return row;
}

function numberRow(label: string, path: NodeFieldPath, value: number, step: number): HTMLElement {
  const row = el('div', 'insp-row');
  row.appendChild(el('span', 'insp-label', label));
  const input = document.createElement('input');
  input.type = 'number';
  input.className = 'num-input';
  input.value = String(value);
  input.step = String(step);
  bindField(input, path, () => numFromInput(input));
  row.appendChild(input);
  return row;
}

function textRow(label: string, path: NodeFieldPath, value: string, multiline: boolean): HTMLElement {
  const row = el('div', 'insp-row text-row');
  row.appendChild(el('span', 'insp-label', label));
  let input: HTMLInputElement | HTMLTextAreaElement;
  if (multiline) {
    const ta = document.createElement('textarea');
    ta.className = 'text-area';
    ta.value = value;
    ta.rows = 3;
    ta.spellcheck = false;
    bindField(ta, path, () => ta.value);
    input = ta;
  } else {
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'name-input';
    inp.value = value;
    inp.spellcheck = false;
    bindField(inp, path, () => inp.value);
    input = inp;
  }
  row.appendChild(input);
  return row;
}

function checkboxRow(label: string, path: NodeFieldPath, checked: boolean): HTMLElement {
  const row = el('div', 'insp-row');
  row.appendChild(el('span', 'insp-label', label));
  const wrap = el('label', 'check-row');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  bindField(input, path, () => input.checked);
  wrap.appendChild(input);
  wrap.appendChild(el('span', 'check-label', checked ? '是' : '否'));
  // 切换时同步标签文案
  input.addEventListener('change', () => {
    const lbl = wrap.querySelector('.check-label');
    if (lbl) lbl.textContent = input.checked ? '是' : '否';
  });
  row.appendChild(wrap);
  return row;
}

function selectRow(
  label: string,
  path: NodeFieldPath,
  value: number,
  options: Array<[string, number]>
): HTMLElement {
  const row = el('div', 'insp-row');
  row.appendChild(el('span', 'insp-label', label));
  const select = document.createElement('select');
  select.className = 'select-input';
  for (const [name, val] of options) {
    const opt = document.createElement('option');
    opt.value = String(val);
    opt.textContent = name;
    if (val === value) opt.selected = true;
    select.appendChild(opt);
  }
  bindField(select, path, () => Number(select.value));
  row.appendChild(select);
  return row;
}

/** color 行：拾色器 + Alpha 数字框 */
function colorRow(label: string, path: NodeFieldPath, c: { r: number; g: number; b: number; a: number }): HTMLElement {
  const row = el('div', 'insp-row color-row');
  row.appendChild(el('span', 'insp-label', label));

  const picker = document.createElement('input');
  picker.type = 'color';
  picker.className = 'color-picker';
  picker.value = rgbToHex(c.r, c.g, c.b);

  const alphaWrap = el('label', 'alpha-cell');
  alphaWrap.appendChild(el('span', 'vec-tag', 'A'));
  const alpha = document.createElement('input');
  alpha.type = 'number';
  alpha.className = 'num-input';
  alpha.min = '0';
  alpha.max = '255';
  alpha.value = String(c.a);
  alphaWrap.appendChild(alpha);

  // 提交时合成 {r,g,b,a}
  const readColor = () => {
    const [r, g, b] = hexToRgb(picker.value);
    return { r, g, b, a: numFromInput(alpha) };
  };
  bindField(picker, path, readColor);
  bindField(alpha, path, readColor);

  row.appendChild(picker);
  row.appendChild(alphaWrap);
  return row;
}

function layerRow(layer: number): HTMLElement {
  const row = el('div', 'insp-row');
  row.appendChild(el('span', 'insp-label', 'Layer'));
  const input = document.createElement('input');
  input.type = 'number';
  input.className = 'num-input layer-input';
  input.value = String(layer);
  input.step = '1';
  bindField(input, 'layer', () => numFromInput(input));
  row.appendChild(input);
  return row;
}

// ===== 颜色工具 =====
function rgbToHex(r: number, g: number, b: number): string {
  const h = (n: number) => Math.max(0, Math.min(255, n | 0)).toString(16).padStart(2, '0');
  return '#' + h(r) + h(g) + h(b);
}
function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function asColor(v: unknown): { r: number; g: number; b: number; a: number } {
  if (v && typeof v === 'object' && 'r' in v && 'g' in v && 'b' in v) {
    const o = v as { r: number; g: number; b: number; a?: number };
    return { r: o.r, g: o.g, b: o.b, a: o.a ?? 255 };
  }
  return { r: 255, g: 255, b: 255, a: 255 };
}

/** 从 .vec3 容器里读取三个 input 组成 {x,y,z} */
function readVec3(vec: HTMLElement, fallback: Vec3Like): Vec3Like {
  const inputs = vec.querySelectorAll<HTMLInputElement>('input.num-input');
  return {
    x: inputs[0] ? numFromInput(inputs[0]) : fallback.x,
    y: inputs[1] ? numFromInput(inputs[1]) : fallback.y,
    z: inputs[2] ? numFromInput(inputs[2]) : fallback.z,
  };
}

function numFromInput(input: HTMLInputElement | HTMLSelectElement): number {
  const n = Number(input.value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 绑定一个控件的写回：input 仅本地，change/blur/Enter 提交。
 * 失败则标红。
 */
function bindField(
  input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  path: NodeFieldPath,
  readValue: () => unknown
): void {
  const submit = async () => {
    if (!currentCtx) return;
    const value = readValue();
    const ok = await currentCtx.commit(currentCtx.uuid, path, value);
    input.classList.toggle('err', !ok);
  };
  input.addEventListener('change', () => void submit());
  input.addEventListener('blur', () => void submit());
  if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) {
    const keyEl = input as HTMLElement;
    keyEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !(input instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        input.blur();
      }
    });
  }
}

// ===== 小工具 =====
function kvRow(key: string, value: string): HTMLElement {
  const tr = document.createElement('tr');
  tr.classList.add('kv-row');
  tr.appendChild(el('th', 'kv-label', key));
  tr.appendChild(el('td', 'kv-value mono', value));
  return tr;
}

function formatValue(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  const t = typeof v;
  if (t === 'string') return v as string;
  if (t === 'number' || t === 'boolean') return String(v);
  if (t === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return '[object]';
    }
  }
  return String(v);
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

function emptyHint(text: string): HTMLElement {
  return el('div', 'placeholder', text);
}
