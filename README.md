# dsh-auto-continue — 重启后自动继续任务 + 自动修复损坏会话

host + web client 插件。每次启动 DeepSeek Harness 时:

1. **自动修复**:扫描 `$DSH_HOME/sessions` 下所有会话日志,发现被并发写入损坏的(重复/重叠事件段,即两个 dsh 实例同时写同一会话的痕迹)自动**无损修复**——去重、裁剪重叠、保留全部唯一事件,原子写回并备份原文件。真缺口(事件确实丢失)不自动处理,记日志等人工。
2. **自动继续**:找到**最近一个**(或全部,见 `onlyMostRecent`)最后回合未正常完成的会话,按会话自己的模型配置与 agent 预设重建,注入"继续"消息让 agent 接着跑。
3. **可见提示**:Web UI 弹出横幅(「已自动恢复上次未完成的任务」+「打开会话」按钮)与系统通知。

## 安装

```sh
cd <harness>
dsh plugin --profile web add file:/path/to/dsh-auto-continue
```

## 配置

配置写在插件 bundle 的 `cordis.patch.yml` 里(安装后随 bundle 层加载):

```yaml
- insert:
    - id: dsh-auto-continue
      name: dsh-auto-continue
      config:
        enabled: true
        prompt: 系统刚刚重启。请从上次中断的地方继续完成任务，并在完成后简要汇报。
        continueOn: [interrupted, error, max-tokens, aborted]
        skipSubagents: true
        onlyMostRecent: true
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `prompt` | 见 patch | 注入的“继续”消息文本 |
| `continueOn` | `[interrupted, error, max-tokens, aborted]` | 哪些结束原因算“未完成” |
| `skipSubagents` | `true` | 跳过子代理/派生的会话 |
| `onlyMostRecent` | `true` | 只恢复最近一个未完成会话 |
| `repairOnBoot` | `true` | 启动时自动修复损坏的会话日志 |
| `repairMinAgeMs` | `60000` | 修复时跳过最近 N 毫秒内修改过的会话(可能正在被写入) |
| `logFile` | `$DSH_HOME/auto-continue.log` | 运行日志路径 |

## 行为

- host 启动、`loader` 树沉降后执行(与 headless runner 同款时机),服务未就绪会短暂重试;
- **自动修复**(`repairOnBoot`):遍历所有会话日志,用官方同款 zstd 帧扫描 + 记录解码检测损坏(重复事件段),无损重建文件,备份为 `session.jsonl.zstd.bak-auto`;真缺口只记录不处理;
- 判定“未完成”:事件日志里存在未配对的 `turn/start`(崩溃现场),或最后一个 `turn/end` 的 reason 落在 `continueOn` 里;
- **归档会话一律跳过**(读 `$DSH_HOME/storages/workspace.json` 的归档集合);
- 本进程已经 live 的会话(API 网关刚恢复过)跳过,避免双驱动写同一个日志;
- 恢复后注入一条 `source: { kind: 'plugin', plugin: 'dsh-auto-continue' }` 的用户消息,agent 自动跑完;
- 全部会话都正常结束时不动作,只记一条 `SKIP` 日志。

## 观察

每次执行追加一行到 `$DSH_HOME/auto-continue.log`:`REPAIR <path> fixes=N events=M`(自动修复)/ `RESUME <session-id>` / `SKIP ...` / `FAIL <id> <原因>` / `WARN ...`。

## 已知限制

- **跨进程互斥**:插件启动时通过 `$DSH_HOME/.auto-continue.lock`(目录锁 + pid)保证同一份 `~/.dsh` 同时只有**一个实例**执行自动恢复——多个 dsh 进程并发恢复同一会话会把事件写重复、损坏会话日志(已因此损坏过会话)。拿不到锁的实例会记一条 `SKIP another instance holds the resume lock` 并退出;崩溃残留的死锁会被自动回收。
- 恢复使用的 agent 预设取会话**自己记录**的值;从未记录过预设的会话会跟随当前默认预设(与 harness 自带行为一致)。
- 横幅只在「本次启动确实恢复了会话」时显示;全部完成时无横幅(正确行为)。

## 开发注意

`dsh plugin add file:...` 会把插件**复制**进 profile 的 node_modules,而不是符号链接。改 `lib/` 或 `cordis.patch.yml` 后需重新 `dsh plugin add`(或手动同步到 `node_modules/<name>/` 下)再重启才生效;客户端 bundle 在启动时由 host 组装,同样需要重启。
