export interface Character {
  id: string;
  name: string;
  password: string;
}

export interface World {
  id: string;
  name: string;
  host: string;
  // null while the user hasn't entered one yet.
  port: number | null;
  tls: boolean;
  // Connect over TLS even if the certificate fails verification (self-signed,
  // expired, wrong host). Only meaningful when `tls` is set.
  tlsAllowUntrusted: boolean;
  // Send `loginTemplate` on connect when connecting as a character.
  autoLogin: boolean;
  loginTemplate: string;
  // Echo typed commands back into the scrollback (in cyan). Turn off for
  // servers that echo your input themselves, to avoid seeing it twice.
  echoCommands: boolean;
  characters: Character[];
}

// A world, optionally as one of its characters.
export interface MruEntry {
  worldId: string;
  characterId?: string;
}

export interface ConnectTarget {
  world: World;
  character: Character | null;
}

// What the worlds-load IPC returns. `error` is set when the worlds file
// exists but couldn't be read or parsed (nor its backup); saving is then
// refused so the user's file isn't overwritten. `warning` is set when the
// worlds came from the backup instead (see readWorldsFile).
export interface WorldsLoadResult {
  worlds: World[];
  error?: string;
  warning?: string;
}
