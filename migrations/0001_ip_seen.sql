-- 「本站观测到的设备数」：只存哈希，不存原始 IP / 原始指纹
-- ip_hash：HMAC-SHA256(IP_HASH_SALT, "v4:<IPv4>" 或 "v6/64:<IPv6 前 64 位>") 的前 16 字节（32 位十六进制）
-- fp_hash：HMAC-SHA256(IP_HASH_SALT, "fp:<浏览器端指纹哈希>") 的前 16 字节
-- day：UTC 日期 YYYY-MM-DD；同一 IP + 同一指纹每天只记一行
CREATE TABLE IF NOT EXISTS ip_seen (
  ip_hash TEXT NOT NULL,
  fp_hash TEXT NOT NULL,
  day     TEXT NOT NULL,
  PRIMARY KEY (ip_hash, fp_hash, day)
) WITHOUT ROWID;

-- 按日期清理 30 天前的数据
CREATE INDEX IF NOT EXISTS idx_ip_seen_day ON ip_seen (day);
