// 业务模型：类型定义、常量、时间工具、浏览器存储与初始数据。
// 数据只保存在浏览器（localStorage），不依赖任何服务。

export const STORAGE_KEY = "hxyfront-62008-fireworks-v1";

/** 同点位两次点火的最小安全间隔（毫秒） */
export const MIN_SAME_POINT_GAP = 3000;
/** 引信分段长度：同一引火线在同一分段内只能承载一次点火（毫秒） */
export const FUSE_SEGMENT = 5000;

/** 冲突类型 */
export type ConflictKind = "crowd" | "interval" | "fuse";

export const CONFLICT_META: Record<
  ConflictKind,
  { label: string; hint: string; exemptable: boolean }
> = {
  crowd: {
    label: "人员密集区",
    hint: "点火点安全距离覆盖到人员密集区，依法禁止例外放行",
    exemptable: false,
  },
  interval: {
    label: "同点位间隔",
    hint: `同一燃放点位两次点火间隔不足 ${MIN_SAME_POINT_GAP / 1000} 秒`,
    exemptable: true,
  },
  fuse: {
    label: "引信越段",
    hint: `同一条引火线上的两次点火落入同一 ${FUSE_SEGMENT / 1000} 秒分段`,
    exemptable: true,
  },
};

/** 审批记录状态：待审 / 有效 / 失效 / 驳回（有效与失效由审批结果 + 运行条件推导） */
export type ApprovalStatus = "pending" | "approved" | "rejected";

export interface FuseNode {
  id: string;
  section: string; // 节目段落
  model: string; // 烟花型号
  caliber: string; // 口径
  /** 平面图坐标（米，场地坐标系） */
  x: number;
  y: number;
  pointName: string; // 点位名称
  musicCue: string; // 音乐点火时间 mm:ss.SSS
  duration: number; // 持续毫秒
  launchAngle: number; // 发射角度（度）
  safetyDistance: number; // 安全距离（米）
  fuseLine: string; // 引火线编号
  fuseOffset: number; // 该节点在引火线上的位置（毫秒，沿引信燃烧方向）
}

export interface CrowdZone {
  id: string;
  name: string;
  x: number;
  y: number;
  radius: number; // 人员密集区半径（米）
}

export interface Exemption {
  id: string;
  /** 冲突指纹，同指纹代表同一个冲突 */
  conflictKey: string;
  kind: ConflictKind;
  title: string; // 冲突摘要快照，便于历史阅读
  nodeIds: string[]; // 相关节点（按 id 排序）
  applicant: string;
  approver: string; // 安全负责人
  reason: string;
  expiresAt: number; // 失效时刻（整场时间轴上的毫秒时刻）
  status: ApprovalStatus;
  createdAt: number;
  reviewedAt?: number;
  rejectNote?: string;
  /** 提交时相关节点的音乐点 / 发射角 / 安全距离快照 */
  snapshot: Record<string, NodeSignature>;
}

export interface NodeSignature {
  musicCueMs: number;
  launchAngle: number;
  safetyDistance: number;
}

export interface ShowState {
  nodes: FuseNode[];
  zones: CrowdZone[];
  exemptions: Exemption[];
  /** 整场结束时刻（毫秒） */
  showEndMs: number;
}

/* ---------------- 时间工具 ---------------- */

const TIME_RE = /^(\d{1,2}):(\d{2})[.:](\d{1,3})$/;

/** "mm:ss.SSS"（也容忍 mm:ss:SSS） -> 毫秒 */
export function parseTime(text: string): number | null {
  const m = TIME_RE.exec(text.trim());
  if (!m) return null;
  const sec = Number(m[2]);
  if (sec >= 60) return null;
  return (
    Number(m[1]) * 60_000 + sec * 1000 + Number(m[3].padEnd(3, "0"))
  );
}

/** 毫秒 -> "mm:ss.SSS" */
export function formatTime(ms: number): string {
  const safe = Math.max(0, Math.round(ms));
  const m = Math.floor(safe / 60_000);
  const s = Math.floor((safe % 60_000) / 1000);
  const milli = safe % 1000;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(
    milli
  ).padStart(3, "0")}`;
}

let seq = 0;
export function uid(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq}${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}

/* ---------------- 初始演示数据 ---------------- */

export function initialState(): ShowState {
  const nodes: FuseNode[] = [
    {
      id: "n1",
      section: "Intro 引子",
      model: "30mm 扇形架",
      caliber: "30mm",
      x: 22,
      y: 12,
      pointName: "A 点",
      musicCue: "00:12.500",
      duration: 1800,
      launchAngle: 75,
      safetyDistance: 30,
      fuseLine: "F1",
      fuseOffset: 2000,
    },
    {
      id: "n2",
      section: "Intro 引子",
      model: "75mm 礼花弹",
      caliber: "75mm",
      x: 22,
      y: 12,
      pointName: "A 点",
      musicCue: "00:14.500",
      duration: 2200,
      launchAngle: 90,
      safetyDistance: 30,
      fuseLine: "F1",
      fuseOffset: 7000,
    },
    {
      id: "n3",
      section: "Chorus 主歌",
      model: "75mm 礼花弹",
      caliber: "75mm",
      x: 78,
      y: 14,
      pointName: "B 点",
      musicCue: "01:08.200",
      duration: 2600,
      launchAngle: 85,
      safetyDistance: 30,
      fuseLine: "F2",
      fuseOffset: 1000,
    },
    {
      id: "n4",
      section: "Chorus 主歌",
      model: "100mm 礼花弹",
      caliber: "100mm",
      x: 50,
      y: 10,
      pointName: "C 点",
      musicCue: "01:11.000",
      duration: 3000,
      launchAngle: 90,
      safetyDistance: 30,
      fuseLine: "F2",
      fuseOffset: 3500,
    },
    {
      id: "n5",
      section: "Finale 终场",
      model: "冷焰火",
      caliber: "—",
      x: 26,
      y: 44,
      pointName: "E 点",
      musicCue: "03:42.000",
      duration: 4000,
      launchAngle: 60,
      safetyDistance: 40,
      fuseLine: "F3",
      fuseOffset: 1000,
    },
    {
      id: "n6",
      section: "Finale 终场",
      model: "罗马烛光",
      caliber: "45mm",
      x: 60,
      y: 46,
      pointName: "D 点",
      musicCue: "03:45.000",
      duration: 2000,
      launchAngle: 80,
      safetyDistance: 30,
      fuseLine: "F3",
      fuseOffset: 8000,
    },
  ];

  const zones: CrowdZone[] = [
    { id: "z1", name: "观众前区", x: 24, y: 58, radius: 14 },
    { id: "z2", name: "控台区", x: 88, y: 52, radius: 10 },
  ];

  const showEndMs = parseTime("04:00.000")!;

  const exemptions: Exemption[] = [
    {
      id: "ex-demo-1",
      conflictKey: "interval|n1|n2",
      kind: "interval",
      title: "A 点 · 00:12.500 与 00:14.500 同点位间隔不足 3 秒",
      nodeIds: ["n1", "n2"],
      applicant: "张编排",
      approver: "李安全",
      reason: "引子段双层叠加为既定设计，A 点炮位已加装挡火板。",
      expiresAt: parseTime("00:20.000")!,
      status: "approved",
      createdAt: Date.now() - 1000,
      reviewedAt: Date.now(),
      snapshot: {
        n1: { musicCueMs: parseTime("00:12.500")!, launchAngle: 75, safetyDistance: 30 },
        n2: { musicCueMs: parseTime("00:14.500")!, launchAngle: 90, safetyDistance: 30 },
      },
    },
  ];

  return { nodes, zones, exemptions, showEndMs };
}

/* ---------------- 浏览器存储 ---------------- */

export function loadState(): ShowState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return initialState();
    const parsed = JSON.parse(raw) as ShowState;
    if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.exemptions)) {
      return initialState();
    }
    if (typeof parsed.showEndMs !== "number") {
      parsed.showEndMs = parseTime("04:00.000")!;
    }
    if (!Array.isArray(parsed.zones)) parsed.zones = [];
    return parsed;
  } catch {
    return initialState();
  }
}

export function saveState(state: ShowState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 存储不可用时静默降级为内存态
  }
}

export function clearState(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
