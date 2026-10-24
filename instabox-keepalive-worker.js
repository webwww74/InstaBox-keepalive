/**
 * Cloudflare Worker：给 InstaBox 主机保活
 * ============================================================
 * 原理（用的是 InstaBox 官方 API，不是旁门左道）：
 *   InstaBox 官方文档说：闲置 30 分钟后机器会自动暂停。
 *   所以 Worker 每 10 分钟做两件事：
 *     1. POST /v1/machines/{id}/resume —— 机器如果已被暂停，把它唤醒；
 *        如果已经在运行，返回 200/202/409 都算正常，不算失败。
 *     2. POST /v1/machines/{id}/exec —— 在机器里跑一条极轻的心跳命令
 *        （写一个 /tmp/instabox-keepalive.txt），让机器里产生一次活动，
 *        而不只是 API 层面碰一下。
 *
 * 触发方式（两种都支持，任选其一即可）：
 *   - Cron Trigger：wrangler.toml 里配每 10 分钟一次的 cron（见 wrangler.toml）
 *   - 手动 / 外部定时器：GET https://你的-worker.workers.dev/keepalive
 *     （如果你的 Workers 套餐没有 Cron Trigger，就用外部定时器每 10 分钟
 *      请求这个地址，效果一样）
 *
 * 需要配置的变量（千万不要把 API Key 写进代码里）：
 *   - INSTABOX_MACHINE_ID：机器 ID，形如 m_...，在 InstaBox 仪表盘 / CLI 里看
 *   - INSTABOX_API_KEY：API Key，形如 ibk_...，在仪表盘 Profile → API keys 里建
 *     在 Cloudflare 里设为 Secret（wrangler secret put / 仪表盘 Settings → Variables → Encrypt）
 *
 * 官方 API 依据：
 *   - Base URL：https://api.instabox.sh
 *   - 认证：X-API-Key 请求头（或 Authorization: Bearer）
 *   - resume：POST /v1/machines/{id}/resume
 *   - exec：POST /v1/machines/{id}/exec，请求体字段是 cmd（不是 command）
 *   - 两个 POST 都必须带 Idempotency-Key 请求头（1-200 个可打印字符）；
 *     每次调用都要用新值，否则第二次会被当成重复请求或报 409 冲突。
 *     下面代码每次调用都用 crypto.randomUUID() 生成一个新 Key。
 *   - 完整字段定义：https://api.instabox.sh/v1/openapi.json
 *     （exec 的超时字段在不同版本里可能是 timeoutMs / timeout_ms，
 *      下面代码会按顺序试两种，400 就换下一种，不会因为字段名卡死）
 *   - 2026-10-24 实测纠错：第一版缺 Idempotency-Key 报 400，
 *     exec 用 command 报 cmd is required，两项都在这一版修掉。
 *
 * 限制，先说清楚：
 *   - 保活只能防“闲置 30 分钟自动暂停”。关于“免费版最长 480 分钟”：
 *     2026-10-24 再查官方定价页时，免费档只列了 1 台机器、4 vCPU/8 GiB、
 *     5 个快照，没有写 480 分钟的每日或单次上限；480 这个数字来自早期
 *     文档/CLI 提示，字面更像是“单次连续运行上限”而非“每天总额”，
 *     且不排除已经变更。不要把它当成已证实的每日限额，实际以你仪表盘
 *     的 Usage / 机器状态为准；如果连续跑 8 小时后被强制暂停，Worker 的
 *     resume 仍可尝试把它唤醒，除非仪表盘报 quota_exceeded。
 *   - 机器被删掉、额度用完、API Key 过期时，保活会失败并在日志里报错，
 *     不会悄悄假装成功。
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
      // 200/202 = 接受/成功；409 = 机器正忙，稍后重试的意义不大，记为一次尝试
      if (res.status === 200 || res.status === 202) {
        return { ok: true, status: res.status, data };
      }
      last = { ok: false, status: res.status, data };
      // 只有 400（字段不对）才值得换下一种 body 试；其它错误直接返回
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

  // 1. 唤醒（已暂停时唤醒，已运行时 200/202/409 都算正常）
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

  // 2. 机器内活动心跳。如果刚唤醒、机器还没起来，exec 会报 machine_not_running，
  //    等 5 秒再试一次（重试用新的 Idempotency-Key）。
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

  const ok =
    execResult.ok || resumeStatus === 200 || resumeStatus === 202;
  console.log(
    "instabox-keepalive",
    JSON.stringify({ machineId, resumeStatus, execOk: execResult.ok, ok, at: new Date().toISOString() })
  );
  return { ok, machineId, resumeStatus, resumeData, exec: execResult, at: new Date().toISOString() };
}

export default {
  // Cron Trigger 入口
  async scheduled(event, env, ctx) {
    ctx.waitUntil(keepalive(env));
  },

  // 手动 / 外部定时器入口
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/keepalive") {
      const result = await keepalive(env);
      return Response.json(result, { status: result.ok ? 200 : 502 });
    }
    if (url.pathname === "/status") {
      // 只回显配置是否齐全，不回显 Key 本身
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
