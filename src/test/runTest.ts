// @vscode/test-electron 으로 지정한 VS Code 버전을 내려받아 확장을 띄우고
// 통합 테스트를 실행한다. 기본 1.96.0(=Node 20 확장 호스트) — TLS 보장 검증용.
import * as path from "path";
import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, "../../");
    const extensionTestsPath = path.resolve(__dirname, "./suite/index");
    const version = process.env.VSCODE_TEST_VERSION || "1.96.0";

    // 알려진 @vscode/test-electron(Windows) 제약: 경로에 공백/일부 비ASCII가 있으면
    // Code.exe 로 넘기는 --extensionTestsPath 인자가 공백에서 잘려 테스트가 실패한다.
    // 그런 경로면 공백 없는 ASCII 경로(예: C:\dev\ext)로 복사해 실행하라고 안내한다.
    if (process.platform === "win32" && /\s/.test(extensionDevelopmentPath)) {
      console.warn(
        "[warn] 확장 경로에 공백이 있습니다: " +
          extensionDevelopmentPath +
          "\n[warn] Windows의 @vscode/test-electron 제약으로 테스트가 실패할 수 있습니다." +
          "\n[warn] 공백/한글이 없는 경로(예: C:\\dev\\codex-usage-monitor)로 복사한 뒤 npm test 를 실행하세요.",
      );
    }

    await runTests({ version, extensionDevelopmentPath, extensionTestsPath });
  } catch (err) {
    console.error("Failed to run integration tests:", err);
    process.exit(1);
  }
}

void main();
