// M0 验证用测试内容生成器：真实中文 + 混合语法结构，M3 起由正式 fixtures 接替

export function buildSampleMarkdown(): string {
  return `---
title: Redis 笔记
---

Redis 是一个基于内存的数据结构服务器，常用作缓存与消息中间件。

# Redis

<!-- recall:block:11111111-2222-4333-8444-555555555555 -->

Redis 是一个基于内存的数据结构服务器。

## RDB

<!-- recall:block:aaaaaaa1-2222-4333-8444-555555555555 -->

RDB 是 Redis 的一种持久化机制。
它通过 fork 创建子进程生成快照。

\`\`\`text
## 这行在代码块里，不是标题
trigger: save 900 1
\`\`\`

## AOF

AOF 记录写命令，追加到日志文件。

> ## 引用里的标题，属于直属正文，不划块

### 追加模式

- everysec：每秒刷盘
- always：每条命令都落盘

| 模式 | 速度 | 安全性 |
| --- | --- | --- |
| everysec | 快 | 中 |
| always | 慢 | 高 |

---

## 发布订阅

与消息队列的区别在于不持久化消息。
`;
}

export function buildLargeDocument(lines = 50_000): string {
  // 每 50 行一个段：1 个标题 + 中文段落 + 列表 + 代码 + 引用
  const out: string[] = [];
  let section = 0;
  while (out.length < lines) {
    section++;
    out.push(`## 第 ${section} 节 · 缓存淘汰策略`);
    out.push("");
    out.push(`<!-- recall:block:00000000-0000-4000-8000-${String(section).padStart(12, "0")} -->`);
    out.push("");
    out.push(`第 ${section} 节说明：当内存达到 maxmemory 时，Redis 按 ${section % 2 === 0 ? "allkeys-lru" : "volatile-lru"} 策略淘汰键。`);
    out.push("LRU 近似实现通过随机采样若干候选键，淘汰其中最久未使用者。");
    out.push("");
    out.push(`- 参数 ${section}：采样数量，越大越接近真实 LRU`);
    out.push("- 淘汰不阻塞主线程，由同步路径逐个执行");
    out.push("- 惰性删除与定期删除配合，避免过期键堆积");
    out.push("");
    out.push("```text");
    out.push(`# 配置示例（第 ${section} 节），行首井号位于代码块内`);
    out.push("maxmemory 256mb");
    out.push("maxmemory-policy allkeys-lru");
    out.push("```");
    out.push("");
    out.push("> 引用：LFU 策略按访问频率计数，适合热点明显的负载。");
    out.push("");
  }
  return out.slice(0, lines).join("\n");
}
