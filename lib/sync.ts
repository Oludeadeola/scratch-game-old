/**
 * Binds a Blockly workspace to a shared room.
 *
 * Blockly already describes every edit as a small, replayable event object, and
 * those events are addressed by block id. If every client agrees on block ids,
 * replaying the same events in the same order lands every client on the same
 * workspace. Yjs gives us exactly that: one agreed order over an append-only
 * log.
 *
 * Two details make it work in practice:
 *
 *  1. The hat block is created locally on every client with a fixed id and is
 *     never logged. Otherwise the first client would log a create for it and
 *     everyone would end up with two.
 *
 *  2. Remote events are applied with Blockly's event system switched off.
 *     Blockly flushes its own event queue on a timer, so a simple "am I
 *     applying?" flag races and echoes; disabling is the only reliable guard.
 */

import * as Blockly from 'blockly/core';
import type * as Y from 'yjs';
import { HAT_BLOCK, registerBlocks } from './blocks';
import type { Room } from './yroom';

/** Marks transactions we originated, so we don't replay our own events. */
export const LOCAL_ORIGIN = Symbol('mathblocks-local');

/** Shared across every client so events about the hat block line up. */
export const HAT_ID = 'mathblocks-hat-root';

/** Events that describe a view, not the project. Never worth sending. */
function isBroadcastable(event: Blockly.Events.Abstract): boolean {
  if (event.isUiEvent) return false;
  if (event.type === Blockly.Events.FINISHED_LOADING) return false;
  if (event.type === Blockly.Events.VIEWPORT_CHANGE) return false;
  // The hat is seeded locally on each client; its own create must not travel.
  const blockId = (event as { blockId?: string }).blockId;
  if (event.type === Blockly.Events.BLOCK_CREATE && blockId === HAT_ID) {
    return false;
  }
  return true;
}

/** Creates the "when Run is clicked" hat, identically on every client. */
export function seedWorkspace(workspace: Blockly.WorkspaceSvg): void {
  registerBlocks();
  if (workspace.getBlockById(HAT_ID)) return;

  Blockly.Events.disable();
  try {
    const hat = workspace.newBlock(HAT_BLOCK, HAT_ID);
    hat.initSvg();
    hat.moveBy(32, 32);
    hat.render();
  } finally {
    Blockly.Events.enable();
  }
}

function applyRemote(
  workspace: Blockly.WorkspaceSvg,
  json: string,
): void {
  let parsed: Blockly.Events.Abstract;
  try {
    parsed = JSON.parse(json);
  } catch {
    return;
  }

  Blockly.Events.disable();
  try {
    const event = Blockly.Events.fromJson(
      parsed as unknown as Blockly.Events.Abstract & { type: string },
      workspace,
    );
    event.run(true);
  } catch {
    // One bad event must not stop the rest of the lesson from syncing. The
    // most common cause is an event for a block another event already removed,
    // which is harmless to skip.
  } finally {
    Blockly.Events.enable();
  }
}

export interface BindOptions {
  workspace: Blockly.WorkspaceSvg;
  room: Room;
  /** Called after the workspace changes, local or remote. */
  onChange?: () => void;
  /** While true, local edits are neither applied nor sent. */
  isLocked?: () => boolean;
}

/**
 * Replays the log, then keeps the workspace and the log in step.
 * Returns a teardown function.
 */
export async function bindWorkspace({
  workspace,
  room,
  onChange,
  isLocked,
}: BindOptions): Promise<() => void> {
  await room.whenLoaded;

  seedWorkspace(workspace);

  // Replay everything already in the log, including whatever IndexedDB just
  // restored. This is what makes the project "there next time".
  let replayed = 0;
  const replayFrom = (start: number) => {
    const all = room.events.toArray();
    for (let i = start; i < all.length; i += 1) {
      applyRemote(workspace, all[i]);
    }
    replayed = all.length;
  };
  replayFrom(0);
  onChange?.();

  const observer = (
    _event: Y.YArrayEvent<string>,
    transaction: Y.Transaction,
  ) => {
    if (transaction.origin === LOCAL_ORIGIN) {
      // Our own edit; the workspace already has it.
      replayed = room.events.length;
      return;
    }
    replayFrom(replayed);
    onChange?.();
  };
  room.events.observe(observer);

  const listener = (event: Blockly.Events.Abstract) => {
    if (!isBroadcastable(event)) return;
    if (isLocked?.()) return;
    room.doc.transact(() => {
      room.events.push([JSON.stringify(event.toJson())]);
    }, LOCAL_ORIGIN);
    replayed = room.events.length;
    onChange?.();
  };
  workspace.addChangeListener(listener);

  return () => {
    room.events.unobserve(observer);
    workspace.removeChangeListener(listener);
  };
}

/**
 * Clears the script without clearing the shared log.
 *
 * Deleting blocks the normal way produces delete events that travel like any
 * other edit, which is what we want: everyone's screen clears together.
 */
export function clearScript(workspace: Blockly.WorkspaceSvg): void {
  const hat = workspace.getBlockById(HAT_ID);
  if (!hat) return;
  let block = hat.getNextBlock();
  const doomed: Blockly.Block[] = [];
  while (block) {
    doomed.push(block);
    block = block.getNextBlock();
  }
  for (const target of doomed.reverse()) {
    target.dispose(false);
  }
}
