# 实习决策与执行工作台：前端原型

此仓库目前包含一份可直接预览的静态前端原型，使用虚构数据，不连接后端。完整产品的功能规格、技术选型和待实现事项见 [PLAN.md](PLAN.md)；其中规划的 React、API、离线同步等功能尚未包含在本仓库中。

## 项目结构

```text
.
├── LICENSE
├── PLAN.md                         # 完整产品的功能规格与实施计划
├── README.md
└── frontend/
    ├── index.html                  # 当前前端原型，单文件页面入口
    ├── index.html.artifact.json    # 页面预览元数据
    ├── .file-versions/             # 页面历史版本与版本清单
    └── .od-frames/                 # 设备预览模板及样式
```

`frontend/index.html` 是运行页面所需的文件。隐藏目录和元数据用于设计预览与版本回溯，不属于页面部署文件。

## 本地预览

在仓库根目录运行：

```sh
python3 -m http.server 8000 --directory frontend
```

然后访问 `http://localhost:8000/`。页面没有构建步骤或 npm 依赖。

## 更新已有的 Cloudflare Worker

如果本机已有独立部署项目 `~/Documents/Cloudflare-Worker-Sites/greenbp-intern-workbench`，可复制当前页面并在该项目中部署：

```sh
cp "$HOME/Documents/Yat-Sen-Occupation-Leading/frontend/index.html" "$HOME/Documents/Cloudflare-Worker-Sites/greenbp-intern-workbench/public/index.html"
cd "$HOME/Documents/Cloudflare-Worker-Sites/greenbp-intern-workbench"
npx wrangler@4 deploy --dry-run
npx wrangler@4 deploy
```

部署项目与此仓库分开维护；需要 Cloudflare 登录及对应项目的部署权限。
