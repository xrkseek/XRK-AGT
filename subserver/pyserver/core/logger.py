"""日志：控制台 + 轮转文件。"""

import logging
import sys
from logging.handlers import RotatingFileHandler
from typing import Optional

from .config import Config, resolve_path

logger = logging.getLogger(__name__)
config = Config()
_root_configured = False


def setup_logger(name: str = __name__, level: Optional[str] = None) -> logging.Logger:
    global _root_configured
    root = logging.getLogger()

    try:
        log_level = level or config.get("logging.level", "info")
        root.setLevel(getattr(logging, log_level.upper(), logging.INFO))

        if _root_configured:
            return logging.getLogger(name)

        _root_configured = True

        console_formatter = logging.Formatter(
            "%(asctime)s │ %(levelname)-7s │ %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        )
        console_handler = logging.StreamHandler(sys.stdout)
        console_handler.setLevel(logging.INFO)
        console_handler.setFormatter(console_formatter)
        root.addHandler(console_handler)

        log_file = config.get("logging.file", "logs/app.log")
        try:
            log_path = resolve_path(log_file)
            log_path.parent.mkdir(parents=True, exist_ok=True)

            file_formatter = logging.Formatter(
                "%(asctime)s │ %(name)-20s │ %(levelname)-8s │ %(funcName)s:%(lineno)-4d │ %(message)s",
                datefmt="%Y-%m-%d %H:%M:%S",
            )
            file_handler = RotatingFileHandler(
                log_path,
                maxBytes=config.get("logging.max_bytes", 10 * 1024 * 1024),
                backupCount=config.get("logging.backup_count", 5),
                encoding="utf-8",
            )
            file_handler.setLevel(logging.DEBUG)
            file_handler.setFormatter(file_formatter)
            root.addHandler(file_handler)

            logger.info("Logging to file: %s", log_path)
        except (IOError, OSError) as e:
            logger.error("Failed to configure file logging: %s", e, exc_info=True)

        return logging.getLogger(name)

    except Exception as e:
        logger.error("Error setting up logger: %s", e, exc_info=True)
        logging.basicConfig(level=logging.INFO)
        return logging.getLogger(name)
