"""子服运行时配置：default_config.yaml → data/subserver/config.yaml。"""

import yaml
import shutil
import os
from pathlib import Path
from typing import Any, Dict, Optional


def get_project_root() -> Path:
    return Path(__file__).parent.parent


def get_data_root() -> Path:
    return get_project_root().parent.parent / "data" / "subserver"


def resolve_path(path_str: str, base: Optional[Path] = None) -> Path:
    path = Path(path_str)
    if path.is_absolute():
        return path
    base = base or get_project_root()
    return base / path_str


class Config:
    def __init__(self, config_file: str = "config.yaml"):
        self.project_root = get_project_root()
        self.default_config_file = self.project_root / "config" / "default_config.yaml"
        self.data_root = get_data_root()
        self.config_file = self.data_root / config_file

        self._config: Dict[str, Any] = {}
        self._cache: Dict[str, Any] = {}
        self._ensure_config_exists()
        self.load()

    def _ensure_config_exists(self):
        """确保配置文件存在，从默认配置复制"""
        # 确保数据目录存在
        self.config_file.parent.mkdir(parents=True, exist_ok=True)

        # 如果配置文件不存在，尝试从默认配置复制
        if not self.config_file.exists():
            if self.default_config_file.exists():
                # 从默认配置复制
                shutil.copy2(self.default_config_file, self.config_file)
            else:
                # 默认配置也不存在，使用内置默认配置
                self._config = self._get_builtin_default_config()
                self.save()

    def load(self):
        """加载配置文件"""
        try:
            if self.config_file.exists():
                with open(self.config_file, "r", encoding="utf-8") as f:
                    self._config = yaml.safe_load(f) or {}
            else:
                # 配置文件不存在，使用默认配置
                self._config = self._get_builtin_default_config()
                self.save()
        except Exception:
            # 配置文件损坏或读取失败，使用默认配置
            self._config = self._get_builtin_default_config()
            self.save()

        # 合并默认配置，确保所有字段都存在
        default_config = self._get_builtin_default_config()
        self._config = self._merge_config(default_config, self._config)

        self._cache.clear()

    def _merge_config(
        self, default: Dict[str, Any], user: Dict[str, Any]
    ) -> Dict[str, Any]:
        """深度合并配置（用户配置优先）"""
        result = default.copy()
        for key, value in user.items():
            if (
                key in result
                and isinstance(result[key], dict)
                and isinstance(value, dict)
            ):
                result[key] = self._merge_config(result[key], value)
            else:
                result[key] = value
        return result

    def save(self):
        """保存配置文件"""
        self.config_file.parent.mkdir(parents=True, exist_ok=True)
        with open(self.config_file, "w", encoding="utf-8") as f:
            yaml.dump(
                self._config,
                f,
                allow_unicode=True,
                default_flow_style=False,
                sort_keys=False,
            )

    def _get_builtin_default_config(self) -> Dict[str, Any]:
        """获取内置默认配置（当文件不存在时使用）"""
        return {
            "server": {
                "host": "0.0.0.0",
                "port": 8000,
                "reload": False,
                "log_level": "info",
                "stdin": {"enabled": True, "prompt": "子服> "},
            },
            "cors": {"origins": ["*"]},
            "logging": {
                "level": "info",
                "file": "logs/app.log",
                "max_bytes": 10485760,
                "backup_count": 5,
            },
        }

    def get(self, key: str, default: Any = None) -> Any:
        if key in self._cache:
            return self._cache[key]

        keys = key.split(".")
        value = self._config

        for k in keys:
            if isinstance(value, dict) and k in value:
                value = value[k]
            else:
                self._cache[key] = default
                return default

        self._cache[key] = value
        return value

    def get_file_path(self) -> Path:
        return self.config_file
