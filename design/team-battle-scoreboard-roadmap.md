# 本地团战记分路线图

> 状态：规划中
>
> 目标版本：v6.x 后续版本
>
> 最后更新：2026-08-29

## 1. 目标

在“玩法”页面新增“团战记分”入口，支持 2–8 名成员在同一场本地对局中轮流组成两人对局，并沿用中八计分板的视觉与逐局记分方式。

本期需要完成：

1. 开局时创建 2–8 名成员，并允许比赛中途加入新成员、自定义或修改姓名；
2. 计分板上方选择两名不同的在场成员；
3. 选中组合后，计分板自动恢复这两人在本场团战中的历史比分；若从未交手则显示 `0 : 0`；
4. 每次确认一局后，只更新当前两人的两两比分，并保存可撤销、可更正的追加式流水；
5. 结算页展示整场成员排行、所有实际发生过的两两比分和逐局流水；
6. 结算页可直接导出 PNG 长图和 PDF；内容过长时自动省略逐局比分变化，只保留两两最终比分；
7. 结算页可选择一名成员，输出他与其他所有成员的对局成绩；内容过长时采用相同的摘要降级规则；
8. 第一阶段完全本地运行，不创建实时房间，不写 D1，不进入云端同步队列。

## 2. 需求解释与默认规则

为避免实现时出现不同理解，本路线图采用以下定义：

- “历史比分”指同一场团战内，两名成员此前所有有效局的累计比分，不跨团战、不跨设备查询；
- 成员切换只改变当前计分板视图，不新增比分事件；
- 新的成员组合首次被选中时为 `0 : 0`；重新选中已有组合时从流水重新计算比分；
- 一局只属于当时选中的两名成员，后来改名不会改变成员 ID，也不会把旧局转移给其他人；
- 总排行默认按总胜局降序，其次按总负局升序、交手净胜局降序、加入时间升序排列；并列时明确显示并列，不凭姓名决定竞技名次；
- “两两比分”只展示至少进行过一局的组合；成员专项报告可列出其他全部成员，未交手显示 `0 : 0 / 未交手`；
- 中途加入只允许在对局未结束时进行，成员总数达到 8 人后禁用入口；
- 本期不做成员退出、删除有历史记录的成员、跨场累计战绩、队伍分组或淘汰赛编排。

如果产品希望“历史比分”跨多场团战累计，或希望开局时手工录入旧比分，应另立需求；它会改变存储范围、结算口径和导出说明，不应隐式混入本期。

## 3. 当前代码基线

当前仓库已有可复用能力：

- `PlayPage` 已集中展示中八、斯诺克、多人追分和奇招牌入口；
- `EightBallBoard` 已提供红蓝计分板、选择胜者、普胜/炸清/接清、犯规、备注、暂停、撤销和更正交互；
- `src/lib/eight-ball.ts` 使用追加式事件计算有效局、比分和分类统计；
- `AppData` 已分别保存进行中与历史中八、斯诺克和追分对局，并通过版本化 LocalStorage 恢复；
- `UnifiedHistoryPage` 已把多种对局汇总到同一个战绩入口；
- `src/lib/json-report.ts` 已具备 SVG 转 Canvas、PNG Blob、长图切页和 PDF 生成能力；
- 战绩详情页已有报告选项，但中八与追分详情当前下载的是 SVG，PDF 通过打印窗口生成，尚未直接输出 PNG/PDF 文件。

现有中八模型的 `players` 是固定二元组，开球轮转也按两人计算。团战虽然复用其视觉和单局字段，但不应把 `EightBallMatch` 扩成 2–8 人，否则会把双人赛规则、实时房间协议和历史存档兼容绑在一起。

知识图谱当前把相关代码归入 `app-eight`、`lib-match`、`e2e-score` 和 `realtime-room` 等模块，但索引落后于当前提交；实际实施应继续以源码和测试为准。

## 4. 核心设计

### 4.1 新建独立的团战 Module

新增 `src/lib/team-battle.ts`，对 UI 和测试暴露一个小 interface，复杂度集中在 implementation 内：

```ts
createTeamBattleMatch(draft, now): TeamBattleMatch
addTeamBattlePlayer(match, name, now): TeamBattleMatch
renameTeamBattlePlayer(match, playerId, name, now): TeamBattleMatch
recordTeamBattleRound(match, input, now): TeamBattleMatch
correctTeamBattleRound(match, eventId, replacement, now): TeamBattleMatch
undoLastTeamBattleRound(match, pair?, now): TeamBattleMatch
finishTeamBattleMatch(match, now): TeamBattleMatch
getTeamBattleProjection(match): TeamBattleProjection
getPairProjection(match, firstPlayerId, secondPlayerId): PairProjection
getPlayerReport(match, playerId): PlayerReportProjection
```

UI 不自行维护比分矩阵、排行或导出统计；callers 和 tests 都通过同一 interface 获取投影。这样更正、撤销、改名和报表口径只需在一个地方修正。

不新增持久化 adapter。当前只有 LocalStorage 一个 implementation，尚不存在需要替换的第二种存储实现；待未来接入云端或实时房间时，再把存储 seam 提升为真实 interface。

### 4.2 数据模型

建议初始契约：

```ts
type TeamBattlePlayer = {
  id: string;
  name: string;
  joinedAt: number;
};

type TeamBattleRoundPayload = {
  playerIds: [string, string];
  winnerId: string;
  winType: "normal" | "break_clear" | "runout";
  fouls: Record<string, number>;
  note: string;
  startedAt: number;
  confirmedAt: number;
};

type TeamBattleEvent = {
  id: string;
  sequenceNo: number;
  type: "join" | "rename" | "round" | "correction" | "pause" | "resume" | "finish";
  occurredAt: number;
  playerNames: Record<string, string>;
  round?: TeamBattleRoundPayload;
  correctsEventId?: string;
  replacement?: TeamBattleRoundPayload;
};

type TeamBattleMatch = {
  schemaVersion: 1;
  id: string;
  mode: "team_battle";
  status: "active" | "completed";
  title: string;
  location: string;
  note: string;
  createdAt: number;
  startedAt: number;
  endedAt?: number;
  pausedAt?: number;
  pausedDurationMs: number;
  players: TeamBattlePlayer[];
  events: TeamBattleEvent[];
};
```

关键约束：

- `players` 始终为 2–8 人，成员 ID 在整场对局中稳定且唯一；
- 姓名去除首尾空格、限制 1–20 个字符；同场默认不允许重名，避免选择器和报告歧义；
- `playerIds` 必须包含两个不同且存在的成员；`winnerId` 必须属于该组合；
- `fouls` 只接受当前组合中的成员，值为非负整数；
- 组合 key 使用排序后的稳定 ID，例如 `pairKey(a, b)`，展示顺序由当前选择顺序决定；
- 事件不可原地覆盖。撤销和更正追加 `correction` 事件，投影从有效流水重算；
- 每条事件保留当时的姓名快照，当前界面展示最新姓名，原始审计信息仍可追溯。

不在 `TeamBattleMatch` 中重复保存可变的两两比分矩阵。比分、胜负局、分类统计和排行都是事件流水的派生投影，以免矩阵与流水在撤销或更正后失去一致性。

### 4.3 当前对阵选择

当前选择属于页面临时状态，不属于竞技流水：

- 默认选择开局名单前两人；
- 左右两个选择器不能选到同一成员；
- 切换任意一侧后调用 `getPairProjection`，立即显示该组合在本场内的累计比分；
- 新成员加入后自动出现在两个选择器中，但不强制打断当前对局；
- 若正在编辑尚未确认的一局，切换成员前弹出“放弃本局草稿”确认，防止备注、犯规或胜者被错误带到新组合；
- 已暂停时允许查看不同组合的历史比分，但禁止确认新局。

建议计分板沿用中八红/蓝布局与 CSS 视觉 token，但抽出共享的展示 Module，例如 `HeadToHeadScoreboard`。中八和团战分别准备自己的投影，不让共享展示层理解任何比赛规则。

### 4.4 两两统计与排行口径

`TeamBattleProjection` 至少包含：

```ts
type PairProjection = {
  pairKey: string;
  players: [TeamBattlePlayer, TeamBattlePlayer];
  scores: Record<string, number>;
  rounds: EffectiveTeamBattleRound[];
  lastPlayedAt?: number;
};

type PlayerStanding = {
  player: TeamBattlePlayer;
  wins: number;
  losses: number;
  differential: number;
  opponentsPlayed: number;
};
```

一局给胜者增加 1 个胜局、给对手增加 1 个负局；炸清、接清和犯规只作为分类统计，不改变局分权重。所有两两比分、总榜和成员专项报告必须来自同一投影，禁止三个页面分别实现统计逻辑。

## 5. 页面与交互

### 5.1 玩法页与设置

在 `PlayPage` 增加“团战记分”玩法卡片：

- 标识 `TEAM BATTLE`；
- 文案明确“2–8 人、本机轮换对阵、自动记住两两比分”；
- 点击后打开 `TeamBattleSetupDialog`；
- 设置页至少录入 2 名成员，最多 8 名；支持添加、删除尚未开局的输入行和调整顺序；
- 可选字段包括比赛标题、地点和备注；本期不展示云端房间或牌组配置。

### 5.2 进行中页面

推荐布局顺序：

1. 比赛标题、在场人数、已记录局数、用时、暂停和结束入口；
2. 成员管理条：展示 2–8 人，并提供“加入成员”；
3. 左右对阵选择器：头像色、姓名、当前组合已打局数；
4. 与中八相同的红蓝计分板，显示当前组合历史比分和分类统计；
5. 本局结果：胜者、普胜/炸清/接清、双方犯规、备注；
6. 当前组合的逐局流水；
7. 全场最近流水，可按成员或组合筛选。

新增成员通过小型对话框录入姓名，成功后写入 `join` 事件并保存本地状态。改名写入 `rename` 事件。达到 8 人、比赛已结束或姓名无效时必须给出明确反馈。

### 5.3 结算页面

团战详情页分为四部分：

- 总览：成员数、总局数、实际交手组合数、比赛用时；
- 总排行：每人胜局、负局、净胜局、交手人数；
- 两两比分：按最后交手时间或成员加入顺序稳定排列；
- 逐局流水：显示对阵、胜者、获胜类型、犯规、备注和局后比分。

新增“报告范围”选项：

- `整场团战`：输出总排行、所有实际发生过的两两比分和允许时的逐局变化；
- `指定成员`：选择一名成员，输出他与其他所有成员的比分、总胜负和允许时的相关逐局变化。

页面中的筛选只影响报告预览和导出，不修改原战绩。

## 6. PNG、PDF 与过长降级策略

### 6.1 统一报告投影

把报告数据准备放入独立的纯函数 Module，而不是让 React 页面拼 SVG：

```ts
buildTeamBattleReportProjection(match, {
  scope: { kind: "all" } | { kind: "player"; playerId: string };
  detail: "auto" | "full" | "summary";
}): TeamBattleReportProjection
```

报告投影先生成摘要区和候选的逐局区，再根据预计高度决定最终 detail。这样 PNG、PDF、页面预览和测试使用同一口径。

### 6.2 自动降级规则

默认使用 `detail: "auto"`：

1. 始终保留标题、日期、总览、总排行或指定成员汇总；
2. 始终保留两两最终比分；整场最多 28 组，指定成员最多 7 组；
3. 仅当加入逐局变化后预计 SVG 高度不超过安全预算时，才包含逐局比分变化；
4. 超过预算则整个逐局区省略，不做截断到一半的流水；
5. 报告中明确标注“内容较长，已省略逐局变化，仅展示两两最终比分”；
6. `full` 仅用于开发调试或后续显式高级选项，若超过渲染硬上限仍必须失败并给出可理解错误；
7. `summary` 永远不包含逐局变化。

初始建议将自动详情预算设为 `20_000px`，低于当前 Canvas `30_000px` 硬上限，为字体、浏览器缩放和页脚留出余量。预算必须集中为一个常量，并通过边界测试校准，不能散落在 UI 中。

成员专项报告的逐局区只计算该成员参与的事件；如果仍过长，同样退化为该成员与其他人的最终比分。

### 6.3 文件输出

- PNG：复用 `renderReportCanvas`，通过 `canvas.toBlob("image/png")` 下载真正的 `.png` 长图；
- PDF：复用 `splitReportCanvas`、`canvasJpeg` 和 `buildPdf`，直接下载 `.pdf`，不依赖打印弹窗；
- JSON：保留完整原始对局、有效局、总投影和 `exportVersion`，不因图片长度而删减；
- 文件名示例：`团战战绩-20260829.png`、`团战战绩-张三-20260829.pdf`；
- 导出时禁用重复点击并显示“生成中”；异常后恢复按钮并保留当前报告选项。

建议同时把中八和追分详情接入现有的真实 PNG/PDF 管线，避免界面继续把 SVG 称为“长图”。这属于同一报告渲染 seam 的收敛，但应作为独立提交，便于回滚。

## 7. 本地存储与兼容

将 `AppData` 升级到版本 3，增加：

```ts
activeTeamBattleMatch: TeamBattleMatch | null;
teamBattleHistory: TeamBattleMatch[];
```

迁移原则：

- v1/v2 本机数据读取后补上空的团战字段，既有中八、斯诺克和追分数据不变；
- `isTeamBattleMatch` 严格校验 schema、成员数量、事件数组和稳定 ID；非法团战数据隔离为 storage issue，不影响其他历史战绩读取；
- 每次有效操作后沿用当前 `setData`/LocalStorage 自动保存机制；刷新页面可恢复当前选择的默认前两人及全部比分，但无需恢复未确认的表单草稿；
- 本地完整备份应包含团战记录；云端迁移上传暂时跳过 `team_battle`，并在界面标注“团战战绩仅保存在本机”；
- 云端历史 API、D1 schema、Worker business API、Durable Objects 和实时房间协议本期不修改；
- 删除本地团战战绩沿用现有确认流程，但不能调用云端删除接口。

## 8. 分阶段实施

### 阶段 0：契约与测试样例（0.5 个工程日）

- [x] 固定本路线图中的需求口径和非目标；
- [x] 定义 `TeamBattleMatch`、事件和投影类型；
- [x] 固定 2–8 人、姓名、组合 key、排序和报告长度规则；
- [x] 准备 2 人、8 人、中途加入、重复交手、撤销/更正和超长流水样例。

退出条件：同一份样例能写出明确的预期两两比分、总排行和成员专项报告。

### 阶段 1：领域模型 Module（1–1.5 个工程日）

- [x] 新增 `src/lib/team-battle.ts`；
- [x] 实现创建、加入、改名、记局、暂停、恢复、撤销、更正和结束；
- [x] 实现组合投影、总榜投影和成员专项投影；
- [x] 保证更正后从完整有效流水重算；
- [x] 为所有 invariants、错误模式和排序规则补单元测试。

退出条件：不依赖 React 或浏览器即可完整模拟一场 8 人团战并得到稳定结果。

### 阶段 2：本地存储与应用路由（0.5–1 个工程日）

- [x] `AppData` 升级到 v3 并兼容读取 v1/v2；
- [x] 接入进行中团战和团战历史；
- [x] 增加开始、更新、完成、恢复和删除处理；
- [x] 将团战加入“当前只能有一场进行中对局”的互斥判断；
- [x] 明确阻止团战进入云端同步、云端恢复和实时房间分支。

退出条件：刷新页面不会丢失已确认局，旧本机数据加载结果保持一致。

### 阶段 3：玩法设置与进行中页面（1.5–2 个工程日）

- [x] 在玩法页新增团战卡片和设置对话框；
- [x] 抽出规则无关的 `HeadToHeadScoreboard` 展示 Module；
- [x] 实现双成员选择、历史比分恢复和 `0 : 0` 空状态；
- [x] 实现中途加入、改名、8 人上限和重名校验；
- [x] 实现单局录入、当前组合流水、撤销、更正、暂停与结束；
- [x] 完成 320px 宽移动端、横屏和桌面端布局；
- [x] 检查键盘焦点、label、错误提示和颜色对比度。

退出条件：任意切换多组成员后，各组合比分互不污染，刷新后仍一致。

### 阶段 4：结算、筛选与导出（1–1.5 个工程日）

- [x] 将团战加入统一战绩列表和详情路由；
- [x] 展示总排行、两两比分和逐局流水；
- [x] 增加“整场 / 指定成员”报告范围；
- [x] 实现 `auto/full/summary` 报告投影；
- [x] 直接下载 PNG 长图和 PDF；
- [x] 对超长整场和超长成员报告验证自动省略逐局变化；
- [x] 保留完整 JSON 备份；
- [x] 收敛中八、追分详情的真实 PNG/PDF 输出作为独立提交。

退出条件：PNG、PDF 与页面摘要数字一致；任何自动降级报告都保留完整两两最终比分。

### 阶段 5：回归与发布（1 个工程日）

- [ ] 单元测试：模型、投影、存储迁移、报告长度边界和文件构建；
- [ ] 组件测试：选择器互斥、切换组合、加入成员、草稿保护和导出状态；
- [ ] E2E：2 人开局、扩展到 8 人、多组合往返切换、结算、删除；
- [ ] E2E：超长战绩导出 PNG/PDF，只显示两两比分并带降级提示；
- [ ] E2E：选择成员后导出他与其他 7 人的报告；
- [ ] 回归中八、斯诺克、追分的开始、恢复、结算和导出；
- [ ] 执行 `npm test`、`npm run lint`、`npm run build` 和目标 Playwright 用例；
- [ ] preview 验证后再发布生产版本。

退出条件：自动化检查通过，旧存档兼容，移动端实机导出可打开且数字一致。

## 9. 测试矩阵

| 场景 | 必须验证 |
| --- | --- |
| 新组合 | 首次选择显示 `0 : 0` |
| 重复组合 | A/B 与 B/A 指向同一份历史，但按当前左右顺序展示 |
| 组合隔离 | A/B 记局不改变 A/C、B/C 比分 |
| 中途加入 | 新成员可与所有旧成员对阵，旧比分不变 |
| 改名 | 稳定 ID 不变，当前报告用新名，原始事件保留旧名快照 |
| 撤销与更正 | 两两比分、总榜、专项报告同时重算且结果一致 |
| 8 人边界 | 第 9 人被阻止，最多 28 个实际两两组合 |
| 暂停与刷新 | 暂停期间不能记局；刷新后计时和已确认比分恢复 |
| 整场摘要 | 所有实际交手组合均有最终比分 |
| 成员摘要 | 目标成员与其余成员逐一列出，未交手为 `0 : 0` |
| 自动详情 | 阈值以内有逐局变化，超过阈值完全省略逐局区并提示 |
| 文件一致性 | 页面、PNG、PDF、JSON 的最终比分一致 |
| 旧数据 | v1/v2 LocalStorage 和现有三类战绩无回归 |

## 10. 验收标准

以下条件全部满足才视为本地版完成：

1. 玩法页能创建 2–8 人团战，少于 2 人或多于 8 人不能开始；
2. 进行中可添加成员并自定义姓名，最多 8 人；
3. 计分板上方可以选择两名不同成员；
4. 首次组合显示 `0 : 0`，已有组合显示本场历史累计比分；
5. 切换组合、刷新页面、暂停恢复后比分仍正确且互不污染；
6. 每局支持普胜、炸清、接清、犯规和备注，并可撤销或更正；
7. 结算页展示总排行、所有实际交手的两两比分和完整可用流水；
8. 结算页可以直接下载真正的 PNG 长图和 PDF 文件；
9. 报告过长时自动省略逐局比分变化，仍完整显示两两最终比分并给出提示；
10. 可选择任一成员，导出他与其他所有成员的成绩，超长时采用相同降级规则；
11. 所有团战数据只保存在本机，不调用实时房间、D1 或云端历史接口；
12. 旧版本地存档、中八、斯诺克和追分流程通过回归测试。

## 11. 推荐提交拆分

1. `feat(team-battle): add append-only local match model`；
2. `feat(storage): persist local team battle matches`；
3. `feat(play): add team battle setup and scoreboard`；
4. `feat(history): add team battle settlement and player reports`；
5. `feat(report): export team battle PNG and PDF with auto summary`；
6. `refactor(report): reuse PNG and PDF renderer in match details`；
7. `test(team-battle): cover pair scores joins corrections and exports`；
8. `docs(team-battle): document local-only behavior and future seams`。

每个提交同时包含对应测试。领域模型、LocalStorage 迁移和 UI 接入应保持可独立审查；不要在本地版提交中顺带修改实时房间协议或数据库 schema。

## 12. 后续版本预留

本地版稳定后，如需实时团战，优先复用 `TeamBattleMatch` 的事件和投影 interface，在其外新增 Durable Object adapter 与命令权限；不要让实时连接状态进入领域模型。云端历史则新增独立的 schema 版本、同步幂等和冲突规则。

后续候选能力包括：跨场成员档案与累计交手、固定队伍/团体总分、瑞士轮或淘汰赛编排、成员退出、二维码加入和观战。它们都不属于本路线图的本地第一阶段。
