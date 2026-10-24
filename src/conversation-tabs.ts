// Private conversations, each in a tab of its own titled with the other
// character's name, beside the window's first tab (the scrollback). A server
// line one of the world's conversation patterns matches is moved out of the
// scrollback into its conversation, as a chat bubble: the other character's
// on the left, ours on the right, an emote as italic text without one. Only
// lines that arrive while the window is open are moved (replayed history
// stays in the scrollback), and the tabs start over with each connection.
// The tab strip is hidden until the first conversation starts. Which
// conversation a line belongs to, and what it says, is conversations.ts's.
import { type ConversationEntry, Conversations } from "./conversations";
import { TabStrip } from "./tabs";
import type { ConversationPattern } from "./worlds-types";

// Pixels from the bottom within which a conversation counts as scrolled to
// the bottom, and so follows new messages.
const STICK_THRESHOLD = 4;

interface Conversation {
  // As the other character's name was first seen.
  name: string;
  tab: HTMLButtonElement;
  panel: HTMLDivElement;
  // Scrolled to the bottom, so following new messages; kept while the panel
  // is hidden, when it can't scroll.
  stuck: boolean;
}

export class ConversationTabs {
  private readonly tabs: TabStrip;
  private readonly list: HTMLElement;
  private readonly model = new Conversations();
  // Keyed by the other character's name as first seen (ConversationEntry.partner).
  private readonly conversations = new Map<string, Conversation>();
  private nextId = 1;
  private font = { family: "", size: 14 };

  // `strip` holds the tablist, with `mainTab` (whose panel is the scrollback)
  // in it; each conversation's panel is added to `views`.
  constructor(
    private readonly strip: HTMLElement,
    private readonly mainTab: HTMLButtonElement,
    private readonly views: HTMLElement,
  ) {
    const list = strip.querySelector<HTMLElement>('[role="tablist"]');
    if (!list) throw new Error("tab strip has no tablist");
    this.list = list;
    this.tabs = new TabStrip(strip, (id) => this.shown(id));
  }

  private shown(tabId: string): void {
    const conversation = this.conversationByTab(tabId);
    if (!conversation) return;
    conversation.tab.classList.remove("unread");
    if (conversation.stuck) conversation.panel.scrollTop = conversation.panel.scrollHeight;
  }

  // The connection's world, character and patterns, from its state. While
  // disconnected there are no patterns, so nothing more is moved.
  setConnection(worldName: string | null, characterName: string | null, patterns: ConversationPattern[]): void {
    if (worldName !== null) this.mainTab.textContent = worldName;
    this.model.setConnection(characterName, patterns);
  }

  // Offered each line from the server as it ends; returns whether it was
  // moved into a conversation (and so is to be taken out of the scrollback).
  // A line that doesn't name the other character, with no conversation to
  // put it in, stays where it is.
  take(text: string, time: number | null): boolean {
    const entry = this.model.take(text, time, this.selectedConversation()?.name ?? null);
    if (!entry) return false;
    this.addEntry(this.conversations.get(entry.partner) ?? this.open(entry.partner), entry);
    return true;
  }

  // Back to just the scrollback, as when a new connection starts.
  clear(): void {
    this.tabs.select(this.mainTab, { focus: false });
    for (const conversation of this.conversations.values()) {
      conversation.tab.remove();
      conversation.panel.remove();
    }
    this.conversations.clear();
    this.model.clear();
    this.strip.hidden = true;
  }

  setFont(family: string, size: number): void {
    this.font = { family, size };
    for (const conversation of this.conversations.values()) this.applyFont(conversation.panel);
  }

  // Shows the scrollback (for the find widget, which searches it).
  showMain(): void {
    this.tabs.select(this.mainTab, { focus: false });
  }

  // Whether there's more than the scrollback's tab to switch between.
  hasConversations(): boolean {
    return this.conversations.size > 0;
  }

  // The next (1) or previous (-1) tab, keeping focus where it is.
  step(direction: 1 | -1): void {
    this.tabs.step(direction, { focus: false });
  }

  // Page Up / Page Down in the selected conversation; returns false when the
  // scrollback's tab is selected, which scrolls itself.
  scrollPages(direction: 1 | -1): boolean {
    const conversation = this.selectedConversation();
    if (!conversation) return false;
    const { panel } = conversation;
    panel.scrollBy({ top: direction * Math.max(1, panel.clientHeight - this.font.size * 2) });
    return true;
  }

  private selectedConversation(): Conversation | null {
    return this.conversationByTab(this.tabs.selected().id);
  }

  private conversationByTab(id: string): Conversation | null {
    for (const conversation of this.conversations.values()) if (conversation.tab.id === id) return conversation;
    return null;
  }

  // A new conversation's tab and panel.
  private open(name: string): Conversation {
    const id = this.nextId++;
    const tab = document.createElement("button");
    tab.type = "button";
    tab.id = `conversation-tab-${id}`;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", "false");
    tab.setAttribute("aria-controls", `conversation-${id}`);
    tab.tabIndex = -1;
    tab.textContent = name;
    const panel = document.createElement("div");
    panel.id = `conversation-${id}`;
    panel.className = "conversation";
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", tab.id);
    panel.hidden = true;
    this.applyFont(panel);
    this.list.append(tab);
    this.views.append(panel);
    const conversation = { name, tab, panel, stuck: true };
    panel.addEventListener("scroll", () => {
      if (!panel.hidden)
        conversation.stuck = panel.scrollTop + panel.clientHeight >= panel.scrollHeight - STICK_THRESHOLD;
    });
    this.conversations.set(name, conversation);
    this.strip.hidden = false;
    return conversation;
  }

  private applyFont(panel: HTMLElement): void {
    panel.style.fontFamily = this.font.family;
    panel.style.fontSize = `${this.font.size}px`;
  }

  private addEntry(conversation: Conversation, entry: ConversationEntry): void {
    const { panel, tab } = conversation;
    const row = document.createElement("div");
    row.className = `bubble-row from-${entry.from}`;
    const bubble = document.createElement("div");
    bubble.className = entry.kind === "emote" ? "bubble emote" : "bubble";
    bubble.textContent = entry.text;
    if (entry.kind === "say") {
      const avatar = document.createElement("span");
      avatar.className = "avatar";
      avatar.textContent = entry.initials;
      avatar.title = entry.name;
      row.append(avatar);
    }
    if (entry.time !== null) bubble.title = new Date(entry.time).toLocaleTimeString();
    row.append(bubble);
    panel.append(row);
    if (conversation.stuck) panel.scrollTop = panel.scrollHeight;
    if (tab.getAttribute("aria-selected") !== "true") tab.classList.add("unread");
  }
}
