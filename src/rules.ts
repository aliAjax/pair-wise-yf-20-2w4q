// 判定层：冲突检测、例外指纹与生命周期、放行阻塞判定。
// 不做任何渲染与存储 IO，输入 ShowState，输出派生结果。

import {
  CROWD_ZONES,
  FireNode,
  MIN_POSITION_INTERVAL,
  POSITIONS,
  RiskException,
  SEGMENTS,
  SHOW_END,
  ShowState,
  fmtTime,
} from "./model";

export type ConflictKind = "crowd" | "interval" | "overrun";

export interface Conflict {
  id: string;
  kind: ConflictKind;
  title: string;
  detail: string;
  nodeIds: string[];
  /** 人员密集区冲突永远阻塞且禁止例外；其余两类可申请例外 */
  exceptionAllowed: boolean;
}

export const CONFLICT_LABEL: Record<ConflictKind, string> = {
  crowd: "人员密集区",
  interval: "同点位间隔",
  overrun: "引信越段",
};

export const STATUS_LABEL: Record<string, string> = {
  pending: "待审",
  approved: "有效",
  invalid: "失效",
  rejected: "驳回",
};

const positionOf = (id: string) => POSITIONS.find((p) => p.id === id);
const segmentOf = (id: string) => SEGMENTS.find((s) => s.id === id);

function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

/** 单个节点参与指纹的字段：音乐点、发射角、安全距离（以及决定冲突身份的归属字段） */
function nodeFingerprint(node: FireNode): string {
  return [
    node.id,
    node.positionId,
    node.segmentId,
    node.time,
    node.angle,
    node.safetyDistance,
    node.duration,
  ].join("|");
}

export function fingerprintFor(nodeIds: string[], nodes: FireNode[]): string {
  return nodeIds
    .map((id) => nodes.find((n) => n.id === id))
    .filter((n): n is FireNode => Boolean(n))
    .map(nodeFingerprint)
    .sort()
    .join("||");
}

// ---- 冲突检测 ----

function detectCrowd(node: FireNode): Conflict | null {
  const pos = positionOf(node.positionId);
  if (!pos) return null;
  for (const zone of CROWD_ZONES) {
    if (dist(pos.x, pos.y, zone.x, zone.y) <= zone.r) {
      return {
        id: `crowd:${node.id}`,
        kind: "crowd",
        title: `人员密集区 · ${node.name}`,
        detail: `${pos.name} 落入「${zone.name}」覆盖范围，该类风险不得申请例外，必须改点或取消发射。`,
        nodeIds: [node.id],
        exceptionAllowed: false,
      };
    }
  }
  return null;
}

function detectInterval(nodes: FireNode[]): Conflict[] {
  const result: Conflict[] = [];
  const byPosition = new Map<string, FireNode[]>();
  for (const n of nodes) {
    const list = byPosition.get(n.positionId) ?? [];
    list.push(n);
    byPosition.set(n.positionId, list);
  }
  for (const [posId, list] of byPosition) {
    const sorted = [...list].sort((a, b) => a.time - b.time);
    for (let i = 0; i < sorted.length - 1; i += 1) {
      const a = sorted[i];
      const b = sorted[i + 1];
      const gap = b.time - a.time;
      if (gap < MIN_POSITION_INTERVAL) {
        const pos = positionOf(posId);
        result.push({
          id: `interval:${a.id}:${b.id}`,
          kind: "interval",
          title: `同点位间隔 · ${a.name} ↔ ${b.name}`,
          detail: `${pos?.name ?? posId} 两次点火仅间隔 ${(gap / 1000).toFixed(1)}s，小于最小安全间隔 ${(
            MIN_POSITION_INTERVAL / 1000
          ).toFixed(0)}s。`,
          nodeIds: [a.id, b.id],
          exceptionAllowed: true,
        });
      }
    }
  }
  return result;
}

function detectOverrun(node: FireNode): Conflict | null {
  const seg = segmentOf(node.segmentId);
  if (!seg) return null;
  const windowEnd = node.time + node.duration;
  if (windowEnd > seg.end) {
    const over = windowEnd - seg.end;
    return {
      id: `overrun:${node.id}`,
      kind: "overrun",
      title: `引信越段 · ${node.name}`,
      detail: `点火窗口结束于 ${fmtTime(windowEnd)}，相对「${seg.name}」结束点 ${fmtTime(seg.end)} 越界 ${(
        over / 1000
      ).toFixed(1)}s，引信需留在本段内完成。`,
      nodeIds: [node.id],
      exceptionAllowed: true,
    };
  }
  return null;
}

/** 按时间顺序计算当前全部冲突（人员密集区 → 同点位间隔 → 引信越段） */
export function detectConflicts(nodes: FireNode[]): Conflict[] {
  const conflicts: Conflict[] = [];
  for (const node of nodes) {
    const c = detectCrowd(node);
    if (c) conflicts.push(c);
  }
  conflicts.push(...detectInterval(nodes));
  for (const node of nodes) {
    const c = detectOverrun(node);
    if (c) conflicts.push(c);
  }
  return conflicts.sort((a, b) => Math.min(...a.nodeIds.map((id) => nodes.find((n) => n.id === id)?.time ?? 0)) -
    Math.min(...b.nodeIds.map((id) => nodes.find((n) => n.id === id)?.time ?? 0)));
}

// ---- 例外生命周期 ----

/**
 * 节点音乐点、发射角或安全距离（含点位、段落、持续时长）变化后，
 * 待审/有效例外立即失效并恢复阻塞。返回新数组；无变化时返回原数组。
 */
export function reconcileExceptions(state: ShowState): RiskException[] {
  let changed = false;
  const next = state.exceptions.map((ex) => {
    if (ex.status !== "pending" && ex.status !== "approved") return ex;
    if (fingerprintFor(ex.nodeIds, state.nodes) !== ex.fingerprint) {
      changed = true;
      return { ...ex, status: "invalid" as const, invalidReason: "modified" as const };
    }
    return ex;
  });
  return changed ? next : state.exceptions;
}

export function isTimeExpired(ex: RiskException, nowMs: number): boolean {
  return (ex.status === "approved" || ex.status === "pending") && nowMs >= ex.expireAt;
}

/** 界面展示用状态：有效例外到达失效时刻即显示「失效(超时)」 */
export function displayStatus(ex: RiskException, nowMs: number): RiskException["status"] {
  if ((ex.status === "approved" || ex.status === "pending") && nowMs >= ex.expireAt) {
    return "invalid";
  }
  return ex.status;
}

export function invalidReasonText(ex: RiskException, nowMs: number): string {
  if (ex.status !== "invalid" && !isTimeExpired(ex, nowMs)) return "";
  if (ex.invalidReason === "modified") return "节点参数变更，例外立即失效";
  if (nowMs >= ex.expireAt) return "已到失效时刻";
  return "";
}

/** 某冲突当前是否存在有效（approved 且未超时且指纹未变）例外 */
export function activeExceptionFor(
  conflictId: string,
  state: ShowState,
  nowMs: number
): RiskException | undefined {
  return state.exceptions.find(
    (ex) =>
      ex.conflictId === conflictId &&
      ex.status === "approved" &&
      nowMs < ex.expireAt &&
      fingerprintFor(ex.nodeIds, state.nodes) === ex.fingerprint
  );
}

/**
 * 同一冲突已有待审或有效例外时不能重复提交
 * （驳回、失效属于终态，允许重新提交）。
 */
export function findBlockingSubmission(
  conflictId: string,
  state: ShowState,
  nowMs: number
): RiskException | undefined {
  return state.exceptions.find((ex) => {
    if (ex.conflictId !== conflictId) return false;
    if (ex.status === "pending") return true;
    if (ex.status === "approved") {
      return (
        nowMs < ex.expireAt &&
        fingerprintFor(ex.nodeIds, state.nodes) === ex.fingerprint
      );
    }
    return false;
  });
}

export interface ConflictView extends Conflict {
  activeException?: RiskException;
  blocking: boolean; // 是否仍然阻塞放行（人员密集区恒为 true）
}

export function buildConflictViews(state: ShowState, nowMs: number): ConflictView[] {
  return detectConflicts(state.nodes).map((c) => {
    const active = activeExceptionFor(c.id, state, nowMs);
    return {
      ...c,
      activeException: active,
      blocking: !c.exceptionAllowed || !active,
    };
  });
}

export interface SubmitExceptionInput {
  conflictId: string;
  kind: ConflictKind;
  nodeIds: string[];
  safetyOwner: string;
  reason: string;
  expireAt: number;
}

export type SubmitError =
  | "CROWD_NOT_ALLOWED"
  | "MISSING_FIELDS"
  | "EXPIRE_AFTER_SHOW"
  | "DUPLICATE_ACTIVE";

export function validateSubmission(
  input: SubmitExceptionInput,
  state: ShowState,
  nowMs: number
): SubmitError | null {
  if (input.kind === "crowd") return "CROWD_NOT_ALLOWED";
  if (!input.safetyOwner.trim() || !input.reason.trim() || !Number.isFinite(input.expireAt)) {
    return "MISSING_FIELDS";
  }
  if (input.expireAt > SHOW_END) return "EXPIRE_AFTER_SHOW";
  if (findBlockingSubmission(input.conflictId, state, nowMs)) return "DUPLICATE_ACTIVE";
  return null;
}

export const SUBMIT_ERROR_TEXT: Record<SubmitError, string> = {
  CROWD_NOT_ALLOWED: "人员密集区风险不得申请例外",
  MISSING_FIELDS: "须填写安全负责人、理由和失效时刻",
  EXPIRE_AFTER_SHOW: "失效时刻不得晚于整场结束（04:00.000）",
  DUPLICATE_ACTIVE: "该冲突已有待审或有效例外，不能重复提交",
};

/** 审批通过：以当前节点状态刷新指纹，避免审批期间参数被改动。 */
export function approveException(
  ex: RiskException,
  nodes: FireNode[],
  decider: string,
  nowMs: number
): RiskException {
  return {
    ...ex,
    status: "approved",
    fingerprint: fingerprintFor(ex.nodeIds, nodes),
    decidedAt: nowMs,
    decider: decider.trim() || "安全值班",
    rejectNote: undefined,
  };
}

export function rejectException(
  ex: RiskException,
  decider: string,
  note: string,
  nowMs: number
): RiskException {
  return {
    ...ex,
    status: "rejected",
    decidedAt: nowMs,
    decider: decider.trim() || "安全值班",
    rejectNote: note.trim() || "未通过风险评审",
  };
}

/** 整场是否允许放行：存在任意阻塞冲突即不可放行 */
export function releaseBlocked(state: ShowState, nowMs: number): boolean {
  return buildConflictViews(state, nowMs).some((c) => c.blocking);
}
