# 30 秒上手

## 0. 前提

- 远程机上有 `~/.vscode-server/cli/servers/Stable-<commit>/server`
- 会用 SSH 到那台机器

## 1. 打补丁

```bash
S=~/.vscode-server/cli/servers/Stable-<commit>/server   # 换成你自己的 commit
NODE="$S/node"

# 把本目录三个文件传上去
scp patch.mjs adapter.js server-bridge.js <host>:/tmp/vscode-remote-byok/

ssh <host>
cd /tmp/vscode-remote-byok
"$NODE" patch.mjs --server-dir "$S"
"$NODE" patch.mjs --server-dir "$S" --check      # 应输出 ✅ 已打补丁
```

## 2. 填配置

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

## 3. 放密钥（三选一）

**A. 在远程窗口里用 VS Code 自己的方式**（有 keyring 的机器推荐）

命令面板 → `Manage Models` → 选中刚才的 vendor 组 → 填 key。
（key 进远程 SecretStorage，文件仍是占位符。）

**B. 兜底文件**（最省事）

```bash
install -m 600 /dev/null ~/.vscode-server/data/User/chatLanguageModels.secrets.json
cat > ~/.vscode-server/data/User/chatLanguageModels.secrets.json <<'JSON'
{ "chat.lm.secret.0123456789": "REPLACE_WITH_YOUR_KEY" }
JSON
```

**C. 环境变量**

```bash
# chat.lm.secret.0123456789 → VSCODE_SECRET_CHAT_LM_SECRET_0123456789
```

## 4. 重启，让补丁生效

```bash
# 先看当前进程启动时间
ps -eo pid,lstart,args | grep "[t]ype=agentHost"

# 断开重连远程窗口（会重启 agent host）
# 若 server-main 也打了 B 段，还需要 server 进程重启
```

## 5. 验证

```bash
cat /tmp/vscode-remote-byok.log
# 期望：loaded pid=… models=1 providers=1        （没有 skipped=）
```

然后在远程窗口的 agent-host 会话里选模型、发消息。
agent host 日志里出现下面这行就说明真的走了我们的 provider：

```
[Copilot:…] Using custom provider: type=openai, baseUrl=https://api.example.com/v1, wireApi=completions
```

## 本机开发要不要打这个补丁？

**不需要。** 本机（不是 Remote-SSH）的 agent host 是 utility process，原生 BYOK 桥是好的。
适配器在那种情况下会**完全让位**（`registry.getModels()` 非空即静默），
所以即使打了补丁也不会产生重复 provider、也不会影响原生行为。

判定很简单：看日志 `describe().nativeActive`，或直接看
`/tmp/vscode-remote-byok.log` 里有没有 `models=N`（你文件里的模型数）——
本机有原生模型时，我们不会把自己那份塞进去。

## 出问题看这里

| 现象 | 去看 |
| --- | --- |
| 选择器里没有模型 | §5 配置路径 / `models=0` → 文件没读到 |
| `400 The requested model is not supported` | README §4.1（id 不一致，回落官方 API） |
| `does not support reasoning effort` | README §4.2（进程没换，还在跑旧代码） |
| 401 / 未授权 | 密钥没解析到 → 看 `missingSecrets` |
| 什么都没有 | 进程没重启 → 对比 `ps` 启动时间与补丁 mtime |

完整说明见 [README.md](./README.md)。
