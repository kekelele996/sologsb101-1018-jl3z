/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据结构版本号与升级迁移逻辑
 *   v1 → v2：Coat 增加 paintType 索引并回填历史记录
 *   v2 → v3：镶嵌 / 髹涂两摊分开留底
 *           · inlays 补出嵌片嵌贴（pieceState/appliedAt）与归属道次
 *             （claimState/claimedCoatId/lateRegistered），旧记录只有图案+位置，
 *             挂不上罩漆道次的单列待认领；
 *           · coats 补出罩漆覆盖位置 coverPositions。
 * - 六张业务表的增删改查与整库导入导出
 * - 首次打开自动播种互相引用的演示数据（幂等）
 * 纯前端应用：不依赖任何后端服务或数据库。
 */
import Dexie, { type Table } from 'dexie';
import type { Body } from '@/types/body';
import type { Coat, PaintType } from '@/types/coat';
import { isCoatLaid } from '@/types/coat';
import type { Room } from '@/types/room';
import type { Polish } from '@/types/polish';
import { isGatedInlayType, type Inlay } from '@/types/inlay';
import type { Inspect } from '@/types/inspect';

/** 数据库名（README 与导出文件均使用该名称） */
export const DB_NAME = 'gblacquer';

/** 当前数据结构版本号 */
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

    // v3：两摊分开留底。inlays 增加嵌贴 / 归属索引；coats 增加罩漆覆盖位置索引
    this.version(DB_SCHEMA_VERSION)
      .stores({
        bodies: 'id, code, material, shape, state, updatedAt',
        coats: 'id, bodyId, seq, paintType, state, needRecheck, *coverPositions, updatedAt',
        rooms: 'id, bodyId, date, verdict, updatedAt',
        polishes: 'id, bodyId, seq, method, updatedAt',
        inlays:
          'id, bodyId, type, position, pieceState, claimState, claimedCoatId, lateRegistered, updatedAt',
        inspects: 'id, bodyId, verdict, date, updatedAt',
      })
      .upgrade(async (tx) => {
        const coats = await tx.table<Coat>('coats').toArray();
        const inlays = await tx.table<Inlay>('inlays').toArray();
        normalizeV3Data(coats, inlays);
        await tx.table<Coat>('coats').bulkPut(coats);
        await tx.table<Inlay>('inlays').bulkPut(inlays);
      });
  }
}

/**
 * v2→v3 数据补齐（迁移与导入旧版 JSON 共用同一套规则，保持口径一致）：
 * - coats：paintType / needRecheck / thicknessUm 兜底；罩漆道次按工位记录回填覆盖位置。
 * - inlays：旧记录只有图案 + 位置，补出嵌贴与归属道次；挂不上罩漆道次的单列待认领。
 */
export function normalizeV3Data(coats: Coat[], inlays: Inlay[]): void {
  // coats 历史字段兜底
  const legal: PaintType[] = ['raw', 'color', 'topcoat'];
  coats.forEach((coat) => {
    if (!legal.includes(coat.paintType)) coat.paintType = 'raw';
    if (typeof coat.needRecheck !== 'boolean') coat.needRecheck = false;
    if (typeof coat.thicknessUm !== 'number') coat.thicknessUm = 40;
    if (!Array.isArray(coat.coverPositions)) coat.coverPositions = [];
  });

  // 旧镶嵌记录只有图案 + 位置：以同胎体纹饰所在位置回填罩漆道次覆盖位置
  const positionsByBody = new Map<string, Set<string>>();
  inlays.forEach((inlay) => {
    const set = positionsByBody.get(inlay.bodyId) ?? new Set<string>();
    set.add(inlay.position);
    positionsByBody.set(inlay.bodyId, set);
  });
  coats.forEach((coat) => {
    if (coat.paintType !== 'topcoat') {
      coat.coverPositions = [];
      return;
    }
    // 已有覆盖位置的保留（较新的备份）；没有的按旧镶嵌位置回填
    if (!Array.isArray(coat.coverPositions) || coat.coverPositions.length === 0) {
      const positions = positionsByBody.get(coat.bodyId);
      coat.coverPositions = positions ? [...positions] : [];
    }
  });

  const topcoatAt = (bodyId: string, position: string): Coat | undefined =>
    coats
      .filter((coat) => coat.bodyId === bodyId && coat.paintType === 'topcoat')
      .sort((a, b) => a.seq - b.seq)
      .find((coat) => coat.coverPositions.includes(position));

  inlays.forEach((rawInlay) => {
    // 旧备份里这些字段可能不存在，放宽类型逐字段判断
    const inlay = rawInlay as Inlay & {
      pieceState?: unknown;
      claimState?: unknown;
      appliedAt?: number | null;
      lateRegistered?: unknown;
    };
    // 已经是新结构的记录不动，只补缺失字段（导入较新备份时）
    if (inlay.pieceState !== 'registered' && inlay.pieceState !== 'applied') {
      const gated = isGatedInlayType(inlay.type);
      const topcoat = topcoatAt(inlay.bodyId, inlay.position);
      const laid = topcoat !== undefined && isCoatLaid(topcoat.state);
      const pieceApplied = !gated || laid;
      inlay.pieceState = pieceApplied ? 'applied' : 'registered';
      inlay.appliedAt = pieceApplied ? inlay.updatedAt ?? null : null;
    }
    if (inlay.claimState !== 'unlinked' && inlay.claimState !== 'claimed' && inlay.claimState !== 'pendingClaim') {
      const topcoat = topcoatAt(inlay.bodyId, inlay.position);
      if (topcoat) {
        inlay.claimState = 'claimed';
        inlay.claimedCoatId = topcoat.id;
        inlay.lateRegistered = false;
      } else {
        inlay.claimState = 'pendingClaim';
        inlay.claimedCoatId = null;
        inlay.lateRegistered = isGatedInlayType(inlay.type);
      }
    }
    if (typeof inlay.lateRegistered !== 'boolean') inlay.lateRegistered = false;
    if (inlay.appliedAt === undefined) {
      inlay.appliedAt = inlay.pieceState === 'applied' ? inlay.updatedAt ?? null : null;
    }
  });
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

  // body_01：罩漆道次 coat_0103 覆盖外壁，螺钿已嵌贴可罩 → 通过
  // body_02：罩漆道次 coat_0203 待涂、覆盖盖面，蛋壳还没嵌完 → 工序台停待嵌
  // body_03：罩漆已完成；另有一条事后补记的螺钿 → 待认领，不退回罩漆
  const coats: Coat[] = [
    { id: 'coat_0101', bodyId: 'body_01', seq: 1, paintType: 'raw', colorName: '漆黑', coatDate: '2026-03-02', thicknessUm: 40, state: 'done', needRecheck: false, coverPositions: [], createdAt: now - 86400000 * 11, updatedAt: now - 86400000 * 10 },
    { id: 'coat_0102', bodyId: 'body_01', seq: 2, paintType: 'color', colorName: '朱红', coatDate: '2026-03-06', thicknessUm: 45, state: 'toPolish', needRecheck: true, coverPositions: [], createdAt: now - 86400000 * 7, updatedAt: now - 86400000 * 2 },
    { id: 'coat_0103', bodyId: 'body_01', seq: 3, paintType: 'topcoat', colorName: '推光本色', coatDate: '2026-03-12', thicknessUm: 30, state: 'todo', needRecheck: false, coverPositions: ['外壁'], createdAt: now - 86400000 * 6, updatedAt: now - 86400000 * 6 },
    { id: 'coat_0201', bodyId: 'body_02', seq: 1, paintType: 'raw', colorName: '漆黑', coatDate: '2026-03-03', thicknessUm: 35, state: 'done', needRecheck: false, coverPositions: [], createdAt: now - 86400000 * 8, updatedAt: now - 86400000 * 7 },
    { id: 'coat_0202', bodyId: 'body_02', seq: 2, paintType: 'color', colorName: '赭石', coatDate: '2026-03-08', thicknessUm: 42, state: 'coated', needRecheck: true, coverPositions: [], createdAt: now - 86400000 * 5, updatedAt: now - 86400000 },
    { id: 'coat_0203', bodyId: 'body_02', seq: 3, paintType: 'topcoat', colorName: '推光本色', coatDate: '2026-03-14', thicknessUm: 30, state: 'awaitInlay', needRecheck: false, coverPositions: ['盖面'], createdAt: now - 86400000 * 2, updatedAt: now - 86400000 * 2 },
    { id: 'coat_0301', bodyId: 'body_03', seq: 1, paintType: 'raw', colorName: '漆黑', coatDate: '2026-02-10', thicknessUm: 38, state: 'done', needRecheck: false, coverPositions: [], createdAt: now - 86400000 * 26, updatedAt: now - 86400000 * 25 },
    { id: 'coat_0302', bodyId: 'body_03', seq: 2, paintType: 'color', colorName: '石绿', coatDate: '2026-02-18', thicknessUm: 44, state: 'done', needRecheck: false, coverPositions: [], createdAt: now - 86400000 * 20, updatedAt: now - 86400000 * 18 },
    { id: 'coat_0303', bodyId: 'body_03', seq: 3, paintType: 'topcoat', colorName: '描金', coatDate: '2026-02-26', thicknessUm: 28, state: 'done', needRecheck: false, coverPositions: ['通体', '外壁', '口沿'], createdAt: now - 86400000 * 14, updatedAt: now - 86400000 * 4 },
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
    // body_01 外壁螺钿已嵌贴 → 对 coat_0103，可罩
    {
      id: 'inlay_0101', bodyId: 'body_01', type: 'nacre', pattern: '缠枝莲', position: '外壁',
      materialNote: '0.8mm 螺钿片，刻纹嵌贴',
      pieceState: 'applied', claimState: 'claimed', claimedCoatId: 'coat_0103', lateRegistered: false,
      appliedAt: now - 86400000 * 7, createdAt: now - 86400000 * 7, updatedAt: now - 86400000 * 7,
    },
    // body_02 盖面蛋壳仅登记、未嵌贴 → coat_0203 被挡在待嵌
    {
      id: 'inlay_0201', bodyId: 'body_02', type: 'eggshell', pattern: '云纹', position: '盖面',
      materialNote: '鸭蛋壳拼贴后髹漆磨显',
      pieceState: 'registered', claimState: 'claimed', claimedCoatId: 'coat_0203', lateRegistered: false,
      appliedAt: null, createdAt: now - 86400000 * 4, updatedAt: now - 86400000 * 4,
    },
    // body_03 戗金（非嵌片，不参与先嵌后罩），归属已完成罩漆
    {
      id: 'inlay_0301', bodyId: 'body_03', type: 'incisedGold', pattern: '折枝花', position: '通体',
      materialNote: '戗金，金粉入刻线',
      pieceState: 'applied', claimState: 'claimed', claimedCoatId: 'coat_0303', lateRegistered: false,
      appliedAt: now - 86400000 * 12, createdAt: now - 86400000 * 12, updatedAt: now - 86400000 * 12,
    },
    {
      id: 'inlay_0302', bodyId: 'body_03', type: 'goldTrace', pattern: '诗文', position: '外壁',
      materialNote: '描金，泥金细描',
      pieceState: 'applied', claimState: 'claimed', claimedCoatId: 'coat_0303', lateRegistered: false,
      appliedAt: now - 86400000 * 11, createdAt: now - 86400000 * 11, updatedAt: now - 86400000 * 11,
    },
    // body_03 口沿螺钿：罩漆已过后才补记 → 待认领，不退回 coat_0303
    {
      id: 'inlay_0303', bodyId: 'body_03', type: 'nacre', pattern: '几何回纹', position: '口沿',
      materialNote: '罩漆后补嵌的细螺钿边，磨显处理',
      pieceState: 'applied', claimState: 'pendingClaim', claimedCoatId: null, lateRegistered: true,
      appliedAt: now - 86400000 * 2, createdAt: now - 86400000 * 2, updatedAt: now - 86400000 * 2,
    },
    // body_02 底足蛋壳：两摊还没对上（没有罩漆道次覆盖底足）→ 挂起等补
    {
      id: 'inlay_0202', bodyId: 'body_02', type: 'eggshell', pattern: '折枝花', position: '底足',
      materialNote: '蛋壳小片，待确认罩漆道次',
      pieceState: 'registered', claimState: 'unlinked', claimedCoatId: null, lateRegistered: false,
      appliedAt: null, createdAt: now - 86400000 * 3, updatedAt: now - 86400000 * 3,
    },
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
  // 旧版本备份（v1/v2）导入时按当前结构补齐：罩漆覆盖位置、嵌贴、归属道次，挂不上的待认领
  if ((snapshot.schemaVersion ?? 0) < DB_SCHEMA_VERSION) {
    normalizeV3Data(snapshot.coats, snapshot.inlays);
  }
  await clearAllTables();
  await db.transaction('rw', TABLE_LIST, async () => {
    await db.bodies.bulkPut(snapshot.bodies);
    await db.coats.bulkPut(snapshot.coats);
    await db.rooms.bulkPut(snapshot.rooms);
    await db.polishes.bulkPut(snapshot.polishes);
    await db.inlays.bulkPut(snapshot.inlays);
    await db.inspects.bulkPut(snapshot.inspects);
  });
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
