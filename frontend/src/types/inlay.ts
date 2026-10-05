/**
 * 镶嵌（Inlay）数据模型 —— 镶嵌工位自留底
 * 螺钿、蛋壳、描金、戗金等纹饰的登记与嵌片嵌贴，叠加显示于器型示意区。
 * 本分只记工位这一摊：纹饰登记、嵌贴状态、归属道次、事后补记认领；
 * 不写髹涂工序台的 coats 那份。
 */

/** 镶嵌类型 */
export type InlayType = 'nacre' | 'eggshell' | 'goldTrace' | 'incisedGold';

/** 嵌贴状态：待嵌（只登记未嵌片）/ 已嵌（嵌片已嵌贴到位） */
export type InlayAffixState = 'pending' | 'affixed';

/** 认领状态：正常 / 待认领（位置已罩漆后工位才补记，挂不上归属道次） */
export type InlayClaimState = 'normal' | 'unclaimed';

export interface Inlay {
  id: string;
  /** 所属胎体 id */
  bodyId: string;
  /** 镶嵌类型 */
  type: InlayType;
  /** 图案名，如「缠枝莲」「云纹」 */
  pattern: string;
  /** 位置，如「外壁」「盖面」；与工序台按 胎体编号 + 位置 核对 */
  position: string;
  /** 材料与工艺备注 */
  materialNote: string;
  /** 嵌片嵌贴状态（工位留底） */
  affixState: InlayAffixState;
  /** 归属道次：同胎体罩漆道次 seq；挂不上时为 null */
  affixSeq: number | null;
  /** 认领状态：已罩漆位置事后补记的单列「待认领」，不退回罩漆道次 */
  claimState: InlayClaimState;
  /** 嵌贴完成时间戳，未嵌为 null（工位留底） */
  affixedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export type InlayDraft = Omit<Inlay, 'id' | 'createdAt' | 'updatedAt'>;

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

export const INLAY_AFFIX_LABEL: Record<InlayAffixState, string> = {
  pending: '待嵌',
  affixed: '已嵌',
};

export const INLAY_AFFIX_COLOR: Record<InlayAffixState, string> = {
  pending: '#c9963c',
  affixed: '#2f6f4f',
};

export const INLAY_AFFIX_OPTIONS: ReadonlyArray<{ value: InlayAffixState; label: string }> = [
  { value: 'pending', label: '待嵌' },
  { value: 'affixed', label: '已嵌' },
];

export const INLAY_CLAIM_LABEL: Record<InlayClaimState, string> = {
  normal: '正常',
  unclaimed: '待认领',
};

export const INLAY_CLAIM_OPTIONS: ReadonlyArray<{ value: InlayClaimState; label: string }> = [
  { value: 'normal', label: '正常' },
  { value: 'unclaimed', label: '待认领' },
];

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
    affixState: 'pending',
    affixSeq: null,
    claimState: 'normal',
    affixedAt: null,
  };
}
