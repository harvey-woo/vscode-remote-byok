# vscode-remote-byok

让 **Remote-SSH 远程窗口**里的官方 Copilot（agent-host 会话：Copilot CLI / Chat）
能用 `chatLanguageModels.json` 里的自定义模型。

解决的问题：远程窗口里模型选择器**只有 Auto**，即使按官方文档把配置放到远程也没用。

```
vscode-remote-byok/
├── README.md                                本文
├── QUICKSTART.md                            30 秒上手
├── patch.mjs                                补丁脚本（--check / --force / --revert / --dry-run）
├── adapter.js                               agent host 侧适配器（读配置、provider 映射、密钥解析）
├── server-bridge.js                         可选：server 侧用 SecretStorage 解析占位符（默认关）
├── example.chatLanguageModels.json          配置示例（标准占位符，不含密钥）
└── example.chatLanguageModels.secrets.json  密钥兜底文件示例（0600）
```

---

## 1. 现象与官方立场

远程窗口里，agent-host 会话的模型选择器**只有 Auto**；本机同样配置却正常。

VS Code 会主动弹一条警告，出处
`src/vs/workbench/contrib/chat/browser/agentSessions/agentHost/agentHostRemoteByokNotification.ts`：

```js
message:     "Bring your own key (BYOK) models aren't supported in remote Copilot sessions."
description: "Use a GitHub Copilot model for this session, or switch to the local agent harness to use your own models."
```

运行时闸门在 `src/vs/platform/agentHost/node/agentHostMain.ts`：

```js
const server = utilityProcessServer ?? new ChildProcessServer(AgentHostIpcChannels.AgentHost);
if (server instanceof UtilityProcessServer) {          // ← 只有「本机 utility process」进得来
    byokLmBridgeRegistry.register(clientId,
        createAgentHostClientByokLmConnection(getChannel(AGENT_HOST_CLIENT_BYOK_LM_CHANNEL)));
}
```

Remote-SSH 时 agent host 是 server 拉起的**子进程**（`ChildProcessServer`）→ 整块被跳过
→ `getModels()` 恒空。上游注释也点名了：`byokLmBridgeRegistry.ts` 里
*"…e.g. **the remote agent host**…"*。

相关配置项只有两个，都救不了：

| 设置项 | 实际作用 |
| --- | --- |
| `chat.agentHost.byokModels.enabled` | 只 gate 上面那个「远程根本不执行」的分支 |
| `chat.agentHost.remoteByokNotification.disabled` | 只是把那条警告静音 |

**结论：纯配置无解。**

---

## 2. 为什么补丁能这么小

`copilotSessionLauncher.ts` 的 `synthesizeByokSessionConfig`（bundle 内 `znt()`）只有两个输入：

```js
let byokModels = [...bridgeRegistry.getModels()];              // ① 模型来源
const providers = [...new Set(byokModels.map(m => m.vendor))].map(vendor => ({
    name: vendor, type: 'openai', wireApi: 'responses',        // ② 端点
    baseUrl: handle.providerBaseUrl(vendor),                   //    指向 BYOK 回环代理
    bearerToken: `${handle.nonce}.${sessionId}`,
}));
const models = byokModels.map(m => ({ id: getByokLmSelectionModelId(m), provider: m.vendor, … }));
```

Copilot SDK 的 provider **默认 wireApi 就是 `completions`**
（`modelUsesResponsesApi`: `(n.wireApi ?? "completions") === "responses"`）。

所以把 ② 换成「直连真实端点 + `wireApi:'completions'`」就**不需要回环代理，也不需要协议翻译**；
剩下的只是把 ① 喂上。

---

## 3. 补丁做了什么

改 **两个** 文件，共 9 处注入。

### A. `out/vs/platform/agentHost/node/agentHostMain.js`（6 处）

| # | 位置 | 改动 |
| --- | --- | --- |
| 1 | 文件顶部 | 插入 `adapter.js` |
| 2 | `byok:{kind:"renderer",bridgeRegistry:b}` **之前最近的** `b=new MW` | 追加 `,b=__vscodeRemoteByok.wrap(b)` → 补上 `getModels()` |
| 3 | `znt()` providers 段 | `let a=__vscodeRemoteByok.providers(n),`（直连真实端点） |
| 4 | `znt()` models 段 | `provider: __vscodeRemoteByok.providerFor(l)` |
| 5 | `function BQ(o,i,e,t){` | 开头短路我们模型的 `reasoningEffort` |
| 6 | `function GQ(o,i,e){` | 开头短路我们模型的 `contextTier` |

> 第 2 处为什么不取「全文第一个 `b=new X`」：压缩后的标识符在作用域内会复用
> （同一个 `b` 可能既是 `TextDecoder` 又是 registry），必须锚定在 byok 描述符**之前最近的**那个。

### B. `out/server-main.js`（3 处，默认关闭）

| # | 位置 | 改动 |
| --- | --- | --- |
| 7 | 文件顶部 | 插入 `server-bridge.js` |
| 8 | `X.createInstance(<Starter>)` | 包成 `Object.assign(…, {__di: X})`，把 DI 容器挂到 starter 实例 |
| 9 | `<Starter>.start()` 开头 | `VSCODE_BYOK_BRIDGE=1` 时，用 server 的 SecretStorage 解析占位符 → 通过 `VSCODE_BYOK_SECRETS_JSON` 注入子进程 |

B 段默认**关闭**，原因见 §6。

---

## 4. 三个必须知道的坑

### 4.1 provider 名必须等于 vendor（否则 `400 The requested model is not supported`）

```js
function Zq(o){ return `${o.vendor}/${m_(o)}` }      // ① 客户端看到的模型 id
// ② 原始 znt(): providers 的 name 就是 l.vendor；models 的 provider 也是 l.vendor
```

SDK 的 BYOK 键 = `<provider 名>/<selectionId>`，只有 `provider 名 === vendor` 时它才等于 ①。
若为了让「一个 vendor 挂多个端点」而把 provider 名做成 `` `${vendor}--${hash}` ``，SDK 就查不到：

```js
resolveModelBackend(e){ let n = this.byokModels.get(e);
  if (!n) return { backend: "capi", id: e };   // ← 回落官方 API → 400（错误里带 GH 请求 ID）
}
```

**做法：改写 vendor 本身**（单端点保持原名，多端点加 `--<hash>`），
并让 `vendor` / provider 名 / `modelIdentifier` 三处一致。

### 4.2 reasoningEffort 必须在 agent host 侧压掉

```js
async _createSession(...){
  let s = r ? k1(i.model, r) : i.model;
  …client.createSession({ …, reasoningEffort: BQ(s, …), contextTier: GQ(s, …) })
}
function qnt(o){ let e = o?.config?.["thinkingLevel"] ?? o?.config?.["reasoningEffort"]; … }
function BQ(o,i,e,t){ return lAe(o, dAe(o,i,e,t) ?? qnt(o)) }
```

只要**客户端**仍带该模型的 `config.thinkingLevel`（可能是上次交互残留），
`reasoningEffort` 就会被送进 SDK；而 SDK 的元数据按 `capabilityModelId` 去官方模型目录查，
自定义模型不在目录 → 判定不支持 → 会话构造失败：

```
session construction failed: Model '<vendor>/<group>/<id>' does not support reasoning effort configuration.
```

所以补丁在 `BQ`/`GQ` 开头直接短路。**这比只改模型能力更硬 —— 不依赖客户端刷新缓存。**

### 4.3 `baseUrl` 必须给根地址

SDK 会自己往 baseUrl 后拼 wire 路径（本地 BYOK 代理的 baseUrl 是
`http://127.0.0.1:<port>/v/<vendor>`，请求实际落到 `…/v/<vendor>/responses` —— 路径是 SDK 拼的）。
给全路径会拼成 `…/v1/chat/completions/chat/completions` → 404。
适配器会剥掉 wire 后缀并按 `/v<N>` 规则补 `/v1`。

---

## 5. 配置与密钥

### 5.1 两件事要分清

VS Code 的 `chatLanguageModels.json` **只存占位符，不含密钥**；密钥在 **SecretStorage**：

```js
// ExtHostLanguageModels._resolveConfiguration
if (schema.properties?.[prop]?.secret) {
    const name = this.decodeSecretKey(value);      // ${input:chat.lm.secret.X} → chat.lm.secret.X
    value = name ? await this._secretStorageService.get(name) : void 0;
}
```

而且 `decodeSecretKey` 对**任何字符串**都做 `substring(indexOf(':')+1, len-1)`
（`Me(r){return typeof r=="string"}`），所以**明文 `apiKey` 会被截断再当 key 名查 → 必然失效**。
只有 `${input:…}` 有效。

因此「**文件格式**」和「**谁能拿到密钥**」是两件事：

| | 是否标准 | 说明 |
| --- | --- | --- |
| 文件里的占位符格式 | ✅ 标准 | 本机 / 远程的 VS Code 都能正确**解析**这个文件，同一份可原样复制 |
| 本机密钥来源 | ✅ 标准 | SecretStorage（`Manage Models` 输一次即可） |
| **远程 agent host 的密钥来源** | ⚠️ 非标准 | 该进程里没有 SecretStorage，见 §6 |

### 5.2 文件：保持标准格式

```jsonc
{
  "name": "My Endpoint",
  "vendor": "customendpoint",
  "apiType": "chat-completions",
  "apiKey": "${input:chat.lm.secret.0123456789}",   // ★ 与 VS Code 自己写出来的完全一致
  "models": [{
    "id": "my-model",
    "name": "My Model",
    "url": "https://api.example.com/v1",
    "maxInputTokens": 400000,
    "maxOutputTokens": 64000,
    "vision": true
  }]
}
```

放远程：`<data-dir>/User/chatLanguageModels.json`
（`<data-dir>/Machine/` 兜底；因为 `appSettingsHome = join(userDataPath, 'User')`）。

### 5.3 各场景怎么放密钥

| 场景 | 做法 | 是否标准 |
| --- | --- | --- |
| **本机桌面 VS Code** | `Manage Models` 填一次 key → 进本机 SecretStorage | ✅ 标准（本机不需要本补丁） |
| **远程窗口 · 普通 Chat** | 在**远程窗口**里 `Manage Models` 填一次 | ✅ 标准（前提：该机 SecretStorage 可用） |
| **远程窗口 · agent-host 会话** | 额外喂一次（见 §5.4） | ⚠️ 非标准，补丁的固有代价 |

### 5.4 远程 agent host 的密钥来源（按优先级）

1. **`VSCODE_BYOK_SECRETS_JSON`** —— JSON 字符串，由 server 侧桥接注入（§6），或你自己的启动 wrapper 给
2. **`VSCODE_SECRET_<NAME>`** 环境变量，如 `chat.lm.secret.ab12cd34` → `VSCODE_SECRET_CHAT_LM_SECRET_AB12CD34`
3. **同级 secrets 文件**（0600）：

   ```
   <配置文件所在目录>/chatLanguageModels.secrets.json
   { "chat.lm.secret.0123456789": "REPLACE_WITH_YOUR_KEY" }
   ```

   也认 `<配置文件去掉 .json>.secrets.json`。

> 第 3 条是**本补丁的扩展**，不是 VS Code 的设计。它只补「agent host 拿不到 SecretStorage」
> 这件事，**不改变配置文件的标准性**：配置仍是纯占位符，仍可在本机/远程之间原样复制。

三者都没有 → 记入 `missingSecrets` 并明确告警（不再静默 401）。

### 5.5 其他写法（兼容，一般不需要）

| 写法 | 说明 |
| --- | --- |
| `apiKey: "YOUR-API-KEY"` | ⚠️ VS Code 侧无效（会被截断再当 key 名查）；补丁会直接用，但两边行为不一致，不建议 |
| `requestHeaders: { authorization: "Bearer ${apiKey}" }` | 用解析后的 `apiKey` 填充该头 |
| `requestHeaders: { "x-api-key": "${input:chat.lm.secret.X}" }` | 头里也可写占位符 |
| `requestHeaders: { authorization: "Bearer YOUR-API-KEY" }` | 明文头（网关不吃 `Authorization` 时才需要） |

### 5.6 不要写 reasoning effort

不要写 `supportsReasoningEffort` / `settings.reasoningEffort` —— 适配器会忽略（§4.2），
写了也只会在诊断里记一条 skip。

---

## 6. 可选：B 段（让密钥走真正的 SecretStorage）

B 段会在 fork agent host 之前，用 **server 自己的 SecretStorage** 解析占位符，
结果经 `VSCODE_BYOK_SECRETS_JSON` 注入子进程（子进程 env = `i8(process.env, …)`，可继承）。

### 默认关闭

需要 `VSCODE_BYOK_BRIDGE=1`。

**原因（实测）**：在**无头 Linux（没有 keyring / Secret Service）**上，
`instantiationService.get(secretStorageService)` 会**同步阻塞** —— 日志停在
`di.get(token=secretStorageService) …` 就再也不返回，连 `Promise.race` 的超时也抢不走
（同步阻塞时定时器不跑）。一旦阻塞会拖住 agent host 启动。
有可用 keyring 的机器上它是即时且正常的，所以做成开关。

### 启用与验证

```bash
echo 'export VSCODE_BYOK_BRIDGE=1' >> ~/.vscode-server/server-env-setup
# 重启 server 后：
tail -5 /tmp/vscode-remote-byok.log
#   bridge: resolved N/M secret(s) from SecretStorage   → 成功
#   bridge: SecretStorage has 0/M (k timed out)          → 该机不可用，继续用兜底
```

判定某台机器能否用标准流程：

```bash
ls -la <data-dir>/User/globalStorage/state.vscdb    # 存在且含 secret://chat.lm.secret.* 才有数据
ls -la ~/.local/share/keyrings/ 2>/dev/null         # 无 keyring 的机器基本用不了
```

---

## 7. 用法

```bash
S=<server bundle 根目录>       # ~/.vscode-server/cli/servers/Stable-<commit>/server
NODE="$S/node"                 # server 自带的 node；没有就用系统 node

"$NODE" patch.mjs --server-dir "$S"              # 打补丁（自动备份 .orig、幂等、node --check）
"$NODE" patch.mjs --server-dir "$S" --check      # 自检（升级后会失效）
"$NODE" patch.mjs --server-dir "$S" --force      # 改了 adapter.js / server-bridge.js 后重打
"$NODE" patch.mjs --server-dir "$S" --revert     # 回滚（两个文件一起还原）
"$NODE" patch.mjs --server-dir "$S" --dry-run    # 只报告注入点与字节数
```

---

## 8. 生效（最容易踩的一步）

| 段 | 需要什么 | 说明 |
| --- | --- | --- |
| A（agent host） | **agent host 进程重启** | 重载/重连窗口即可 |
| B（server-main） | **server 进程重启** | label 窗口重载**不会**重启 server |

判断是否真的换了进程（对比启动时间与补丁 mtime）：

```bash
ps -eo pid,lstart,args | grep "[t]ype=agentHost"
stat -c '%y' "$S/out/vs/platform/agentHost/node/agentHostMain.js"   # macOS: stat -f %Sm
```

- **进程启动时间早于补丁 mtime** → 还在跑旧代码
- 让 server 重启：断开所有远程连接后重连；或精确 kill（见下）

> ⚠️ **别用 `ps | grep` 拿 pid 直接 kill** —— 会把 grep 自己/你的 shell 也算进去。
> 安全做法（精确匹配 cmdline 的第 2 个参数）：
>
> ```bash
> for d in /proc/[0-9]*; do p=${d#/proc/}; [ -r "$d/cmdline" ] || continue
>   case "$(tr '\0' '\n' < "$d/cmdline" | sed -n '2p')" in */out/server-main.js) echo "$p";; esac
> done
> ```
>
> ⚠️ `ServerAgentHostManager` 有**重启预算**：连续失败 5 次会 `giving up after 5 restarts`。
> 但预算耗尽时 `_restartCount` 已归零，且 server 有 lazy 的 `agentHostProxy` 通道
> **每次 renderer 连接都会 `ensureStarted()`** → **重载/重连窗口就能拉回来**。

---

## 9. 诊断

```bash
cat /tmp/vscode-remote-byok.log
```

| 日志 | 含义 |
| --- | --- |
| `loaded pid=… file=… models=N providers=M` | 适配器已加载（N=0 检查路径/JSON） |
| `skipped=N` | N 条被跳过的模型/配置（`VSCODE_REMOTE_BYOK_DEBUG=1` 看详情） |
| `[Copilot:…] Wired N BYOK model(s) across M provider(s) via …` | 已注入该会话 |
| `Using custom provider: type=openai, baseUrl=…, wireApi=completions` | SDK 确认用了我们的 provider（**成功标志**） |
| `400 … The requested model is not supported` | 回落官方 API → §4.1 的 id 不一致 |
| `does not support reasoning effort configuration` | §4.2 未生效（进程没换 / 补丁没打） |
| `bridge: resolved …` | B 段成功 |
| `bridge: SecretStorage has 0/…` | 该机拿不到密钥，继续用兜底 |

环境变量：

| 变量 | 作用 |
| --- | --- |
| `VSCODE_REMOTE_BYOK_LOG` | 日志路径（默认 `/tmp/vscode-remote-byok.log`） |
| `VSCODE_REMOTE_BYOK_DEBUG=1` | 详细日志 |
| `VSCODE_REMOTE_BYOK_FILE` | 显式指定配置文件 |
| `VSCODE_REMOTE_BYOK_SECRETS` | 显式指定 secrets 文件 |
| `VSCODE_BYOK_SECRETS_JSON` | 直接给一份 `{name: value}` JSON（最高优先级） |
| `VSCODE_BYOK_BRIDGE=1` | 开启 B 段（server 侧 SecretStorage 桥接） |

---

## 10. 限制

- 仅对 **agent-host 会话** 生效（远程窗口里 Copilot CLI / Chat 都走远程 agent host）。
- 这是**改 bundle** 的做法，不是官方支持路径；VS Code 升级会换 server commit，补丁失效
  （`--check` 会发现，重跑即可）。
- 自定义模型不支持 reasoning effort 选择器（§4.2）。
- `apiType: "messages"`（Anthropic 形状）会被降级为 chat-completions 处理。
- 在无 keyring 的机器上，B 段不可用（§6）。

---

## 11. 已验证

- 全新 bundle 副本：`--dry-run` / apply / `--check` / `--revert` 全通过；两个文件 `node --check` 通过
- 补丁后 server 可正常启动（本地冒烟：socket 建立、进程存活）
- `BQ`/`GQ` 守卫**功能**测试：我们的模型返回 `undefined` 且**不调用**辅助函数（真短路）；
  官方模型 `copilot/auto` 行为不变
- id 一致性：`modelIdentifier` 的 vendor 前缀 == `providerFor()` == provider 名
- 多端点（同一 vendor 多个 URL/凭据）自动分配唯一 vendor，三处一致
- 模型 id 稳定：换密钥不改变 id（provider 名不与密钥值相关）
- 凭据解析矩阵：标准占位符（文件/环境变量/注入 JSON）、明文 `apiKey`、
  `requestHeaders: Bearer ${apiKey}`、头内占位符、缺失场景（正确报 `missingSecrets`）
- 真实远程：适配器随 agent host 启动加载；端点调用返回 `200` 且模型有正常回复
- B 段：注入点与开关校验通过；**在无 keyring 的机器上实测会阻塞，故默认关闭**
