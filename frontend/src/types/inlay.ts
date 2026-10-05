/**
 * 镶嵌（Inlay）数据模型 —— 镶嵌工位留底
 * 螺钿、蛋壳、描金、戗金等纹饰的登记与嵌片嵌贴，叠加显示于器型示意区。
 *
 * 职责边界：镶嵌工位只管「纹饰登记 + 嵌片嵌贴 + 归属道次认领」，
 * 不回写、不改动髹涂工序台那份道次台账（coats）。
 */

/** 镶嵌类型 */
export type InlayType = 'nacre' | 'eggshell' | 'goldTrace' | 'incisedGold';

/**
 * 嵌片嵌贴状态：
 * - registered 仅登记（纹饰登记了，嵌片还没嵌）
 * - applied    已嵌贴（螺钿/蛋壳罩漆前必须到这一步）
 * 描金/戗金不属于嵌片工序，登记即视同已嵌贴。
 */
export type InlayPieceState = 'registered' | 'applied';

/**
 * 归属核对状态（两摊按「胎体编号 + 位置」核对后的结果，只记在工位自己这份上）：
 * - unlinked      未对道次：登记时还没有罩漆道次覆盖该位置，挂起等补
 * - claimed       已归属：已对上具体罩漆道次（claimedCoatId）
 * - pendingClaim  待认领：位置已被罩过漆、工位事后补记的嵌片，单列待认领，
 *                 不退回罩漆那道；认领后才转为 claimed
 */
export type InlayClaimState = 'unlinked' | 'claimed' | 'pendingClaim';

export interface Inlay {
  id: string;
  /** 所属胎体 id */
  bodyId: string;
  /** 镶嵌类型 */
  type: InlayType;
  /** 图案名，如「缠枝莲」「云纹」 */
  pattern: string;
  /** 位置，如「外壁」「盖面」——两摊核对的键之一 */
  position: string;
  /** 材料与工艺备注 */
  materialNote: string;
  /** 嵌片嵌贴状态：仅登记 / 已嵌贴 */
  pieceState: InlayPieceState;
  /** 归属核对状态：未对道次 / 已归属 / 待认领 */
  claimState: InlayClaimState;
  /**
   * 归属道次（罩漆道次 id，髹涂台账 coats 的主键）。
   * 未对上时为 null；待认领条目由工位事后认领填入，认领不改 coats 那份。
   */
  claimedCoatId: string | null;
  /** 是否罩漆已过后事后补记（补记的不退回罩漆那道，只进待认领） */
  lateRegistered: boolean;
  /** 嵌贴完成时间戳，未嵌贴为 null */
  appliedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export type InlayDraft = Pick<
  Inlay,
  'bodyId' | 'type' | 'pattern' | 'position' | 'materialNote' | 'pieceState'
>;

export const INLAY_TYPE_LABEL: Record<InlayType, string> = {
  nacre: '螺钿',
  eggshell: '蛋壳',
  goldTrace: '描金',
  incisedGold: '戗金',
};

export const INLAY_TYPE_COLOR: Record<InlayType, string> = {
  nacre: '#7d6ba8',
  eggshell: '#8c8479',
  goldTrace: '#c9963c',
  incisedGold: '#8c2f1f',
};

export const INLAY_TYPE_OPTIONS: ReadonlyArray<{ value: InlayType; label: string }> = [
  { value: 'nacre', label: '螺钿' },
  { value: 'eggshell', label: '蛋壳' },
  { value: 'goldTrace', label: '描金' },
  { value: 'incisedGold', label: '戗金' },
];

export const INLAY_PIECE_STATE_LABEL: Record<InlayPieceState, string> = {
  registered: '待嵌',
  applied: '已嵌贴',
};

export const INLAY_PIECE_STATE_COLOR: Record<InlayPieceState, string> = {
  registered: '#c9963c',
  applied: '#2f6f4f',
};

export const INLAY_PIECE_STATE_OPTIONS: ReadonlyArray<{ value: InlayPieceState; label: string }> = [
  { value: 'registered', label: '待嵌（仅登记）' },
  { value: 'applied', label: '已嵌贴' },
];

export const INLAY_CLAIM_STATE_LABEL: Record<InlayClaimState, string> = {
  unlinked: '未对道次',
  claimed: '已归属',
  pendingClaim: '待认领',
};

export const INLAY_CLAIM_STATE_COLOR: Record<InlayClaimState, string> = {
  unlinked: '#8c8c8c',
  claimed: '#2f6f4f',
  pendingClaim: '#8c2f1f',
};

export const INLAY_CLAIM_STATE_OPTIONS: ReadonlyArray<{ value: InlayClaimState; label: string }> = [
  { value: 'unlinked', label: '未对道次' },
  { value: 'claimed', label: '已归属' },
  { value: 'pendingClaim', label: '待认领' },
];

/**
 * 罩漆前必须先嵌好的类型：螺钿、蛋壳。
 * 描金 / 戗金是漆面工序，不参与「先嵌后罩」的位置闸口。
 */
export const INLAY_GATED_TYPES: ReadonlySet<InlayType> = new Set(['nacre', 'eggshell']);

export function isGatedInlayType(type: InlayType): boolean {
  return INLAY_GATED_TYPES.has(type);
}

export const INLAY_POSITION_OPTIONS: readonly string[] = [
  '外壁',
  '内壁',
  '盖面',
  '底足',
  '口沿',
  '通体',
];

export const INLAY_PATTERN_OPTIONS: readonly string[] = [
  '缠枝莲',
  '云纹',
  '折枝花',
  '山水人物',
  '几何回纹',
  '诗文',
];

export function createEmptyInlayDraft(bodyId: string): InlayDraft {
  return {
    bodyId,
    type: 'nacre',
    pattern: '缠枝莲',
    position: '外壁',
    materialNote: '',
    pieceState: 'registered',
  };
}
