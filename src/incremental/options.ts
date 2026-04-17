import { fnvFeedU32, fnvInit, fnv1a } from "../internal/hash.js";
import type { IncrementalParseOptions } from "../types";

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

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

// 深拷贝：只处理 plain object 和 array，函数/class 实例原样返回。
// 显式栈 + seen WeakMap 防循环引用（不走原生递归，避免深层栈溢出）。
const cloneSnapshotValueInternal = <T>(value: T, seen: WeakMap<object, unknown>): T => {
  type ObjectFrame = {
    kind: "object";
    source: Record<string, unknown>;
    target: Record<string, unknown>;
    keys: string[];
    index: number;
  };
  type ArrayFrame = {
    kind: "array";
    source: unknown[];
    target: unknown[];
    index: number;
  };
  type CloneFrame = ObjectFrame | ArrayFrame;
  type CloneContainer = {
    source: object;
    clone: unknown[] | Record<string, unknown>;
    kind: "array" | "object";
  };

  const asContainer = (candidate: unknown): CloneContainer | undefined => {
    if (Array.isArray(candidate)) {
      return { source: candidate, clone: new Array(candidate.length), kind: "array" };
    }
    if (isPlainObject(candidate)) {
      return { source: candidate, clone: {}, kind: "object" };
    }
    return undefined;
  };

  const rootContainer = asContainer(value);
  if (!rootContainer) return value;

  const pushContainerFrame = (container: CloneContainer, stack: CloneFrame[]): void => {
    if (container.kind === "array") {
      stack.push({
        kind: "array",
        source: container.source as unknown[],
        target: container.clone as unknown[],
        index: 0,
      });
      return;
    }
    stack.push({
      kind: "object",
      source: container.source as Record<string, unknown>,
      target: container.clone as Record<string, unknown>,
      keys: Object.keys(container.source as Record<string, unknown>),
      index: 0,
    });
  };

  const rootSeen = seen.get(rootContainer.source);
  if (rootSeen !== undefined) return rootSeen as T;
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

  return rootContainer.clone as T;
};

const cloneSnapshotValue = <T>(value: T): T =>
  cloneSnapshotValueInternal(value, new WeakMap<object, unknown>());

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
const getObjectIdentity = (value: object | undefined): number => {
  if (!value) return 0;
  const cached = objectIdentityMap.get(value);
  if (cached) return cached;
  const next = objectIdentitySeed;
  objectIdentitySeed += 1;
  objectIdentityMap.set(value, next);
  return next;
};

const getIdentityForUnknown = (value: unknown): number => {
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    return getObjectIdentity(value);
  }
  return 0;
};

const hashText = (value: string): number => fnv1a(value);

// handler 结构指纹：hash(key 列表 + 每个 handler 的 inline/raw/block 函数引用 identity)。
// key 排序是必要的——JS 对象 key 顺序受插入顺序影响，
// 等价 handler 用不同顺序构造会产生不同 key 序列，不排序会误判为"配置变了"。
const buildHandlersShapeFingerprint = (handlers: unknown): number => {
  if (!handlers || typeof handlers !== "object") return 0;
  const record = handlers as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  let hash = fnvInit();
  hash = fnvFeedU32(hash, keys.length);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const handler = record[key];
    hash = fnvFeedU32(hash, hashText(key));
    if (!handler || typeof handler !== "object") continue;
    const handlerRecord = handler as Record<string, unknown>;
    hash = fnvFeedU32(hash, getIdentityForUnknown(handlerRecord.inline));
    hash = fnvFeedU32(hash, getIdentityForUnknown(handlerRecord.raw));
    hash = fnvFeedU32(hash, getIdentityForUnknown(handlerRecord.block));
  }
  return hash >>> 0;
};

const DEFAULT_PARSE_OPTIONS_FINGERPRINT = fnvFeedU32(fnvInit(), 0x9e3779b9);

const normalizeShorthandList = (input: readonly string[]): string[] => Array.from(new Set(input)).sort();

// 整合指纹：handlers + allowForms + shorthand 模式 + syntax 8 字段 + tagName 两个函数引用。
// 任何一项变了 → fingerprint 不同 → 增量更新直接跳 full rebuild。
export const buildParseOptionsFingerprint = (options: IncrementalParseOptions | undefined): number => {
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

  hash = fnvFeedU32(hash, getObjectIdentity(tagName.isTagStartChar as object | undefined));
  hash = fnvFeedU32(hash, getObjectIdentity(tagName.isTagChar as object | undefined));
  return hash >>> 0;
};
