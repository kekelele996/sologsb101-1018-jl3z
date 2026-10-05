/**
 * /inlays 镶嵌纹饰登记（镶嵌工位自留底）
 * 两摊分开：本页只写工位这份（纹饰登记 + 嵌片嵌贴 + 归属道次 + 认领），
 * 不改髹涂工序台的 coats 那份；罩漆位置与罩漆道次只读核对。
 * - 按 胎体编号 + 位置 与工序台核对：没嵌完 → 那边罩漆道次停在「待嵌」；对不上 → 工位挂起等补
 * - 已罩漆位置事后补记 → 单列「待认领」，不退回罩漆道次
 * 消费 Inlay、Body、只读 Coat；复用 <FilterBar>、<EmptyPanel>、<StatBadge>。
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
import { CheckCircleOutlined, DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import EmptyPanel from '@/components/common/EmptyPanel';
import FilterBar, { useFilterQuery, type FilterSelectConfig } from '@/components/common/FilterBar';
import StatBadge from '@/components/common/StatBadge';
import { useIdbTable } from '@/hooks/useIdbTable';
import { useBodyStore } from '@/stores/bodyStore';
import { useCoatStore } from '@/stores/coatStore';
import { BODY_SHAPE_LABEL } from '@/types/body';
import {
  INLAY_AFFIX_COLOR,
  INLAY_AFFIX_LABEL,
  INLAY_AFFIX_OPTIONS,
  INLAY_CLAIM_OPTIONS,
  INLAY_PATTERN_OPTIONS,
  INLAY_POSITION_OPTIONS,
  INLAY_TYPE_COLOR,
  INLAY_TYPE_LABEL,
  INLAY_TYPE_OPTIONS,
  createEmptyInlayDraft,
  type Inlay,
  type InlayAffixState,
  type InlayDraft,
  type InlayType,
} from '@/types/inlay';
import {
  classifyInlayRow,
  isPositionTopcoated,
  plannedTopcoatSeq,
  INLAY_ROW_STATUS_LABEL,
  type InlayRowStatus,
} from '@/utils/inlayGate';
import { retryOwnWrite } from '@/utils/retry';

const FILTER_KEYS = ['type', 'position', 'affixState', 'claimState'] as const;

const FILTER_SELECTS: ReadonlyArray<FilterSelectConfig> = [
  { key: 'type', label: '镶嵌类型', options: INLAY_TYPE_OPTIONS },
  { key: 'position', label: '位置', options: INLAY_POSITION_OPTIONS.map((item) => ({ value: item, label: item })) },
  { key: 'affixState', label: '嵌贴', options: INLAY_AFFIX_OPTIONS },
  { key: 'claimState', label: '认领', options: INLAY_CLAIM_OPTIONS.map((item) => ({ value: item.value, label: item.label })) },
];

const STATUS_COLOR: Record<InlayRowStatus, string> = {
  pendingAffix: '#c9963c',
  ready: '#2f6f4f',
  unclaimed: '#8c2f1f',
  hanging: '#b5651d',
};

/** 位置 → 器型示意区中的坐标（百分比） */
const POSITION_COORDS: Record<string, { left: string; top: string }> = {
  外壁: { left: '8%', top: '46%' },
  内壁: { left: '46%', top: '52%' },
  盖面: { left: '40%', top: '8%' },
  底足: { left: '40%', top: '82%' },
  口沿: { left: '58%', top: '30%' },
  通体: { left: '40%', top: '66%' },
};

export default function InlayBoard() {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<InlayDraft>();
  const inlayTable = useIdbTable<Inlay>((database) => database.inlays, { sortByUpdatedAt: false });

  const bodies = useBodyStore((state) => state.bodies);
  const currentBodyId = useBodyStore((state) => state.currentBodyId);
  const setCurrentBodyId = useBodyStore((state) => state.setCurrentBodyId);
  // 工序台那份只读，用于按 胎体编号 + 位置 核对；本页不改写它
  const coats = useCoatStore((state) => state.coats);

  const url = useFilterQuery(FILTER_KEYS);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Inlay | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [batchType, setBatchType] = useState<InlayType>('nacre');

  const activeBody = bodies.find((body) => body.id === currentBodyId) ?? bodies[0] ?? null;
  const bodyId = activeBody?.id ?? '';

  const filtered = useMemo(() => {
    const keyword = url.keyword.trim();
    const types = url.values.type ?? [];
    const positions = url.values.position ?? [];
    const affixStates = url.values.affixState ?? [];
    const claimStates = url.values.claimState ?? [];
    return inlayTable.rows.filter((row) => {
      if (keyword.length > 0) {
        const haystack = `${row.pattern}${row.materialNote}${row.position}`;
        if (!haystack.includes(keyword)) return false;
      }
      if (types.length > 0 && !types.includes(row.type)) return false;
      if (positions.length > 0 && !positions.includes(row.position)) return false;
      if (affixStates.length > 0 && !affixStates.includes(row.affixState)) return false;
      if (claimStates.length > 0 && !claimStates.includes(row.claimState)) return false;
      return true;
    });
  }, [inlayTable.rows, url.keyword, url.values]);

  const bodyInlays = useMemo(() => filtered.filter((row) => row.bodyId === bodyId), [filtered, bodyId]);

  /** 当前胎体的罩漆道次（归属道次候选） */
  const bodyTopcoats = useMemo(
    () => coats.filter((coat) => coat.bodyId === bodyId && coat.paintType === 'topcoat').sort((a, b) => a.seq - b.seq),
    [coats, bodyId],
  );

  /** 逐条与工序台核对出的工位状态 */
  const statusOf = (row: Inlay): InlayRowStatus => classifyInlayRow(row, coats);

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
      affixState: row.affixState,
      affixSeq: row.affixSeq,
      claimState: row.claimState,
    });
    setOpen(true);
  };

  /**
   * 工位保存（只写 inlays 这份）：
   * - 归属道次按同胎体 + 位置的第一道罩漆道次补出；挂不上为 null
   * - 位置已罩过漆才补记 → 单列待认领（affixSeq 清空），不退回罩漆那道
   */
  const submit = async (): Promise<void> => {
    const values = await form.validateFields();
    const topcoated = isPositionTopcoated(coats, values.bodyId, values.position);
    const payload: InlayDraft = {
      ...values,
      affixSeq: topcoated ? null : (values.affixSeq ?? plannedTopcoatSeq(coats, values.bodyId, values.position)),
      claimState: topcoated ? 'unclaimed' : values.claimState,
      affixedAt:
        values.affixState === 'affixed'
          ? editing?.affixedAt ?? Date.now()
          : null,
    };
    try {
      if (editing) {
        await retryOwnWrite(() => inlayTable.update(editing.id, payload), '工位镶嵌留底');
        message.success('已更新镶嵌登记（仅工位这份留底）');
      } else {
        await retryOwnWrite(() => inlayTable.create(payload, 'inlay'), '工位镶嵌留底');
        message.success(topcoated ? '该位置已罩过漆，已单列为待认领，不退回罩漆道次' : '已新增镶嵌登记');
      }
      setOpen(false);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '工位留底写入失败');
    }
  };

  /** 嵌片嵌贴到位：只更新工位自己这份 */
  const markAffixed = async (row: Inlay): Promise<void> => {
    try {
      await retryOwnWrite(
        () => inlayTable.update(row.id, { affixState: 'affixed', affixedAt: Date.now() }),
        '工位镶嵌留底',
      );
      message.success(`已登记嵌贴到位：${row.position} · ${row.pattern}`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '工位留底写入失败');
    }
  };

  const columns: ColumnsType<Inlay> = [
    {
      title: '类型',
      dataIndex: 'type',
      width: 100,
      filters: INLAY_TYPE_OPTIONS.map((item) => ({ text: item.label, value: item.value })),
      onFilter: (value, record) => record.type === value,
      render: (value: InlayType) => <Tag color={INLAY_TYPE_COLOR[value]}>{INLAY_TYPE_LABEL[value]}</Tag>,
    },
    { title: '图案', dataIndex: 'pattern', width: 120 },
    { title: '位置', dataIndex: 'position', width: 90, render: (value: string) => <Tag>{value}</Tag> },
    {
      title: '嵌贴',
      dataIndex: 'affixState',
      width: 90,
      render: (value: InlayAffixState) => (
        <Tag color={INLAY_AFFIX_COLOR[value]}>{INLAY_AFFIX_LABEL[value]}</Tag>
      ),
    },
    {
      title: '归属道次',
      dataIndex: 'affixSeq',
      width: 90,
      render: (seq: number | null) => (seq === null ? <Typography.Text type="secondary">挂不上</Typography.Text> : `第 ${seq} 道`),
    },
    {
      title: '与工序台核对',
      key: 'reconcile',
      width: 110,
      render: (_value, record) => {
        const status = statusOf(record);
        return (
          <Tooltip
            title={
              status === 'hanging'
                ? '工序台没有罩漆道次覆盖该位置，先挂起等补'
                : status === 'unclaimed'
                  ? '该位置已罩漆后才补记，工位单列为待认领，不退回罩漆道次'
                  : status === 'pendingAffix'
                    ? '嵌片未嵌完，工序台罩漆前该道会停在待嵌'
                    : '已对上工序台罩漆位置'
            }
          >
            <Tag color={STATUS_COLOR[status]}>{INLAY_ROW_STATUS_LABEL[status]}</Tag>
          </Tooltip>
        );
      },
    },
    {
      title: '所属胎体',
      dataIndex: 'bodyId',
      width: 120,
      render: (value: string) => bodies.find((body) => body.id === value)?.code ?? value,
    },
    {
      title: '材料与工艺',
      dataIndex: 'materialNote',
      render: (value: string) => (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {value || '未填写'}
        </Typography.Text>
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 200,
      render: (_value, record) => (
        <Space size={4}>
          {record.affixState === 'pending' ? (
            <Button size="small" type="link" icon={<CheckCircleOutlined />} onClick={() => void markAffixed(record)}>
              嵌片嵌贴
            </Button>
          ) : null}
          <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEdit(record)}>
            编辑
          </Button>
          <Popconfirm
            title="删除该镶嵌记录"
            okText="确认"
            cancelText="取消"
            onConfirm={() =>
              void retryOwnWrite(() => inlayTable.remove(record.id), '工位镶嵌留底')
                .then(() => message.success('已删除（仅工位这份）'))
                .catch((error: unknown) => message.error(error instanceof Error ? error.message : '删除失败'))
            }
          >
            <Button size="small" type="link" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const stats = useMemo(() => {
    const result: Record<string, number> = { pendingAffix: 0, ready: 0, unclaimed: 0, hanging: 0 };
    inlayTable.rows.forEach((row) => {
      result[classifyInlayRow(row, coats)] += 1;
    });
    return result;
  }, [inlayTable.rows, coats]);

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <h2>镶嵌纹饰登记（镶嵌工位）</h2>
          <p>
            工位这份只管纹饰登记与嵌片嵌贴；罩漆前工序台按「胎体编号 + 位置」对这里的嵌贴，没嵌完那道停在待嵌，对不上先挂起等补；已罩漆后补记单列待认领。
          </p>
        </div>
        <Space wrap>
          <Select
            style={{ minWidth: 220 }}
            placeholder="选择胎体"
            value={bodyId || undefined}
            options={bodies.map((body) => ({
              value: body.id,
              label: `${body.code} · ${BODY_SHAPE_LABEL[body.shape]}`,
            }))}
            onChange={(value: string) => setCurrentBodyId(value)}
          />
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            新增镶嵌
          </Button>
        </Space>
      </div>

      <div className="gb-stat-row">
        <StatBadge label="镶嵌总数" value={inlayTable.rows.length} suffix="条" tone="primary" />
        <StatBadge label="待嵌" value={stats.pendingAffix} suffix="条" tone="warning" />
        <StatBadge label="已对上" value={stats.ready} suffix="条" tone="success" />
        <StatBadge label="挂起等补" value={stats.hanging} suffix="条" tone="info" />
        <StatBadge label="待认领" value={stats.unclaimed} suffix="条" tone="danger" />
      </div>

      <FilterBar
        keyword={url.keyword}
        onKeywordChange={url.setKeyword}
        selects={FILTER_SELECTS}
        values={url.values}
        onValuesChange={url.setValues}
        onReset={url.reset}
        keywordPlaceholder="搜索图案 / 材料备注…"
        actions={
          <Space size={6} wrap>
            <Select
              size="small"
              style={{ width: 130 }}
              value={batchType}
              options={[...INLAY_TYPE_OPTIONS]}
              onChange={(value: InlayType) => setBatchType(value)}
            />
            <Button
              size="small"
              disabled={selectedIds.length === 0}
              onClick={() => {
                const now = Date.now();
                const rows = inlayTable.rows
                  .filter((row) => selectedIds.includes(row.id))
                  .map((row) => ({ ...row, type: batchType, updatedAt: now }));
                void retryOwnWrite(() => inlayTable.bulkPut(rows), '工位镶嵌留底')
                  .then(() => {
                    message.success(`已批量改为${INLAY_TYPE_LABEL[batchType]}`);
                    setSelectedIds([]);
                  })
                  .catch((error: unknown) => message.error(error instanceof Error ? error.message : '批量写入失败'));
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
              {bodyInlays.map((row, index) => {
                const coord = POSITION_COORDS[row.position] ?? { left: '30%', top: `${20 + index * 12}%` };
                const status = statusOf(row);
                return (
                  <span
                    key={row.id}
                    className={`gb-vessel__mark ${status === 'pendingAffix' ? 'is-pending' : ''} ${
                      status === 'unclaimed' || status === 'hanging' ? 'is-flagged' : ''
                    }`}
                    style={{ left: coord.left, top: coord.top, color: INLAY_TYPE_COLOR[row.type] }}
                  >
                    {INLAY_TYPE_LABEL[row.type]}·{row.pattern}·{INLAY_ROW_STATUS_LABEL[status]}
                  </span>
                );
              })}
            </div>
            <div className="gb-vessel__legend">
              {bodyInlays.length === 0 ? (
                <Typography.Text type="secondary">该胎体暂无镶嵌纹饰</Typography.Text>
              ) : (
                bodyInlays.map((row) => {
                  const status = statusOf(row);
                  return (
                    <Tag key={row.id} color={INLAY_TYPE_COLOR[row.type]}>
                      {row.position} · {INLAY_TYPE_LABEL[row.type]} · {INLAY_ROW_STATUS_LABEL[status]}
                    </Tag>
                  );
                })
              )}
            </div>
            {bodyTopcoats.length > 0 ? (
              <Typography.Text type="secondary" style={{ display: 'block', marginTop: 8, fontSize: 12 }}>
                工序台罩漆道次：
                {bodyTopcoats.map((coat) => `第${coat.seq}道(${coat.coverPositions.join('/') || '未登记位置'})`).join('，')}
              </Typography.Text>
            ) : (
              <Typography.Text type="secondary" style={{ display: 'block', marginTop: 8, fontSize: 12 }}>
                工序台尚无罩漆道次，归属道次暂时挂不上，先挂起等补。
              </Typography.Text>
            )}
          </Card>
        </Col>
        <Col xs={24} lg={16}>
          <Card className="gb-table-card" styles={{ body: { padding: 0 } }}>
            {filtered.length === 0 ? (
              <EmptyPanel
                title={inlayTable.rows.length === 0 ? '还没有镶嵌登记' : '当前条件下没有记录'}
                description={
                  inlayTable.rows.length === 0
                    ? '登记第一处螺钿或蛋壳纹饰，填写图案、位置与嵌贴状态；归属道次按位置自动对工序台。'
                    : '试着调整类型、位置或认领筛选。'
                }
                actionText="新增镶嵌"
                onAction={openCreate}
                secondaryText="重置筛选"
                onSecondary={url.reset}
                size="small"
              />
            ) : (
              <Table<Inlay>
                rowKey="id"
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
        title={editing ? '编辑镶嵌登记' : '新增镶嵌登记'}
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
          <Form.Item name="pattern" label="图案" rules={[{ required: true, message: '请填写图案名' }]}>
            <Select
              showSearch
              placeholder="如：缠枝莲"
              options={INLAY_PATTERN_OPTIONS.map((item) => ({ value: item, label: item }))}
            />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="affixState" label="嵌片嵌贴" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Select options={[...INLAY_AFFIX_OPTIONS]} />
            </Form.Item>
            <Form.Item name="affixSeq" label="归属道次" style={{ flex: 1 }}>
              <Select
                allowClear
                placeholder="挂不上则留空"
                options={bodyTopcoats.map((coat) => ({
                  value: coat.seq,
                  label: `第 ${coat.seq} 道罩漆 · ${coat.coverPositions.join('/') || '位置未登记'}`,
                }))}
              />
            </Form.Item>
          </Space>
          <Form.Item name="claimState" label="认领状态" rules={[{ required: true }]}>
            <Select options={INLAY_CLAIM_OPTIONS.map((item) => ({ value: item.value, label: item.label }))} />
          </Form.Item>
          <Form.Item name="materialNote" label="材料与工艺备注">
            <Input.TextArea rows={3} placeholder="如：0.8mm 螺钿片，刻纹嵌贴后磨显" />
          </Form.Item>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            归属道次按同胎体 + 位置的第一道罩漆道次自动补；位置已罩过漆再补记会单列为待认领，不退回罩漆那道。
          </Typography.Text>
        </Form>
      </Modal>
    </div>
  );
}
