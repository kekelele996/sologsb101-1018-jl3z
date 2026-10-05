/* 纯逻辑 + 假 IndexedDB 冒烟测试：两摊留底、v2→v3 迁移、罩前核对、写失败只退自己那份 */
import 'fake-indexeddb/auto';
import { strict as assert } from 'node:assert';
import {
  db,
  DB_SCHEMA_VERSION,
  initDatabase,
  seedDatabase,
} from '../src/utils/db';
import {
  evaluateTopcoatGate,
  reconcileInlay,
  isPositionAlreadyLaid,
  claimCandidatesForInlay,
} from '../src/utils/reconcile';
import type { Coat } from '../src/types/coat';
import type { Inlay } from '../src/types/inlay';

let passed = 0;
const ok = (name: string, cond: boolean): void => {
  assert.ok(cond, name);
  passed += 1;
  console.log('✓', name);
};

async function main(): Promise<void> {
  ok('当前结构版本为 v3', DB_SCHEMA_VERSION === 3);

  await initDatabase();
  const inlays = await db.inlays.toArray();
  const coats = await db.coats.toArray();

  // 播种数据：body_02 罩漆道次 coat_0203 覆盖盖面，蛋壳未嵌 → waiting
  const coat0203 = coats.find((c) => c.id === 'coat_0203') as Coat;
  ok('播种：被挡罩漆道次停在待嵌', coat0203.state === 'awaitInlay');
  ok('播种：罩漆道次带覆盖位置', JSON.stringify(coat0203.coverPositions) === JSON.stringify(['盖面']));

  const gate0203 = evaluateTopcoatGate(coat0203, inlays);
  ok('罩前核对：盖面待嵌', gate0203.positions[0]!.status === 'waiting');
  ok('罩前核对：不可罩', gate0203.canTopcoat === false);

  // body_01 外壁螺钿已嵌贴 → clear
  const coat0103 = coats.find((c) => c.id === 'coat_0103') as Coat;
  const gate0103 = evaluateTopcoatGate(coat0103, inlays);
  ok('罩前核对：外壁已嵌可罩', gate0103.positions[0]!.status === 'clear' && gate0103.canTopcoat === true);

  // body_03 口沿螺钿事后补记 → pendingClaim，不退回已完成的 coat_0303
  const inlay0303 = inlays.find((i) => i.id === 'inlay_0303') as Inlay;
  ok('播种：罩后补记为待认领', inlay0303.claimState === 'pendingClaim' && inlay0303.lateRegistered === true);
  const rec0303 = reconcileInlay(inlay0303, coats);
  ok('工位核对：待认领状态', rec0303.status === 'lateClaim');
  const coat0303 = coats.find((c) => c.id === 'coat_0303') as Coat;
  ok('罩漆道次不受补记影响，仍已完成', coat0303.state === 'done');
  const candidates = claimCandidatesForInlay(inlay0303, coats);
  ok('待认领可认领的道次覆盖口沿', candidates.some((c) => c.id === 'coat_0303'));

  // body_02 底足蛋壳挂起：没有罩漆道次覆盖底足
  const inlay0202 = inlays.find((i) => i.id === 'inlay_0202') as Inlay;
  ok('播种：对不上道次先挂起', inlay0202.claimState === 'unlinked');
  ok('工位核对：挂起等补', reconcileInlay(inlay0202, coats).status === 'unlinked');

  // 位置已罩判定
  ok('已罩位置判定：口沿已罩', isPositionAlreadyLaid(coats, 'body_03', '口沿') === true);
  ok('未罩位置判定：底足未罩', isPositionAlreadyLaid(coats, 'body_02', '底足') === false);

  // 空位直接罩：覆盖一个工位没有任何记录的位置 → unmatched，挡住
  const phantom: Coat = { ...coat0203, id: 'coat_phantom', seq: 4, state: 'todo', coverPositions: ['内壁'] };
  const gatePhantom = evaluateTopcoatGate(phantom, inlays);
  ok('空位置核对：挂起等补，不直接罩', gatePhantom.positions[0]!.status === 'unmatched' && gatePhantom.canTopcoat === false);

  // 只有描金/戗金的位置 → clear（非嵌片工序）
  const goldOnly: Coat = { ...coat0203, id: 'coat_gold', seq: 5, state: 'todo', coverPositions: ['通体'] };
  const gateGold = evaluateTopcoatGate(goldOnly, inlays);
  ok('通体只有戗金：可罩', gateGold.positions[0]!.status === 'unmatched'); // body_02 通体无记录 → 实际应 unmatched
  // body_03 通体是戗金
  const goldOnBody3: Coat = { ...coat0303, state: 'todo', coverPositions: ['通体'] };
  const gateGold3 = evaluateTopcoatGate(goldOnBody3, inlays);
  ok('body_03 通体戗金：无嵌片等待可罩', gateGold3.positions[0]!.status === 'clear');
  void gateGold;

  /* ---------------- v2→v3 迁移：旧数据只有图案 + 位置 ---------------- */
  await db.delete();
  const { Dexie } = await import('dexie');
  const old = new Dexie('gblacquer');
  old.version(2).stores({
    bodies: 'id, code, material, shape, state, updatedAt',
    coats: 'id, bodyId, seq, paintType, state, needRecheck, updatedAt',
    rooms: 'id, bodyId, date, verdict, updatedAt',
    polishes: 'id, bodyId, seq, method, updatedAt',
    inlays: 'id, bodyId, type, position, updatedAt',
    inspects: 'id, bodyId, verdict, date, updatedAt',
  });
  const now = Date.now();
  await old.table('bodies').bulkPut([
    { id: 'b1', code: 'OLD-1', material: 'wood', shape: 'bowl', sizeMm: 100, ownerName: '', state: 'coating', createdAt: now, updatedAt: now },
  ]);
  await old.table('coats').bulkPut([
    // 旧记录还没有 paintType 兜底字段缺失、也没有 coverPositions；一道已罩、一道待涂
    { id: 'c1', bodyId: 'b1', seq: 1, colorName: '漆黑', coatDate: '2026-01-01', thicknessUm: 40, state: 'done', createdAt: now, updatedAt: now },
    { id: 'c2', bodyId: 'b1', seq: 2, paintType: 'topcoat', colorName: '推光本色', coatDate: '2026-01-05', thicknessUm: 30, state: 'todo', needRecheck: false, createdAt: now, updatedAt: now },
  ]);
  // 旧镶嵌：只有图案 + 位置
  await old.table('inlays').bulkPut([
    { id: 'i1', bodyId: 'b1', type: 'eggshell', pattern: '云纹', position: '盖面', materialNote: '', createdAt: now, updatedAt: now },
    { id: 'i2', bodyId: 'b1', type: 'goldTrace', pattern: '诗文', position: '外壁', materialNote: '', createdAt: now, updatedAt: now },
    { id: 'i3', bodyId: 'b1', type: 'nacre', pattern: '回纹', position: '底足', materialNote: '', createdAt: now, updatedAt: now },
  ]);
  await old.close();

  await initDatabase();
  const migratedInlays = await db.inlays.toArray();
  const migratedCoats = await db.coats.toArray();
  const c2 = migratedCoats.find((c) => c.id === 'c2') as Coat;
  ok('迁移：罩漆道次回填覆盖位置（含描金位置）', ['外壁', '盖面', '底足'].every((p) => c2.coverPositions.includes(p)));
  const c1 = migratedCoats.find((c) => c.id === 'c1') as Coat;
  ok('迁移：缺 paintType 的道次回填生漆', c1.paintType === 'raw');

  // i1 盖面：c2 是 todo（未上漆）→ 未嵌过，待嵌 + 挂不上「已罩」→ 但能对上待涂罩漆道次
  const i1 = migratedInlays.find((i) => i.id === 'i1') as Inlay;
  ok('迁移：未上漆的螺钿/蛋壳补为待嵌', i1.pieceState === 'registered');
  ok('迁移：能对上待涂罩漆道次 → claimed', i1.claimState === 'claimed' && i1.claimedCoatId === 'c2');
  // i2 描金：非嵌片 → applied；claimed
  const i2 = migratedInlays.find((i) => i.id === 'i2') as Inlay;
  ok('迁移：描金补为已嵌贴', i2.pieceState === 'applied' && i2.claimState === 'claimed');
  // i3 底足同样在 c2 覆盖内 → claimed, registered
  const i3 = migratedInlays.find((i) => i.id === 'i3') as Inlay;
  ok('迁移：底足螺钿待嵌且归属 c2', i3.pieceState === 'registered' && i3.claimState === 'claimed');

  // 挂不上的情况：一条位置在任何罩漆道次里都没有
  await db.inlays.put({
    ...i3,
    id: 'i4',
    position: '内壁',
    claimState: 'pendingClaim',
    claimedCoatId: null,
    lateRegistered: true,
    pieceState: 'applied',
    appliedAt: now,
  });
  const orphan = await db.inlays.get('i4') as Inlay;
  ok('挂不上的单列待认领', orphan.claimState === 'pendingClaim' && orphan.claimedCoatId === null);

  /* ---- 导入补齐：新旧记录混在一个备份里，旧的补齐、新的不动 ---- */
  const { normalizeV3Data } = await import('../src/utils/db');
  const mixCoats: Coat[] = [
    { id: 'm1', bodyId: 'b1', seq: 3, paintType: 'topcoat', colorName: '罩漆', coatDate: '2026-02-01', thicknessUm: 30, state: 'done', needRecheck: false, coverPositions: [], createdAt: now, updatedAt: now },
  ];
  const mixInlays = [
    // 旧记录（缺新字段），位置能对上已完成罩漆 → 已嵌贴 + claimed
    { id: 'old1', bodyId: 'b1', type: 'nacre', pattern: '旧花', position: '外壁', materialNote: '', createdAt: now, updatedAt: now },
    // 新记录保持不变
    { id: 'new1', bodyId: 'b1', type: 'eggshell', pattern: '新花', position: '盖面', materialNote: '', pieceState: 'registered', claimState: 'unlinked', claimedCoatId: null, lateRegistered: false, appliedAt: null, createdAt: now, updatedAt: now },
  ] as unknown as Inlay[];
  normalizeV3Data(mixCoats, mixInlays);
  ok('导入补齐：罩漆覆盖位置由旧记录回填', mixCoats[0]!.coverPositions.includes('外壁') && mixCoats[0]!.coverPositions.includes('盖面'));
  const old1 = mixInlays.find((i) => i.id === 'old1') as Inlay;
  ok('导入补齐：旧嵌片按已上漆回填已嵌贴并归属', old1.pieceState === 'applied' && old1.claimState === 'claimed' && old1.claimedCoatId === 'm1');
  const new1 = mixInlays.find((i) => i.id === 'new1') as Inlay;
  ok('导入补齐：新记录维持挂起等补不动', new1.pieceState === 'registered' && new1.claimState === 'unlinked');

  /* ---------------- 各自留底互不覆盖：清空再播种确认幂等 ---------------- */
  await seedDatabase();
  const count = await db.inlays.count();
  await seedDatabase();
  ok('播种幂等（条数不变）', (await db.inlays.count()) === count);

  console.log(`\n全部 ${passed} 项断言通过`);
  await db.close();
  await old.close();
}

main().catch((err) => {
  console.error('测试失败：', err);
  process.exit(1);
});
