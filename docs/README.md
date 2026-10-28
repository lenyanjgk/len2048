# docs

存放 README 里引用的截图。**这些文件会被提交进仓库**（和 `.gitignore` 里那些运行期产物不同），所以放之前先压一下图。

| 文件 | 内容 | 尺寸 |
|---|---|---|
| `游戏界面.png` | 助手模式主界面：记分板 + 棋盘 + 推荐着法 + 四方向期望分 + 搜索统计 | 2698×1733 |
| `对局记录界面.png` | 对局记录管理页：汇总条 + 筛选 + 表格 + 详情栏 | 2713×1734 |
| `官网界面.png` | 官网首屏（Hero + 实时演示板） | 2710×1719 |
| `官网完整界面.png` | 官网整页长图，从 Hero 到开源区 | 2718×11662，4.3 MB |
| `15708.png` / `35936.png` / `77892.png` | 自动演示三局实录，文件名就是终局分数 | ≈2720×1730 |

## 重新截图

页面没有构建步骤，直接用 `tools/` 里的走查脚本截（先 `python server.py`）：

```bash
node tools/nav-check.cjs out 1440 900 neon     # 三个页面各一张视口图
node tools/e2e-check.cjs  out 1440 900         # 管理页顶部 + 选中详情
```

想换主题就把最后一个参数改成 `classic` / `sakura` / `forest`。

`官网完整界面.png` 是整页长图，`nav-check.cjs` 默认只截视口，需要另外用
`Page.captureScreenshot` 的 `captureBeyondViewport` 自己截一次。

## 注意

- 文件名的中文在 GitHub 的 Markdown 里能正常渲染，但本地某些预览器可能需要 URL 编码
- `官网完整界面.png` 有 4 MB，如果嫌 README 太重可以只保留首屏那张
