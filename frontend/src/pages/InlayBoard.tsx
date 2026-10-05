/**
 * /inlays 镶嵌工位台账：纹饰登记 + 嵌片嵌贴 + 归属道次认领。
 * 本页只写工位自己那份（inlays）：
 * - 罩漆前按「胎体编号 + 位置」对工序台留底，螺钿/蛋壳没嵌完会挡住对应罩漆道次；
 * - 已罩过漆的位置事后补记 → 单列待认领，不退回罩漆那道；
 * - 对不上罩漆道次的先挂起等补。
 * 消费 Inlay（写）、Coat/Body（只读核对）；复用 <FilterBar>、<EmptyPanel>、<StatBadge>。
 */
import { useMemo, useState } from 'react';
import {
  App as AntdApp,
  Button,
  Card,
  Col,
  Form,
  Input,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CheckCircleOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  PlusOutlined,
  RollbackOutlined,
} from '@ant-design/icons';
import EmptyPanel from '@/components/common/EmptyPanel';
import FilterBar, { useFilterQuery, type FilterSelectConfig } from '@/components/common/FilterBar';
import StatBadge from '@/components/common/StatBadge';
import { useBodyStore } from '@/stores/bodyStore';
import { useCoatStore } from '@/stores/coatStore';
import { useInlayStore } from '@/stores/inlayStore';
import { BODY_SHAPE_LABEL } from '@/types/body';
import {
  INLAY_CLAIM_STATE_COLOR,
  INLAY_CLAIM_STATE_OPTIONS,
  INLAY_PATTERN_OPTIONS,
  INLAY_PIECE_STATE_COLOR,
  INLAY_PIECE_STATE_LABEL,
  INLAY_PIECE_STATE_OPTIONS,
  INLAY_POSITION_OPTIONS,
  INLAY_TYPE_COLOR,
  INLAY_TYPE_LABEL,
  INLAY_TYPE_OPTIONS,
  createEmptyInlayDraft,
  isGatedInlayType,
  type Inlay,
  type InlayDraft,
  type InlayType,
} from '@/types/inlay';
import { exportInlayLedgerCsv } from '@/utils/export';
import {
  INLAY_RECONCILE_COLOR,
  INLAY_RECONCILE_LABEL,
  claimCandidatesForInlay,
  reconcileInlay,
  type InlayReconcile,
} from '@/utils/reconcile';

const FILTER_KEYS = ['type', 'position', 'claimState'] as const;

const FILTER_SELECTS: ReadonlyArray<FilterSelectConfig> = [
  { key: 'type', label: '镶嵌类型', options: INLAY_TYPE_OPTIONS },
  { key: 'position', label: '位置', options: INLAY_POSITION_OPTIONS.map((item) => ({ value: item, label: item })) },
  { key: 'claimState', label: '归属核对', options: INLAY_CLAIM_STATE_OPTIONS },
];

/** 位置 → 器型示意区中的坐标（百分比） */
const POSITION_COORDS: Record<string, { left: string; top: string }> = {
  外壁: { left: '8%', top: '46%' },
  内壁: { left: '46%', top: '52%' },
  盖面: { left: '40%', top: '8%' },
  底足: { left: '40%', top: '82%' },
  口沿: { left: '58%', top: '30%' },
  通体: { left: '40%', top: '66%' },
};

interface InlayRow extends InlayReconcile {
  bodyCode: string;
  coatText: string;
}

export default function InlayBoard() {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<InlayDraft>();

  const inlays = useInlayStore((state) => state.inlays);
  const registerInlay = useInlayStore((state) => state.registerInlay);
  const updateInlay = useInlayStore((state) => state.updateInlay);
  const removeInlay = useInlayStore((state) => state.removeInlay);
  const markApplied = useInlayStore((state) => state.markApplied);
  const markRegistered = useInlayStore((state) => state.markRegistered);
  const claimInlay = useInlayStore((state) => state.claimInlay);
  const bulkPutInlays = useInlayStore((state) => state.bulkPutInlays);

  const bodies = useBodyStore((state) => state.bodies);
  const currentBodyId = useBodyStore((state) => state.currentBodyId);
  const setCurrentBodyId = useBodyStore((state) => state.setCurrentBodyId);
  const coats = useCoatStore((state) => state.coats);

  const url = useFilterQuery(FILTER_KEYS);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Inlay | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [batchType, setBatchType] = useState<InlayType>('nacre');
  const [claiming, setClaiming] = useState<Inlay | null>(null);
  const [claimCoatId, setClaimCoatId] = useState<string | undefined>(undefined);

  const activeBody = bodies.find((body) => body.id === currentBodyId) ?? bodies[0] ?? null;
  const bodyId = activeBody?.id ?? '';

  const bodyCode = (id: string): string => bodies.find((body) => body.id === id)?.code ?? id;
  const coatTextOf = (id: string | null): string => {
    if (!id) return '';
    const coat = coats.find((item) => item.id === id);
    return coat ? `第 ${coat.seq} 道·罩漆` : '道次已删';
  };

  const rows = useMemo<InlayRow[]>(
    () =>
      inlays.map((inlay) => ({
        ...reconcileInlay(inlay, coats),
        bodyCode: bodyCode(inlay.bodyId),
        coatText: coatTextOf(inlay.claimedCoatId),
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [inlays, coats, bodies],
  );

  const filtered = useMemo(() => {
    const keyword = url.keyword.trim();
    const types = url.values.type ?? [];
    const positions = url.values.position ?? [];
    const claimStates = url.values.claimState ?? [];
    return rows.filter((row) => {
      if (keyword.length > 0) {
        const haystack = `${row.inlay.pattern}${row.inlay.materialNote}${row.inlay.position}${row.bodyCode}`;
        if (!haystack.includes(keyword)) return false;
      }
      if (types.length > 0 && !types.includes(row.inlay.type)) return false;
      if (positions.length > 0 && !positions.includes(row.inlay.position)) return false;
      if (claimStates.length > 0 && !claimStates.includes(row.inlay.claimState)) return false;
      return true;
    });
  }, [rows, url.keyword, url.values]);

  const bodyRows = useMemo(() => filtered.filter((row) => row.inlay.bodyId === bodyId), [filtered, bodyId]);

  /** 全库口径的待办计数（不只当前胎体） */
  const waitingCount = useMemo(
    () => inlays.filter((inlay) => isGatedInlayType(inlay.type) && inlay.pieceState === 'registered').length,
    [inlays],
  );
  const unlinkedCount = useMemo(() => inlays.filter((inlay) => inlay.claimState === 'unlinked').length, [inlays]);
  const pendingClaimCount = useMemo(
    () => inlays.filter((inlay) => inlay.claimState === 'pendingClaim').length,
    [inlays],
  );
  /** 待认领单列：罩漆后补记、还没认领到道次的条目 */
  const pendingClaimRows = useMemo(
    () => rows.filter((row) => row.inlay.claimState === 'pendingClaim'),
    [rows],
  );

  const openCreate = (): void => {
    if (!bodyId) {
      message.warning('请先登记胎体');
      return;
    }
    setEditing(null);
    form.setFieldsValue(createEmptyInlayDraft(bodyId));
    setOpen(true);
  };

  const openEdit = (row: Inlay): void => {
    setEditing(row);
    form.setFieldsValue({
      bodyId: row.bodyId,
      type: row.type,
      pattern: row.pattern,
      position: row.position,
      materialNote: row.materialNote,
      pieceState: row.pieceState,
    });
    setOpen(true);
  };

  const submit = async (): Promise<void> => {
    const values = await form.validateFields();
    if (editing) {
      const result = await updateInlay(editing.id, values);
      result.ok ? message.success(result.message) : message.error(result.message);
    } else {
      const result = await registerInlay(values, coats);
      result.ok ? message.success(result.message) : message.error(result.message);
    }
    setOpen(false);
  };

  const openClaim = (row: Inlay): void => {
    const candidates = claimCandidatesForInlay(row, coats);
    setClaiming(row);
    setClaimCoatId(candidates[0]?.id ?? undefined);
  };

  const submitClaim = async (): Promise<void> => {
    if (!claiming || !claimCoatId) {
      message.warning('请选择要归属的罩漆道次');
      return;
    }
    const result = await claimInlay(claiming.id, claimCoatId);
    result.ok ? message.success(result.message) : message.error(result.message);
    setClaiming(null);
  };

  const columns: ColumnsType<InlayRow> = [
    {
      title: '类型',
      dataIndex: ['inlay', 'type'],
      width: 100,
      render: (_value, record) => <Tag color={INLAY_TYPE_COLOR[record.inlay.type]}>{INLAY_TYPE_LABEL[record.inlay.type]}</Tag>,
    },
    { title: '图案', width: 120, render: (_v, record) => record.inlay.pattern },
    {
      title: '位置',
      width: 90,
      render: (_v, record) => <Tag>{record.inlay.position}</Tag>,
    },
    {
      title: '嵌片嵌贴',
      width: 100,
      render: (_v, record) => (
        <Tag color={INLAY_PIECE_STATE_COLOR[record.inlay.pieceState]}>
          {INLAY_PIECE_STATE_LABEL[record.inlay.pieceState]}
        </Tag>
      ),
    },
    {
      title: '两摊核对',
      width: 110,
      render: (_v, record) => (
        <Tooltip title={record.coat ? `对上 ${bodyCode(record.inlay.bodyId)} ${record.coatText}` : '按胎体编号 + 位置核对'}>
          <Tag color={INLAY_RECONCILE_COLOR[record.status]}>{INLAY_RECONCILE_LABEL[record.status]}</Tag>
        </Tooltip>
      ),
    },
    {
      title: '归属道次',
      width: 120,
      render: (_v, record) =>
        record.inlay.claimedCoatId ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {record.coatText}
          </Typography.Text>
        ) : (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            —
          </Typography.Text>
        ),
    },
    {
      title: '胎体',
      width: 100,
      render: (_v, record) => record.bodyCode,
    },
    {
      title: '操作',
      key: 'action',
      width: 250,
      render: (_value, record) => {
        const inlay = record.inlay;
        const gated = isGatedInlayType(inlay.type);
        return (
          <Space size={2} wrap>
            {gated && inlay.pieceState === 'registered' ? (
              <Button
                size="small"
                type="link"
                icon={<CheckCircleOutlined />}
                onClick={() => void markApplied(inlay.id).then((r) => (r.ok ? message.success(r.message) : message.error(r.message)))}
              >
                记已嵌贴
              </Button>
            ) : null}
            {gated && inlay.pieceState === 'applied' ? (
              <Button
                size="small"
                type="link"
                icon={<RollbackOutlined />}
                onClick={() => void markRegistered(inlay.id).then((r) => (r.ok ? message.success(r.message) : message.error(r.message)))}
              >
                退回待嵌
              </Button>
            ) : null}
            {inlay.claimState === 'pendingClaim' ? (
              <Button size="small" type="link" onClick={() => openClaim(inlay)}>
                归属认领
              </Button>
            ) : null}
            <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEdit(inlay)}>
              编辑
            </Button>
            <Popconfirm
              title="删除该镶嵌记录（只删工位这份）"
              okText="确认"
              cancelText="取消"
              onConfirm={() => void removeInlay(inlay.id).then((r) => (r.ok ? message.success(r.message) : message.error(r.message)))}
            >
              <Button size="small" type="link" danger icon={<DeleteOutlined />}>
                删除
              </Button>
            </Popconfirm>
          </Space>
        );
      },
    },
  ];

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <h2>镶嵌工位台账</h2>
          <p>
            工位管纹饰登记与嵌片嵌贴，独立留底；罩漆前工序台按胎体编号 + 位置对这份，没嵌完那道停在待嵌。
            已罩过漆才补记的，单列待认领，不退回罩漆那道。
          </p>
        </div>
        <Space wrap>
          <Select
            style={{ minWidth: 200 }}
            placeholder="选择胎体"
            value={bodyId || undefined}
            options={bodies.map((body) => ({
              value: body.id,
              label: `${body.code} · ${BODY_SHAPE_LABEL[body.shape]}`,
            }))}
            onChange={(value: string) => setCurrentBodyId(value)}
          />
          <Button
            icon={<DownloadOutlined />}
            onClick={() => {
              const filename = exportInlayLedgerCsv(bodies, inlays, coats);
              message.success(`已导出工位留底 ${filename}`);
            }}
          >
            导出工位台账
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            新增镶嵌
          </Button>
        </Space>
      </div>

      <div className="gb-stat-row">
        <StatBadge label="镶嵌登记" value={inlays.length} suffix="条" tone="primary" />
        <StatBadge label="待嵌（挡罩漆）" value={waitingCount} suffix="片" tone="warning" />
        <StatBadge label="挂起等补" value={unlinkedCount} suffix="条" tone="info" />
        <StatBadge label="待认领（罩后补记）" value={pendingClaimCount} suffix="条" tone="danger" />
        <StatBadge
          label="已归属"
          value={inlays.filter((inlay) => inlay.claimState === 'claimed').length}
          suffix="条"
          tone="success"
        />
      </div>

      {pendingClaimRows.length > 0 ? (
        <Card
          size="small"
          style={{ marginBottom: 14, borderColor: 'rgba(140,47,31,0.35)' }}
          title={<Typography.Text strong>待认领 · 罩漆后补记（不退回罩漆那道，仅工位这份补归属）</Typography.Text>}
        >
          <Space wrap>
            {pendingClaimRows.map((row) => (
              <Tag
                key={row.inlay.id}
                color={INLAY_CLAIM_STATE_COLOR.pendingClaim}
                style={{ padding: '4px 8px', display: 'inline-flex', alignItems: 'center', gap: 6 }}
              >
                {row.bodyCode} · {row.inlay.position} · {INLAY_TYPE_LABEL[row.inlay.type]}·{row.inlay.pattern}
                <Button size="small" type="link" style={{ padding: 0, height: 18 }} onClick={() => openClaim(row.inlay)}>
                  归属认领
                </Button>
              </Tag>
            ))}
          </Space>
        </Card>
      ) : null}

      <FilterBar
        keyword={url.keyword}
        onKeywordChange={url.setKeyword}
        selects={FILTER_SELECTS}
        values={url.values}
        onValuesChange={url.setValues}
        onReset={url.reset}
        keywordPlaceholder="搜索图案 / 位置 / 胎体编号…"
        actions={
          <Space size={6} wrap>
            <Select
              size="small"
              style={{ width: 120 }}
              value={batchType}
              options={[...INLAY_TYPE_OPTIONS]}
              onChange={(value: InlayType) => setBatchType(value)}
            />
            <Button
              size="small"
              disabled={selectedIds.length === 0}
              onClick={() => {
                const now = Date.now();
                const rows = inlays
                  .filter((row) => selectedIds.includes(row.id))
                  .map((row) => ({ ...row, type: batchType, updatedAt: now }));
                void bulkPutInlays(rows).then((r) => {
                  if (r.ok) {
                    message.success(`已批量改为${INLAY_TYPE_LABEL[batchType]}`);
                    setSelectedIds([]);
                  } else {
                    message.error(r.message);
                  }
                });
              }}
            >
              批量调整分类
            </Button>
          </Space>
        }
      />

      <Row gutter={16} style={{ marginTop: 16 }}>
        <Col xs={24} lg={8}>
          <Card title={`器型示意 · ${activeBody ? activeBody.code : '未选择'}`} size="small">
            <div className="gb-vessel">
              <div className={`gb-vessel__shape is-${activeBody?.shape ?? 'bowl'}`} />
              {bodyRows.map((row, index) => {
                const coord = POSITION_COORDS[row.inlay.position] ?? { left: '30%', top: `${20 + index * 12}%` };
                const applied = row.inlay.pieceState === 'applied';
                return (
                  <span
                    key={row.inlay.id}
                    className="gb-vessel__mark"
                    style={{
                      left: coord.left,
                      top: coord.top,
                      color: INLAY_TYPE_COLOR[row.inlay.type],
                      opacity: applied ? 1 : 0.55,
                      textDecoration: applied ? 'none' : 'underline dashed',
                    }}
                  >
                    {INLAY_TYPE_LABEL[row.inlay.type]}·{row.inlay.pattern}
                    {applied ? '' : '（待嵌）'}
                  </span>
                );
              })}
            </div>
            <div className="gb-vessel__legend">
              {bodyRows.length === 0 ? (
                <Typography.Text type="secondary">该胎体暂无镶嵌纹饰</Typography.Text>
              ) : (
                bodyRows.map((row) => (
                  <Tag key={row.inlay.id} color={INLAY_RECONCILE_COLOR[row.status]}>
                    {row.inlay.position} · {INLAY_TYPE_LABEL[row.inlay.type]} · {INLAY_RECONCILE_LABEL[row.status]}
                  </Tag>
                ))
              )}
            </div>
          </Card>
        </Col>
        <Col xs={24} lg={16}>
          <Card className="gb-table-card" styles={{ body: { padding: 0 } }}>
            {filtered.length === 0 ? (
              <EmptyPanel
                title={inlays.length === 0 ? '还没有镶嵌登记' : '当前条件下没有记录'}
                description={
                  inlays.length === 0
                    ? '登记第一处螺钿或蛋壳纹饰；罩漆前记得把嵌片状态推进到「已嵌贴」。'
                    : '试着调整类型、位置或归属核对筛选。'
                }
                actionText="新增镶嵌"
                onAction={openCreate}
                secondaryText="重置筛选"
                onSecondary={url.reset}
                size="small"
              />
            ) : (
              <Table<InlayRow>
                rowKey={(record) => record.inlay.id}
                size="small"
                pagination={{ pageSize: 8 }}
                columns={columns}
                dataSource={filtered}
                rowSelection={{
                  selectedRowKeys: selectedIds,
                  onChange: (keys) => setSelectedIds(keys.map((key) => String(key))),
                }}
              />
            )}
          </Card>
        </Col>
      </Row>

      <Modal
        open={open}
        title={editing ? '编辑镶嵌登记（工位留底）' : '新增镶嵌登记（工位留底）'}
        onCancel={() => setOpen(false)}
        onOk={() => void submit()}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="bodyId" label="所属胎体" rules={[{ required: true }]}>
            <Select
              options={bodies.map((body) => ({
                value: body.id,
                label: `${body.code} · ${BODY_SHAPE_LABEL[body.shape]}`,
              }))}
            />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="type" label="镶嵌类型" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Select options={[...INLAY_TYPE_OPTIONS]} />
            </Form.Item>
            <Form.Item name="position" label="位置" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Select options={INLAY_POSITION_OPTIONS.map((item) => ({ value: item, label: item }))} />
            </Form.Item>
          </Space>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="pattern" label="图案" rules={[{ required: true, message: '请填写图案名' }]} style={{ flex: 1 }}>
              <Select
                showSearch
                placeholder="如：缠枝莲"
                options={INLAY_PATTERN_OPTIONS.map((item) => ({ value: item, label: item }))}
              />
            </Form.Item>
            <Form.Item
              name="pieceState"
              label="嵌片嵌贴"
              tooltip="螺钿/蛋壳罩漆前必须为「已嵌贴」；描金/戗金非嵌片工序"
              style={{ flex: 1 }}
            >
              <Select options={[...INLAY_PIECE_STATE_OPTIONS]} />
            </Form.Item>
          </Space>
          <Form.Item name="materialNote" label="材料与工艺备注">
            <Input.TextArea rows={3} placeholder="如：0.8mm 螺钿片，刻纹嵌贴后磨显" />
          </Form.Item>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            归属道次由两摊按「胎体编号 + 位置」核对自动挂接；若该位置已罩过漆，保存后进入待认领，不退回罩漆那道。
          </Typography.Text>
        </Form>
      </Modal>

      <Modal
        open={claiming !== null}
        title="归属认领（只补工位这份，工序台留底不动）"
        onCancel={() => setClaiming(null)}
        onOk={() => void submitClaim()}
        okText="确认认领"
        cancelText="取消"
        destroyOnClose
      >
        {claiming ? (
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            <Typography.Text>
              {bodyCode(claiming.bodyId)} · {claiming.position} · {INLAY_TYPE_LABEL[claiming.type]}·{claiming.pattern}
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              该位置罩漆已过，补记的嵌片不退回罩漆道次；请认领当时罩住该位置的罩漆道次：
            </Typography.Text>
            <Select
              style={{ width: '100%' }}
              value={claimCoatId}
              onChange={(value: string) => setClaimCoatId(value)}
              options={claimCandidatesForInlay(claiming, coats).map((coat) => ({
                value: coat.id,
                label: `${bodyCode(claiming.bodyId)} 第 ${coat.seq} 道 · 罩漆 · ${coat.colorName}（${coat.coatDate}）`,
              }))}
              placeholder="选择罩漆道次"
            />
          </Space>
        ) : null}
      </Modal>
    </div>
  );
}
