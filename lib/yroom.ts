/**
 * The shared room: one Yjs document per project.
 *
 * How a change travels
 * --------------------
 * A child drags a block. Blockly raises an event. We push that event's JSON
 * onto a Y.Array. Yjs ships it to everyone else in the room, who replay it into
 * their own workspace. Blockly's event format is designed for exactly this, so
 * we never have to diff two workspaces or reconcile two serialisations.
 *
 * Using an append-only log rather than a shared snapshot is what keeps both
 * edits when two people drag at the same moment: Yjs orders the two appends,
 * and every client replays the same order, so every client lands in the same
 * place.
 *
 * Two providers are attached:
 *   - IndexedDB, which gives us offline editing and the PRD's "saves by itself"
 *     with no server round trip.
 *   - WebSocket, which carries the room between Lagos and the US.
 */

import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { IndexeddbPersistence } from 'y-indexeddb';
import { Awareness } from 'y-protocols/awareness';

export type Role = 'teacher' | 'student';

export interface Participant {
  name: string;
  colour: string;
  role: Role;
  /** Workspace coordinates of this person's pointer, or null if off-canvas. */
  cursor: { x: number; y: number } | null;
  handRaised: boolean;
  /** Block this person is currently dragging, so others can see it move. */
  draggingBlockId: string | null;
}

/** Room-wide state the teacher controls. */
export interface RoomMeta {
  /** Students can watch but not edit. */
  locked: boolean;
  /** Incremented to start a shared run on every screen at once. */
  runToken: number;
  runSpeed: 'normal' | 'slow';
  /** Which week's challenge this project is working on. */
  week: number;
}

export const DEFAULT_META: RoomMeta = {
  locked: false,
  runToken: 0,
  runSpeed: 'normal',
  week: 1,
};

/** High-contrast cursor colours, distinguishable for common colour blindness. */
export const CURSOR_COLOURS = [
  '#d6336c',
  '#1c7ed6',
  '#f08c00',
  '#2f9e44',
  '#7048e8',
  '#0c8599',
  '#e8590c',
  '#495057',
];

export function colourForClientId(clientId: number): string {
  return CURSOR_COLOURS[Math.abs(clientId) % CURSOR_COLOURS.length];
}

export interface Room {
  doc: Y.Doc;
  /** Append-only log of Blockly events, as JSON strings. */
  events: Y.Array<string>;
  meta: Y.Map<unknown>;
  /** Stars awarded, keyed by `${participantName}:${week}`. */
  stars: Y.Map<number>;
  awareness: Awareness;
  websocket: WebsocketProvider | null;
  indexeddb: IndexeddbPersistence;
  /** Resolves once the local offline copy has loaded. */
  whenLoaded: Promise<void>;
  destroy: () => void;
}

const SYNC_URL =
  process.env.NEXT_PUBLIC_SYNC_URL ?? 'ws://localhost:1234';

/**
 * Opens (or re-opens) a room.
 *
 * `roomId` is the project key. The PRD gives one project per student per week,
 * so it looks like `demo-class/ada/week-3`.
 */
export function openRoom(roomId: string): Room {
  const doc = new Y.Doc();
  const events = doc.getArray<string>('events');
  const meta = doc.getMap<unknown>('meta');
  const stars = doc.getMap<number>('stars');

  const indexeddb = new IndexeddbPersistence(`mathblocks:${roomId}`, doc);
  const whenLoaded = new Promise<void>((resolve) => {
    indexeddb.once('synced', () => resolve());
  });

  let websocket: WebsocketProvider | null = null;
  try {
    websocket = new WebsocketProvider(SYNC_URL, roomId, doc, {
      connect: true,
    });
  } catch {
    // No sync server reachable. The editor still works offline against
    // IndexedDB, and will pick the room up when the connection returns.
    websocket = null;
  }

  // Offline fallback so the presence code always has something to talk to.
  const awareness: Awareness = websocket?.awareness ?? new Awareness(doc);

  return {
    doc,
    events,
    meta,
    stars,
    awareness,
    websocket,
    indexeddb,
    whenLoaded,
    destroy: () => {
      websocket?.destroy();
      indexeddb.destroy();
      doc.destroy();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Meta helpers                                                        */
/* ------------------------------------------------------------------ */

export function readMeta(meta: Y.Map<unknown>): RoomMeta {
  return {
    locked: (meta.get('locked') as boolean) ?? DEFAULT_META.locked,
    runToken: (meta.get('runToken') as number) ?? DEFAULT_META.runToken,
    runSpeed:
      (meta.get('runSpeed') as RoomMeta['runSpeed']) ?? DEFAULT_META.runSpeed,
    week: (meta.get('week') as number) ?? DEFAULT_META.week,
  };
}

export function writeMeta(
  meta: Y.Map<unknown>,
  patch: Partial<RoomMeta>,
): void {
  meta.doc?.transact(() => {
    for (const [key, value] of Object.entries(patch)) {
      meta.set(key, value);
    }
  });
}

/** Starts a run on every screen watching this project. */
export function triggerSharedRun(
  meta: Y.Map<unknown>,
  speed: RoomMeta['runSpeed'],
): void {
  const current = readMeta(meta);
  writeMeta(meta, { runToken: current.runToken + 1, runSpeed: speed });
}

export function starKey(name: string, week: number): string {
  return `${name}:${week}`;
}

export function awardStar(
  stars: Y.Map<number>,
  name: string,
  week: number,
  count = 1,
): void {
  const key = starKey(name, week);
  stars.set(key, (stars.get(key) ?? 0) + count);
}

export function starsThisWeek(
  stars: Y.Map<number>,
  name: string,
  week: number,
): number {
  return stars.get(starKey(name, week)) ?? 0;
}
