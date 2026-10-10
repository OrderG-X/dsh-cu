# macOS: a locked session makes every AX window invisible

**Symptom you will see**

```
$ cua-driver call get_window_state '{"pid": 1620, "window_id": 13088}'
{
  "degraded": true,
  "degraded_reason": "ax_window_unresolved: window_id 13088 exists and is owned by pid 1620,
                      but none of the 0 AXWindow element(s) under that pid reports this CGWindowID. ..."
}
```

…for **every** app, while `list_windows` happily reports all of them with correct bounds.

Screenshots are wrong in the same way: `screencapture -x` returns only the desktop wallpaper, and
`screencapture -R <window rect>` fails with `could not create image from rect`.

**Cause: the session is locked.**

```python
import Quartz
Quartz.CGSessionCopyCurrentDictionary()
# -> {'CGSSessionScreenIsLocked': True, 'kCGSSessionOnConsoleKey': True, ...}
```

While the screen is locked, macOS does not expose other apps' AX windows and does not composite
their surfaces. Everything downstream looks like a driver bug.

## Evidence that it is the session, not the driver

1. **An independent probe reproduces it without cua involved.** A 20-line Swift program run from
   the same host reports `AXIsProcessTrusted() == true`, but
   `AXUIElementCopyAttributeValue(app, kAXWindowsAttribute, &ref)` returns an array whose single
   element has role **`AXApplication`** — never `AXWindow`. Same for Chrome, Finder, WeChat,
   ChatGPT. So the "0 AXWindow element(s)" line is literally true, and it is the OS answering.

2. **Permissions look fine throughout.** `permissions status --json` reports
   `accessibility: true`, `screen_recording: true`. Restarting the daemon does not help.
   Neither does re-granting.

3. **AppleScript can still read UI while locked**, which makes this extra confusing if you test
   with `osascript`: System Events is an Apple-signed system process and reaches the accessibility
   tree by a different path. So "AX works" can be simultaneously true and false depending on which
   process you ask.

4. **It clears the instant the screen is unlocked** — nothing else changed:

```
# while locked
get_window_state -> elements: 0    degraded: True

# after unlocking (same daemon, same window id, no restart)
get_window_state -> elements: 154  degraded: None
  0 AXWindow '计算器'
  1 AXButton '删除'
  5 AXButton '7'
```

## Two suggestions

1. **Surface it in `degraded_reason`.** When the AX walk finds zero AXWindows, check the session
   lock state and say so — e.g. `degraded_reason: "session_locked"`. One word would have saved me
   an evening of chasing permissions and daemon attribution.

2. **Do the same for capture.** A screenshot that yields only wallpaper is currently
   indistinguishable from a legitimately empty desktop.

Both are cheap, and they turn a "the driver is broken" experience into "unlock your screen".

## Caveat

This is not necessarily the explanation for every report of `ax_window_unresolved` — it can also
persist while unlocked (see trycua/cua#4039). But it is a two-second check, and it reproduces the
exact error string on demand, which makes it worth ruling out first.
