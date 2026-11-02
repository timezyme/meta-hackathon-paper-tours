---
name: browser-verify
description: Choose a working browser driver and verify AmuseMe flows in the real app or visual fixture. Use when a change needs browser evidence, when Chrome automation is disconnected or keypresses do not land, or before delegating browser checks to a worker.
---

# Verify AmuseMe in a browser

Use the cmux browser first for browser testing. Playwright is only for end-to-end tests, and AmuseMe has none, so don't use it to verify flows. Never launch Chrome from the shell.

## Pick the driver

1. The cmux built-in browser. It is WebKit (the Safari engine), not Chrome. Every result recorded with it must say "cmux WebKit".
2. Chrome through CUA or Chrome DevTools, for Chrome-only behavior or when cmux can't show the flow, and only when one attaches to a usable window. The Chrome extension may be disconnected, CUA keypresses may not land in automation-controlled Chrome, and Chrome started with `--remote-debugging-pipe` has no attachable port. Test one action and read back the result before trusting a driver.
3. If neither works, stop browser testing and report the blocker. Chrome-only behavior, such as native downloads, still needs [native download verification](../chrome-native-download-verification/SKILL.md).

## Drive cmux

```sh
cmux browser open http://127.0.0.1:4184/        # live app; fixture: http://127.0.0.1:4187/qa; prints surface=<ref>
S=<ref>
cmux browser $S wait --selector 'input[type=email]' --timeout 15
set -a; . qa/goal-first-20261101/native-test-account.env; set +a
cmux browser $S fill 'input[type=email]' --text "$AMUSEME_INVITE_EMAIL"
cmux browser $S fill 'input[type=password]' --text "$AMUSEME_INVITE_PASSWORD"
cmux browser $S press Enter
cmux browser $S viewport 390 844                 # also check desktop width
cmux browser $S screenshot --out qa/<run>/<name>.png
cmux browser $S errors list; cmux browser $S console list
```

Use `goto <url>`, `click <css>`, `eval "<js>"` and `reload` for navigation and read-back. Never echo or log the credential values. Check selectors against the current page with `snapshot -i`; do not assume them.

## Record and clean up

- Record the serving URL, build identity, driver and engine, viewport, steps and observed result. Keep screenshots under ignored `qa/`.
- Report console errors and page errors, even when unrelated.
- Close every surface you opened with `cmux close-surface --surface $S`. Close Chrome tabs you opened. Do not touch tabs or surfaces you did not open. Report anything left open.
