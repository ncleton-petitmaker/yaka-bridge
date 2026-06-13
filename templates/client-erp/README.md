# {{CLIENT_NAME}} ERP

Private Yaka ERP client project.

This repository consumes the shared Yaka platform through `@ncleton-petitmaker/yaka-*` packages.
Do not copy platform core folders such as `bridge/`, `bridge-voice/` or
`electron-builder.bridge.cjs` into this repository.

Required checks:

```bash
npm run yaka:doctor
npm run typecheck
npm test
npm run build
```
