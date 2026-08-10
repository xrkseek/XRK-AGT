"""XRK-AGT Python 子服务端（底层精简版）"""
import logging
import os
import sys
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

from core.config import Config
from core.loader import ApiLoader
from core.logger import setup_logger
from core.stdin_loop import start_stdin_loop, stop_stdin_loop
from core.version import PACKAGE_VERSION


def _ensure_stdio_utf8() -> None:
    """Windows 控制台默认 GBK；统一 UTF-8，避免日志/stdin 乱码。"""
    os.environ.setdefault("PYTHONUTF8", "1")
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            try:
                reconfigure(encoding="utf-8", errors="replace")
            except Exception:
                pass


_ensure_stdio_utf8()

config = Config()
logger = setup_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期管理"""
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logger.info("启动 XRK-AGT Python 子服务端")
    try:
        await ApiLoader.load_all(app)
        logger.info("──────────────────────────────────────")
        logger.info("启动就绪 · 底层服务已加载")
        logger.info("──────────────────────────────────────")
        stdin_enabled = config.get("server.stdin.enabled", True)
        stdin_prompt = config.get("server.stdin.prompt", "子服> ")
        start_stdin_loop(enabled=stdin_enabled, prompt=stdin_prompt)
    except Exception as e:
        logger.error("启动失败: %s", e, exc_info=True)
        raise

    yield

    logger.info("关闭服务...")
    stop_stdin_loop()
    try:
        await ApiLoader.shutdown_all(app)
    except Exception as e:
        logger.warning("API 资源释放异常: %s", e, exc_info=True)


app = FastAPI(
    title="XRK-AGT Python 子服务端",
    description="提供子服务端底层能力（健康检查、扩展 API 装载）",
    version=PACKAGE_VERSION,
    lifespan=lifespan,
    docs_url="/docs",
    redoc_url="/redoc",
    openapi_url="/openapi.json",
)

app.add_middleware(GZipMiddleware, minimum_size=1000)

cors_origins = config.get("cors.origins", ["*"])
if cors_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )


def main():
    host = os.getenv("HOST") or config.get("server.host", "0.0.0.0")
    port = int(os.getenv("PORT") or config.get("server.port", 8000))
    reload = os.getenv("RELOAD", "").lower() in ("true", "1") or config.get("server.reload", False)
    log_level = os.getenv("LOG_LEVEL") or config.get("server.log_level", "info")

    from core.plugin_kit import install_all_plugin_deps

    deps = install_all_plugin_deps()
    if deps.get("failed"):
        logger.warning("插件依赖失败: %s", ", ".join(deps["failed"]))
    elif deps.get("installed"):
        logger.info("插件依赖就绪: %s", ", ".join(deps["installed"]))

    logger.info("──────────────────────────────────────")
    logger.info("🌐 子服务端  http://%s:%s", host, port)
    logger.info("📁 配置     %s", config.get_file_path())
    logger.info("──────────────────────────────────────")

    uvicorn.run(
        "main:app",
        host=host,
        port=port,
        reload=reload,
        log_level=log_level,
        access_log=True,
        use_colors=True,
    )


if __name__ == "__main__":
    main()
