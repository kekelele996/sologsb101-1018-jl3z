/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据结构版本号与升级迁移逻辑（v1 → v2：Coat 增加 paintType 索引并回填历史记录）
 * - 六张业务表的增删改查与整库导入导出
 * - 首次打开自动播种互相引用的演示数据（幂等）
 * 纯前端应用：不依赖任何后端服务或数据库。
 */
import Dexie, { type Table } from 'dexie';
import type { Body } from '@/types/body';
import type { Coat, PaintType } from '@/types/coat';
import type { Room } from '@/types/room';
import type { Polish } from '@/types/polish';
import type { Inlay } from '@/types/inlay';
import type { Inspect } from '@/types/inspect';
import { coatCoversPosition } from '@/utils/inlayGate';

/** 数据库名（README 与导出文件均使用该名称） */
export const DB_NAME = 'gblacquer';

/**
 * 当前数据结构版本号
 * v3：镶嵌与罩漆两摊分开留底 —— Inlay 补嵌贴/归属道次/认领，Coat 加罩漆位置与「待嵌」卡位
 */
export const DB_SCHEMA_VERSION = 3;

/** localStorage 侧少量元数据键 */
export const LS_KEYS = {
  dbVersion: 'gblacquer:db-version',
  lastBackupAt: 'gblacquer:last-backup-at',
  uiPrefs: 'gblacquer:ui-prefs',
} as const;

export interface UiPrefs {
  /** 最近选中的胎体 */
  lastBodyId: string | null;
}

export const DEFAULT_UI_PREFS: UiPrefs = { lastBodyId: null };

export function readUiPrefs(): UiPrefs {
  try {
    const raw = localStorage.getItem(LS_KEYS.uiPrefs);
    if (!raw) return { ...DEFAULT_UI_PREFS };
    const parsed = JSON.parse(raw) as Partial<UiPrefs>;
    return { lastBodyId: typeof parsed.lastBodyId === 'string' ? parsed.lastBodyId : null };
  } catch {
    return { ...DEFAULT_UI_PREFS };
  }
}

export function writeUiPrefs(prefs: UiPrefs): void {
  try {
    localStorage.setItem(LS_KEYS.uiPrefs, JSON.stringify(prefs));
  } catch {
    /* 忽略隐私模式下的写入失败 */
  }
}

/** 记录结构版本与最近备份时间，便于「本地数据」页回显 */
export function stampDbVersion(): void {
  try {
    localStorage.setItem(LS_KEYS.dbVersion, String(DB_SCHEMA_VERSION));
  } catch {
    /* ignore */
  }
}

export function readLastBackupAt(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastBackupAt);
  } catch {
    return null;
  }
}

export function writeLastBackupAt(value: string): void {
  try {
    localStorage.setItem(LS_KEYS.lastBackupAt, value);
  } catch {
    /* ignore */
  }
}

class LacquerDatabase extends Dexie {
  bodies!: Table<Body, string>;
  coats!: Table<Coat, string>;
  rooms!: Table<Room, string>;
  polishes!: Table<Polish, string>;
  inlays!: Table<Inlay, string>;
  inspects!: Table<Inspect, string>;

  constructor() {
    super(DB_NAME);

    // v1：初版结构（历史数据保留）
    this.version(1).stores({
      bodies: 'id, code, material, shape, state, updatedAt',
      coats: 'id, bodyId, seq, state, updatedAt',
      rooms: 'id, bodyId, date, verdict, updatedAt',
      polishes: 'id, bodyId, seq, method, updatedAt',
      inlays: 'id, bodyId, type, position, updatedAt',
      inspects: 'id, bodyId, verdict, date, updatedAt',
    });

    // v2：Coat 增加 paintType 索引；历史记录缺少 paintType 时按「生漆」回填
    this.version(2)
      .stores({
        bodies: 'id, code, material, shape, state, updatedAt',
        coats: 'id, bodyId, seq, paintType, state, needRecheck, updatedAt',
        rooms: 'id, bodyId, date, verdict, updatedAt',
        polishes: 'id, bodyId, seq, method, updatedAt',
        inlays: 'id, bodyId, type, position, updatedAt',
        inspects: 'id, bodyId, verdict, date, updatedAt',
      })
      .upgrade(async (tx) => {
        await tx
          .table<Coat>('coats')
          .toCollection()
          .modify((coat) => {
            const legal: PaintType[] = ['raw', 'color', 'topcoat'];
            if (!legal.includes(coat.paintType)) coat.paintType = 'raw';
            if (typeof coat.needRecheck !== 'boolean') coat.needRecheck = false;
            if (typeof coat.thicknessUm !== 'number') coat.thicknessUm = 40;
          });
      });

    // v3：镶嵌工位 / 髹涂工序台两摊分开留底
    //  - coats 加 coverPositions 多值索引（罩漆位置，工序台留底）
    //  - inlays 加 affixState / affixSeq / claimState 索引（嵌贴、归属道次、认领）
    // 旧镶嵌记录只有图案和位置：补出嵌贴与归属道次，挂不上的单列「待认领」
    this.version(DB_SCHEMA_VERSION)
      .stores({
        bodies: 'id, code, material, shape, state, updatedAt',
        coats: 'id, bodyId, seq, paintType, state, needRecheck, coverPositions, updatedAt',
        rooms: 'id, bodyId, date, verdict, updatedAt',
        polishes: 'id, bodyId, seq, method, updatedAt',
        inlays: 'id, bodyId, type, position, affixState, affixSeq, claimState, updatedAt',
        inspects: 'id, bodyId, verdict, date, updatedAt',
      })
      .upgrade(async (tx) => {
        // 工序台那份：补罩漆位置留底（历史道次无登记，按空位置留底）
        await tx
          .table<Coat>('coats')
          .toCollection()
          .modify((coat) => {
            if (!Array.isArray(coat.coverPositions)) coat.coverPositions = [];
            // 历史上不存在「待嵌」卡位，异常值回落到「待涂」由工序台重新核对
            if (coat.state === 'awaitInlay') coat.state = 'coated';
          });

        // 工位那份：只有图案和位置 → 补嵌贴状态、归属道次；挂不上的待认领
        const coats = await tx.table<Coat>('coats').toArray();
        const legalAffix = ['pending', 'affixed'];
        const legalClaim = ['normal', 'unclaimed'];
        await tx
          .table<Inlay>('inlays')
          .toCollection()
          .modify((inlay) => {
            const topcoats = coats
              .filter((coat) => coat.bodyId === inlay.bodyId && coat.paintType === 'topcoat')
              .sort((a, b) => a.seq - b.seq);
            // 旧道次没有罩漆位置留底时，用「首道罩漆」兜底归属，保证旧镶嵌能补出归属道次
            const cover =
              topcoats.find((coat) => coatCoversPosition(coat, inlay.position)) ??
              (topcoats.every((coat) => coat.coverPositions.length === 0) ? topcoats[0] : undefined);
            const alreadyCoated = cover !== undefined && cover.state === 'done';
            if (typeof inlay.affixState !== 'string' || !legalAffix.includes(inlay.affixState)) {
              // 旧记录只有图案和位置：一律视为嵌片已嵌贴（纹饰登记即已完成嵌贴）
              inlay.affixState = 'affixed';
              inlay.affixedAt = typeof inlay.affixedAt === 'number' ? inlay.affixedAt : inlay.updatedAt ?? null;
            }
            if (inlay.affixState === 'affixed' && typeof inlay.affixedAt !== 'number') {
              inlay.affixedAt = inlay.updatedAt ?? null;
            }
            // 归属道次：能对上覆盖该位置的第一道罩漆道次就补 seq
            inlay.affixSeq = cover ? cover.seq : null;
            // 挂不上的（无罩漆道次，或该位置已罩过漆才补记）单列待认领
            if (typeof inlay.claimState !== 'string' || !legalClaim.includes(inlay.claimState)) {
              inlay.claimState = cover === undefined || alreadyCoated ? 'unclaimed' : 'normal';
            }
          });
      });
  }
}

export const db = new LacquerDatabase();

/** 六张业务表清单，事务中统一引用 */
const TABLE_LIST = [db.bodies, db.coats, db.rooms, db.polishes, db.inlays, db.inspects];

/** 生成主键：短前缀 + 时间戳 + 随机串，避免多标签页写入冲突 */
export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

/** 打开数据库并在首次使用时播种演示数据（幂等） */
export async function initDatabase(): Promise<void> {
  await db.open();
  stampDbVersion();
  if ((await db.bodies.count()) === 0) {
    await seedDatabase();
  }
}

/* ------------------------------ 播种数据 ------------------------------ */
/* 三层互相引用：Body →（Coat / Room / Polish / Inlay）→ Inspect，id 固定便于深链命中 */

export async function seedDatabase(): Promise<void> {
  const now = Date.now();
  const bodies: Body[] = [
    {
      id: 'body_01',
      code: 'LQ-2401',
      material: 'wood',
      shape: 'bowl',
      sizeMm: 152,
      ownerName: '陈氏委托',
      state: 'coating',
      createdAt: now - 86400000 * 12,
      updatedAt: now - 86400000 * 2,
    },
    {
      id: 'body_02',
      code: 'LQ-2402',
      material: 'lacquered',
      shape: 'box',
      sizeMm: 96,
      ownerName: '工作室自藏',
      state: 'drying',
      createdAt: now - 86400000 * 9,
      updatedAt: now - 86400000,
    },
    {
      id: 'body_03',
      code: 'LQ-2403',
      material: 'metal',
      shape: 'vase',
      sizeMm: 210,
      ownerName: '市工艺美术馆',
      state: 'done',
      createdAt: now - 86400000 * 30,
      updatedAt: now - 86400000 * 4,
    },
  ];

  const coats: Coat[] = [
    { id: 'coat_0101', bodyId: 'body_01', seq: 1, paintType: 'raw', colorName: '漆黑', coatDate: '2026-03-02', thicknessUm: 40, state: 'done', needRecheck: false, coverPositions: [], createdAt: now - 86400000 * 11, updatedAt: now - 86400000 * 10 },
    { id: 'coat_0102', bodyId: 'body_01', seq: 2, paintType: 'color', colorName: '朱红', coatDate: '2026-03-06', thicknessUm: 45, state: 'toPolish', needRecheck: true, coverPositions: [], createdAt: now - 86400000 * 7, updatedAt: now - 86400000 * 2 },
    { id: 'coat_0103', bodyId: 'body_01', seq: 3, paintType: 'topcoat', colorName: '推光本色', coatDate: '2026-03-12', thicknessUm: 30, state: 'todo', needRecheck: false, coverPositions: ['外壁', '口沿'], createdAt: now - 86400000 * 6, updatedAt: now - 86400000 * 6 },
    { id: 'coat_0201', bodyId: 'body_02', seq: 1, paintType: 'raw', colorName: '漆黑', coatDate: '2026-03-03', thicknessUm: 35, state: 'done', needRecheck: false, coverPositions: [], createdAt: now - 86400000 * 8, updatedAt: now - 86400000 * 7 },
    { id: 'coat_0202', bodyId: 'body_02', seq: 2, paintType: 'color', colorName: '赭石', coatDate: '2026-03-08', thicknessUm: 42, state: 'coated', needRecheck: true, coverPositions: [], createdAt: now - 86400000 * 5, updatedAt: now - 86400000 },
    { id: 'coat_0203', bodyId: 'body_02', seq: 3, paintType: 'topcoat', colorName: '推光本色', coatDate: '2026-03-13', thicknessUm: 30, state: 'coated', needRecheck: false, coverPositions: ['盖面'], createdAt: now - 86400000 * 2, updatedAt: now - 86400000 },
    { id: 'coat_0301', bodyId: 'body_03', seq: 1, paintType: 'raw', colorName: '漆黑', coatDate: '2026-02-10', thicknessUm: 38, state: 'done', needRecheck: false, coverPositions: [], createdAt: now - 86400000 * 26, updatedAt: now - 86400000 * 25 },
    { id: 'coat_0302', bodyId: 'body_03', seq: 2, paintType: 'color', colorName: '石绿', coatDate: '2026-02-18', thicknessUm: 44, state: 'done', needRecheck: false, coverPositions: [], createdAt: now - 86400000 * 20, updatedAt: now - 86400000 * 18 },
    { id: 'coat_0303', bodyId: 'body_03', seq: 3, paintType: 'topcoat', colorName: '描金', coatDate: '2026-02-26', thicknessUm: 28, state: 'done', needRecheck: false, coverPositions: ['通体', '外壁'], createdAt: now - 86400000 * 14, updatedAt: now - 86400000 * 4 },
  ];

  const rooms: Room[] = [
    { id: 'room_0101', bodyId: 'body_01', date: '2026-03-03', tempC: 24, humidityPct: 78, inAt: '09:00', outAt: '21:00', verdict: 'suitable', createdAt: now - 86400000 * 10, updatedAt: now - 86400000 * 10 },
    { id: 'room_0102', bodyId: 'body_01', date: '2026-03-07', tempC: 27, humidityPct: 56, inAt: '08:30', outAt: '20:00', verdict: 'dry', createdAt: now - 86400000 * 6, updatedAt: now - 86400000 * 2 },
    { id: 'room_0201', bodyId: 'body_02', date: '2026-03-05', tempC: 23, humidityPct: 91, inAt: '10:00', outAt: '22:30', verdict: 'wet', createdAt: now - 86400000 * 5, updatedAt: now - 86400000 },
    { id: 'room_0301', bodyId: 'body_03', date: '2026-02-20', tempC: 25, humidityPct: 76, inAt: '09:30', outAt: '21:30', verdict: 'suitable', createdAt: now - 86400000 * 18, updatedAt: now - 86400000 * 18 },
  ];

  const polishes: Polish[] = [
    { id: 'polish_0101', bodyId: 'body_01', seq: 1, grit: 600, method: 'water', durationMin: 35, operator: '王丽', createdAt: now - 86400000 * 9, updatedAt: now - 86400000 * 9 },
    { id: 'polish_0102', bodyId: 'body_01', seq: 2, grit: 1500, method: 'burnish', durationMin: 45, operator: '王丽', createdAt: now - 86400000 * 2, updatedAt: now - 86400000 * 2 },
    { id: 'polish_0201', bodyId: 'body_02', seq: 1, grit: 800, method: 'water', durationMin: 30, operator: '李成', createdAt: now - 86400000 * 6, updatedAt: now - 86400000 * 6 },
    { id: 'polish_0301', bodyId: 'body_03', seq: 3, grit: 2000, method: 'burnish', durationMin: 60, operator: '王丽', createdAt: now - 86400000 * 5, updatedAt: now - 86400000 * 4 },
  ];

  const inlays: Inlay[] = [
    // body_01 罩漆（coat_0103 罩外壁/口沿）：外壁螺钿已嵌可过核对；口沿工位未登记 → 挂起
    { id: 'inlay_0101', bodyId: 'body_01', type: 'nacre', pattern: '缠枝莲', position: '外壁', materialNote: '0.8mm 螺钿片，刻纹嵌贴', affixState: 'affixed', affixSeq: 3, claimState: 'normal', affixedAt: now - 86400000 * 7, createdAt: now - 86400000 * 7, updatedAt: now - 86400000 * 7 },
    // body_02 罩漆（coat_0203 罩盖面）：盖面蛋壳只登记未嵌片 → 核对时该道停在待嵌
    { id: 'inlay_0201', bodyId: 'body_02', type: 'eggshell', pattern: '云纹', position: '盖面', materialNote: '鸭蛋壳拼贴后髹漆磨显', affixState: 'pending', affixSeq: 3, claimState: 'normal', affixedAt: null, createdAt: now - 86400000 * 4, updatedAt: now - 86400000 * 4 },
    // body_03 已完工通体罩漆：戗金已罩后补记，归属道次 3；描金已罩后补记但归属挂不上 → 待认领
    { id: 'inlay_0301', bodyId: 'body_03', type: 'incisedGold', pattern: '折枝花', position: '通体', materialNote: '戗金，金粉入刻线', affixState: 'affixed', affixSeq: 3, claimState: 'normal', affixedAt: now - 86400000 * 12, createdAt: now - 86400000 * 12, updatedAt: now - 86400000 * 12 },
    { id: 'inlay_0302', bodyId: 'body_03', type: 'goldTrace', pattern: '诗文', position: '外壁', materialNote: '描金，泥金细描', affixState: 'affixed', affixSeq: 3, claimState: 'normal', affixedAt: now - 86400000 * 11, createdAt: now - 86400000 * 11, updatedAt: now - 86400000 * 11 },
    // 已罩漆后工位才补记底足：罩漆位置没覆盖到底足，归属挂不上 → 工位单列待认领，不退回罩漆
    { id: 'inlay_0303', bodyId: 'body_03', type: 'nacre', pattern: '几何回纹', position: '底足', materialNote: '罩漆后补登，待工位认领归属道次', affixState: 'affixed', affixSeq: null, claimState: 'unclaimed', affixedAt: now - 86400000 * 2, createdAt: now - 86400000 * 2, updatedAt: now - 86400000 * 2 },
  ];

  const inspects: Inspect[] = [
    { id: 'inspect_0101', bodyId: 'body_03', verdict: 'pass', defectNote: '', inspector: '周衡', date: '2026-03-02', defectCoatSeq: null, defectRoomId: null, createdAt: now - 86400000 * 4, updatedAt: now - 86400000 * 4 },
    { id: 'inspect_0102', bodyId: 'body_02', verdict: 'rework', defectNote: '起皱（荫干过快）', inspector: '周衡', date: '2026-03-08', defectCoatSeq: 2, defectRoomId: 'room_0201', createdAt: now - 86400000, updatedAt: now - 86400000 },
  ];

  await db.transaction('rw', TABLE_LIST, async () => {
    await db.bodies.bulkPut(bodies);
    await db.coats.bulkPut(coats);
    await db.rooms.bulkPut(rooms);
    await db.polishes.bulkPut(polishes);
    await db.inlays.bulkPut(inlays);
    await db.inspects.bulkPut(inspects);
  });
}

/* ------------------------------ 整库导入导出 ------------------------------ */

export interface LacquerSnapshot {
  app: typeof DB_NAME;
  schemaVersion: number;
  exportedAt: string;
  bodies: Body[];
  coats: Coat[];
  rooms: Room[];
  polishes: Polish[];
  inlays: Inlay[];
  inspects: Inspect[];
}

export async function exportSnapshot(): Promise<LacquerSnapshot> {
  const [bodies, coats, rooms, polishes, inlays, inspects] = await Promise.all([
    db.bodies.toArray(),
    db.coats.toArray(),
    db.rooms.toArray(),
    db.polishes.toArray(),
    db.inlays.toArray(),
    db.inspects.toArray(),
  ]);
  return {
    app: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    bodies,
    coats,
    rooms,
    polishes,
    inlays,
    inspects,
  };
}

/** 校验导入文件结构，返回错误文案（空串表示通过） */
export function validateSnapshot(input: unknown): string {
  if (typeof input !== 'object' || input === null) return '文件内容不是合法的 JSON 对象';
  const snapshot = input as Partial<LacquerSnapshot>;
  if (snapshot.app !== DB_NAME) return `备份文件不属于本项目（app=${String(snapshot.app)}）`;
  const keys: Array<keyof LacquerSnapshot> = ['bodies', 'coats', 'rooms', 'polishes', 'inlays', 'inspects'];
  for (const key of keys) {
    if (!Array.isArray(snapshot[key])) return `备份文件缺少 ${String(key)} 集合`;
  }
  return '';
}

export async function importSnapshot(snapshot: LacquerSnapshot): Promise<void> {
  const normalized = normalizeSnapshot(snapshot);
  await clearAllTables();
  await db.transaction('rw', TABLE_LIST, async () => {
    await db.bodies.bulkPut(normalized.bodies);
    await db.coats.bulkPut(normalized.coats);
    await db.rooms.bulkPut(normalized.rooms);
    await db.polishes.bulkPut(normalized.polishes);
    await db.inlays.bulkPut(normalized.inlays);
    await db.inspects.bulkPut(normalized.inspects);
  });
}

/**
 * 归一化导入的备份：旧结构版本（如 v2）缺少 v3 两摊留底字段时补齐。
 * 镶嵌旧记录只有图案和位置：补出嵌贴与归属道次，挂不上的单列待认领。
 * 导入走整库覆盖，与 Dexie .upgrade() 同口径，不写对方那份之外的内容。
 */
export function normalizeSnapshot(snapshot: LacquerSnapshot): LacquerSnapshot {
  const coats: Coat[] = snapshot.coats.map((coat) => ({
    ...coat,
    coverPositions: Array.isArray(coat.coverPositions)
      ? coat.coverPositions.filter((item): item is string => typeof item === 'string')
      : [],
    state: coat.state === 'awaitInlay' ? 'coated' : coat.state,
  }));
  const inlays: Inlay[] = snapshot.inlays.map((inlay) => {
    const hasAffix = inlay.affixState === 'pending' || inlay.affixState === 'affixed';
    const topcoats = coats
      .filter((coat) => coat.bodyId === inlay.bodyId && coat.paintType === 'topcoat')
      .sort((a, b) => a.seq - b.seq);
    // 旧备份罩漆道次可能没有位置留底：用首道罩漆兜底归属
    const cover =
      topcoats.find((coat) => coatCoversPosition(coat, inlay.position)) ??
      (topcoats.length > 0 && topcoats.every((coat) => coat.coverPositions.length === 0)
        ? topcoats[0]
        : undefined);
    const alreadyCoated = cover !== undefined && cover.state === 'done';
    const affixState = hasAffix ? inlay.affixState : 'affixed';
    return {
      ...inlay,
      affixState,
      affixedAt:
        typeof inlay.affixedAt === 'number'
          ? inlay.affixedAt
          : affixState === 'affixed'
            ? (inlay.updatedAt ?? null)
            : null,
      affixSeq: typeof inlay.affixSeq === 'number' ? inlay.affixSeq : cover ? cover.seq : null,
      claimState:
        inlay.claimState === 'normal' || inlay.claimState === 'unclaimed'
          ? inlay.claimState
          : cover === undefined || alreadyCoated
            ? 'unclaimed'
            : 'normal',
    } as Inlay;
  });
  return { ...snapshot, coats, inlays };
}

export async function clearAllTables(): Promise<void> {
  await db.transaction('rw', TABLE_LIST, async () => {
    await Promise.all([
      db.bodies.clear(),
      db.coats.clear(),
      db.rooms.clear(),
      db.polishes.clear(),
      db.inlays.clear(),
      db.inspects.clear(),
    ]);
  });
}

/** 清空并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await clearAllTables();
  await seedDatabase();
}

export async function countAll(): Promise<Record<string, number>> {
  const [bodies, coats, rooms, polishes, inlays, inspects] = await Promise.all([
    db.bodies.count(),
    db.coats.count(),
    db.rooms.count(),
    db.polishes.count(),
    db.inlays.count(),
    db.inspects.count(),
  ]);
  return { bodies, coats, rooms, polishes, inlays, inspects };
}

/* ------------------------------ 级联删除 ------------------------------ */

export async function removeBodyCascade(bodyId: string): Promise<void> {
  await db.transaction('rw', TABLE_LIST, async () => {
    await db.coats.where('bodyId').equals(bodyId).delete();
    await db.rooms.where('bodyId').equals(bodyId).delete();
    await db.polishes.where('bodyId').equals(bodyId).delete();
    await db.inlays.where('bodyId').equals(bodyId).delete();
    await db.inspects.where('bodyId').equals(bodyId).delete();
    await db.bodies.delete(bodyId);
  });
}
