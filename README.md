# 优雅阅读器 (Elegant Reader)

一个基于 Electron 的桌面阅读应用，专为 TXT 小说阅读而设计。

## 功能特性

- 📖 支持 TXT 格式文件阅读
- 🎨 优雅的用户界面设计
- 💾 本地数据库存储阅读进度
- 🌙 支持深色/浅色主题切换
- 📱 响应式设计，适配不同屏幕尺寸
- 🔍 快速搜索和导航功能

## 技术栈

- **前端**: HTML5, CSS3, JavaScript
- **桌面框架**: Electron 28.1.0
- **数据库**: SQLite3
- **构建工具**: Electron Builder

## 安装和运行

### 环境要求

- Node.js 16.0 或更高版本
- npm 或 yarn

### 安装依赖

```bash
npm install
```

### 开发模式运行

```bash
npm start
```

### 构建应用

```bash
# 构建 Windows 版本
npm run build-win

# 构建所有平台版本
npm run build
```

## 项目结构

```
├── index.html          # 主界面
├── main.js            # Electron 主进程
├── preload.js         # 预加载脚本
├── styles.css         # 样式文件
├── package.json       # 项目配置
└── build/             # 构建输出目录
```

## 数据存储位置

- 配置文件 (`config.json`) 与随机状态 (`random_state.json`) 均存储于 Electron 的用户数据目录（`app.getPath('userData')`）。
- 应用启动时会自动将旧版本存放在可执行文件所在目录的配置或随机状态迁移至用户数据目录。

## 开发说明

这是一个开源的桌面阅读应用，欢迎提交 Issue 和 Pull Request。

## 许可证

MIT License

## 作者

ponsde 