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

**默认用 B**（不加任何额外条件就能用）。A 是标准做法，但需要你能把环境变量送进 server 进程。

**B. 明文写进配置**（开箱可用）

```jsonc
"apiKey": "YOUR-API-KEY"
```

适配器直接读文件，所以明文在我们的代码路径上可用。代价两条：

- 密钥以明文存在配置文件里（0600）
- **只有 agent-host 会话能用**。普通 Chat 仍走 VS Code 的解析器，
  它会把明文截断后当 key 名去查 SecretStorage → 拿不到

**A. 用 SecretStorage**（需要 keyring + 能注入 env）

1. 远程窗口命令面板 `Manage Models` → 选中该 vendor 组 → 填 key
   （key 进 SecretStorage，配置文件里保持 `${input:...}` 占位符）
2. 让 server 把值注入 agent host：需要给 server 进程设 `VSCODE_BYOK_BRIDGE=1`

   ```bash
   # 前提：有 ~/.local/share/keyrings/，且 state.vscdb 里能写入 secret://chat.lm.secret.*
   echo 'export VSCODE_BYOK_BRIDGE=1' >> ~/.vscode-server/server-env-setup
   ```

   > 实测 VS Code Server 1.145 的 `bin/code-server` **不** source 这个文件，
   > ssh 非登录 shell 也不读 `.bashrc` / `.profile`。所以这一句在很多机器上不生效 ——
   > 你需要自己确认一种能把 env 送进 server 进程的方式（否则桥接不会启动）。

为什么 B 存在：agent host 里**没有** SecretStorage（bundle 内 `secretStorageService` 为 0 处），
而 VS Code 的配置解析器只认占位符，所以它只能靠外部喂 —— 要么桥接从 SecretStorage 拿，要么明文放文件。

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
| `does not support reasoning effort configuration` | 旧版补丁遗留；当前版本不会再报这个（见 §2.4） |
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

远程和本机是**两个独立的 user data 目录**，配置各放一份：

| | 配置位置 |
| --- | --- |
| 本机桌面 | `~/.config/Code/User/`（macOS：`~/Library/Application Support/Code/User/`） |
| Remote-SSH | `~/.vscode-server/data/User/` |

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
以及 reasoning 能力的处理，都在适配器内部完成，**配置里不用管**（写上也不会报错）。

共 9 处注入，两个文件：

| 文件 | 处 | 内容 |
| --- | --- | --- |
| `agentHostMain.js` | 6 | 插入 adapter、包住 registry、改 providers/models、短路 BQ/GQ |
| `server-main.js` | 3 | 插入 bridge、挂 DI、在 start() 里解析占位符注入 env（`VSCODE_BYOK_BRIDGE=1` 才启用，见 §3 A） |

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
- **自定义模型没有 reasoning effort 选择器**：agent host 无法让该能力生效（SDK 按官方模型目录
  校验自定义模型），下发只会出现一个选了没作用的下拉，所以适配器发布模型时省略它。
  配置里的 `supportsReasoningEffort` / `settings.reasoningEffort` **可以保留**，
  这样远程与本机可以是同一份 JSON —— 这是本补丁唯一无法与本地对齐的功能点。
- 桥接（§3 A）要求：该机有可用 keyring，且你能把 `VSCODE_BYOK_BRIDGE=1` 送进 server 进程。
  无 keyring 时 `get(secretStorageService)` 还会同步阻塞，所以默认关闭。
