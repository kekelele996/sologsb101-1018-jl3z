# 漆器髹涂工序与荫房环境档案（gblacquer）

面向漆艺工作室工序管理员的本地化档案工具：把每件漆器的髹涂道次、荫干时长与打磨推光逐道记录，并同步留存荫房温湿度，作为漆层缺陷回溯依据。

核心动作：**登记胎体与器型 → 编排髹涂道次与漆种 → 记录荫房温湿度 → 登记打磨与推光 → 登记镶嵌纹饰 → 成品质检与导出**。

纯前端单页应用（React 18 + TypeScript + Ant Design + Vite + Zustand + React Router），**无后端、无数据库服务、无 API 服务**，全部数据保存在浏览器本地（IndexedDB / Dexie + 少量 localStorage 元数据），刷新或重启浏览器后依然存在。

---

## 一、Docker 一键启动（推荐）

```bash
# 1. 首次启动先复制环境变量模板
cp .env.example .env

# 2. 构建并启动
docker compose up -d --build
```

启动完成后访问：**http://localhost:22818**

常用命令：

```bash
docker compose ps                 # 查看服务状态（healthy 表示就绪）
docker compose logs -f frontend   # 查看 nginx 日志
docker compose down               # 停止并移除容器
docker compose up -d --build      # 代码改动后重新构建
```

> 端口可在 `.env` 中通过 `FRONTEND_PORT` 修改；容器名固定为 `${COMPOSE_PROJECT_NAME:-gblacquer}-frontend`。
> 容器无状态：不连接数据库、不挂载命名卷，数据全部在浏览器本地；迁移设备请使用 `/export` 页的「导出 / 导入 JSON 备份」。

---

## 二、技术栈

| 分类 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | React 18（函数组件 + Hooks） | 页面按路由懒加载 |
| 语言 | TypeScript（`strict: true`，`noUnusedLocals`） | `npm run build` 内含 `tsc --noEmit` 类型检查 |
| UI 组件库 | Ant Design 5（含 `@ant-design/icons`） | 表格、表单、对话框、拖拽排序、徽标 |
| 构建工具 | Vite 5 | 开发服务器端口 22818 |
| 状态管理 | Zustand 4 | `bodyStore` / `coatStore` / `roomStore` |
| 路由 | React Router 6（`createBrowserRouter`，history 模式） | nginx 侧配合 `try_files` 做 SPA fallback |
| 本地存储 | Dexie 4（IndexedDB 封装）+ localStorage | 含数据结构版本号与 v1→v2 升级迁移 |
| 容器化 | Docker 多阶段构建：`node:20-alpine` → `nginx:alpine` | 构建阶段类型检查 + 打包，运行阶段仅托管静态产物 |

---

## 三、本地开发方式

```bash
cd frontend
npm install
npm run dev        # 开发服务器 http://localhost:22818
npm run build      # 类型检查 + 生产构建，产物在 frontend/dist
npm run preview    # 本地预览构建产物（http://localhost:22818）
```

要求 Node.js 20 及以上（与 Docker 构建阶段镜像 `node:20-alpine` 保持一致）。

---

## 四、页面与路由

| 路由 | 页面 | 主要职责 | 消费模型 |
| --- | --- | --- | --- |
| `/bodies` | 胎体与器型台账 | 新建胎体、按材质与器型筛选（同步 URL query），卡片回显已完成道次与最近荫房记录 | Body、Coat、Room |
| `/coats` | 髹涂道次编排（工序台台账） | 拖拽调整道次先后并重编号、批量改漆种与状态、同器型自动带出上次漆种与间隔建议；罩漆道次登记**覆盖位置**，罩漆前按「胎体编号 + 位置」对工位嵌贴，没嵌完那道先停**待嵌**，对不上的挂起等补 | Coat、Body（只读 Inlay 核对） |
| `/rooms` | 荫房温湿度记录 | 按区间判定适宜 / 偏干 / 偏湿，越界回写关联道次为「待复检」，支持日期区间筛选 | Room、Coat |
| `/polish` | 打磨与推光工序 | 按道次生成目数序列（320→2000），未打磨完的道次禁止进入下一道罩漆 | Polish、Coat |
| `/inlays` | 镶嵌工位台账 | 螺钿 / 蛋壳 / 描金 / 戗金的**纹饰登记 + 嵌片嵌贴 + 归属道次**；工位独立留底（不写 coats），已罩漆位置的事后补记单列**待认领**不退回罩漆，挂不上道次的先挂起等补 | Inlay（写）、Coat、Body（只读核对） |
| `/export` | 成品质检与导出 | 质检登记（返工定位到具体道次与荫房记录）、返工清单、JSON 导入导出与清空重播种 | Inspect 及全部模型 |

`/` 与未匹配路径重定向到 `/bodies`。筛选条件写入 URL query（`?kw=&paintType=&state=` 等），刷新后条件保留，可直接分享链接。

---

## 五、数据模型

| 模型 | 文件 | 关键字段 | 说明 |
| --- | --- | --- | --- |
| Body 胎体 | `src/types/body.ts` | `id` `code` `material`（木/脱胎/金属） `shape`（碗/盘/盒/瓶） `sizeMm` `ownerName` `state`（待髹涂/髹涂中/待荫干/已完成） | 新建后进入道次编排，卡片回显进度与最近荫房 |
| Coat 髹涂道次 | `src/types/coat.ts` | `id` `bodyId` `seq` `paintType`（生漆/色漆/罩漆） `colorName` `coatDate` `thicknessUm` `state`（待涂/已涂/待打磨/已完成/**待嵌**） `needRecheck` `coverPositions`（罩漆覆盖位置） | 拖拽调序，同器型带出上次漆种与间隔建议；罩漆道次按覆盖位置核对工位嵌贴 |
| Room 荫房记录 | `src/types/room.ts` | `id` `bodyId` `date` `tempC` `humidityPct` `inAt` `outAt` `verdict`（适宜/偏干/偏湿） | 越界即回写关联道次为待复检 |
| Polish 打磨推光 | `src/types/polish.ts` | `id` `bodyId` `seq` `grit` `method`（水砂/推光/揩清） `durationMin` `operator` | 按道次生成目数序列 |
| Inlay 镶嵌（工位留底） | `src/types/inlay.ts` | `id` `bodyId` `type`（螺钿/蛋壳/描金/戗金） `pattern` `position` `materialNote` `pieceState`（待嵌/已嵌贴） `claimState`（未对道次/已归属/待认领） `claimedCoatId` `lateRegistered` `appliedAt` | 螺钿/蛋壳罩漆前必须先嵌好；工位独立留底，不写 coats |
| Inspect 质检 | `src/types/inspect.ts` | `id` `bodyId` `verdict`（合格/返工） `defectNote` `inspector` `date` `defectCoatSeq` `defectRoomId` | 返工定位到道次与荫房记录并生成返工清单 |

数据结构版本号 `DB_SCHEMA_VERSION` 定义在 `src/utils/db.ts`，当前为 `v3`：
v1→v2 为 `coats` 表增加 `paintType` 索引并回填 `paintType = 'raw'`、`needRecheck = false`、`thicknessUm = 40`；
v2→v3 把镶嵌工位与髹涂工序台拆成两摊独立留底——`inlays` 补出嵌贴状态（`pieceState`/`appliedAt`）与归属道次（`claimState`/`claimedCoatId`/`lateRegistered`），`coats` 补出罩漆覆盖位置 `coverPositions`。升级时旧镶嵌记录只有图案和位置：按「胎体编号 + 位置」回填归属道次与嵌贴状态，挂不上任何罩漆道次的单列**待认领**。

### 两摊分开留底（镶嵌工位 / 髹涂工序台）

螺钿、蛋壳必须先嵌好再罩漆。为避免「空位被直接罩住」，两边各自留底、互不写入对方那份：

- **镶嵌工位**（`/inlays`，只写 `inlays` 表）：管纹饰登记、嵌片嵌贴（待嵌/已嵌贴）、归属道次认领。
- **髹涂工序台**（`/coats`，只写 `coats` 表）：管道次、罩漆覆盖位置与状态；罩漆前按「胎体编号 + 位置」对工位留底。
  - 螺钿/蛋壳**没嵌完**的位置 → 这道先停在**待嵌**，工位补嵌后工序台「嵌完恢复」再罩；
  - 工位在该位置**一条记录都没有** → 先**挂起等补**，不直接罩；
  - 已罩过漆的位置工位事后补记 → 工位那份单列**待认领**，可认领到当时罩漆道次，**不退回、不改写**罩漆那道。
- 核对逻辑全部在纯函数 `src/utils/reconcile.ts`；写入各自走 `src/utils/ledgerWrite.ts` 的单表事务 + 有限重试，**写入失败只退自己那份重试，另一摊不动**。
- 两摊留底可分别导出 CSV：工序台台账（含罩漆覆盖位置）与镶嵌工位台账（含嵌贴 / 归属道次）。

---

## 六、目录结构

```
sologsb101-1018/
├── frontend/                     # 前端源码
│   ├── src/
│   │   ├── types/                # body.ts coat.ts room.ts polish.ts inlay.ts inspect.ts
│   │   ├── stores/               # bodyStore.ts coatStore.ts roomStore.ts inlayStore.ts
│   │   ├── components/common/    # StageTag.tsx FilterBar.tsx StatBadge.tsx EmptyPanel.tsx
│   │   ├── hooks/                # useCoatProgress.ts useIdbTable.ts
│   │   ├── pages/                # BodyList.tsx CoatBoard.tsx RoomLog.tsx PolishBoard.tsx InlayBoard.tsx ExportView.tsx
│   │   ├── router/               # index.tsx
│   │   ├── utils/                # humidity.ts db.ts export.ts reconcile.ts ledgerWrite.ts
│   │   ├── styles/               # main.css
│   │   ├── scripts/              # verify-inlay-ledger.ts（两摊留底与 v2→v3 迁移冒烟校验）
│   │   ├── App.tsx main.tsx
│   ├── public/favicon.svg
│   ├── index.html package.json tsconfig.json vite.config.ts
│   ├── Dockerfile                # 多阶段构建（node:20-alpine → nginx:alpine）
│   ├── nginx.conf                # SPA fallback + gzip + 静态资源缓存
│   └── .dockerignore
├── docker-compose.yml            # 顶层 name、container_name、端口映射
├── .env / .env.example           # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── .gitignore
└── README.md
```

分层约定：页面只读 Zustand store，跨页状态不留在组件内部 `useState`；IndexedDB 读写统一走 `useIdbTable()` 封装；筛选派生逻辑统一走 store 导出的选择器函数。

---

## 七、数据存储说明

- **IndexedDB（Dexie，数据库名 `gblacquer`）**：6 张业务表 `bodies` / `coats` / `rooms` / `polishes` / `inlays` / `inspects`，由 `src/utils/db.ts` 统一定义 schema、版本号与升级迁移；`initDatabase()` 在首次打开时自动播种**三层互相引用**的演示数据（Body → Coat / Room → Polish / Inlay / Inspect，固定 id 如 `body_01`、`coat_0101`），播种幂等。
- **localStorage**：仅存元数据 —— `gblacquer:db-version`（本地结构版本）、`gblacquer:last-backup-at`（最近导出时间）、`gblacquer:ui-prefs`（当前选中胎体）。
- **备份**：`/export` 页可导出 JSON（6 张表全量数据 + 结构版本号），导入时校验 `app` 字段与各集合数组完整性，覆盖导入前二次确认；另有返工清单 TXT 与工序台账 CSV。
- **隐私与无状态**：数据不上传任何服务器，容器不挂载命名卷；清理浏览器站点数据或更换浏览器会丢失档案，请定期导出备份。

---

## 八、开发提示

- 类型检查与构建：`cd frontend && npm run build`（含 `tsc --noEmit`，必须零错误）。
- 两摊留底与 v2→v3 迁移冒烟校验：`cd frontend && npm run verify:ledger`（用 fake-indexeddb 在 Node 下跑 28 项断言，覆盖罩前核对、待嵌 / 挂起 / 待认领与旧数据补齐）。
- 端口一致性：开发服务器（`vite.config.ts`）、预览服务、compose 的 `FRONTEND_PORT` 默认值均为 `22818`。
- 若部署在中文路径下，`docker-compose.yml` 顶层的 `name: gblacquer` 可保证项目名不为空，`docker compose config --quiet` 不会报错。
- 容器运行阶段执行了 `RUN chmod -R a+rX /usr/share/nginx/html`，避免宿主机静态资源权限为 0600 时 nginx worker 读取失败返回 403。
