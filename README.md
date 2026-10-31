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

结果通过 Cache API + 内存 LRU 缓存（默认 6 小时）。查询他人 IP 有每个 isolate 每分钟 30 次的简单限流。

其他接口：`GET /api/health`、`GET /api/meta`（数据更新时间与来源状态）。

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
src/lib/http.js          带超时的 fetch 工具
src/data/*.json          由脚本生成的 IP 段 / Tor 列表 / 元数据（已提交）
scripts/build-data.mjs   下载并合并公开 IP 段数据
scripts/smoke-test.mjs   本地冒烟测试，输出 Markdown 表格
scripts/test-ranges.mjs  IP 段匹配测试（与原始 CIDR 暴力比对）
scripts/test-rules.mjs   ASN / PTR / 评分规则测试
scripts/bench-ranges.mjs 冷启动 CPU 时间测量
public/                  前端页面（index.html、assets/、config.js）
```

## 本地运行

需要 Node.js 18+。

```bash
npm install
cp .dev.vars.example .dev.vars     # 本地开发变量，可设置 DEV_IP 模拟访问者
npx wrangler dev                   # 或 npm run dev（--local 模式）
# 打开 http://127.0.0.1:8787
```

本地没有 `CF-Connecting-IP`，Worker 会在 `DEV_MODE=true` 时依次使用 `DEV_IP` → ip.sb → ipify 获取本机出口 IP 作为“访问者 IP”（仅本地开发使用，线上直接读 `CF-Connecting-IP`）。

模拟所有外部查询失败（检查「数据不完整」状态，仅 `DEV_MODE=true` 时生效）：

```bash
npx wrangler dev --local --var DEV_SIMULATE_FAIL:true
```

单元测试与性能（不需要启动 dev）：

```bash
npm test               # IP 段匹配（与原始 CIDR 暴力比对，约 21 万次检查）+ ASN / PTR / 评分规则
npm run bench          # 冷启动 CPU：每次新开 node 进程导入并做第一次查询
```

冒烟测试（需先启动 dev）：

```bash
npm run smoke                                         # 默认测试一组 IP
node scripts/smoke-test.mjs http://127.0.0.1:8787 8.8.8.8 114.222.1.1
```

## 部署到 Cloudflare

```bash
npx wrangler login
npx wrangler deploy
```

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
4. **前端**：编辑 `public/config.js`，把 `SITE_DOMAIN` 设为 `'ip.mydomain.com'`，前端就会改用 `https://v4.ip.mydomain.com/api/ip` 与 `https://v6.ip.mydomain.com/api/ip`。`SITE_DOMAIN` 为空（或仍是 example.com）时退回 ip.sb 的公共接口。
5. **验证**：`curl -4 https://v4.ip.mydomain.com/api/ip`、`curl -6 https://v6.ip.mydomain.com/api/ip`，以及 `curl -6 https://v4.ip.mydomain.com/api/ip` 应当失败（无 AAAA）。
6. 如果主站与探测子域不是“`v4.` + 主站域名”的关系（例如主站是 `www.mydomain.com`），把主站来源加入 `ALLOWED_ORIGINS`。

### 跨域（CORS）

`/api/*` 默认只允许同源调用。需要让别的网站调用时，在 `wrangler.toml` 的 `ALLOWED_ORIGINS` 写入来源（逗号分隔，含协议），例如 `"https://a.com,https://b.com"`。
不在白名单的跨域来源请求 `/api/ip?ip=…` 会得到 `403 origin_not_allowed`；查询自身 IP（无 `?ip=`）不返回 CORS 头，浏览器会拒绝跨域读取。
注意：CORS 只能阻止**别的网站借访客浏览器**调用接口，curl 等非浏览器客户端可以伪造或省略 `Origin`，所以仍需要限流。

### 限流

Worker 优先使用 Cloudflare 的 **Rate Limiting 绑定**（Workers Rate Limiting API，需 wrangler ≥ 4.36）：

1. 在 `wrangler.toml` 取消注释这一段（`namespace_id` 是你账号内唯一的正整数，写成字符串）：
   ```toml
   [[ratelimits]]
   name = "LOOKUP_LIMITER"
   namespace_id = "1001"
     [ratelimits.simple]
     limit = 30
     period = 60      # 只能是 10 或 60
   ```
   旧版 wrangler 使用的等价写法是 `[[unsafe.bindings]]`：
   ```toml
   [[unsafe.bindings]]
   name = "LOOKUP_LIMITER"
   type = "ratelimit"
   namespace_id = "1001"
   simple = { limit = 30, period = 60 }
   ```
2. 重新部署。代码中检测到 `env.LOOKUP_LIMITER` 时以 `lookup:<访问者 IP>` 为键调用 `limit()`，超限返回 429；响应头 `x-ratelimit-via: binding` 表示使用了绑定。
3. 未配置绑定时退回进程内计数（`x-ratelimit-via: memory`，阈值为 `LOOKUP_RATE_LIMIT`），每个 isolate 独立，只是兜底。

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
| `LOOKUP_RATE_LIMIT` | var | `30` | 未配置限流绑定时，每个 isolate 每分钟允许的查询次数 |
| `ALLOWED_ORIGINS` | var | 空（仅同源） | 允许跨域调用的来源，逗号分隔 |
| `LOOKUP_LIMITER` | ratelimit 绑定 | 未配置 | 可选，Cloudflare Rate Limiting 绑定，见「限流」 |
| `DEV_SIMULATE_FAIL` | var | 未设置 | 仅 `DEV_MODE=true` 时有效：模拟所有外部查询失败 |
| `DEV_MODE` | var | 未设置 | `true` 时忽略 `request.cf`，用于本地开发 |
| `DEV_IP` | var | 未设置 | 本地开发时模拟的访问者 IP |
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
- 未配置 `LOOKUP_LIMITER` 绑定时，限流只是 isolate 内存级别；配置绑定后也是按节点的近似计数。
- 默认未接入任何信誉库（IP 黑名单 / 代理库）。使用代理或 VPN 的家宽 IP 仍可能得到高分，页面与 API（`analysis.reputation`）会明确提示；配置 `IPAPI_IS_KEY` / `PROXYCHECK_KEY` / `ABUSEIPDB_KEY` 后才会参考外部信誉数据。
- 当地理 / ASN 接口全部失败时，结果标记为「数据不完整」（`analysis.incomplete = true`），分数封顶 60、风险至少为「中」，不会误报为“干净”。
- DNS 泄露检测尚未实现（第二期）。

## 数据来源

AWS `ip-ranges.json`、Google `cloud.json` / `goog.json`、Cloudflare `ips-v4` / `ips-v6`、Microsoft Azure Service Tags、Oracle `public_ip_ranges.json`、DigitalOcean / Linode / Vultr geofeed、Fastly `public-ip-list`、Tor Project 出口列表；地理信息来自 ip.sb、ipwho.is、GeoJS 等免费接口。各数据版权归其提供方所有。
