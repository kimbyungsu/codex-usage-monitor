/*
 * 마켓플레이스용 설치 파일(vsix) 생성기.
 *  - 일반 설치 파일(npm run package → codex-usage-monitor-<버전>.vsix)은 publisher "local" 그대로 둔다:
 *    이미 그 파일로 설치한 PC는 같은 확장 ID(local.codex-usage-monitor)라 덮어쓰기 업그레이드가 된다.
 *  - 마켓 게시는 등록된 퍼블리셔 ID가 필요하므로, 패키징하는 동안만 package.json 의 publisher 를
 *    MARKET_PUBLISHER 로 바꾸고 끝나면(실패해도) 원래 내용을 그대로 되돌린다.
 *  - 마켓 소개는 영문 README(docs/README.en.md)를 쓴다(codex-bridge 와 같은 방식).
 * 산출물: codex-usage-monitor-<버전>-marketplace.vsix  → 마켓 관리 페이지에 업로드(또는 vsce publish --packagePath).
 * 주의: 같은 PC에 일반 설치본과 마켓 설치본을 함께 깔면 확장 ID가 달라 상태바 항목이 두 벌 생긴다.
 * 사용: npm run package:market   (퍼블리셔 변경: MARKET_PUBLISHER=<id> npm run package:market)
 */
const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PKG = path.join(ROOT, "package.json");
const MARKET_PUBLISHER = process.env.MARKET_PUBLISHER || "kimbyungsu";

const original = fs.readFileSync(PKG, "utf8");
const pkg = JSON.parse(original);
const out = `${pkg.name}-${pkg.version}-marketplace.vsix`;
const eol = original.includes("\r\n") ? "\r\n" : "\n";
// 영문 README 가 설치 파일 안에서 readme.md 가 되므로, 루트 README.md(한국어)는 빼야 한다
// (VSIX 는 대소문자만 다른 두 경로를 허용하지 않음). 기본 제외 목록 + README.md 를 임시 파일로.
const ignoreFile = path.join(os.tmpdir(), `codex-usage-monitor-market-${process.pid}.vscodeignore`);
fs.writeFileSync(ignoreFile, fs.readFileSync(path.join(ROOT, ".vscodeignore"), "utf8") + "\nREADME.md\n", "utf8");

try {
  fs.writeFileSync(PKG, JSON.stringify({ ...pkg, publisher: MARKET_PUBLISHER }, null, 2).replace(/\n/g, eol) + eol, "utf8");
  execSync(`npx vsce package --readme-path docs/README.en.md --ignoreFile "${ignoreFile}" --out "${out}"`, {
    cwd: ROOT,
    stdio: "inherit",
  });
  console.log(`\nmarketplace vsix: ${path.join(ROOT, out)} (publisher ${MARKET_PUBLISHER})`);
} finally {
  fs.writeFileSync(PKG, original, "utf8");
  fs.rmSync(ignoreFile, { force: true });
}
