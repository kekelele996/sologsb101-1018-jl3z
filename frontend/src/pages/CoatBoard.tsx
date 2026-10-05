/**
 * /coats 髹涂道次编排
 * 拖拽调整道次先后、批量改漆种与状态、同器型自动带出上次漆种与间隔建议。
 * 消费 Coat、Body；复用 <StageTag>、<FilterBar>、<StatBadge>、<EmptyPanel>。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  DeleteOutlined,
  EditOutlined,
  HolderOutlined,
  PlusOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import EmptyPanel from '@/components/common/EmptyPanel';
import FilterBar, { useFilterQuery, type FilterSelectConfig } from '@/components/common/FilterBar';
import StatBadge from '@/components/common/StatBadge';
import StageTag from '@/components/common/StageTag';
import { useCoatProgress } from '@/hooks/useCoatProgress';
import { useBodyStore } from '@/stores/bodyStore';
import { useCoatStore } from '@/stores/coatStore';
import { useInlayStore } from '@/stores/inlayStore';
import {
  COAT_STATE_LABEL,
  COAT_STATE_OPTIONS,
  COLOR_NAME_OPTIONS,
  PAINT_TYPE_LABEL,
  PAINT_TYPE_OPTIONS,
  createEmptyCoatDraft,
  type Coat,
  type CoatDraft,
  type CoatState,
  type PaintType,
} from '@/types/coat';
import { BODY_SHAPE_LABEL } from '@/types/body';
import { INLAY_POSITION_OPTIONS, INLAY_TYPE_COLOR, INLAY_TYPE_LABEL } from '@/types/inlay';
import { evaluateBodyTopcoats } from '@/utils/reconcile';
import { suggestIntervalHours } from '@/utils/humidity';

const FILTER_KEYS = ['paintType', 'state'] as const;

const FILTER_SELECTS: ReadonlyArray<FilterSelectConfig> = [
  { key: 'paintType', label: '漆种', options: PAINT_TYPE_OPTIONS },
  { key: 'state', label: '状态', options: COAT_STATE_OPTIONS },
];

export default function CoatBoard() {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<CoatDraft>();

  const bodies = useBodyStore((state) => state.bodies);
  const currentBodyId = useBodyStore((state) => state.currentBodyId);
  const setCurrentBodyId = useBodyStore((state) => state.setCurrentBodyId);
  const coats = useCoatStore((state) => state.coats);
  const createCoat = useCoatStore((state) => state.createCoat);
  const updateCoat = useCoatStore((state) => state.updateCoat);
  const removeCoat = useCoatStore((state) => state.removeCoat);
  const batchUpdate = useCoatStore((state) => state.batchUpdate);
  const advanceState = useCoatStore((state) => state.advanceState);
  const reorderCoats = useCoatStore((state) => state.reorderCoats);
  const nextSeq = useCoatStore((state) => state.nextSeq);
  const suggestForBody = useCoatStore((state) => state.suggestForBody);
  const topcoatGateCheck = useCoatStore((state) => state.topcoatGateCheck);
  const resumeFromAwaitInlay = useCoatStore((state) => state.resumeFromAwaitInlay);

  // 工位那份留底只读：工序台不改 inlays，罩漆前按位置核对
  const inlays = useInlayStore((state) => state.inlays);

  const { progressOf, currentCoatText, totals } = useCoatProgress();
  const url = useFilterQuery(FILTER_KEYS);

  const [editing, setEditing] = useState<Coat | null>(null);
  const [open, setOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [batchPaint, setBatchPaint] = useState<PaintType>('color');
  const [batchState, setBatchState] = useState<CoatState>('coated');
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const activeBody = bodies.find((body) => body.id === currentBodyId) ?? bodies[0] ?? null;
  const bodyId = activeBody?.id ?? '';

  useEffect(() => {
    if (!currentBodyId && bodies.length > 0) setCurrentBodyId(bodies[0]!.id);
  }, [bodies, currentBodyId, setCurrentBodyId]);

  const bodyCoats = useMemo(
    () => coats.filter((coat) => coat.bodyId === bodyId).sort((a, b) => a.seq - b.seq),
    [coats, bodyId],
  );

  const filtered = useMemo(() => {
    const keyword = url.keyword.trim();
    const paintTypes = url.values.paintType ?? [];
    const states = url.values.state ?? [];
    return bodyCoats.filter((coat) => {
      if (keyword.length > 0) {
        const haystack = `${coat.colorName}${coat.coatDate}${coat.thicknessUm}`;
        if (!haystack.includes(keyword)) return false;
      }
      if (paintTypes.length > 0 && !paintTypes.includes(coat.paintType)) return false;
      if (states.length > 0 && !states.includes(coat.state)) return false;
      return true;
    });
  }, [bodyCoats, url.keyword, url.values]);

  const suggestion = bodyId.length > 0 ? suggestForBody(bodyId) : null;
  const stat = bodyId.length > 0 ? progressOf(bodyId) : null;

  /** 罩漆道次的罩前核对（只读工位那份，派生逐位置结果） */
  const gateResults = useMemo(
    () => (bodyId ? evaluateBodyTopcoats(coats, inlays, bodyId) : []),
    [coats, inlays, bodyId],
  );
  const gateByCoatId = useMemo(() => {
    const map = new Map(gateResults.map((gate) => [gate.coat.id, gate]));
    return map;
  }, [gateResults]);
  const awaitingInlays = gateResults.filter(
    (gate) => gate.coat.state === 'awaitInlay' || gate.waitingCount > 0 || gate.unmatchedCount > 0,
  );

  const openCreate = (): void => {
    if (!bodyId) {
      message.warning('请先选择或新建胎体');
      return;
    }
    setEditing(null);
    form.setFieldsValue({
      ...createEmptyCoatDraft(bodyId, nextSeq(bodyId)),
      paintType: suggestion?.paintType ?? 'raw',
    });
    setOpen(true);
  };

  const openEdit = (coat: Coat): void => {
    setEditing(coat);
    form.setFieldsValue({
      bodyId: coat.bodyId,
      seq: coat.seq,
      paintType: coat.paintType,
      colorName: coat.colorName,
      coatDate: coat.coatDate,
      thicknessUm: coat.thicknessUm,
      state: coat.state,
      needRecheck: coat.needRecheck,
      coverPositions: coat.coverPositions,
    });
    setOpen(true);
  };

  const watchedPaintType = Form.useWatch('paintType', form) as PaintType | undefined;

  const submit = async (): Promise<void> => {
    const values = await form.validateFields();
    // 非罩漆道次不记录覆盖位置；罩漆道次至少留一个位置，否则罩前无从核对
    const payload: CoatDraft = {
      ...values,
      coverPositions: values.paintType === 'topcoat' ? values.coverPositions ?? [] : [],
    };
    if (payload.paintType === 'topcoat' && payload.coverPositions.length === 0) {
      // 不在保存时硬拦：允许先建罩漆道次，罩漆前核对时会把「无位置」挡下并提示先补
      message.warning('该罩漆道次还没填覆盖位置，罩漆前核对会挂起，请补齐位置');
    }
    if (editing) {
      await updateCoat(editing.id, payload);
      message.success(`已更新第 ${payload.seq} 道工序`);
    } else {
      await createCoat(payload);
      message.success(`已新增第 ${payload.seq} 道工序`);
    }
    setOpen(false);
  };

  /** 拖拽重排：按落点重排并落库重编号 */
  const handleDrop = async (targetId: string): Promise<void> => {
    setOverId(null);
    if (!dragId || dragId === targetId || !bodyId) {
      setDragId(null);
      return;
    }
    const ids = bodyCoats.map((coat) => coat.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) {
      setDragId(null);
      return;
    }
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved as string);
    await reorderCoats(bodyId, ids);
    setDragId(null);
    message.success('道次顺序已更新并重编号');
  };

  /** 状态推进：前一道未完成时禁止进入下一道；罩漆道次要先过工位嵌贴核对 */
  const handleAdvance = async (coat: Coat): Promise<void> => {
    const previous = bodyCoats.find((item) => item.seq === coat.seq - 1);
    if (previous && previous.state !== 'done') {
      message.warning(`第 ${previous.seq} 道尚未完成，禁止进入第 ${coat.seq} 道`);
      return;
    }
    if (coat.paintType === 'topcoat') {
      const result = await topcoatGateCheck(coat.id, inlays);
      if (result.ok) message.success(result.message);
      else message.warning(result.message);
      return;
    }
    await advanceState(coat.id);
  };

  /** 待嵌道次：工位补嵌后，工序台恢复为待涂，重新核对罩漆（只动 coats 这份） */
  const handleResume = async (coat: Coat): Promise<void> => {
    const result = await resumeFromAwaitInlay(coat.id);
    if (result.ok) message.success(result.message);
    else message.error(result.message);
  };

  const columns: ColumnsType<Coat> = [
    {
      title: '',
      dataIndex: 'drag',
      width: 44,
      render: (_value, record) => (
        <Tooltip title="按住拖动可调整道次先后">
          <span
            className="gb-drag-handle"
            draggable
            onDragStart={() => setDragId(record.id)}
            onDragEnd={() => {
              setDragId(null);
              setOverId(null);
            }}
          >
            <HolderOutlined />
          </span>
        </Tooltip>
      ),
    },
    {
      title: '道次',
      dataIndex: 'seq',
      width: 90,
      sorter: (a, b) => a.seq - b.seq,
      render: (seq: number, record) => (
        <StageTag state={record.state} seq={seq} needRecheck={record.needRecheck} />
      ),
    },
    { title: '漆种', dataIndex: 'paintType', width: 100, render: (value: PaintType) => <Tag>{PAINT_TYPE_LABEL[value]}</Tag> },
    {
      title: '罩漆覆盖位置',
      dataIndex: 'coverPositions',
      width: 150,
      render: (positions: string[], record) =>
        record.paintType === 'topcoat' ? (
          positions.length > 0 ? (
            <Space size={2} wrap>
              {positions.map((position) => {
                const gate = gateByCoatId.get(record.id);
                const hit = gate?.positions.find((item) => item.position === position);
                const color = hit?.status === 'clear' ? 'success' : hit?.status === 'waiting' ? 'warning' : 'error';
                return (
                  <Tooltip key={position} title={hit?.reason ?? '罩前按位置核对工位嵌贴'}>
                    <Tag color={color} style={{ marginInlineEnd: 0 }}>
                      {position}
                    </Tag>
                  </Tooltip>
                );
              })}
            </Space>
          ) : (
            <Typography.Text type="warning" style={{ fontSize: 12 }}>
              未填位置，无法核对
            </Typography.Text>
          )
        ) : (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            —
          </Typography.Text>
        ),
    },
    { title: '色名', dataIndex: 'colorName', width: 110 },
    { title: '涂刷日期', dataIndex: 'coatDate', width: 130, sorter: (a, b) => a.coatDate.localeCompare(b.coatDate) },
    {
      title: '湿膜厚度',
      dataIndex: 'thicknessUm',
      width: 120,
      render: (value: number) => `${value} μm`,
    },
    {
      title: '操作',
      key: 'action',
      width: 250,
      render: (_value, record) => (
        <Space size={4} wrap>
          {record.state === 'awaitInlay' ? (
            <Button size="small" type="link" style={{ color: '#2f6f4f' }} onClick={() => void handleResume(record)}>
              嵌完恢复
            </Button>
          ) : null}
          <Button size="small" type="link" onClick={() => void handleAdvance(record)}>
            {record.paintType === 'topcoat' ? '罩漆前核对' : '推进状态'}
          </Button>
          <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEdit(record)}>
            编辑
          </Button>
          <Popconfirm
            title="删除该道次"
            description="删除后其余道次会自动重编号。"
            okText="确认"
            cancelText="取消"
            onConfirm={() => void removeCoat(record.id).then(() => message.success('已删除该道次'))}
          >
            <Button size="small" type="link" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <h2>髹涂道次编排</h2>
          <p>逐道登记漆种与色名，拖拽调整先后顺序；批量改漆种或状态，同器型自动带出上次做法。</p>
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
            新增道次
          </Button>
        </Space>
      </div>

      <div className="gb-stat-row">
        <StatBadge label="道次总数" value={stat?.coatTotal ?? 0} suffix="道" tone="primary" />
        <StatBadge label="完成率" value={`${stat?.coatPercent ?? 0}%`} percent={stat?.coatPercent ?? 0} tone="success" />
        <StatBadge label="当前道次" value={stat?.currentSeq ? `第 ${stat.currentSeq} 道` : '已完工'} tone="warning" />
        <StatBadge label="全局待复检" value={totals.recheck} suffix="道" tone="danger" />
        <StatBadge label="荫干等待" value={stat?.dryingHours ?? 0} suffix="小时" tone="info" />
      </div>

      {suggestion && suggestion.sourceCode ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 14 }}
          message={`同器型参考：${suggestion.sourceCode} 上次采用${suggestion.sourceColor || '同漆种'}，建议下一道用「${
            PAINT_TYPE_LABEL[suggestion.paintType]
          }」，间隔约 ${suggestion.intervalHours} 小时`}
          action={
            <Button
              size="small"
              icon={<ThunderboltOutlined />}
              onClick={() => {
                form.setFieldsValue({ paintType: suggestion.paintType });
                message.success('已带出建议漆种');
              }}
            >
              带出建议
            </Button>
          }
        />
      ) : null}

      {gateResults.length > 0 ? (
        <Card size="small" style={{ marginBottom: 14 }} title="罩漆前核对（按胎体编号 + 位置对工位嵌贴留底，只读不改工位那份）">
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            {gateResults.map((gate) => (
              <div key={gate.coat.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <Tag color={gate.coat.state === 'awaitInlay' ? '#b8860b' : gate.canTopcoat ? 'success' : 'default'} style={{ marginTop: 2 }}>
                  第 {gate.coat.seq} 道罩漆 · {COAT_STATE_LABEL[gate.coat.state]}
                </Tag>
                <Space size={4} wrap>
                  {gate.positions.map((position) => (
                    <Tooltip key={position.position} title={position.reason}>
                      <Tag
                        color={
                          position.status === 'clear'
                            ? 'success'
                            : position.status === 'waiting'
                              ? 'warning'
                              : 'error'
                        }
                      >
                        {position.position}
                        {position.status === 'clear' ? '·可罩' : position.status === 'waiting' ? '·待嵌' : '·挂起等补'}
                        {position.gatedInlays.length > 0 ? (
                          <span style={{ marginLeft: 4, opacity: 0.85 }}>
                            {position.gatedInlays.map((inlay) => (
                              <span key={inlay.id} style={{ marginRight: 4 }}>
                                <span style={{ color: INLAY_TYPE_COLOR[inlay.type] }}>
                                  {INLAY_TYPE_LABEL[inlay.type]}
                                </span>
                                ·{inlay.pattern}
                                {inlay.pieceState === 'applied' ? '✓' : '（未嵌）'}
                              </span>
                            ))}
                          </span>
                        ) : null}
                      </Tag>
                    </Tooltip>
                  ))}
                </Space>
              </div>
            ))}
            {awaitingInlays.length === 0 ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                当前胎体全部罩漆位置的螺钿 / 蛋壳均已嵌贴核对通过。
              </Typography.Text>
            ) : (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                没嵌完的位置这道先停在「待嵌」；工位在镶嵌页补嵌后，点「嵌完恢复」重新核对。工位那份留底不在本页改动。
              </Typography.Text>
            )}
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
        keywordPlaceholder="搜索色名 / 日期 / 厚度…"
        actions={
          <Space size={6} wrap>
            <Select
              size="small"
              style={{ width: 120 }}
              value={batchPaint}
              options={[...PAINT_TYPE_OPTIONS]}
              onChange={(value: PaintType) => setBatchPaint(value)}
            />
            <Button
              size="small"
              disabled={selectedIds.length === 0}
              onClick={() =>
                void batchUpdate(selectedIds, { paintType: batchPaint }).then(() => {
                  message.success(`已批量改为${PAINT_TYPE_LABEL[batchPaint]}`);
                  setSelectedIds([]);
                })
              }
            >
              批量改漆种
            </Button>
            <Select
              size="small"
              style={{ width: 120 }}
              value={batchState}
              options={[...COAT_STATE_OPTIONS]}
              onChange={(value: CoatState) => setBatchState(value)}
            />
            <Button
              size="small"
              disabled={selectedIds.length === 0}
              onClick={() =>
                void batchUpdate(selectedIds, { state: batchState }).then(() => {
                  message.success(`已批量改为${COAT_STATE_LABEL[batchState]}`);
                  setSelectedIds([]);
                })
              }
            >
              批量改状态
            </Button>
          </Space>
        }
      />

      <Card className="gb-table-card" style={{ marginTop: 16 }} styles={{ body: { padding: 0 } }}>
        {filtered.length === 0 ? (
          <EmptyPanel
            title={bodyCoats.length === 0 ? '该胎体尚未编排髹涂道次' : '当前筛选条件下没有道次'}
            description={
              bodyCoats.length === 0
                ? '从第一道生漆打底开始，逐道登记漆种、色名与湿膜厚度。'
                : '试着调整漆种或状态筛选条件。'
            }
            actionText="新增道次"
            onAction={openCreate}
            secondaryText="重置筛选"
            onSecondary={url.reset}
            size="small"
          />
        ) : (
          <Table<Coat>
            rowKey="id"
            size="small"
            pagination={false}
            columns={columns}
            dataSource={filtered}
            onRow={(record) => ({
              onDragOver: (event) => {
                event.preventDefault();
                setOverId(record.id);
              },
              onDrop: () => void handleDrop(record.id),
              className: overId === record.id && dragId !== record.id ? 'gb-row-drop-target' : undefined,
            })}
            rowSelection={{
              selectedRowKeys: selectedIds,
              onChange: (keys) => setSelectedIds(keys.map((key) => String(key))),
            }}
            rowClassName={(record) => (record.id === dragId ? 'gb-row-dragging' : record.state === 'awaitInlay' ? 'gb-row-await-inlay' : '')}
          />
        )}
      </Card>

      <Typography.Text type="secondary" style={{ display: 'block', marginTop: 10 }}>
        当前胎体进度：{bodyId ? currentCoatText(bodyId) : '未选择胎体'}
      </Typography.Text>

      <Modal
        open={open}
        title={editing ? `编辑第 ${editing.seq} 道` : '新增髹涂道次'}
        onCancel={() => setOpen(false)}
        onOk={() => void submit()}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="seq" label="道次序号" rules={[{ required: true }]} style={{ flex: 1 }}>
              <InputNumber min={1} max={99} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="paintType" label="漆种" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Select options={[...PAINT_TYPE_OPTIONS]} />
            </Form.Item>
          </Space>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="colorName" label="色名" rules={[{ required: true, message: '请填写色名' }]} style={{ flex: 1 }}>
              <Select
                showSearch
                options={COLOR_NAME_OPTIONS.map((name) => ({ value: name, label: name }))}
                placeholder="如：朱红"
              />
            </Form.Item>
            <Form.Item name="coatDate" label="涂刷日期" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Input type="date" />
            </Form.Item>
          </Space>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="thicknessUm" label="湿膜厚度（μm）" rules={[{ required: true }]} style={{ flex: 1 }}>
              <InputNumber min={5} max={500} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="state" label="状态" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Select options={[...COAT_STATE_OPTIONS]} />
            </Form.Item>
          </Space>
          <Form.Item name="needRecheck" label="待复检">
            <Select
              options={[
                { value: false, label: '正常' },
                { value: true, label: '待复检（荫房异常）' },
              ]}
            />
          </Form.Item>
          {watchedPaintType === 'topcoat' ? (
            <Form.Item
              name="coverPositions"
              label="本道罩漆覆盖位置"
              tooltip="工序台罩漆前按「胎体编号 + 位置」对工位嵌贴留底；螺钿/蛋壳没嵌完的位置，这道先停待嵌。未填位置时罩漆核对会直接挂起。"
            >
              <Select
                mode="multiple"
                allowClear
                placeholder="如：外壁、盖面"
                options={INLAY_POSITION_OPTIONS.map((item) => ({ value: item, label: item }))}
              />
            </Form.Item>
          ) : null}
          <Alert
            type="warning"
            showIcon
            message={`环境适宜时，${PAINT_TYPE_LABEL[form.getFieldValue('paintType') as PaintType] ?? '该漆种'}建议间隔约 ${
              suggestion?.intervalHours ?? suggestIntervalHours('raw')
            } 小时再进入下一道`}
          />
        </Form>
      </Modal>
    </div>
  );
}
