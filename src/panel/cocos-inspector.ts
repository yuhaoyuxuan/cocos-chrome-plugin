import type { InspectorResult, NodeFieldPath, SerializedNode, SetFieldResult } from '../types';

/**
 * 要注入到页面主世界执行的序列化脚本（字符串形式）。
 *
 * 关键点：
 * - 必须是自包含的纯 JS 字符串，不能引用任何外部变量/TS 作用域；
 * - 返回值必须是可 JSON 序列化的纯对象（eval 会自动结构化克隆回面板）；
 * - 用 `n.children || n._children` 双保险：Cocos 3.x 公开字段是 `children`，
 *   但用户场景里可能见到私有 `_children`，两者都覆盖；
 * - 限制递归深度上限，避免极深节点树把面板卡死（如循环引用、巨型场景）。
 * - 组件属性走硬编码白名单（类名→属性名数组），未命中者只列类名。
 */
const SERIALIZE_SCRIPT = `
(function () {
  var MAX_DEPTH = 200;
  var cc = window.cc;
  if (!cc || !cc.director || typeof cc.director.getScene !== 'function') {
    return { error: 'NO_CC' };
  }
  var scene = cc.director.getScene();
  if (!scene) return { error: 'NO_SCENE' };

  // 组件白名单：类名 -> 要枚举的属性名数组
  var COMP_PROPS = {
    'Sprite':      ['spriteFrame', 'type', 'sizeMode', 'trim', 'color'],
    'Label':       ['string', 'fontSize', 'color', 'horizontalAlign', 'verticalAlign', 'overflow', 'lineHeight', 'font'],
    'UITransform': ['contentSize', 'anchorPoint', 'scale', 'position', 'rotation', 'width', 'height'],
    'UIOpacity':   ['opacity'],
    'Button':      ['interactable', 'transition', 'normalColor', 'pressedColor', 'hoverColor'],
    'RichText':    ['string', 'fontSize', 'maxWidth', 'lineHeight', 'horizontalAlign'],
    'Layout':      ['type', 'spacingX', 'spacingY', 'horizontalDirection', 'verticalDirection', 'paddingLeft', 'paddingRight'],
    'Widget':      ['top', 'bottom', 'left', 'right', 'isAlignTop', 'isAlignBottom', 'isAlignLeft', 'isAlignRight'],
    'Mask':        ['type', 'alphaThreshold', 'inverted'],
    'Animation':   ['playOnLoad', 'defaultClip', 'crossFade'],
    'EditBox':     ['string', 'placeholder', 'maxLength', 'inputFlag', 'inputMode'],
    'ToggleButton': ['interactable', 'isChecked', 'checkMark'],
    'ProgressBar': ['progress', 'mode', 'barSprite'],
    'Slider':      ['progress', 'slideSprite', 'handleSprite'],
    'ScrollView':  ['content', 'horizontal', 'vertical', 'horizontalScrollBar', 'verticalScrollBar'],
    'PageView':    ['currentPage', 'direction', 'scrollThreshold']
  };

  function getChildren(n) {
    return (n && (n.children || n._children)) || [];
  }

  function round(n) { return typeof n === 'number' ? Math.round(n * 1000) / 1000 : n; }

  // 把任意属性值净化成可序列化值
  function safeVal(v, depth) {
    if (v === null || v === undefined) return v;
    var t = typeof v;
    if (t === 'number' || t === 'boolean' || t === 'string') return v;
    if (v instanceof cc.Vec2 || v instanceof cc.Vec3) {
      return { x: round(v.x), y: round(v.y), z: round(v.z) };
    }
    if (v instanceof cc.Size) return { w: round(v.width), h: round(v.height) };
    if (v instanceof cc.Rect) return { x: round(v.x), y: round(v.y), w: round(v.width), h: round(v.height) };
    if (v instanceof cc.Color) return { r: v.r, g: v.g, b: v.b, a: v.a };
    if (v instanceof cc.Quat) return { x: v.x, y: v.y, z: v.z, w: v.w };
    var ctor = v.constructor && v.constructor.name;
    if (ctor === 'Node') return '[Node:' + (v.name || '') + ']';
    if (v instanceof cc.Asset || v instanceof cc.SpriteFrame || v instanceof cc.TextureBase || v instanceof cc.Material) {
      return '[Asset:' + (ctor || '?') + (v.name ? ':' + v.name : '') + ']';
    }
    if (t === 'object' && depth < 1) {
      try {
        var out = {};
        var keys = Object.keys(v).slice(0, 20);
        for (var i = 0; i < keys.length; i++) out[keys[i]] = safeVal(v[keys[i]], depth + 1);
        return out;
      } catch (e) { return '[obj]'; }
    }
    return '[' + (ctor || t) + ']';
  }

  function serComp(c) {
    var cls = (c && c.constructor && c.constructor.name) || (c && c.__classname__) || 'Component';
    var dot = cls.lastIndexOf('.');
    if (dot >= 0) cls = cls.slice(dot + 1);
    var want = COMP_PROPS[cls];
    var props = {};
    if (want) {
      for (var i = 0; i < want.length; i++) {
        var k = want[i];
        try { props[k] = safeVal(c[k], 0); }
        catch (e) { props[k] = '<err>'; }
      }
    }
    return { name: cls, enabled: c ? c.enabled !== false : true, props: props };
  }

  function getUITransform(n) {
    if (!n.getComponent) return null;
    try {
      return n.getComponent('cc.UITransform') || (cc.UITransform && n.getComponent(cc.UITransform)) || null;
    } catch (e) { return null; }
  }

  function ser(n, depth) {
    if (!n || depth > MAX_DEPTH) {
      return {
        name: '(truncated)', active: true, uuid: '', hasUITransform: false,
        childCount: 0, children: [], components: [],
        position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 }, layer: 0
      };
    }
    var kids = getChildren(n);
    var comps = [];
    try {
      var rawComps = n.components || n._components || [];
      for (var i = 0; i < rawComps.length; i++) {
        try { comps.push(serComp(rawComps[i])); } catch (e) {}
      }
    } catch (e) {}

    // 变换属性
    var pos = n.position || { x: 0, y: 0, z: 0 };
    var scl = n.scale || { x: 1, y: 1, z: 1 };
    // rotation 是 Quat，转欧拉角：3.x 提供 eulerAngles getter（部分版本）或 getEulerAngles
    var e = null;
    try { e = n.eulerAngles || (n.getEulerAngles && n.getEulerAngles()); } catch (ex) {}
    if (!e) e = { x: 0, y: 0, z: 0 };

    // UITransform
    var uit = getUITransform(n);
    var uitInfo = null;
    if (uit) {
      uitInfo = {
        width: round(uit.width), height: round(uit.height),
        anchorX: round(uit.anchorX), anchorY: round(uit.anchorY)
      };
    }

    return {
      name: (n.name || '(unnamed)'),
      active: n.active !== false,
      uuid: n.uuid || '',
      hasUITransform: !!uit,
      childCount: kids.length,
      children: kids.map(function (k) { return ser(k, depth + 1); }),
      components: comps,
      position: { x: round(pos.x), y: round(pos.y), z: round(pos.z) },
      rotation: { x: round(e.x), y: round(e.y), z: round(e.z) },
      scale: { x: round(scl.x), y: round(scl.y), z: round(scl.z) },
      layer: n.layer || 0,
      uiTransform: uitInfo
    };
  }
  return ser(scene, 0);
})();
`;

/**
 * 写回脚本模板：按 uuid 在页面找到节点，按 path 修改对应属性。
 * 用占位符 __PAYLOAD__ 由 TS 侧替换（JSON 注入，避免字符串拼接转义）。
 *
 * 写回 API（已核实 3.x）：
 * - setPosition(x,y,z) / setScale(Vec3) / setRotationFromEuler(x,y,z)
 * - active / name / layer 直接赋值
 * - UITransform: setContentSize(w,h) / setAnchorPoint(x,y)
 * - 3.8.4+ 陷阱规避：每次传新构造值给 setter，不修改 readonly 返回值
 */
const SET_FIELD_SCRIPT = `
(function () {
  var PAYLOAD = __PAYLOAD__;
  var cc = window.cc;
  if (!cc || !cc.director) return { ok: false, reason: 'NO_CC' };

  function findNode(n, uid, depth) {
    if (!n || depth > 500) return null;
    if (n.uuid === uid) return n;
    var kids = (n.children || n._children) || [];
    for (var i = 0; i < kids.length; i++) {
      var hit = findNode(kids[i], uid, depth + 1);
      if (hit) return hit;
    }
    return null;
  }

  var scene = cc.director.getScene();
  if (!scene) return { ok: false, reason: 'NOT_FOUND' };
  var node = findNode(scene, PAYLOAD.uuid, 0);
  if (!node) return { ok: false, reason: 'NOT_FOUND' };

  var path = PAYLOAD.path;
  var v = PAYLOAD.value;

  // 组件级写回辅助：处理 comp.X.enabled / <compPrefix>.<field>
  // compPrefix = 组件类名小写，如 sprite/label/widget/layout/uiopacity
  function handleComponentPath() {
    function getCompByPrefix(prefix) {
      // prefix 是小写类名（sprite），还原首字母大写找组件类
      var cls = prefix.charAt(0).toUpperCase() + prefix.slice(1);
      return node.getComponent('cc.' + cls) || (cc[cls] && node.getComponent(cc[cls])) || null;
    }

    // comp.<ClassName>.enabled
    var m = /^comp\\.(.+?)\\.enabled$/.exec(path);
    if (m) {
      var c = node.getComponent('cc.' + m[1]) || (cc[m[1]] && node.getComponent(cc[m[1]])) || null;
      if (!c) return false;
      c.enabled = !!v;
      return true;
    }

    // <compPrefix>.<field>  —— compPrefix 是首个 '.' 前的部分
    var dot = path.indexOf('.');
    if (dot > 0) {
      var prefix = path.slice(0, dot);
      var field = path.slice(dot + 1);
      // 跳过已知的 Node/UITransform 路径前缀（不应进到这里）
      if (prefix === 'uiTransform') return false;
      var comp = getCompByPrefix(prefix);
      if (!comp) return false;
      if (!(field in comp)) return false;
      var old = comp[field];
      // 按值类型赋值：
      // - color：值是 {r,g,b,a}，构造 cc.Color
      // - 布尔字段：转 bool
      // - 数字字段：转 number
      // - 字符串字段：转 string
      if (v && typeof v === 'object' && ('r' in v) && ('g' in v) && ('b' in v)) {
        var a = (v.a !== undefined) ? v.a : (old && old.a !== undefined ? old.a : 255);
        comp[field] = new cc.Color(v.r | 0, v.g | 0, v.b | 0, a | 0);
      } else if (typeof old === 'boolean') {
        comp[field] = !!v;
      } else if (typeof old === 'number') {
        comp[field] = typeof v === 'number' ? v : (v | 0);
      } else if (typeof old === 'string') {
        comp[field] = String(v);
      } else {
        // 枚举等：直接赋 number
        comp[field] = typeof v === 'number' ? v : (v | 0);
      }
      // Widget 改值后触发对齐更新
      if (prefix === 'widget' && comp.updateAlignment) try { comp.updateAlignment(); } catch (e) {}
      return true;
    }
    return false;
  }

  try {
    switch (path) {
      case 'active':
        node.active = !!v; break;
      case 'name':
        node.name = String(v); break;
      case 'layer':
        node.layer = v | 0; break;
      case 'position':
        node.setPosition(v.x, v.y, v.z); break;
      case 'scale':
        node.setScale(new cc.Vec3(v.x, v.y, v.z)); break;
      case 'rotation':
        // 欧拉角 -> 四元数
        node.setRotationFromEuler(v.x, v.y, v.z); break;
      case 'uiTransform.width':
      case 'uiTransform.height': {
        var uit1 = node.getComponent('cc.UITransform') || (cc.UITransform && node.getComponent(cc.UITransform));
        if (!uit1) return { ok: false, reason: 'NO_UITRANSFORM' };
        var w = path === 'uiTransform.width' ? v : uit1.width;
        var h = path === 'uiTransform.height' ? v : uit1.height;
        uit1.setContentSize(w, h); break;
      }
      case 'uiTransform.anchorX':
      case 'uiTransform.anchorY': {
        var uit2 = node.getComponent('cc.UITransform') || (cc.UITransform && node.getComponent(cc.UITransform));
        if (!uit2) return { ok: false, reason: 'NO_UITRANSFORM' };
        var ax = path === 'uiTransform.anchorX' ? v : uit2.anchorX;
        var ay = path === 'uiTransform.anchorY' ? v : uit2.anchorY;
        uit2.setAnchorPoint(ax, ay); break;
      }
      default:
        if (!handleComponentPath()) return { ok: false, reason: 'BAD_PATH' };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: 'BAD_PATH' };
  }
})();
`;

/** 构造写回脚本（JSON 注入 payload） */
function buildSetFieldScript(uuid: string, path: string, value: unknown): string {
  const payload = JSON.stringify({ uuid, path, value });
  return SET_FIELD_SCRIPT.replace('__PAYLOAD__', payload);
}

/**
 * 在 inspected 页面主世界执行序列化脚本，拿回节点树（含 transform/组件）。
 * @returns 成功返回 SerializedNode；失败抛 Error（带友好信息）。
 */
export function fetchSceneTree(): Promise<SerializedNode> {
  return new Promise((resolve, reject) => {
    chrome.devtools.inspectedWindow.eval(
      SERIALIZE_SCRIPT,
      (result: unknown, isException: chrome.devtools.inspectedWindow.EvaluationExceptionInfo | undefined) => {
        if (isException) {
          reject(
            new Error(
              isException && 'value' in isException ? String(isException.value) : '页面执行序列化脚本时发生异常'
            )
          );
          return;
        }
        const data = result as InspectorResult;
        if (data && typeof data === 'object' && 'error' in data) {
          reject(new Error(friendlyError(data.error)));
          return;
        }
        if (!data || typeof data !== 'object' || !('name' in data)) {
          reject(new Error('返回数据格式不符合预期'));
          return;
        }
        resolve(data as SerializedNode);
      }
    );
  });
}

/**
 * 写回节点字段：在页面主世界修改对应节点属性。
 * @returns SetFieldResult，ok=false 时 reason 说明原因
 */
export function setNodeField(uuid: string, path: NodeFieldPath, value: unknown): Promise<SetFieldResult> {
  return new Promise((resolve) => {
    chrome.devtools.inspectedWindow.eval(
      buildSetFieldScript(uuid, path, value),
      (result: unknown, isException: chrome.devtools.inspectedWindow.EvaluationExceptionInfo | undefined) => {
        if (isException) {
          resolve({ ok: false, reason: 'BAD_PATH' });
          return;
        }
        resolve((result as SetFieldResult) ?? { ok: false, reason: 'BAD_PATH' });
      }
    );
  });
}

/** 把内部错误码翻译成面向用户的中文提示 */
function friendlyError(code: string): string {
  switch (code) {
    case 'NO_CC':
      return '未检测到 window.cc：当前页面不是 Cocos Creator 游戏，或引擎尚未初始化完成。';
    case 'NO_SCENE':
      return '检测到 cc，但当前没有运行中的场景（cc.director.getScene() 返回空）。';
    default:
      return `未知错误：${code}`;
  }
}
