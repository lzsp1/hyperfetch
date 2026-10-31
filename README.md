# HyperFetch · 多线程加速下载器

<p align="center">
  <img src="build/icon.png" width="96" alt="HyperFetch" />
</p>

一个现代感、带过渡动画的 Windows 桌面下载器：粘贴地址 → 自动识别文件 → **多线程分段加速下载**，保存位置随意选；支持**应用内更新**（GitHub Releases + 国内 CDN 加速，用内置引擎直接下载安装包），**深色 / 浅色 / 跟随系统**三种主题。

遵循 **MIT** 开源协议。所有代码保存在本仓库，安装包发布在 [Releases](https://github.com/OWNER/HyperFetch/releases)。

---

## 下载与安装

从 [Releases](https://github.com/OWNER/HyperFetch/releases/latest) 下载：

| 文件 | 说明 |
| --- | --- |
| `HyperFetch-x.x.x-x64-setup.exe` | **安装程序**（推荐），可自选安装目录，创建桌面 / 开始菜单快捷方式 |
| `HyperFetch-x.x.x-portable.exe` | 免安装便携版，双击即用 |

> 安装包为 64 位 Windows。程序未做商业代码签名，个别杀毒软件可能误报，可添加信任。

---

## 功能

### 下载引擎
- **多线程分段下载**：文件切成多片，多连接并发下载（8 / 16 / 32 可选，最高 64）
- **单线程自动回退**：服务器不支持 Range、不返回文件大小、或返回整包时，自动改用单连接顺序下载 —— 只要能下就一定下得下来
- **断点续传**：暂停、退出、重启后从上次位置继续（`.hfd` 元数据 + `.part` 数据）
- **智能文件名**：`Content-Disposition`（含 RFC 5987 中文名）→ URL 末段 → 主机名
- **重定向**自动跟随（最多 10 次）；**同名文件**自动改为 `文件 (2).zip`，绝不覆盖
- **断线重试**：指数退避重试 5 次；完成后校验字节数与服务器声明一致才改名落盘

### 下载管理
- 任务队列、并发数限制、全局与单任务限速
- 暂停 / 继续 / 移除 / 打开文件 / 打开所在文件夹
- 详情抽屉：数据块热力图、分段进度、实时速度、剩余时间
- 筛选（全部 / 进行中 / 已暂停 / 已完成 / 失败）、全部暂停、清除已完成
- 标题栏实时总速度、任务栏进度、运行日志面板

### 软件更新（GitHub Releases + CDN）
- 启动后静默检查新版本，有更新时弹窗展示版本号与更新说明
- **不使用浏览器**：安装包由应用自身的多线程引擎下载，带进度、速度、剩余时间
- **国内网络友好**：依次尝试 `ghfast.top`、`gh-proxy.com`、`ghproxy.net` 镜像，最后回落到 GitHub 直连；哪个能用就用哪个
- 下载完成后校验大小，一键「立即安装并退出」直接拉起安装程序
- 可关闭自动检查、可包含预发布版本

### 界面
- 自绘无边框窗口、极光渐变背景、毛玻璃卡片、流光进度条、卡片进出与抽屉滑出等过渡动效
- **深色 / 浅色 / 跟随系统** 三种主题，6 套强调色，可关闭动效
- 设置页内置「查看开源库」「查看 MIT 许可证」「打开发布页」

---

## 从源码运行

需要 Node.js 18+。

```bash
npm install
npm start
```

Windows 上也可以直接双击 `启动 HyperFetch.cmd`（会使用仓库内附带的便携版 Node）。

## 打包

```bash
npm run dist     # 生成安装包 + 便携版到 release\
npm run pack     # 只生成便携版
```

## 发布到 GitHub

1. 准备一个带 `repo` 权限的 GitHub 令牌，设置为环境变量：
   ```bat
   set GH_TOKEN=ghp_xxxxxxxx
   ```
2. 运行：
   ```bash
   node tools/publish-github.js --repo HyperFetch
   ```
   脚本会：创建公开仓库（若不存在）→ 以 MIT 许可证模板提交 `LICENSE` → 推送源码 → 创建 `v1.0.0` Release 并上传**安装程序**与便携版。

也可以推 tag 交给 GitHub Actions 打包发布：

```bash
git tag v1.0.0 && git push origin v1.0.0
```

`.github/workflows/release.yml` 会自动执行测试、构建安装包并发布。

> 发布后，把仓库地址填进 `package.json` 的 `repository.url`、
> `src/renderer/app.js` 的 `GITHUB_USER`，以及应用内「设置 → 软件更新」的仓库项（默认即可）。

## 测试

```bash
npm run test:node    # 版本比较 / CDN 镜像 / 更新包下载 / 工具函数
electron test/engine.test.js   # 真实 HTTP 服务器上的 11 项下载引擎测试
npm run test:ui      # 驱动真实界面并截图到 screenshots\
```

---

## 目录结构

```
src/
  main/
    main.js      主进程：窗口、IPC、代理、主题、生命周期
    download.js  下载任务：分片、续传、重试、单线程回退、合并
    manager.js   任务队列、并发控制、持久化
    update.js    检查 GitHub Releases、CDN 回退、下载并安装更新
    netfetch.js  基于 Electron net 的轻量 HTTP 读取
    util.js      HTTP 请求、文件名解析、并发写入器
    settings.js  设置读写
  preload/preload.js   安全 IPC 桥
  renderer/            界面（HTML / CSS / JS）
test/                  测试
tools/                 发布脚本、打包辅助
```

## 配置位置

| 内容 | 路径 |
| --- | --- |
| 设置 | `%USERPROFILE%\.hyperfetch\settings.json` |
| 任务列表 | `%USERPROFILE%\.hyperfetch\tasks.json` |
| 下载中的临时文件 | `<保存目录>\<文件名>.part` |
| 续传元数据 | `<保存目录>\<文件名>.hfd` |
| 更新包 | `%USERPROFILE%\.hyperfetch\updates\` |

---

## 常见问题

**提示「服务器忽略分段请求」/ 只有 1 个连接**
该服务器不允许分段下载，程序自动降级为单连接，速度取决于服务器。

**更新的安装包下载失败**
会自动尝试多个国内镜像；全部失败时可在弹窗中「打开发布页」手动下载。

**杀毒软件报毒**
未做商业代码签名，属于误报，可添加信任或自行从源码构建。

## 许可证

[MIT](LICENSE) © HyperFetch contributors
