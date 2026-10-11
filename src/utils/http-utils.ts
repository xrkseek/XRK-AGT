import { errorHandler, ErrorCodes, type ErrorCode } from '#utils/error-handler.js';

type ExpressLikeRes = {
  headersSent?: boolean;
  setHeader: (name: string, value: string) => unknown;
  status: (code: number) => ExpressLikeRes;
  json: (body: unknown) => unknown;
  write: (chunk: string) => unknown;
  end: () => unknown;
};

/**
 * HTTP 响应工具类
 * 统一 HTTP 响应格式与错误处理；core 下 http 模块 handler 应优先使用。
 *
 * success 形状是底层契约（前端必遵）：
 * - 普通对象拍平到顶层；数组/标量进 data；见 JSDoc / skill xrk-http-api
 * - 浏览器解包：unwrapSuccess（web-compat.js / 产品内联；skill xrk-www-compat）
 */
export class HttpResponse {
  /**
   * 成功响应
   * 普通对象（非数组）会 Object.assign 到顶层；数组/标量放在 response.data。
   */
  static success(res: ExpressLikeRes, data: unknown = null, message = '操作成功'): unknown {
    const response: Record<string, unknown> = { success: true, message };
    if (data !== null) {
      if (typeof data === 'object' && !Array.isArray(data)) {
        Object.assign(response, data);
      } else {
        response.data = data;
      }
    }
    if (!res.headersSent) {
      res.setHeader('Cache-Control', 'no-store');
    }
    return res.json(response);
  }

  /**
   * 原样 JSON 响应（兼容端点如 stdin，不包 success 外壳）
   */
  static json(res: ExpressLikeRes, body: unknown, statusCode = 200): unknown {
    if (!res.headersSent) {
      res.setHeader('Cache-Control', 'no-store');
    }
    return res.status(statusCode).json(body);
  }

  /**
   * 错误响应
   */
  static error(res: ExpressLikeRes, error: unknown, statusCode = 500, context = ''): unknown {
    const botError = errorHandler.handle(
      error as Error,
      { context, code: ErrorCodes.SYSTEM_ERROR },
      false,
    ) as { message: string; code: number };
    return res.status(statusCode).json({
      success: false,
      message: botError.message,
      code: botError.code,
    });
  }

  /**
   * 验证错误响应
   */
  static validationError(
    res: ExpressLikeRes,
    message: string,
    code: ErrorCode | number = ErrorCodes.INPUT_VALIDATION_FAILED,
  ): unknown {
    return res.status(400).json({
      success: false,
      message,
      code,
    });
  }

  /**
   * 未找到响应
   */
  static notFound(res: ExpressLikeRes, message = '资源未找到'): unknown {
    return res.status(404).json({
      success: false,
      message,
      code: ErrorCodes.NOT_FOUND,
    });
  }

  /**
   * 未授权响应
   */
  static unauthorized(res: ExpressLikeRes, message = '未授权'): unknown {
    if (!res.headersSent) {
      res.setHeader('Cache-Control', 'no-store');
    }
    return res.status(401).json({
      success: false,
      message,
      code: 'UNAUTHORIZED',
    });
  }

  /**
   * 禁止访问响应
   */
  static forbidden(res: ExpressLikeRes, message = '禁止访问'): unknown {
    return res.status(403).json({
      success: false,
      message,
      code: 'FORBIDDEN',
    });
  }

  /**
   * 异步处理器包装器
   * 自动捕获错误并返回统一格式
   */
  static asyncHandler(
    handler: (req: unknown, res: ExpressLikeRes, ...args: unknown[]) => unknown | Promise<unknown>,
    context = '',
  ) {
    return async (req: unknown, res: ExpressLikeRes, ...args: unknown[]) => {
      try {
        await handler(req, res, ...args);
      } catch (error) {
        this.error(res, error, 500, context);
      }
    };
  }

  /**
   * 流式响应（SSE）
   */
  static async streamResponse(
    res: ExpressLikeRes,
    streamHandler: (res: ExpressLikeRes) => Promise<void>,
    context = '',
  ): Promise<void> {
    try {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.setHeader('Access-Control-Allow-Origin', '*');

      await streamHandler(res);
    } catch (error) {
      const err = error as { message?: string; code?: number };
      res.write(
        `data: ${JSON.stringify({
          success: false,
          message: err.message,
          code: err.code || ErrorCodes.SYSTEM_ERROR,
        })}\n\n`,
      );
      res.end();

      errorHandler.handle(error as Error, { context, code: ErrorCodes.SYSTEM_ERROR });
    }
  }

  /**
   * JSON-RPC 2.0 错误响应（MCP标准）
   */
  static jsonRpcError(
    res: ExpressLikeRes,
    id: number | string | null,
    code: number,
    message: string,
    data: unknown = null,
    httpStatusCode = 200,
  ): unknown {
    const response: {
      jsonrpc: string;
      id: number | string | null;
      error: { code: number; message: string; data?: unknown };
    } = {
      jsonrpc: '2.0',
      id,
      error: {
        code,
        message,
      },
    };

    if (data !== null) {
      response.error.data = data;
    }

    return res.status(httpStatusCode).json(response);
  }

  /**
   * JSON-RPC 2.0 成功响应（MCP标准）
   */
  static jsonRpcSuccess(res: ExpressLikeRes, id: number | string | null, result: unknown): unknown {
    return res.json({
      jsonrpc: '2.0',
      id,
      result,
    });
  }

  /**
   * 验证JSON-RPC请求格式
   */
  static validateJsonRpcRequest(
    request: unknown,
  ): { code: number; message: string } | null {
    if (!request || typeof request !== 'object') {
      return {
        code: -32600,
        message: 'Invalid Request: request must be an object',
      };
    }

    const req = request as { jsonrpc?: unknown; method?: unknown };

    if (req.jsonrpc !== '2.0') {
      return {
        code: -32600,
        message: 'Invalid Request: jsonrpc must be "2.0"',
      };
    }

    if (typeof req.method !== 'string') {
      return {
        code: -32600,
        message: 'Invalid Request: method is required and must be a string',
      };
    }

    return null;
  }
}
