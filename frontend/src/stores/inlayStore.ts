/**
 * 镶嵌工位状态管理（Zustand）——工位自己那份留底（inlays）。
 * 管纹饰登记、嵌片嵌贴、归属道次认领；所有写入只动 inlays 表，
 * 失败时只重试工位这份，绝不回写 / 改动工序台的 coats。
 */
import { create } from 'zustand';
import { db, createId } from '@/utils/db';
import { writeOwnLedger } from '@/utils/ledgerWrite';
import { isPositionAlreadyLaid } from '@/utils/reconcile';
import { isGatedInlayType, type Inlay, type InlayDraft } from '@/types/inlay';

export interface InlayMutationResult {
  ok: boolean;
  message: string;
}

interface InlayStoreState {
  inlays: Inlay[];
  loading: boolean;
  ready: boolean;
  error: string;
  loadInlays: () => Promise<void>;
  inlaysOfBody: (bodyId: string) => Inlay[];
  /** 登记纹饰：若该位置已被罩过漆，事后补记直接单列待认领，不退回罩漆那道 */
  registerInlay: (draft: InlayDraft, coats: import('@/types/coat').Coat[]) => Promise<InlayMutationResult>;
  /** 嵌片嵌贴：工位把某条嵌片标记为已嵌贴（只写自己那份） */
  markApplied: (id: string) => Promise<InlayMutationResult>;
  /** 退回为待嵌（误操作纠正，仍只写工位这份） */
  markRegistered: (id: string) => Promise<InlayMutationResult>;
  /** 事后认领：待认领条目归属到具体罩漆道次，认领不改 coats 那份 */
  claimInlay: (id: string, coatId: string) => Promise<InlayMutationResult>;
  /** 通用更新（编辑备注 / 图案等），同样只写 inlays */
  updateInlay: (id: string, patch: Partial<Inlay>) => Promise<InlayMutationResult>;
  removeInlay: (id: string) => Promise<InlayMutationResult>;
  bulkPutInlays: (rows: Inlay[]) => Promise<InlayMutationResult>;
}

export const useInlayStore = create<InlayStoreState>((set, get) => ({
  inlays: [],
  loading: false,
  ready: false,
  error: '',

  async loadInlays() {
    set({ loading: true });
    try {
      const inlays = await db.inlays.toArray();
      inlays.sort((a, b) => b.updatedAt - a.updatedAt);
      set({ inlays, loading: false, ready: true, error: '' });
    } catch (error) {
      set({ loading: false, ready: true, error: error instanceof Error ? error.message : '镶嵌记录读取失败' });
    }
  },

  inlaysOfBody(bodyId) {
    return get().inlays.filter((inlay) => inlay.bodyId === bodyId);
  },

  async registerInlay(draft, coats) {
    const now = Date.now();
    const gated = isGatedInlayType(draft.type);
    // 位置已被罩过漆 → 事后补记：单列待认领，不退回罩漆那道
    const laid = isPositionAlreadyLaid(coats, draft.bodyId, draft.position);
    const appliedNow = draft.pieceState === 'applied';
    const row: Inlay = {
      ...draft,
      id: createId('inlay'),
      claimState: laid ? 'pendingClaim' : 'unlinked',
      claimedCoatId: null,
      lateRegistered: laid && gated,
      appliedAt: appliedNow ? now : null,
      createdAt: now,
      updatedAt: now,
    };
    const result = await writeOwnLedger(db.inlays, (table) => table.put(row), { ledgerName: '镶嵌工位台账' });
    if (!result.ok) return { ok: false, message: result.error ?? '镶嵌登记失败' };
    await get().loadInlays();
    return { ok: true, message: laid ? '该位置已罩过漆，补记已单列「待认领」，不退回罩漆道次' : '镶嵌纹饰已登记' };
  },

  async markApplied(id) {
    const now = Date.now();
    const result = await writeOwnLedger(
      db.inlays,
      (table) => table.update(id, { pieceState: 'applied', appliedAt: now, updatedAt: now }),
      { ledgerName: '镶嵌工位台账' },
    );
    if (!result.ok) return { ok: false, message: result.error ?? '嵌贴登记失败' };
    await get().loadInlays();
    return { ok: true, message: '已记为嵌贴完成' };
  },

  async markRegistered(id) {
    const now = Date.now();
    const result = await writeOwnLedger(
      db.inlays,
      (table) => table.update(id, { pieceState: 'registered', appliedAt: null, updatedAt: now }),
      { ledgerName: '镶嵌工位台账' },
    );
    if (!result.ok) return { ok: false, message: result.error ?? '退回待嵌失败' };
    await get().loadInlays();
    return { ok: true, message: '已退回待嵌' };
  },

  async claimInlay(id, coatId) {
    const now = Date.now();
    const result = await writeOwnLedger(
      db.inlays,
      (table) =>
        table.update(id, {
          claimState: 'claimed',
          claimedCoatId: coatId,
          updatedAt: now,
        }),
      { ledgerName: '镶嵌工位台账' },
    );
    if (!result.ok) return { ok: false, message: result.error ?? '认领失败' };
    await get().loadInlays();
    return { ok: true, message: '已归属到罩漆道次（工序台那份未改动）' };
  },

  async updateInlay(id, patch) {
    const now = Date.now();
    const result = await writeOwnLedger(
      db.inlays,
      (table) => table.update(id, { ...patch, updatedAt: now }),
      { ledgerName: '镶嵌工位台账' },
    );
    if (!result.ok) return { ok: false, message: result.error ?? '镶嵌登记更新失败' };
    await get().loadInlays();
    return { ok: true, message: '已更新镶嵌登记' };
  },

  async removeInlay(id) {
    const result = await writeOwnLedger(db.inlays, (table) => table.delete(id), { ledgerName: '镶嵌工位台账' });
    if (!result.ok) return { ok: false, message: result.error ?? '删除失败' };
    await get().loadInlays();
    return { ok: true, message: '已删除' };
  },

  async bulkPutInlays(rows) {
    const now = Date.now();
    const stamped = rows.map((row) => ({ ...row, updatedAt: now }));
    const result = await writeOwnLedger(db.inlays, (table) => table.bulkPut(stamped), {
      ledgerName: '镶嵌工位台账',
    });
    if (!result.ok) return { ok: false, message: result.error ?? '批量更新失败' };
    await get().loadInlays();
    return { ok: true, message: '批量更新成功' };
  },
}));

/** 工位派生选择器：按归属状态过滤 */
export function selectInlaysByClaimState(inlays: Inlay[], states: Inlay['claimState'][]): Inlay[] {
  if (states.length === 0) return inlays;
  return inlays.filter((inlay) => states.includes(inlay.claimState));
}
