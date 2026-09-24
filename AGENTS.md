# Agent notes

- Before starting, read the latest `docs/context/*-handoff.md` and `docs/context/*-learnings.md`.
- Before finishing work that changed this repository, update `docs/context/` as described in `docs/context/README.md`, commit only that directory, and push. In oh-my-pi, `.omp/extensions/context-sync.ts` requests this automatically; other harnesses must do it by hand.
- The library itself lives in https://github.com/har1101/strands-lambda-durable-functions. This repository is the example app.
- minamo, the dependency-free core for durable agent loops, lives in https://github.com/har1101/minamo. Its handoff notes are kept here in `docs/context/`.
