"""API 加载器：扫描 apis/ 并注册路由与命令。"""

import importlib
import importlib.util
import inspect
from pathlib import Path
from typing import List, Dict, Any, Optional
from fastapi import FastAPI
import logging

from .base_api import BaseAPI, create_api_from_dict
from .command_registry import CommandRegistry, PluginCommandSet
from . import plugin_kit

logger = logging.getLogger(__name__)


class ApiLoader:
    """API 加载器（单例模式），支持多组结构"""
    
    _instance: Optional['ApiLoader'] = None
    _apis: List[BaseAPI] = []
    _loaded = False
    
    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._apis = []
            cls._instance._loaded = False
        return cls._instance
    
    @property
    def apis_dir(self) -> Path:
        """获取 apis 目录（复用 plugin_kit 的定位，确保目录存在）"""
        apis_dir = plugin_kit.apis_dir()
        apis_dir.mkdir(exist_ok=True)
        return apis_dir
    
    @classmethod
    async def load_all(cls, app: FastAPI):
        """加载所有 API"""
        if cls._loaded:
            logger.debug("API 已加载，跳过")
            return
        
        instance = cls()
        await instance._load_apis(app)
        cls._loaded = True
    
    async def _load_apis(self, app: FastAPI):
        api_groups = sorted(
            d for d in self.apis_dir.iterdir()
            if d.is_dir() and not d.name.startswith("_")
        )
        if not api_groups:
            logger.warning("未找到 API 组目录")
            return

        loaded_count = 0
        skipped_count = 0
        failed_count = 0
        for group_dir in api_groups:
            group_name = group_dir.name
            api_files = sorted(
                f for f in group_dir.glob("*.py") if not f.name.startswith("_")
            )
            if not api_files:
                if group_name != "system":
                    logger.warning("跳过空插件目录: %s", group_name)
                continue

            group_loaded = False
            group_hard_failed = False
            for api_file in api_files:
                try:
                    await self._load_api_file(api_file, group_name, app)
                    loaded_count += 1
                    group_loaded = True
                except ImportError as e:
                    skipped_count += 1
                    logger.warning(
                        "跳过插件 %s/%s（依赖未安装）: %s",
                        group_name, api_file.name, e,
                    )
                except Exception as e:
                    failed_count += 1
                    group_hard_failed = True
                    logger.error("加载失败 %s/%s: %s", group_name, api_file.name, e, exc_info=True)

            if group_hard_failed and not group_loaded and group_name != "system":
                CommandRegistry.register(
                    PluginCommandSet(
                        group=group_name,
                        description="加载失败，可先 更新 再重启",
                        plugin_dir=group_dir.resolve(),
                        commands={},
                    )
                )

        self._apis.sort(key=lambda x: x.priority, reverse=True)
        if skipped_count:
            logger.info(
                "📂 API 已加载 · %d 个（跳过 %d · 失败 %d）",
                loaded_count, skipped_count, failed_count,
            )
        else:
            logger.info("📂 API 已加载 · %d 个（失败 %d）", loaded_count, failed_count)
    
    async def _load_api_file(self, api_file: Path, group_name: str, app: FastAPI):
        """加载单个 API 文件"""
        module_name = f"apis.{group_name}.{api_file.stem}"
        
        spec = importlib.util.spec_from_file_location(module_name, api_file)
        if spec is None or spec.loader is None:
            raise ImportError(f"无法加载模块: {module_name}")
        
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        
        api_export = getattr(module, "default", None)
        if not api_export:
            return
        
        if isinstance(api_export, dict):
            api = create_api_from_dict(api_export)
        elif inspect.isclass(api_export) and issubclass(api_export, BaseAPI):
            api = api_export()
        else:
            return
        
        await api.startup(app)
        self._apis.append(api)
        logger.debug("加载 API: %s [%s]", api.name, group_name)
    
    @classmethod
    def get_api_list(cls) -> List[Dict[str, Any]]:
        instance = cls()
        return [api.get_info() for api in instance._apis]

    @classmethod
    async def shutdown_all(cls, app: FastAPI):
        """关闭所有 API，释放线程池/连接等资源"""
        instance = cls()
        for api in reversed(instance._apis):
            try:
                await api.shutdown(app)
            except Exception as e:
                logger.warning("API 关闭失败 %s: %s", api.name, e, exc_info=True)
