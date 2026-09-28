import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyTurnFailure,
  isModelOutputUpdate,
  retryTurn
} from "../plugins/gemini/scripts/lib/gemini.mjs";

function failure(message, extra = {}) {
  return Object.assign(new Error(message), extra);
}

// 本地采集到的真实故障文本。这三条正是让一次 Review 停在 starting 阶段几十分钟的原因。
const REAL_PERMISSION_DENIED = `[{
  "error": {
    "code": 403,
    "message": "Permission 'cloudaicompanion.companions.generateChat' denied on resource '//cloudaicompanion.googleapis.com/projects/codeassist-prod/locations/global'",
    "status": "PERMISSION_DENIED"
  }
}]`;
const REAL_NETWORK_FAILURE =
  "request to https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse failed, reason: ";
const REAL_TURN_TIMEOUT = "Gemini turn exceeded 1800000ms timeout. Override with GEMINI_TASK_TIMEOUT_MS.";

test("a silent start is retried", () => {
  assert.equal(
    classifyTurnFailure(failure("Gemini accepted the prompt but sent nothing back for 300s.", { retryable: true })),
    "retry"
  );
});

test("an upstream network failure is retried", () => {
  assert.equal(classifyTurnFailure(failure(REAL_NETWORK_FAILURE)), "retry");
});

test("a permission denial is never retried", () => {
  // 权限被拒重试多少次都还是被拒，重试只会把一次立刻可见的失败拖成三倍时长。
  assert.equal(classifyTurnFailure(failure(REAL_PERMISSION_DENIED)), "permanent");
});

test("a permission denial found only in the stderr is still recognized", () => {
  // 403 有时候只出现在 Gemini 的 stderr 里，错误消息本身是一句泛泛的超时。
  const error = failure("Gemini did not open a session in time (120s)", {
    retryable: true,
    geminiStderr: REAL_PERMISSION_DENIED
  });
  assert.equal(classifyTurnFailure(error), "permanent");
});

test("a turn that ran its full timeout is not retried", () => {
  // 整轮超时说明这一轮做得太久，重跑一遍只会再等一次同样长的时间。
  assert.equal(classifyTurnFailure(failure(REAL_TURN_TIMEOUT)), "permanent");
});

// 本测试守住自动重试唯一的安全前提。Gemini 一旦流出过数据块，这一轮就可能已经调用过
// 工具、改过文件，重跑等于把副作用做第二遍。
test("a failure that already streamed output is never retried", () => {
  const error = failure(REAL_NETWORK_FAILURE, { streamed: true, retryable: true });
  assert.equal(classifyTurnFailure(error), "permanent");
});

test("an unrecognized failure is not retried", () => {
  assert.equal(classifyTurnFailure(failure("state.foo is not a function")), "permanent");
});

// 本测试守的是一个真的漏出去过的 Bug：等第一个数据块的期限原本被 available_commands_update
// 立刻清掉，于是整套机制在真实运行里一次都没生效。实测这条更新在会话建立后几毫秒就到达，
// 而它跟模型有没有响应毫无关系。
test("a session handshake update does not count as the model responding", () => {
  assert.equal(isModelOutputUpdate("available_commands_update"), false);
  assert.equal(isModelOutputUpdate("user_message_chunk"), false);
});

test("real model output counts as the model responding", () => {
  for (const kind of ["agent_thought_chunk", "agent_message_chunk", "tool_call", "tool_call_update", "plan"]) {
    assert.equal(isModelOutputUpdate(kind), true, kind);
  }
});

test("the retry loop stops at the attempt limit", async () => {
  let calls = 0;
  await assert.rejects(
    retryTurn(
      () => {
        calls += 1;
        return Promise.reject(failure(REAL_NETWORK_FAILURE));
      },
      { attempts: 3, backoffMs: 0 }
    ),
    /streamGenerateContent/
  );
  assert.equal(calls, 3);
});

test("the retry loop returns the first success", async () => {
  let calls = 0;
  const result = await retryTurn(
    () => {
      calls += 1;
      return calls < 3 ? Promise.reject(failure(REAL_NETWORK_FAILURE)) : Promise.resolve("done");
    },
    { attempts: 5, backoffMs: 0 }
  );
  assert.equal(result, "done");
  assert.equal(calls, 3);
});

test("the retry loop gives up immediately on a permanent failure", async () => {
  let calls = 0;
  await assert.rejects(
    retryTurn(
      () => {
        calls += 1;
        return Promise.reject(failure(REAL_PERMISSION_DENIED));
      },
      { attempts: 3, backoffMs: 0 }
    ),
    /PERMISSION_DENIED/
  );
  assert.equal(calls, 1);
});

test("each retry is announced on the job log", async () => {
  const messages = [];
  await assert.rejects(
    retryTurn(() => Promise.reject(failure(REAL_NETWORK_FAILURE)), {
      attempts: 2,
      backoffMs: 0,
      onProgress: (event) => messages.push(typeof event === "string" ? event : event.message)
    })
  );
  assert.equal(messages.length, 1);
  assert.match(messages[0], /Attempt 1 of 2/);
});
