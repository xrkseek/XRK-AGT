"""API 基类与 dict 配置工厂。"""

from pathlib import Path
from typing import List, Dict, Callable, Any
from fastapi import FastAPI, Request, HTTPException
import logging
import inspect

from .command_registry import CommandRegistry, PluginCommandSet
from .plugin_kit import dispatch_plugin_command

logger = logging.getLogger(__name__)


class BaseAPI:
    def __init__(
        self,
        name: str,
        description: str = "",
        priority: int = 100,
        enabled: bool = True,
    ):
        self.name = name
        self.description = description or "暂无描述"
        self.priority = priority
        self.enabled = enabled
        self.routes: List[Dict[str, Any]] = []
        self._registered = False

    def register_routes(self, app: FastAPI):
        logger.warning("[BaseAPI] %s 未实现 register_routes", self.name)

    async def init(self, app: FastAPI):
        pass

    async def startup(self, app: FastAPI):
        if not self.enabled:
            logger.info("[BaseAPI] %s 已禁用，跳过注册", self.name)
            return
        try:
            self.register_routes(app)
            await self.init(app)
            self._registered = True
            logger.info("[BaseAPI] %s 注册成功 (%d 个路由)", self.name, len(self.routes))
        except Exception as e:
            logger.error("[BaseAPI] %s 注册失败: %s", self.name, e, exc_info=True)
            raise

    async def shutdown(self, app: FastAPI):
        pass

    def get_info(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "priority": self.priority,
            "enabled": self.enabled,
            "routes_count": len(self.routes),
            "registered": self._registered,
        }


async def _run_hook(hook, app: FastAPI) -> None:
    if not callable(hook):
        return
    if inspect.iscoroutinefunction(hook):
        await hook(app)
        return
    result = hook(app)
    if inspect.isawaitable(result):
        await result


def _register_plugin_commands(app: FastAPI, api: BaseAPI, data: Dict[str, Any]):
    group = data.get("group")
    if not group:
        return

    plugin_dir_raw = data.get("plugin_dir")
    plugin_dir = Path(plugin_dir_raw) if plugin_dir_raw else None
    commands = data.get("commands") or {}
    on_update = data.get("on_update")
    if not commands and not plugin_dir:
        return

    CommandRegistry.register(
        PluginCommandSet(
            group=group,
            description=data.get("description", api.description),
            plugin_dir=plugin_dir,
            commands=commands,
            on_update=on_update,
        )
    )

    prefix = f"/api/{group}"

    async def health_handler(_request: Request):
        return {
            "ok": True,
            "group": group,
            "name": api.name,
            "commands": sorted(commands.keys()) + ["update", "help"],
        }

    async def command_handler(request: Request):
        try:
            body = await request.json()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"无效 JSON: {exc}") from exc

        cmd = str(body.get("cmd") or body.get("command") or "").strip()
        args = body.get("args") or []
        if isinstance(args, str):
            args = args.split()
        elif not isinstance(args, list):
            args = []

        line = body.get("line")
        if line and not cmd:
            parts = str(line).strip().split()
            if parts and parts[0] == group:
                parts = parts[1:]
            if parts:
                cmd, args = parts[0], parts[1:]

        return await dispatch_plugin_command(
            group,
            commands,
            request,
            cmd=cmd or "help",
            args=args,
            plugin_dir=plugin_dir,
            on_update=on_update,
        )

    app.get(f"{prefix}/health")(health_handler)
    app.post(f"{prefix}/command")(command_handler)


def create_api_from_dict(data: Dict[str, Any]) -> BaseAPI:
    class DictAPI(BaseAPI):
        def __init__(self, data: Dict[str, Any]):
            super().__init__(
                name=data.get("name", "unnamed-api"),
                description=data.get("description", ""),
                priority=data.get("priority", 100),
                enabled=data.get("enabled", True),
            )
            self._data = data

        def register_routes(self, app: FastAPI):
            route_methods = {
                "GET": app.get,
                "POST": app.post,
                "PUT": app.put,
                "DELETE": app.delete,
                "PATCH": app.patch,
                "HEAD": app.head,
            }
            for route_config in self._data.get("routes", []):
                method = route_config.get("method", "GET").upper()
                path = route_config.get("path")
                handler = route_config.get("handler")
                if not path or not handler:
                    continue
                register = route_methods.get(method)
                if not register:
                    continue
                register(path)(self._wrap_handler(handler))
                self.routes.append(route_config)
            _register_plugin_commands(app, self, self._data)

        async def init(self, app: FastAPI):
            await _run_hook(self._data.get("init"), app)

        async def shutdown(self, app: FastAPI):
            await _run_hook(self._data.get("shutdown"), app)

        def _wrap_handler(self, handler: Callable) -> Callable:
            is_async = inspect.iscoroutinefunction(handler)

            async def wrapped(request: Request):
                try:
                    return await handler(request) if is_async else handler(request)
                except HTTPException:
                    raise
                except Exception as e:
                    logger.error("[DictAPI] %s 处理失败: %s", self.name, e, exc_info=True)
                    raise HTTPException(status_code=500, detail=str(e)) from e

            return wrapped

    return DictAPI(data)
