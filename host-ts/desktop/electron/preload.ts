import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("vibestickDesktop", {
  hostStatus: (): Promise<{ state: "starting" | "running" | "exited" | "missing"; detail?: string }> => ipcRenderer.invoke("vibestick:host-status"),
  restartHost: (): Promise<{ state: "starting" | "running" | "exited" | "missing"; detail?: string }> => ipcRenderer.invoke("vibestick:restart-host"),
  releasePythonOwner: (): Promise<{ ok: boolean; detail: string }> => ipcRenderer.invoke("vibestick:release-python-owner"),
  loginStartup: (action: "install" | "uninstall"): Promise<{ ok: boolean; detail: string }> => ipcRenderer.invoke("vibestick:login-startup", action),
  loginStartupStatus: (): Promise<{ enabled: boolean; detail?: string }> => ipcRenderer.invoke("vibestick:login-startup-status"),
});
