import { fnvFeedU32, fnvInit, fnv1a } from "../internal/hash.js";
import type { IncrementalParseOptions } from "../types";

type SnapshotPrimitive = string | number | boolean | bigint | symbol | null | undefined;
type SnapshotFunction = (...args: never[]) => unknown;
type SnapshotReference = object | SnapshotFunction;
interface SnapshotObject {
  [key: string]: SnapshotValue;
}
type SnapshotArray = SnapshotValue[];
type SnapshotValue = SnapshotPrimitive | SnapshotReference | SnapshotObject | SnapshotArray;
type SnapshotContainer = SnapshotObject | SnapshotArray;

// ── 快照克隆 ──
//
// 为什么要克隆 parseOptions？
// 用户传进来的 options 可能被外部改动（比如 handler.meta.xxx = 123），
// 如果不隔离，session 内部状态会被"穿透"。
// 所以每次拿到 options 都做一次深拷贝：函数引用保留，plain object/array 递归克隆。
//
// frozenSnapshots 的作用：
// 内部创建的 snapshot 会被标记进 WeakSet。
// 下次同一个 snapshot 再传进来时，我们知道"这是自己人"，但仍然要 re-clone
// nested 字段（handlers/syntax/tagName/allowForms），因为跨代共享会导致
// 旧文档改动影响新文档。所以 frozenSnapshots 目前只是幂等守卫，不是性能快路径。
// 这里最容易踩坑的点就是：不要把 frozenSnapshots 当作"可以直接复用旧 options 对象"的许可。
// 只要 options 里面还有 handlers / syntax 这类可变嵌套结构，就必须重新拍扁成新 snapshot。

const isPlainObject = (value: SnapshotValue): value is SnapshotObject => {
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

// 深拷贝：只处理 plain object 和 array，函数/class 实例原样返回。
// 显式栈 + seen WeakMap 防循环引用（不走原生递归，避免深层栈溢出）。
const cloneSnapshotValueInternal = <TValue extends SnapshotValue>(
  value: TValue,
  seen: WeakMap<object, SnapshotContainer>,
): TValue => {
  type ObjectFrame = {
    kind: "object";
    source: SnapshotObject;
    target: SnapshotObject;
    keys: string[];
    index: number;
  };
  type ArrayFrame = {
    kind: "array";
    source: SnapshotArray;
    target: SnapshotArray;
    index: number;
  };
  type CloneFrame = ObjectFrame | ArrayFrame;
  type ArrayCloneContainer = { kind: "array"; source: SnapshotArray; clone: SnapshotArray };
  type ObjectCloneContainer = { kind: "object"; source: SnapshotObject; clone: SnapshotObject };
  type CloneContainer = ArrayCloneContainer | ObjectCloneContainer;

  const asContainer = (candidate: SnapshotValue): CloneContainer | undefined => {
    if (Array.isArray(candidate)) {
      return { kind: "array", source: candidate, clone: new Array(candidate.length) };
    }
    if (isPlainObject(candidate)) {
      return { kind: "object", source: candidate, clone: {} };
    }
    return undefined;
  };

  const rootContainer = asContainer(value);
  if (!rootContainer) return value;

  const pushContainerFrame = (container: CloneContainer, stack: CloneFrame[]): void => {
    if (container.kind === "array") {
      stack.push({
        kind: "array",
        source: container.source,
        target: container.clone,
        index: 0,
      });
      return;
    }
    stack.push({
      kind: "object",
      source: container.source,
      target: container.clone,
      keys: Object.keys(container.source),
      index: 0,
    });
  };

  const rootSeen = seen.get(rootContainer.source);
  if (rootSeen !== undefined) return rootSeen as TValue;
  seen.set(rootContainer.source, rootContainer.clone);

  const stack: CloneFrame[] = [];
  pushContainerFrame(rootContainer, stack);

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame.kind === "array") {
      if (frame.index >= frame.source.length) {
        stack.pop();
        continue;
      }
      const i = frame.index++;
      const child = frame.source[i];
      const container = asContainer(child);
      if (!container) {
        frame.target[i] = child;
        continue;
      }
      const cached = seen.get(container.source);
      if (cached !== undefined) {
        frame.target[i] = cached;
        continue;
      }
      seen.set(container.source, container.clone);
      frame.target[i] = container.clone;
      pushContainerFrame(container, stack);
      continue;
    }

    if (frame.index >= frame.keys.length) {
      stack.pop();
      continue;
    }
    const key = frame.keys[frame.index++];
    const child = frame.source[key];
    const container = asContainer(child);
    if (!container) {
      frame.target[key] = child;
      continue;
    }
    const cached = seen.get(container.source);
    if (cached !== undefined) {
      frame.target[key] = cached;
      continue;
    }
    seen.set(container.source, container.clone);
    frame.target[key] = container.clone;
    pushContainerFrame(container, stack);
  }

  return rootContainer.clone as TValue;
};

const cloneSnapshotValue = <TValue extends SnapshotValue>(value: TValue): TValue =>
  cloneSnapshotValueInternal(value, new WeakMap<object, SnapshotContainer>());

// handler 克隆：每个 handler 的 data 字段递归深拷贝，函数引用保留。
// 不能改成浅拷贝——测试证明 handler.meta 这种嵌套对象会被外部改动。
const cloneHandlersSnapshot = (
  handlers: IncrementalParseOptions["handlers"] | undefined,
): IncrementalParseOptions["handlers"] | undefined => {
  if (!handlers) return undefined;
  const next: Record<string, (typeof handlers)[string]> = {};
  const keys = Object.keys(handlers);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const handler = handlers[key];
    next[key] = handler ? cloneSnapshotValue(handler) : handler;
  }
  return next;
};

const frozenSnapshots = new WeakSet<object>();

export const cloneParseOptions = (
  options: IncrementalParseOptions | undefined,
): IncrementalParseOptions | undefined => {
  if (!options) return undefined;
  // 已经是内部 snapshot —— 仍然 re-clone 嵌套可变字段，
  // 防止跨代引用穿透（旧 doc.parseOptions.handlers.bold.meta 被改 → 影响新文档）。
  // 这里如果为了省一次 clone 而直接返回旧对象，session 的"历史快照"语义就会被破坏：
  // 后一代编辑会悄悄改到前一代 doc.parseOptions 上，调试时会非常难查。
  const snapshot: IncrementalParseOptions = {
    ...options,
    handlers: cloneHandlersSnapshot(options.handlers),
    syntax: options.syntax ? { ...options.syntax } : undefined,
    tagName: options.tagName ? { ...options.tagName } : undefined,
    allowForms: options.allowForms ? [...options.allowForms] : undefined,
  };
  if (frozenSnapshots.has(options)) {
    frozenSnapshots.add(snapshot);
    return snapshot;
  }
  frozenSnapshots.add(snapshot);
  return snapshot;
};

let objectIdentitySeed = 1;
const objectIdentityMap = new WeakMap<object, number>();

// 给函数/对象分配稳定整数 ID，用于 fingerprint 中比对 handler 引用是否相同。
const getObjectIdentity = (value: SnapshotReference | undefined): number => {
  if (!value) return 0;
  const cached = objectIdentityMap.get(value);
  if (cached) return cached;
  const next = objectIdentitySeed;
  objectIdentitySeed += 1;
  objectIdentityMap.set(value, next);
  return next;
};

const getIdentityForReference = (value: SnapshotReference | null | undefined): number =>
  value ? getObjectIdentity(value) : 0;

const hashText = (value: string): number => fnv1a(value);

// handler 结构指纹：hash(key 列表 + 每个 handler 的 inline/raw/block 函数引用 identity)。
// key 排序是必要的——JS 对象 key 顺序受插入顺序影响，
// 等价 handler 用不同顺序构造会产生不同 key 序列，不排序会误判为"配置变了"。
// 这里故意只看 handler 形状和函数 identity，不看 handler 附带的 plain data。
// plain data 的隔离由 snapshot clone 负责；fingerprint 若把它也算进去，会让增量路径过度敏感。
const buildHandlersShapeFingerprint = (handlers: IncrementalParseOptions["handlers"] | undefined): number => {
  if (!handlers) return 0;
  const keys = Object.keys(handlers).sort();
  let hash = fnvInit();
  hash = fnvFeedU32(hash, keys.length);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const handler = handlers[key];
    hash = fnvFeedU32(hash, hashText(key));
    if (!handler) continue;
    hash = fnvFeedU32(hash, getIdentityForReference(handler.inline));
    hash = fnvFeedU32(hash, getIdentityForReference(handler.raw));
    hash = fnvFeedU32(hash, getIdentityForReference(handler.block));
  }
  return hash >>> 0;
};

const DEFAULT_PARSE_OPTIONS_FINGERPRINT = fnvFeedU32(fnvInit(), 0x9e3779b9);

const normalizeShorthandList = (input: readonly string[]): string[] => Array.from(new Set(input)).sort();

// 整合指纹：handlers + allowForms + shorthand 模式 + syntax 8 字段 + tagName 两个函数引用。
// 任何一项变了 → fingerprint 不同 → 增量更新直接跳 full rebuild。
export const buildParseOptionsFingerprint = (options: IncrementalParseOptions | undefined): number => {
  // 这里的目标不是"绝对唯一哈希"，而是作为"配置是否足够不同到必须 rebuild"的稳定哨兵。
  // 宁可偶发保守 rebuild，也不能把明显不同的配置误判成同一套语义。
  if (!options) return DEFAULT_PARSE_OPTIONS_FINGERPRINT;
  const syntax = options.syntax ?? {};
  const tagName = options.tagName ?? {};
  const allowForms = options.allowForms ?? [];
  const shorthandMode = options.implicitInlineShorthand;

  let hash = fnvInit();
  hash = fnvFeedU32(hash, buildHandlersShapeFingerprint(options.handlers));
  hash = fnvFeedU32(hash, allowForms.length);
  for (let i = 0; i < allowForms.length; i++) {
    hash = fnvFeedU32(hash, hashText(allowForms[i]));
  }
  if (Array.isArray(shorthandMode)) {
    const normalized = normalizeShorthandList(shorthandMode);
    hash = fnvFeedU32(hash, 2);
    hash = fnvFeedU32(hash, normalized.length);
    for (let i = 0; i < normalized.length; i++) {
      hash = fnvFeedU32(hash, hashText(normalized[i]));
    }
  } else if (shorthandMode === true) {
    hash = fnvFeedU32(hash, 1);
  } else {
    hash = fnvFeedU32(hash, 0);
  }

  const syntaxKeys = [
    "tagOpen",
    "tagClose",
    "endTag",
    "tagDivider",
    "rawOpen",
    "rawClose",
    "blockOpen",
    "blockClose",
  ] as const;
  for (const key of syntaxKeys) {
    hash = fnvFeedU32(hash, hashText(syntax[key] ?? ""));
  }

  hash = fnvFeedU32(hash, getObjectIdentity(tagName.isTagStartChar));
  hash = fnvFeedU32(hash, getObjectIdentity(tagName.isTagChar));
  return hash >>> 0;
};
