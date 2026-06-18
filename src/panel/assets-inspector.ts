import type {
  AssetPreview,
  AssetSnapshot,
  DynamicAtlasSnapshot,
  ReleaseResult,
  SerializedAsset,
} from '../types';

/**
 * 资源序列化脚本：遍历 cc.assetManager.assets（ICache<Asset>），拍平成纯 JSON。
 *
 * 关键点：
 * - assets 是 ICache，有 forEach((asset, key) => ...)，key 是 uuid
 * - 引用计数：3.x 在 asset._reference（release-manager 读取），做兜底
 * - 类型：constructor.name（如 'Texture'），去掉可能的命名空间前缀
 * - 依赖：3.x 用 dependUtil.get(uuid).deps（uuid 数组），做兜底
 */
const SERIALIZE_ASSETS_SCRIPT = `
(function () {
  var cc = window.cc;
  if (!cc || !cc.assetManager || !cc.assetManager.assets) return { error: 'NO_CC' };
  var am = cc.assetManager;
  var cache = am.assets;
  var dependUtil = am.dependUtil;

  function getType(a) {
    var cls = (a && a.constructor && a.constructor.name) || 'Asset';
    var dot = cls.lastIndexOf('.');
    if (dot >= 0) cls = cls.slice(dot + 1);
    return cls;
  }
  // 引用计数：3.x 字段为 asset._ref，公开 getter 为 refCount。
  // （注意：不是 _reference，引擎里无此字段。addRef/decRef 操作的就是 _ref。）
  function getRefCount(a) {
    if (!a) return 0;
    if (typeof a.refCount === 'number') return a.refCount;
    if (typeof a._ref === 'number') return a._ref;
    return 0;
  }
  function getDepCount(uuid) {
    try {
      if (dependUtil) {
        var d = dependUtil.get(uuid);
        if (d && d.deps && d.deps.length) return d.deps.length;
      }
    } catch (e) {}
    return 0;
  }

  // ===== 内存估算（字节）：Cocos 资源没有官方占用字节 API，按类型估算 =====
  // 仅对常见资源（Texture/RenderTexture/Audio 等）精确估算，其余返回 0。

  // 用引擎内置的 cc.gfx.FormatInfos 表查每像素字节数，避免硬编码易错的枚举值。
  // FormatInfos 是数组，索引 = gfx.Format 枚举值；每项含 { name, size, count, isCompressed... }。
  // （枚举值从 UNKNOWN=0 起，与引擎 cocos/core/gfx/base/define.ts 严格对应。曾因硬编码枚举值
  //  错误，把 RGB16F(=21) 的 size 错填到枚举值 35（实为 RGB5A1），导致 RGBA8 纹理按 6 字节算偏大。）
  // 压缩格式 size 非每像素值（按块计），此函数仅供非压缩用；压缩纹理由 getTextureSize 单独算。
  function bytesPerPixel(format) {
    try {
      var gfx = window.cc && window.cc.gfx;
      var infos = gfx && gfx.FormatInfos;
      if (infos && infos[format] && !infos[format].isCompressed) {
        return infos[format].size || 0;
      }
    } catch (e) {}
    // 兜底：拿不到 FormatInfos 时按 RGBA8（4 字节）
    return 4;
  }

  // 用引擎的 cc.gfx.FormatSize 精确算纹理占用（正确处理压缩纹理块大小）。
  // 回退到 width×height×bytesPerPixel。返回字节数。
  function getTextureSize(format, w, h) {
    try {
      var gfx = window.cc && window.cc.gfx;
      if (gfx && typeof gfx.FormatSize === 'function') {
        var bytes = gfx.FormatSize(format, w, h, 1);
        if (typeof bytes === 'number' && bytes >= 0) return Math.round(bytes);
      }
    } catch (e) {}
    return Math.round(w * h * bytesPerPixel(format));
  }

  // 估算单个资源的显存/内存占用（字节）。出错或不可估返回 0。
  function getMemory(asset) {
    if (!asset) return 0;
    try {
      var cls = (asset.constructor && asset.constructor.name) || '';
      var w, h, fmt;
      switch (cls) {
        case 'Texture':
        case 'Texture2D':
        case 'TextureCube':
          w = asset.width || 0;
          h = asset.height || 0;
          // 取 format：优先公开的 getPixelFormat()（= _format，PixelFormat 枚举，不经转换链路），
          // 其次 _format 字段。引擎无公开 getGFXFormat()（仅 protected _getGFXFormat）。
          fmt = (typeof asset.getPixelFormat === 'function')
            ? asset.getPixelFormat()
            : (asset._format != null ? asset._format : 33);
          return getTextureSize(fmt, w, h);                    // 含压缩纹理正确估算
        case 'RenderTexture':
          w = asset.width || 0;
          h = asset.height || 0;
          return Math.round(w * h * 4);                        // 默认 RGBA8
        case 'AudioBuffer':
          // length=样本数, _channels=声道数, 每样本 f32=4 字节
          return Math.round((asset.length || 0) * 4 * (asset.numberOfChannels || asset._channels || 2));
        case 'AudioClip':
          // 汇总内部所有 AudioBuffer
          var bufs = asset._buffers || asset._audio;
          if (Array.isArray(bufs)) {
            var sum = 0;
            for (var i = 0; i < bufs.length; i++) {
              var b = bufs[i];
              if (b) sum += (b.length || 0) * 4 * (b.numberOfChannels || b._channels || 2);
            }
            return sum;
          }
          // 部分版本用 _audio 持单个 buffer 或含 duration
          if (asset._audio && asset._audio.length) {
            return Math.round(asset._audio.length * 4 * (asset._audio.numberOfChannels || 2));
          }
          if (typeof asset.duration === 'number' && typeof asset.sampleRate === 'number') {
            return Math.round(asset.duration * asset.sampleRate * 4 * 2);
          }
          return 0;
        default:
          return 0;
      }
    } catch (e) {
      return 0;
    }
  }

  // 建立 uuid -> {bundleName, path} 倒排索引：
  // 遍历每个已加载 bundle 的 config.assetInfos（uuid → info），其中 info 含 path
  // （资源的相对路径，如 'textures/hero'）。资源的 _name 通常为空，path 才是人能读的名字。
  var uuidToBundle = {};
  var uuidToPath = {};
  try {
    am.bundles.forEach(function (bundle) {
      if (!bundle) return;
      var bName = bundle.name;
      try {
        var infos = bundle.config && bundle.config.assetInfos;
        if (infos && typeof infos.forEach === 'function') {
          infos.forEach(function (info, uuid) {
            if (!uuid) return;
            uuidToBundle[uuid] = bName;
            // info 可能是 { uuid, path, ... } 或 IAssetInfo，取 path 作为可读名
            if (info && info.path) uuidToPath[uuid] = info.path;
          });
        }
      } catch (e) {}
    });
  } catch (e) {}

  function getDisplayName(asset, uuid) {
    // 优先用 _name（少数资源有）；否则用 config 里的 path；都没有就用 uuid 短码
    if (asset && asset.name) return asset.name;
    if (uuidToPath[uuid]) return uuidToPath[uuid];
    if (uuid) return uuid.length > 8 ? uuid.slice(0, 8) + '…' : uuid;
    return '(unnamed)';
  }

  var list = [];
  var groups = {};
  var bundleGroups = {};
  cache.forEach(function (asset, key) {
    if (!asset) return;
    var uuid = asset._uuid || key || '';
    var info = {
      uuid: uuid,
      name: getDisplayName(asset, uuid),
      type: getType(asset),
      refCount: getRefCount(asset),
      depCount: getDepCount(uuid),
      bundle: uuidToBundle[uuid] || '(unbundled)',
      memory: getMemory(asset)
    };
    list.push(info);
    if (!groups[info.type]) groups[info.type] = [];
    groups[info.type].push(info);
    if (!bundleGroups[info.bundle]) bundleGroups[info.bundle] = [];
    bundleGroups[info.bundle].push(info);
  });

  return { assets: list, groups: groups, bundleGroups: bundleGroups, total: list.length };
})();
`;

/** 释放脚本：按 uuid 取出 asset 再 releaseAsset */
const RELEASE_ASSET_SCRIPT = `
(function () {
  var UUID = __UUID__;
  var cc = window.cc;
  if (!cc || !cc.assetManager) return { ok: false, reason: 'NO_CC' };
  var cache = cc.assetManager.assets;
  var asset = cache.get(UUID);
  if (!asset) return { ok: false, reason: 'NOT_FOUND' };
  try {
    cc.assetManager.releaseAsset(asset);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: 'RELEASE_FAILED' };
  }
})();
`;

function buildReleaseScript(uuid: string): string {
  return RELEASE_ASSET_SCRIPT.replace('__UUID__', JSON.stringify(uuid));
}

/**
 * 拉取当前 assetManager.assets 快照。
 * @returns AssetSnapshot；失败抛 Error
 */
export function fetchAssets(): Promise<AssetSnapshot> {
  return new Promise((resolve, reject) => {
    chrome.devtools.inspectedWindow.eval(
      SERIALIZE_ASSETS_SCRIPT,
      (result: unknown, isException: chrome.devtools.inspectedWindow.EvaluationExceptionInfo | undefined) => {
        if (isException) {
          reject(
            new Error(
              isException && 'value' in isException ? String(isException.value) : '页面执行资源序列化脚本时发生异常'
            )
          );
          return;
        }
        if (data_has_error(result)) {
          reject(new Error('未检测到 cc.assetManager：当前页面不是 Cocos 游戏或引擎未初始化'));
          return;
        }
        const snap = result as AssetSnapshot;
        if (!snap || typeof snap !== 'object' || !Array.isArray(snap.assets)) {
          reject(new Error('资源数据格式不符合预期'));
          return;
        }
        resolve(snap);
      }
    );
  });
}

function data_has_error(r: unknown): boolean {
  return !!r && typeof r === 'object' && 'error' in (r as Record<string, unknown>);
}

/**
 * 释放指定 uuid 的资源。
 */
export function releaseAsset(uuid: string): Promise<ReleaseResult> {
  return new Promise((resolve) => {
    chrome.devtools.inspectedWindow.eval(
      buildReleaseScript(uuid),
      (result: unknown, isException: chrome.devtools.inspectedWindow.EvaluationExceptionInfo | undefined) => {
        if (isException) {
          resolve({ ok: false, reason: 'RELEASE_FAILED' });
          return;
        }
        resolve((result as ReleaseResult) ?? { ok: false, reason: 'RELEASE_FAILED' });
      }
    );
  });
}

/**
 * 预览图提取脚本：按 uuid 取出 Texture/SpriteFrame，画到缩略 canvas 再 toDataURL。
 *
 * 取图路径（多条兜底）：
 * - getHtmlElementObj()（web 端从图片加载的纹理，level-0 通常是 HTMLImageElement）
 * - image.data / mipmaps[0].data（ImageAsset 持有的 HTML 元素）
 * SpriteFrame：先取底层 texture，再按 _rect 裁剪只显示帧区域。
 * 压缩纹理（ASTC/ETC2 等）level-0 非 HTML 元素，所有路径拿不到 → 返回 dataUrl:null。
 * 缩到 maxDim 再 toDataURL，控制 dataURL 体积（几十~几百 KB）。
 */
const EXTRACT_PREVIEW_SCRIPT = `
(function () {
  var UUID = __UUID__;
  var MAX_DIM = 256;
  var cc = window.cc;
  if (!cc || !cc.assetManager || !cc.assetManager.assets) return null;
  var cache = cc.assetManager.assets;
  var asset = cache.get(UUID);
  if (!asset) return null;

  var cls = (asset.constructor && asset.constructor.name) || '';
  var tex = asset;
  var rect = null;
  // SpriteFrame：取底层纹理 + 裁剪区域
  if (cls === 'SpriteFrame') {
    tex = asset.texture || asset._texture;
    var r = asset._rect || asset.rect;
    if (tex && r) rect = r;
    if (!tex) return { uuid: UUID, width: 0, height: 0, dataUrl: null };
    cls = (tex.constructor && tex.constructor.name) || '';
  }

  // 取 HTML 图像源（多种路径兜底）
  var src = null;
  try { if (typeof tex.getHtmlElementObj === 'function') src = tex.getHtmlElementObj(); } catch (e) {}
  if (!src && tex.image && tex.image.data) src = tex.image.data;
  if (!src && tex.mipmaps && tex.mipmaps[0] && tex.mipmaps[0].data) src = tex.mipmaps[0].data;
  if (!src) return { uuid: UUID, width: 0, height: 0, dataUrl: null };

  var srcW = src.naturalWidth || src.width || 0;
  var srcH = src.naturalHeight || src.height || 0;
  var w = rect ? (rect.width || rect.w || 0) : srcW;
  var h = rect ? (rect.height || rect.h || 0) : srcH;
  if (!w || !h) return { uuid: UUID, width: 0, height: 0, dataUrl: null };

  var scale = Math.min(1, MAX_DIM / Math.max(w, h));
  var cw = Math.max(1, Math.round(w * scale));
  var ch = Math.max(1, Math.round(h * scale));
  try {
    var c = document.createElement('canvas');
    c.width = cw; c.height = ch;
    var ctx = c.getContext('2d');
    if (rect) {
      ctx.drawImage(src, rect.x || 0, rect.y || 0, w, h, 0, 0, cw, ch);
    } else {
      ctx.drawImage(src, 0, 0, cw, ch);
    }
    return { uuid: UUID, width: w, height: h, dataUrl: c.toDataURL('image/png') };
  } catch (e) {
    return { uuid: UUID, width: w, height: h, dataUrl: null };
  }
})();
`;

function buildExtractPreviewScript(uuid: string): string {
  return EXTRACT_PREVIEW_SCRIPT.replace('__UUID__', JSON.stringify(uuid));
}

/**
 * 拉取单个资源的预览图（懒加载，仅 Texture/SpriteFrame 有效）。
 * @returns AssetPreview；资源不存在或类型不符返回 null
 */
export function fetchAssetPreview(uuid: string): Promise<AssetPreview | null> {
  return new Promise((resolve) => {
    chrome.devtools.inspectedWindow.eval(
      buildExtractPreviewScript(uuid),
      (result: unknown, isException: chrome.devtools.inspectedWindow.EvaluationExceptionInfo | undefined) => {
        if (isException) {
          resolve(null);
          return;
        }
        const p = result as AssetPreview | null;
        if (!p || typeof p !== 'object') {
          resolve(null);
          return;
        }
        resolve(p);
      }
    );
  });
}

/** 按类型分组并排序（数量多的类型在前） */
export function sortedGroups(snap: AssetSnapshot): Array<{ type: string; assets: SerializedAsset[] }> {
  return Object.entries(snap.groups)
    .map(([type, assets]) => ({ type, assets }))
    .sort((a, b) => b.assets.length - a.assets.length);
}

/** 按 bundle 分组并排序（数量多的在前，'(unbundled)' 永远排最后） */
export function sortedBundleGroups(
  snap: AssetSnapshot
): Array<{ type: string; assets: SerializedAsset[] }> {
  return Object.entries(snap.bundleGroups)
    .map(([type, assets]) => ({ type, assets }))
    .sort((a, b) => {
      if (a.type === '(unbundled)') return 1;
      if (b.type === '(unbundled)') return -1;
      return b.assets.length - a.assets.length;
    });
}

// ===== 动态图集（dynamicAtlasManager）=====
//
// 引擎结构（3.5.2，cocos/2d/utils/dynamic-atlas/）：
//   cc.internal.dynamicAtlasManager
//     - enabled: 是否启用（默认 false，需在项目设置开启）
//     - _atlases: Atlas[]（已创建的图集，渲染期实时变化）
//   Atlas:
//     - _texture: DynamicAtlasTexture（继承 Texture2D）—— 合并大纹理，有 width/height/getGFXFormat()
//     - _innerSpriteFrames: SpriteFrame[] —— 已合并的源 SpriteFrame 列表（子项）
//   每个 SpriteFrame: .texture 源纹理 / .rect 源帧区域 / .name
//   reset(): 清空并销毁所有图集（无单个释放 API）

/**
 * 动态图集序列化脚本：遍历 dynamicAtlasManager._atlases，拍平成纯 JSON。
 * 严格 try/catch + 存在性检查；未启用或无此 API 时返回 { enabled:false, atlases:[] }。
 */
const SERIALIZE_DYNAMIC_ATLAS_SCRIPT = `
(function () {
  var cc = window.cc;
  if (!cc || !cc.internal || !cc.internal.dynamicAtlasManager) {
    return { enabled: false, atlases: [] };
  }
  var mgr = cc.internal.dynamicAtlasManager;
  try {
    var enabled = !!mgr.enabled;
    if (!enabled) return { enabled: false, atlases: [] };

    // 内存估算：动态图集纹理恒为 RGBA8888（引擎 initWithSize 默认值）。
    // 用公开的 getPixelFormat() 取 _format 值（最可靠，不经 _getGFXPixelFormat 转换链路），
    // 再用 cc.gfx.FormatSize 算；取不到 format 时直接用宽高×4（RGBA8 = 4 字节/像素）。
    // 注意：引擎没有公开的 getGFXFormat()（仅 protected _getGFXFormat），曾误用导致
    // DynamicAtlasTexture 算成 RGB32F(size=12)，2048×2048 显示 48MB（应为 16MB）。
    function texBytes(tex) {
      try {
        var w = tex.width || 0, h = tex.height || 0;
        var gfx = cc.gfx;
        // 取 format：优先公开的 getPixelFormat()（= _format，PixelFormat 枚举），其次 _format 字段
        var fmt = -1;
        if (typeof tex.getPixelFormat === 'function') fmt = tex.getPixelFormat();
        else if (tex._format != null) fmt = tex._format;
        if (fmt >= 0 && gfx && typeof gfx.FormatSize === 'function') {
          var b = gfx.FormatSize(fmt, w, h, 1);
          if (typeof b === 'number' && b >= 0) return Math.round(b);
        }
        // 兜底：RGBA8 = 4 字节/像素
        return Math.round(w * h * 4);
      } catch (e) { return 0; }
    }

    var atlases = mgr._atlases || [];
    var out = [];
    for (var i = 0; i < atlases.length; i++) {
      var atlas = atlases[i];
      if (!atlas) continue;
      var tex = atlas._texture;
      var w = (tex && tex.width) || 0;
      var h = (tex && tex.height) || 0;
      var mem = tex ? texBytes(tex) : 0;

      var sfs = atlas._innerSpriteFrames || [];
      var frames = [];
      for (var j = 0; j < sfs.length; j++) {
        var sf = sfs[j];
        if (!sf || !sf.isValid) continue;
        var srcTex = sf.texture;
        var r = sf.rect || (sf._rect) || { x: 0, y: 0, width: 0, height: 0 };
        var texName = '';
        try {
          texName = (srcTex && (srcTex.name || srcTex._name)) || (srcTex && srcTex.constructor && srcTex.constructor.name) || '';
        } catch (e) {}
        frames.push({
          name: sf.name || sf._name || '(unnamed)',
          textureName: texName,
          rect: { x: r.x || 0, y: r.y || 0, width: r.width || 0, height: r.height || 0 },
          uuid: (srcTex && (srcTex._uuid || '')) || (sf._uuid || '')
        });
      }
      out.push({
        index: i,
        width: w,
        height: h,
        memory: mem,
        frameCount: frames.length,
        frames: frames
      });
    }
    return { enabled: true, atlases: out };
  } catch (e) {
    return { enabled: false, atlases: [] };
  }
})();
`;

/**
 * 拉取动态图集快照（懒加载，仅切到该维度时调用）。
 * @returns DynamicAtlasSnapshot；引擎无此 API 时返回 { enabled:false, atlases:[] }
 */
export function fetchDynamicAtlas(): Promise<DynamicAtlasSnapshot> {
  return new Promise((resolve) => {
    chrome.devtools.inspectedWindow.eval(
      SERIALIZE_DYNAMIC_ATLAS_SCRIPT,
      (result: unknown, isException: chrome.devtools.inspectedWindow.EvaluationExceptionInfo | undefined) => {
        if (isException) {
          resolve({ enabled: false, atlases: [] });
          return;
        }
        const snap = result as DynamicAtlasSnapshot | null;
        if (!snap || typeof snap !== 'object') {
          resolve({ enabled: false, atlases: [] });
          return;
        }
        if (!Array.isArray(snap.atlases)) snap.atlases = [];
        resolve(snap);
      }
    );
  });
}

/** 重置（清空并销毁）所有动态图集。引擎仅提供整包 reset，无法单个释放。 */
const RESET_DYNAMIC_ATLAS_SCRIPT = `
(function () {
  var cc = window.cc;
  if (!cc || !cc.internal || !cc.internal.dynamicAtlasManager) {
    return { ok: false, reason: 'NOT_FOUND' };
  }
  try {
    cc.internal.dynamicAtlasManager.reset();
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: 'RELEASE_FAILED' };
  }
})();
`;

export function resetDynamicAtlas(): Promise<ReleaseResult> {
  return new Promise((resolve) => {
    chrome.devtools.inspectedWindow.eval(
      RESET_DYNAMIC_ATLAS_SCRIPT,
      (result: unknown, isException: chrome.devtools.inspectedWindow.EvaluationExceptionInfo | undefined) => {
        if (isException) {
          resolve({ ok: false, reason: 'RELEASE_FAILED' });
          return;
        }
        resolve((result as ReleaseResult) ?? { ok: false, reason: 'RELEASE_FAILED' });
      }
    );
  });
}

/** 动态图集预览结果（轻量类型，独立于 AssetPreview） */
export interface AtlasPreview {
  /** 图集序号（_atlases 索引） */
  index: number;
  /** PNG dataURL；null 表示 GPU 回读失败 */
  dataUrl: string | null;
}

/**
 * 动态图集预览提取脚本：GPU 回读合并大纹理。
 *
 * 动态图集纹理是 GPU 端动态合成的（drawTextureAt → copyTexImagesToTexture），
 * 没有 HTML 图像源（getHtmlElementObj 返回 null），必须走 GFX 层 GPU 回读：
 *   _texture.getGFXTexture() → device.copyTextureToBuffers(回读 RGBA8 ArrayBuffer)
 *   → ImageData → putImageData 到临时 canvas → drawImage 缩放到 256px → toDataURL
 * 任何环节失败返回 { index, dataUrl: null }（前端显示「GPU 回读失败」提示）。
 */
const EXTRACT_ATLAS_PREVIEW_SCRIPT = `
(function () {
  var INDEX = __INDEX__;
  var MAX_DIM = 256;
  var cc = window.cc;
  if (!cc || !cc.internal || !cc.internal.dynamicAtlasManager) return null;
  var mgr = cc.internal.dynamicAtlasManager;
  var atlases = mgr._atlases || [];
  var atlas = atlases[INDEX];
  if (!atlas || !atlas._texture) return { index: INDEX, dataUrl: null };

  try {
    var tex = atlas._texture;
    var w = tex.width || 0, h = tex.height || 0;
    if (!w || !h) return { index: INDEX, dataUrl: null };
    var gfxTex = (typeof tex.getGFXTexture === 'function') ? tex.getGFXTexture() : tex._gfxTexture;
    if (!gfxTex) return { index: INDEX, dataUrl: null };

    // 取 GFX Device 单例
    var device = null;
    try {
      device = cc.director && cc.director.root && cc.director.root.device;
    } catch (e) {}
    if (!device || typeof device.copyTextureToBuffers !== 'function') {
      return { index: INDEX, dataUrl: null };
    }

    // GPU 回读：整张图集，RGBA8（动态图集恒为 RGBA8888）
    var buf = new Uint8Array(w * h * 4);
    var region = {
      texOffset: { x: 0, y: 0 },
      texExtent: { width: w, height: h },
      texSubres: { mipLevel: 0, faceIndex: 0 }
    };
    device.copyTextureToBuffers(gfxTex, [buf], [region]);

    // ArrayBuffer → ImageData → 临时 canvas（原图）→ 缩放 canvas → toDataURL
    var imageData = new ImageData(new Uint8ClampedArray(buf.buffer), w, h);
    var tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    tmp.getContext('2d').putImageData(imageData, 0, 0);

    var scale = Math.min(1, MAX_DIM / Math.max(w, h));
    var cw = Math.max(1, Math.round(w * scale));
    var ch = Math.max(1, Math.round(h * scale));
    var out = document.createElement('canvas');
    out.width = cw; out.height = ch;
    out.getContext('2d').drawImage(tmp, 0, 0, cw, ch);
    return { index: INDEX, dataUrl: out.toDataURL('image/png') };
  } catch (e) {
    return { index: INDEX, dataUrl: null };
  }
})();
`;

function buildExtractAtlasPreviewScript(index: number): string {
  return EXTRACT_ATLAS_PREVIEW_SCRIPT.replace('__INDEX__', JSON.stringify(index));
}

/**
 * 拉取动态图集预览图（懒加载，GPU 回读）。
 * @returns AtlasPreview；图集不存在返回 null
 */
export function fetchAtlasPreview(index: number): Promise<AtlasPreview | null> {
  return new Promise((resolve) => {
    chrome.devtools.inspectedWindow.eval(
      buildExtractAtlasPreviewScript(index),
      (result: unknown, isException: chrome.devtools.inspectedWindow.EvaluationExceptionInfo | undefined) => {
        if (isException) {
          resolve(null);
          return;
        }
        const p = result as AtlasPreview | null;
        if (!p || typeof p !== 'object') {
          resolve(null);
          return;
        }
        resolve(p);
      }
    );
  });
}
