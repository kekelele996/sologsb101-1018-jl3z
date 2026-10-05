/**
 * 髹涂道次（Coat）数据模型 —— 髹涂工序台留底
 * 一件胎体上的逐道髹涂记录：漆种、色名、涂刷日期、湿膜厚度与状态推进。
 *
 * 职责边界：工序台只管「髹涂道次 + 罩漆覆盖位置 + 待嵌闸口」，
 * 不改镶嵌工位那份纹饰 / 嵌贴台账（inlays）。罩漆前按位置对工位的嵌贴留底。
 */

/** 漆种：生漆 / 色漆 / 罩漆 */
export type PaintType = 'raw' | 'color' | 'topcoat';

/**
 * 道次状态：待涂 / 已涂 / 待打磨 / 已完成 / 待嵌
 * 「待嵌」只用于罩漆道次：按位置核对发现该罩的位置嵌片没嵌完时，
 * 这一道先停在待嵌，等工位嵌贴完成后再继续；它不在常规线性推进链路里。
 */
export type CoatState = 'todo' | 'coated' | 'toPolish' | 'done' | 'awaitInlay';

export interface Coat {
  id: string;
  /** 所属胎体 id */
  bodyId: string;
  /** 道次序号，从 1 开始连续整数 */
  seq: number;
  /** 漆种 */
  paintType: PaintType;
  /** 色名，如「朱红」「漆黑」 */
  colorName: string;
  /** 涂刷日期 yyyy-MM-dd */
  coatDate: string;
  /** 湿膜厚度（微米） */
  thicknessUm: number;
  /** 当前状态 */
  state: CoatState;
  /** 荫房判定异常时回写的「待复检」标记 */
  needRecheck: boolean;
  /**
   * 本道罩漆覆盖的位置（如「外壁」「盖面」），工序台罩漆前据此逐位核对工位嵌贴。
   * 非罩漆道次为空数组。
   */
  coverPositions: string[];
  createdAt: number;
  updatedAt: number;
}

export type CoatDraft = Omit<Coat, 'id' | 'createdAt' | 'updatedAt'>;

export const PAINT_TYPE_LABEL: Record<PaintType, string> = {
  raw: '生漆',
  color: '色漆',
  topcoat: '罩漆',
};

export const COAT_STATE_LABEL: Record<CoatState, string> = {
  todo: '待涂',
  coated: '已涂',
  toPolish: '待打磨',
  done: '已完成',
  awaitInlay: '待嵌',
};

export const COAT_STATE_COLOR: Record<CoatState, string> = {
  todo: '#8c8c8c',
  coated: '#c9963c',
  toPolish: '#8c2f1f',
  done: '#2f6f4f',
  awaitInlay: '#b8860b',
};

/** 常规线性推进链路（待嵌为罩漆专属的旁挂状态，不在此链路中） */
export const COAT_STATE_FLOW: readonly CoatState[] = ['todo', 'coated', 'toPolish', 'done'];

export const PAINT_TYPE_OPTIONS: ReadonlyArray<{ value: PaintType; label: string }> = [
  { value: 'raw', label: '生漆' },
  { value: 'color', label: '色漆' },
  { value: 'topcoat', label: '罩漆' },
];

export const COAT_STATE_OPTIONS: ReadonlyArray<{ value: CoatState; label: string }> = [
  ...COAT_STATE_FLOW.map((state) => ({ value: state, label: COAT_STATE_LABEL[state] })),
  { value: 'awaitInlay', label: COAT_STATE_LABEL.awaitInlay },
];

/** 色名候选，表单下拉直接复用 */
export const COLOR_NAME_OPTIONS: readonly string[] = [
  '漆黑',
  '朱红',
  '赭石',
  '藤黄',
  '石绿',
  '推光本色',
  '描金',
];

export function nextCoatState(state: CoatState): CoatState {
  const index = COAT_STATE_FLOW.indexOf(state);
  if (index < 0 || index >= COAT_STATE_FLOW.length - 1) return state;
  return COAT_STATE_FLOW[index + 1] as CoatState;
}

/** 已经实际罩 / 涂过漆的状态（漆已上器，不可因补嵌回退） */
export const COAT_LAID_STATES: ReadonlySet<CoatState> = new Set(['coated', 'toPolish', 'done']);

export function isCoatLaid(state: CoatState): boolean {
  return COAT_LAID_STATES.has(state);
}

export function createEmptyCoatDraft(bodyId: string, seq: number): CoatDraft {
  return {
    bodyId,
    seq,
    paintType: 'raw',
    colorName: '漆黑',
    coatDate: new Date().toISOString().slice(0, 10),
    thicknessUm: 40,
    state: 'todo',
    needRecheck: false,
    coverPositions: [],
  };
}
