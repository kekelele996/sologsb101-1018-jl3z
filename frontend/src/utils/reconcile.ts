/**
 * 镶嵌工位台账（inlays）与髹涂工序台台账（coats）的核对逻辑。
 * 两摊各自留底、互不写入；本文件只做纯函数派生，不落库。
 *
 * 核对键：胎体编号（bodyId）+ 位置（position）。
 * - 工序台罩漆前：罩漆道次按 coverPositions 逐位对工位的嵌贴留底；
 *   螺钿 / 蛋壳没嵌完的位置 → 这道先停在「待嵌」；对不上的先挂起等补。
 * - 工位事后补记：位置已被罩过漆的 → 单列「待认领」，不退回罩漆那道。
 */
import type { Coat } from '@/types/coat';
import { isCoatLaid } from '@/types/coat';
import { isGatedInlayType, type Inlay } from '@/types/inlay';

/** 单个罩漆位置的核对结果 */
export interface PositionGate {
  position: string;
  /** clear 可罩（螺钿/蛋壳已嵌贴，或无需嵌片）；waiting 待嵌；unmatched 对不上，挂起等补 */
  status: 'clear' | 'waiting' | 'unmatched';
  /** 该位置参与闸口的螺钿/蛋壳嵌片（未嵌贴的即 waiting 来源） */
  gatedInlays: Inlay[];
  /** 提示文案 */
  reason: string;
}

/** 一道罩漆道次的罩前核对结果 */
export interface CoatGateResult {
  coat: Coat;
  positions: PositionGate[];
  /** 是否所有覆盖位置都可罩 */
  canTopcoat: boolean;
  /** 因嵌片未完成而停待嵌的位置数 */
  waitingCount: number;
  /** 对不上、先挂起等补的位置数 */
  unmatchedCount: number;
}

/** 工位视角的单条嵌片核对状态 */
export type InlayReconcileStatus =
  | 'clear' // 已对上罩漆道次且已嵌贴
  | 'waiting' // 螺钿/蛋壳待嵌，挡着对应罩漆道次
  | 'unlinked' // 没有罩漆道次覆盖该位置，先挂起等补
  | 'lateClaim' // 罩过后补记，待认领，不退回罩漆那道
  | 'claimed'; // 已事后认领到具体罩漆道次

export interface InlayReconcile {
  inlay: Inlay;
  status: InlayReconcileStatus;
  /** 对上 / 认领的罩漆道次（没有则 null） */
  coat: Coat | null;
}

/** 取一件胎体的全部罩漆道次，按道次升序 */
export function topcoatsOfBody(coats: Coat[], bodyId: string): Coat[] {
  return coats
    .filter((coat) => coat.bodyId === bodyId && coat.paintType === 'topcoat')
    .sort((a, b) => a.seq - b.seq);
}

/** 找一道罩漆道次覆盖某位置时对应的记录（同胎体、罩漆、位置命中） */
export function findTopcoatForPosition(
  coats: Coat[],
  bodyId: string,
  position: string,
): Coat | null {
  const hits = topcoatsOfBody(coats, bodyId).filter((coat) => coat.coverPositions.includes(position));
  return hits[0] ?? null;
}

/** 某罩漆道次在某个位置上参与闸口的螺钿 / 蛋壳嵌片 */
export function gatedInlaysAtPosition(inlays: Inlay[], bodyId: string, position: string): Inlay[] {
  return inlays.filter(
    (inlay) =>
      inlay.bodyId === bodyId &&
      inlay.position === position &&
      isGatedInlayType(inlay.type),
  );
}

/**
 * 工序台罩漆前按位置核对工位留底。
 * 每个覆盖位置：
 * - 工位在该位置一条记录都没有 → unmatched（对不上，先挂起等补，防止把空位直接罩住）
 * - 有登记且螺钿/蛋壳存在未嵌贴的 → waiting（没嵌完，这道停待嵌）
 * - 该位置只有描金/戗金等非嵌片工序，或螺钿/蛋壳均已嵌贴 → clear
 */
export function evaluateTopcoatGate(coat: Coat, inlays: Inlay[]): CoatGateResult {
  const bodyInlays = inlays.filter((inlay) => inlay.bodyId === coat.bodyId);
  const positions = coat.coverPositions.map<PositionGate>((position) => {
    const at = bodyInlays.filter((inlay) => inlay.position === position);
    if (at.length === 0) {
      return {
        position,
        status: 'unmatched',
        gatedInlays: [],
        reason: '工位留底里查不到该位置的任何嵌片 / 纹饰记录，先挂起等补',
      };
    }
    const gatedAt = at.filter((inlay) => isGatedInlayType(inlay.type));
    const waiting = gatedAt.filter((inlay) => inlay.pieceState !== 'applied');
    if (waiting.length > 0) {
      return {
        position,
        status: 'waiting',
        gatedInlays: gatedAt,
        reason: `还有 ${waiting.length} 片螺钿/蛋壳未嵌贴，罩漆前先停待嵌`,
      };
    }
    return {
      position,
      status: 'clear',
      gatedInlays: gatedAt,
      reason:
        gatedAt.length > 0 ? '螺钿/蛋壳均已嵌贴，可以罩漆' : '该位置为描金/戗金等漆面工序，无嵌片等待，可以罩漆',
    };
  });
  const waitingCount = positions.filter((item) => item.status === 'waiting').length;
  const unmatchedCount = positions.filter((item) => item.status === 'unmatched').length;
  return {
    coat,
    positions,
    // 一个覆盖位置都没填 → 无法核对，按不可罩处理（防止绕过位置核对直接罩漆）
    canTopcoat: coat.coverPositions.length > 0 && waitingCount === 0 && unmatchedCount === 0,
    waitingCount,
    unmatchedCount,
  };
}

/** 对一件胎体的全部罩漆道次做罩前核对 */
export function evaluateBodyTopcoats(coats: Coat[], inlays: Inlay[], bodyId: string): CoatGateResult[] {
  return topcoatsOfBody(coats, bodyId).map((coat) => evaluateTopcoatGate(coat, inlays));
}

/**
 * 工位视角：一条嵌片与罩漆台账的核对结果。
 * 以工位自己那份的 claimState / claimedCoatId 为准，台账只用于派生提示。
 */
export function reconcileInlay(inlay: Inlay, coats: Coat[]): InlayReconcile {
  const claimed =
    inlay.claimedCoatId !== null
      ? (coats.find((coat) => coat.id === inlay.claimedCoatId) ?? null)
      : null;

  if (inlay.claimState === 'pendingClaim') {
    return { inlay, status: 'lateClaim', coat: claimed };
  }
  if (inlay.claimState === 'claimed') {
    return { inlay, status: 'claimed', coat: claimed };
  }

  // unlinked：按「胎体编号 + 位置」对工序台的罩漆覆盖位置
  const topcoat = findTopcoatForPosition(coats, inlay.bodyId, inlay.position);
  if (!topcoat) {
    return { inlay, status: 'unlinked', coat: null };
  }
  if (isGatedInlayType(inlay.type) && inlay.pieceState !== 'applied') {
    return { inlay, status: 'waiting', coat: topcoat };
  }
  return { inlay, status: 'clear', coat: topcoat };
}

export function reconcileBodyInlays(coats: Coat[], inlays: Inlay[], bodyId: string): InlayReconcile[] {
  return inlays
    .filter((inlay) => inlay.bodyId === bodyId)
    .map((inlay) => reconcileInlay(inlay, coats));
}

/**
 * 工位登记 / 嵌贴时，判断该位置是否已经被罩过漆（漆已上器）。
 * 已罩过 → 事后补记走待认领，不退回罩漆那道。
 */
export function isPositionAlreadyLaid(coats: Coat[], bodyId: string, position: string): boolean {
  const topcoat = findTopcoatForPosition(coats, bodyId, position);
  return topcoat !== null && isCoatLaid(topcoat.state);
}

/** 待认领条目可认领的罩漆道次候选：同胎体、覆盖该位置的罩漆道次 */
export function claimCandidatesForInlay(inlay: Inlay, coats: Coat[]): Coat[] {
  return topcoatsOfBody(coats, inlay.bodyId).filter((coat) =>
    coat.coverPositions.includes(inlay.position),
  );
}

export const INLAY_RECONCILE_LABEL: Record<InlayReconcileStatus, string> = {
  clear: '可罩/已对上',
  waiting: '待嵌',
  unlinked: '挂起等补',
  lateClaim: '待认领',
  claimed: '已归属',
};

export const INLAY_RECONCILE_COLOR: Record<InlayReconcileStatus, string> = {
  clear: '#2f6f4f',
  waiting: '#b8860b',
  unlinked: '#8c8c8c',
  lateClaim: '#8c2f1f',
  claimed: '#3a6ea5',
};
