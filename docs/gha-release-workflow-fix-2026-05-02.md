# GitHub Actions 故障调查与修复报告（2026-05-02）

## 1) 调查命令与结果

### 1.1 查看最近 run
```powershell
gh run list --limit 5
```
结果摘要：
- 最新 run：`25251828332`
- workflow：`.github/workflows/release.yml`
- 结论：`failure`
- 耗时：`0s`

### 1.2 查看 run 详情与日志
```powershell
gh run view 25251828332
gh run view 25251828332 --log --verbose
gh api repos/lim12137/Chat2API/actions/runs/25251828332/jobs
```
结果摘要：
- `gh run view` 显示：`This run likely failed because of a workflow file issue.`
- `--log` 返回：`failed to get run log: log not found`
- jobs API 返回：`"total_count": 0`（没有任何 job 被创建）

### 1.3 复现实锤报错（手动触发）
```powershell
gh workflow run release.yml -f platform=linux -f publish=false
```
关键报错：
```text
HTTP 422: Invalid Argument - failed to parse workflow:
(Line: 51, Col: 9): Unrecognized named-value: 'matrix'.
Located at position 105 within expression:
github.event_name == 'push' || github.event.inputs.platform == 'all' || github.event.inputs.platform == matrix.platform
```

## 2) 根因分析

- 在 `jobs.release.if` 中引用了 `matrix.platform`。
- GitHub Actions 在该位置解析时不允许这样使用 `matrix` 上下文，导致 workflow 在调度前解析失败。
- 因为解析阶段失败，所以 run 为 `0s`、无 job、无 step、无日志。

## 3) 修复方案

修改文件：`.github/workflows/release.yml`

- 新增 `prepare-matrix` job，根据触发方式动态生成 matrix JSON：
  - `push`：全平台矩阵；
  - `workflow_dispatch`：按 `platform` 仅生成目标平台矩阵。
- `release` job 改为：
  - `needs: prepare-matrix`
  - `strategy.matrix: ${{ fromJson(needs.prepare-matrix.outputs.matrix) }}`
- 删除原来在 `jobs.release.if` 中对 `matrix.platform` 的引用，避免解析错误。

## 4) 本地验证与结果摘要

### 4.1 构建前检查
```powershell
npm run prebuild:check
```
结果：通过（`✅ 构建前检查通过`）

### 4.2 构建验证
```powershell
npm run build
```
结果：通过（Electron/Vite 三段构建完成）

### 4.3 gh 侧验证说明
```powershell
gh workflow run release.yml -f platform=linux -f publish=false
```
结果：仍返回旧版本 workflow 的 422（远端文件尚未包含本地修复，未推送）。

结论：
- 本地 workflow 已修复并可通过本地构建链路验证；
- 远端 run 验证需在后续 push 后进行（本任务要求不推送，故到此为止）。

---

## 5) 补充调查（远端 run 25251909652）

用户补充的远端失败信息：
- run: `25251909652`
- 失败 job: `prepare-matrix`
- 错误：
  - `Invalid format '        {"os":"ubuntu-latest","arch":"x64","platform":"linux"},'`
  - `Unable to process file command 'output' successfully.`

根因：
- `prepare-matrix` 里将**多行 JSON**直接写入：
  - `echo "matrix=$MATRIX" >> "$GITHUB_OUTPUT"`
- `$GITHUB_OUTPUT` 的 `name=value` 语法要求 value 为单行（或使用 heredoc 多行格式），当前写法导致 output 文件命令解析失败。

二次修复：
- 将所有 `MATRIX='{"include":[...]}'` 改为**单行 JSON**，继续使用：
  - `echo "matrix=$MATRIX" >> "$GITHUB_OUTPUT"`
- 避免多行内容写入 `$GITHUB_OUTPUT` 导致的格式错误。

二次本地验证命令：
```powershell
npm run prebuild:check
npm run build
```
结果摘要：
- 两条命令均通过；
- `release.yml` 本地已更新为单行 matrix 输出；
- `gh workflow view ... --yaml` 读取的是远端版本，不代表本地未提交版本。
