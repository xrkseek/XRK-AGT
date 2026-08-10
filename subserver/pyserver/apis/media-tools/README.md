# media-tools 子服务插件

图片缩放、格式转换、缩略图。

## 依赖

`uv run python main.py` 启动时自动安装本目录 `requirements.txt`；也可 `子服> media-tools 更新`。

## 终端命令

子服务启动后（交互终端）：

```text
子服> media-tools 状态
子服> media-tools 更新
```

主服务代码调用：`AgentRuntime.callSubserver('/api/media-tools/...')`

## API

- `POST /api/media-tools/resize` — `{"path":"data/.../a.png","width":800}`
- `POST /api/media-tools/convert` — `{"path":"...","format":"jpeg"}`
- `POST /api/media-tools/thumbnail` — `{"path":"...","size":320}`
- `GET /api/media-tools/file?path=data/media-tools/output/...`
- `POST /api/media-tools/command` — `{"cmd":"status"}`

配置：`data/media-tools/config.yaml`（首次从 `default_config.yaml` 复制）
