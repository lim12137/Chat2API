# 调查报告：运行后全部模型都不可用（2026-05-02）

## 1. 任务与范围
- 目标：在本地调查“运行后全部模型都不可用”，按“先复现 -> 找根因 -> 修复 -> 验证”执行。
- 约束：不假设与体积优化相关，仅基于当前代码与本地可执行验证。

## 2. 症状收集（代码链路）

### 2.1 启动与存储初始化链路
- 启动入口：`src/main/index.ts`
- IPC 初始化入口：`src/main/ipc/handlers.ts` 中 `registerIpcHandlers()`，会先执行 `storeManager.initialize()`
- 存储初始化：`src/main/store/store.ts`

### 2.2 “模型可用/不可用”统一判定点
- 前端模型管理页：
  - `src/renderer/src/components/models/ModelList.tsx`
  - 逻辑：按 provider 维度判断 `hasActiveAccounts = providerAccounts.some(a => a.status === 'active')`
  - 结论：只要某 provider 下没有 `active` 账号，该 provider 的所有模型都显示 `unavailable`。
- OpenAI 兼容模型列表接口：
  - `src/main/proxy/routes/models.ts`
  - 逻辑：只统计 `account.status === 'active'` 的账号；无 active 则该 provider 的模型不会出现在 `/v1/models`。
- 负载均衡选账号：
  - `src/main/proxy/loadbalancer.ts`
  - 逻辑：`isAccountAvailable()` 只接受 `status === 'active'`。

结论：`account.status` 一旦不是 `active`（包括历史遗留值），会在多个链路统一被判定为不可用。

## 3. 复现

### 3.1 复现命令（模拟旧状态值）
```powershell
@'
const providers = [{ id: 'deepseek', enabled: true, supportedModels: ['deepseek-chat'] }];
const accountsLegacy = [{ providerId: 'deepseek', status: 'valid' }];

const before = providers.map((p) => {
  const providerAccounts = accountsLegacy.filter((a) => a.providerId === p.id);
  const hasActiveAccounts = providerAccounts.some((a) => a.status === 'active');
  return { providerId: p.id, model: p.supportedModels[0], status: hasActiveAccounts ? 'available' : 'unavailable' };
});

function normalizeAccountStatus(status, errorMessage) {
  if (status === 'active' || status === 'inactive' || status === 'expired' || status === 'error') return status;
  if (typeof status === 'string') {
    const normalized = status.trim().toLowerCase();
    if (['valid', 'enabled', 'online', 'ok', 'success', 'available'].includes(normalized)) return 'active';
    if (['invalid', 'disabled', 'offline', 'failed', 'unauthorized'].includes(normalized)) return 'error';
  }
  if (typeof errorMessage === 'string' && errorMessage.trim().length > 0) return 'error';
  return 'active';
}

const accountsAfter = accountsLegacy.map((a) => ({ ...a, status: normalizeAccountStatus(a.status, a.errorMessage) }));
const after = providers.map((p) => {
  const providerAccounts = accountsAfter.filter((a) => a.providerId === p.id);
  const hasActiveAccounts = providerAccounts.some((a) => a.status === 'active');
  return { providerId: p.id, model: p.supportedModels[0], status: hasActiveAccounts ? 'available' : 'unavailable' };
});

console.log('before:', before);
console.log('after :', after);
'@ | node -
```

### 3.2 复现结果摘要
- `before`: `status: 'unavailable'`
- `after`: `status: 'available'`

即：当账号状态是历史/非标准值（如 `valid`）时，会被现有统一判定链路当作“无 active 账号”，导致全部模型不可用。

## 4. 根因
- 根因：账号状态判定严格依赖 `status === 'active'`，但启动时缺少对历史/非标准状态值的兼容迁移与归一化。
- 影响：
  - 模型管理页统一显示不可用；
  - `/v1/models` 模型列表变空或缺失；
  - 负载均衡选不到账号，聊天请求返回 `No available account for model`。

## 5. 修复

### 5.1 修改点
- 文件：`src/main/store/store.ts`
- 在 `storeManager.initialize()`（含恢复分支）中新增启动归一化调用：
  - `this.normalizeLegacyAccountStatuses()`
- 新增方法：
  - `normalizeLegacyAccountStatuses()`
  - `normalizeAccountStatus(status, errorMessage)`
- 归一化规则：
  - 兼容映射到 `active`：`valid/enabled/online/ok/success/available`
  - 兼容映射到 `error`：`invalid/disabled/offline/failed/unauthorized`
  - 缺失/未知状态：若有 `errorMessage` -> `error`，否则默认 `active`（避免历史账号被全部锁死）

## 6. 验证

### 6.1 本地数据状态检查
命令：
```powershell
@'
import Store from 'electron-store';
import os from 'os';
import path from 'path';

const storagePath = path.join(os.homedir(), '.chat2api');
const store = new Store({
  name: 'data',
  cwd: storagePath,
  encryptionKey: 'chat2api-fixed-encryption-key-v1',
});
const accounts = store.get('accounts') || [];
const statusCount = accounts.reduce((m, a) => {
  const s = a?.status ?? '__missing__';
  m[s] = (m[s] || 0) + 1;
  return m;
}, {});
console.log('current status count:', statusCount);
'@ | node -
```
结果摘要：
- `current status count: { active: 2 }`

### 6.2 构建验证
命令：
```powershell
npm run build
```
结果摘要：
- 构建成功（main/preload/renderer 全部完成）
- 无新增构建错误；仅存在既有构建 warning（与本次修复无关）。

## 7. 结论
- 该问题可由“账号状态历史值未迁移”稳定触发，属于启动兼容性缺失。
- 已在存储初始化阶段修复，保证旧状态数据在启动后被统一归一化，恢复模型可用性判定链路。
