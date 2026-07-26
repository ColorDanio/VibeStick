import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("vibestickDesktop", {
  hostStatus: (): Promise<{ state: "starting" | "running" | "exited" | "missing"; detail?: string }> => ipcRenderer.invoke("vibestick:host-status"),
});
