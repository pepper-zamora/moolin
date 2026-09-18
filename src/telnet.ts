import * as net from "net";
import { TelnetSocket } from "telnet-stream";
import type { World } from "./worlds-types";
import type { LogLevel } from "./logger";

const TELOPT_ECHO = 1;
const TELOPT_SGA = 3;
const TELOPT_TTYPE = 24;
const TELOPT_NAWS = 31;

export interface TelnetSessionHandlers {
  onConnect: () => void;
  onData: (data: string | Uint8Array) => void;
  // A `reason` means the socket errored; its absence means a normal close.
  onDisconnect: (reason?: string) => void;
}

type LogFn = (level: Exclude<LogLevel, "none">, ...args: unknown[]) => void;

const noopLog: LogFn = () => {};

export class TelnetSession {
  private socket: TelnetSocket | null = null;
  private localEchoSuppressed = false;
  private nawsEnabled = false;
  private cols = 80;
  private rows = 24;

  constructor(
    private readonly handlers: TelnetSessionHandlers,
    private readonly log: LogFn = noopLog,
  ) {}

  connect(world: World): void {
    this.log("debug", "tcp connecting to", `${world.host}:${world.port}`);
    const rawSocket = net.createConnection({ host: world.host, port: world.port });
    const telnetSocket = new TelnetSocket(rawSocket);
    this.socket = telnetSocket;

    rawSocket.on("connect", () => {
      this.log("debug", "tcp connected");
      this.handlers.onConnect();
    });

    telnetSocket.on("data", (data) => {
      this.handlers.onData(typeof data === "string" ? data : new Uint8Array(data));
    });

    // Reasonable defaults: accept NAWS/TTYPE/SGA/ECHO, refuse everything else
    // (GMCP/MSDP/MCCP are MUD-specific extensions layered on top of telnet
    // that would need dedicated handling — out of scope for this pass).
    telnetSocket.on("do", (option) => {
      this.log("debug", "recv IAC DO", option);
      switch (option) {
        case TELOPT_NAWS:
          this.nawsEnabled = true;
          telnetSocket.writeWill(TELOPT_NAWS);
          this.sendNaws();
          break;
        case TELOPT_TTYPE:
          telnetSocket.writeWill(TELOPT_TTYPE);
          break;
        case TELOPT_SGA:
          telnetSocket.writeWill(TELOPT_SGA);
          break;
        default:
          telnetSocket.writeWont(option);
      }
    });

    telnetSocket.on("will", (option) => {
      this.log("debug", "recv IAC WILL", option);
      switch (option) {
        case TELOPT_ECHO:
          // Server takes over echoing — typically for password prompts.
          this.localEchoSuppressed = true;
          telnetSocket.writeDo(option);
          break;
        case TELOPT_SGA:
          telnetSocket.writeDo(option);
          break;
        default:
          telnetSocket.writeDont(option);
      }
    });

    telnetSocket.on("wont", (option) => {
      this.log("debug", "recv IAC WONT", option);
      if (option === TELOPT_ECHO) this.localEchoSuppressed = false;
    });

    telnetSocket.on("sub", (option, buffer) => {
      this.log("debug", "recv IAC SB", option, "len =", buffer.length);
      if (option === TELOPT_TTYPE && buffer[0] === 1 /* SEND */) {
        telnetSocket.writeSub(TELOPT_TTYPE, Buffer.concat([Buffer.from([0 /* IS */]), Buffer.from("XTERM", "ascii")]));
      }
    });

    telnetSocket.on("error", (err) => {
      this.log("error", "socket error:", err.message);
      this.teardown(err.message);
    });
    telnetSocket.on("close", () => {
      this.log("debug", "socket closed");
      this.teardown();
    });
  }

  private teardown(reason?: string): void {
    if (!this.socket) return;
    this.socket = null;
    this.handlers.onDisconnect(reason);
  }

  isConnected(): boolean {
    return this.socket !== null;
  }

  sendLine(text: string): { echoed: boolean } {
    if (!this.socket) return { echoed: false };
    this.socket.write(text.replace(/\n/g, "\r\n") + "\r\n");
    return { echoed: !this.localEchoSuppressed };
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.sendNaws();
  }

  private sendNaws(): void {
    if (!this.socket || !this.nawsEnabled) return;
    this.log("debug", "sending NAWS", `${this.cols}x${this.rows}`);
    const buffer = Buffer.alloc(4);
    buffer.writeUInt16BE(this.cols, 0);
    buffer.writeUInt16BE(this.rows, 2);
    this.socket.writeSub(TELOPT_NAWS, buffer);
  }

  disconnect(): void {
    // Don't clear `this.socket` here — let the resulting `close` event drive
    // `teardown()`, which is what actually fires `onDisconnect`.
    this.socket?.destroy();
  }
}
