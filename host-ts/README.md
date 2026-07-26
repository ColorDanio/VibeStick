# VibeStick TypeScript Host Core

This is the new cross-platform host domain core, developed alongside—not in
place of—the supported Python traditional daemon.  It has no real BLE,
keyboard, microphone, or lifecycle side effects yet.  Those are capability
adapters added only after this core conforms to `../contracts/v1`.

```bash
npm install
npm test
```

The test suite reads the same versioned JSON fixtures as Python.  Do not copy
or alter product semantics in platform UI code: add them here and prove them
through a contract fixture first.
