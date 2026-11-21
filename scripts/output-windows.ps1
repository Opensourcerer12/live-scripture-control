# Lists FreeShow's top-level windows so the app can tell whether the live
# output window is currently visible (FreeShow's "Present" toggle).
# Prints one JSON object: { ok, visible, windows: [{ title, visible }] }

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class FsWindows {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
}
"@

$found = New-Object System.Collections.ArrayList

$callback = {
  param($handle, $lparam)
  $title = New-Object System.Text.StringBuilder 256
  [void][FsWindows]::GetWindowText($handle, $title, 256)
  if ($title.Length -eq 0) { return $true }

  $procId = 0
  [void][FsWindows]::GetWindowThreadProcessId($handle, [ref]$procId)
  $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
  if ($proc -and $proc.ProcessName -like 'FreeShow*') {
    [void]$found.Add([pscustomobject]@{
      title = $title.ToString()
      visible = [bool][FsWindows]::IsWindowVisible($handle)
    })
  }
  return $true
}

[void][FsWindows]::EnumWindows($callback, [IntPtr]::Zero)

# The main editor window is titled "FreeShow"; anything else visible is an output.
$outputs = @($found | Where-Object { $_.visible -and $_.title -ne 'FreeShow' })

[pscustomobject]@{
  ok = $true
  visible = ($outputs.Count -gt 0)
  windows = @($found)
} | ConvertTo-Json -Depth 4 -Compress
