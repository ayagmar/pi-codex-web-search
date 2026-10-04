# Changelog

## [0.2.0](https://github.com/ayagmar/pi-codex-web-search/compare/v0.1.9...v0.2.0) (2026-10-04)

### ⚠ BREAKING CHANGES

* requires pi 1.0.1 or newer and Node.js 22.19 or newer.

### Features

* require pi 1.0 ([11f50a7](https://github.com/ayagmar/pi-codex-web-search/commit/11f50a71826dea5d39262fc0e1525441663c8101))
* **web-search:** coalesce identical searches with a per-turn cache ([e6e0624](https://github.com/ayagmar/pi-codex-web-search/commit/e6e062424aac5726c918a5eb446d901cef41cda3))
* **web-search:** improve reliability and observability ([8a1a94a](https://github.com/ayagmar/pi-codex-web-search/commit/8a1a94ac19c985bff4f499526421034b0bd4d6e1))

### Bug Fixes

* **codex:** classify exit failures by Codex errors, not by search activity ([f4a835b](https://github.com/ayagmar/pi-codex-web-search/commit/f4a835bc27e711c803b4c2ba727cae63bd8262a6))
* **codex:** classify long stderr failures by their final error line ([d205fc9](https://github.com/ayagmar/pi-codex-web-search/commit/d205fc9f2031c6c855a336f723ce2b96b2dc60e4))
* **codex:** classify network drops as transport, not cancellation or auth ([aee3d78](https://github.com/ayagmar/pi-codex-web-search/commit/aee3d78250259c788e424d1a1b8aec92aadfb83c))
* **codex:** classify the startup inactivity timeout as a timeout ([36e8b37](https://github.com/ayagmar/pi-codex-web-search/commit/36e8b37ea9f190817997e32bf0eeac830ab82290))
* **codex:** handle EPIPE when Codex exits before reading the prompt ([91375f2](https://github.com/ayagmar/pi-codex-web-search/commit/91375f253a2f9a4c399df8d9af5e93db57784cab))
* **codex:** never classify exit failures on stdout research activity ([d949240](https://github.com/ayagmar/pi-codex-web-search/commit/d94924056d17096e0f1b03038e5a70492c2348e6))
* **codex:** never run a Codex binary from the workspace's node_modules ([0f3194e](https://github.com/ayagmar/pi-codex-web-search/commit/0f3194ebf4b80ec8b6ab7b6966e60b10c0396c58))
* **codex:** never spawn Codex or Defuddle for an already cancelled search ([b2be5e9](https://github.com/ayagmar/pi-codex-web-search/commit/b2be5e9fc3d43cdd1ba371ba05cdc2f0c8373385))
* **codex:** report a missing working directory instead of a missing Codex ([2b728ba](https://github.com/ayagmar/pi-codex-web-search/commit/2b728bae11fd6b737c3a27caa9047018b40167d3))
* **codex:** report the current elapsed time in heartbeat progress ([11783f8](https://github.com/ayagmar/pi-codex-web-search/commit/11783f80caec01ab459c3ac96c4d26b7d54784ea))
* **defuddle:** force-kill a Defuddle process that ignores SIGTERM ([41c8447](https://github.com/ayagmar/pi-codex-web-search/commit/41c84472f90733417eacf3bbfcbb3faf72299694))
* **defuddle:** run the Defuddle script under Pi's standalone Bun binary ([fc777f6](https://github.com/ayagmar/pi-codex-web-search/commit/fc777f64c0b0f52efba47fd4f9f9b57da6e28820))
* **render:** keep collapsed web_search previews on a single line ([0650855](https://github.com/ayagmar/pi-codex-web-search/commit/065085506ddc4acde57adc282548e7941bdcbb0e))
* **render:** keep the expand hint's closing parenthesis dim ([52dde7e](https://github.com/ayagmar/pi-codex-web-search/commit/52dde7e733ac422d4b748d375edc9f8bb18acfa2))
* **render:** show skipped concurrent searches as skipped, not failed ([6ffcb3b](https://github.com/ayagmar/pi-codex-web-search/commit/6ffcb3bf6b27da72ab6dfe78c9917ca47d6c167f))
* **settings:** never overwrite a settings file that has invalid JSON ([ca633d6](https://github.com/ayagmar/pi-codex-web-search/commit/ca633d65fd2f8808ea6e66a8fa688c61af39fe99))
* **settings:** report command output on stderr when there is no UI ([8744d27](https://github.com/ayagmar/pi-codex-web-search/commit/8744d277b25b84c6d06dceca9636b88a799c70fc))
* **settings:** save through a dangling symlink onto its target ([73b9002](https://github.com/ayagmar/pi-codex-web-search/commit/73b900255028292abd02f69a479f801a741cc75a))
* **settings:** save through a symlinked settings file and keep its mode ([20c5630](https://github.com/ayagmar/pi-codex-web-search/commit/20c56303c2c46fa85c1dfdf5cd31b4fa56aeab87))
* **settings:** store settings in the Pi agent directory ([c3ca9d2](https://github.com/ayagmar/pi-codex-web-search/commit/c3ca9d2aa4803ccf71ce34c8473a47bd98436cb7))
* **web-search:** budget per search call and fail fast on stalls ([a1fdbce](https://github.com/ayagmar/pi-codex-web-search/commit/a1fdbced5da967fada2d3e65fdb2e7e16b4438c1))
* **web-search:** cancel in-flight searches on session_shutdown ([55ddce7](https://github.com/ayagmar/pi-codex-web-search/commit/55ddce72086fb923638e05bf8b36e10a6f363526))
* **web-search:** flag recoverable search failures as tool errors ([11583ac](https://github.com/ayagmar/pi-codex-web-search/commit/11583ac08216ece77ed5c560b709c910f5eb5552))
* **web-search:** keep abort signal, progress and cwd per tool call ([562ea3f](https://github.com/ayagmar/pi-codex-web-search/commit/562ea3fc749dc9ed1ab4425b27bd5edfd8f1cd95))
* **web-search:** list web_search in pi 1.0's system prompt ([a29e11a](https://github.com/ayagmar/pi-codex-web-search/commit/a29e11a1438a2ca902cfcff20591c7cbcc025fbc))
