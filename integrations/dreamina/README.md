# 即梦 CLI 接入 New API（实验版）

`客户端 → New API 类型 61 任务插件 → 本机 HTTP 服务 → dreamina-canvas → 即梦`

本目录是独立适配服务，无 npm 依赖；不修改 New API 数据库或内置即梦渠道。内置即梦渠道使用火山引擎 AK/SK，不能绑定这里的 CLI 服务。

## 当前范围

- 文生图：`POST /v1/images/generations`，模型 `dreamina-image`，同步等待结果；支持 `n`、`response_format=url|b64_json`。
- 文生视频：`POST /v1/videos`，模型 `dreamina-video`，JSON 请求；`GET /v1/videos/:id` 查询，`GET/HEAD /v1/videos/:id/content` 下载。
- 不接受图片编辑、参考图/文件、音频、画布编辑、Responses API。未知参数会报错，尺寸和比例由服务端配置固定。
- 图片/视频共用一个串行队列。提交身份在调用 CLI 前落盘，断线或重启只查询原 submit ID，不自动重提。
- **视频交付尚需真实素材验证。** 实现调用官方 `resource download` 并校验文件签名、大小和 SHA256；安装的 CLI 1.1.1 文档只明确描述图片下载。若该版本不能导出视频，任务保持 `in_progress` 且 `attention=download_failed`，不会谎报完成或重新生成。此时后续队列会等待处理；不要先开放视频渠道给用户。

自动化测试覆盖模拟 CLI 的成功、失败、超时恢复与 HTTP 交付。2026-10-28 使用 CLI 1.1.1 在个人空间完成一次真实图片链路：New API → 插件 → HTTP 服务 → Seedream 4.0（2K、1 张，上限 1 积分）→ PNG 下载及校验 → OpenAI 图片响应。个人空间保存 Seedance 2.0 mini 视频节点返回 `access_denied`，视频尚未完成真实生成/下载验证。CLI dry-run 只验证本地参数，不代表真实生成或账号权限已验证；报价上限也不是最终净扣费账单。

## 准备 CLI 与配置

要求 Node.js 22+，以及当前用户已安装的官方 `dreamina-canvas`。适配服务运行在 CLI 所在主机，用官方 CLI 自己的登录存储；不复制 Cookie、OAuth token 或团队授权。

为服务准备一个独占的 profile（例 `new-api`），按照 CLI 的 `auth login --help` 完成授权。确认空间并选择/创建用于服务的画布：

```sh
dreamina-canvas --profile new-api --format json auth status
dreamina-canvas --profile new-api --format json space current
dreamina-canvas --profile new-api --format json canvas ls --limit 20
dreamina-canvas --profile new-api --format json model list --type image
dreamina-canvas --profile new-api --format json model list --type video
```

需要更换个人/团队空间时，按 `space use --help` 显式选择。服务不会自动切换空间、创建画布、登录或批准增加预算。不要让其他进程/人工同时修改这个 profile 的登录和空间；一个 profile 只能对应一个桥接服务实例。

复制 `config.example.json` 为 `config.local.json`，填入绝对路径、账号 ID、画布 UUID 和预期空间。团队空间写 `team:<teamId>`。所有示例模型须通过启动时的实时规格检查，服务检查 ratio/resolution/count/duration 的有效值及大小写。

`maxCredits` 是**每次生成的最高即梦积分报价**，不是人民币或 New API 单价。示例为 0，不批准正积分消费。管理员应在确认个人/团队消费主体后明确设置允许上限。客户端无法覆盖。图片批量的上限覆盖整次任务，而非每张图。没有按天/总额自动配额；面向用户时还应配置 New API 的令牌额度、限流和模型价格。

```sh
cd integrations/dreamina
cp config.example.json config.local.json
# 编辑 config.local.json 后执行；密钥应随机生成并保存，重启保持不变。
export DREAMINA_BRIDGE_TOKEN="$(openssl rand -hex 32)"
export DREAMINA_BRIDGE_CONFIG="$PWD/config.local.json"
npm run check
npm start
```

`check` 只核验当前账号/空间和模型参数，不创建任务，也不验证指定画布的编辑权限。首次真实请求前需确认该画布可编辑、模型权限和积分充足。

`host` 默认 `127.0.0.1`，端口 8787。若 New API 在 Docker 内运行，渠道地址一般为 `http://host.docker.internal:8787`；先确认容器能连通。某些网络环境需要将 `host` 设为 `0.0.0.0` 并限制防火墙访问。`publicUrl` 是图片结果中的签名链接地址，必须同时能被客户端和 New API 访问，不能随意填写容器内的 localhost。跨主机访问时使用 TLS 反向代理。

## 在 New API 配置

1. 在任务插件管理中上传本目录 `plugin.js`，启用 `dreamina-cli`。
2. 新建 **任务插件（类型 61）** 渠道，绑定该插件；Base URL 填适配服务地址，Key 填 `DREAMINA_BRIDGE_TOKEN`（原值，程序添加 Bearer）。
3. 先启用 `dreamina-image`；视频完成真实生成与下载验收后再启用 `dreamina-video`。这里的别名由适配服务映射到 CLI 模型，不要将渠道模型映射到 `seedream_*`/`seedance_*`。
4. 配置分组、令牌权限及计费。插件提供图片 `image_count` 和视频 `seconds` 用量；没有内置美元价格。图片完成时按实际交付数量，视频按实际发送给 CLI 的时长参数结算。即梦积分与 New API 用户账单是两套体系。

```sh
# NEW_API_KEY 是 New API 用户令牌，与服务之间的桥接密钥不同。
curl http://localhost:3000/v1/images/generations \
  -H "Authorization: Bearer $NEW_API_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"dreamina-image","prompt":"一只纸船漂在平静湖面上","n":1,"response_format":"url"}'

curl http://localhost:3000/v1/videos \
  -H "Authorization: Bearer $NEW_API_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"dreamina-video","prompt":"海浪轻轻拍打沙滩，固定机位","seconds":5}'
```

视频返回 New API 的公开任务 ID，后续用同一用户令牌查询和下载。图片默认等待最多 600 秒（由 New API 的 `TASK_PLUGIN_PROTOCOL_TIMEOUT_SECONDS` 控制）；客户端超时不表示上游停止，不要盲目发起另一笔生成。

## 状态、恢复和存储

- 桥接 API 仅供可信 New API 渠道访问。`POST /v1/jobs` 要求 Bearer 和 `Idempotency-Key`；插件自动用 New API 的 `publicTaskId`。相同键/请求返回同一任务，不同请求返回 409。不同客户端请求即使 prompt 相同，仍是不同生成。
- `GET /v1/jobs/:id` 返回状态；鉴权的 `GET /healthz` 只表示服务存活，不等于即梦登录、生成或下载可用。
- 每次执行前检查账号与空间。`context_mismatch`、`cli_unavailable` 时停止生成，修复原 profile 后自动继续。队首 `attention` 会阻止后续生成，这是保护消费身份的保守策略。
- 未开始的任务默认最多排队 300 秒（`maxQueueWaitSeconds`），过期以 `queue_expired` 失败，不执行生成。排队任务还需要最近的网关轮询租约（`leaseSeconds` 默认 15 秒）；重启不恢复租约，必须由网关继续查询后才允许开始。直接使用桥接 API 的客户端也必须持续查询任务。
- New API 的任务超时必须大于排队上限加 CLI 命令超时，连续轮询失败窗口也必须大于租约（默认 New API 配置满足）。若调小 `TASK_TIMEOUT_MINUTES` 或 `TASK_POLL_MAX_FAILURES`，同步减小桥接排队/租约时间。租约避免长期离线后启动弃单，不是跨服务原子取消：生成提交与网关终止恰好并发时仍可能消费，已提交任务不会自动取消。
- `submission_uncertain`/`status_unavailable`/`manual_recovery_required`：使用存储文件中的 submitId 和 projectId 执行只读 `operation status`，必要时按官方 Skill 恢复。`absent` 不证明从未扣费；不要删除任务或换 ID 重跑。
- `download_failed`：远端可能已经收费，保持任务进行中，修复 CLI 导出/磁盘后自动重试下载。不能据此自动给任务退款或再生成一次。
- 退出码 10（报价未批准）以及明确 rejected/failed 状态会终止任务。登录、网络和其他未知失败保留原任务等待排查。
- 正常 SIGINT/SIGTERM 会等当前 CLI 命令结束并释放锁。异常退出留下 `dataDir/.lock`，先核对文件中的 PID 已退出再删除锁并重启；启动会加载原任务继续只读恢复。
- 固定配置与存储绑定。修改账号、空间、画布、profile 或模型配置时，原目录会拒绝启动；先完成/排查旧任务再迁移，不要为重试不确定任务新建数据目录。
- 默认最多 20 个未完成任务、1000 个持久任务、单文件 512 MiB；可在配置中设置 `maxQueue`、`maxJobs`、`maxMediaBytes`。数据保存在权限 0700 的目录中，包括提示词、任务身份及产物。不会保存即梦凭据和上游响应。没有自动清理/备份，应监控磁盘并在停止服务、确认历史任务不再需要后归档整个目录；丢弃记录会失去幂等保护。
- 图片 URL 是有效期默认 1 小时的下载授权链接（可设置 `mediaTTL`），不包含渠道密钥；不要公开日志中的完整链接。视频走 New API 的鉴权下载接口。桥接服务不支持用户隔离/多租户，不直接把桥接密钥发给终端用户。

## 测试

```sh
npm test
# 在仓库根目录执行，验证真实 New API JS 引擎和现有插件回归：
go test ./plugins
```

测试不消耗即梦积分。视频实测完成前，应把本接入视为开发版本。
