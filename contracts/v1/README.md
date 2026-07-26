# VibeStick Host Interoperability Contracts v1

These fixtures are the compatibility boundary between the maintained Python
traditional daemon and the future TypeScript host.  Each JSON document has
`version: 1`, a stable `kind`, an `input`, and an `expected` result.  Values
are UTF-8 JSON and all object comparisons are semantic (key order is not part
of the contract).

`v1` additions are backward-compatible only: a reader must ignore fields it
does not understand, and a writer must retain every required v1 field.  A
change to routing semantics, a required field, HID mapping, or serialization
defaults requires a new directory such as `contracts/v2/`.

The fixtures intentionally contain no host paths, credentials, BLE address,
or wall-clock time.  Hardware transport and OS driver installation remain
platform adapters; the protocol data and product behaviour here remain shared.

| Fixture | Covers |
| --- | --- |
| `config-normalization.json` | Config recovery/defaulting and canonical output |
| `status-payload.json` | STATUS serialization used by device/dashboard |
| `sessions-payload.json` | SESSIONS serialization and selected index |
| `voice-routing.json` | Agent CLI ASR versus Vibe Mic route transitions |
| `hid-reports.json` | Vibe Mic F15/F14 keyboard reports and optional report ID |
