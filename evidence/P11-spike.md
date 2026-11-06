# P11-spike — S3: which attention layers fire here, and can `gio launch` raise a running Chrome?

Date: 2026-11-06
Owner: orchestrator
Verdict: **PASS** — all three S3 questions are answered with measurements. (a) L0/L1/L2 are all available on
this host; (b) **`gio launch …/google-chrome.desktop` opens and focuses a second window instead of
activating the running one**, so the plan's draft rung is rejected with data and the ladder keeps it out;
(c) the macOS/Windows equivalents are recorded on paper, with the one that would launch a stopped browser
explicitly rejected.

Plan: `PLAN-v2.md` §3 (S3) and §4 P11 (L2). Written after the lanes landed: P11-A/B/C were integrated from
the P9/P10 sessions' measurements, and this file closes the one spike the phase was still missing.

## Method

One throwaway script (`/tmp/p11-spike.ts`, not committed — probes are evidence, not code):

1. read `~/.config/google-chrome/DevToolsActivePort` (the authoritative file) and open **one** CDP socket;
2. snapshot `Target.getTargets` + `Browser.getWindowForTarget` per page + `hyprctl activewindow -j`;
3. run exactly one `gio launch /usr/share/applications/google-chrome.desktop`, wait 3 s;
4. snapshot again, then close **only** the blank tab the call created and re-snapshot to prove no residue.

Nothing is written to the profile, no browser is launched, killed or restarted, and no user tab is touched.

```bash
node /tmp/p11-spike.ts
gdbus call --session --dest org.freedesktop.Notifications --object-path /org/freedesktop/Notifications \
  --method org.freedesktop.Notifications.GetCapabilities
hyprctl clients -j    # chrome window count, before and after cleanup
```

## (a) Which attention layers exist on this host

| Layer | Present | Measured |
|---|---|---|
| L0 terminal | **yes** — kitty (`pi → fish → kitty`, `TERM=xterm-256color`) | kitty implements both OSC 9 and OSC 777; the escapes are emitted only on a TTY stdout (`V11.5`) |
| L1 desktop notification | **yes** — `org.freedesktop.Notifications` owned by `quickshell` 1.2 (`GetServerInformation` → `('quickshell', 'quickshell', '', '1.2')`) | `GetCapabilities` → `persistence, body, body-markup, body-hyperlinks, body-images, actions, icon-static`; `persistence` is why the adapter asks for `urgency=critical` + `-t 0` (popup stays until dismissed) |
| L2 raise | **one adapter** — `hyprctl` 0.57.0 | `hyprctl eval 'hl.dsp.focus({window="class:google-chrome"})'` → `ok`; the legacy `dispatch focuswindow` form fails on 0.57 (recorded in `evidence/P11.md` V11.4) |
| L2 helpers absent | — | `wmctrl`, `xdotool`, `kdotool`, `swaymsg` are not installed; `ydotool` exists with its daemon active but has no window-identity semantics (it types/clicks), so it is not an adapter |
| L3 | always | the `cdp.attachWaitMs` wait is independent of every layer above |

Notification ladder binaries present: `notify-send`, `gdbus`, `dbus-send` (all three → `notify-send` wins).

## (b) `gio launch` — measured, rejected

Raw output of the one run (trimmed to the fields that decide the question; the user's page titles are
intentionally not reproduced):

```json
{
  "product": "Chrome/157.0.8103.38",
  "gioError": null,
  "before": { "active": { "class": "google-chrome" }, "windowCount": 1, "pages": 6 },
  "after":  { "active": { "class": "google-chrome" }, "windowCount": 2, "pages": 7 },
  "createdPages": [{ "url": "chrome://newtab/", "title": "Новая вкладка" }],
  "newWindows": [{ "id": 347207610, "bounds": { "width": 845, "height": 1028, "windowState": "maximized" } }],
  "closed": ["B3004FCAE1950AA7AA14BD7BEBC2AD91"],
  "cleaned": { "active": { "class": "google-chrome" }, "windowCount": 1, "pages": 6 }
}
```

1. **A second window, not an activation.** `google-chrome.desktop` has `Exec=/usr/bin/google-chrome-stable %U`
   and the call passes no URI, so Chrome treats it as a *New Window* request: the existing process is reused
   (no second browser process, no profile lock) but a new window is created, maximized and focused. The
   active window address changed to the new window, and the window count went 1 → 2.
2. **So it cannot be a raise rung.** Attention means "look at the window that is already waiting for Allow";
   `gio launch` manufactures a second window and moves focus to it, which is exactly the side effect the
   module refuses. The comment in `src/cdp/raise.ts` ("`gio launch` is deliberately absent") now has a
   measurement behind it instead of an assumption.
3. **Cleanup is exact.** The created blank tab was closed through `Target.closeTarget`, the window
   disappeared with its last tab, and the post-cleanup snapshot is byte-equal in shape to the pre-launch one
   (1 window, 6 pages, the same page set, focus back on the original window). `hyprctl clients -j` reports
   one `google-chrome` window afterwards.
4. **Passing a URL would not help either**: it would open a tab in the existing window — still a new document
   in the user's session, still a side effect, and still not the Allow prompt.

## (c) macOS and Windows — on paper only (no such host here)

| Concern | macOS | Windows |
|---|---|---|
| raise (used) | `osascript -e 'tell application "Google Chrome" to activate'` — raises the **running** app; AppleScript asks the user instead of launching a stopped one, which is the behaviour we want | `powershell -NoProfile -Command [Microsoft.VisualBasic.Interaction]::AppActivate('Google Chrome')` — raises the window whose title starts with that string; throws when no such window exists (caught → `raise: unavailable`) |
| raise (rejected) | `open -a "Google Chrome"` — activates when running, but **launches** when stopped: the same defect as `gio launch`, so it is not an adapter | `Start-Process chrome` — launches; rejected for the same reason |
| notification | `osascript -e 'display notification "…" with title "…"'` → Notification Center. No urgency/persistence control, so a banner can be missed | PowerShell + WinRT toast (`Windows.UI.Notifications`). Best effort, no persistence control |
| backstop | L0 (iTerm2/WezTerm/Ghostty OSC) + L3 (60 s wait, `--watch` 5 min) | L0 (Windows Terminal OSC 9) + L3 |

Both OSes reach their binaries through `capability()` (`osascript`, `powershell` are declared names), and the
three-platform unit matrix in `tests/unit/raise.test.ts` runs those branches under a stubbed platform.

## Degradation matrix (OS × desktop × with/without helpers)

| OS / desktop | Helpers | L0 terminal | L1 notification | L2 raise | Verdict |
|---|---|---|---|---|---|
| Linux / X11 (any DE) | `wmctrl` or `xdotool` | yes | yes | `wmctrl -a` / `xdotool … windowactivate` | full |
| Linux / X11 | none | yes | yes (D-Bus) | `raise: unavailable` | feature carries (L0+L1+L3) |
| Linux / Wayland / Hyprland | `hyprctl` (**this host**) | yes (kitty) | yes (quickshell, `persistence`) | `hyprctl eval 'hl.dsp.focus(…)'` — **measured ok** | full |
| Linux / Wayland / Hyprland | none | yes | yes | `raise: unavailable` | feature carries |
| Linux / Wayland / sway | `swaymsg` | yes | yes | `swaymsg '[app_id="…"] focus'` | full |
| Linux / Wayland / KWin | `kdotool` | yes | yes | `kdotool search … windowactivate` | full |
| Linux / Wayland / GNOME | none (no portable API) | yes | yes | `raise: unavailable` | feature carries |
| any Linux | `gio` only | yes | yes | **rejected (opens a second window, measured)** | feature carries |
| macOS | built-in | yes (iTerm2/WezTerm/Ghostty/kitty) | `osascript` banner | `osascript … activate` (paper) | full on paper |
| Windows | built-in | yes (Windows Terminal) | PowerShell toast (paper) | `AppActivate` (paper) | full on paper |
| headless / CI / no session bus | none | TTY-gated, absent | `{delivered:false}`, non-fatal | `unavailable` | wait + honest error (L3) |

## Decision

- The raise ladder in `src/cdp/raise.ts` is final: `wmctrl` → `xdotool` → `kdotool` → `hyprctl eval` →
  `hyprctl dispatch` → `swaymsg` on Linux, `osascript` on macOS, `AppActivate` on Windows. `gio launch` and
  `open -a` are **not** adapters; both are recorded here with the reason.
- No code change was needed for this spike; it closes the last open question of P11 and turns two comments
  into measurements.
- `research/FINDINGS.md` §14 item 6 carries the same result in one line.
