# 优雅阅读器 (Elegant Reader)

一个支持 **桌面端 (Electron)** 和 **Web 端 (Node.js)** 双模式运行的优雅阅读应用，专为 TXT 小说阅读而设计。无论是在本地电脑还是云服务器上，都能提供一致的流畅阅读体验。

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
- **服务端**: Node.js (Web 模式)
- **数据存储**: JSON 文件系统
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

### Web 服务端部署 (全新功能)

本项目现已支持在服务器上直接部署运行，通过浏览器访问。

1. **安装依赖**
   ```bash
   npm install
   ```

2. **启动服务**
   ```bash
   npm run start-web
   ```

3. **访问**
   打开浏览器访问 `http://localhost:3000` (或服务器 IP:3000)。
   *注意：请确保服务器防火墙放行 3000 端口。*

## 项目结构

```
├── index.html          # 主界面
├── main.js            # Electron 主进程
├── preload.js         # 预加载脚本
├── styles.css         # 样式文件
├── package.json       # 项目配置
└── build/             # 构建输出目录
```

## 开发说明

这是一个开源的桌面阅读应用，欢迎提交 Issue 和 Pull Request。

## 许可证

MIT License

## 作者

ponsde 