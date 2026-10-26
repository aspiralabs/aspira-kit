---
'@aspiralabs/ai': patch
---

A `Telemetry not written: the telemetry file could not be written` notice now names the error that stopped the write (for example `EACCES` or `EEXIST`), whatever the cause, instead of only a folder it cannot write.
