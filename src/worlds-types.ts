// A cascading setting's override at the World or Character level: defer to
// whatever the level above it resolves to, or force it on/off regardless.
// Global itself has nothing above it, so it's just a plain boolean.
export type TriState = "inherit" | "on" | "off";

// App-wide defaults for settings that World and Character can each override
// (see TriState and resolveTriState in world-utils.ts). Lives in the worlds
// file (WorldsState) rather than preferences.json, since it's edited in the
// Worlds dialog's Global pane, alongside the World/Character overrides it's
// the fallback for.
export interface GlobalSettings {
  // Wrap long server lines at word boundaries for display.
  wordWrap: boolean;
  // Echo typed commands back into the scrollback (in cyan).
  echoCommands: boolean;
  // Act on a Pueblo server's request to clear the screen.
  honorClear: boolean;
}

// Who a conversation line comes from: the character we're connected as, or
// the other one.
export type ConversationSpeaker = "us" | "them";
// Something said (shown as is) or an emote (shown after the speaker's name).
export type ConversationKind = "say" | "emote";

// One shape of server line that belongs in a private conversation between
// two characters. In the template {{us}} and {{them}} stand for their names
// and {{message}} for what's said or done; the rest is matched literally.
export interface ConversationPattern {
  template: string;
  from: ConversationSpeaker;
  kind: ConversationKind;
}

export interface Character {
  id: string;
  name: string;
  password: string;
  echoCommands: TriState;
  wordWrap: TriState;
  honorClear: TriState;
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
  echoCommands: TriState;
  wordWrap: TriState;
  honorClear: TriState;
  conversationPatterns: ConversationPattern[];
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
  globalSettings: GlobalSettings;
  error?: string;
  warning?: string;
  // The worlds file is encrypted and not unlocked: the list is empty.
  locked?: boolean;
}
