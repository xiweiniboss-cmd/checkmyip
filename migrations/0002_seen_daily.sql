-- 全站每日新增行计数（v0.3.2）：保护 D1 免费额度（每天 10 万行写入，索引行也计入）
-- 每成功写入一行 ip_seen 就 +1；读取只需按主键点查 1 行，比 COUNT(*) 当天行数便宜得多
-- 不含任何 IP / 指纹信息，只有日期和数字；与 ip_seen 一起按 30 天清理
CREATE TABLE IF NOT EXISTS seen_daily (
  day TEXT NOT NULL PRIMARY KEY,
  n   INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
