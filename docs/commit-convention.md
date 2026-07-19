# SkillOps 提交信息规范（Commit Convention）

> 状态：current
> 最后更新：2026-07-20
> 目的：让每条提交都能说明“改了哪个模块、改变了什么行为、如何验证、是否影响兼容性”。
> 采用 **Conventional Commits** 风格，统一使用**中文**描述。

配套文档：`AGENTS.md`、`docs/README.md`、
`docs/develop/roadmap/task.md`、`docs/develop/data/event_model.md`。

---

## 1. 提交格式

```text
<类型>(<模块>): <简述>

<正文：说明动机、行为变化、实现方式、隐私/兼容性影响、验证证据>

<页脚：BREAKING CHANGE / 关联任务 / 修复问题>
```

要求：

- `类型 + 模块 + 简述` 为必填首行。
- 首行使用中文动宾短语，建议不超过 50 个汉字。
- 正文对非纯文档改动强烈推荐，复杂适配器或事件模型改动必须填写。
- 页脚用于破坏性变更、任务追踪或问题编号。
- 一个提交只包含一个可独立验收、可安全回滚的切片。

示例：

```text
fix(registry): 按运行时隔离重复 Skill 与版本冲突

Registry 先确定 Codex、Claude Code 或 Cursor 工作区，再计算来源、
provider 和健康状态；同名 Skill 只有在同一运行时存在多个定义时才
标记 duplicate，不再把跨运行时共享名称误判为冲突。

验证：npm test；npm run build；Registry 真实扫描
关联：docs/develop/roadmap/task.md M4
```

---

## 2. 提交类型（type）

| 类型 | 含义 | SkillOps 使用场景 |
| --- | --- | --- |
| `feat` | 新增用户可用能力 | 新扫描来源、真实运行时适配器、导入/导出能力、真实评估器 |
| `fix` | 修复错误行为 | 事件重复、指标口径错误、Hook 漏记、Registry 分类错误 |
| `refactor` | 重构且不改变外部行为 | 深化模块、移动实现、简化接口、消除重复逻辑 |
| `style` | 仅视觉或格式调整 | 布局、颜色、响应式、CSS，不改变交互语义 |
| `perf` | 性能优化 | ETag、增量读取、大事件列表渲染、扫描缓存 |
| `docs` | 文档更新 | PRD、架构、事件模型、运维、安全、路线图 |
| `test` | 测试变更 | 单元、组件、适配器、回归或冒烟测试 |
| `build` | 构建、依赖与工具链 | npm 依赖、Vite、TypeScript、Node 版本、打包 |
| `ci` | 持续集成 | CI 矩阵、自动校验、发布流水线 |
| `chore` | 不属于以上类型的仓库维护 | `.gitignore`、无行为变化的文件清理、维护脚本 |
| `revert` | 回滚已有提交 | 撤销某次明确提交并说明原因 |

选择规则：

- 从 Preview/占位状态变为真实可用能力使用 `feat`。
- 已承诺的行为不正确使用 `fix`。
- 目录调整但对用户和本地接口无行为变化使用 `refactor`。
- UI 行为发生变化时不能只写 `style`。
- 测试随功能一起修改时仍以功能的 `feat`/`fix` 为主；纯测试补充才用 `test`。
- 只改文档使用 `docs`，不要用 `chore`。
- 当前 Evaluations 页面是 Preview；仅修改示例文案不能称为真实评估 `feat`。

---

## 3. 模块（scope）

提交必须选择最相关的一个 scope。不要把多个 scope 用逗号、斜线或
`+` 拼成一个名称；跨模块切片选择拥有主要行为的模块，并在正文说明影响面。

### 产品界面模块

- `overview` — Overview KPI、趋势图、运行时分布、近期活动和零状态。
- `skills` — Skill 执行指标、版本、成功率与 lifecycle-only 展示。
- `runs` — 执行时间线、搜索、分页、详情关联、JSON/JSONL 导入。
- `registry` — 安装定义扫描、运行时工作区、来源/provider 分类、冲突健康状态。
- `settings` — 运行时连接、本地事件导出、清空和备份交互。
- `evaluations` — 评估预览；未来真实 evaluator、版本比较和报告。

### 核心应用模块

- `frontend` — `app/frontend/skillops` 中跨页面的路由、状态、组件和样式。
- `backend` — `app/backend` 中本地 HTTP、静态服务与跨后端行为。
- `events` — 事件 schema、规范化、JSONL 存储、导入、去重、备份和 outcome 语义。
- `scanner` — Skill/command 目录、插件注册表、frontmatter、来源与 provider 发现。
- `connections` — 有效运行时配置检查、Hook 路径健康和真实活动状态。
- `desktop-ingest` — Codex Desktop 会话增量解析、Skill 路径识别和派生事件。
- `analytics` — 运行、成功率、覆盖率、成本、日期和聚合口径。
- `shared` — `app/shared` 中前后端共同依赖的窄接口。

### 运行时与工程模块

- `codex` — Codex Hook、安装器、信号检测、信任和诊断。
- `claude` — Claude Code Hook、安装器、Skill Tool/Slash 检测、CC Switch 兼容。
- `cursor` — Cursor 扫描或未来真实适配器；当前仅为 Preview。
- `cli` — `bin/skillops.mjs` 的 scan/emit 命令。
- `docs` — 文档体系和文档索引。
- `repo` — 根目录结构、`.gitignore`、AGENTS/CLAUDE 仓库规范。
- `build` — Vite、TypeScript、npm 依赖和生产构建。
- `ci` — 持续集成和自动发布校验。

### scope 选择示例

| 改动 | 推荐 scope |
| --- | --- |
| 修复 Registry 的跨运行时重复判断 | `registry` |
| 增加 Claude Code 插件 command 扫描 | `scanner` |
| 修复 Claude Hook 对 Skill Tool 的检测 | `claude` |
| 改变 success/outcome 规范化规则 | `events` |
| 调整所有页面共同导航 | `frontend` |
| 增加本地 HTTP 端点 | `backend` |
| 只补充隐私文档 | `docs` |

---

## 4. 常用提交示例

### 新功能

```text
feat(scanner): 识别 Claude Code 已安装插件命令

读取 installed_plugins.json，并仅扫描对当前 user/project scope 生效的
commands 目录；结合有效 settings 中的 enabledPlugins 标记启用状态。
缺失或无权限目录按未安装处理，不阻断完整扫描。

验证：npm test；POST /api/scan 真实扫描
关联：docs/develop/roadmap/task.md M4
```

### 缺陷修复

```text
fix(events): 拒绝 completed 事件携带 failed 结果

在共享规范化接口中拒绝矛盾 event/outcome 组合，并保持 failed 事件统一
归一化为 failed，避免前端成功率和失败数出现互相冲突的事实。

验证：npm test；npm run smoke
```

### 重构

```text
refactor(backend): 将服务端实现迁入 app/backend

保持根 npm 命令和本地 HTTP 接口不变，统一更新 Vite中间件、CLI、
适配器与冒烟脚本导入路径；事件数据路径保持不变。

验证：npm test；npm run build；npm run smoke
```

### 文档

```text
docs(docs): 补齐产品、架构与本地运维文档

按产品和开发层建立 docs 索引，补充 PRD、事件模型、运行时适配器、
测试、故障排查、隐私安全及路线图，并校验全部相对链接。

验证：Markdown 相对链接检查；git diff --check
```

### 其它简短示例

```text
perf(events): 使用 ETag 避免重复传输未变化事件
test(codex): 增加 SKILL 路径误报回归用例
style(registry): 优化窄屏运行时卡片与表格滚动
build(build): 升级 Vite 并保持生产输出路径不变
chore(repo): 锚定根运行数据忽略规则
revert(cursor): 回滚“feat(cursor): 接入原生 Hook”
```

`revert` 建议正文注明被回滚的提交哈希与原因。

---

## 5. 正文和页脚要求

正文优先回答：

1. 为什么需要这次变化？
2. 用户或调用者可观察到什么行为变化？
3. 主要实现方式与模块接口是什么？
4. 是否影响事件 schema、本地 HTTP、运行时配置、数据隐私或兼容性？
5. 使用什么命令或真实场景验证？

推荐页脚：

```text
验证：npm test；npm run build；npm run smoke
关联：docs/develop/roadmap/task.md M6
修复：#123
```

不要在提交信息中粘贴真实 prompt、transcript、源码内容、Hook payload、
凭据、环境变量值或完整用户路径。

---

## 6. 破坏性变更

以下变化通常需要 `BREAKING CHANGE`：

- 删除或重命名本地 HTTP 路径、方法或响应字段；
- 改变事件字段、枚举、去重身份或 outcome 含义，导致旧 JSONL 不兼容；
- 改变默认数据目录或不再读取旧数据；
- 改变 Hook marker/config 结构，导致现有安装必须迁移；
- 改变 CLI 参数或 npm 命令且不保留兼容入口；
- 将默认 HTTP 绑定从 loopback 改为其它地址。

示例：

```text
feat(events): 引入带版本号的事件信封

所有新事件使用 schemaVersion 字段，读取器继续兼容 v0.3.1 JSONL，
但外部 emit 集成必须在下一版本前完成迁移。

BREAKING CHANGE: POST /api/events 从下个主版本起要求 schemaVersion。
关联：docs/develop/data/event_model.md
```

如仍保持完整向后兼容，可以不标破坏性变更，但正文必须说明迁移行为。

---

## 7. 一个提交的边界

推荐的可验收切片：

- 一个事件不变量及其测试、文档；
- 一个扫描来源及其 fixtures/真实扫描证据；
- 一个运行时信号的检测、隐私过滤和回归测试；
- 一个页面问题及其交互/组件测试；
- 一个本地 HTTP 行为及开发/生产实现、冒烟验证；
- 一次纯目录重构及所有路径消费者更新。

应拆分：

- 无关页面视觉调整和后端事件语义修复；
- 依赖升级和大范围功能改造（除非升级是该功能不可分割的前置）；
- Codex 与 Claude Code 不同问题的独立修复；
- 自动格式化产生的大量无关变更。

不要为了追求“每个文件一个提交”而破坏一个可运行的完整切片。

---

## 8. 提交前验证

### 代码或结构变更

按风险运行：

```powershell
npm test
npm run build
npm run smoke
git diff --check
git status --short --branch
```

- server、路由、构建、本地 HTTP、隐私或目录变化必须运行 `npm run smoke`。
- Codex/Claude 适配器变化还必须运行对应 dry-run，并做一次真实
  non-discovery 生命周期记录验证。
- Registry/scanner 变化需要 `POST /api/scan` 真实扫描并核对分类。
- 不要因为某条命令不通过而在提交信息中写“已验证通过”。

### 纯文档变更

至少运行：

```powershell
git diff --check
git status --short --branch
```

同时检查所有新增或修改的相对 Markdown 链接能够解析。若文档修改了
命令、路径、schema、HTTP 或运行时保证，仍应运行对应代码验证，不能只做
文字检查。

---

## 9. 禁止提交的内容

提交前检查 Git 状态，禁止加入：

- `data/` 中的事件、发现索引、适配器错误日志和任何备份；
- `dist/`、`node_modules/`、`*.tsbuildinfo` 和临时文件；
- `.opc/`、`.omx/` 等本地代理运行状态；
- `.env*`（允许明确设计的 `.env.example`）、私钥、token、cookie；
- 用户真实 prompt、transcript、模型输出、工具输入/输出、源代码样本；
- 未脱敏的 Codex/Claude/CC Switch 配置；
- 与当前提交目的无关的用户修改。

仓库主要源码当前可能仍显示为未跟踪文件。提交前必须明确选择范围，
不能直接使用宽泛的 `git add .` 来替代检查。

---

## 10. 提交操作规则

- 未经用户明确要求，不执行 `git add`、`git commit`、`git push` 或创建 PR。
- 不使用 `git reset --hard`、`git checkout --` 等方式丢弃用户改动。
- 提交前查看完整 diff 和状态，确认没有运行数据或秘密。
- 提交信息必须与实际 diff、测试证据和任务状态一致。
- 路线图中的 Planned 项不能在提交信息中描述成已完成能力。

推荐提交前审查：

```powershell
git status --short --branch
git diff --check
git diff --stat
git diff
```

对于已暂存内容，另外审查：

```powershell
git diff --cached --check
git diff --cached --stat
git diff --cached
```
