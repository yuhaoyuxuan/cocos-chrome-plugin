import type { AssetSnapshot, ReleaseResult, SerializedAsset } from '../types';

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
      bundle: uuidToBundle[uuid] || '(unbundled)'
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
