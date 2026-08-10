# doc-pipeline 子服务插件

HTML 正文提取、简易 Markdown 转换。

## 依赖

启动子服时安装本目录 `requirements.txt`；也可 `子服> doc-pipeline 更新`。

## 终端

```text
子服> doc-pipeline 状态
子服> doc-pipeline 更新
```

## API

- `POST /api/doc-pipeline/extract` — `{"path":"data/.../page.html"}` 或 `{"text":"<html>..."}`
- `POST /api/doc-pipeline/markdown` — 同上，可选 `"save": true`
- `POST /api/doc-pipeline/command` — `{"cmd":"status"}`

配置：`data/doc-pipeline/config.yaml`
