// Single source of truth for IPC channel names, shared between main.ts
// (which registers handlers and sends) and preload.ts (the only place
// allowed to call ipcRenderer directly). A typo in either file becomes a
// compile error here instead of a silently-dropped message.
export const IpcChannels = {
  worldsLoad: "worlds:load",
  worldsSave: "worlds:save",
  worldsCreateNew: "worlds:createNew",
  dialogConfirm: "dialog:confirm",
  connectRequest: "connect:request",
  telnetInput: "telnet:input",
  telnetResize: "telnet:resize",
  telnetData: "telnet:data",
  terminalGetScrollback: "terminal:getScrollback",
  terminalZoom: "terminal:zoom",
  terminalContextMenu: "terminal:contextMenu",
  terminalCopyRequested: "terminal:copyRequested",
  terminalPasteRequested: "terminal:pasteRequested",
  terminalSelectAllRequested: "terminal:selectAllRequested",
  connectionGetState: "connection:getState",
  connectionState: "connection:state",
  clipboardWriteText: "clipboard:writeText",
  clipboardReadText: "clipboard:readText",
  shellOpenExternal: "shell:openExternal",
  logEmit: "log:emit",
} as const;
