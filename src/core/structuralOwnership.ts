export type EndTagMatchState = "none" | "full" | "truncated-prefix";
export type ShorthandOwnershipDecision = "allow" | "defer-parent";

export interface ShorthandProbeState {
  textEnd: number;
  startI: number;
  boundaryI: number;
  reject: boolean;
}

export interface ReplayFrameLike {
  text: string;
  parentIndex: number;
  inlineCloseToken: string | null;
  implicitInlineShorthand: boolean;
  tagStartI: number;
  argStartI: number;
  tagOpenPos: number;
}

export interface MalformedInlineReplayPlan {
  chain: ReplayFrameLike[];
  resumeParentIndex: number;
  resumeTagStartI: number;
  resumeArgStartI: number;
}

interface ResolveShorthandPushInput {
  argStart: number;
  frameInlineCloseToken: string | null;
  frameText: string;
  frameTextEnd: number;
  endTag: string;
  tagClose: string;
  currentProbe: ShorthandProbeState | null;
  hasAncestorEndTagOwnerAt: (at: number) => boolean;
  readEscapedNext: (at: number) => number | null;
  hasTagStartAt: (at: number) => boolean;
}

interface ResolveShorthandPushResult {
  decision: ShorthandOwnershipDecision;
  nextProbe: ShorthandProbeState | null;
}

export const scanEndTagAt = (
  text: string,
  endTag: string,
  start: number,
  endExclusive: number,
): EndTagMatchState => {
  if (start >= endExclusive) return "none";
  if (text[start] !== endTag[0]) return "none";
  let offset = 0;
  while (offset < endTag.length) {
    const pos = start + offset;
    if (pos >= endExclusive) return "truncated-prefix";
    if (text[pos] !== endTag[offset]) return "none";
    offset++;
  }
  return "full";
};

export const resolveShorthandOwnershipPush = (
  input: ResolveShorthandPushInput,
): ResolveShorthandPushResult => {
  const {
    argStart,
    frameInlineCloseToken,
    frameText,
    frameTextEnd,
    endTag,
    tagClose,
    currentProbe,
    hasAncestorEndTagOwnerAt,
    readEscapedNext,
    hasTagStartAt,
  } = input;

  if (
    frameInlineCloseToken === endTag &&
    scanEndTagAt(frameText, endTag, argStart, frameTextEnd) === "full"
  ) {
    return { decision: "defer-parent", nextProbe: currentProbe };
  }

  if (hasAncestorEndTagOwnerAt(argStart)) {
    return { decision: "defer-parent", nextProbe: currentProbe };
  }

  if (frameInlineCloseToken !== endTag) {
    return { decision: "allow", nextProbe: currentProbe };
  }

  const canReuseProbe =
    currentProbe !== null &&
    currentProbe.textEnd === frameTextEnd &&
    argStart >= currentProbe.startI &&
    argStart <= currentProbe.boundaryI;

  let nextProbe = currentProbe;
  if (!canReuseProbe) {
    let boundary = frameTextEnd;
    let reject = false;
    let probe = argStart;
    while (probe < frameTextEnd) {
      const escapedNext = readEscapedNext(probe);
      if (escapedNext !== null) {
        probe = escapedNext;
        continue;
      }
      if (hasTagStartAt(probe)) {
        boundary = probe;
        reject = false;
        break;
      }
      if (frameText.startsWith(tagClose, probe)) {
        boundary = probe;
        reject = scanEndTagAt(frameText, endTag, probe, frameTextEnd) === "full";
        break;
      }
      probe++;
    }

    nextProbe = {
      textEnd: frameTextEnd,
      startI: argStart,
      boundaryI: boundary,
      reject,
    };
  }

  return { decision: nextProbe?.reject ? "defer-parent" : "allow", nextProbe };
};

export const resolveShorthandOwnershipClose = (
  at: number,
  implicitInlineShorthand: boolean,
  hasEndTagOwnerAt: (index: number) => boolean,
): ShorthandOwnershipDecision => {
  if (!implicitInlineShorthand) return "allow";
  return hasEndTagOwnerAt(at) ? "defer-parent" : "allow";
};

export const buildMalformedInlineReplayPlan = (
  startFrame: ReplayFrameLike,
  getFrameByParentIndex: (parentIndex: number) => ReplayFrameLike | null,
): MalformedInlineReplayPlan => {
  const chain: ReplayFrameLike[] = [];
  let replayFrame: ReplayFrameLike | null = startFrame;

  while (replayFrame) {
    chain.push(replayFrame);
    const parent = getFrameByParentIndex(replayFrame.parentIndex);
    if (!parent) {
      return {
        chain,
        resumeParentIndex: -1,
        resumeTagStartI: replayFrame.tagStartI,
        resumeArgStartI: replayFrame.argStartI,
      };
    }
    if (parent.inlineCloseToken === null) {
      return {
        chain,
        resumeParentIndex: replayFrame.parentIndex,
        resumeTagStartI: replayFrame.tagStartI,
        resumeArgStartI: replayFrame.argStartI,
      };
    }
    replayFrame = parent;
  }

  return {
    chain,
    resumeParentIndex: -1,
    resumeTagStartI: startFrame.tagStartI,
    resumeArgStartI: startFrame.argStartI,
  };
};
