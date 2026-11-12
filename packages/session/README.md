# @lotsman/session

What a lotsman session *is*: the record, the transcript and the resume binding, plus a JSON file store.
No ACP client, no agent adapter, no `gi://`. The store takes a path and never decides one, so a test
writes to a temp directory and an app writes to XDG.

Licence: **LGPL-3.0-or-later** (`LICENSE`, `COPYING` in this directory).

```bash
npm i @lotsman/session @lotsman/acp
```

The package ships TypeScript sources; consume it with a bundler that compiles `.ts`. Part of
[lotsman](https://github.com/JumpLink/lotsman).
