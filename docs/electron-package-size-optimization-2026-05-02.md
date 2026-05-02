# Electron 打包体积分析与安全优化报告（2026-05-02）

## 1. 调查范围与命令

执行目录：`D:\1work\chat2api`

核心调查命令：

```powershell
Get-Content package.json
Get-ChildItem dist | Select-Object Name,Length,LastWriteTime
Get-ChildItem dist\win-unpacked -Recurse | Sort-Object Length -Descending | Select-Object FullName,Length -First 30
Get-ChildItem build -Recurse | Sort-Object Length -Descending | Select-Object FullName,Length -First 30
npx asar list dist\win-unpacked\resources\app.asar
```

构建与打包验证命令：

```powershell
npm run build
npm run build:win
npm run build:win:portable
```

## 2. 体积根因结论

1. **主要体积来自 Electron Runtime，而非业务代码**  
   - `dist/win-unpacked/Chat2API.exe`：`188,855,296` 字节  
   - `dist/win-unpacked/resources/app.asar`：约 `12.74 MB`  
   说明安装包大头在 Chromium/Electron 运行时组件，不在 `app.asar`。

2. **多语言 locale 文件默认全量打包，累计体积明显**  
   优化前 `locales` 目录包含大量语言 `*.pak`（几十个文件，单文件可达约 1.4MB）。

3. **Windows 默认同时产出 NSIS + Portable**  
   原 `build:win` 会一次生成两个大文件（setup + portable），虽然不增加单个文件体积，但会增加发布产物总量与构建时间，并造成“产物整体很大”的感知。

4. **`extraResources` 包含整个 `build` 目录**  
   实际运行只需要托盘图标 `build/icon.png`，原配置会额外打入不必要图片资源。

## 3. 修改点（低风险）

修改文件：`package.json`

1. 增加 `electronLanguages`，仅保留业务实际使用语言：
   - `en-US`
   - `zh-CN`

2. `extraResources` 从整目录收敛到必需文件：
   - 保留 `build/icon.png`（托盘图标运行时依赖）
   - 保留 `sha3_wasm_bg.7b9ca65ddd.wasm`（挑战计算依赖）

3. Windows 打包策略调整：
   - `build:win` 改为只打 `nsis`
   - 新增 `build:win:portable` 单独产出 portable

4. 启用更高压缩级别：
   - `build.compression = "maximum"`

## 4. 优化前后对比

> 说明：以下均为本地同环境、同版本（1.2.0）构建结果。

### 4.1 关键产物对比

| 项目 | 优化前 | 优化后 | 变化 |
|---|---:|---:|---:|
| `Chat2API-1.2.0-x64-setup.exe` | 85,186,520 | 77,083,979 | **-8,102,541 (~ -9.51%)** |
| `Chat2API-1.2.0-x64-portable.exe` | 84,805,060 | 70,047,981 | **-14,757,079 (~ -17.40%)** |

### 4.2 unpacked locale 对比

| 项目 | 优化前 | 优化后 |
|---|---|---|
| `dist/win-unpacked/locales` | 多语言全量（几十个 pak） | 仅 `en-US.pak`、`zh-CN.pak` |

## 5. 验证结果摘要

1. `npm run build`：通过  
2. `npm run build:win`：通过，成功生成 NSIS 安装包  
3. `npm run build:win:portable`：通过，portable 独立命令可用  
4. 应用关键运行依赖仍在：
   - `resources/build/icon.png` 存在（托盘图标路径依赖）
   - `resources/sha3_wasm_bg.7b9ca65ddd.wasm` 存在

## 6. 风险说明

1. `electronLanguages` 收敛会移除其它系统语言的 Chromium 本地化资源。  
   - 对中文/英文用户无影响。  
   - 非中英文系统下界面/系统组件文案可能回落英文（功能不受影响）。

2. `build:win` 默认不再同时输出 portable。  
   - 功能未删除，改为显式执行 `npm run build:win:portable`。

3. `compression: maximum` 主要影响打包耗时，通常不影响运行时行为。

