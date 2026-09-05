/**
 * HTTP业务层工具模块
 * 提供重定向、CDN、反向代理增强等功能的统一实现
 *
 * @module http-business
 * @description 使用 Node.js 全局 URLPattern API，提供完整的 HTTP 业务层能力
 */

import crypto from 'node:crypto';

type ExpressLikeReq = {
  url?: string;
  protocol?: string;
  ip?: string;
  headers?: Record<string, string | string[] | undefined>;
  connection?: { remoteAddress?: string };
};

type ExpressLikeRes = {
  headersSent?: boolean;
  redirect: (status: number, url: string) => unknown;
  setHeader: (name: string, value: string) => unknown;
};

type RedirectRuleConfig = {
  from: string;
  to: string;
  status?: number;
  hostname?: string;
  preserveQuery?: boolean;
  preservePath?: boolean;
  condition?: string;
};

type CompiledRedirectRule = {
  pattern: URLPattern;
  to: string;
  status: number;
  preserveQuery: boolean;
  preservePath: boolean;
  condition: ((req: ExpressLikeReq) => unknown) | null;
  from?: string;
};

type RedirectManagerConfig = {
  redirects?: RedirectRuleConfig[];
};

type CacheControlConfig = {
  static?: number;
  images?: number;
  default?: number;
};

type CDNConfig = {
  enabled?: boolean;
  domain?: string;
  staticPrefix?: string;
  cacheControl?: CacheControlConfig;
  https?: boolean;
};

type CDNManagerConfig = {
  cdn?: CDNConfig;
};

type CDNInfo = {
  type: string;
  ip: string;
  headers: Record<string, unknown>;
};

type UpstreamEntry = {
  url: string;
  weight: number;
  healthy: boolean;
  failCount: number;
  connections: number;
  responseTime: number;
  lastCheck: number;
  healthUrl: string;
  [key: string]: unknown;
};

type UpstreamTarget =
  | string
  | {
      url?: string;
      weight?: number;
      healthUrl?: string;
      [key: string]: unknown;
    };

type DomainConfig = {
  domain: string;
  target?: string | UpstreamTarget[];
  healthUrl?: string;
};

type HealthCheckConfig = {
  enabled?: boolean;
  interval?: number;
  cacheTime?: number;
  timeout?: number;
  maxFailures?: number;
};

type ProxyConfig = {
  domains?: DomainConfig[];
  healthCheck?: HealthCheckConfig;
};

type ProxyManagerConfig = {
  proxy?: ProxyConfig;
};

type UpstreamStat = {
  requests: number;
  failures: number;
  totalResponseTime: number;
  avgResponseTime: number;
};

type HealthCacheEntry = {
  healthy: boolean;
  timestamp: number;
};

type MapWithHelpers<K, V> = Map<K, V> & {
  getOrInsert(key: K, defaultValue: V): V;
  getOrInsertComputed(key: K, callbackfn: () => V): V;
};

type BufferWithToBase64 = Buffer & { toBase64(): string };

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err ?? '');
}

/**
 * 重定向管理器
 * 支持多种重定向类型：301(永久), 302(临时), 307(临时保持方法), 308(永久保持方法)
 */
export class RedirectManager {
  rules: CompiledRedirectRule[] = [];
  config: RedirectManagerConfig;

  constructor(config: RedirectManagerConfig = {}) {
    this.rules = [];
    this.config = config;
    this._compileRules();
  }

  /**
   * 编译重定向规则（URLPattern API）
   */
  _compileRules(): void {
    const redirectConfig = this.config.redirects || [];

    for (const rule of redirectConfig) {
      try {
        const pattern = new URLPattern({
          pathname: rule.from,
          ...(rule.hostname && { hostname: rule.hostname }),
        });

        this.rules.push({
          pattern,
          to: rule.to,
          status: rule.status || 301,
          preserveQuery: rule.preserveQuery !== false,
          preservePath: rule.preservePath !== false,
          condition: rule.condition ? (new Function('req', 'return ' + rule.condition) as (req: ExpressLikeReq) => unknown) : null,
        });
      } catch (err) {
        console.warn(`[重定向] 规则编译失败: ${rule.from} -> ${rule.to}`, errMessage(err));
      }
    }

    this.rules.sort((a, b) => {
      const aSpecificity = this._getPatternSpecificity(a.pattern);
      const bSpecificity = this._getPatternSpecificity(b.pattern);
      return bSpecificity - aSpecificity;
    });
  }

  /**
   * 获取模式的特异性（用于优先级排序）
   */
  _getPatternSpecificity(pattern: URLPattern): number {
    // 简单实现：路径越具体（越少通配符），优先级越高
    const pathname = pattern.pathname || '';
    const wildcards = (pathname.match(/\*/g) || []).length;
    return 100 - wildcards * 10;
  }

  /**
   * 检查并执行重定向
   * @returns 是否执行了重定向
   */
  check(req: ExpressLikeReq, res: ExpressLikeRes): boolean {
    if (res.headersSent) return false;

    const url = new URL(req.url as string, `http://${(req.headers as Record<string, string | string[] | undefined>).host || 'localhost'}`);

    for (const rule of this.rules) {
      try {
        if (rule.condition && !rule.condition(req)) {
          continue;
        }

        const match = rule.pattern.test({
          pathname: url.pathname,
          hostname: url.hostname,
        });

        if (!match) continue;

        let targetUrl = rule.to;

        if (targetUrl.includes('$')) {
          targetUrl = url.pathname.replace(rule.pattern.pathname, targetUrl);
        }

        if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
          const protocol = req.protocol || 'http';
          const host = (req.headers as Record<string, string | string[] | undefined>).host || 'localhost';
          targetUrl = `${protocol}://${host}${targetUrl.startsWith('/') ? '' : '/'}${targetUrl}`;
        }

        if (rule.preserveQuery && url.search) {
          const targetUrlObj = new URL(targetUrl);
          url.searchParams.forEach((value, key) => {
            targetUrlObj.searchParams.append(key, value);
          });
          targetUrl = targetUrlObj.toString();
        }

        res.redirect(rule.status, targetUrl);
        return true;
      } catch (err) {
        console.warn(`[重定向] 执行失败: ${rule.from} -> ${rule.to}`, errMessage(err));
      }
    }

    return false;
  }
}

/**
 * CDN管理器
 * 处理CDN回源、缓存控制、CDN头部等
 * 支持主流CDN：Cloudflare、阿里云CDN、腾讯云CDN、AWS CloudFront等
 */
export class CDNManager {
  config: CDNConfig;
  enabled: boolean;
  cdnDomain: string;
  staticPrefix: string;
  cacheControl: CacheControlConfig;
  cdnPatterns: Record<string, string[]>;

  constructor(config: CDNManagerConfig = {}) {
    this.config = config.cdn || {};
    this.enabled = this.config.enabled === true;
    this.cdnDomain = this.config.domain || '';
    this.staticPrefix = this.config.staticPrefix || '/static';
    this.cacheControl = this.config.cacheControl || {};

    // CDN识别模式（主流CDN头部）
    this.cdnPatterns = {
      cloudflare: ['cf-connecting-ip', 'cf-ray', 'cf-visitor', 'cf-ipcountry'],
      aliyun: ['ali-swift-stat-host', 'ali-swift-stat-path', 'x-oss-request-id'],
      tencent: ['x-qcloud-cdn', 'x-qcloud-request-id'],
      aws: ['x-amz-cf-id', 'x-amzn-trace-id', 'cloudfront-viewer-country'],
      baidu: ['x-bce-request-id', 'x-bce-date'],
      qiniu: ['x-qiniu-request-id'],
      ucloud: ['x-ucloud-request-id'],
      general: ['x-cdn-request', 'x-forwarded-for', 'x-real-ip', 'x-forwarded-proto'],
    };
  }

  /**
   * 检查是否为CDN回源请求
   * @returns CDN信息对象，包含类型和IP
   */
  isCDNRequest(req: ExpressLikeReq): CDNInfo | null {
    if (!this.enabled) return null;

    const headers = req.headers || {};
    const lowerHeaders: Record<string, unknown> = {};
    Object.keys(headers).forEach((k) => {
      lowerHeaders[k.toLowerCase()] = headers[k];
    });

    // 检测CDN类型
    for (const [cdnType, patterns] of Object.entries(this.cdnPatterns)) {
      for (const pattern of patterns) {
        if (lowerHeaders[pattern.toLowerCase()]) {
          const clientIP = this._extractClientIP(req, cdnType);
          return {
            type: cdnType,
            ip: clientIP,
            headers: lowerHeaders,
          };
        }
      }
    }

    return null;
  }

  /**
   * 提取真实客户端IP（考虑CDN代理）
   */
  _extractClientIP(req: ExpressLikeReq, cdnType: string): string {
    const headers = req.headers || {};
    const lowerHeaders: Record<string, any> = {};
    Object.keys(headers).forEach((k) => {
      lowerHeaders[k.toLowerCase()] = headers[k];
    });

    // 根据CDN类型提取IP
    switch (cdnType) {
      case 'cloudflare':
        return lowerHeaders['cf-connecting-ip'] || req.ip || req.connection?.remoteAddress || 'unknown';
      case 'aliyun':
        return lowerHeaders['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown';
      case 'tencent':
        return lowerHeaders['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown';
      case 'aws':
        return lowerHeaders['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown';
      default: {
        // 通用提取：优先使用X-Forwarded-For，取第一个IP
        const forwardedFor = lowerHeaders['x-forwarded-for'];
        if (forwardedFor) {
          return forwardedFor.split(',')[0].trim();
        }
        return lowerHeaders['x-real-ip'] || req.ip || req.connection?.remoteAddress || 'unknown';
      }
    }
  }

  /**
   * 设置CDN相关响应头
   */
  setCDNHeaders(res: ExpressLikeRes, filePath: string, req: ExpressLikeReq | null = null): void {
    if (!this.enabled || res.headersSent) return;

    const ext = this._getFileExtension(filePath);
    const cacheMaxAge = this._getCacheMaxAge(ext);

    // 标准缓存控制头
    if (cacheMaxAge > 0) {
      const cacheControl = this._buildCacheControl(ext, cacheMaxAge);
      res.setHeader('Cache-Control', cacheControl);

      // CDN特定缓存控制（部分CDN支持）
      if (req) {
        const cdnInfo = this.isCDNRequest(req);
        if (cdnInfo) {
          this._setCDNSpecificHeaders(res, cdnInfo.type, cacheMaxAge);
        }
      }

      // ETag支持（用于缓存验证）
      res.setHeader('ETag', this._generateETag(filePath));
    }

    // CDN域名标识
    if (this.cdnDomain) {
      res.setHeader('X-CDN-Domain', this.cdnDomain);
    }

    // 预加载提示（H2 Server Push）
    if (this._isCriticalAsset(filePath)) {
      res.setHeader('Link', `<${filePath}>; rel=preload; as=${this._getAssetType(ext)}`);
    }
  }

  /**
   * 构建Cache-Control头
   */
  _buildCacheControl(ext: string, maxAge: number): string {
    const directives = ['public'];

    // 静态资源使用immutable（浏览器不会重新验证）
    if (['css', 'js', 'woff', 'woff2', 'ttf', 'otf', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico'].includes(ext)) {
      directives.push('immutable');
    }

    directives.push(`max-age=${maxAge}`);

    // 添加stale-while-revalidate（允许在重新验证时使用过期缓存）
    if (maxAge > 3600) {
      directives.push(`stale-while-revalidate=${Math.min(maxAge / 2, 86400)}`);
    }

    return directives.join(', ');
  }

  /**
   * 设置CDN特定响应头
   */
  _setCDNSpecificHeaders(res: ExpressLikeRes, cdnType: string, maxAge: number): void {
    switch (cdnType) {
      case 'cloudflare':
        // Cloudflare支持CDN-Cache-Control
        res.setHeader('CDN-Cache-Control', `public, max-age=${maxAge}`);
        break;
      case 'aliyun':
        // 阿里云CDN缓存控制
        res.setHeader('X-Cache-Control', `public, max-age=${maxAge}`);
        break;
      case 'tencent':
        // 腾讯云CDN缓存控制
        res.setHeader('X-QCloud-Cache-Control', `public, max-age=${maxAge}`);
        break;
    }
  }

  /**
   * 生成ETag（简单实现）
   */
  _generateETag(filePath: string): string {
    // 简单实现：基于文件路径和修改时间
    // 实际应用中可以使用文件hash
    return `"${(Buffer.from(filePath) as BufferWithToBase64).toBase64().slice(0, 16)}"`;
  }

  /**
   * 判断是否为关键资源（用于H2 Server Push）
   */
  _isCriticalAsset(filePath: string): boolean {
    const criticalExts = ['.css', '.js', '.woff', '.woff2'];
    return criticalExts.some((ext) => filePath.toLowerCase().endsWith(ext));
  }

  /**
   * 获取资源类型（用于H2 Server Push）
   */
  _getAssetType(ext: string): string {
    if (['css'].includes(ext)) return 'style';
    if (['js'].includes(ext)) return 'script';
    if (['woff', 'woff2', 'ttf', 'otf'].includes(ext)) return 'font';
    if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico'].includes(ext)) return 'image';
    return 'fetch';
  }

  /**
   * 获取文件的CDN URL
   */
  getCDNUrl(filePath: string): string {
    if (!this.enabled || !this.cdnDomain) {
      return filePath;
    }

    if (!filePath.startsWith(this.staticPrefix) && !this._isStaticAsset(filePath)) {
      return filePath;
    }

    const protocol = this.config.https ? 'https' : 'http';
    return `${protocol}://${this.cdnDomain}${filePath}`;
  }

  /**
   * 获取文件扩展名
   */
  _getFileExtension(filePath: string): string {
    const match = filePath.match(/\.([^.]+)$/);
    return match ? match[1].toLowerCase() : '';
  }

  /**
   * 判断是否为静态资源
   */
  _isStaticAsset(filePath: string): boolean {
    const staticExts = ['.css', '.js', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.woff', '.woff2', '.ttf', '.otf'];
    return staticExts.some((ext) => filePath.toLowerCase().endsWith(ext));
  }

  /**
   * 获取缓存时间（秒）
   */
  _getCacheMaxAge(ext: string): number {
    const config = this.cacheControl;

    if (['css', 'js', 'woff', 'woff2', 'ttf', 'otf'].includes(ext)) {
      return config.static || 31536000; // 1年
    }

    if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif', 'ico'].includes(ext)) {
      return config.images || 604800; // 7天
    }

    return config.default || 3600; // 1小时
  }
}

/**
 * 反向代理增强管理器
 * 提供负载均衡、健康检查、故障转移等高级功能
 * 支持多种负载均衡算法：轮询、加权轮询、最少连接、IP Hash、一致性哈希
 */
export class ProxyManager {
  config: ProxyConfig = {};
  upstreams = new Map<string, UpstreamEntry[]>();
  _roundRobinIndex = new Map<string, number>();
  _connectionCounts = new Map<string, number>();
  _responseTimes = new Map<string, number>();
  _healthCheckCache = new Map<string, HealthCacheEntry>();
  _stats: {
    totalRequests: number;
    totalFailures: number;
    upstreamStats: Map<string, UpstreamStat>;
  } = {
    totalRequests: 0,
    totalFailures: 0,
    upstreamStats: new Map(),
  };

  constructor(config: ProxyManagerConfig = {}) {
    this.config = config.proxy || {};
    this._initUpstreams();
  }

  /**
   * 获取统计信息（企业级监控）
   */
  getStats(): {
    totalRequests: number;
    totalFailures: number;
    successRate: string;
    upstreams: Array<{
      domain: string;
      url: string;
      healthy: boolean;
      connections: number;
      responseTime: number;
      failCount: number;
      lastCheck: number;
      requests: number;
      failures: number;
      successRate: string;
      avgResponseTime: string;
    }>;
  } {
    const stats = {
      totalRequests: this._stats.totalRequests,
      totalFailures: this._stats.totalFailures,
      successRate:
        this._stats.totalRequests > 0
          ? (((this._stats.totalRequests - this._stats.totalFailures) / this._stats.totalRequests) * 100).toFixed(2) + '%'
          : '0%',
      upstreams: [] as Array<{
        domain: string;
        url: string;
        healthy: boolean;
        connections: number;
        responseTime: number;
        failCount: number;
        lastCheck: number;
        requests: number;
        failures: number;
        successRate: string;
        avgResponseTime: string;
      }>,
    };

    for (const [domain, upstreams] of this.upstreams.entries()) {
      for (const upstream of upstreams) {
        const upstreamStat = this._stats.upstreamStats.get(`${domain}-${upstream.url}`) || {
          requests: 0,
          failures: 0,
          avgResponseTime: 0,
        };

        stats.upstreams.push({
          domain,
          url: upstream.url,
          healthy: upstream.healthy,
          connections: upstream.connections || 0,
          responseTime: upstream.responseTime || 0,
          failCount: upstream.failCount || 0,
          lastCheck: upstream.lastCheck || 0,
          requests: upstreamStat.requests,
          failures: upstreamStat.failures,
          successRate:
            upstreamStat.requests > 0
              ? (((upstreamStat.requests - upstreamStat.failures) / upstreamStat.requests) * 100).toFixed(2) + '%'
              : '0%',
          avgResponseTime: upstreamStat.avgResponseTime.toFixed(2) + 'ms',
        });
      }
    }

    return stats;
  }

  /**
   * 记录请求统计
   */
  recordRequest(domain: string, upstreamUrl: string, success: boolean, responseTime = 0): void {
    this._stats.totalRequests++;
    if (!success) {
      this._stats.totalFailures++;
    }

    const key = `${domain}-${upstreamUrl}`;
    const stat = (this._stats.upstreamStats as MapWithHelpers<string, UpstreamStat>).getOrInsertComputed(key, () => ({
      requests: 0,
      failures: 0,
      totalResponseTime: 0,
      avgResponseTime: 0,
    }));

    stat.requests++;
    if (!success) {
      stat.failures++;
    }
    if (responseTime > 0) {
      stat.totalResponseTime += responseTime;
      stat.avgResponseTime = stat.totalResponseTime / stat.requests;
    }
  }

  /**
   * 初始化上游服务器池
   */
  _initUpstreams(): void {
    const domains = this.config.domains || [];

    for (const domainConfig of domains) {
      if (!domainConfig.target || typeof domainConfig.target === 'string') {
        this.upstreams.set(domainConfig.domain, [
          {
            url: domainConfig.target as string,
            weight: 1,
            healthy: true,
            failCount: 0,
            connections: 0,
            responseTime: 0,
            lastCheck: Date.now(),
            healthUrl: domainConfig.healthUrl || `${domainConfig.target}/health`,
          },
        ]);
      } else if (Array.isArray(domainConfig.target)) {
        this.upstreams.set(
          domainConfig.domain,
          domainConfig.target.map((upstream: any) => ({
            url: typeof upstream === 'string' ? upstream : upstream.url,
            weight: upstream.weight || 1,
            healthy: true,
            failCount: 0,
            connections: 0,
            responseTime: 0,
            lastCheck: Date.now(),
            healthUrl: upstream.healthUrl || `${typeof upstream === 'string' ? upstream : upstream.url}/health`,
            ...upstream,
          })),
        );
      }
    }

    if (this.config.healthCheck?.enabled) {
      this._startHealthChecks();
    }
  }

  /**
   * 启动健康检查
   */
  _startHealthChecks(): void {
    const interval = this.config.healthCheck?.interval || 30000;
    setInterval(() => {
      this._performHealthChecks();
    }, interval);
  }

  /**
   * 执行健康检查（并行检查所有上游服务器）
   */
  async _performHealthChecks(): Promise<void> {
    const checkPromises: Promise<void>[] = [];

    for (const [domain, upstreams] of this.upstreams.entries()) {
      for (const upstream of upstreams) {
        checkPromises.push(this._checkUpstreamHealth(domain, upstream));
      }
    }

    // 并行执行所有健康检查
    await Promise.allSettled(checkPromises);
  }

  /**
   * 检查单个上游服务器健康状态
   */
  async _checkUpstreamHealth(domain: string, upstream: UpstreamEntry): Promise<void> {
    const cacheKey = `${domain}-${upstream.url}`;
    const cacheTime = this.config.healthCheck?.cacheTime || 5000; // 默认5秒缓存

    // 检查缓存
    const cached = this._healthCheckCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < cacheTime) {
      upstream.healthy = cached.healthy;
      upstream.lastCheck = cached.timestamp;
      return;
    }

    const startTime = Date.now();

    try {
      const healthUrl = upstream.healthUrl || `${upstream.url}/health`;
      const timeout = this.config.healthCheck?.timeout || 5000;

      const response = await fetch(healthUrl, {
        signal: AbortSignal.timeout(timeout),
        method: 'GET',
        headers: {
          'User-Agent': 'XRK-AGT-HealthCheck/1.0',
        },
      });

      const responseTime = Date.now() - startTime;
      upstream.responseTime = responseTime;
      upstream.healthy = response.ok;
      upstream.failCount = 0;
      upstream.lastCheck = Date.now();

      // 更新缓存
      this._healthCheckCache.set(cacheKey, {
        healthy: upstream.healthy,
        timestamp: upstream.lastCheck,
      });
    } catch {
      upstream.failCount++;
      upstream.healthy = upstream.failCount < (this.config.healthCheck?.maxFailures || 3);
      upstream.lastCheck = Date.now();
      upstream.responseTime = Date.now() - startTime;

      // 更新缓存
      this._healthCheckCache.set(cacheKey, {
        healthy: upstream.healthy,
        timestamp: upstream.lastCheck,
      });
    }
  }

  /**
   * 选择上游服务器（负载均衡）
   * @param algorithm - 算法: 'round-robin', 'weighted', 'least-connections', 'ip-hash', 'consistent-hash', 'least-response-time'
   * @returns 选中的上游服务器配置
   */
  selectUpstream(domain: string, algorithm = 'round-robin', clientIP: string | null = null): UpstreamEntry | null {
    const upstreams = this.upstreams.get(domain);
    if (!upstreams || upstreams.length === 0) return null;

    const healthyUpstreams = upstreams.filter((u) => u.healthy);
    if (healthyUpstreams.length === 0) {
      // 所有服务器都不健康时，仍返回第一个（确保服务可用）
      return upstreams[0];
    }

    switch (algorithm) {
      case 'weighted':
        return this._selectWeighted(healthyUpstreams);

      case 'least-connections':
        return this._selectLeastConnections(healthyUpstreams);

      case 'ip-hash':
        return this._selectIPHash(healthyUpstreams, clientIP || '0.0.0.0');

      case 'consistent-hash':
        return this._selectConsistentHash(healthyUpstreams, clientIP || '0.0.0.0');

      case 'least-response-time':
        return this._selectLeastResponseTime(healthyUpstreams);

      case 'round-robin':
      default:
        return this._selectRoundRobin(healthyUpstreams, domain);
    }
  }

  /**
   * 增加连接数
   */
  incrementConnections(domain: string, upstreamUrl: string): void {
    const upstreams = this.upstreams.get(domain);
    if (!upstreams) return;

    const upstream = upstreams.find((u) => u.url === upstreamUrl);
    if (upstream) {
      upstream.connections = (upstream.connections || 0) + 1;
    }
  }

  /**
   * 减少连接数
   */
  decrementConnections(domain: string, upstreamUrl: string): void {
    const upstreams = this.upstreams.get(domain);
    if (!upstreams) return;

    const upstream = upstreams.find((u) => u.url === upstreamUrl);
    if (upstream && upstream.connections > 0) {
      upstream.connections--;
    }
  }

  /**
   * 加权轮询
   */
  _selectWeighted(upstreams: UpstreamEntry[]): UpstreamEntry {
    const totalWeight = upstreams.reduce((sum, u) => sum + u.weight, 0);
    let random = Math.random() * totalWeight;

    for (const upstream of upstreams) {
      random -= upstream.weight;
      if (random <= 0) {
        return upstream;
      }
    }

    return upstreams[0];
  }

  /**
   * 最少连接
   */
  _selectLeastConnections(upstreams: UpstreamEntry[]): UpstreamEntry {
    return upstreams.reduce((min, u) => {
      const connections = u.connections || 0;
      const minConnections = min.connections || 0;
      return connections < minConnections ? u : min;
    }, upstreams[0]);
  }

  /**
   * 轮询
   */
  _selectRoundRobin(upstreams: UpstreamEntry[], domain: string): UpstreamEntry {
    const key = `round-robin-${domain}`;
    const currentIndex = (this._roundRobinIndex as MapWithHelpers<string, number>).getOrInsert(key, 0);
    const selected = upstreams[currentIndex % upstreams.length];
    this._roundRobinIndex.set(key, currentIndex + 1);

    return selected;
  }

  /**
   * IP Hash算法（基于客户端IP的哈希）
   * 相同IP总是路由到同一服务器，适合会话保持
   */
  _selectIPHash(upstreams: UpstreamEntry[], clientIP: string): UpstreamEntry {
    // 简单哈希函数
    let hash = 0;
    for (let i = 0; i < clientIP.length; i++) {
      hash = (hash << 5) - hash + clientIP.charCodeAt(i);
      hash = hash & hash; // 转换为32位整数
    }

    const index = Math.abs(hash) % upstreams.length;
    return upstreams[index];
  }

  /**
   * 一致性哈希算法（简化实现）
   * 当服务器列表变化时，最小化重新路由
   */
  _selectConsistentHash(upstreams: UpstreamEntry[], clientIP: string): UpstreamEntry {
    // 简化的一致性哈希：使用MD5哈希
    const hash = crypto.createHash('md5').update(clientIP).digest('hex');
    const hashInt = parseInt(hash.slice(0, 8), 16);

    const index = hashInt % upstreams.length;
    return upstreams[index];
  }

  /**
   * 最少响应时间算法
   * 选择响应时间最短的服务器
   */
  _selectLeastResponseTime(upstreams: UpstreamEntry[]): UpstreamEntry {
    return upstreams.reduce((min, u) => {
      const responseTime = u.responseTime || Infinity;
      const minResponseTime = min.responseTime || Infinity;
      return responseTime < minResponseTime ? u : min;
    }, upstreams[0]);
  }

  /**
   * 标记上游服务器失败
   */
  markUpstreamFailure(domain: string, upstreamUrl: string): void {
    const upstreams = this.upstreams.get(domain);
    if (!upstreams) return;

    const upstream = upstreams.find((u) => u.url === upstreamUrl);
    if (upstream) {
      upstream.failCount++;
      const maxFailures = this.config.healthCheck?.maxFailures || 3;
      upstream.healthy = upstream.failCount < maxFailures;

      // 记录失败统计
      this.recordRequest(domain, upstreamUrl, false);

      // 如果标记为不健康，记录警告
      if (!upstream.healthy) {
        console.warn(`[ProxyManager] 上游服务器标记为不健康: ${domain} -> ${upstreamUrl} (失败次数: ${upstream.failCount})`);
      }
    }
  }

  /**
   * 标记上游服务器成功
   */
  markUpstreamSuccess(domain: string, upstreamUrl: string, responseTime = 0): void {
    const upstreams = this.upstreams.get(domain);
    if (!upstreams) return;

    const upstream = upstreams.find((u) => u.url === upstreamUrl);
    if (upstream) {
      // 记录成功统计
      this.recordRequest(domain, upstreamUrl, true, responseTime);

      // 如果之前不健康，现在恢复健康
      if (!upstream.healthy && upstream.failCount > 0) {
        upstream.failCount = 0;
        upstream.healthy = true;
        console.info(`[ProxyManager] 上游服务器恢复健康: ${domain} -> ${upstreamUrl}`);
      }
    }
  }
}

type HTTPBusinessConfig = RedirectManagerConfig & CDNManagerConfig & ProxyManagerConfig;

/**
 * HTTP业务层工具类
 * 统一管理重定向、CDN、反向代理等功能
 */
export class HTTPBusinessLayer {
  config: HTTPBusinessConfig;
  redirectManager: RedirectManager;
  cdnManager: CDNManager;
  proxyManager: ProxyManager;

  constructor(config: HTTPBusinessConfig = {}) {
    this.config = config;
    this.redirectManager = new RedirectManager(config);
    this.cdnManager = new CDNManager(config);
    this.proxyManager = new ProxyManager(config);
  }

  /**
   * 处理重定向
   */
  handleRedirect(req: ExpressLikeReq, res: ExpressLikeRes): boolean {
    return this.redirectManager.check(req, res);
  }

  /**
   * 处理CDN相关逻辑
   */
  handleCDN(req: ExpressLikeReq, res: ExpressLikeRes, filePath: string): string {
    this.cdnManager.setCDNHeaders(res, filePath);
    return this.cdnManager.getCDNUrl(filePath);
  }

  /**
   * 选择代理上游
   */
  selectProxyUpstream(domain: string, algorithm?: string): UpstreamEntry | null {
    return this.proxyManager.selectUpstream(domain, algorithm);
  }

  /**
   * 标记代理失败
   */
  markProxyFailure(domain: string, upstreamUrl: string): void {
    this.proxyManager.markUpstreamFailure(domain, upstreamUrl);
  }
}

export default HTTPBusinessLayer;
