import { spawn } from "node:child_process";

export type FocusedPlatform = "darwin" | "win32" | "linux";
export interface ProcessInvocation { command: string; args: string[]; env?: NodeJS.ProcessEnv; }
export type ProcessRunner = (invocation: ProcessInvocation) => Promise<boolean>;

/** Cross-platform current-focus input for YOLO only, never selected-session delivery. */
export class PlatformFocusedInput {
  constructor(private readonly platform: FocusedPlatform = process.platform as FocusedPlatform, private readonly run: ProcessRunner = runProcess) {}
  get available(): boolean { return this.platform === "darwin" || this.platform === "win32"; }

  /** Explicit no-input readiness check for the current foreground target. */
  async probe(): Promise<boolean> {
    if (!this.available) return false;
    if (this.platform === "darwin") return this.run({ command: "osascript", args: ["-e", 'tell application "System Events" to get name of first application process whose frontmost is true'] });
    const encoded = Buffer.from(windowsProbeProgram, "utf16le").toString("base64");
    return this.run({ command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded] });
  }

  async text(value: string): Promise<boolean> {
    if (!this.available || !value) return false;
    if (this.platform === "darwin") return this.run({ command: "osascript", args: ["-e", `tell application "System Events" to keystroke ${appleString(value)}`] });
    return this.windows("text", value);
  }
  async enter(): Promise<boolean> {
    if (!this.available) return false;
    if (this.platform === "darwin") return this.run({ command: "osascript", args: ["-e", 'tell application "System Events" to key code 36'] });
    return this.windows("enter");
  }
  async escapeTwice(): Promise<boolean> {
    if (!this.available) return false;
    if (this.platform === "darwin") return (await this.run({ command: "osascript", args: ["-e", 'tell application "System Events" to key code 53'] })) && await this.run({ command: "osascript", args: ["-e", 'tell application "System Events" to key code 53'] });
    return this.windows("escape");
  }

  private windows(action: "text" | "enter" | "escape", text = ""): Promise<boolean> {
    const encoded = Buffer.from(windowsProgram, "utf16le").toString("base64");
    return this.run({
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      env: { ...process.env, VIBESTICK_INPUT_ACTION: action, VIBESTICK_INPUT_TEXT_B64: Buffer.from(text, "utf8").toString("base64") },
    });
  }
}

function appleString(value: string): string {
  // Keep one focused input event; a transcript newline must not become Enter.
  return `"${value.replace(/[\r\n]+/g, " ").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function runProcess(invocation: ProcessInvocation): Promise<boolean> {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(invocation.command, invocation.args, { stdio: "ignore", windowsHide: true, ...(invocation.env ? { env: invocation.env } : {}) }); }
    catch { resolve(false); return; }
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
  });
}

// The text itself is carried only in a base64 child environment value, never
// interpolated into PowerShell source. SendInput KEYEVENTF_UNICODE preserves
// non-ASCII transcripts without touching the user's clipboard.
const windowsProgram = String.raw`
$source = @'
using System;
using System.Runtime.InteropServices;
public static class VibeStickInput {
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public UInt32 type; public InputUnion U; }
  [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public UInt16 wVk; public UInt16 wScan; public UInt32 dwFlags; public UInt32 time; public IntPtr dwExtraInfo; }
  [DllImport("user32.dll", SetLastError=true)] static extern UInt32 SendInput(UInt32 nInputs, INPUT[] inputs, Int32 size);
  static void Send(UInt16 vk, UInt16 scan, UInt32 flags) { var x = new INPUT[] { new INPUT { type=1, U=new InputUnion { ki=new KEYBDINPUT { wVk=vk, wScan=scan, dwFlags=flags } } }; SendInput(1, x, Marshal.SizeOf(typeof(INPUT))); }
  public static void Text(string text) { foreach (char c in text) { Send(0, c, 4); Send(0, c, 6); } }
  public static void Key(UInt16 vk) { Send(vk, 0, 0); Send(vk, 0, 2); }
}
'@
Add-Type -TypeDefinition $source
$action = $env:VIBESTICK_INPUT_ACTION
if ($action -eq 'text') { [VibeStickInput]::Text([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:VIBESTICK_INPUT_TEXT_B64))) }
elseif ($action -eq 'enter') { [VibeStickInput]::Key(13) }
elseif ($action -eq 'escape') { [VibeStickInput]::Key(27); [VibeStickInput]::Key(27) }
else { exit 2 }
`;

// This checks only that Windows exposes a foreground target. It does not send
// a key, alter the clipboard, or inspect the target process.
const windowsProbeProgram = String.raw`
$source = @'
using System;
using System.Runtime.InteropServices;
public static class VibeStickProbe {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
'@
Add-Type -TypeDefinition $source
if ([VibeStickProbe]::GetForegroundWindow() -eq [IntPtr]::Zero) { exit 1 }
`;
