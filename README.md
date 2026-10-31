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
3. **云厂商 IP 段**：AWS、GCP、Google、Cloudflare、Azure、Oracle、DigitalOcean、Linode、Vultr、Fastly 的官方公开段（`src/data/cloud-ranges.json`，二分查找）。
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
src/worker.js            路由、访问者 IP 识别、查询编排、缓存、限流
src/lib/ip.js            IPv4/IPv6 解析、保留地址判断、PTR 名称
src/lib/ranges.js        云厂商 IP 段匹配
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

本地没有 `CF-Connecting-IP`，Worker 会在 `DEV_MODE=true` 时依次使用 `DEV_IP` → ip.sb → ipify 获取本机出口 IP 作为“访问者 IP”。

冒烟测试（需先启动 dev）：

```bash
npm test                                   # 默认测试一组 IP
node scripts/smoke-test.mjs http://127.0.0.1:8787 8.8.8.8 114.222.1.1
```

## 部署到 Cloudflare

```bash
npx wrangler login
npx wrangler deploy
```

### 绑定自定义域名

在 `wrangler.toml` 中取消注释并修改 `routes`：

```toml
routes = [
  { pattern = "checkmyip.example.com", custom_domain = true },
  { pattern = "v4.checkmyip.example.com", custom_domain = true },  # 可选：仅 A 记录
  { pattern = "v6.checkmyip.example.com", custom_domain = true },  # 可选：仅 AAAA 记录
]
```

域名需托管在 Cloudflare。若要用自己的域名做 IPv4 / IPv6 分别检测，可让 `v4.` 子域只有 A 记录、`v6.` 子域只有 AAAA 记录，再把 `public/config.js` 中的 `ipv4` / `ipv6` 地址改为 `https://v4.你的域名/api/ip`、`https://v6.你的域名/api/ip`（前端已兼容 `{ip: ...}` JSON 返回）。

## 更新 IP 段数据

```bash
npm run build:data     # 即 node scripts/build-data.mjs
```

脚本会下载各云厂商公开 IP 段和 Tor 出口列表，合并为最小 CIDR 后写入 `src/data/`。某个来源失败时保留旧数据，并在 `src/data/meta.json` 中记录每个来源的状态。建议每周运行一次后提交并重新部署。

## 环境变量

| 名称 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `GEO_PROVIDERS` | var | `ip.sb,ipwho.is,geojs,ipapi.is,ipinfo,ipapi.co` | 地理接口尝试顺序（另支持 `ip-api`，仅 HTTP） |
| `CACHE_TTL` | var | `21600` | 查询结果缓存秒数 |
| `LOOKUP_TIMEOUT_MS` | var | `3000` | 单个外部请求超时 |
| `LOOKUP_RATE_LIMIT` | var | `30` | 每个 isolate 每分钟允许的查询次数 |
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
- 限流为 isolate 内存级别，不是全局限流；生产环境建议配合 Cloudflare 的 Rate Limiting 规则。
- DNS 泄露检测尚未实现（第二期）。

## 数据来源

AWS `ip-ranges.json`、Google `cloud.json` / `goog.json`、Cloudflare `ips-v4` / `ips-v6`、Microsoft Azure Service Tags、Oracle `public_ip_ranges.json`、DigitalOcean / Linode / Vultr geofeed、Fastly `public-ip-list`、Tor Project 出口列表；地理信息来自 ip.sb、ipwho.is、GeoJS 等免费接口。各数据版权归其提供方所有。
