#!/bin/bash
# Duplicate tabs from your biggest Chrome window into a NEW window, so you can
# test Pile (which discards/activates/closes tabs) without disturbing your real
# session. The clone's tabs load in the background; Pile discards the cold ones.
#
# Usage: dup-window.sh [N]   # duplicate only the last N tabs (default: all)
set -euo pipefail
COUNT="${1:-0}"

osascript - "$COUNT" <<'APPLESCRIPT'
on run argv
  set wantN to (item 1 of argv) as integer
  tell application "Google Chrome"
    -- Pick the window with the most tabs (the "pile"), not just whatever is front.
    set srcWin to missing value
    set maxCount to -1
    repeat with w in windows
      set c to count of tabs of w
      if c > maxCount then
        set maxCount to c
        set srcWin to w
      end if
    end repeat
    if srcWin is missing value then return "no windows"

    set total to count of tabs of srcWin
    if wantN is 0 or wantN > total then set wantN to total
    set startIdx to total - wantN + 1 -- take the newest (rightmost) tabs

    set urlList to {}
    repeat with i from startIdx to total
      set end of urlList to URL of tab i of srcWin
    end repeat
    if (count of urlList) is 0 then return "no tabs"

    set newWin to make new window
    set URL of active tab of newWin to item 1 of urlList
    repeat with i from 2 to count of urlList
      tell newWin to make new tab with properties {URL:item i of urlList}
    end repeat
    return "duplicated " & (count of urlList) & " of " & total & " tabs into a new window"
  end tell
end run
APPLESCRIPT
