# checkmyip · IP 纯净度检测

一个面向中文用户的 IP 检测网站：查看本站看到的公网 IP、归属地与运营商，判断是**家庭宽带 / 移动网络 / 商业宽带 / 数据中心（机房）**，给出 0–100 的**纯净度参考分**和风险等级，并附带 IPv4/IPv6 双栈检测、WebRTC 泄露检测、浏览器指纹概览和环境一致性提示。

- 全站简体中文，支持浅色 / 深色模式，适配手机。
- 不依赖任何外部 CDN（无 Google Fonts / googleapis），所有前端代码均为本仓库自写，无第三方库。
- 后端是一个 Cloudflare Worker + 静态资源，一条 `wrangler deploy` 即可上线。

> ⚠️ 免责声明：评分基于公开 IP 段、ASN 名单、反向解析和 Tor 出口列表等规则推断，仅供参考，**不代表任何平台（支付、流媒体、AI 服务等）的真实风控结果**。地理位置来自免费公共数据库，可能存在误差。

## 功能

| 模块 | 说明 |
|---|---|
| 我的 IP / 查询 IP | 默认展示访问者 IP，可输入任意公网 IPv4 / IPv6 查询（`/?ip=8.8.8.8` 可直接分享） |
| 纯净度评分 | 0–100 分 + 低 / 中 / 高风险 + 中文扣分明细 |
| 预估多少人在用这个 IP | 按 IP 类型估算共用人数（移动 CGNAT、国内宽带、家宽、校园 / 企业 NAT、VPN / 代理 / Tor、服务器），附置信度与中文理由；前端补充 WebRTC 的 CGNAT 证据；可选 D1「本站观测」设备数，见下文 |
| IPv4 / IPv6 连通性 | 浏览器分别请求仅 IPv4 / 仅 IPv6 的接口，显示两种出口地址 |
| 环境一致性 | 浏览器时区 vs IP 时区、浏览器语言 vs IP 国家、WebRTC 地址 vs HTTP 地址 |
| WebRTC 泄露检测 | 通过 `stun.cloudflare.com:3478`、`stun.miwifi.com:3478` 收集候选地址并对比 |
| 浏览器指纹概览 | UA、屏幕、时区、语言、Canvas、WebGL、字体等，全部在本地计算，不上传 |
| DNS 泄露检测 | 占位，第二期上线（需要自有权威 DNS） |

## 架构

```
浏览器 ──► Cloudflare Worker (src/worker.js)
            ├─ /api/*   → Worker 处理
            └─ 其他路径 → 静态资源 public/（env.ASSETS）
```

`GET /api/ip[?ip=x.x.x.x]` 的判定流程：

1. **访问者 IP**：线上取 `CF-Connecting-IP`，并直接使用 `request.cf` 中的国家 / 城市 / ASN / 时区。
2. **地理与 ASN**：`request.cf` 不可用（查询他人 IP 或本地开发）时，依次尝试免费免 key 的接口：ip.sb → ipwho.is → GeoJS → ipapi.is → ipinfo → ipapi.co（顺序可由 `GEO_PROVIDERS` 配置），每个请求 3 秒超时。
3. **云厂商 IP 段**：AWS、GCP、Google、Cloudflare、Azure、Oracle、DigitalOcean、Linode、Vultr、Fastly 的官方公开段（构建时预处理为互不相交区间 `src/data/cloud-index.json`，运行时一次二分查找）。
4. **ASN 名单**：`src/lib/asn.js` 内置国内外常见运营商、移动网络、教育网、云厂商 / 机房、VPN 厂商的 ASN，以及按名称关键词兜底。
5. **反向解析（PTR）**：通过 DoH（cloudflare-dns.com，失败回退 dns.google）查询，按关键词识别机房 / 静态 / 家宽。
6. **Tor 出口**：在线拉取 Tor Project 出口列表（缓存 1 小时），失败时使用内置列表。
7. **可选商业接口**：配置了 key 时额外查询 ipapi.is、proxycheck.io、AbuseIPDB。
8. **评分**：`src/lib/score.js` 汇总各项信号加减分，输出类型、分数、风险等级、标签和中文说明。

结果通过 Cache API + 内存 LRU 缓存（默认 6 小时）。查询自己 IP、查询他人 IP、本站观测上报分别限流，见「限流」。

其他接口：

- `GET /api/health`：版本、各限流桶使用的是绑定还是进程内兜底（`rateLimit.*.mode = binding | memory | memory-dev`）、限流键口径（`rateLimitKey`）、本站统计是否启用及每日上限（`seen.dailyNewDeviceCap`），以及 `warnings` 数组（缺少绑定、未配置 D1 / 盐时会列出）。
- `GET /api/meta`：数据更新时间与来源状态。
- `POST /api/seen`：本站观测上报，见「预估多少人在用这个 IP」。

## 预估多少人在用这个 IP

页面上的「预估多少人在用这个 IP」卡片和 `/api/ip` 返回中的 `sharing` 对象：

```json
"sharing": {
  "kind": "cgnat_mobile",
  "label": "约 10–100+ 人（运营商级 NAT）",
  "range": { "min": 10, "max": null },
  "confidence": "medium", "confidenceText": "中",
  "reasons": ["…中文理由…"],
  "note": "这是根据 IP 类型推测的估算，不是实际统计；…",
  "observed": { "shown": true, "enabled": true, "devices30d": 4, "devices7d": 3, "scope": "ip" }
}
```

**这是估算，不是统计。** 运营商是否做 NAT、一个出口背后有多少用户，从外部无法准确得知。规则（`src/lib/sharing.js`，按顺序命中）：

| 情况 | 输出 | 置信度 |
|---|---|---|
| Tor 出口 | 可能数百人（公共出口 / Tor） | 中 |
| VPN 厂商 ASN，或外部接口标记为代理 / VPN | 可能数百人（公共出口 / 代理） | 中 / 低 |
| 云厂商段 / 机房 ASN | 未知（服务器 IP，若用作代理出口则可能多人） | 低 |
| 数据不完整 / 无法分类 | 无法估算 | 低 |
| 移动网络 ASN（含中国移动 IPv4，按 ASN 命中） | 约 10–100+ 人（运营商级 NAT） | 中（按名称猜测时为低） |
| 教育网 | 可能数百人（校园网 / 机构 NAT） | 中 |
| 商业宽带 / 骨干 / PTR 含 static 等 | 约 1–数百人（企业 / 机构出口，规模未知） | 低 |
| 国内固网宽带（电信 / 联通等 IPv4） | 约 1–数十人（可能共享出口） | 低 |
| 家宽且 PTR 内嵌该 IP（每户一条反解） | 约 1–5 人（单户家庭） | 中 |
| 家宽且 PTR 为住宅关键词（不含 IP） | 约 1–5 人（单户家庭） | 低 |
| ASN 不在内置库，但 PTR 为宽带用户写法（见下） | 按家宽估算（通常约 1–5 人） | 低 |
| 其他家宽 | 约 1–10 人（家庭或小型网络） | 低 |
| IPv6 家宽 | 约 1–5 人（单户家庭） | 中 |

**ASN 不在内置库时看 PTR**：内置 ASN 库只收录了大运营商和云厂商，很多地区性家宽运营商（如瑞士 Init7 AS13030、Sunrise AS6730）不在库里。此时如果反向解析是宽带用户类写法，就按家庭宽带估算，置信度固定为「低」。例：`85-195-230-77.fiber7.init7.net`、`77-57-100-20.dclient.hispeed.ch`、`adsl-84-226-12-34.adslplus.ch` → 约 1–5 人；`dns9.quad9.net`（AS19281 在库内，为数据中心）不受影响。

PTR 规则（`src/lib/asn.js` 的 `classifyPtr`）按**词**匹配，不做子串匹配：

1. 先把 PTR 按 `.` / `-` / `_` / 数字切成字母词（`fiber7` → `fiber`，`hsd1` → `hsd`）。
2. **机房词优先** → 判为数据中心：`server` / `srv` / `vps` / `vds` / `hosting` / `hosted` / `colo` / `dedicated` / `baremetal` / `datacenter` / `cloud` / `compute` / `ec2` 以及容器平台 `gke` / `aks` / `eks` / `k8s` / `kube` / `kubernetes` / `cluster`（另有已知云域名列表）。
3. `static` 等 → 静态（商业）。
4. **排除词**：出现 `vpn` / `proxy` / `node` / `mail` / `mx` / `smtp` / `host` / `ns` / `dns` / `www` / `web` / `relay` / `tor` / `exit` / `cdn` / `edge` / `gw` / `gateway` / `router` / `core` / `nat` / `vm` / `worker` 等服务 / 平台类词时，**不判家宽**（也不足以判机房，结果为「无信号」）。很多运营商用 `host-1-2-3-4` 命名家宽，所以 `host` 只排除、不算机房。
5. 家宽词必须是**整词**：`ppp` / `pppoe` / `adsl` / `dsl` / `vdsl` / `xdsl` / `cable` / `kabel` / `dyn` / `dynamic` / `dynip` / `pool` / `dhcp` / `broadband` / `fiber` / `fibre` / `ftth` / `cust` / `customer(s)` / `client(s)` / `subscriber` / `user(s)` / `cpe` / `home` / `residential` / `dialup` / `hsd` / `hsi` / `mobile` 等；或者是能**完整拆成**家宽词 + 常见后缀（`d` / `s` / `x` / `plus` / `ip` / `modem` / `net` / `line`）的复合词，如 `dclient`、`adslplus`、`cablemodem`。拆不完的不算：`fiberhost`、`liverpool`、`dyndns`、`poolside` 都**不**命中。

反例（测试覆盖）：`vpn-pool-1.example.net` → 无信号；`gke-prod-default-pool-…` → 数据中心；`fiberhost-1.example.net` → 无信号；`mx.dynect.net` → 无信号；`proxy-7.pool…` / `node-12.dsl…` / `mail.cable…` / `host-1-2-3-4.dsl…` → 无信号。

**外部数据说是机房时不按家宽估算**：配置了 `IPAPI_IS_KEY` 后，如果 ipapi.is 标记该 IP 为数据中心（`is_datacenter`），而 PTR 看起来像家宽，则以外部数据为准：ASN 不在内置库 → 类型判为数据中心、PTR 不加分，人数显示「服务器 IP」（不显示 1–5 人）；ASN 在库内且为家宽运营商 → 类型为商业宽带（低），人数显示「无法估算（外部数据标记为机房）」。移动网络不受此规则影响。外部请求失败（`ok=false`）时忽略。

国内运营商常给整段地址批量生成 PTR，因此国内宽带即使 PTR 内嵌 IP 也不会被当作“单户”证据。同一 ASN 下电信 / 联通的移动与固网无法区分。

**前端补充证据**（`public/assets/app.js` 的 `cgnatEvidence()`）：WebRTC 收集到 `100.64.0.0/10`（RFC 6598 共享地址）候选，或 WebRTC 看到的公网 IPv4 与 HTTP / IPv4 探测地址不一致时，卡片会显示“发现 CGNAT 迹象”；没发现也不代表没有 NAT。

### 本站观测（D1，可选）

在配置了 D1 和盐后，页面会把**浏览器指纹哈希**上报到 `POST /api/seen`，Worker 统计“最近 30 天 / 7 天有多少个不同的浏览器指纹从你这个 IP 访问过本站”。

- **存什么**：只存三列：`ip_hash`、`fp_hash`、`day`（UTC 日期）。`ip_hash = HMAC-SHA256(IP_HASH_SALT, "v4:<IP>")`（IPv6 按 /64 前缀：`"v6/64:<前缀>"`），`fp_hash = HMAC-SHA256(IP_HASH_SALT, "fp:<指纹哈希>")`，各截取 128 位。不存原始 IP、指纹明细、UA、时间戳或 Cookie。指纹哈希本身由浏览器本地计算（UA、屏幕、时区、语言、Canvas、WebGL、字体等拼接后取 64 位哈希）。
- **去重**：主键 `(ip_hash, fp_hash, day)`，同一设备同一天重复访问只算一行。
- **每日上限**：同一 `ip_hash`（IPv4 单个地址 / IPv6 同一 /64）每天最多新记录 `SEEN_DAILY_CAP` 个指纹（默认 30），防止脚本伪造指纹刷高设备数、刷写入额度。先读当天行数，满额直接返回、不写；写入语句本身带条件（`INSERT … SELECT … WHERE 当天行数 < 上限`），并发请求也不会超额；满额后本 isolate 记住该 IP 当天已满，之后只做一次主键点查（判断这个浏览器是否早已计入），**不再写 D1**。响应带 `capped` / `alreadyCounted`，`observed.dailyCap` / `observed.cappedToday`，页面会注明「今天这个 IP 上新出现的浏览器已达上限」。
- **全站每日上限**：全站当天新写入的 `ip_seen` 行数达到 `SEEN_GLOBAL_DAILY_CAP`（默认 15000）后，**当天暂停统计**，UTC 0 点（北京时间 8 点）自动恢复。计数放在 `seen_daily(day, n)` 计数器表（迁移 `0002_seen_daily.sql`；只有日期和数字，不含 IP / 指纹），每成功写入一行 +1；检查时与单 IP 计数在同一条查询里按主键读 1 行，不做 `COUNT(*)` 全天扫描；写入语句也带「计数器 < 上限」条件，并发不会超额；暂停后本 isolate 记住，之后只做主键点查、不读计数器、不写。暂停时 `POST /api/seen` 仍返回 200：`{ ok: true, recorded: false, paused: true, pausedReason: "global_cap", message: "本站统计今日已暂停…IP 检测不受影响" }`，`observed.pausedToday = true`；页面在「本站观测」处注明，**IP 检测、评分、人数类型估算完全不受影响**。`/api/health` 的 `seen.globalDailyCap` / `seen.pausedToday` 可查看当前设置。
  - **为什么默认 15000 而不是 5 万**：D1 免费额度是每天 10 万「写入行」，并且**索引行、DELETE 都计入**（[D1 定价](https://developers.cloudflare.com/d1/platform/pricing/)）。每新增 1 行 ≈ 表 1 + `day` 索引 1 + 计数器 1 = 3 行写入，30 天后清理删除 ≈ 再 2 行；15000 × 3 + 15000 × 2 ≈ 7.5 万行 / 天（最坏情况），留出余量。付费计划可以调高。
  - 没有做按 /48 的单独上限：单 IP（IPv6 按 /64）上限 + 严格限流 + 全站上限已能兜住写入额度，再加一个 /48 计数器每次写入还要多写 1 行。
- **保留**：只保留最近 30 天。每天 cron（`17 19 * * *` UTC）清理，另外每个 isolate 每小时在上报时顺带清理一次。
- **谁能看到**：只对“查询自己 IP”展示；`/api/ip?ip=其他IP` 永远不返回观测数（`observed.shown = false`）。
- **调用限制**：`/api/seen` 只接受同源 `POST`（`Origin` 必须与本站一致，`Sec-Fetch-Site` 若存在须为 `same-origin`，`content-type: application/json`，请求体 ≤ 512 字节），并有独立的严格限流（IPv6 按 /64 计）。
- **含义**：这是“本站见过的不同浏览器数”，不是这个 IP 的真实用户数。同一人换浏览器、清理数据会多算；没访问过本站的人不会被算进去。
- **默认关闭**：`wrangler.toml` 里的 `[[d1_databases]]` 默认是注释掉的。没有 D1 绑定、表不存在或没有设置盐（少于 16 个字符视为未设置）时，页面显示「本站统计未启用」（表缺失 / 查询出错时为「本站统计暂时不可用」，`error: "db_error"`），其余功能照常，不会写入任何东西，也不会用未加盐的哈希。

启用步骤见「部署到 Cloudflare」。更换盐会让旧数据无法再与新访问对应（相当于重新计数）。

本地测试（不用改 `wrangler.toml`）：

```bash
npm run db:migrate:local    # 生成 wrangler.local-d1.toml（已 gitignore，D1 段已启用、本地用全 0 ID），再对本地库执行迁移
npm run dev:d1              # 用 wrangler.local-d1.toml 启动 wrangler dev --local
# .dev.vars 里需要有 IP_HASH_SALT（.dev.vars.example 已带一个本地用的值）
# 模拟多个设备（fp 为 8–64 位十六进制）：
curl -X POST http://127.0.0.1:8787/api/seen -H 'Origin: http://127.0.0.1:8787' \
     -H 'content-type: application/json' -d '{"fp":"a1b2c3d4e5f60718"}'
curl http://127.0.0.1:8787/cdn-cgi/local/scheduled   # 手动触发清理 cron
```

## 目录结构

```
wrangler.toml            Worker 与静态资源配置
src/worker.js            路由、访问者 IP 识别、查询编排、缓存、CORS 白名单、限流、v4/v6 探测子域
src/lib/ip.js            IPv4/IPv6 解析、保留地址判断、PTR 名称
src/lib/ranges.js        云厂商 IP 段匹配（读取预计算索引，单次二分）
src/lib/asn.js           ASN 名单与关键词分类、PTR 关键词
src/lib/geo.js           免费地理接口适配与合并
src/lib/ptr.js           DoH 反向解析
src/lib/tor.js           Tor 出口列表
src/lib/external.js      可选商业风控接口（需要 key）
src/lib/score.js         纯净度评分
src/lib/sharing.js       预估共用人数
src/lib/seen.js          D1 观测：HMAC、写入、计数、清理
src/lib/http.js          带超时的 fetch 工具
src/data/*.json          由脚本生成的 IP 段 / Tor 列表 / 元数据（已提交）
scripts/build-data.mjs   下载并合并公开 IP 段数据
scripts/smoke-test.mjs   本地冒烟测试，输出 Markdown 表格
scripts/test-ranges.mjs  IP 段匹配测试（与原始 CIDR 暴力比对）
scripts/test-rules.mjs   ASN / PTR / 评分规则测试
scripts/test-sharing.mjs 共用人数估算规则测试
scripts/test-seen.mjs    D1 观测计数测试（node:sqlite 模拟 D1，执行真实迁移）
scripts/stamp-assets.mjs 给 index.html 中的静态资源加 ?v=<内容哈希>
migrations/              D1 表结构
scripts/bench-ranges.mjs 冷启动 CPU 时间测量
public/                  前端页面（index.html、assets/、config.js）
```

## 本地运行

需要 Node.js 18+（`npm test` 中的 D1 计数测试使用 `node:sqlite`，需要 Node.js 22.5+）。

```bash
npm install
cp .dev.vars.example .dev.vars     # 本地开发变量：DEV_IP（模拟访问者）、RATE_LIMIT_MULTIPLIER 等
npm run dev                        # 盖资源版本号后 wrangler dev --local（不绑定 D1）；带 D1 用 npm run dev:d1
# 打开 http://127.0.0.1:8787
```

本地没有真实的 `CF-Connecting-IP`（`wrangler dev` 给的是 127.0.0.1），`DEV_MODE=true` 时 Worker 用 `DEV_IP` 作为“访问者 IP”；没有设置时，「查询自己的 IP」返回错误并提示在 `.dev.vars` 设置 `DEV_IP`。**不会**再向 ip.sb / ipify 等第三方查询本机出口 IP（线上直接读 `CF-Connecting-IP`）。

本地放宽限流：`.dev.vars` 里设置 `RATE_LIMIT_MULTIPLIER=10`（`.dev.vars.example` 已带）。仅在 `DEV_MODE=true` 时生效：三个桶的阈值 ×N（最多 ×1000），并改用进程内计数（绑定的阈值写死在 `wrangler.toml`，运行时无法放大）；`/api/health` 的 `rateLimit.*.mode` 显示 `memory-dev`，`warnings` 中会注明。线上不要设置。

模拟所有外部查询失败（检查「数据不完整」状态，仅 `DEV_MODE=true` 时生效）：

```bash
npx wrangler dev --local --var DEV_SIMULATE_FAIL:true
```

单元测试与性能（不需要启动 dev）：

```bash
npm test               # IP 段匹配（约 21 万次检查）+ ASN / PTR / 评分规则 + 共用人数估算 + D1 计数与每日上限 + 限流键（IPv6 /64）+ 资源版本号检查
npm run bench          # 冷启动 CPU：每次新开 node 进程导入并做第一次查询
```

冒烟测试（需先启动 dev）：

```bash
npm run smoke                                         # 默认测试一组 IP；有错误或命中 429 时退出码为 1（需 RATE_LIMIT_MULTIPLIER ≥ 2）
node scripts/smoke-test.mjs http://127.0.0.1:8787 8.8.8.8 114.222.1.1
```

## 部署到 Cloudflare

```bash
npx wrangler login
npm run deploy                       # 先盖资源版本号再 wrangler deploy；默认不绑定 D1，可直接部署
```

`wrangler.toml` 不含任何占位 `database_id`（旧版的全 0 UUID 会让 `wrangler deploy` 报错 10021）。也没有依赖 wrangler 的 D1 自动创建：在 TOML 配置下它不会把创建出的 ID 写回文件，之后 `wrangler d1 migrations apply --remote` 找不到 `database_id` 而失败。

**启用「本站观测」（可选）**：

```bash
npx wrangler d1 create checkmyip                       # 1. 记下输出里的 database_id
#                                                        2. 编辑 wrangler.toml：把「# >>> D1 BEGIN」与「# <<< D1 END」之间
#                                                           5 行开头的 "# " 去掉，database_id 换成第 1 步的 ID
npm run db:migrate:remote                              # 3. 即 wrangler d1 migrations apply checkmyip --remote
#                                                        （从 v0.3.1 升级：也要重跑这一步，应用新增的 0002_seen_daily.sql；
#                                                         未应用时「本站观测」会显示暂时不可用，IP 检测不受影响）
openssl rand -hex 32 | npx wrangler secret put IP_HASH_SALT   # 4. ≥16 字符的随机盐
npm run deploy                                         # 5.
```

部署后访问 `/api/health`：`seen.enabled` 应为 `true`；为 `false` 时 `seen.reason` 会说明原因（`no_db` / `no_salt`）。

### 静态资源缓存与版本号

`public/_headers` 让 `/assets/*` 长期缓存（`max-age=31536000, immutable`），`index.html` 中引用的 CSS / JS / `config.js` 都带 `?v=<内容哈希前 10 位>`，图标 `icons.svg` 的版本号由 `app.js` 从 `<meta name="checkmyip-asset-version">` 读取。**修改 `public/assets/*` 或 `public/config.js` 后必须运行**：

```bash
npm run build:assets   # 即 node scripts/stamp-assets.mjs，重写 index.html 中的 ?v=
```

`npm run dev` / `npm run deploy` 会自动执行；`npm test` 会检查版本号是否最新（`--check`），忘记运行时测试失败。

### 绑定自定义域名

`wrangler.toml` 中的 `routes` 是**模板**，默认注释，`checkmyip.example.com` 只是占位符。域名必须已托管在 Cloudflare（NS 指向 Cloudflare）。以下用 `ip.mydomain.com` 举例：

1. **主站**：在 `wrangler.toml` 取消注释 `routes`，把三处 `checkmyip.example.com` 换成 `ip.mydomain.com`：
   ```toml
   routes = [
     { pattern = "ip.mydomain.com", custom_domain = true },
     { pattern = "v4.ip.mydomain.com", custom_domain = true },
     { pattern = "v6.ip.mydomain.com", custom_domain = true },
   ]
   ```
2. **部署**：`npx wrangler deploy`。`custom_domain = true` 会让 Cloudflare 自动为这三个主机名创建 DNS 记录和证书。
3. **v4 / v6 子域只保留单栈**：在 Cloudflare 控制台 → 该域名 → DNS → 记录 中检查：
   - `v4.ip.mydomain.com`：只保留 **A** 记录，删除 AAAA 记录；
   - `v6.ip.mydomain.com`：只保留 **AAAA** 记录，删除 A 记录。

   这样浏览器访问 `v4.` 时只能走 IPv4、访问 `v6.` 时只能走 IPv6。Worker 对 `v4.*` / `v6.*` 主机名只提供极简接口 `GET /api/ip` → `{"ok":true,"ip":"…","version":4}`，并自动允许主域名跨域调用。
   如果控制台不允许修改 Custom Domain 自动生成的记录，可改为：先手动创建 `v4`（仅 A，值随便填如 `192.0.2.1`，开启代理/橙色云）和 `v6`（仅 AAAA，如 `100::`，开启代理），再把这两条改用 `routes = [{ pattern = "v4.ip.mydomain.com/*", zone_name = "mydomain.com" }, …]` 的普通路由方式绑定。
4. **前端**：编辑 `public/config.js`，把 `SITE_DOMAIN` 设为 `'ip.mydomain.com'`，前端会**依次**尝试 `https://v4.ip.mydomain.com/api/ip` → `https://api-ipv4.ip.sb/jsonip`（IPv6 同理）。如果自有子域失败，或者返回了**错误协议族**的地址（例如 v4 子域因为还有 AAAA 记录而返回了 IPv6），前端会跳过它并尝试下一个，ip.sb 始终是最后的兜底。`SITE_DOMAIN` 为空（或仍是 example.com）时直接使用 ip.sb。改完运行 `npm run build:assets`。
5. **验证**：`curl -4 https://v4.ip.mydomain.com/api/ip`、`curl -6 https://v6.ip.mydomain.com/api/ip`，以及 `curl -6 https://v4.ip.mydomain.com/api/ip` 应当失败（无 AAAA）。
   **DNS 注意事项**：`v4.` 必须只有 A、`v6.` 必须只有 AAAA。开启代理（橙色云）的记录由 Cloudflare 边缘应答，某些设置下（如区域开启了 IPv6 兼容性）边缘仍可能对外同时提供 A 和 AAAA，导致“单栈”子域实际是双栈；用 `dig A v6.ip.mydomain.com`、`dig AAAA v4.ip.mydomain.com` 确认应无结果。即使配置有误，前端也会丢弃错误协议族的结果并回退到 ip.sb，只是不再使用自有接口。
6. 如果主站与探测子域不是“`v4.` + 主站域名”的关系（例如主站是 `www.mydomain.com`），把主站来源加入 `ALLOWED_ORIGINS`。

### 跨域（CORS）

`/api/*` 默认只允许同源调用。需要让别的网站调用时，在 `wrangler.toml` 的 `ALLOWED_ORIGINS` 写入来源（逗号分隔，含协议），例如 `"https://a.com,https://b.com"`。
不在白名单的跨域来源请求 `/api/ip?ip=…` 会得到 `403 origin_not_allowed`；查询自身 IP（无 `?ip=`）不返回 CORS 头，浏览器会拒绝跨域读取。
注意：CORS 只能阻止**别的网站借访客浏览器**调用接口，curl 等非浏览器客户端可以伪造或省略 `Origin`，所以仍需要限流。

### 限流

`wrangler.toml` **默认启用**三个 Cloudflare Rate Limiting 绑定（Workers Rate Limiting API，需 wrangler ≥ 4.36）：

| 绑定 | 用途 | 默认 | 键 |
|---|---|---|---|
| `SELF_LIMITER` | 查询自己的 IP（`/api/ip`） | 60 次 / 60 秒（宽松） | `self:<访问者键>` |
| `LOOKUP_LIMITER` | 查询其他 IP（`/api/ip?ip=`） | 20 次 / 60 秒（较严） | `lookup:<访问者键>` |
| `SEEN_LIMITER` | 本站观测上报（`POST /api/seen`） | 10 次 / 60 秒（严格） | `seen:<访问者键>` |

**访问者键**取自 `CF-Connecting-IP`：IPv4 为单个地址（`v4:<IP>`），**IPv6 为所在 /64**（`v6/64:<前 64 位>`）。一户家宽 / 一台 VPS 通常分到整段 /64 甚至更大，按单个 IPv6 地址计数可以随手换地址绕过限流；绑定和进程内兜底用的是同一个键（`src/lib/ratelimit.js` 的 `limiterKey()`，与本站观测的 `ip_hash` 口径一致）。

```toml
[[ratelimits]]
name = "LOOKUP_LIMITER"
namespace_id = "1002"      # 账号内唯一的正整数，写成字符串
  [ratelimits.simple]
  limit = 20
  period = 60              # 只能是 10 或 60
```

超限返回 `429`（`retry-after: 60`）；响应头 `x-ratelimit-via: binding` 表示使用了绑定。`wrangler dev --local` 会在本地模拟这些绑定。

如果删掉了某个绑定（或旧版 wrangler 不支持），Worker 会退回进程内计数（`x-ratelimit-via: memory`，阈值来自 `SELF_RATE_LIMIT` / `LOOKUP_RATE_LIMIT` / `SEEN_RATE_LIMIT`），每个 isolate 独立、可被轻易绕过；此时每个桶会 `console.warn` **一次**（`wrangler tail` 可见），并在 `GET /api/health` 的 `rateLimit.<桶>.mode = "memory"` 和 `warnings` 中列出。旧版 wrangler 的等价写法是 `[[unsafe.bindings]]`（`type = "ratelimit"`，`simple = { limit = 20, period = 60 }`）。

绑定的计数按 Cloudflare 节点分别统计、为近似值；需要全局严格限流请改用 Durable Objects 或在控制台配置 WAF Rate Limiting 规则。

## 更新 IP 段数据

```bash
npm run build:data     # 即 node scripts/build-data.mjs
```

脚本会下载各云厂商公开 IP 段和 Tor 出口列表，合并为最小 CIDR 后写入 `src/data/cloud-ranges.json`（便于人工查看与测试），并生成运行时索引 `src/data/cloud-index.json`：把所有厂商（含互相嵌套的 Google / GCP 段）切分成**已排序、互不相交**的区间，每段记录覆盖它的厂商集合；IPv4 存数字，IPv6 存定宽十六进制字符串（字典序即数值序）。Worker 运行时不做任何排序或构建，一次二分查找即可，IPv6 只在查询 IPv6 时才转换键值。某个来源失败时保留旧数据，并在 `src/data/meta.json` 中记录每个来源的状态。建议每周运行一次后提交并重新部署。

## 环境变量

| 名称 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `GEO_PROVIDERS` | var | `ip.sb,ipwho.is,geojs,ipapi.is,ipinfo,ipapi.co` | 地理接口尝试顺序（另支持 `ip-api`，仅 HTTP） |
| `CACHE_TTL` | var | `21600` | 查询结果缓存秒数 |
| `LOOKUP_TIMEOUT_MS` | var | `3000` | 单个外部请求超时 |
| `SELF_RATE_LIMIT` | var | `60` | 缺少 `SELF_LIMITER` 绑定时的进程内兜底阈值（次 / 分钟） |
| `LOOKUP_RATE_LIMIT` | var | `20` | 缺少 `LOOKUP_LIMITER` 绑定时的兜底阈值 |
| `SEEN_RATE_LIMIT` | var | `10` | 缺少 `SEEN_LIMITER` 绑定时的兜底阈值 |
| `SEEN_DAILY_CAP` | var | `30` | 本站观测：每个 IP（IPv6 按 /64）每天最多新记录的浏览器指纹数（1–1000） |
| `SEEN_GLOBAL_DAILY_CAP` | var | `15000` | 本站观测：全站每天最多新写入的行数（1–10000000），达到后当天暂停统计、IP 检测不受影响；见「本站观测」 |
| `RATE_LIMIT_MULTIPLIER` | var | 未设置 | 仅 `DEV_MODE=true` 时有效：本地放宽限流 ×N（最多 1000）并改用进程内计数 |
| `ALLOWED_ORIGINS` | var | 空（仅同源） | 允许跨域调用的来源，逗号分隔 |
| `SELF_LIMITER` / `LOOKUP_LIMITER` / `SEEN_LIMITER` | ratelimit 绑定 | 已启用 | 见「限流」 |
| `DB` | D1 绑定 | 默认注释掉（不启用） | 本站观测；启用步骤见「部署到 Cloudflare」 |
| `IP_HASH_SALT` | secret | — | 本站观测的 HMAC 盐，至少 16 个字符；未设置时观测功能关闭 |
| `DEV_SIMULATE_FAIL` | var | 未设置 | 仅 `DEV_MODE=true` 时有效：模拟所有外部查询失败 |
| `DEV_MODE` | var | 未设置 | `true` 时忽略 `request.cf`，用于本地开发 |
| `DEV_IP` | var | 未设置 | 本地开发时模拟的访问者 IP（本地「查询自己的 IP」必需，不再自动查询本机出口 IP） |
| `IPAPI_IS_KEY` | secret | — | 可选，ipapi.is |
| `PROXYCHECK_KEY` | secret | — | 可选，proxycheck.io |
| `ABUSEIPDB_KEY` | secret | — | 可选，AbuseIPDB 滥用评分 |
| `IPINFO_TOKEN` | secret | — | 可选，ipinfo.io |

设置 secret：`npx wrangler secret put PROXYCHECK_KEY`。本地开发写入 `.dev.vars`。

## 已知限制

- 免费地理接口有频率限制，地区 / 城市名称多为英文；国家名通过 `Intl.DisplayNames` 转为中文。
- 阿里云、腾讯云、华为云等国内云厂商没有公开的 IP 段文件，只能依靠 ASN 名单识别。
- 1.1.1.1 等 Cloudflare 自有服务地址不在其公布的代理段中，仅通过 ASN 识别为数据中心。
- 中国移动等运营商同一 ASN 同时承载家庭宽带和 4G/5G，无法精确区分，页面会给出提示。
- 缺少限流绑定时，限流只是 isolate 内存级别；配置绑定后也是按节点的近似计数。
- 不在内置 ASN 库中的网络：完全无法识别时扣 10 分、标记「未知网络」并附说明（内置库只收录大运营商和云厂商，很多地区性家宽也会落到这里）；这一项**单独不会抬高风险等级**（计算风险时把这 10 分加回），置信度为「低」；PTR 为宽带用户写法时类型判为家庭宽带。按名称关键词猜到类型时，置信度固定为「低」，并注明「该 ASN 不在内置库中，类型按名称推测」，未识别为风险的关键词网络也会扣 5 分。
- 「预估多少人在用这个 IP」只是按类型的估算；本站观测数只统计访问过本站的浏览器，两者都不是真实用户数。
- 默认未接入任何信誉库（IP 黑名单 / 代理库）。使用代理或 VPN 的家宽 IP 仍可能得到高分，页面与 API（`analysis.reputation`）会明确提示；配置 `IPAPI_IS_KEY` / `PROXYCHECK_KEY` / `ABUSEIPDB_KEY` 后才会参考外部信誉数据。
- 当地理 / ASN 接口全部失败时，结果标记为「数据不完整」（`analysis.incomplete = true`），分数封顶 60、风险至少为「中」，不会误报为“干净”。
- DNS 泄露检测尚未实现（第二期）。

## 数据来源

AWS `ip-ranges.json`、Google `cloud.json` / `goog.json`、Cloudflare `ips-v4` / `ips-v6`、Microsoft Azure Service Tags、Oracle `public_ip_ranges.json`、DigitalOcean / Linode / Vultr geofeed、Fastly `public-ip-list`、Tor Project 出口列表；地理信息来自 ip.sb、ipwho.is、GeoJS 等免费接口。各数据版权归其提供方所有。
