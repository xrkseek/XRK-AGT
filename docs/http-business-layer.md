# HTTP 业务层

> **文件位置**：`src/utils/http-business.js`  
> **说明**：本文档详细介绍了XRK-AGT框架的HTTP业务层功能，包括重定向、CDN支持、反向代理增强等

HTTP业务层（`HTTPBusinessLayer`）是XRK-AGT框架的核心HTTP功能模块，统一管理重定向、CDN支持和反向代理增强功能。

### 核心特性

- ✅ **重定向管理**：配置化HTTP重定向规则（301/302/307/308）
- ✅ **CDN支持**：静态资源CDN回源、缓存控制、CDN头部处理
- ✅ **反向代理增强**：负载均衡、健康检查、故障转移
- ✅ **配置驱动**：通过YAML配置文件管理所有功能
- ✅ **灵活路由**：支持多种负载均衡算法

---

## 📚 目录

- [概述](#概述)
- [实际应用场景](#实际应用场景)
- [重定向功能](#重定向功能)
- [CDN支持](#cdn支持)
- [反向代理增强](#反向代理增强)
- [配置说明](#配置说明)
- [运行时依赖](#运行时依赖)
- [最佳实践](#最佳实践)

---

## 概述

HTTP业务层（`HTTPBusinessLayer`）是XRK-AGT框架的核心HTTP功能模块，统一管理：

- **重定向管理**：配置化HTTP重定向规则（301/302/307/308）
- **CDN支持**：静态资源CDN回源、缓存控制、CDN头部处理
- **反向代理增强**：负载均衡、健康检查、故障转移

### 架构设计

```mermaid
flowchart LR
    Request["🌐 HTTP请求<br/>进入业务层"] --> Business["💼 HTTP业务层<br/>HTTPBusinessLayer<br/>统一管理"]
    
    Business --> Redirect["🔄 重定向管理器<br/>RedirectManager<br/>规则匹配"]
    Business --> CDN["🌍 CDN管理器<br/>CDNManager<br/>回源识别"]
    Business --> Proxy["⚖️ 反向代理管理器<br/>ProxyManager<br/>负载均衡"]
    
    Redirect -->|"匹配规则"| RedirectAction["📍 执行重定向<br/>301/302/307/308<br/>Location头"]
    CDN -->|"设置头部"| CDNHeaders["📋 CDN响应头<br/>Cache-Control<br/>ETag/CDN-Cache-Control"]
    CDN -->|"生成URL"| CDNUrl["🔗 CDN资源URL<br/>cdn.example.com<br/>HTTPS协议"]
    Proxy -->|"负载均衡"| LoadBalance["⚖️ 选择上游服务器<br/>6种算法<br/>智能路由"]
    Proxy -->|"健康检查"| HealthCheck["🏥 故障转移<br/>自动切换<br/>健康监控"]
    
    RedirectAction --> Response["✅ 返回响应<br/>HTTP状态码<br/>响应数据"]
    CDNHeaders --> Response
    CDNUrl --> Response
    LoadBalance --> Response
    HealthCheck --> Response
    
    style Request fill:#4A90E2,stroke:#2E5C8A,stroke-width:3px,color:#fff
    style Business fill:#FFA500,stroke:#CC8400,stroke-width:3px,color:#fff
    style Redirect fill:#FF6B6B,stroke:#CC5555,stroke-width:2px,color:#fff
    style CDN fill:#9B59B6,stroke:#7D3C98,stroke-width:2px,color:#fff
    style Proxy fill:#50C878,stroke:#3FA060,stroke-width:2px,color:#fff
    style RedirectAction fill:#E74C3C,stroke:#C0392B,stroke-width:2px,color:#fff
    style CDNHeaders fill:#3498DB,stroke:#2980B9,stroke-width:2px,color:#fff
    style CDNUrl fill:#1ABC9C,stroke:#16A085,stroke-width:2px,color:#fff
    style LoadBalance fill:#F39C12,stroke:#D68910,stroke-width:2px,color:#fff
    style HealthCheck fill:#2ECC71,stroke:#27AE60,stroke-width:2px,color:#fff
    style Response fill:#2ECC71,stroke:#27AE60,stroke-width:3px,color:#fff
```

**流程说明**：请求首先进入HTTP业务层，依次经过重定向检查、CDN处理、反向代理路由，最终返回响应。HTTP业务层在AgentRuntime的中间件链中，位于请求体解析之后、路由匹配之前。

### 文件位置

- **核心实现**：`src/utils/http-business.js`
- **集成位置**：`src/agent-runtime.js`（AgentRuntime类中初始化）
- **配置文件**：`config/default_config/server.yaml`

---

## 实际应用场景

### 场景1：网站迁移（重定向）

**需求**：将旧网站 `/blog/*` 迁移到新路径 `/articles/*`

```yaml
redirects:
  - from: "/blog/*"
    to: "/articles/*"
    status: 301
    preserveQuery: true
```

**效果**：
- 访问 `https://example.com/blog/post1?page=1` 
- 自动重定向到 `https://example.com/articles/post1?page=1`
- 保留查询参数，SEO友好

### 场景2：移动端分离（条件重定向）

**需求**：移动设备访问 `/dashboard` 时重定向到移动版

```yaml
redirects:
  - from: "/dashboard"
    to: "/mobile/dashboard"
    status: 302
    condition: "req.headers['user-agent'].includes('Mobile')"
```

### 场景3：CDN加速静态资源

**需求**：将CSS/JS/图片等静态资源通过CDN加速

```yaml
cdn:
  enabled: true
  domain: "cdn.example.com"
  https: true
  cacheControl:
    static: 31536000  # CSS/JS缓存1年
    images: 604800    # 图片缓存7天
```

**效果**：
- 静态资源自动使用CDN域名
- 浏览器缓存优化，减少服务器负载
- CDN自动回源到服务器

### 场景4：高可用后端服务（负载均衡）

**需求**：后端服务部署了3个实例，需要负载均衡和故障转移

```yaml
proxy:
  enabled: true
  healthCheck:
    enabled: true
    interval: 30000
    maxFailures: 3
  domains:
    - domain: "api.example.com"
      target:
        - url: "http://backend1:3000"
          weight: 3
        - url: "http://backend2:3000"
          weight: 2
        - url: "http://backend3:3000"
          weight: 1
      loadBalance: "weighted"
```

**效果**：
- 请求按权重分发到3个后端服务
- 自动健康检查，故障自动切换
- 确保服务高可用

### 场景5：多服务统一入口

**需求**：一个域名代理多个不同的后端服务

```yaml
proxy:
  enabled: true
  domains:
    - domain: "example.com"
      target: "http://frontend:3000"
      rewritePath:
        from: "/api"
        to: "/"
    - domain: "api.example.com"
      target: "http://backend:3001"
    - domain: "admin.example.com"
      target: "http://admin:3002"
```

---

## 重定向功能

### 功能说明

重定向管理器支持多种HTTP重定向类型，可以配置复杂的重定向规则。

### 支持的重定向类型

| 状态码 | 名称 | 用途 | 是否保持HTTP方法 |
|-------|------|------|----------------|
| 301 | Moved Permanently | 永久重定向 | 否 |
| 302 | Found | 临时重定向 | 否 |
| 307 | Temporary Redirect | 临时重定向 | 是 |
| 308 | Permanent Redirect | 永久重定向 | 是 |

### 重定向处理流程

```mermaid
sequenceDiagram
    participant Client as 👤 客户端
    participant Server as 🌐 服务器
    participant Redirect as 🔄 重定向管理器
    participant Rules as 📋 重定向规则
    
    Note over Client,Server: 🔄 HTTP重定向流程
    
    Client->>Server: 📨 GET /old-path<br/>请求旧路径
    Server->>Redirect: 🔍 检查重定向规则<br/>遍历规则列表
    Redirect->>Rules: 📋 匹配规则<br/>优先级排序<br/>精确匹配优先
    Rules-->>Redirect: ✅ 找到匹配规则<br/>from: /old-path<br/>to: /new-path
    Redirect->>Redirect: 🔗 生成目标URL<br/>构建完整URL
    Redirect->>Redirect: 📝 保留查询参数<br/>?key=value（可选）
    Redirect->>Server: 📤 返回重定向响应<br/>status: 301/302
    Server->>Client: 📥 301/302 Location: /new-path<br/>重定向响应
    Client->>Server: 📨 GET /new-path<br/>自动跟随重定向
    Server->>Client: ✅ 200 OK<br/>返回新路径内容
    
    Note over Client: ✅ 重定向完成
```

**说明**：重定向规则按优先级排序，精确匹配优先于通配符匹配。

### 配置示例

```yaml
redirects:
  # 简单路径重定向
  - from: "/old-page"
    to: "/new-page"
    status: 301
  
  # 通配符重定向（支持*）
  - from: "/blog/*"
    to: "/articles/*"
    status: 301
    preserveQuery: true
  
  # 外部重定向
  - from: "/external"
    to: "https://other-site.com"
    status: 302
  
  # 条件重定向（JavaScript表达式）
  - from: "/mobile"
    to: "/mobile-site"
    status: 302
    condition: "req.headers['user-agent'].includes('Mobile')"
```

### 特性

1. **模式匹配**：使用全局 URLPattern API
2. **优先级排序**：精确匹配优先于通配符匹配
3. **查询参数保留**：可配置是否保留原始查询参数
4. **条件重定向**：支持基于请求头的条件判断

---

## CDN支持

### 功能说明

CDN管理器提供静态资源CDN支持，包括CDN回源识别、缓存控制和CDN URL生成。

### CDN处理流程

```mermaid
flowchart LR
    Request["🌐 请求静态资源<br/>CSS/JS/图片/字体"] --> Check{"🔍 是否为CDN请求?<br/>检查请求头<br/>x-cdn-request<br/>cf-connecting-ip"}
    
    Check -->|"✅ 是"| CDNHeaders["📋 设置CDN头部<br/>Cache-Control<br/>CDN-Cache-Control<br/>ETag"]
    
    Check -->|"❌ 否"| Normal["⚙️ 正常处理<br/>标准HTTP响应"]
    
    CDNHeaders --> CDNUrl["🔗 生成CDN URL<br/>cdn.example.com/path<br/>HTTPS协议"]
    
    CDNUrl --> CacheControl["⏱️ 设置缓存控制<br/>静态资源: 1年<br/>图片: 7天<br/>其他: 1小时"]
    
    CacheControl --> Response["✅ 返回响应<br/>带CDN头部"]
    
    Normal --> Response
    
    style Request fill:#4A90E2,stroke:#2E5C8A,stroke-width:3px,color:#fff
    style Check fill:#FFD700,stroke:#CCAA00,stroke-width:3px,color:#000
    style CDNHeaders fill:#FFA500,stroke:#CC8400,stroke-width:2px,color:#fff
    style CDNUrl fill:#9B59B6,stroke:#7D3C98,stroke-width:2px,color:#fff
    style CacheControl fill:#50C878,stroke:#3FA060,stroke-width:2px,color:#fff
    style Normal fill:#95A5A6,stroke:#7F8C8D,stroke-width:2px,color:#fff
    style Response fill:#2ECC71,stroke:#27AE60,stroke-width:3px,color:#fff
```

**说明**：CDN请求通过请求头识别（如`x-cdn-request`、`cf-connecting-ip`等），自动设置CDN相关响应头。

### 配置示例

```yaml
cdn:
  enabled: true
  domain: "cdn.example.com"
  staticPrefix: "/static"
  https: true
  cacheControl:
    static: 31536000    # CSS/JS/字体：1年
    images: 604800      # 图片：7天
    default: 3600       # 其他：1小时
```

### 功能特性

1. **CDN回源识别**：自动识别来自CDN的请求
2. **缓存控制**：根据文件类型设置不同缓存时间
3. **CDN头部设置**：自动设置CDN相关HTTP响应头
4. **静态资源识别**：自动识别CSS、JS、图片、字体等

### 支持的CDN头部

- `x-cdn-request`：CDN请求标识
- `x-forwarded-for`：代理IP（可能来自CDN）
- `cf-connecting-ip`：Cloudflare CDN
- `x-real-ip`：Nginx代理

### 缓存策略

| 文件类型 | 默认缓存时间 | 说明 |
|---------|------------|------|
| CSS/JS/字体 | 1年（31536000秒） | 使用版本号或哈希控制更新 |
| 图片 | 7天（604800秒） | 平衡性能和更新需求 |
| 其他 | 1小时（3600秒） | 保守策略 |

---

## 反向代理增强

### 功能说明

反向代理管理器在原有反向代理基础上，提供了负载均衡、健康检查和故障转移等高级功能。

### 负载均衡架构

```mermaid
flowchart LR
    Client["👤 客户端请求<br/>HTTP/HTTPS"] --> Proxy["🔄 反向代理管理器<br/>ProxyManager"]
    
    Proxy --> Algorithm{"⚖️ 负载均衡算法<br/>选择策略"}
    
    Algorithm -->|"1️⃣ 轮询"| RoundRobin["🔄 轮询选择<br/>Round-Robin<br/>依次分配"]
    Algorithm -->|"2️⃣ 加权"| Weighted["⚖️ 加权选择<br/>Weighted<br/>按权重分配"]
    Algorithm -->|"3️⃣ 最少连接"| LeastConn["🔌 最少连接<br/>Least-Connections<br/>选择连接数最少"]
    Algorithm -->|"4️⃣ IP哈希"| IPHash["🔐 IP哈希<br/>IP-Hash<br/>会话保持"]
    Algorithm -->|"5️⃣ 一致性哈希"| ConsistentHash["🔗 一致性哈希<br/>Consistent-Hash<br/>动态扩缩容"]
    Algorithm -->|"6️⃣ 最少响应时间"| LeastTime["⚡ 最少响应时间<br/>Least-Response-Time<br/>性能优先"]
    
    RoundRobin --> Server1["🌐 上游服务器1<br/>:3001"]
    Weighted --> Server1
    Weighted --> Server2["🌐 上游服务器2<br/>:3002"]
    LeastConn --> Server3["🌐 上游服务器3<br/>:3003"]
    IPHash --> Server1
    ConsistentHash --> Server2
    LeastTime --> Server1
    
    Server1 --> HealthCheck{"🏥 健康检查<br/>检查服务器状态"}
    Server2 --> HealthCheck
    Server3 --> HealthCheck
    
    HealthCheck -->|"✅ 健康"| Forward["➡️ 转发请求<br/>到选中服务器"]
    HealthCheck -->|"❌ 不健康"| Failover["🔄 故障转移<br/>选择其他服务器"]
    
    Failover --> Forward
    Forward --> Response["✅ 返回响应<br/>给客户端"]
    
    style Client fill:#4A90E2,stroke:#2E5C8A,stroke-width:3px,color:#fff
    style Proxy fill:#FFA500,stroke:#CC8400,stroke-width:2px,color:#fff
    style Algorithm fill:#FFD700,stroke:#CCAA00,stroke-width:3px,color:#000
    style RoundRobin fill:#87CEEB,stroke:#5F9EA0,stroke-width:2px
    style Weighted fill:#9B59B6,stroke:#7D3C98,stroke-width:2px,color:#fff
    style LeastConn fill:#50C878,stroke:#3FA060,stroke-width:2px,color:#fff
    style IPHash fill:#E74C3C,stroke:#C0392B,stroke-width:2px,color:#fff
    style ConsistentHash fill:#1ABC9C,stroke:#16A085,stroke-width:2px,color:#fff
    style LeastTime fill:#F39C12,stroke:#D68910,stroke-width:2px,color:#fff
    style Server1 fill:#98FB98,stroke:#3CB371,stroke-width:2px
    style Server2 fill:#98FB98,stroke:#3CB371,stroke-width:2px
    style Server3 fill:#98FB98,stroke:#3CB371,stroke-width:2px
    style HealthCheck fill:#FF6B6B,stroke:#CC5555,stroke-width:2px,color:#fff
    style Forward fill:#3498DB,stroke:#2980B9,stroke-width:2px,color:#fff
    style Failover fill:#E67E22,stroke:#D35400,stroke-width:2px,color:#fff
    style Response fill:#2ECC71,stroke:#27AE60,stroke-width:3px,color:#fff
```

**说明**：负载均衡支持三种算法，自动健康检查确保请求分发到健康的服务器。

### 负载均衡算法

#### 1. 轮询（Round-Robin）

按顺序依次分发请求到各个上游服务器。

```yaml
target:
  - "http://localhost:3001"
  - "http://localhost:3002"
  - "http://localhost:3003"
loadBalance: "round-robin"
```

#### 2. 加权轮询（Weighted）

根据服务器权重分配请求，权重越高接收的请求越多。

```yaml
target:
  - url: "http://localhost:3001"
    weight: 3  # 处理60%的请求
  - url: "http://localhost:3002"
    weight: 2  # 处理40%的请求
loadBalance: "weighted"
```

#### 3. 最少连接（Least-Connections）

将请求分发到当前连接数最少的服务器。

```yaml
target:
  - "http://localhost:3001"
  - "http://localhost:3002"
loadBalance: "least-connections"
```

#### 4. IP Hash（IP哈希）

基于客户端IP的哈希值分配请求，相同IP总是路由到同一服务器，适合会话保持。

```yaml
target:
  - "http://localhost:3001"
  - "http://localhost:3002"
loadBalance: "ip-hash"
```

#### 5. 一致性哈希（Consistent Hash）

当服务器列表变化时，最小化重新路由，适合动态扩缩容场景。

```yaml
target:
  - "http://localhost:3001"
  - "http://localhost:3002"
loadBalance: "consistent-hash"
```

#### 6. 最少响应时间（Least Response Time）

选择响应时间最短的服务器，适合性能敏感场景。

```yaml
target:
  - "http://localhost:3001"
  - "http://localhost:3002"
loadBalance: "least-response-time"
```

### 健康检查流程

```mermaid
sequenceDiagram
    participant Checker as 健康检查器
    participant Server1 as 上游服务器1
    participant Server2 as 上游服务器2
    participant LoadBalancer as 负载均衡器
    
    loop 每30秒
        Checker->>Server1: GET /health
        Server1-->>Checker: 200 OK
        Checker->>Server2: GET /health
        Server2-->>Checker: 502 Bad Gateway
        Checker->>Checker: 标记Server2为不健康
    end
    
    LoadBalancer->>Checker: 获取健康状态
    Checker-->>LoadBalancer: Server1健康, Server2不健康
    LoadBalancer->>LoadBalancer: 只选择Server1
```

**说明**：健康检查定期向每个上游服务器发送请求，连续失败超过阈值后标记为不健康。

### 健康检查配置

```yaml
proxy:
  healthCheck:
    enabled: true
    interval: 30000      # 检查间隔：30秒
    maxFailures: 3       # 最大失败次数：3次
    timeout: 5000       # 健康检查超时：5秒
    cacheTime: 5000      # 结果缓存时间：5秒（减少频繁检查）
    path: "/health"     # 自定义健康检查路径（可选）
```

**特性**：
- **并行检查**：所有上游服务器并行检查，提升效率
- **结果缓存**：健康检查结果缓存，避免频繁请求
- **自定义路径**：支持为每个上游服务器配置自定义健康检查URL
- **详细指标**：记录响应时间、失败次数等指标

### 故障转移

当上游服务器出现故障时：

1. 自动标记为不健康
2. 负载均衡自动跳过不健康的服务器
3. 如果所有服务器都不健康，仍会尝试请求（确保服务可用）
4. 健康检查恢复后，自动重新加入负载均衡

---

## 配置说明

### 完整配置示例

```yaml
server:
  host: "0.0.0.0"
  url: "https://example.com"

# 重定向配置
redirects:
  - from: "/old"
    to: "/new"
    status: 301

# CDN配置
cdn:
  enabled: true
  domain: "cdn.example.com"
  https: true
  cacheControl:
    static: 31536000
    images: 604800
    default: 3600

# 反向代理配置
proxy:
  enabled: true
  httpPort: 80
  httpsPort: 443
  healthCheck:
    enabled: true
    interval: 30000
    maxFailures: 3
  domains:
    - domain: "example.com"
      target:
        - url: "http://localhost:3001"
          weight: 3
        - url: "http://localhost:3002"
          weight: 1
      loadBalance: "weighted"
```

### 配置项说明

#### 重定向配置（redirects）

| 配置项 | 类型 | 必填 | 说明 |
|-------|------|------|------|
| from | string | 是 | 源路径（支持通配符*） |
| to | string | 是 | 目标路径或URL |
| status | number | 否 | HTTP状态码（默认301） |
| preserveQuery | boolean | 否 | 是否保留查询参数（默认true） |
| condition | string | 否 | JavaScript条件表达式 |

#### CDN配置（cdn）

| 配置项 | 类型 | 必填 | 说明 |
|-------|------|------|------|
| enabled | boolean | 否 | 是否启用CDN（默认false） |
| domain | string | 否 | CDN域名 |
| type | string | 否 | CDN类型：general, cloudflare, aliyun, tencent, aws, baidu, qiniu, ucloud（默认general） |
| staticPrefix | string | 否 | 静态资源前缀（默认"/static"） |
| https | boolean | 否 | 是否使用HTTPS（默认true） |
| cacheControl | object | 否 | 缓存控制配置 |

**CDN类型说明**：
- `general`：通用CDN（默认）
- `cloudflare`：Cloudflare CDN（自动识别cf-*头部）
- `aliyun`：阿里云CDN（自动识别ali-*头部）
- `tencent`：腾讯云CDN（自动识别x-qcloud-*头部）
- `aws`：AWS CloudFront（自动识别x-amz-*头部）
- `baidu`：百度云CDN
- `qiniu`：七牛云CDN
- `ucloud`：UCloud CDN

#### 反向代理配置（proxy）

| 配置项 | 类型 | 必填 | 说明 |
|-------|------|------|------|
| enabled | boolean | 否 | 是否启用反向代理（默认false） |
| httpPort | number | 否 | HTTP端口（默认80） |
| httpsPort | number | 否 | HTTPS端口（默认443） |
| healthCheck | object | 否 | 健康检查配置 |
| domains | array | 否 | 域名配置列表 |

**健康检查配置（healthCheck）**：

| 配置项 | 类型 | 必填 | 说明 |
|-------|------|------|------|
| enabled | boolean | 否 | 是否启用健康检查（默认false） |
| interval | number | 否 | 检查间隔（毫秒，默认30000） |
| maxFailures | number | 否 | 最大失败次数（默认3） |
| timeout | number | 否 | 健康检查超时（毫秒，默认5000） |
| cacheTime | number | 否 | 结果缓存时间（毫秒，默认5000） |
| path | string | 否 | 自定义健康检查路径（默认/health） |

**域名配置（domains）**：

| 配置项 | 类型 | 必填 | 说明 |
|-------|------|------|------|
| domain | string | 是 | 域名 |
| target | string/array | 否 | 目标服务器（字符串或数组） |
| loadBalance | string | 否 | 负载均衡算法：round-robin, weighted, least-connections, ip-hash, consistent-hash, least-response-time |
| healthUrl | string | 否 | 自定义健康检查URL（覆盖全局配置） |
| ssl | object | 否 | SSL证书配置 |
| rewritePath | object | 否 | 路径重写规则 |

#### 性能优化配置（performance）

| 配置项 | 类型 | 必填 | 说明 |
|-------|------|------|------|
| keepAlive | object | 否 | Keep-Alive配置 |
| http2Push | object | 否 | HTTP/2 Server Push配置 |
| connectionPool | object | 否 | 连接池配置 |

**Keep-Alive配置**：

| 配置项 | 类型 | 必填 | 说明 |
|-------|------|------|------|
| enabled | boolean | 否 | 是否启用Keep-Alive（默认true） |
| initialDelay | number | 否 | 初始延迟（毫秒，默认1000） |
| timeout | number | 否 | 超时时间（毫秒，默认120000） |

**HTTP/2 Push配置**：

| 配置项 | 类型 | 必填 | 说明 |
|-------|------|------|------|
| enabled | boolean | 否 | 是否启用HTTP/2 Push（默认false） |
| criticalAssets | array | 否 | 关键资源列表（自动推送） |

**连接池配置**：

| 配置项 | 类型 | 必填 | 说明 |
|-------|------|------|------|
| maxSockets | number | 否 | 每个主机的最大socket数（默认50） |
| maxFreeSockets | number | 否 | 空闲socket的最大数量（默认10） |
| timeout | number | 否 | socket超时时间（毫秒，默认30000） |

---

## 企业级特性

### 1. 智能负载均衡

支持6种负载均衡算法，根据场景自动选择最优策略：

- **轮询（Round-Robin）**：简单均匀分配
- **加权轮询（Weighted）**：根据服务器权重分配
- **最少连接（Least-Connections）**：优先选择连接数最少的服务器
- **IP哈希（IP-Hash）**：基于客户端IP分配，适合会话保持
- **一致性哈希（Consistent-Hash）**：服务器变化时最小化重新路由
- **最少响应时间（Least-Response-Time）**：选择响应最快的服务器

### 2. 健康检查与故障转移

- **并行健康检查**：所有上游服务器并行检查，提升效率
- **结果缓存**：健康检查结果缓存，减少频繁请求
- **自动故障转移**：服务器故障时自动切换，确保服务可用
- **详细指标**：记录响应时间、失败次数等指标

### 3. CDN智能识别

自动识别主流CDN类型，优化缓存策略和头部设置：

- Cloudflare、阿里云、腾讯云、AWS CloudFront等
- 智能提取真实客户端IP
- 优化CDN特定响应头

### 4. 性能优化

- **Keep-Alive**：减少连接开销
- **HTTP/2支持**：提升HTTPS性能
- **连接池管理**：优化socket复用
- **响应压缩**：支持 brotli 压缩

---

## 运行时依赖

本模块使用 Node 26 全局 API（如 `URLPattern`、`Error.isError`、原生 `fetch` + `AbortSignal.timeout`）。**完整清单与禁止项**见 [node-26-runtime.md](node-26-runtime.md)，不在此重复示例。

---

## 最佳实践

### 1. 重定向配置

- **使用301进行永久重定向**，有助于SEO
- **保留查询参数**，避免丢失重要信息
- **使用条件重定向**处理移动端和桌面端分离

### 2. CDN配置

- **只对静态资源启用CDN**，动态内容不要使用CDN
- **设置合理的缓存时间**，平衡性能和更新需求
- **使用版本号或哈希控制静态资源更新**

### 3. 反向代理配置

- **启用健康检查**，提高服务可用性
- **使用加权负载均衡**，根据服务器性能分配权重
- **配置多个上游服务器**，实现高可用

### 4. 性能优化

- **重定向规则按优先级排序**，精确匹配优先
- **CDN缓存时间设置合理**，避免缓存过大
- **健康检查间隔不要过短**，避免增加服务器负担

### 5. 安全建议

- **HTTPS重定向使用301或308**
- **CDN配置使用HTTPS**
- **反向代理启用SSL/TLS**

---

## API参考

### HTTPBusinessLayer

```javascript
class HTTPBusinessLayer {
  constructor(config)
  handleRedirect(req, res): boolean
  handleCDN(req, res, filePath): string
  selectProxyUpstream(domain, algorithm): Object|null
  markProxyFailure(domain, upstreamUrl): void
}
```

### RedirectManager

```javascript
class RedirectManager {
  constructor(config)
  check(req, res): boolean
}
```

### CDNManager

```javascript
class CDNManager {
  constructor(config)
  isCDNRequest(req): boolean
  setCDNHeaders(res, filePath): void
  getCDNUrl(filePath): string
}
```

### ProxyManager

```javascript
class ProxyManager {
  constructor(config)
  selectUpstream(domain, algorithm): Object|null
  markUpstreamFailure(domain, upstreamUrl): void
}
```

---

## 相关文档

- **[AgentRuntime 主类文档](agent-runtime.md)** - HTTP/HTTPS/WebSocket 服务详细说明
- **[Server 服务器架构](server.md)** - 完整的服务器架构说明
- **[system-Core 特性](system-core.md)** - system-Core 内置模块完整说明

---

*最后更新：2026-06-14*
