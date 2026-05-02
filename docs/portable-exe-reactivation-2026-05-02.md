# Portable EXE 重新启用验证报告

日期：2026-05-02

## 目标

重新启用 Windows `portable.exe` 产物，并保留 `setup.exe`。

## 修改

- 文件：`package.json`
- 调整：
  - `build.win.target` 重新加入 `portable`
  - `scripts.build:win` 恢复为 `electron-builder --win --x64`，使默认 Windows 打包同时产出 `nsis + portable`

## 验证命令

```powershell
npm run build:win
Get-ChildItem .\dist -File | Select-Object Name,Length
```

## 预期结果

- `dist` 下同时出现：
  - `Chat2API-<version>-x64-setup.exe`
  - `Chat2API-<version>-x64-portable.exe`

## 结果摘要

- `npm run build:win` 通过
- `dist` 下已同时生成：
  - `Chat2API-1.2.0-x64-setup.exe`，大小 `77,083,979`
  - `Chat2API-1.2.0-x64-portable.exe`，大小 `70,047,981`
- 说明：
  - 本地默认 Windows 打包已恢复为同时产出 `setup.exe + portable.exe`
  - GitHub Actions 的 Windows 构建也会随 `package.json` 的 `win.target` 一起恢复生成 `portable.exe`
