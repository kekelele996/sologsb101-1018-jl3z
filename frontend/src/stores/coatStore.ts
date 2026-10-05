/**
 * 髹涂道次状态管理（Zustand）——工序台自己那份留底（coats）。
 * 维护道次顺序与状态推进，支持拖拽重排落库重编号、批量改漆种与状态；
 * 罩漆前按「胎体编号 + 位置」核对工位嵌贴，没嵌完那道先停在待嵌。
 * 所有写入只动 coats 表，不改镶嵌工位的 inlays。
 */
import { create } from 'zustand';
import { db, createId } from '@/utils/db';
import { writeOwnLedger } from '@/utils/ledgerWrite';
import type { Coat, CoatDraft, CoatState, PaintType } from '@/types/coat';
import { nextCoatState } from '@/types/coat';
import { suggestIntervalHours, suggestPaintType } from '@/utils/humidity';
import { evaluateTopcoatGate } from '@/utils/reconcile';
import type { Inlay } from '@/types/inlay';
import { useBodyStore } from './bodyStore';

export interface PaintSuggestion {
  paintType: PaintType;
  intervalHours: number;
  sourceCode: string;
  sourceColor: string;
}

export interface GateMutationResult {
  ok: boolean;
  message: string;
  /** 罩前核对明细，供页面逐位置展示 */
  waitingPositions?: string[];
  unmatchedPositions?: string[];
}

interface CoatStoreState {
  coats: Coat[];
  loading: boolean;
  ready: boolean;
  error: string;
  loadCoats: () => Promise<void>;
  coatsOfBody: (bodyId: string) => Coat[];
  createCoat: (draft: CoatDraft) => Promise<Coat>;
  updateCoat: (id: string, patch: Partial<Coat>) => Promise<void>;
  removeCoat: (id: string) => Promise<void>;
  batchUpdate: (ids: string[], patch: Partial<Coat>) => Promise<void>;
  advanceState: (id: string) => Promise<void>;
  markRecheck: (bodyId: string, recheck: boolean) => Promise<void>;
  reorderCoats: (bodyId: string, orderedIds: string[]) => Promise<void>;
  nextSeq: (bodyId: string) => number;
  /** 同器型自动带出上次漆种与间隔建议 */
  suggestForBody: (bodyId: string) => PaintSuggestion;
  /**
   * 罩漆前核对：按道次覆盖位置对工位嵌贴留底。
   * 没嵌完 → 这道停在待嵌（只写 coats）；对不上的位置挂起等补，同样不罩。
   * 全部对得上且嵌完 → 正常推进一道。
   */
  topcoatGateCheck: (id: string, inlays: Inlay[]) => Promise<GateMutationResult>;
  /** 待嵌道次恢复：工位嵌完后，工序台把道次从待嵌恢复为待涂，重新走罩前核对 */
  resumeFromAwaitInlay: (id: string) => Promise<GateMutationResult>;
}

export const useCoatStore = create<CoatStoreState>((set, get) => ({
  coats: [],
  loading: false,
  ready: false,
  error: '',

  async loadCoats() {
    set({ loading: true });
    try {
      const coats = await db.coats.toArray();
      coats.sort((a, b) => (a.bodyId === b.bodyId ? a.seq - b.seq : a.bodyId.localeCompare(b.bodyId)));
      set({ coats, loading: false, ready: true, error: '' });
    } catch (error) {
      set({ loading: false, ready: true, error: error instanceof Error ? error.message : '道次读取失败' });
    }
  },

  coatsOfBody(bodyId) {
    return get()
      .coats.filter((coat) => coat.bodyId === bodyId)
      .sort((a, b) => a.seq - b.seq);
  },

  async createCoat(draft) {
    const now = Date.now();
    const row: Coat = { ...draft, id: createId('coat'), createdAt: now, updatedAt: now };
    await db.coats.put(row);
    await get().loadCoats();
    return row;
  },

  async updateCoat(id, patch) {
    await db.coats.update(id, { ...patch, updatedAt: Date.now() } as never);
    await get().loadCoats();
  },

  async removeCoat(id) {
    const target = get().coats.find((coat) => coat.id === id);
    await db.coats.delete(id);
    if (target) {
      // 删除后按序重编号，保持 seq 连续
      const rest = get()
        .coats.filter((coat) => coat.bodyId === target.bodyId && coat.id !== id)
        .sort((a, b) => a.seq - b.seq)
        .map((coat, index) => ({ ...coat, seq: index + 1, updatedAt: Date.now() }));
      if (rest.length > 0) await db.coats.bulkPut(rest);
    }
    await get().loadCoats();
  },

  async batchUpdate(ids, patch) {
    if (ids.length === 0) return;
    const now = Date.now();
    const rows = get()
      .coats.filter((coat) => ids.includes(coat.id))
      .map((coat) => ({ ...coat, ...patch, updatedAt: now }));
    await db.coats.bulkPut(rows);
    await get().loadCoats();
  },

  async advanceState(id) {
    const coat = get().coats.find((item) => item.id === id);
    if (!coat) return;
    const next = nextCoatState(coat.state);
    if (next === coat.state) return;
    await get().updateCoat(id, { state: next });
  },

  async markRecheck(bodyId, recheck) {
    const affected = get().coats.filter((coat) => coat.bodyId === bodyId && coat.state !== 'done');
    if (affected.length === 0) return;
    const now = Date.now();
    await db.coats.bulkPut(affected.map((coat) => ({ ...coat, needRecheck: recheck, updatedAt: now })));
    await get().loadCoats();
  },

  async reorderCoats(bodyId, orderedIds) {
    const indexOf = new Map(orderedIds.map((id, index) => [id, index]));
    const rows = get()
      .coats.filter((coat) => coat.bodyId === bodyId)
      .sort((a, b) => {
        const ai = indexOf.has(a.id) ? (indexOf.get(a.id) as number) : Number.MAX_SAFE_INTEGER;
        const bi = indexOf.has(b.id) ? (indexOf.get(b.id) as number) : Number.MAX_SAFE_INTEGER;
        return ai - bi;
      })
      .map((coat, index) => ({ ...coat, seq: index + 1, updatedAt: Date.now() }));
    await db.coats.bulkPut(rows);
    await get().loadCoats();
  },

  nextSeq(bodyId) {
    const list = get().coats.filter((coat) => coat.bodyId === bodyId);
    return list.length === 0 ? 1 : Math.max(...list.map((coat) => coat.seq)) + 1;
  },

  async topcoatGateCheck(id, inlays) {
    const coat = get().coats.find((item) => item.id === id);
    if (!coat) return { ok: false, message: '道次不存在' };
    if (coat.paintType !== 'topcoat') {
      // 非罩漆道次不走嵌片闸口，直接线性推进
      await get().advanceState(id);
      return { ok: true, message: '已推进状态' };
    }

    const gate = evaluateTopcoatGate(coat, inlays);
    if (!gate.canTopcoat) {
      // 没嵌完 / 对不上：这道先停在待嵌（只写工序台自己那份）
      if (coat.state !== 'awaitInlay') {
        const result = await writeOwnLedger(
          db.coats,
          (table) => table.update(id, { state: 'awaitInlay', updatedAt: Date.now() }),
          { ledgerName: '髹涂工序台台账' },
        );
        if (!result.ok) return { ok: false, message: result.error ?? '状态更新失败' };
        await get().loadCoats();
      }
      const waiting = gate.positions.filter((item) => item.status === 'waiting').map((item) => item.position);
      const unmatched = gate.positions.filter((item) => item.status === 'unmatched').map((item) => item.position);
      const missingPosition = coat.coverPositions.length === 0 ? '该罩漆道次还没填覆盖位置，先补位置再核对；' : '';
      return {
        ok: false,
        message:
          missingPosition +
          (waiting.length > 0 ? `位置 ${waiting.join('、')} 嵌片未完成，该道先停在待嵌；` : '') +
          (unmatched.length > 0 ? `位置 ${unmatched.join('、')} 对不上工位留底，先挂起等补。` : ''),
        waitingPositions: waiting,
        unmatchedPositions: unmatched,
      };
    }

    // 全部对得上且嵌完：正常罩漆推进（待嵌恢复出来的从待涂推进到已涂）
    const baseState: CoatState = coat.state === 'awaitInlay' ? 'todo' : coat.state;
    const next = nextCoatState(baseState);
    const result = await writeOwnLedger(
      db.coats,
      (table) => table.update(id, { state: next, updatedAt: Date.now() }),
      { ledgerName: '髹涂工序台台账' },
    );
    if (!result.ok) return { ok: false, message: result.error ?? '状态更新失败' };
    await get().loadCoats();
    return { ok: true, message: '工位嵌贴已逐位核对通过，已罩漆并推进状态' };
  },

  async resumeFromAwaitInlay(id) {
    const result = await writeOwnLedger(
      db.coats,
      (table) => table.update(id, { state: 'todo', updatedAt: Date.now() }),
      { ledgerName: '髹涂工序台台账' },
    );
    if (!result.ok) return { ok: false, message: result.error ?? '恢复失败' };
    await get().loadCoats();
    return { ok: true, message: '已恢复为待涂，请重新按位置核对后罩漆' };
  },

  suggestForBody(bodyId) {
    const bodies = useBodyStore.getState().bodies;
    const current = bodies.find((body) => body.id === bodyId);
    const previousBody = bodies.find((body) => body.id !== bodyId && current !== undefined && body.shape === current.shape);
    const previousCoat = previousBody
      ? get()
          .coats.filter((coat) => coat.bodyId === previousBody.id)
          .sort((a, b) => a.seq - b.seq)
          .pop()
      : undefined;
    const paintType = suggestPaintType(get().nextSeq(bodyId), previousCoat?.paintType, current?.shape);
    return {
      paintType,
      intervalHours: suggestIntervalHours(paintType),
      sourceCode: previousBody?.code ?? '',
      sourceColor: previousCoat?.colorName ?? '',
    };
  },
}));

/** 道次派生选择器：按状态集合过滤 */
export function selectCoatsByStates(coats: Coat[], states: CoatState[]): Coat[] {
  if (states.length === 0) return coats;
  return coats.filter((coat) => states.includes(coat.state));
}
