# vscode-remote-byok

让 **Remote-SSH 远程窗口**里的 Copilot agent-host 会话（Copilot CLI / Chat）
能用 `chatLanguageModels.json` 里的自定义模型。

不用这个补丁时，远程窗口的模型选择器**只有 Auto**。

---

# 一、怎么用

## 1. 打补丁

```bash
S=~/.vscode-server/cli/servers/Stable-<commit>/server
NODE="$S/node"

scp patch.mjs adapter.js server-bridge.js <host>:/tmp/vrb/
ssh <host> 'cd /tmp/vrb && "$NODE" patch.mjs --server-dir "'"$S"'"'
```

> `--server-dir` 指向 `<cli-data-dir>/cli/servers/Stable-<commit>/server`。
> 不知道是哪个：`ls -1t ~/.vscode-server/cli/servers/ | head -1`。

## 2. 写配置

```bash
install -m 600 /dev/null ~/.vscode-server/data/User/chatLanguageModels.json
cat > ~/.vscode-server/data/User/chatLanguageModels.json <<'JSON'
[
  {
    "name": "My Endpoint",
    "vendor": "customendpoint",
    "apiType": "chat-completions",
    "apiKey": "${input:chat.lm.secret.0123456789}",
    "models": [
      { "id": "my-model", "name": "My Model", "url": "https://api.example.com/v1",
        "maxInputTokens": 200000, "maxOutputTokens": 16000 }
    ]
  }
]
JSON
```

> `apiKey` 写成 `${input:...}` 还是明文，取决于 §3 选哪条路。

## 3. 给密钥

`apiKey` 有两条路，取决于那台机器有没有 keyring。

**先判断**：`ls ~/.local/share/keyrings/` 有内容、且
`~/.vscode-server/data/User/globalStorage/state.vscdb` 里有 `secret://chat.lm.secret.*`
→ 有；否则没有（headless 服务器通常没有）。

**A. 有 keyring：用 VS Code 自己的方式（推荐）**

1. 远程窗口命令面板 `Manage Models` → 选中该 vendor 组 → 填 key
   （key 进 SecretStorage，配置文件里仍是占位符）
2. 打开桥接，让 server 把值注入 agent host：

   ```bash
   echo 'export VSCODE_BYOK_BRIDGE=1' >> ~/.vscode-server/server-env-setup
   ```

   > ⚠️ 这一句**只在部分构建里生效**（由启动脚本 source）。实测 VS Code Server 1.145
   > 的 `bin/code-server` **不** source 它，ssh 非登录 shell 也不读 `.bashrc`/`.profile`。
   > 如果你的机器不生效，就用下面的 B。

**B. 没有 keyring：直接写明文 `apiKey`**

适配器是直接读文件的，所以明文在我们的代码路径上可用：

```jsonc
"apiKey": "YOUR-API-KEY"
```

代价两条，想清楚再用：

- 密钥以明文存在配置文件里
- **只有 agent-host 会话能用**。普通 Chat 仍走 VS Code 的解析器
  （`decodeSecretKey` 会把明文截断后当 key 名去查 SecretStorage），所以那边拿不到

为什么不能既标准又简单：VS Code 设计上密钥只存 SecretStorage，
而远程 agent host 里**没有** SecretStorage（bundle 内 `secretStorageService` 为 0 处），
所以它只能靠外部给它 —— 要么桥接从 SecretStorage 拿（需 keyring），要么明文放文件。

## 4. 让补丁生效

| 改了什么 | 需要重启 |
| --- | --- |
| 只改了配置 / 环境变量 | **agent host**（重载或重连远程窗口） |
| 打了补丁（server-main 段） | **server 进程**（断开所有远程连接再连） |

确认进程真的换了：

```bash
ps -eo pid,lstart,args | grep "[t]ype=agentHost"
stat -c '%y' "$S/out/vs/platform/agentHost/node/agentHostMain.js"   # 启动时间要晚于 mtime
```

## 5. 验证

```bash
cat /tmp/vscode-remote-byok.log
# 期望：loaded pid=… models=1 providers=1        （没有 skipped=）
```

然后在远程窗口的 agent-host 会话里选模型发消息。日志出现下面这行就说明走通了：

```
[Copilot:…] Using custom provider: type=openai, baseUrl=…, wireApi=completions
```

## 6. 排查

| 现象 | 原因 |
| --- | --- |
| 选择器里没有模型 | 配置路径不对，或 `models=0` |
| `400 The requested model is not supported` | 补丁未生效（回落官方 API） |
| `does not support reasoning effort configuration` | 补丁未生效（进程还在跑旧代码） |
| 401 / 未授权 | 密钥没解析到 → 看日志里的 `missingSecrets` |
| 什么都没变 | 补丁没生效 → 对比进程启动时间与补丁 mtime |

## 7. 命令

```bash
"$NODE" patch.mjs --server-dir "$S"            # 打补丁（自动备份 .orig、幂等）
"$NODE" patch.mjs --server-dir "$S" --check    # 自检（VS Code 升级后会发现失效）
"$NODE" patch.mjs --server-dir "$S" --force    # 改了 adapter/bridge 后重打
"$NODE" patch.mjs --server-dir "$S" --revert   # 回滚
"$NODE" patch.mjs --server-dir "$S" --dry-run  # 只报告注入点
```

## 8. 本机开发（不是 Remote-SSH）

不用打补丁。本机 agent host 是 utility process，原生 BYOK 正常。
（打了也不影响：适配器是纯兜底，原生有模型时完全让位。）

---

# 二、原理

## 2.1 官方不支持，因为桥只在 utility process 注册

```js
// agentHostMain.ts
const server = utilityProcessServer ?? new ChildProcessServer(…);
if (server instanceof UtilityProcessServer) {        // Remote-SSH 走的是子进程
    byokLmBridgeRegistry.register(clientId, …);      // ← 整块被跳过
}
```

结果 `getModels()` 恒空，模型选择器只剩 Auto。
上游自己也这么写（`byokLmBridgeRegistry.ts`：*"…e.g. the remote agent host…"*），
VS Code 还会主动弹窗提示 "BYOK models aren't supported in remote Copilot sessions"。

## 2.2 补丁补的是哪两处输入

`znt()`（会话配置合成）只有两个输入，补丁各补一半：

```js
let byokModels = [...bridgeRegistry.getModels()];     // ① 模型来源 → 从配置读
const providers = ...map(vendor => ({
    name: vendor, wireApi: 'responses',
    baseUrl: handle.providerBaseUrl(vendor),          // ② 端点 → 直连真实地址
}));
```

Copilot SDK 的 provider 默认 `wireApi` 就是 `completions`，
所以直连即可，**不需要回环代理，也不需要协议翻译**。

端点归一化（`baseUrl` 给根地址、补 `/v1`）、provider 命名、以及绕开 SDK 对自定义模型的
reasoning 能力校验，都在适配器内部完成，**配置里不用管**。

共 9 处注入，两个文件：

| 文件 | 处 | 内容 |
| --- | --- | --- |
| `agentHostMain.js` | 6 | 插入 adapter、包住 registry、改 providers/models、短路 BQ/GQ |
| `server-main.js` | 3 | 插入 bridge、挂 DI、在 start() 里解析占位符注入 env（`VSCODE_BYOK_BRIDGE=1` 才启用） |

## 2.3 密钥为什么这么别扭

VS Code 的配置只接受占位符，真值在 SecretStorage：

```js
_resolveConfiguration(){ if (secret) { name = decodeSecretKey(v); v = await secretStorage.get(name); } }
```

`decodeSecretKey` 对任何字符串都做 `substring`，所以**明文会被截断后当 key 名去查** → 失效。

而 agent host 里没有 SecretStorage，只能由外部喂：桥接从 SecretStorage 解（需 keyring），
或直接把明文写进文件（我们的代码路径能读，但只有 agent-host 生效）。

## 2.4 限制

- 只对 agent-host 会话生效。
- 改 bundle 不是官方路径；**VS Code 升级会换 server commit，补丁失效**，`--check` 会发现，重跑即可。
- 自定义模型不能选 reasoning effort（SDK 以官方模型目录校验该能力）。
- 无 keyring 的机器上桥接不可用（`get(secretStorageService)` 会同步阻塞），用 §3 B 的明文方式。
