# 团战记分多人实时房间路线图

> 状态：阶段 4 自动化回归完成，待 preview 双设备发布验证
>
> 基线版本：v6.2.0
>
> 最后更新：2026-08-31
>
> 前置能力：`design/team-battle-scoreboard-roadmap.md` 中的本地团战模型与界面

## 1. 结论

首版不新建实时服务，也不引入 Socket.IO、第三方房间 SDK 或新的数据库表。直接把 `team_battle` 接入仓库现有实时房间链路：

```text
TeamBattleSetupDialog
        │ POST /api/realtime/rooms/direct
        ▼
worker/realtime/api.ts ── D1：matches / match_players / realtime_rooms
        │ initialize
        ▼
MatchRoom Durable Object ── SQLite：room_game_state(mode = team_battle)
        │ WebSocket snapshot / event
        ▼
RealtimeRoomPanel ── RealtimeTeamBattlePanel
        │ 房主结束
        ▼
D1 completed snapshot ── 现有战绩恢复与团战报告
```

工作量集中在四个 seam：直接开房、Durable Object 团战投影、实时团战面板、完成后归档。现有登录、房间码、成员加入、角色、席位认领、踢人、断线重连、命令幂等、乐观版本和归档重试全部复用。

## 2. 首版范围

### 2.1 必须完成

- 登录用户可在团战设置页选择“本机团战”或“创建实时房间”；
- 实时房间开局时创建 2–8 个固定团战席位；
- 其他登录用户通过现有 6 位房间码加入，先成为观战者；
- 房主可沿用现有成员管理，把成员提升为玩家并认领一个团战席位；
- 所有连接实时看到相同的当前对阵、两两比分、总排行和逐局流水；
- 房主可切换当前对阵、记一局、撤销、更正、暂停、恢复和结束团战；
- 命令重试不重复记分，旧版本命令被拒绝并自动拉取最新快照；
- 断线重连后恢复完整团战状态；事件差距过大时沿用当前有界快照回退；
- 结束后把完整 `TeamBattleMatch`、实时房间元数据和最终结果归档到 D1；
- 云端战绩能识别、查看、恢复到本机并继续使用现有 PNG/PDF/JSON 报告。

### 2.2 明确默认

- **服务器权威**：客户端只发送命令，不直接提交计算后的比分或排行；
- **房主负责计分**：首版只有 `host` 能修改团战竞技状态；`player` 和 `spectator` 均可实时查看；
- **席位与账号分离**：团战成员使用稳定 `playerId`，登录成员通过认领绑定 `userId`；换账号或断线不改变历史；
- **当前对阵属于房间状态**：`currentPairIds` 在 Durable Object 中保存并广播，所有设备显示同一组对阵；
- **开房时固定席位**：首版不在房间进行中新增或删除团战席位；需要几人就在创建时填几人，最多 8 人；
- **完成即只读**：房主结束后不再接受计分、更正或角色变更，归档失败则由现有 alarm 重试；
- **本机模式保留**：原有本地团战入口和 LocalStorage 数据不迁移、不改语义。

### 2.3 本期不做

- 匿名游客加入、免登录临时身份；
- 多房主、裁判角色、玩家自行报分或多人同时编辑；
- 把一场已开始的本机团战“一键升级”为实时房间；
- 房间进行中新增、退出或删除团战席位；
- 固定红蓝队、团体总分、赛程编排、淘汰赛或跨场累计交手；
- 奇招牌与团战联动；
- 新的 D1 表、消息队列、Redis、Socket.IO 或独立实时服务。

只有出现以下真实需求时才扩展：房主成为操作瓶颈时增加裁判/席位权限；用户确实频繁临时加人时增加房中席位创建；有免注册传播需求时再设计游客身份和滥用防护。

## 3. 当前代码基线

可直接复用：

- `src/lib/team-battle.ts` 已有 `TeamBattleMatch`、追加式事件、两两投影、排行、撤销、更正、暂停、恢复和完成逻辑；
- `app/TeamBattleFeature.tsx` 已有本地设置、记分板、成员选择、流水和报告界面；
- `app/GameApp.tsx` 中 `RealtimeRoomPanel` 已处理房间创建/加入、WebSocket、断线重连、角色、席位认领、踢人和结束；
- `worker/realtime/api.ts` 已有直接开房、房间码、D1 投影、成员管理和 DO 初始化重试；
- `worker/realtime/match-room.ts` 已有 Durable Object SQLite、命令幂等、`expectedVersion`、增量同步、快照回退和归档 alarm；
- `worker/realtime/match-room.integration.test.ts` 已覆盖 15 个并发客户端、断线差距、角色收敛、归档重试和现有玩法；
- `matches.mode` 是无枚举约束的文本，`matches.snapshot_json` 可直接保存团战；D1 不需要 schema migration。

需要补齐：

- `DirectDraft` 尚不接受 `team_battle`；
- `room_game_state.mode` 的 DO 内部 CHECK 尚不允许 `team_battle`；
- `RoomSnapshot` 尚无团战状态；
- 席位认领与改名只分支处理追分、中八和斯诺克；
- `processCommand`、`buildArchiveSnapshot` 尚无团战投影；
- `RealtimeRoomPanel` 尚无团战类型和实时团战面板；
- 云端快照校验、恢复与房间列表文案尚未识别团战。

## 4. 最小架构设计

### 4.1 领域模型仍是唯一计分口径

不要复制一套“实时团战算法”。在 `worker/realtime/team-battle-scoring.ts` 增加很薄的 adapter，内部调用 `src/lib/team-battle.ts`：

```ts
type RealtimeTeamBattleState = {
  mode: "team_battle";
  match: TeamBattleMatch;
  seats: Array<{
    playerId: string;
    userId?: string;
  }>;
  currentPairIds: [string, string];
};

projectTeamBattleCommand(state, command):
  | { state: RealtimeTeamBattleState; kind: string; payload: RoomPayload }
  | "invalid_command";
```

`match.players` 保存竞技成员的 ID、姓名和加入时间；`seats` 只保存账号认领关系，避免把连接身份写进领域模型。两两比分和总排行继续由 `getTeamBattleProjection()` 即时派生，不在状态中重复保存矩阵。

首版命令保持最少集合：

| 命令 | 作用 | 权限 |
| --- | --- | --- |
| `team_battle.pair.set` | 更新房间共享的当前对阵 | 房主 |
| `team_battle.round.record` | 记录一局 | 房主 |
| `team_battle.round.undo` | 撤销当前组合上一局 | 房主 |
| `team_battle.round.correct` | 追加更正 | 房主 |
| `team_battle.pause` | 暂停比赛 | 房主 |
| `team_battle.resume` | 恢复比赛 | 房主 |

结束仍走现有 `POST /api/realtime/rooms/:code/complete`，不再增加第二个 `team_battle.finish` 命令。

#### 阶段 0 冻结协议

所有命令沿用房间信封 `{ operationId, expectedVersion, kind, payload }`，操作者只从 WebSocket attachment 读取。`teamBattle` 快照固定为 `{ mode: "team_battle", match, seats, currentPairIds }`；成功命令版本加一，重复 `operationId` 返回原事件且不加版本。

| `kind` | `payload` | 成功事件 |
| --- | --- | --- |
| `team_battle.pair.set` | `{ playerIds: [string, string] }` | `team_battle.pair.changed` |
| `team_battle.round.record` | `{ winnerId, winType, fouls, note?, startedAt? }` | `team_battle.round.recorded` |
| `team_battle.round.undo` | `{}` | `team_battle.round.corrected`，`correctionSource = "undo"` |
| `team_battle.round.correct` | `{ eventId, winnerId, winType, fouls, note?, startedAt? }` | `team_battle.round.corrected`，`correctionSource = "correction"` |
| `team_battle.pause` | `{}` | `team_battle.paused` |
| `team_battle.resume` | `{}` | `team_battle.resumed` |

边界固定为：`winType` 仅 `normal / break_clear / runout`；备注最多 120 字符；犯规仅允许当前两人且为 0–99 的整数；`startedAt` 默认为服务端当前时间，显式值不得晚于服务端 5 分钟。错误沿用 `forbidden / not_found / version_conflict / invalid_command`：成员或局不存在用 `not_found`，结构、同人对阵、获胜类型、犯规、状态不允许用 `invalid_command`。

八人黄金流程固定为房间版本 `0 初始化 → 1 选对阵 → 2 记局 → 3 更正 → 4 撤销 → 5 暂停 → 6 恢复`；重复记局仍为 2，旧版本写入返回当前版本 2，成员加入后为 7 且非房主写入不改变版本。每一步均从 `TeamBattleMatch` 派生两两比分和排行，最终仅调用 `finishTeamBattleMatch()` 形成合法归档领域对象。

阶段 0、1 不新增运行时依赖或 D1 migration；只升级 Durable Object 内部 SQLite `room_game_state` 到 v3。

### 4.2 创建与初始化

给 `DirectDraft` 增加：

```ts
{
  mode: "team_battle";
  players: Array<{ name: string }>;
  title: string;
  location: string;
  note: string;
}
```

校验复用团战常量和规则：2–8 人、姓名 1–20 字符、去首尾空格、同场不重名。API 创建确定性的 `matchId` 和稳定 `playerId`，同一个 `operationId` 重试时继续复用原对局、房间码和 DO，不产生双房间。

直接开房仍写现有三类 D1 记录：

- `matches`：`mode = 'team_battle'`，`snapshot_json` 保存初始 `TeamBattleMatch`；
- `match_players`：每个团战席位一行，开局时 `user_id = NULL`；房主成员行沿用当前额外 host 记录；
- `realtime_rooms`：现有房间码和状态。

不新增 D1 migration。只给 DO 的 `room_game_state` 做 v3 内部迁移，把 CHECK 从四种 mode 扩成五种，并保留已有状态 JSON。

### 4.3 席位认领与名称

沿用现有流程：成员加入房间 → 房主提升为 `player` → 房主认领席位。

- `claimSeat` 增加团战分支，只更新 `seats` 中的 `userId`；
- 已认领席位不能重复认领，一个账号不能占两个席位；
- 认领不自动改写团战成员姓名，避免账号昵称意外改变比赛名单和历史报告；
- 临时席位改名继续只允许房主，并通过 `renameTeamBattlePlayer()` 追加领域事件；
- D1 `match_players` 投影与 DO 成功结果继续按现有 API 收敛；DO 是进行中房间权威源。

### 4.4 权限与并发

在 `processCommand` 中先识别团战，再执行房主检查和投影。不要依赖客户端禁用按钮作为权限边界。

每条命令继续携带：

- `operationId`：网络重试幂等；
- `expectedVersion`：拒绝基于旧快照的操作；
- `actorUserId`：从 WebSocket attachment 读取，不信任消息体；
- 原始意图字段：如胜者、获胜类型、犯规、备注，不接受客户端计算后的总比分。

发生 `version_conflict` 时沿用现有客户端逻辑拉取最新快照。首版只有房主能写，已经大幅降低同一局被两台设备同时确认的概率；不再增加锁或队列。

### 4.5 快照、广播与断线恢复

`RoomSnapshot` 增加：

```ts
teamBattle: RealtimeTeamBattleState | null;
```

所有团战命令成功后持久化 `room_game_state`、追加 `room_events`，再广播事件。客户端接到事件后优先采用服务端返回的新快照/投影；如果只收到增量事件但无法安全重放，就发 `sync`，不要在 React 中实现第二套事件归约器。

继续使用 `MAX_INCREMENTAL_EVENTS = 200`。超过差距直接取有界当前快照；首版不为最多 8 人的朋友局设计额外快照服务。

### 4.6 完成与归档

`buildArchiveSnapshot()` 增加团战分支：

1. 读取 DO 中的 `RealtimeTeamBattleState`；
2. 如果 `match.status` 仍为 active，调用 `finishTeamBattleMatch(match, endedAt)`；
3. 附加现有 `realtimeArchive`：房间码、房间版本、成员和房间事件；
4. 写回 `matches.snapshot_json`、checksum、completed 状态和时间；
5. 沿用原子 D1 batch、失败 pending、指数退避 alarm 和 `archiving_failed` 可观测状态。

归档结果必须通过 `isTeamBattleMatch()`，报告仍调用现有 `getTeamBattleProjection()` 与 `buildTeamBattleReport()`，避免实时结果和本地结果口径分叉。

## 5. 页面改动

### 5.1 团战设置

`TeamBattleSetupDialog` 接收现有登录用户和实时开房回调：

- 游客：只显示“开始本机团战”；
- 登录用户：显示“开始本机团战”和“创建实时房间”；
- 实时按钮提交同一份成员、标题、地点和备注；
- 创建中禁用重复点击，失败保留表单并显示 API 错误；
- 成功后记录直接房间关联并导航到 `/room/:code`。

不增加第二套设置弹窗，也不先创建本地对局再上传。

### 5.2 实时团战面板

新增 `RealtimeTeamBattlePanel`，优先复用 `HeadToHeadScoreboard` 和本地团战的展示结构，但所有写操作改发房间命令：

- 顶部：当前对阵、总局数、连接状态；
- 计分板：当前组合历史比分、普胜/炸清/接清/犯规；
- 房主区：选择对阵、胜者、获胜类型、犯规、备注、确认、撤销、更正、暂停/恢复；
- 公共区：总排行、当前组合流水、全场最近流水；
- 非房主：同样看到实时数据，但写控件隐藏或禁用并提示“由房主记分”。

不要直接复用 `TeamBattleBoard` 的本地 `onChange(match)` 写法；它会让客户端成为权威。可以抽取纯展示的小部件，但不要为了复用先重构整个本地页面。

### 5.3 现有房间壳

`RealtimeRoomPanel` 只做小范围分支：

- 类型增加 `teamBattle`；
- 标题增加“团战实时”；
- 成员席位列表读取团战 `match.players` 与 `seats`；
- 渲染 `RealtimeTeamBattlePanel`；
- 底部“计分”锚点包含团战面板；
- 房间列表、个人页和管理页将 `team_battle` 显示为“团战实时”。

## 6. 分阶段实施

### 阶段 0：固定协议与黄金样例（0.5 工程日）

- [x] 固定上述范围、房主写权限和固定席位规则；
- [x] 用现有 8 人黄金样例写出初始快照、6 类命令和最终归档期望；
- [x] 明确命令 payload、错误码和 `teamBattle` 快照类型；
- [x] 记录无 D1 migration、无新依赖的约束。

退出条件：同一份样例能明确给出每一步房间版本、当前对阵、两两比分、排行和最终 `TeamBattleMatch`。

### 阶段 1：服务端团战投影（1 工程日）

- [x] 新增 `worker/realtime/team-battle-scoring.ts`；
- [x] 复用领域函数实现 6 类命令；
- [x] 增加房主权限、输入边界和稳定错误返回；
- [x] 覆盖重复 `operationId`、旧 `expectedVersion`、非法组合/胜者/犯规；
- [x] 增加 DO `room_game_state` v3 兼容迁移测试。

退出条件：不依赖浏览器即可在一个 DO 中完整运行、断线读取并完成 8 人团战。

### 阶段 2：开房、成员与归档（1–1.5 工程日）

- [x] `DirectDraft` 和 `directDraftBaseline()` 支持 `team_battle`；
- [x] 创建/重试路径加载并初始化团战状态；
- [x] `RoomSnapshot`、`claimSeat`、`renameSeat` 增加团战分支；
- [x] `processCommand` 持久化并广播团战命令；
- [x] `buildArchiveSnapshot()` 输出合法的已完成团战；
- [x] 更新云端快照校验、战绩恢复和列表标签。

退出条件：API 可幂等开房，两个账号可加入并认领席位，结束后 D1 快照通过 `isTeamBattleMatch()`。

### 阶段 3：实时界面（1–1.5 工程日）

- [x] 团战设置页增加实时创建按钮和失败状态；
- [x] 新增 `RealtimeTeamBattlePanel`；
- [x] 接入房间共享当前对阵、计分、撤销、更正、暂停和恢复；
- [x] 非房主只读，断线和重连期间所有写按钮禁用；
- [x] 房间成员区显示席位认领关系；
- [x] 完成 320px 移动端、桌面端、键盘焦点和读屏状态检查。

退出条件：两个浏览器窗口看到相同版本、当前组合、比分、排行和流水；刷新任一窗口后结果不变。

### 阶段 4：回归与发布（1 工程日）

- [x] worker 集成：2 人和 8 人、重复交手、更正、撤销、暂停、完成、归档重试；
- [x] worker 集成：15 个连接的快照一致性和非房主越权拒绝；
- [x] E2E：登录房主创建 → 第二账号加入 → 认领席位 → 多组合记分 → 结束；
- [x] E2E：断网重连、旧版本冲突、重复点击不产生双局；
- [x] E2E：云端战绩打开、恢复、PNG/PDF/JSON 数字一致；
- [x] 回归追分、中八、斯诺克房间以及本地团战；
- [x] 执行 `npm test`、`npm run test:worker`、`npm run lint`、`npm run build` 和目标 Playwright 用例；
- [ ] preview 双设备验证后再发布生产。

退出条件：所有自动化检查通过；关闭或回滚前端入口不会影响已有三类实时房间和本地团战数据。

## 7. 验收矩阵

| 场景 | 必须验证 |
| --- | --- |
| 直接开房 | 2–8 人有效，1/9 人、空名、长名和重名被拒绝 |
| 幂等创建 | 同账号同 `operationId` 只得到一个 match、room 和 DO |
| 当前对阵 | 房主切换后所有窗口同步；同一成员不能占两侧 |
| 组合隔离 | A/B 记局不改变 A/C、B/C |
| 反向组合 | A/B 与 B/A 使用同一历史，左右显示顺序正确 |
| 权限 | 非房主命令在服务端返回 forbidden，伪造 actor 无效 |
| 席位认领 | 一个账号最多一个席位；重连后绑定不丢失 |
| 命令幂等 | 重发同一 `operationId` 不增加事件或比分 |
| 并发冲突 | 同版本两条写命令只有一条成功，另一条触发同步 |
| 撤销/更正 | 两两比分、总排行、成员报告同时重算 |
| 暂停 | 暂停时不能记局，查看和重连正常 |
| 断线恢复 | 小差距增量恢复，大差距快照恢复，结果一致 |
| 完成归档 | 最终快照合法、checksum 正确、失败可由 alarm 重试 |
| 云端战绩 | 团战标签、详情、恢复和三种导出均可用 |
| 无回归 | 追分、中八、斯诺克房间和本地团战行为不变 |

## 8. 验收标准

以下条件全部满足才视为首版完成：

1. 登录用户可用本地团战同一份设置创建实时团战房间；
2. 2–8 个席位、标题、地点和备注正确进入服务端权威状态；
3. 多个客户端实时显示相同当前对阵、比分、排行和流水；
4. 房主可记分、撤销、更正、暂停、恢复和结束，其他成员不能越权；
5. 房间码加入、角色调整、席位认领、踢人和重连继续复用现有流程；
6. 重试不重复、旧版本不覆盖新状态、断线不丢已确认局；
7. 结束后的 D1 快照通过 `isTeamBattleMatch()` 且与房间最终投影一致；
8. 云端战绩可查看、恢复并导出与房间一致的 PNG/PDF/JSON；
9. 不新增运行时依赖和 D1 表；
10. 现有实时玩法与本地团战通过回归测试。

## 9. 推荐提交拆分

1. `feat(realtime): add team battle room projection`；
2. `feat(realtime): create and archive team battle rooms`；
3. `feat(room): add realtime team battle panel`；
4. `feat(history): restore archived realtime team battles`；
5. `test(realtime): cover team battle rooms and reconnects`；
6. `docs(team-battle): document realtime room scope and permissions`。

每个提交带对应测试。不要在同一提交顺便重构全部实时玩法、统一所有状态类型或调整旧页面样式。

## 10. 风险、观测与回滚

### 10.1 主要风险

- **领域状态与席位绑定分叉**：只让 `match.players` 管竞技身份、`seats` 管账号绑定，并在集成测试中同时断言；
- **DO 内部 CHECK 升级丢状态**：复制现有 v2 迁移方式，先建新表、拷贝、替换，再写 schema version；
- **归档后本地解析失败**：归档前后都跑 `isTeamBattleMatch()` 黄金样例；
- **客户端显示旧投影**：版本冲突后统一拉快照，不在 React 中维护独立积分矩阵；
- **旧玩法回归**：团战保持独立分支，避免改写追分、中八和斯诺克 projector。

### 10.2 最小观测

沿用现有结构化日志，并让失败记录包含 `requestId`、`matchId`、`roomCode`、`stage`、`operationId`、命令 `kind` 和当前版本；不记录备注全文或私密内容。

preview 至少观察：创建失败率、`version_conflict` 比例、DO 初始化重试、归档 pending/alarm 次数和 `archiving_failed` 数量。

### 10.3 回滚

优先回滚前端“创建实时团战”入口，服务端保留读取和归档已存在的 `team_battle` 房间。不要回滚到无法读取 DO v3 状态的代码，也不要删除已创建的 D1 对局；已有房间先完成或只读归档。
