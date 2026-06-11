// 스크린샷 하니스용 vscode 모듈 스텁 (out/*.js 를 플레인 Node 에서 로드하기 위함).
class EventEmitter {
  constructor() {
    this.event = () => ({ dispose() {} });
  }
  fire() {}
  dispose() {}
}
module.exports = {
  EventEmitter,
  Disposable: class {},
  workspace: {
    getConfiguration: () => ({ get: (_key, def) => def, update: async () => {} }),
  },
  window: {
    createOutputChannel: () => ({ appendLine() {} }),
    showWarningMessage: () => Promise.resolve(undefined),
    showInformationMessage: () => Promise.resolve(undefined),
  },
  env: { language: "ko" },
};
