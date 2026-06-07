import * as assert from "assert";
import { fetchPlanUsage } from "../../claudeApi";

// 실제 VS Code 확장 호스트(기본 1.96 = Node 20) 안에서 Claude usage 엔드포인트를
// 호출해, 이 환경(사내 백신/프록시 포함)에서 TLS 인증서 검증이 통과하는지 측정한다.
suite("TLS / Claude usage endpoint (extension host)", () => {
  test("usage call passes TLS verification (no cert error)", async () => {
    const res = await fetchPlanUsage({ log: (m) => console.log("[claude]", m) });
    console.log(
      "fetchPlanUsage =>",
      JSON.stringify({ hasUsage: Boolean(res.usage), rateLimited: Boolean(res.rateLimited), error: res.error }),
    );

    // 자격증명이 없으면 환경 문제이므로 TLS 단정은 건너뛴다.
    if (res.error && res.error.includes("자격증명")) {
      console.warn("Claude 자격증명 없음 — TLS 단정 건너뜀");
      return;
    }

    // 핵심: 인증서 검증 실패가 아니어야 한다.
    assert.ok(
      !(res.error && res.error.includes("인증서")),
      "확장 호스트에서 TLS 인증서 검증 실패: " + res.error,
    );
    // 200(usage) 또는 429(rateLimited)면 TLS 채널 자체는 성공한 것.
    assert.ok(
      Boolean(res.usage) || Boolean(res.rateLimited),
      "usage 또는 rate-limit가 와야 함(=TLS 통과). 실제: " + res.error,
    );
  });
});
