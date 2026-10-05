/**
 * 镶嵌工位（inlays）与髹涂工序台（coats）的核对逻辑（纯函数）
 * 两摊各自留底、互不改写；本文件只做「胎体编号 + 位置」的只读比对：
 * - 工序台罩漆前按位置核对工位嵌贴：没嵌完 → 道次停在「待嵌」；对不上 → 挂起等补
 * - 已罩漆位置工位事后补记 → 单列「待认领」，不退回罩漆道次
 */
import type { Coat } from '@/types/coat';
import type { Inlay } from '@/types/inlay';

/** 该道次是否覆盖某位置（「通体」覆盖全部位置） */
export function coatCoversPosition(coat: Pick<Coat, 'coverPositions'>, position: string): boolean {
  return coat.coverPositions.includes(position) || coat.coverPositions.includes('通体');
}

/** 同胎体下覆盖该位置的罩漆道次（按道次升序） */
export function topcoatsCovering(coats: Coat[], bodyId: string, position: string): Coat[] {
  return coats
    .filter((coat) => coat.bodyId === bodyId && coat.paintType === 'topcoat' && coatCoversPosition(coat, position))
    .sort((a, b) => a.seq - b.seq);
}

/** 该位置是否已经罩过漆（存在已完成的罩漆道次覆盖） */
export function isPositionTopcoated(coats: Coat[], bodyId: string, position: string): boolean {
  return topcoatsCovering(coats, bodyId, position).some((coat) => coat.state === 'done');
}

/** 工位归属道次：同胎体覆盖该位置的第一道罩漆道次；挂不上返回 null */
export function plannedTopcoatSeq(coats: Coat[], bodyId: string, position: string): number | null {
  return topcoatsCovering(coats, bodyId, position)[0]?.seq ?? null;
}

export interface InlayCoverCheck {
  position: string;
  /** 工位在该胎体 + 位置是否有镶嵌登记 */
  registered: boolean;
  /** 该位置是否已有嵌片嵌贴到位 */
  affixed: boolean;
}

export interface InlayGateResult {
  /** 逐位置核对结果 */
  coverChecks: InlayCoverCheck[];
  /** 工位完全没有登记的罩漆位置：对不上，先挂起等补 */
  unregisteredPositions: string[];
  /** 已登记但嵌片未嵌完：没嵌完，道次先停在待嵌 */
  pendingPositions: string[];
  /** 已登记且嵌片已嵌贴到位 */
  affixedPositions: string[];
  /** 罩漆位置非空且每个位置都能对上已嵌片，方可罩漆 */
  canTopcoat: boolean;
}

/** 工序台罩漆前核对：按胎体编号 + 位置对工位的嵌贴 */
export function evaluateInlayGate(coat: Coat, inlays: Inlay[]): InlayGateResult {
  const positions = [...new Set(coat.coverPositions)];
  const coverChecks: InlayCoverCheck[] = positions.map((position) => {
    const rows = inlays.filter((row) => row.bodyId === coat.bodyId && row.position === position);
    return {
      position,
      registered: rows.length > 0,
      affixed: rows.some((row) => row.affixState === 'affixed'),
    };
  });
  const unregisteredPositions = coverChecks.filter((item) => !item.registered).map((item) => item.position);
  const pendingPositions = coverChecks
    .filter((item) => item.registered && !item.affixed)
    .map((item) => item.position);
  const affixedPositions = coverChecks.filter((item) => item.affixed).map((item) => item.position);
  return {
    coverChecks,
    unregisteredPositions,
    pendingPositions,
    affixedPositions,
    canTopcoat: positions.length > 0 && unregisteredPositions.length === 0 && pendingPositions.length === 0,
  };
}

/** 工位侧核对状态 */
export type InlayRowStatus = 'pendingAffix' | 'ready' | 'unclaimed' | 'hanging';

export const INLAY_ROW_STATUS_LABEL: Record<InlayRowStatus, string> = {
  pendingAffix: '待嵌',
  ready: '已对上',
  unclaimed: '待认领',
  hanging: '挂起等补',
};

/**
 * 工位侧逐条核对：
 * - 待认领：已罩漆位置事后补记，单列不退回
 * - 待嵌：嵌片尚未嵌贴
 * - 挂起等补：工位登记的位置在工序台没有任何罩漆道次能对上
 */
export function classifyInlayRow(row: Inlay, coats: Coat[]): InlayRowStatus {
  if (row.claimState === 'unclaimed') return 'unclaimed';
  if (row.affixState === 'pending') return 'pendingAffix';
  if (topcoatsCovering(coats, row.bodyId, row.position).length === 0) return 'hanging';
  return 'ready';
}
