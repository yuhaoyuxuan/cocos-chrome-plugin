/**
 * 序列化后的 Cocos 组件信息（纯 JSON 对象）。
 * props 的值经过 safeVal 净化，是可 JSON 序列化的基本类型/扁平对象。
 */
export interface ComponentInfo {
  /** 组件类名，如 'Sprite' / 'Label' / 'UITransform' */
  name: string;
  /** 组件是否启用（component.enabled） */
  enabled: boolean;
  /** 枚举到的常用属性键值表；未命中白名单的组件为空对象 */
  props: Record<string, unknown>;
}

/** 三维向量（位置/旋转/缩放） */
export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** UITransform 的可编辑字段（无该组件时整个字段为 undefined） */
export interface SerializedUITransform {
  width: number;
  height: number;
  anchorX: number;
  anchorY: number;
}

/**
 * 序列化后的 Cocos 节点（纯 JSON 对象，可跨 eval 边界传递）。
 * 由 cocos-inspector 注入的脚本在页面主世界里递归构建。
 */
export interface SerializedNode {
  /** 节点名，未命名时为 '(unnamed)' */
  name: string;
  /** 节点是否激活（activeInHierarchy 在后续版本再加） */
  active: boolean;
  /** 节点 uuid，可用于定位 */
  uuid: string;
  /** 是否含有 UITransform（2D/UI 节点） */
  hasUITransform: boolean;
  /** 直接子节点数量（不含子孙） */
  childCount: number;
  /** 子节点（已递归序列化） */
  children: SerializedNode[];
  /** 挂在该节点上的组件（已序列化） */
  components: ComponentInfo[];
  /** 本地位置 */
  position: Vec3Like;
  /** 欧拉角旋转（度） */
  rotation: Vec3Like;
  /** 本地缩放 */
  scale: Vec3Like;
  /** 节点 layer */
  layer: number;
  /** UITransform 可编辑字段（无该组件时为 undefined） */
  uiTransform?: SerializedUITransform;
}

/** eval 返回的可能形态：成功是 SerializedNode，失败是带 error 的对象 */
export type InspectorResult = SerializedNode | { error: InspectorError };

/** 已知的失败原因码 */
export type InspectorError =
  | 'NO_CC' // 页面没有 window.cc（不是 Cocos 游戏或尚未初始化）
  | 'NO_SCENE'; // 有 cc 但当前没有运行中的场景

/** 面板与树之间的状态：当前持有的整棵序列化树（null 表示尚未加载） */
export type TreeData = SerializedNode | null;

/**
 * 写回字段的路径。实际值动态生成，例如：
 * - 'active' / 'name' / 'layer' / 'position' / 'rotation' / 'scale'（Node 级）
 * - 'uiTransform.width' 等（UITransform 级）
 * - 'comp.Sprite.enabled'（组件启停）
 * - 'sprite.color' / 'label.fontSize' / 'widget.top' 等（组件属性，前缀=类名小写）
 */
export type NodeFieldPath = string;

/** 写回结果 */
export interface SetFieldResult {
  ok: boolean;
  reason?: 'NO_CC' | 'NOT_FOUND' | 'NO_UITRANSFORM' | 'BAD_PATH';
}

/** 组件可编辑字段的控件类型 */
export type ControlKind = 'number' | 'text' | 'checkbox' | 'color' | 'select';

/** 描述一个组件的可编辑字段（供编辑器注册表使用） */
export interface FieldSpec {
  /** 组件上的属性名，如 'color' / 'fontSize' */
  key: string;
  /** 面板显示名 */
  label: string;
  /** 控件类型 */
  control: ControlKind;
  /** number 控件的步进（默认 1） */
  step?: number;
  /** select 控件的选项：[显示名, 枚举值] */
  options?: Array<[string, number]>;
}

// ===== 资源缓存（assetManager.assets）相关类型 =====

/** 序列化后的单个资源信息（纯 JSON） */
export interface SerializedAsset {
  /** 资源 uuid */
  uuid: string;
  /** 资源名 */
  name: string;
  /** 资源类型（constructor.name，如 'Texture' / 'SpriteFrame'） */
  type: string;
  /** 引用计数（asset._ref 兜底，公开 getter 为 refCount，0 表示无引用） */
  refCount: number;
  /** 依赖的其他资源 uuid 数量 */
  depCount: number;
  /** 所属 bundle 名（无法判定归属时为 '(unbundled)'） */
  bundle: string;
  /** 估算的占用内存（字节）。仅对常见类型（Texture/Audio 等）精确估算，其余为 0 */
  memory: number;
}

/** 资源序列化结果：扁平资源数组 + 按类型分组的映射 */
export interface AssetSnapshot {
  /** 全部资源（扁平） */
  assets: SerializedAsset[];
  /** 类型 → 该类型的资源数组（用于分组树渲染） */
  groups: Record<string, SerializedAsset[]>;
  /** bundle 名 → 该 bundle 的资源数组（用于按 bundle 分组） */
  bundleGroups: Record<string, SerializedAsset[]>;
  /** 资源总数 */
  total: number;
}

/** 单个资源的预览图（懒加载，不进 SerializedAsset，避免快照体积膨胀） */
export interface AssetPreview {
  /** 资源 uuid */
  uuid: string;
  /** 原始纹理宽（SpriteFrame 为帧区域宽） */
  width: number;
  /** 原始纹理高（SpriteFrame 为帧区域高） */
  height: number;
  /** PNG dataURL（缩略图，maxDim≈256）；null 表示无法提取（压缩纹理/非图像源） */
  dataUrl: string | null;
}

/** 资源释放结果 */
export interface ReleaseResult {
  ok: boolean;
  reason?: 'NO_CC' | 'NOT_FOUND' | 'RELEASE_FAILED';
}

// ===== 动态图集（dynamicAtlasManager）相关类型 =====

/** 动态图集内的子项（已合并的源 SpriteFrame） */
export interface DynamicAtlasFrame {
  /** SpriteFrame 名（可能为空） */
  name: string;
  /** 源纹理名（texture.name，常为空，回退用 constructor.name） */
  textureName: string;
  /** 源帧区域 */
  rect: { x: number; y: number; width: number; height: number };
  /** 源纹理 uuid（可能为空） */
  uuid: string;
}

/** 单个动态图集 */
export interface DynamicAtlas {
  /** 序号（_atlases 索引） */
  index: number;
  /** 合并纹理宽 */
  width: number;
  /** 合并纹理高 */
  height: number;
  /** 估算占用内存（字节，用 FormatSize 算） */
  memory: number;
  /** 已合并的子项数 */
  frameCount: number;
  /** 子项列表 */
  frames: DynamicAtlasFrame[];
}

/** 动态图集快照（独立于 AssetSnapshot，按需懒加载） */
export interface DynamicAtlasSnapshot {
  /** 是否启用（enabled=false 时 atlases 为空，前端显示占位） */
  enabled: boolean;
  /** 图集列表 */
  atlases: DynamicAtlas[];
}

