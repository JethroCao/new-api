# 即梦视频 CLI 接入 New API

`客户端 → New API 类型 61 任务插件 → HTTP 适配服务 → dreamina-canvas → 即梦`

版本 0.2.1 提供视频生成、参考素材上传、样片转正片、异步查询和多结果下载。New API 继续负责用户鉴权、渠道路由、额度预扣/结算/退款、任务归属及下载鉴权；本目录只实现插件和独立 Node.js 适配服务，无 npm 依赖，不修改网关核心和数据库。终端用户使用 New API 令牌请求 API，无需打开即梦网页或操作 CLI；服务管理员负责 CLI 登录、空间、画布和导出设置。

图片生成接口已从插件移除。图片仍可作为视频参考素材。内置即梦 AK/SK 渠道与本插件不同，必须使用类型 61 任务插件渠道。

## 模型与参数

下表来自 2026-10-28 官方 Canvas CLI 1.1.1 的实时模型目录。插件做静态参数校验，适配服务启动和提交前再核对实时目录；账号权限、可用性和报价最终由即梦服务端决定。

| API 模型名 | 分辨率 | 时长（整数秒） | 首尾帧 | 多模态参考上限 |
| --- | --- | --- | --- | --- |
| `seedance_2.5` | 480p / 720p / 1080p | 4–30 | 1 或 2 图 | 总计 50：图 30 / 视频 10 / 音频 10 |
| `seedance_2.5_draft` | 480p | 4–30 | 1 或 2 图 | 总计 50：图 30 / 视频 10 / 音频 10 |
| `seedance_2.0_vip` | 720p / 1080p / 4k | 4–15 | 1 或 2 图 | 总计 12：图 9 / 视频 3 / 音频 3 |
| `seedance_2.0_fast_vip` | 720p | 4–15 | 1 或 2 图 | 总计 12：图 9 / 视频 3 / 音频 3 |
| `seedance_2.0_mini` | 720p | 4–15 | 1 或 2 图 | 总计 12：图 9 / 视频 3 / 音频 3 |
| `seedance_pro_fast` | 720p / 1080p | 5–10 | 仅首帧 1 图 | 不支持 |
| `happyhorse_1.1` | 720p / 1080p | 4–15 | 仅首帧 1 图 | 图 9 |
| `wan_3.0` | 720p / 1080p | 4–15 | 1 或 2 图 | 总计 20：图 10 / 视频 5 / 音频 5 |

- 全部模型支持文生视频，`n` 为 1–4，默认 1；`seconds` 默认 5。`resolution` 默认模型表中第一个值，输入大小写不敏感，发送 CLI 时自动匹配其大小写。
- `ratio` 默认 `16:9`。Seedance 系列支持 `21:9,16:9,4:3,1:1,3:4,9:16`；HappyHorse 另支持 `4:5,5:4,9:21`；Wan 支持 `16:9,4:3,1:1,3:4,9:16`。
- `mode` 为 `t2v`、`first_last_frame`、`m2v`。不传时：无参考素材为 `t2v`，单张图片为 `first_last_frame`，其余为 `m2v`。两张图片做首尾帧时须显式指定 `first_last_frame`，按首帧、尾帧顺序上传。
- Seedance 2.0 和 Wan 的多模态输入必须包含图片或视频；Seedance 2.5 可以只提供音频。首尾帧模式只允许图片。
- 提示词上限分别为 HappyHorse 2500、Seedance 2.0 系列 4000、Seedance 2.5 系列 15000、Pro Fast 2000、Wan 20000 个 UTF-16 单元。文生视频不能为空；参考模式可以省略提示词。
- 兼容 `size` 的横竖屏组合：`854x480` / `480x854`、`1280x720` / `720x1280`、`1920x1080` / `1080x1920`、`3840x2160` / `2160x3840`，映射到分辨率和比例，仍须符合模型能力。与显式参数冲突时报错。其他比例使用 `resolution` + `ratio`。
- `dreamina-video` 是 `seedance_2.5` 的兼容别名，推荐客户端直接用规范模型名。未知参数、不支持的组合、任意本地路径、即梦内部资源 ID 和提示词中的画布资源引用均拒绝。为避免 CLI 对引用语法的宽松解析，提示词不能包含 `{{`（含转义写法）；参考素材必须通过专门字段提供。
- 返回 `n` 表示请求数量，`video_count` 表示成功交付数量。批量部分失败时保留成功视频，并按成功数量结算。

## API 使用

以下请求均发往 New API；`NEW_API_KEY` 为终端用户令牌，不是桥接密钥。

```sh
curl http://localhost:3000/v1/videos \
  -H "Authorization: Bearer $NEW_API_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"seedance_2.5","prompt":"海浪轻轻拍打沙滩，固定机位","seconds":10,"resolution":"1080p","ratio":"9:16","n":2}'
```

获得公开任务 ID 后查询状态，完成后下载第一个视频：

```sh
curl "http://localhost:3000/v1/videos/$TASK_ID" -H "Authorization: Bearer $NEW_API_KEY"
curl "http://localhost:3000/v1/videos/$TASK_ID/content" \
  -H "Authorization: Bearer $NEW_API_KEY" -o video.mp4
# 多结果：从 New API 的产物列表取得各产物下载地址。
curl "http://localhost:3000/v1/tasks/$TASK_ID/artifacts" -H "Authorization: Bearer $NEW_API_KEY"
```

产物键依次为 `video`、`video-2`、`video-3`、`video-4`。下载支持 GET、HEAD 和单段 Range。任务及所有产物仍受 New API 用户归属校验，响应不暴露桥接密钥、CLI 资源 ID 或签名下载链接。

首尾帧 multipart 上传（同一 `references` 字段按顺序重复）：

```sh
curl http://localhost:3000/v1/videos \
  -H "Authorization: Bearer $NEW_API_KEY" \
  -F model=seedance_2.5 -F mode=first_last_frame -F seconds=5 \
  -F resolution=720p -F ratio=16:9 -F 'prompt=从首帧自然过渡到尾帧' \
  -F 'references=@first.png;type=image/png' \
  -F 'references=@last.jpg;type=image/jpeg'
```

单图也可用文件字段 `input_reference`。多模态模式可在 `references` 字段中按顺序上传图片、视频和音频，必须使用相应 MIME 类型；不要混用文件与 URL 参考。普通参数不能重复。JSON 示例：

```json
{
  "model": "seedance_2.5",
  "mode": "m2v",
  "prompt": "参考画面风格，跟随音频节奏运动",
  "seconds": 10,
  "resolution": "720p",
  "references": [
    {"type": "image", "url": "https://your-public-media-host.example/reference.png"},
    {"type": "audio", "url": "https://your-public-media-host.example/music.mp3"}
  ]
}
```

参考素材也接受 `data:<mime>;base64,...`，但大文件应使用 multipart，避免超过 New API 的任务快照大小限制。每笔请求全部参考素材合计最多 64 MiB，可由服务端进一步调低；URL 下载共用 30 秒期限。支持 PNG/JPEG/WebP、MP4/WebM、WAV/MP3/Ogg/M4A/FLAC，并检查文件头。URL 只允许公网 IPv4 HTTPS 443，逐跳重验 DNS 并固定连接地址；私有 IP、IPv6-only、凭据 URL 和其他端口拒绝。上传成功不保证素材内容或编码满足即梦审核及模型要求。

### 样片转正片

先用 `seedance_2.5_draft`、`n:1` 创建并完成样片，再提交以下请求：

```json
{
  "model": "seedance_2.5",
  "mode": "promote",
  "draft_task_id": "task_你的已完成样片任务ID",
  "resolution": "1080p"
}
```

New API 校验来源任务归属并固定到来源渠道，桥接服务再次核对本地样片记录。转正继承样片的时长和比例，不能另传提示词、参考素材或批量参数；目前官方转正规格仅支持 1080p。只允许单结果样片，因为 CLI 尚未提供从同一节点多个样片结果中选择一个的参数。转正是新任务，单独报价及计费。

**样片最多保留 7 天，过期后不能转正**，具体期限和来源可用性以即梦服务端为准。下载保存在本地不延长即梦侧转正期限。

## 准备 CLI 与配置

要求 Node.js 22+ 和官方 `dreamina-canvas`。桥接服务在 CLI 所在主机运行，使用 CLI 自己的授权存储，不复制 Cookie 或 OAuth token。

为服务准备独占 profile（示例 `new-api`），按照 `auth login --help` 完成授权，然后检查账号、空间和画布：

```sh
dreamina-canvas --profile new-api --format json auth status
dreamina-canvas --profile new-api --format json space current
dreamina-canvas --profile new-api --format json canvas ls --limit 20
dreamina-canvas --profile new-api --format json model list --type video
```

按 `space use --help` 选择个人/团队空间。一个 profile 只对应一个桥接实例，其他进程不要切换其登录或空间。服务不会自动登录、切换空间或提高消费上限；启用下述轮换配置后，会按需创建画布。

复制 `config.example.json` 为 `config.local.json`，填写 CLI 和数据目录绝对路径、账号 ID、画布 UUID，以及 `personal` 或 `team:<teamId>`。`models` 只保留需要开放的规范模型名，每个模型可分别设置 `maxCredits`。

### 每画布最多 5 个视频

示例配置 `canvasTaskLimit: 5` 启用自动轮换；省略或设为 `0` 保持固定画布模式。`projectId` 仍保留为历史任务的默认画布，不要修改它或迁移旧任务。开关变化不影响已绑定任务的上传、生成、查询和下载归属。

- 所有用户共用分配池；命名 `Nexora-YYYYMMDD-NNN`，日期取分配时的北京时间，序号每天从 `001` 递增。跨天新请求不使用昨天的画布，已分配任务继续在原画布执行。
- 按请求的 `n` 预留视频名额，最终成功或失败都不释放；例如 `n:4` 占 4 个名额。剩余容量容不下整笔请求时分配其他画布，不拆分同一请求。同一幂等键和内容重试复用原名额。不必凑满 5 个才开始生成。
- 样片转正必须使用来源画布，也占一次；来源画布已达到 5 个视频时返回 `409` / `source canvas capacity reached (5 videos maximum)`，不提交生成。历史已超过 5 个视频的大画布不拆分，也不再接纳转正。
- 分配台账 `dataDir/canvases.json` 保存画布 UUID、原始名称和名额；与任务文件一起备份，不能单独删除或回滚。磁盘写入结果不确定时保守保留名额并停止继续分配，修复存储并重启后恢复。新画布先分配 UUID，再通过官方 `canvas create` 幂等创建；失败仅重试同一 UUID，不退回历史画布。
- 手动重命名不影响 UUID 路由。画布创建不会使用 `--use` 切换当前画布；创建权限失败时任务保留排队并标记 `canvas_creation_pending`，遵循既有排队期限，不自动换空间。
- 启用后不能回退到只认识全局 `projectId` 的旧桥接程序。停用轮换应保持新程序并将 `canvasTaskLimit` 设为 `0`，已有任务仍绑定原画布。

台账自动升级到版本 2，按已有任务的 `n` 补齐名额数量；历史任务不搬迁，历史已超容量画布不再接纳新任务。升级后不能回退到只支持版本 1 台账的程序。

### 并发调度

示例配置允许最多 100 个未完成视频（`maxQueue: 100`），其中最多 100 个处于准备或生成阶段（`maxConcurrent: 100`）；批量请求按 `n` 占容量。100 个单视频请求分配到 20 个画布，容量不足返回 429。

- `submitWorkers: 6`：最多 6 条创建画布、上传参考素材、提交生成的工作流并行执行。
- `pollWorkers: 4`：4 条独立查询工作流。`downloadWorkers: 2`：2 条独立下载工作流，慢下载不占查询名额；加上提交最多 12 条工作流。同一批同时发起的账号检查会合并。
- `pollMs: 1000`：每秒分配空闲工作位；`pollIntervalMs: 5000`：每条任务查询后至少等待 5 秒再查，任务多时按轮转顺序分配。
- `catalogTTLms: 60000`：公开模型规格缓存 60 秒，到期刷新失败不使用过期规格提交。账号/空间检查只合并同时进行的调用，不缓存成功结果。
- 不同画布并行提交，同一画布的写入暂时串行，提交完成即释放该画布写入位，不等待视频生成完成。查询任务按轮转顺序分配，单个慢任务不会阻塞其他空闲工作位；同一任务不会被重叠的调度周期重复执行。
- `leaseSeconds: 300`：New API 查询任务后有效 5 分钟，覆盖批量任务串行轮询间隔。提交前仍检查有效期与 30 分钟排队期限；服务重启不恢复有效期，必须等待网关重新查询。已提交或结果不确定的任务只查询原提交 ID，不重新生成。
- 停机时停止调度并等待正在运行的工作流保存状态后释放数据目录锁；文件持久化失败时停止新调度。

这些容量是本服务的上限，不代表即梦团队能同时生成同样数量的视频；即梦自己的排队、积分和审核规则仍生效。

### 耗时诊断与状态同步

桥接响应和任务状态文件中的 `timings` 使用 Unix 毫秒：`admitted_at_ms`、`preparation_started_at_ms`、`context_checked_at_ms`、`canvas_ready_at_ms`、`model_checked_at_ms`、`references_ready_at_ms`、`submit_started_at_ms`、`accepted_at_ms`、`upstream_completed_observed_at_ms`、`download_started_at_ms`、`download_completed_at_ms`。旧任务不补造历史时间；结果不确定后才查到已受理，记录为 `accepted_observed_at_ms`。

`poll_count`、`poll_error_count`、`last_poll_started_at_ms`、`last_poll_finished_at_ms`、`max_poll_gap_ms` 用于判断查询积压。结构化服务日志只记录任务 ID、阶段、时间、状态和查询次数，不记录提示词、素材或凭据。`upstream_completed_observed_at_ms` 是本地观察到上游完成的时间，不是即梦提供的真实完成时间，不能据此单独计算官方排队或生成耗时。

观察到成功资源后先保存资源 ID，再由独立下载队列处理；校验下载内容成功后才返回 `completed`。重启继续下载原资源，不重新生成；部分成功仍只交付成功资源。升级不搬迁已有任务或修改画布名额。

New API 的即梦渠道可开启现有 `other_settings.disable_task_polling_sleep: true`，仅取消查询本机桥接快照时每条任务之间的 1 秒睡眠。保留原有 15 秒系统轮询调度，仍存在一定同步延迟；不应自动对其他直连上游的渠道开启此设置。

`maxCredits` 是**整次任务（含全部 n 个结果）的最高即梦积分报价**，不是每个视频的积分，也不是人民币或 New API 单价。示例全部为 0，不批准正积分消费；管理员须明确设置允许的上限，客户端不能覆盖。它不等于累计预算，仍须设置 New API 令牌额度、限流和价格。

管理员明确允许不设单次即梦积分上限时，可在服务端配置顶层设置 `unlimitedCredits: true`（默认 `false`）。普通生成和样片转正会通过官方 CLI 的 `--yes` 自动确认报价，不再传递 `maxCredits`；各模型原有 `maxCredits` 保留，关闭开关后恢复生效。此开关不改变账号、团队、画布或历史任务身份，不能由 API 客户端覆盖。New API 的用户余额预扣、令牌额度、限流及失败退款流程仍然生效；即梦实际消耗运营方积分，用户费用按 New API 售价独立结算。

```sh
cd integrations/dreamina
cp config.example.json config.local.json
# 编辑配置；密钥应随机生成、妥善保存，重启保持不变。
export DREAMINA_BRIDGE_TOKEN="$(openssl rand -hex 32)"
export DREAMINA_BRIDGE_CONFIG="$PWD/config.local.json"
npm run check
npm start
```

`check` 只核对账号、空间和实时模型目录，不生成、不验证画布编辑权限。正式开放前需确认画布权限、报价上限及实际计费。

默认监听 `127.0.0.1:8787`。Docker 中 New API 的渠道地址通常为 `http://host.docker.internal:8787`；确认容器能连通，必要时绑定 `0.0.0.0` 并限制防火墙。跨主机使用 TLS 反向代理。`publicUrl` 为兼容历史图片下载保留，仍需填写有效服务地址，当前视频由 New API 鉴权代理下载。

## New API 渠道与计费

1. 上传 `plugin.js` 并启用 `dreamina-cli`。
2. 新建**任务插件（类型 61）**渠道，绑定插件，Base URL 填桥接地址，Key 填 `DREAMINA_BRIDGE_TOKEN` 原值。
3. 渠道模型选择需要开放的规范模型名，必须与桥接 `models` 配置一致。不要映射到其他供应商模型；兼容别名 `dreamina-video` 会发往桥接的 `seedance_2.5`。
4. 配置分组、用户令牌权限、限流及每个模型的任务计费表达式；插件不内置美元价格。
5. 配置媒体下载安全策略，验证生成、查询和下载整个链路后再开放渠道。

计费用量 `seconds` 在预扣时为 `seconds × n`，完成时改为 `seconds × 成功交付数量`；`resolution`（统一小写）、`mode`、`reference_video` 为创建时冻结的条件，管理员可据此配置不同费率。失败及差额结算复用 New API。沿用按次固定价格不会自动得到按时长计费，需配置任务计费表达式。即梦积分和用户账单是两套独立体系，插件不会将即梦积分虚构为美元单价。

### 本地媒体下载白名单

New API 内容代理另行应用全局 `fetch_setting`，渠道 Base URL 不会自动放行。默认私有 IP 和 8787 端口限制可能导致 502 `artifact_request_rejected`。

专用本地实例可保持 `enable_ssrf_protection=true`，设置以下精确白名单：

- `domain_filter_mode=true`，`domain_list` 仅列受信桥接域名，例如 `host.docker.internal`。
- `ip_filter_mode=true`，`ip_list` 填容器内实际核验的桥接 `/32` 或 `/128` 地址。
- `allowed_ports` 仅列桥接端口，`apply_ip_filter_for_domain=true`。
- 上述限制就绪后才设置 `allow_private_ip=true`，不要关闭 SSRF 保护。

这是实例级设置，须兼顾已有业务的其他受信抓取目标；也可部署满足现有策略的公网 HTTPS 桥接地址。历史联调后的安全设置已恢复，本次开发没有自动放开白名单。

## 队列、恢复与存储

- 桥接 API 仅供可信 New API 使用。`POST /v1/jobs` 要求 Bearer 和 `Idempotency-Key`，插件使用公开任务 ID。相同键和请求返回同一任务，冲突返回 409；不同客户端请求仍是不同生成。
- 每笔任务先写入稳定节点/提交 ID；上传使用预先落盘的资源 UUID，重试使用同一身份。付费提交超时后只查询原 submit ID，不自动重提。
- HTTP 创建后须收到第一次鉴权轮询才开始执行，避免网关未保存受理结果便消耗积分。排队任务须维持轮询租约（默认 300 秒），重启不恢复租约。网关正常任务轮询会续约，无需终端用户直接访问桥接。
- 默认最多 2 个活动生成任务（`maxConcurrent`，1–200；生产压测可显式设为 200），所有进行中任务都会查询。排队任务轮换尝试，没有租约或准备失败的任务不会长期占住队首。HTTP 默认同时最多接纳 2 笔提交（`maxAdmissions`，1–200），其余返回 429，查询及下载仍可用。
- 默认最多 20 个未完成任务、1000 个持久任务，排队最长 1800 秒（30 分钟）；分别由 `maxQueue`（1–200，包含排队和进行中）、`maxJobs`、`maxQueueWaitSeconds` 配置。未开始且过期的任务失败，不生成。
- New API 超时应大于排队上限加 CLI 命令超时，连续轮询失败窗口应大于租约。租约不提供跨服务原子取消：网关终止与 CLI 受理同时发生仍可能消费，已提交任务不自动取消。
- 每次执行检查账号/空间。`context_mismatch`、`cli_unavailable`、`model_unavailable` 表示等待修复；`reference_upload_pending` 使用原 UUID 恢复上传；准备结束后再次检查租约才允许生成。
- `submission_uncertain`、`status_unavailable`、`manual_recovery_required` 应按存储的 submitId/projectId 只读检查 `operation status`。`absent` 不能证明从未扣费，不可换 ID 重跑。
- `download_failed` 时保留进行中，修复导出/磁盘后重试下载；不重新生成，不把已消费的任务谎报失败。校验签名、大小及 SHA256 后才交付。
- 明确失败保留上游公开错误码和文案；任务日志显示文案，视频 API 在兼容原有 `error.code` 的同时返回 `error.upstream_code`。只有错误码时显示 `Dreamina service error: <code>`，不猜测中文含义。仅提取错误码及文案，过滤文案中的认证凭据，不转发上游完整载荷；历史已终结记录不自动改写。
- CLI 退出码 10（报价未批准）、明确拒绝或全部生成失败会终止任务；未知状态继续恢复。`GET /healthz` 只代表进程存活。
- 正常退出等待 CLI 结束并释放锁。异常退出留下 `dataDir/.lock`，先验证记录的 PID 已退出再移除；一个目录只能一个进程。
- 配置和存储绑定，修改账号、空间、画布、profile 或模型配置会拒绝旧目录。升级旧配置前先完成/排查旧任务，保留原记录及旧服务用于历史任务恢复，不可通过新建目录来重试不确定任务。
- 数据目录权限 0700，文件权限 0600，保存提示词、输入文件、任务身份和视频；URL/base64 输入及 CLI 凭据不写入任务快照。默认单个产物最多 512 MiB（`maxMediaBytes`）。没有自动清理、备份或磁盘总额控制，须监控并按保留策略归档；删除任务记录会失去幂等保护。
- 旧图片处理逻辑仅在桥接层保留用于历史数据兼容；新插件不提供图片创建或原图片协议。迁移时不要覆盖仍有图片任务的旧插件部署。
- 导出水印由即梦账号/团队的导出设置控制，CLI 下载遵循该设置。修改设置后需重新下载；已缓存文件不会自动变更。

## 验证状态

```sh
npm test
# 仓库根目录：真实 New API JS 引擎及已有插件回归
go test ./plugins
```

自动化测试使用模拟 CLI，不消耗积分。覆盖 8 个模型、JSON/multipart、输入校验、同键幂等、身份漂移、断线恢复、队列租约、部分成功结算、多产物下载、样片来源校验、上传恢复和 SSRF 边界。

2026-10-28 已核验团队空间的全部 8 个实时模型；官方 CLI 对 23 个模型/模式组合及样片转正命令的 `--dry-run` 验证通过，无联网写入或扣费。实际完整链路的既有付费验证为 Seedance 2.5、480p、5 秒：New API POST 创建、轮询完成、GET/HEAD 下载 200、Range 206、无令牌 401，产物 SHA256 一致，854×480、5.057 秒。该测试的 New API 用户价格为 0，即梦报价上限为 60 团队积分；测试后已恢复价格、禁用渠道及删除临时令牌。

0.2.0 的其他模型、批量、参考素材生成和样片转正片尚未逐项付费生成验收；本次仅完成开发、自动化和只读/本地 CLI 验证，没有自动启用生产渠道或进行额外扣费。正式面向用户前仍需按管理员确认的预算进行真实生成、正价计费及长时间运行验收。

2026-10-30 并发修复验证：本机及生产服务器均通过 69 项桥接测试，覆盖 100 个单视频请求分配 20 个画布、6 个提交/2 个查询位隔离、重叠调度去重、批量视频容量、台账升级与停机恢复。线上 8 个共用 profile 的并行只读 CLI 检查通过。发布后沿用原任务身份恢复用户队列，不重新提交已失败或结果不确定的任务；旧台账升级到版本 2，回退必须保留支持该版本的程序和全部任务记录。
