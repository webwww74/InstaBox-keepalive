# InstaBox 保活 Cloudflare Worker 部署教程

> 目标：用一个 Cloudflare Worker，每 10 分钟给 InstaBox 主机做一次保活，防止它因闲置 30 分钟被自动暂停。
>
> 实测通过日期：2026-10-24（北京时间）。本文档里的代码是修复后的最终版，之前第一版的两个 400 报错已修掉，见文末“踩坑记录”。
>
> 注意：本文档不含任何真实的 API Key 和机器 ID，示例里的 `ibk_...`、`m_...` 都是占位符，部署时换成你自己的。

## 0. 原理（先说清楚，避免误解）

Worker 本身**不能直接在 InstaBox 主机上跑 shell 命令**，它只能调 InstaBox 官方 API，让 API 在主机里跑命令。

每 10 分钟，Worker 做两件事：

1. **唤醒：** `POST https://api.instabox.sh/v1/machines/{id}/resume`
   机器如果已被暂停，把它唤醒；如果已经在运行，返回 200 / 202 / 409 都算正常。
2. **机器内活动：** `POST https://api.instabox.sh/v1/machines/{id}/exec`
   在机器里跑一条极轻的心跳命令，写一个 `/tmp/instabox-keepalive.txt`，让机器里产生一次活动，而不只是 API 层面碰一下。

官方依据：

- API 基础地址：`https://api.instabox.sh`
- 认证：`X-API-Key` 请求头（或 `Authorization: Bearer`）
- 闲置机器 30 分钟后会自动暂停
- 完整字段定义：`https://api.instabox.sh/v1/openapi.json`
- 官方定价页：`https://instabox.sh/pricing`

## 1. 准备工作

你需要准备好两样东西：

| 名称 | 格式 | 用途 |
| --- | --- | --- |
| API Key | `ibk_...` 开头 | Worker 调用 InstaBox API 的凭据 |
| 机器 ID | `m_...` 开头 | 要保活的那台机器的唯一 ID |

**机器名不是机器 ID。** 像 `instabox-instapp99` 这种名字是给 CLI 用的，Worker 里必须填 `m_...` 开头的 ID，填名字会报 404。

## 2. 第一步：拿到 API Key

1. 打开 `https://dashboard.instabox.sh`，登录。
2. 右上角头像 → Profile → API keys → Create 新建一个。
3. **立刻复制下来，`ibk_...` 开头，关掉页面就再也看不到了。**
4. 建的时候选 **Full access**，不要只选只读。
   因为保活不光要查列表，还要调 resume 和 exec，那两个需要写权限。只读 Key 到 Worker 里后面会报权限不足（`insufficient_scope`）。

注意：InstaBox 用 Google 登录和 GitHub 登录是分开的两个账号，Key 必须是在有这台机器的那个登录方式下建的，否则查出来是空列表。

## 3. 第二步：拿到机器 ID

### 方法 A：一条命令查（最准）

在任何一台有 curl 的机器上跑（你的 VPS、你电脑的终端都行），把 Key 换成你自己的：

```bash
curl -s https://api.instabox.sh/v1/machines -H "X-API-Key: ibk_你的Key"
```

返回里会是这样一对一对的，找到名字是你那台的那条，复制它前面的 `id`：

```json
"id": "m_xxxxxxxx",
"name": "instabox-instapp99"
```

- 返回空列表 `[]`：Key 和机器不在同一个账号下，见上一节的登录方式提醒。
- 返回 401：Key 错了或过期了，重新建一个。

### 方法 B：仪表盘地址栏

打开机器详情页，看浏览器地址栏，ID 经常藏在地址里，形如：

```text
dashboard.instabox.sh/.../m_xxxxxxxx
```

页面正文里没有，就看地址栏那一段。

## 4. 第三步：部署 Worker

### 方式一：仪表盘粘贴部署（推荐新手）

1. 打开 `https://dash.cloudflare.com` → Workers & Pages → Create / 打开你已有的 Worker。
2. 把附录里的完整代码整个粘贴进去，点 **Save and Deploy**。
   **只 Save 不 Deploy 不生效。**
3. 变量配置见第 5 节，定时配置见第 6 节。

### 方式二：wrangler 命令部署

把 Worker 代码存为 `instabox-keepalive-worker.js`，再建一个 `wrangler.toml`：

```toml
name = "instabox-keepalive"
main = "instabox-keepalive-worker.js"
compatibility_date = "2026-10-24"

[triggers]
crons = ["*/10 * * * *"]
```

然后依次执行（不要把 Key 写进这个文件）：

```bash
wrangler secret put INSTABOX_API_KEY
wrangler secret put INSTABOX_MACHINE_ID
wrangler deploy
```

用 wrangler 部署的，定时已经包含在 toml 里，不用再手动加 Cron。

## 5. 第四步：配置 API（关键一步）

代码里要的变量名必须一字不差，大小写也不能错：

- `INSTABOX_API_KEY`
- `INSTABOX_MACHINE_ID`

仪表盘操作：

1. Workers & Pages → 点你刚部署的那个 Worker。
2. Settings → Variables and Secrets（有的界面叫 Variables）→ Add variable。
3. 第一条：
   - Variable name：`INSTABOX_API_KEY`
   - Value：粘贴 `ibk_...`
   - **勾上 Encrypt**，这样它才是 Secret，不会明文显示。
4. 第二条：
   - Variable name：`INSTABOX_MACHINE_ID`
   - Value：粘贴 `m_...`
   - Encrypt 勾不勾都行。
5. 点 Save 保存。如果它提示要重新部署，就去 Deployments 点 Redeploy 最新一次，否则新变量可能还没生效。

**安全红线：Key 绝对不要直接写进 Worker 代码里，只填在这个 Variables 位置；也不要把 Key 发给别人或贴到公开地方。**

## 6. 第五步：加上定时触发

这一步最容易漏：

- **仪表盘粘贴部署的，wrangler.toml 是不起作用的，必须手动加定时：**
  Worker → Settings → Triggers → Add Cron Trigger → 填 `*/10 * * * *` → 保存。
  这个表达式的意思是每 10 分钟跑一次，远小于 30 分钟的闲置暂停阈值。
- **wrangler 部署的，跳过这一步**，定时已经在 toml 里了。

如果你的 Workers 套餐没有 Cron Trigger，也可以用外部定时器每 10 分钟请求一次 Worker 的 `/keepalive` 地址，效果一样。代码本身同时支持 Cron 和 HTTP 触发。

## 7. 第六步：验证是不是全通了

把 `你的Worker名` 换成你自己的 Worker 子域名。

### 7.1 查配置

访问：

```text
https://你的Worker名.workers.dev/status
```

应该看到：

```json
{
  "machineId": "m_...",
  "apiKeyConfigured": true
}
```

- `apiKeyConfigured` 是 `false`：名字拼错了，或者没保存、没重新部署。
- 这个接口**不回显 Key 本身**，只告诉你配没配。

### 7.2 跑一次保活

访问：

```text
https://你的Worker名.workers.dev/keepalive
```

应该看到 `ok: true`，`resumeStatus` 是 200 或 202。

### 7.3 最终验证

之后不用管它，等机器闲置超过 30 分钟再去 InstaBox 仪表盘看一眼，如果还是 running 状态没被暂停，就算彻底验证过了。

## 8. 故障排查对照表

`/keepalive` 返回里重点看 `resumeStatus`、`exec.status`、`exec.data.error.code` / `error.message`。

| 现象 | 原因 | 怎么办 |
| --- | --- | --- |
| `apiKeyConfigured: false` | 变量名拼错 / 没保存 / 没重新部署 | 对照第 5 节重填，Save 后 Redeploy |
| `resumeStatus` 401 | Key 错、过期，或 Key 和机器不在同一账号 | 重新建 Key，注意 Google / GitHub 登录是分开的账号 |
| `resumeStatus` 404 | `machineId` 填错，或机器已删 | 用第 3 节的 curl 重新查一遍列表对一下 |
| `resumeStatus` 403，`error.code` 是 `insufficient_scope` | Key 是受限的只读 Key | 换 Full access 的 Key |
| `resumeStatus` 400，`Idempotency-Key header is required` | 缺幂等头 | 用附录最终版代码，旧版有这个 bug，已修 |
| `exec.status` 400，`cmd is required` | exec 字段名错 | 用附录最终版代码，字段必须是 `cmd`，不是 `command`，旧版有这个 bug，已修 |
| `exec.data.error.code` 是 `machine_not_running` | 机器是彻底停了不是暂停，或 resume 还在进行中 | 再跑一次 `/keepalive` 看看 |
| `resumeStatus` 409 | 机器正忙于另一个操作 | 等一会儿再跑一次，不一定是真故障 |
| 返回 502，但 `ok: false` | 上面某一步失败 | 把完整返回（不含 Key）贴出来，按里面的 `code` 查表 |

## 9. 限制，先说清楚

- 保活只能防“闲置 30 分钟自动暂停”。
- 关于“免费版最长 480 分钟”：2026-10-24 再查官方定价页时，免费档只列了 1 台机器、4 vCPU / 8 GiB、5 个快照，没有写 480 分钟的每日或单次上限。480 这个数字来自早期文档 / CLI 提示，字面更像是“单次连续运行上限”而非“每天总额”，且不排除已经变更。**不要把它当成已证实的每日限额**，实际以你仪表盘的 Usage / 机器状态为准；如果连续跑 8 小时后被强制暂停，Worker 的 resume 仍可尝试把它唤醒，除非仪表盘报 `quota_exceeded`。
- 机器被删掉、额度用完、API Key 过期时，保活会失败并在日志里报错，不会悄悄假装成功。
- 长期不暂停的官方办法是付费档关掉闲置暂停。

## 附录：完整 Worker 代码（最终版）

把下面这段整个粘贴到 Worker 里即可，变量按第 5 节在仪表盘里配，不要写进代码。

```javascript
/**
 * Cloudflare Worker：给 InstaBox 主机保活
 * 每 10 分钟：resume 唤醒 + exec 机器内心跳（写 /tmp/instabox-keepalive.txt）
 * 两个 POST 都必须带 Idempotency-Key，且每次调用都要用新值，否则会被当成重复请求或报 409。
 * exec 的命令字段是 cmd（不是 command）。
 */

const API_BASE = "https://api.instabox.sh";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

// 每次 POST 都生成一个新的 Idempotency-Key，绝不复用。
function makeHeaders(apiKey) {
  return {
    "X-API-Key": apiKey,
    "Content-Type": "application/json",
    "Idempotency-Key": "keepalive-" + Date.now() + "-" + crypto.randomUUID(),
  };
}

// 在机器里跑心跳命令。exec 命令字段是 cmd，超时字段不确定时按顺序试两种。
async function execHeartbeat(base, apiKey) {
  const bodies = [
    {
      cmd: "date -u +%FT%TZ > /tmp/instabox-keepalive.txt && echo keepalive-ok",
      cwd: "/data/home",
      timeoutMs: 30000,
    },
    {
      cmd: "date -u +%FT%TZ > /tmp/instabox-keepalive.txt && echo keepalive-ok",
      cwd: "/data/home",
      timeout_ms: 30000,
    },
  ];
  let last = null;
  for (const body of bodies) {
    try {
      const res = await fetch(base + "/exec", {
        method: "POST",
        headers: makeHeaders(apiKey),
        body: JSON.stringify(body),
      });
      const data = await safeJson(res);
      if (res.status === 200 || res.status === 202) {
        return { ok: true, status: res.status, data };
      }
      last = { ok: false, status: res.status, data };
      if (res.status !== 400) break;
    } catch (e) {
      last = { ok: false, error: String(e) };
      break;
    }
  }
  return last || { ok: false, error: "exec request failed" };
}

async function keepalive(env) {
  const machineId = env.INSTABOX_MACHINE_ID;
  const apiKey = env.INSTABOX_API_KEY;
  if (!machineId || !apiKey) {
    return {
      ok: false,
      error: "missing INSTABOX_MACHINE_ID or INSTABOX_API_KEY (set them as Worker Secrets, never hardcode the key)",
    };
  }

  const base = API_BASE + "/v1/machines/" + encodeURIComponent(machineId);

  let resumeStatus = 0;
  let resumeData = null;
  try {
    const resumeRes = await fetch(base + "/resume", {
      method: "POST",
      headers: makeHeaders(apiKey),
      body: JSON.stringify({}),
    });
    resumeStatus = resumeRes.status;
    resumeData = await safeJson(resumeRes);
  } catch (e) {
    return { ok: false, machineId, step: "resume", error: String(e) };
  }

  let execResult = await execHeartbeat(base, apiKey);
  if (
    !execResult.ok &&
    execResult.data &&
    execResult.data.error &&
    execResult.data.error.code === "machine_not_running"
  ) {
    await sleep(5000);
    execResult = await execHeartbeat(base, apiKey);
  }

  const ok = execResult.ok || resumeStatus === 200 || resumeStatus === 202;
  console.log(
    "instabox-keepalive",
    JSON.stringify({ machineId, resumeStatus, execOk: execResult.ok, ok, at: new Date().toISOString() })
  );
  return { ok, machineId, resumeStatus, resumeData, exec: execResult, at: new Date().toISOString() };
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(keepalive(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/keepalive") {
      const result = await keepalive(env);
      return Response.json(result, { status: result.ok ? 200 : 502 });
    }
    if (url.pathname === "/status") {
      return Response.json({
        machineId: env.INSTABOX_MACHINE_ID || null,
        apiKeyConfigured: Boolean(env.INSTABOX_API_KEY),
        note: "GET /keepalive to run a keepalive check now",
      });
    }
    return new Response(
      "instabox-keepalive worker\nGET /keepalive - run keepalive now\nGET /status - check config (key is never shown)\n",
      { headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  },
};
```

## 踩坑记录（2026-10-24 实测）

1. 第一版缺 `Idempotency-Key`，resume 报 400：`Idempotency-Key header is required`。
2. 第一版 exec 用 `command`，报 400：`cmd is required`。
3. 两项都在最终版修掉，重新部署后 `/keepalive` 返回 `ok: true`。
4. 早期写进注释里的 cron 表达式曾因包含 `*/` 提前闭合块注释导致语法错误，已改成文字描述并用 Node 校验通过；README 附录代码里没有这个问题。
